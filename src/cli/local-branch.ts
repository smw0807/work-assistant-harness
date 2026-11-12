import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BranchWorkType } from '../domain/branch.js';
import { HarnessError } from '../domain/errors.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';
import { acquireRuntimeLease, defaultDataDirectory, prepareDataDirectory, safeReadFlag } from './runtime.js';

export type LocalBranchCommand = 'git-branch-plan' | 'git-branch-inspect' | 'git-branch-approve'
  | 'git-branch-create' | 'git-branch-cancel' | 'git-branch-recover';

export interface LocalBranchWorkerOptions {
  command: LocalBranchCommand;
  sourceRoot: string;
  dataDirectory: string;
  taskId: string;
  planHash: string;
  workType: BranchWorkType;
  expiresInMinutes: number;
  approvalOffset: number;
}

export const localBranchUsage = [
  'pnpm harness git-branch-plan --type feature|fix|chore|refactor [--data-dir <private-directory>]',
  'pnpm harness git-branch-inspect --task <uuid> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
  'pnpm harness git-branch-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> [--data-dir <private-directory>]',
  'pnpm harness git-branch-create --task <uuid> --plan-hash <sha256> [--data-dir <private-directory>]',
  'pnpm harness git-branch-cancel --task <uuid> [--data-dir <private-directory>]',
  'pnpm harness git-branch-recover --task <uuid> [--data-dir <private-directory>]',
].join('\n');

const boundedInteger = (text: string, minimum: number, maximum: number): number => {
  if (!/^(?:0|[1-9]\d{0,9})$/.test(text) || Number(text) < minimum || Number(text) > maximum) {
    throw new HarnessError('INVALID_ARGUMENTS');
  }
  return Number(text);
};

const allowedFlags: Record<LocalBranchCommand, string[]> = {
  'git-branch-plan': ['--type'],
  'git-branch-inspect': ['--task', '--approval-offset'],
  'git-branch-approve': ['--task', '--plan-hash', '--expires-in-minutes'],
  'git-branch-create': ['--task', '--plan-hash'],
  'git-branch-cancel': ['--task'],
  'git-branch-recover': ['--task'],
};

const parseArguments = (arguments_: string[]): Omit<LocalBranchWorkerOptions, 'sourceRoot'> => {
  const command = arguments_[0] ?? '';
  if (!Object.hasOwn(allowedFlags, command)) throw new HarnessError('UNKNOWN_COMMAND');
  const localCommand = command as LocalBranchCommand;
  const flags = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const flag = arguments_[index] ?? '';
    const value = arguments_[index + 1];
    if ((!allowedFlags[localCommand].includes(flag) && flag !== '--data-dir') || !value
      || value.startsWith('--') || flags.has(flag)) throw new HarnessError('INVALID_ARGUMENTS');
    flags.set(flag, value);
  }
  const required = localCommand === 'git-branch-plan' ? ['--type']
    : localCommand === 'git-branch-approve' ? ['--task', '--plan-hash', '--expires-in-minutes']
    : localCommand === 'git-branch-create' ? ['--task', '--plan-hash'] : ['--task'];
  if (required.some((flag) => !flags.has(flag))) throw new HarnessError('INVALID_ARGUMENTS');
  const taskId = flags.get('--task') ?? '';
  const planHash = flags.get('--plan-hash') ?? '';
  const workType = flags.get('--type') ?? 'fix';
  if ((taskId && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(taskId))
    || (planHash && !/^[a-f0-9]{64}$/.test(planHash))
    || !['feature', 'fix', 'chore', 'refactor'].includes(workType)) throw new HarnessError('INVALID_ARGUMENTS');
  return {
    command: localCommand, taskId, planHash, workType: workType as BranchWorkType,
    dataDirectory: flags.get('--data-dir') ?? defaultDataDirectory(),
    expiresInMinutes: boundedInteger(flags.get('--expires-in-minutes') ?? '1', 1, 60),
    approvalOffset: boundedInteger(flags.get('--approval-offset') ?? '0', 0, 1_000_000_000),
  };
};

/** controller를 우회해 호출한 worker도 같은 명령별 입력 계약을 검증한다. */
export const assertLocalBranchWorkerOptions: (value: unknown) => asserts value is LocalBranchWorkerOptions = (value) => {
  const textKeys = ['command', 'sourceRoot', 'dataDirectory', 'taskId', 'planHash', 'workType'];
  const numberKeys = ['expiresInMinutes', 'approvalOffset'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessError('INVALID_ARGUMENTS');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== textKeys.length + numberKeys.length
    || textKeys.some((key) => typeof record[key] !== 'string')
    || numberKeys.some((key) => !Number.isSafeInteger(record[key]))
    || !Object.hasOwn(allowedFlags, String(record.command)) || !record.sourceRoot || !record.dataDirectory) {
    throw new HarnessError('INVALID_ARGUMENTS');
  }
  const options = value as LocalBranchWorkerOptions;
  const values: Record<string, string> = {
    '--type': options.workType, '--task': options.taskId, '--plan-hash': options.planHash,
    '--expires-in-minutes': String(options.expiresInMinutes), '--approval-offset': String(options.approvalOffset),
  };
  const arguments_ = [options.command, '--data-dir', options.dataDirectory];
  for (const flag of allowedFlags[options.command]) arguments_.push(flag, values[flag]!);
  const parsed = parseArguments(arguments_);
  if (Object.entries(parsed).some(([key, expected]) => record[key] !== expected)) throw new HarnessError('INVALID_ARGUMENTS');
};

export const assertPrivateLocalBranchFiles = (dataDirectory: string): void => {
  if (!process.getuid) throw new HarnessError('LOCAL_OWNER_UNAVAILABLE');
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const filePath = join(dataDirectory, `git-branches.sqlite${suffix}`);
    assertRuntimeFile(filePath);
    const metadata = runtimePathMetadata(filePath);
    if (metadata && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid())) {
      throw new HarnessError('LOCAL_BRANCH_DATABASE_NOT_PRIVATE');
    }
  }
};

export const runLocalBranchCommand = async (arguments_: string[]): Promise<void> => {
  process.umask(0o077);
  const parsed = parseArguments(arguments_);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = await prepareDataDirectory(parsed.dataDirectory, sourceRoot);
  assertPrivateLocalBranchFiles(dataDirectory);
  const release = acquireRuntimeLease(dataDirectory);
  try {
    const options: LocalBranchWorkerOptions = { ...parsed, sourceRoot, dataDirectory };
    const output = execFileSync(await realpath(process.execPath), [
      '--permission', safeReadFlag(sourceRoot), safeReadFlag(dataDirectory), `--allow-fs-write=${dataDirectory}`,
      join(sourceRoot, 'dist', 'src', 'cli', 'local-branch-worker.js'), JSON.stringify(options),
    ], {
      cwd: sourceRoot, env: { LANG: 'C.UTF-8', TZ: 'UTC' }, encoding: 'utf8', timeout: 30_000,
      maxBuffer: 256_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(output);
    const result = JSON.parse(output) as { task: { status: string } };
    if (parsed.command === 'git-branch-create' && result.task.status !== 'SUCCEEDED') process.exitCode = 1;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new HarnessError(/^[A-Z][A-Z0-9_]{1,80}$/.test(stderr) ? stderr : 'LOCAL_BRANCH_WORKER_FAILED');
  } finally { release(); }
};
