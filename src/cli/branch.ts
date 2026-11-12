import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BranchControlKind, BranchFixture, BranchWorkType } from '../domain/branch.js';
import { HarnessError } from '../domain/errors.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';
import { acquireRuntimeLease, defaultDataDirectory, prepareDataDirectory, safeReadFlag } from './runtime.js';

export type BranchCommand = 'branch-plan' | 'branch-inspect' | 'branch-approve' | 'branch-simulate'
  | 'branch-cancel' | 'branch-invalidate' | 'branch-recover';

export interface BranchWorkerOptions {
  command: BranchCommand;
  sourceRoot: string;
  dataDirectory: string;
  taskId: string;
  planHash: string;
  workType: BranchWorkType;
  fixture: BranchFixture;
  expiresInMinutes: number;
  approvalOffset: number;
  eventId: string;
  event: Exclude<BranchControlKind, 'cancel'>;
  revision: number;
}

export const branchUsage = [
  'pnpm harness branch-plan --type feature|fix|chore|refactor [--fixture success|collision|source-changed|unknown] [--data-dir <private-directory>]',
  'pnpm harness branch-inspect --task <uuid> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
  'pnpm harness branch-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> [--data-dir <private-directory>]',
  'pnpm harness branch-simulate --task <uuid> --plan-hash <sha256> [--data-dir <private-directory>]',
  'pnpm harness branch-cancel --task <uuid> [--event-id <synthetic-id>] [--data-dir <private-directory>]',
  'pnpm harness branch-invalidate --task <uuid> --event edited|deleted|base-changed|diff-changed|branch-conflict --revision <2..1000000000> --event-id <synthetic-id> [--data-dir <private-directory>]',
  'pnpm harness branch-recover --task <uuid> [--data-dir <private-directory>]',
].join('\n');

const boundedInteger = (text: string, minimum: number, maximum: number): number => {
  if (!/^(?:0|[1-9]\d{0,9})$/.test(text) || Number(text) < minimum || Number(text) > maximum) {
    throw new HarnessError('INVALID_ARGUMENTS');
  }
  return Number(text);
};

const allowedFlags: Record<BranchCommand, string[]> = {
  'branch-plan': ['--type', '--fixture'],
  'branch-inspect': ['--task', '--approval-offset'],
  'branch-approve': ['--task', '--plan-hash', '--expires-in-minutes'],
  'branch-simulate': ['--task', '--plan-hash'],
  'branch-cancel': ['--task', '--event-id'],
  'branch-invalidate': ['--task', '--event', '--revision', '--event-id'],
  'branch-recover': ['--task'],
};

const parseArguments = (arguments_: string[]): Omit<BranchWorkerOptions, 'sourceRoot'> => {
  const command = arguments_[0] ?? '';
  if (!Object.hasOwn(allowedFlags, command)) throw new HarnessError('UNKNOWN_COMMAND');
  const branchCommand = command as BranchCommand;
  const flags = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const flag = arguments_[index] ?? '';
    const value = arguments_[index + 1];
    if ((!allowedFlags[branchCommand].includes(flag) && flag !== '--data-dir') || !value
      || value.startsWith('--') || flags.has(flag)) throw new HarnessError('INVALID_ARGUMENTS');
    flags.set(flag, value);
  }
  const required = branchCommand === 'branch-plan' ? ['--type']
    : branchCommand === 'branch-approve' ? ['--task', '--plan-hash', '--expires-in-minutes']
    : branchCommand === 'branch-simulate' ? ['--task', '--plan-hash']
    : branchCommand === 'branch-invalidate' ? ['--task', '--event', '--revision', '--event-id'] : ['--task'];
  if (required.some((flag) => !flags.has(flag))) throw new HarnessError('INVALID_ARGUMENTS');
  const taskId = flags.get('--task') ?? '';
  const planHash = flags.get('--plan-hash') ?? '';
  if ((taskId && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(taskId))
    || (planHash && !/^[a-f0-9]{64}$/.test(planHash))) throw new HarnessError('INVALID_ARGUMENTS');
  const workType = flags.get('--type') ?? 'fix';
  const fixture = flags.get('--fixture') ?? 'success';
  const event = flags.get('--event') ?? 'edited';
  if (!['feature', 'fix', 'chore', 'refactor'].includes(workType)
    || !['success', 'collision', 'source-changed', 'unknown'].includes(fixture)
    || !['edited', 'deleted', 'base-changed', 'diff-changed', 'branch-conflict'].includes(event)) {
    throw new HarnessError('INVALID_ARGUMENTS');
  }
  const eventId = flags.get('--event-id') ?? '';
  if (eventId && !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(eventId)) throw new HarnessError('INVALID_ARGUMENTS');
  return {
    command: branchCommand, taskId, planHash, workType: workType as BranchWorkType, fixture: fixture as BranchFixture,
    dataDirectory: flags.get('--data-dir') ?? defaultDataDirectory(),
    expiresInMinutes: boundedInteger(flags.get('--expires-in-minutes') ?? '1', 1, 60),
    approvalOffset: boundedInteger(flags.get('--approval-offset') ?? '0', 0, 1_000_000_000),
    eventId, event: event as Exclude<BranchControlKind, 'cancel'>,
    revision: boundedInteger(flags.get('--revision') ?? '2', 2, 1_000_000_000),
  };
};

