import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerIsolatedExecution } from '../adapters/docker-execution.js';
import { SyntheticExecutionWorkspace } from '../adapters/execution-workspace.js';
import { SqliteExecutionStore } from '../adapters/sqlite-execution-store.js';
import { SyntheticExecutionService } from '../application/execute-synthetic.js';
import { HarnessError } from '../domain/errors.js';
import type { ExecutionFixture, ExecutionRun } from '../domain/execution.js';
import type { SandboxConfig } from '../domain/sandbox.js';
import { parseSandboxConfig } from '../policy/sandbox-policy.js';
import { acquireRuntimeLease, assertSafeEventFile, defaultDataDirectory, prepareDataDirectory } from './runtime.js';

export const executionUsage = [
  'pnpm harness execution-plan [--fixture success|test-failure|timeout|output] [--config <local-json>] [--data-dir <private-directory>]',
  'pnpm harness execution-approve --task <id> --plan-hash <sha256> --base-commit <sha1> --expires-in-minutes <1..1440> [--config <local-json>] [--data-dir <private-directory>]',
  'pnpm harness execution-run --task <id> --plan-hash <sha256> --base-commit <sha1> [--config <local-json>] [--data-dir <private-directory>]',
  'pnpm harness execution-inspect --task <id> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
].join('\n');

@Module({})
class ExecutionModule {
  static configure(store: SqliteExecutionStore, config: SandboxConfig, controlDirectory: string): DynamicModule {
    return {
      module: ExecutionModule,
      providers: [{ provide: SyntheticExecutionService, useFactory: () => new SyntheticExecutionService(
        store, new SyntheticExecutionWorkspace(), new DockerIsolatedExecution(config, controlDirectory), config,
      ) }],
    };
  }
}

const parseArguments = (arguments_: string[]): { command: string; options: Map<string, string> } => {
  const command = arguments_[0] ?? '';
  const allowed: Record<string, string[]> = {
    'execution-plan': ['--fixture', '--config', '--data-dir'],
    'execution-approve': ['--task', '--plan-hash', '--base-commit', '--expires-in-minutes', '--config', '--data-dir'],
    'execution-run': ['--task', '--plan-hash', '--base-commit', '--config', '--data-dir'],
    'execution-inspect': ['--task', '--approval-offset', '--data-dir'],
  };
  if (!Object.hasOwn(allowed, command)) throw new HarnessError('UNKNOWN_COMMAND');
  const options = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const name = arguments_[index] ?? '';
    const value = arguments_[index + 1];
    if (!allowed[command]!.includes(name) || !value || value.startsWith('--') || options.has(name)) {
      throw new HarnessError('INVALID_ARGUMENTS');
    }
    options.set(name, value);
  }
  const required = command === 'execution-plan' ? [] : command === 'execution-inspect' ? ['--task']
    : ['--task', '--plan-hash', '--base-commit', ...(command === 'execution-approve' ? ['--expires-in-minutes'] : [])];
  if (required.some((key) => !options.has(key))) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--task') && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(options.get('--task')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--plan-hash') && !/^[a-f0-9]{64}$/.test(options.get('--plan-hash')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--base-commit') && !/^[a-f0-9]{40}$/.test(options.get('--base-commit')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--expires-in-minutes') && !/^(?:[1-9]\d{0,2}|1[0-3]\d{2}|14[0-3]\d|1440)$/.test(options.get('--expires-in-minutes')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--approval-offset') && (!/^(?:0|[1-9]\d{0,9})$/.test(options.get('--approval-offset')!)
    || Number(options.get('--approval-offset')) > 1_000_000_000)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--fixture') && !['success', 'test-failure', 'timeout', 'output'].includes(options.get('--fixture')!)) throw new HarnessError('INVALID_ARGUMENTS');
  return { command, options };
};

