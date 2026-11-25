import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { join } from 'node:path';
import { SlackReadClient } from '../adapters/slack-read-client.js';
import { SlackListExportClient } from '../adapters/slack-list-export.js';
import { SlackSocketTransport } from '../adapters/slack-socket-transport.js';
import { SqliteSlackInbox } from '../adapters/sqlite-slack-inbox.js';
import { SqliteTaskStore } from '../adapters/sqlite-task-store.js';
import { MockSlackSource } from '../adapters/mock-slack-source.js';
import { LocalReportSink } from '../adapters/local-report-sink.js';
import { SlackReceptionService, type SlackThreadReader } from '../application/receive-slack.js';
import { pollSlackLists } from '../application/poll-slack-list.js';
import { HarnessError } from '../domain/errors.js';
import { getSlackListIds, type SlackInbox } from '../domain/slack.js';
import { parseSlackReceiverConfig } from '../policy/slack-ingestion.js';
import type { SlackWorkerOptions } from './slack.js';
import { assertSlackReceiverPermissions } from './runtime.js';

const INBOX = Symbol('SlackInbox');
@Module({})
class SlackReceiverModule {}

const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = JSON.parse(process.argv[2] ?? '{}') as SlackWorkerOptions;
  options.config = parseSlackReceiverConfig(options.config);
  assertSlackReceiverPermissions(options.sourceRoot, options.dataDirectory, options.command === 'slack-listen');
  const live = options.command === 'slack-listen';
  const controller = new AbortController();
  const parentDisconnected = (): void => controller.abort();
  if (process.connected) process.on('disconnect', parentDisconnected);
  if (live && !options.config.liveReadEnabled) throw new HarnessError('SLACK_LIVE_READ_DISABLED');
  const appToken = process.env['SLACK_APP_TOKEN'];
  const webToken = process.env['SLACK_WEB_TOKEN'] ?? '';
  const channelEnabled = options.config.channelIds.length > 0;
  const listIds = getSlackListIds(options.config);
  const listUserToken = listIds.length > 0 ? process.env['SLACK_LIST_USER_TOKEN'] : undefined;
  const client = live && (channelEnabled || !listUserToken)
    ? new SlackReadClient({ ...(appToken ? { appToken } : {}), webToken }) : null;
  const listClient = live && listIds.length > 0 ? new SlackListExportClient(listUserToken || webToken) : null;
  const listThreads = listClient ? new SlackReadClient({ webToken: listUserToken || webToken, allowedListIds: listIds }) : null;
  delete process.env['SLACK_APP_TOKEN'];
  delete process.env['SLACK_WEB_TOKEN'];
  delete process.env['SLACK_LIST_USER_TOKEN'];
  const threads: SlackThreadReader = client ? {
    readThread: (channel, ts, limits) => client.readThread(channel, ts, limits, controller.signal),
  } : {
    readThread: async () => ({ messages: [], complete: false, reason: 'OFFLINE_NO_THREAD_SOURCE' }),
  };
  const databasePath = join(options.dataDirectory, 'tasks.sqlite');
  const application = await NestFactory.createApplicationContext({
    module: SlackReceiverModule,
    providers: [
      { provide: INBOX, useFactory: () => new SqliteSlackInbox(databasePath, options.config) },
      {
        provide: SlackReceptionService, inject: [INBOX],
        useFactory: (inbox: SlackInbox) => new SlackReceptionService(options.config, inbox, threads, () => new Date(), controller.signal),
      },
    ],
  }, { logger: false, abortOnError: false });
  const inbox = application.get<SqliteSlackInbox>(INBOX);
  const service = application.get(SlackReceptionService);
  const tasks = new SqliteTaskStore(databasePath);
  const reporter = new LocalReportSink(join(options.dataDirectory, 'reports'));
  const synchronizeReports = async (): Promise<void> => {
    for (const task of tasks.list()) if (task.status === 'CANCELLED') await reporter.write(task);
  };
  const list = () => inbox.list().filter((request) => request.workspaceId === options.config.workspaceId
    && options.config.channelIds.includes(request.channelId));
  const result = (value: object): void => {
    process.stdout.write(`${JSON.stringify({
      ...value, dataDirectory: options.dataDirectory,
      checks: [
        { name: 'analysis', status: 'not_run', reason: '이 수신 프로세스는 Slack 문맥만 기록합니다. 별도 Codex 분석 상태는 slack-analysis 이벤트와 slack-inspect 결과에서 확인합니다.' },
        { name: 'external_message_delivery', status: 'not_run', reason: 'Slack 메시지·DM·Git 원격 전송 경로가 없습니다.' },
        { name: 'approval_and_execution', status: 'not_run', reason: '수집 경로는 승인과 실행을 제공하지 않으며 실행 포트는 계속 거부합니다.' },
      ],
    }, null, 2)}\n`);
  };
  let drainFailure: unknown = null;
  let followup: Promise<void> | null = null;
  const scheduleDrain = (): void => {
    if (followup) return;
    followup = service.drain().then(synchronizeReports)
      .catch((error: unknown) => { drainFailure = error; controller.abort(); })
      .finally(() => {
        followup = null;
        if (!controller.signal.aborted && inbox.pending().length > 0) scheduleDrain();
      });
  };
  try {
    inbox.prune(new Date());
    const readOnly = options.command === 'slack-list' || options.command === 'slack-inspect';
    const recovered = readOnly || !channelEnabled ? 0 : inbox.recoverInterrupted(new Date());
    await synchronizeReports();
    if (options.command === 'slack-list') {
      const requests = list();
      result({ requests: requests.slice(-100).map(({ text: _text, thread: _thread, ...metadata }) => metadata),
        ...(listIds.length > 0 ? { listMentions: inbox.listMentions() } : {}),
        total: requests.length, truncated: requests.length > 100, connection: inbox.connection(), connectionHistory: inbox.connectionHistory() });
    } else if (options.command === 'slack-inspect') {
      const isList = listIds.includes(options.channelId);
      if (!isList && !options.config.channelIds.includes(options.channelId)) throw new HarnessError('SLACK_CHANNEL_DENIED');
      const request = isList ? inbox.findListAnalysisRequest(options.channelId, options.messageTs)
        : inbox.find(options.config.workspaceId, options.channelId, options.messageTs);
      if (!request) throw new HarnessError('SLACK_REQUEST_NOT_FOUND');
      result({ request });
    } else if (options.command === 'slack-replay') {
      const counts = { accepted: 0, duplicate: 0, ignored: 0, acknowledgements: 0 };
      for (const envelope of await new MockSlackSource(options.eventsPath).read()) {
        const outcome = await service.receive(envelope, async () => { counts.acknowledgements += 1; });
        counts[outcome] += 1;
      }
      await synchronizeReports();
      await service.drain();
      result({ recovered, ...counts, requests: list() });
    } else if (live) {
      const stop = (): void => controller.abort();
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      const retentionTimer = setInterval(() => {
        try { inbox.prune(new Date()); } catch (error) { drainFailure = error; controller.abort(); }
      }, 60_000);
      const activeSources: Promise<void>[] = [];
      try {
        try { await client?.verifyWorkspace(options.config.workspaceId, controller.signal); } catch (error) {
          if (controller.signal.aborted) return;
          throw error;
        }
        if (channelEnabled) scheduleDrain();
        result({ status: 'starting', recovered, ...(listIds.length > 0 ? {
          listIds, listAuth: listUserToken ? 'user' : 'web', listAnalysisEnabled: options.config.listAnalysisEnabled === true,
        } : {}) });
        const { workspaceId, targetUserId } = options.config;
        if (listClient && listThreads) {
          const reader = {
            ...(listUserToken ? { verifyIdentity: (signal: AbortSignal) => listThreads.verifyWorkspace(workspaceId, signal, targetUserId) } : {}),
            read: listClient.read.bind(listClient),
            readListThreadPage: listThreads.readListThreadPage.bind(listThreads),
            ...(options.config.listAnalysisEnabled ? {
              readListAnalysisThread: (listId: string, itemId: string, threadTs: string, signal: AbortSignal) =>
                listThreads.readListAnalysisThread(listId, itemId, threadTs, targetUserId, options.config.thread, signal),
            } : {}),
          };
          activeSources.push(pollSlackLists({ workspaceId, targetUserId, listIds }, reader, inbox, controller.signal,
            notice => process.stdout.write(`${JSON.stringify({ event: 'slack-list-poll', ...notice })}\n`)));
        }
        if (channelEnabled && client) {
          const socket = new SlackSocketTransport(client).run(async (envelope, acknowledge) => {
            if (drainFailure) throw drainFailure;
            await service.receive(envelope, acknowledge);
            scheduleDrain();
          }, controller.signal, (state, reason) => {
            inbox.setConnection({ state, reason, at: new Date().toISOString() });
            process.stdout.write(`${JSON.stringify({ connection: inbox.connection() })}\n`);
          });
          activeSources.push(socket.catch((error: unknown) => {
            if (!listClient || !(error instanceof HarnessError) || error.code !== 'SLACK_RECONNECT_LIMIT') throw error;
            process.stdout.write(`${JSON.stringify({ event: 'slack-channel-stopped', reason: error.code })}\n`);
          }));
        }
        await Promise.all(activeSources);
      } finally {
        controller.abort();
        clearInterval(retentionTimer);
        await Promise.allSettled(activeSources);
        if (followup) await followup;
        if (channelEnabled) await service.drain();
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        if (channelEnabled) inbox.setConnection({ state: 'gap', reason: 'RECEIVER_STOPPED', at: new Date().toISOString() });
      }
      if (drainFailure) throw drainFailure;
    } else throw new HarnessError('UNKNOWN_COMMAND');
  } finally {
    process.off('disconnect', parentDisconnected);
    tasks.close();
    inbox.close();
    await application.close();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof HarnessError ? error.code : 'SLACK_RECEIVER_FAILED'}\n`);
  process.exitCode = 1;
});
