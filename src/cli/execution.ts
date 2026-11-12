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
import {
  BRANCH_EXECUTION_POLICY_VERSION, CODEX_EXECUTION_POLICY_VERSION, EXECUTION_POLICY_VERSION,
  type ExecutionFixture, type ExecutionPolicyVersion, type ExecutionRun,
} from '../domain/execution.js';
import type { BranchWorkType } from '../domain/branch.js';
import type { CodexProposalExport } from '../domain/codex-proposal.js';
import type { SandboxConfig } from '../domain/sandbox.js';
import { parseSandboxConfig } from '../policy/sandbox-policy.js';
import { acquireRuntimeLease, assertSafeEventFile, defaultDataDirectory, prepareDataDirectory } from './runtime.js';
import { consumeCodexProposal, readCodexConfig } from './codex-proposal.js';

export const executionUsage = [
  'pnpm harness execution-plan [--fixture success|test-failure|timeout|output] [--config <local-json>] [--data-dir <private-directory>]',
  'pnpm harness execution-approve --task <id> --plan-hash <sha256> --base-commit <sha1> --expires-in-minutes <1..1440> [--config <local-json>] [--data-dir <private-directory>]',
  'pnpm harness execution-run --task <id> --plan-hash <sha256> --base-commit <sha1> [--config <local-json>] [--data-dir <private-directory>]',
  'pnpm harness execution-inspect --task <id> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
  'pnpm harness execution-cancel --task <id> [--event-id <synthetic-id>] [--data-dir <private-directory>]',
  'pnpm harness execution-invalidate --task <id> --event edited|deleted --revision <2..1000000000> --event-id <synthetic-id> [--data-dir <private-directory>]',
  'pnpm harness execution-recover --task <id> [--config <local-json>] [--data-dir <private-directory>]',
].join('\n');

export const branchExecutionUsage = [
  'pnpm harness branch-execution-plan --type feature|fix|chore|refactor [--fixture success|test-failure|timeout|output] [--config <local-json>] [--data-dir <private-directory>]',
  'pnpm harness branch-execution-approve --task <id> --plan-hash <sha256> --base-commit <sha1> --expires-in-minutes <1..60> [--config <local-json>] [--data-dir <private-directory>]',
  'pnpm harness branch-execution-run --task <id> --plan-hash <sha256> --base-commit <sha1> [--config <local-json>] [--data-dir <private-directory>]',
  'pnpm harness branch-execution-inspect --task <id> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
  'pnpm harness branch-execution-cancel --task <id> [--event-id <synthetic-id>] [--data-dir <private-directory>]',
  'pnpm harness branch-execution-invalidate --task <id> --event edited|deleted --revision <2..1000000000> --event-id <synthetic-id> [--data-dir <private-directory>]',
  'pnpm harness branch-execution-recover --task <id> [--config <local-json>] [--data-dir <private-directory>]',
].join('\n');

export const codexExecutionUsage = [
  'pnpm harness codex-execution-plan --proposal <uuid> --codex-config <local-json> --config <local-docker-json> [--data-dir <private-directory>]',
  'pnpm harness codex-execution-approve --task <uuid> --plan-hash <sha256> --base-commit <sha1> --expires-in-minutes <1..60> [--config <local-docker-json>] [--data-dir <private-directory>]',
  'pnpm harness codex-execution-run --task <uuid> --plan-hash <sha256> --base-commit <sha1> [--config <local-docker-json>] [--data-dir <private-directory>]',
  'pnpm harness codex-execution-inspect --task <uuid> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
  'pnpm harness codex-execution-cancel --task <uuid> [--event-id <synthetic-id>] [--data-dir <private-directory>]',
  'pnpm harness codex-execution-invalidate --task <uuid> --event edited|deleted --revision <2..1000000000> --event-id <synthetic-id> [--data-dir <private-directory>]',
  'pnpm harness codex-execution-recover --task <uuid> [--config <local-docker-json>] [--data-dir <private-directory>]',
].join('\n');

interface ExecutionProfile {
  prefix: 'execution' | 'branch-execution' | 'codex-execution';
  directory: 'executions' | 'branch-executions' | 'codex-executions';
  database: 'execution.sqlite' | 'branch-execution.sqlite' | 'codex-execution.sqlite';
  policy: ExecutionPolicyVersion;
}

const executionProfile: ExecutionProfile = {
  prefix: 'execution', directory: 'executions', database: 'execution.sqlite', policy: EXECUTION_POLICY_VERSION,
};
const branchExecutionProfile: ExecutionProfile = {
  prefix: 'branch-execution', directory: 'branch-executions', database: 'branch-execution.sqlite',
  policy: BRANCH_EXECUTION_POLICY_VERSION,
};
const codexExecutionProfile: ExecutionProfile = {
  prefix: 'codex-execution', directory: 'codex-executions', database: 'codex-execution.sqlite', policy: CODEX_EXECUTION_POLICY_VERSION,
};