/** worker 직접 실행도 controller와 같은 입력 계약을 거치며 숨겨진 추가 옵션을 받지 않는다. */
export const assertBranchWorkerOptions: (value: unknown) => asserts value is BranchWorkerOptions = (value) => {
  const textKeys = ['command', 'sourceRoot', 'dataDirectory', 'taskId', 'planHash', 'workType', 'fixture', 'eventId', 'event'];
  const numberKeys = ['expiresInMinutes', 'approvalOffset', 'revision'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessError('INVALID_ARGUMENTS');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== textKeys.length + numberKeys.length
    || textKeys.some((key) => typeof record[key] !== 'string')
    || numberKeys.some((key) => !Number.isSafeInteger(record[key]))
    || !Object.hasOwn(allowedFlags, String(record.command)) || !record.sourceRoot || !record.dataDirectory) {
    throw new HarnessError('INVALID_ARGUMENTS');
  }
  const options = value as BranchWorkerOptions;
  const values: Record<string, string> = {
    '--type': options.workType, '--fixture': options.fixture, '--task': options.taskId,
    '--plan-hash': options.planHash, '--expires-in-minutes': String(options.expiresInMinutes),
    '--approval-offset': String(options.approvalOffset), '--event-id': options.eventId,
    '--event': options.event, '--revision': String(options.revision),
  };
  const arguments_ = [options.command, '--data-dir', options.dataDirectory];
  for (const flag of allowedFlags[options.command]) {
    if (flag === '--event-id' && options.command === 'branch-cancel' && options.eventId === '') continue;
    arguments_.push(flag, values[flag]!);
  }
  const parsed = parseArguments(arguments_);
  if (Object.entries(parsed).some(([key, expected]) => record[key] !== expected)) throw new HarnessError('INVALID_ARGUMENTS');
};

export const assertPrivateBranchFiles = (dataDirectory: string): void => {
  if (!process.getuid) throw new HarnessError('LOCAL_OWNER_UNAVAILABLE');
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const filePath = join(dataDirectory, `branches.sqlite${suffix}`);
    assertRuntimeFile(filePath);
    const metadata = runtimePathMetadata(filePath);
    if (metadata && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid())) {
      throw new HarnessError('BRANCH_DATABASE_NOT_PRIVATE');
    }
  }
};

export const runBranchCommand = async (arguments_: string[]): Promise<void> => {
  process.umask(0o077);
  const parsed = parseArguments(arguments_);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = await prepareDataDirectory(parsed.dataDirectory, sourceRoot);
  assertPrivateBranchFiles(dataDirectory);
  const release = acquireRuntimeLease(dataDirectory);
  try {
    const options: BranchWorkerOptions = { ...parsed, sourceRoot, dataDirectory };
    const executable = await realpath(process.execPath);
    const output = execFileSync(executable, [
      '--permission', safeReadFlag(sourceRoot), safeReadFlag(dataDirectory), `--allow-fs-write=${dataDirectory}`,
      join(sourceRoot, 'dist', 'src', 'cli', 'branch-worker.js'), JSON.stringify(options),
    ], {
      cwd: sourceRoot, env: { LANG: 'C.UTF-8', TZ: 'UTC' }, encoding: 'utf8', timeout: 30_000,
      maxBuffer: 256_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(output);
    const result = JSON.parse(output) as { attempt?: { status: string } | null };
    if (parsed.command === 'branch-simulate' && result.attempt?.status !== 'SIMULATED') process.exitCode = 1;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new HarnessError(/^[A-Z][A-Z0-9_]{1,80}$/.test(stderr) ? stderr : 'BRANCH_WORKER_FAILED');
  } finally {
    release();
  }
};
