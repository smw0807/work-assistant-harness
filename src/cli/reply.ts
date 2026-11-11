import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';
import type { ReplyControlKind, ReplyFixture, ReplyRetention } from '../domain/reply.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';
import { acquireRuntimeLease, defaultDataDirectory, prepareDataDirectory, safeReadFlag } from './runtime.js';

export type ReplyCommand = 'reply-plan' | 'reply-inspect' | 'reply-approve' | 'reply-send'
  | 'reply-cancel' | 'reply-invalidate' | 'reply-recover' | 'reply-prune';

export interface ReplyWorkerOptions {
  command: ReplyCommand;
  sourceRoot: string;
  dataDirectory: string;
  taskId: string;
  planHash: string;
  fixture: ReplyFixture;
  retention: ReplyRetention;
  expiresInMinutes: number;
  approvalOffset: number;
  eventId: string;
  event: Exclude<ReplyControlKind, 'cancel'>;
  revision: number;
}

export const replyUsage = [
  'pnpm harness reply-plan [--fixture success|not-sent|unknown|incomplete|gap] [--body-retention-hours <1..168>] [--audit-retention-days <1..3650>] [--data-dir <private-directory>]',
  'pnpm harness reply-inspect --task <uuid> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
  'pnpm harness reply-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> [--data-dir <private-directory>]',
  'pnpm harness reply-send --task <uuid> --plan-hash <sha256> [--data-dir <private-directory>]',
  'pnpm harness reply-cancel --task <uuid> [--event-id <synthetic-id>] [--data-dir <private-directory>]',
  'pnpm harness reply-invalidate --task <uuid> --event edited|deleted|reply|gap|incomplete|expired --revision <2..1000000000> --event-id <synthetic-id> [--data-dir <private-directory>]',
  'pnpm harness reply-recover --task <uuid> [--data-dir <private-directory>]',
  'pnpm harness reply-prune [--data-dir <private-directory>]',
].join('\n');

const boundedInteger = (text: string, minimum: number, maximum: number): number => {
  if (!/^(?:0|[1-9]\d{0,9})$/.test(text) || Number(text) < minimum || Number(text) > maximum) {
    throw new HarnessError('INVALID_ARGUMENTS');
  }
  return Number(text);
};

const parseArguments = (arguments_: string[]): Omit<ReplyWorkerOptions, 'sourceRoot'> => {
  const command = arguments_[0] ?? '';
  const allowed: Record<ReplyCommand, string[]> = {
    'reply-plan': ['--fixture', '--body-retention-hours', '--audit-retention-days'],
    'reply-inspect': ['--task', '--approval-offset'],
    'reply-approve': ['--task', '--plan-hash', '--expires-in-minutes'],
    'reply-send': ['--task', '--plan-hash'],
    'reply-cancel': ['--task', '--event-id'],
    'reply-invalidate': ['--task', '--event', '--revision', '--event-id'],
    'reply-recover': ['--task'],
    'reply-prune': [],
  };
  if (!Object.hasOwn(allowed, command)) throw new HarnessError('UNKNOWN_COMMAND');
  const replyCommand = command as ReplyCommand;
  const flags = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const flag = arguments_[index] ?? '';
    const value = arguments_[index + 1];
    if ((!allowed[replyCommand].includes(flag) && flag !== '--data-dir') || !value
      || value.startsWith('--') || flags.has(flag)) throw new HarnessError('INVALID_ARGUMENTS');
    flags.set(flag, value);
  }
  const required = replyCommand === 'reply-plan' || replyCommand === 'reply-prune' ? []
    : replyCommand === 'reply-approve' ? ['--task', '--plan-hash', '--expires-in-minutes']
    : replyCommand === 'reply-send' ? ['--task', '--plan-hash']
    : replyCommand === 'reply-invalidate' ? ['--task', '--event', '--revision', '--event-id'] : ['--task'];
  if (required.some((flag) => !flags.has(flag))) throw new HarnessError('INVALID_ARGUMENTS');
  const taskId = flags.get('--task') ?? '';
  const planHash = flags.get('--plan-hash') ?? '';
  if ((taskId && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(taskId))
    || (planHash && !/^[a-f0-9]{64}$/.test(planHash))) throw new HarnessError('INVALID_ARGUMENTS');
  const fixture = flags.get('--fixture') ?? 'success';
  if (!['success', 'not-sent', 'unknown', 'incomplete', 'gap'].includes(fixture)) throw new HarnessError('INVALID_ARGUMENTS');
  const event = flags.get('--event') ?? 'edited';
  if (!['edited', 'deleted', 'reply', 'gap', 'incomplete', 'expired'].includes(event)) throw new HarnessError('INVALID_ARGUMENTS');
  const eventId = flags.get('--event-id') ?? '';
  if (eventId && !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(eventId)) throw new HarnessError('INVALID_ARGUMENTS');
  return {
    command: replyCommand, taskId, planHash, fixture: fixture as ReplyFixture,
    dataDirectory: flags.get('--data-dir') ?? defaultDataDirectory(),
    retention: {
      bodyRetentionHours: boundedInteger(flags.get('--body-retention-hours') ?? '24', 1, 168),
      auditRetentionDays: flags.has('--audit-retention-days') ? boundedInteger(flags.get('--audit-retention-days')!, 1, 3650) : null,
    },
    expiresInMinutes: boundedInteger(flags.get('--expires-in-minutes') ?? '1', 1, 60),
    approvalOffset: boundedInteger(flags.get('--approval-offset') ?? '0', 0, 1_000_000_000),
    eventId, event: event as Exclude<ReplyControlKind, 'cancel'>,
    revision: boundedInteger(flags.get('--revision') ?? '2', 2, 1_000_000_000),
  };
};

export const assertPrivateReplyFiles = (dataDirectory: string): void => {
  if (!process.getuid) throw new HarnessError('LOCAL_OWNER_UNAVAILABLE');
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const filePath = join(dataDirectory, `replies.sqlite${suffix}`);
    assertRuntimeFile(filePath);
    const metadata = runtimePathMetadata(filePath);
    if (metadata && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid())) {
      throw new HarnessError('REPLY_DATABASE_NOT_PRIVATE');
    }
  }
};

export const runReplyCommand = async (arguments_: string[]): Promise<void> => {
  process.umask(0o077);
  const parsed = parseArguments(arguments_);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = await prepareDataDirectory(parsed.dataDirectory, sourceRoot);
  assertPrivateReplyFiles(dataDirectory);
  // 조회도 본문 만료를 처리하므로 모든 답장 명령은 수신과 같은 전역 lease를 쓴다.
  const release = acquireRuntimeLease(dataDirectory);
  try {
    const options: ReplyWorkerOptions = { ...parsed, sourceRoot, dataDirectory };
    const executable = await realpath(process.execPath);
    const output = execFileSync(executable, [
      '--permission', safeReadFlag(sourceRoot), safeReadFlag(dataDirectory), `--allow-fs-write=${dataDirectory}`,
      join(sourceRoot, 'dist', 'src', 'cli', 'reply-worker.js'), JSON.stringify(options),
    ], {
      cwd: sourceRoot, env: { LANG: 'C.UTF-8', TZ: 'UTC' }, encoding: 'utf8', timeout: 30_000,
      maxBuffer: 512_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(output);
    const result = JSON.parse(output) as { attempt?: { status: string } };
    if (result.attempt && result.attempt.status !== 'SIMULATED') process.exitCode = 1;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new HarnessError(/^[A-Z][A-Z0-9_]{1,80}$/.test(stderr) ? stderr : 'REPLY_WORKER_FAILED');
  } finally {
    release();
  }
};