@Module({})
class ExecutionModule {
  static configure(store: SqliteExecutionStore, config: SandboxConfig, controlDirectory: string, policy: ExecutionPolicyVersion): DynamicModule {
    return {
      module: ExecutionModule,
      providers: [{ provide: SyntheticExecutionService, useFactory: () => new SyntheticExecutionService(
        store, new SyntheticExecutionWorkspace(), new DockerIsolatedExecution(config, controlDirectory, undefined, undefined, policy),
        config, undefined, undefined, policy,
      ) }],
    };
  }
}

const parseArguments = (arguments_: string[], profile: ExecutionProfile): { command: string; options: Map<string, string> } => {
  const input = arguments_[0] ?? '';
  if (!input.startsWith(`${profile.prefix}-`)) throw new HarnessError('UNKNOWN_COMMAND');
  const command = `execution-${input.slice(profile.prefix.length + 1)}`;
  const allowed: Record<string, string[]> = {
    'execution-plan': profile.policy === CODEX_EXECUTION_POLICY_VERSION ? ['--proposal', '--codex-config', '--config', '--data-dir']
      : ['--fixture', '--config', '--data-dir', ...(profile.policy === BRANCH_EXECUTION_POLICY_VERSION ? ['--type'] : [])],
    'execution-approve': ['--task', '--plan-hash', '--base-commit', '--expires-in-minutes', '--config', '--data-dir'],
    'execution-run': ['--task', '--plan-hash', '--base-commit', '--config', '--data-dir'],
    'execution-inspect': ['--task', '--approval-offset', '--data-dir'],
    'execution-cancel': ['--task', '--event-id', '--data-dir'],
    'execution-invalidate': ['--task', '--event', '--revision', '--event-id', '--data-dir'],
    'execution-recover': ['--task', '--config', '--data-dir'],
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
  const required = command === 'execution-plan' ? (profile.policy === CODEX_EXECUTION_POLICY_VERSION ? ['--proposal', '--codex-config', '--config']
    : profile.policy === BRANCH_EXECUTION_POLICY_VERSION ? ['--type'] : [])
    : command === 'execution-invalidate' ? ['--task', '--event', '--revision', '--event-id']
    : ['execution-inspect', 'execution-cancel', 'execution-recover'].includes(command) ? ['--task']
    : ['--task', '--plan-hash', '--base-commit', ...(command === 'execution-approve' ? ['--expires-in-minutes'] : [])];
  if (required.some((key) => !options.has(key))) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--task') && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(options.get('--task')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--proposal') && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(options.get('--proposal')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--plan-hash') && !/^[a-f0-9]{64}$/.test(options.get('--plan-hash')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--base-commit') && !/^[a-f0-9]{40}$/.test(options.get('--base-commit')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--expires-in-minutes') && !/^(?:[1-9]\d{0,2}|1[0-3]\d{2}|14[0-3]\d|1440)$/.test(options.get('--expires-in-minutes')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (profile.policy !== EXECUTION_POLICY_VERSION && options.has('--expires-in-minutes')
    && Number(options.get('--expires-in-minutes')) > 60) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--approval-offset') && (!/^(?:0|[1-9]\d{0,9})$/.test(options.get('--approval-offset')!)
    || Number(options.get('--approval-offset')) > 1_000_000_000)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--fixture') && !['success', 'test-failure', 'timeout', 'output'].includes(options.get('--fixture')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--type') && !['feature', 'fix', 'chore', 'refactor'].includes(options.get('--type')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--event') && !['edited', 'deleted'].includes(options.get('--event')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--event-id') && !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(options.get('--event-id')!)) throw new HarnessError('INVALID_ARGUMENTS');
  if (options.has('--revision') && (!/^[1-9]\d{0,9}$/.test(options.get('--revision')!)
    || Number(options.get('--revision')) < 2 || Number(options.get('--revision')) > 1_000_000_000)) throw new HarnessError('INVALID_ARGUMENTS');
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

const readSandboxConfig = async (requested: string): Promise<SandboxConfig> => {
  const path = await assertSafeEventFile(requested);
  try { return parseSandboxConfig(JSON.parse(await readFile(path, 'utf8'))); }
  catch { throw new HarnessError('INVALID_SANDBOX_CONFIG'); }
};

