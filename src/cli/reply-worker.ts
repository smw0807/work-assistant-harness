import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockReplyDelivery } from '../adapters/mock-reply-delivery.js';
import { SqliteReplyStore } from '../adapters/sqlite-reply-store.js';
import { SyntheticReplyService } from '../application/send-reply.js';
import { HarnessError } from '../domain/errors.js';
import type { ReplySnapshot } from '../domain/reply.js';
import type { ReplyStore } from '../ports/reply.js';
import { assertPrivateReplyFiles, type ReplyWorkerOptions } from './reply.js';

const STORE = Symbol('ReplyStore');

@Module({})
class ReplyModule {}

const assertRestrictedWorker = async (options: ReplyWorkerOptions): Promise<void> => {
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const permissions = process.permission;
  if (options.sourceRoot !== sourceRoot || !permissions || permissions.has('fs.write', sourceRoot)
    || !permissions.has('fs.write', options.dataDirectory) || permissions.has('child') || permissions.has('worker')
    || permissions.has('net') || permissions.has('addons') || permissions.has('wasi') || permissions.has('inspector')) {
    throw new HarnessError('REPLY_UNSAFE_WORKER_PERMISSIONS');
  }
  if (!process.getuid) throw new HarnessError('LOCAL_OWNER_UNAVAILABLE');
  // macOS는 최소 환경으로 실행해도 프로세스 초기화 때 문자 인코딩 정보를 추가한다.
  const localeKeys = ['LANG', 'TZ', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])];
  if (Object.keys(process.env).some((key) => !localeKeys.includes(key))) throw new HarnessError('REPLY_UNSAFE_WORKER_ENVIRONMENT');
  const directory = await lstat(options.dataDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
    || directory.uid !== process.getuid() || await realpath(options.dataDirectory) !== options.dataDirectory) {
    throw new HarnessError('DATA_DIRECTORY_NOT_PRIVATE');
  }
  assertPrivateReplyFiles(options.dataDirectory);
};

const withoutBody = ({ body: _body, ...metadata }: ReplySnapshot): Omit<ReplySnapshot, 'body'> => metadata;

const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = JSON.parse(process.argv[2] ?? '{}') as ReplyWorkerOptions;
  await assertRestrictedWorker(options);
  const ownerId = `os-user:${process.getuid!()}`;
  const application = await NestFactory.createApplicationContext({
    module: ReplyModule,
    providers: [
      { provide: STORE, useFactory: () => new SqliteReplyStore(join(options.dataDirectory, 'replies.sqlite')) },
      { provide: SyntheticReplyService, inject: [STORE], useFactory: (store: ReplyStore) => new SyntheticReplyService(store, new MockReplyDelivery()) },
    ],
  }, { logger: false, abortOnError: false });
  const store = application.get<ReplyStore>(STORE);
  const service = application.get(SyntheticReplyService);
  const now = new Date();
  const output = (result: object): void => { process.stdout.write(`${JSON.stringify({
    ...result, mode: 'mock', dataDirectory: options.dataDirectory,
    checks: [
      { name: 'restricted_worker', status: 'passed', reason: '답장 worker는 데이터 디렉터리 쓰기만 허용하며 네트워크·하위 프로세스·상속 토큰 권한이 없습니다.' },
      { name: 'external_message_delivery', status: 'not_run', reason: '고정 합성 답장과 모의 전송만 사용하며 실제 Slack 전송 어댑터를 연결하지 않습니다.' },
    ],
  }, null, 2)}\n`); };
  try {
    // 만료 제거와 명시적 복구를 분리하여 시작 시 전송을 재개하지 않는다.
    const maintenance = service.maintain(now);
    if (options.command === 'reply-plan') {
      const snapshot = service.create(options.fixture, ownerId, now, options.retention);
      output({ ...snapshot, maintenance, nextApproval: snapshot.task.status === 'AWAITING_APPROVAL'
        ? '표시된 계획 해시와 필수 유효기간으로 reply-approve를 호출하세요. 승인은 모의 전송을 시작하지 않습니다.' : null });
    } else if (options.command === 'reply-inspect') {
      output({ ...service.inspect(options.taskId, ownerId, now, options.approvalOffset), maintenance });
    } else if (options.command === 'reply-approve') {
      const approval = service.approve({ taskId: options.taskId, planHash: options.planHash, expiresInMinutes: options.expiresInMinutes }, ownerId, now);
      output({ ...withoutBody(service.inspect(options.taskId, ownerId, now)), approval, maintenance });
    } else if (options.command === 'reply-send') {
      const attempt = await service.send(options.taskId, options.planHash, ownerId, now);
      output({ ...withoutBody(service.inspect(options.taskId, ownerId, new Date())), attempt, maintenance });
    } else if (options.command === 'reply-cancel' || options.command === 'reply-invalidate') {
      const current = service.inspect(options.taskId, ownerId, now).task;
      const task = service.control({
        taskId: options.taskId, eventId: options.eventId || randomUUID(),
        kind: options.command === 'reply-cancel' ? 'cancel' : options.event,
        revision: options.command === 'reply-cancel' ? Math.max(current.requestRevision, current.contextRevision) : options.revision,
      }, ownerId, now);
      output({ ...withoutBody(service.inspect(options.taskId, ownerId, now)), task, maintenance });
    } else if (options.command === 'reply-recover') {
      output({ ...withoutBody(service.recover(options.taskId, ownerId, now)), maintenance });
    } else if (options.command === 'reply-prune') output({ maintenance });
    else throw new HarnessError('UNKNOWN_COMMAND');
  } finally {
    store.close();
    await application.close();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof HarnessError ? error.code : 'REPLY_WORKER_FAILED'}\n`);
  process.exitCode = 1;
});
