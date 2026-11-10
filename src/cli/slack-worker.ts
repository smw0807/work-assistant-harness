import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { join } from 'node:path';
import { SlackReadClient } from '../adapters/slack-read-client.js';
import { SlackSocketTransport } from '../adapters/slack-socket-transport.js';
import { SqliteSlackInbox } from '../adapters/sqlite-slack-inbox.js';
import { SqliteTaskStore } from '../adapters/sqlite-task-store.js';
import { MockSlackSource } from '../adapters/mock-slack-source.js';
import { LocalReportSink } from '../adapters/local-report-sink.js';
import { SlackReceptionService, type SlackThreadReader } from '../application/receive-slack.js';
import { HarnessError } from '../domain/errors.js';
import type { SlackInbox } from '../domain/slack.js';
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
  if (live && !options.config.liveReadEnabled) throw new HarnessError('SLACK_LIVE_READ_DISABLED');
  const client = live ? new SlackReadClient({
    appToken: process.env['SLACK_APP_TOKEN'] ?? '', webToken: process.env['SLACK_WEB_TOKEN'] ?? '',
  }) : null;
  delete process.env['SLACK_APP_TOKEN'];
  delete process.env['SLACK_WEB_TOKEN'];
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
  const inbox = application.get<SlackInbox>(INBOX);
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
        { name: 'analysis', status: 'not_run', reason: 'Slack 수신·문맥 기록만 수행하며 모델과 대상 저장소를 연결하지 않습니다.' },
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
    const recovered = readOnly ? 0 : inbox.recoverInterrupted(new Date());
    await synchronizeReports();
    if (options.command === 'slack-list') {
      const requests = list();
      result({ requests: requests.slice(-100).map(({ text: _text, thread: _thread, ...metadata }) => metadata),
        total: requests.length, truncated: requests.length > 100, connection: inbox.connection(), connectionHistory: inbox.connectionHistory() });
    } else if (options.command === 'slack-inspect') {
      if (!options.config.channelIds.includes(options.channelId)) throw new HarnessError('SLACK_CHANNEL_DENIED');
      const request = inbox.find(options.config.workspaceId, options.channelId, options.messageTs);
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
    } else if (live && client) {
      const stop = (): void => controller.abort();
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      const retentionTimer = setInterval(() => {
        try { inbox.prune(new Date()); } catch (error) { drainFailure = error; controller.abort(); }
      }, 60_000);
      try {
        try { await client.verifyWorkspace(options.config.workspaceId, controller.signal); } catch (error) {
          if (controller.signal.aborted) return;
          throw error;
        }
        scheduleDrain();
        result({ status: 'starting', recovered });
        await new SlackSocketTransport(client).run(async (envelope, acknowledge) => {
          if (drainFailure) throw drainFailure;
          await service.receive(envelope, acknowledge);
          scheduleDrain();
        }, controller.signal, (state, reason) => {
          inbox.setConnection({ state, reason, at: new Date().toISOString() });
          process.stdout.write(`${JSON.stringify({ connection: inbox.connection() })}\n`);
        });
      } finally {
        controller.abort();
        clearInterval(retentionTimer);
        if (followup) await followup;
        await service.drain();
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        inbox.setConnection({ state: 'gap', reason: 'RECEIVER_STOPPED', at: new Date().toISOString() });
      }
      if (drainFailure) throw drainFailure;
    } else throw new HarnessError('UNKNOWN_COMMAND');
  } finally {
    tasks.close();
    inbox.close();
    await application.close();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof HarnessError ? error.code : 'SLACK_RECEIVER_FAILED'}\n`);
  process.exitCode = 1;
});