const runProfileCommand = async (arguments_: string[], profile: ExecutionProfile): Promise<void> => {
  process.umask(0o077);
  const { command, options } = parseArguments(arguments_, profile);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = await prepareDataDirectory(options.get('--data-dir') ?? defaultDataDirectory(), sourceRoot);
  // 실행 소유 lease는 유지한다. 제어 기록은 짧은 별도 DB 트랜잭션으로 전달한다.
  const release = ['execution-cancel', 'execution-invalidate', 'execution-inspect'].includes(command)
    ? () => undefined : acquireRuntimeLease(dataDirectory);
  let store: SqliteExecutionStore | null = null;
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  try {
    const ownerId = process.getuid ? `os-user:${process.getuid()}` : '';
    const context = { ownerId, now: new Date() };
    let proposal: CodexProposalExport | null = null;
    let planConfig: SandboxConfig | null = null;
    if (profile.policy === CODEX_EXECUTION_POLICY_VERSION && command === 'execution-plan') {
      // 입력 설정부터 검사한다. export 이후 DB/원본 준비가 실패해도 제안 소비는 되돌리지 않는다.
      planConfig = await readSandboxConfig(options.get('--config')!);
      const codexConfig = await readCodexConfig(options.get('--codex-config')!);
      proposal = consumeCodexProposal(dataDirectory, options.get('--proposal')!, codexConfig, context);
    }
    const root = join(dataDirectory, profile.directory);
    try { await privateDirectory(root); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      await privateDirectory(root, true);
    }
    store = new SqliteExecutionStore(join(dataDirectory, profile.database), profile.policy);
    const taskId = proposal?.proposalId ?? options.get('--task') ?? randomUUID();
    if (command !== 'execution-plan') {
      const existing = store.find(taskId);
      if (!existing) throw new HarnessError('EXECUTION_TASK_NOT_FOUND');
      if (existing.sourceRoot !== join(root, taskId, 'source')) throw new HarnessError('UNSAFE_EXECUTION_DIRECTORY');
      await privateDirectory(join(root, taskId));
    }
    if (command === 'execution-cancel' || command === 'execution-invalidate') {
      const current = store.requestState(taskId);
      const requestState = store.control({
        taskId, eventId: options.get('--event-id') ?? randomUUID(),
        kind: command === 'execution-cancel' ? 'cancel' : options.get('--event') as 'edited' | 'deleted',
        revision: command === 'execution-cancel' ? current.revision : Number(options.get('--revision')),
      }, context);
      process.stdout.write(`${JSON.stringify({ task: store.find(taskId), requestState }, null, 2)}\n`);
      return;
    }
    if (command === 'execution-inspect') {
      const snapshot = store.inspect(taskId, Number(options.get('--approval-offset') ?? 0));
      const reportPaths = [];
      for (const run of snapshot.runs) {
        if (dirname(run.artifactDirectory) !== join(root, taskId) || !/^run-[a-f0-9-]{36}$/.test(basename(run.artifactDirectory))) {
          throw new HarnessError('UNSAFE_EXECUTION_DIRECTORY');
        }
        if (run.finishedAt) reportPaths.push(await persistRunReport(run));
      }
      process.stdout.write(`${JSON.stringify({ ...snapshot, reportPaths }, null, 2)}\n`);
      return;
    }
    const config = planConfig ?? await readSandboxConfig(options.get('--config') ?? join(sourceRoot, 'config/sandbox.example.json'));
    const taskDirectory = await privateDirectory(join(root, taskId), command === 'execution-plan');
    const recovering = command === 'execution-recover' ? store.listRuns(taskId)[0] : undefined;
    if (recovering && (dirname(recovering.artifactDirectory) !== taskDirectory
      || !/^run-[a-f0-9-]{36}$/.test(basename(recovering.artifactDirectory)))) throw new HarnessError('UNSAFE_EXECUTION_DIRECTORY');
    const artifactDirectory = command === 'execution-run' ? await privateDirectory(join(taskDirectory, `run-${randomUUID()}`), true)
      : recovering ? await privateDirectory(recovering.artifactDirectory) : taskDirectory;
    const controlDirectory = join(artifactDirectory, `docker-control-${randomUUID()}`);
    // plan/approve는 Docker를 호출하지 않으며 control directory도 실행 때만 생성한다.
    if (command === 'execution-run' || command === 'execution-recover') await privateDirectory(controlDirectory, true);
    const application = await NestFactory.createApplicationContext(ExecutionModule.configure(store, config, controlDirectory, profile.policy), { logger: false, abortOnError: false });
    try {
      const service = application.get(SyntheticExecutionService);
      if (command === 'execution-plan') {
        const task = proposal ? await service.planProposal(taskId, taskDirectory, proposal.workType, proposal.content, {
          proposalId: proposal.proposalId, inputHash: proposal.inputHash, responseHash: proposal.responseHash,
          configHash: proposal.configHash, validatorVersion: 'codex-proposal-v1',
        }) : await service.plan(taskId, taskDirectory, (options.get('--fixture') ?? 'success') as ExecutionFixture,
          options.get('--type') as BranchWorkType | undefined);
        process.stdout.write(`${JSON.stringify({ task, nextApproval: `표시된 실행 계획 해시·기준 커밋과 필수 유효기간으로 ${profile.prefix}-approve를 호출하세요.` }, null, 2)}\n`);
      } else if (command === 'execution-recover') {
        const run = await service.recover(taskId, context);
        const reportPath = run?.finishedAt ? await persistRunReport(run) : null;
        process.stdout.write(`${JSON.stringify({ task: store.find(taskId), requestState: store.requestState(taskId), run,
          lifecycle: run ? store.lifecycle(run.runId) : null, reportPath }, null, 2)}\n`);
        if (run?.status === 'BLOCKED') process.exitCode = 1;
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

export const runExecutionCommand = (arguments_: string[]): Promise<void> => runProfileCommand(arguments_, executionProfile);
export const runBranchExecutionCommand = (arguments_: string[]): Promise<void> => runProfileCommand(arguments_, branchExecutionProfile);
export const runCodexExecutionCommand = (arguments_: string[]): Promise<void> => runProfileCommand(arguments_, codexExecutionProfile);