const privateDirectory = async (directory: string, create = false): Promise<string> => {
  if (create) await mkdir(directory, { mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()
    || await realpath(directory) !== directory) throw new HarnessError('UNSAFE_EXECUTION_DIRECTORY');
  return directory;
};

const persistRunReport = async (run: ExecutionRun): Promise<string> => {
  await privateDirectory(run.artifactDirectory);
  const reportPath = join(run.artifactDirectory, 'report.json');
  const contents = `${JSON.stringify(run, null, 2)}\n`;
  if (Buffer.byteLength(contents) > 64_000) throw new HarnessError('EXECUTION_REPORT_TOO_LARGE');
  try { await writeFile(reportPath, contents, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    // SQLite가 원본이다. 기존 보고서는 덮어쓰지 않고 안전한 동일 내용만 재사용한다.
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const metadata = await lstat(reportPath);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 64_000 || (metadata.mode & 0o077) !== 0
      || await readFile(reportPath, 'utf8') !== contents) throw new HarnessError('UNSAFE_EXECUTION_REPORT');
  }
  return reportPath;
};

export const runExecutionCommand = async (arguments_: string[]): Promise<void> => {
  process.umask(0o077);
  const { command, options } = parseArguments(arguments_);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = await prepareDataDirectory(options.get('--data-dir') ?? defaultDataDirectory(), sourceRoot);
  const release = acquireRuntimeLease(dataDirectory);
  let store: SqliteExecutionStore | null = null;
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  try {
    const root = join(dataDirectory, 'executions');
    try { await privateDirectory(root); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await privateDirectory(root, true);
    }
    store = new SqliteExecutionStore(join(dataDirectory, 'execution.sqlite'));
    const taskId = options.get('--task') ?? randomUUID();
    if (command !== 'execution-plan') {
      const existing = store.find(taskId);
      if (!existing) throw new HarnessError('EXECUTION_TASK_NOT_FOUND');
      if (existing.sourceRoot !== join(root, taskId, 'source')) throw new HarnessError('UNSAFE_EXECUTION_DIRECTORY');
      await privateDirectory(join(root, taskId));
    }
    if (command === 'execution-inspect') {
      const task = store.find(taskId);
      if (!task) throw new HarnessError('EXECUTION_TASK_NOT_FOUND');
      const runs = store.listRuns(taskId);
      const reportPaths = [];
      for (const run of runs) {
        if (dirname(run.artifactDirectory) !== join(root, taskId) || !/^run-[a-f0-9-]{36}$/.test(basename(run.artifactDirectory))) {
          throw new HarnessError('UNSAFE_EXECUTION_DIRECTORY');
        }
        if (run.finishedAt) reportPaths.push(await persistRunReport(run));
      }
      process.stdout.write(`${JSON.stringify({ task, ...store.listApprovalHistory(taskId, Number(options.get('--approval-offset') ?? 0)), runs, reportPaths }, null, 2)}\n`);
      return;
    }
    const configPath = await assertSafeEventFile(options.get('--config') ?? join(sourceRoot, 'config/sandbox.example.json'));
    let config: SandboxConfig;
    try { config = parseSandboxConfig(JSON.parse(await readFile(configPath, 'utf8'))); }
    catch { throw new HarnessError('INVALID_SANDBOX_CONFIG'); }
    const taskDirectory = await privateDirectory(join(root, taskId), command === 'execution-plan');
    const artifactDirectory = command === 'execution-run'
      ? await privateDirectory(join(taskDirectory, `run-${randomUUID()}`), true) : taskDirectory;
    const controlDirectory = join(artifactDirectory, `docker-control-${randomUUID()}`);
    // plan/approve는 Docker를 호출하지 않으며 control directory도 실행 때만 생성한다.
    if (command === 'execution-run') await privateDirectory(controlDirectory, true);
    const application = await NestFactory.createApplicationContext(ExecutionModule.configure(store, config, controlDirectory), { logger: false, abortOnError: false });
    try {
      const service = application.get(SyntheticExecutionService);
      const ownerId = process.getuid ? `os-user:${process.getuid()}` : '';
      const context = { ownerId, now: new Date() };
      if (command === 'execution-plan') {
        const task = await service.plan(taskId, taskDirectory, (options.get('--fixture') ?? 'success') as ExecutionFixture);
        process.stdout.write(`${JSON.stringify({ task, nextApproval: '표시된 실행 계획 해시·기준 커밋과 필수 유효기간으로 execution-approve를 호출하세요.' }, null, 2)}\n`);
      } else {
        const request = { taskId, planHash: options.get('--plan-hash')!, baseCommit: options.get('--base-commit')! };
        if (command === 'execution-approve') {
          const approval = await service.approve({ ...request, expiresInMinutes: Number(options.get('--expires-in-minutes')) }, context);
          process.stdout.write(`${JSON.stringify({ task: store.find(taskId), approval }, null, 2)}\n`);
        } else {
          const run = await service.run(request, context, artifactDirectory, controller.signal);
          const reportPath = await persistRunReport(run);
          process.stdout.write(`${JSON.stringify({ task: store.find(taskId), run, reportPath }, null, 2)}\n`);
          if (run.status !== 'SUCCEEDED') process.exitCode = 1;
        }
      }
    } finally { await application.close(); }
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    store?.close(); release();
  }
};
