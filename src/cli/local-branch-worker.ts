import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteLocalBranchStore } from '../adapters/sqlite-local-branch-store.js';
import { SyntheticLocalBranchWorkspace } from '../adapters/local-branch-workspace.js';
import { LocalBranchService } from '../application/local-branch.js';
import { HarnessError } from '../domain/errors.js';
import {
  assertLocalBranchWorkerOptions, assertPrivateLocalBranchFiles, type LocalBranchWorkerOptions,
} from './local-branch.js';
import { isInside, safeReadFlag } from './runtime.js';

const STORE = Symbol('LocalBranchStore');

@Module({})
class LocalBranchModule {}

const assertRestrictedWorker = async (options: LocalBranchWorkerOptions): Promise<void> => {
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const permissions = process.permission;
  const expectedFlags = ['--permission', safeReadFlag(sourceRoot), safeReadFlag(options.dataDirectory),
    `--allow-fs-write=${options.dataDirectory}`];
  if (options.sourceRoot !== sourceRoot || !permissions || permissions.has('fs.write', sourceRoot)
    || process.execArgv.length !== expectedFlags.length || process.execArgv.some((flag, index) => flag !== expectedFlags[index])
    || permissions.has('fs.read', '/') || !permissions.has('fs.write', options.dataDirectory)
    || permissions.has('child') || permissions.has('worker') || permissions.has('net')
    || permissions.has('addons') || permissions.has('wasi') || permissions.has('inspector')) {
    throw new HarnessError('LOCAL_BRANCH_UNSAFE_WORKER_PERMISSIONS');
  }
  if (!process.getuid) throw new HarnessError('LOCAL_OWNER_UNAVAILABLE');
  const localeKeys = ['LANG', 'TZ', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])];
  if (Object.keys(process.env).some((key) => !localeKeys.includes(key))) throw new HarnessError('LOCAL_BRANCH_UNSAFE_WORKER_ENVIRONMENT');
  const directory = await lstat(options.dataDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
    || directory.uid !== process.getuid() || await realpath(options.dataDirectory) !== options.dataDirectory
    || isInside(sourceRoot, options.dataDirectory) || isInside(options.dataDirectory, sourceRoot)) {
    throw new HarnessError('DATA_DIRECTORY_NOT_PRIVATE');
  }
  assertPrivateLocalBranchFiles(options.dataDirectory);
};

const run = async (): Promise<void> => {
  process.umask(0o077);
  let options: unknown;
  try { options = JSON.parse(process.argv[2] ?? '{}') as unknown; } catch { throw new HarnessError('INVALID_ARGUMENTS'); }
  assertLocalBranchWorkerOptions(options);
  await assertRestrictedWorker(options);
  const ownerId = `os-user:${process.getuid!()}`;
  const application = await NestFactory.createApplicationContext({
    module: LocalBranchModule,
    providers: [
      { provide: STORE, useFactory: () => new SqliteLocalBranchStore(join(options.dataDirectory, 'git-branches.sqlite')) },
      { provide: LocalBranchService, inject: [STORE], useFactory: (store: SqliteLocalBranchStore) =>
        new LocalBranchService(store, new SyntheticLocalBranchWorkspace(options.dataDirectory)) },
    ],
  }, { logger: false, abortOnError: false });
  const store = application.get<SqliteLocalBranchStore>(STORE);
  const service = application.get(LocalBranchService);
  const now = new Date();
  const output = (result: object): void => { process.stdout.write(`${JSON.stringify({
    ...result, mode: 'local-synthetic', dataDirectory: options.dataDirectory,
    checks: [
      { name: 'restricted_worker', status: 'passed', reason: '전용 합성 저장소와 비공개 DB만 쓰며 네트워크·하위 프로세스·상속 토큰을 차단합니다.' },
      { name: 'codex_execution', status: 'not_run', reason: '실제 Codex와 모델을 호출하지 않습니다.' },
      { name: 'git_remote_operations', status: 'not_run', reason: '회사 저장소와 Git 원격을 연결하지 않으며 push·PR/MR을 수행하지 않습니다.' },
    ],
  }, null, 2)}\n`); };
  try {
    if (options.command === 'git-branch-plan') output(await service.plan(options.workType, ownerId, now));
    else if (options.command === 'git-branch-inspect') output(service.inspect(options.taskId, ownerId, now, options.approvalOffset));
    else if (options.command === 'git-branch-approve') {
      output(await service.approve({ taskId: options.taskId, planHash: options.planHash, expiresInMinutes: options.expiresInMinutes }, ownerId, now));
    } else if (options.command === 'git-branch-create') output(await service.create(options.taskId, options.planHash, ownerId, now));
    else if (options.command === 'git-branch-cancel') output(service.cancel(options.taskId, ownerId, now));
    else if (options.command === 'git-branch-recover') output(service.recover(options.taskId, ownerId, now));
    else throw new HarnessError('UNKNOWN_COMMAND');
  } finally {
    store.close();
    await application.close();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof HarnessError ? error.code : 'LOCAL_BRANCH_WORKER_FAILED'}\n`);
  process.exitCode = 1;
});
