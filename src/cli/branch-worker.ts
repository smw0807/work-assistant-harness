import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockBranchWorkspace } from '../adapters/mock-branch-workspace.js';
import { SqliteBranchStore } from '../adapters/sqlite-branch-store.js';
import { SyntheticBranchService } from '../application/simulate-branch.js';
import { HarnessError } from '../domain/errors.js';
import type { BranchStore } from '../ports/branch.js';
import { assertBranchWorkerOptions, assertPrivateBranchFiles, type BranchWorkerOptions } from './branch.js';
import { isInside, safeReadFlag } from './runtime.js';

const STORE = Symbol('BranchStore');

@Module({})
class BranchModule {}

const assertRestrictedWorker = async (options: BranchWorkerOptions): Promise<void> => {
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const permissions = process.permission;
  // 경로 없는 has('fs.read')만으로는 '/'처럼 넓은 경로 권한을 판별할 수 없다.
  const permissionFlags = ['--permission', safeReadFlag(sourceRoot), safeReadFlag(options.dataDirectory),
    `--allow-fs-write=${options.dataDirectory}`];
  if (options.sourceRoot !== sourceRoot || !permissions || permissions.has('fs.write', sourceRoot)
    || process.execArgv.length !== permissionFlags.length || process.execArgv.some((flag) => !permissionFlags.includes(flag))
    || permissions.has('fs.read', '/') || !permissions.has('fs.write', options.dataDirectory)
    || permissions.has('child') || permissions.has('worker') || permissions.has('net')
    || permissions.has('addons') || permissions.has('wasi') || permissions.has('inspector')) {
    throw new HarnessError('BRANCH_UNSAFE_WORKER_PERMISSIONS');
  }
  if (!process.getuid) throw new HarnessError('LOCAL_OWNER_UNAVAILABLE');
  const localeKeys = ['LANG', 'TZ', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])];
  if (Object.keys(process.env).some((key) => !localeKeys.includes(key))) throw new HarnessError('BRANCH_UNSAFE_WORKER_ENVIRONMENT');
  const directory = await lstat(options.dataDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
    || directory.uid !== process.getuid() || await realpath(options.dataDirectory) !== options.dataDirectory
    || isInside(sourceRoot, options.dataDirectory) || isInside(options.dataDirectory, sourceRoot)) {
    throw new HarnessError('DATA_DIRECTORY_NOT_PRIVATE');
  }
  assertPrivateBranchFiles(options.dataDirectory);
};

const run = async (): Promise<void> => {
  process.umask(0o077);
  let options: unknown;
  try { options = JSON.parse(process.argv[2] ?? '{}') as unknown; } catch { throw new HarnessError('INVALID_ARGUMENTS'); }
  assertBranchWorkerOptions(options);
  await assertRestrictedWorker(options);
  const ownerId = `os-user:${process.getuid!()}`;
  const application = await NestFactory.createApplicationContext({
    module: BranchModule,
    providers: [
      { provide: STORE, useFactory: () => new SqliteBranchStore(join(options.dataDirectory, 'branches.sqlite')) },
      { provide: SyntheticBranchService, inject: [STORE], useFactory: (store: BranchStore) => new SyntheticBranchService(store, new MockBranchWorkspace()) },
    ],
  }, { logger: false, abortOnError: false });
  const store = application.get<BranchStore>(STORE);
  const service = application.get(SyntheticBranchService);
  const now = new Date();
  const output = (result: object): void => { process.stdout.write(`${JSON.stringify({
    ...result, mode: 'offline', dataDirectory: options.dataDirectory,
    checks: [
      { name: 'restricted_worker', status: 'passed', reason: '합성 브랜치 worker는 비공개 DB 쓰기만 허용하며 네트워크·하위 프로세스·상속 토큰을 차단합니다.' },
      { name: 'actual_git_operations', status: 'not_run', reason: '실제 저장소 접근·브랜치 생성·수정·commit·push·PR/MR을 수행하지 않는 모의 계약입니다.' },
      { name: 'codex_execution', status: 'not_run', reason: 'Codex와 실제 모델을 호출하지 않습니다. 계획의 커밋·diff는 합성 식별자료입니다.' },
    ],
  }, null, 2)}\n`); };
  try {
    if (options.command === 'branch-plan') {
      const snapshot = service.create(options.workType, options.fixture, ownerId, now);
      output({ ...snapshot, nextApproval: snapshot.task.status === 'AWAITING_APPROVAL'
        ? '브랜치·기준·계획 해시를 검토하고 branch-approve에 필수 TTL을 지정하세요. 승인은 모의 실행만 허용합니다.' : null });
    } else if (options.command === 'branch-inspect') {
      output(service.inspect(options.taskId, ownerId, now, options.approvalOffset));
    } else if (options.command === 'branch-approve') {
      const approval = service.approve({ taskId: options.taskId, planHash: options.planHash, expiresInMinutes: options.expiresInMinutes }, ownerId, now);
      output({ ...service.inspect(options.taskId, ownerId, now), approval });
    } else if (options.command === 'branch-simulate') {
      await service.simulate(options.taskId, options.planHash, ownerId, now);
      output(service.inspect(options.taskId, ownerId, new Date()));
    } else if (options.command === 'branch-cancel' || options.command === 'branch-invalidate') {
      const current = service.inspect(options.taskId, ownerId, now).task;
      service.control({
        taskId: options.taskId, eventId: options.eventId || randomUUID(),
        kind: options.command === 'branch-cancel' ? 'cancel' : options.event,
        revision: options.command === 'branch-cancel' ? current.revision : options.revision,
      }, ownerId, now);
      output(service.inspect(options.taskId, ownerId, now));
    } else if (options.command === 'branch-recover') {
      output(service.recover(options.taskId, ownerId, now));
    } else throw new HarnessError('UNKNOWN_COMMAND');
  } finally {
    store.close();
    await application.close();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof HarnessError ? error.code : 'BRANCH_WORKER_FAILED'}\n`);
  process.exitCode = 1;
});
