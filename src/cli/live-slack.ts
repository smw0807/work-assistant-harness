import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ReadStream } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';
import { acquireRuntimeLease, defaultDataDirectory, prepareDataDirectory, safeReadFlag } from './runtime.js';

export const liveSlackCommands = [
  'slack-live-plan', 'slack-live-inspect', 'slack-live-approve', 'slack-live-send',
  'slack-live-cancel', 'slack-live-recover', 'slack-live-prune', 'slack-live-list',
] as const;

export type LiveSlackCommand = typeof liveSlackCommands[number];

export interface LiveSlackWorkerOptions {
  command: LiveSlackCommand;
  sourceRoot: string;
  dataDirectory: string;
  taskId: string;
  planHash: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  liveEnabled: boolean;
  expiresInMinutes: number;
}

export const liveSlackUsage = [
  'pnpm harness slack-live-plan --workspace-id <T...> --channel-id <C...> --thread-ts <timestamp> --live-enabled true [--data-dir <private-directory>]',
  'pnpm harness slack-live-inspect <task-id> [--data-dir <private-directory>]',
  'pnpm harness slack-live-approve <task-id> --plan-hash <sha256> --expires-in-minutes <1..60> --live-enabled true [--data-dir <private-directory>]',
  'pnpm harness slack-live-send <task-id> --plan-hash <sha256> --live-enabled true [--data-dir <private-directory>]',
  'pnpm harness slack-live-cancel <task-id> [--data-dir <private-directory>]',
  'pnpm harness slack-live-recover <task-id> [--data-dir <private-directory>]',
  'pnpm harness slack-live-list [--data-dir <private-directory>]',
  'pnpm harness slack-live-prune [--data-dir <private-directory>]',
].join('\n');

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
export const requiresLiveSlackNetwork = (command: LiveSlackCommand): boolean =>
  command === 'slack-live-plan' || command === 'slack-live-approve' || command === 'slack-live-send';

export const parseLiveSlackArguments = (arguments_: string[]): Omit<LiveSlackWorkerOptions, 'sourceRoot'> => {
  const args = [...arguments_];
  const command = args.shift() ?? '';
  if (!liveSlackCommands.some((candidate) => candidate === command)) throw new HarnessError('UNKNOWN_COMMAND');
  const liveCommand = command as LiveSlackCommand;
  const needsTask = !['slack-live-plan', 'slack-live-list', 'slack-live-prune'].includes(liveCommand);
  const taskId = needsTask ? args.shift() ?? '' : '';
  if (needsTask && !uuid.test(taskId)) throw new HarnessError('INVALID_ARGUMENTS');
  const allowed = new Set(['--data-dir']);
  if (requiresLiveSlackNetwork(liveCommand)) allowed.add('--live-enabled');
  if (liveCommand === 'slack-live-plan') for (const flag of ['--workspace-id', '--channel-id', '--thread-ts']) allowed.add(flag);
  if (liveCommand === 'slack-live-approve' || liveCommand === 'slack-live-send') allowed.add('--plan-hash');
  if (liveCommand === 'slack-live-approve') allowed.add('--expires-in-minutes');
  const flags = new Map<string, string>();
  while (args.length > 0) {
    const flag = args.shift() ?? '';
    const value = args.shift();
    if (!allowed.has(flag) || !value || value.startsWith('--') || flags.has(flag)) throw new HarnessError('INVALID_ARGUMENTS');
    flags.set(flag, value);
  }
  const required = liveCommand === 'slack-live-plan' ? ['--workspace-id', '--channel-id', '--thread-ts']
    : liveCommand === 'slack-live-approve' ? ['--plan-hash', '--expires-in-minutes']
    : liveCommand === 'slack-live-send' ? ['--plan-hash'] : [];
  if (required.some((flag) => !flags.has(flag))) throw new HarnessError('INVALID_ARGUMENTS');
  const workspaceId = flags.get('--workspace-id') ?? '';
  const channelId = flags.get('--channel-id') ?? '';
  const threadTs = flags.get('--thread-ts') ?? '';
  const planHash = flags.get('--plan-hash') ?? '';
  const minutes = flags.get('--expires-in-minutes') ?? '0';
  const enabled = flags.get('--live-enabled') ?? 'false';
  if ((workspaceId && !/^T[A-Z0-9]{1,127}$/.test(workspaceId))
    || (channelId && !/^C[A-Z0-9]{1,127}$/.test(channelId))
    || (threadTs && !/^\d{1,20}\.\d{1,10}$/.test(threadTs))
    || (planHash && !digest.test(planHash)) || !['true', 'false'].includes(enabled)
    || !/^(?:0|[1-9]\d?)$/.test(minutes)
    || (liveCommand === 'slack-live-approve' && (Number(minutes) < 1 || Number(minutes) > 60))) {
    throw new HarnessError('INVALID_ARGUMENTS');
  }
  return {
    command: liveCommand, dataDirectory: flags.get('--data-dir') ?? defaultDataDirectory(), taskId, planHash,
    workspaceId, channelId, threadTs, liveEnabled: enabled === 'true', expiresInMinutes: Number(minutes),
  };
};

export const assertPrivateLiveSlackFiles = (dataDirectory: string): void => {
  if (!process.getuid) throw new HarnessError('LOCAL_OWNER_UNAVAILABLE');
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const path = join(dataDirectory, `live-replies.sqlite${suffix}`);
    assertRuntimeFile(path);
    const metadata = runtimePathMetadata(path);
    if (metadata && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid())) {
      throw new HarnessError('SLACK_LIVE_DATABASE_NOT_PRIVATE');
    }
  }
};

export const isSlackSendToken = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 4096 && /^xoxb-[A-Za-z0-9-]+$/.test(value);

/** 토큰은 echo 없는 TTY 입력으로만 받으며 argv·파일·출력에는 넣지 않는다. */
export const readHiddenSlackToken = (input: ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> => {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new HarnessError('SLACK_LIVE_TOKEN_TTY_REQUIRED'));
  }
  return new Promise((resolveToken, reject) => {
    const bytes = Buffer.alloc(4096);
    let size = 0;
    let finished = false;
    const wasRaw = input.isRaw;
    const timer = setTimeout(() => finish(new HarnessError('SLACK_LIVE_TOKEN_INPUT_TIMEOUT')), 300_000);
    const finish = (error: HarnessError | null, token = ''): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.off('data', onData);
      input.off('error', onError);
      process.off('SIGINT', onCancel);
      process.off('SIGTERM', onCancel);
      try { input.setRawMode(wasRaw); } catch { error = new HarnessError('SLACK_LIVE_TOKEN_INPUT_FAILED'); }
      input.pause();
      bytes.fill(0);
      output.write('\n');
      if (error) reject(error); else resolveToken(token);
    };
    const onError = (): void => finish(new HarnessError('SLACK_LIVE_TOKEN_INPUT_FAILED'));
    const onCancel = (): void => finish(new HarnessError('SLACK_LIVE_TOKEN_INPUT_CANCELLED'));
    const onData = (chunk: Buffer): void => {
      if (!Buffer.isBuffer(chunk)) { finish(new HarnessError('SLACK_LIVE_TOKEN_FORMAT_INVALID')); return; }
      try {
        for (let index = 0; index < chunk.length; index += 1) {
          const byte = chunk[index]!;
          if (byte === 3 || byte === 4) { onCancel(); return; }
          if (byte === 10 || byte === 13) {
            if (chunk.subarray(index + 1).some((remaining) => remaining !== 10 && remaining !== 13)) {
              finish(new HarnessError('SLACK_LIVE_TOKEN_FORMAT_INVALID')); return;
            }
            const token = bytes.subarray(0, size).toString('ascii');
            finish(isSlackSendToken(token) ? null : new HarnessError('SLACK_LIVE_TOKEN_FORMAT_INVALID'), token);
            return;
          }
          if (byte === 8 || byte === 127) { if (size > 0) bytes[--size] = 0; continue; }
          if (byte < 32 || byte > 126 || size >= bytes.length) {
            finish(new HarnessError('SLACK_LIVE_TOKEN_FORMAT_INVALID')); return;
          }
          bytes[size++] = byte;
        }
      } finally { chunk.fill(0); }
    };
    try {
      input.setRawMode(true);
      if (input.isRaw !== true) throw new HarnessError('SLACK_LIVE_TOKEN_INPUT_FAILED');
      input.on('data', onData);
      input.on('error', onError);
      process.once('SIGINT', onCancel);
      process.once('SIGTERM', onCancel);
      output.write('SLACK_LIVE_TOKEN_READY: Bot User OAuth Token을 입력하고 Enter를 누르세요.\n');
      input.resume();
    } catch { finish(new HarnessError('SLACK_LIVE_TOKEN_INPUT_FAILED')); }
  });
};

export const runLiveSlackCommand = async (arguments_: string[]): Promise<void> => {
  process.umask(0o077);
  // 다른 worker로 잘못 전달되지 않게 입력 경로의 환경 변수는 즉시 제거한다.
  const secret: Record<string, string | undefined> = { token: process.env['SLACK_SEND_TOKEN'] };
  delete process.env['SLACK_SEND_TOKEN'];
  const parsed = parseLiveSlackArguments(arguments_);
  const live = requiresLiveSlackNetwork(parsed.command);
  if (live && !parsed.liveEnabled) throw new HarnessError('SLACK_LIVE_SEND_DISABLED');
  if (live && secret['token'] !== undefined && !isSlackSendToken(secret['token'])) throw new HarnessError('SLACK_LIVE_TOKEN_FORMAT_INVALID');
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = await prepareDataDirectory(parsed.dataDirectory, sourceRoot);
  assertPrivateLiveSlackFiles(dataDirectory);
  const release = acquireRuntimeLease(dataDirectory);
  const environment: Record<string, string> = { LANG: 'C.UTF-8', TZ: 'UTC' };
  try {
    if (live) {
      if (secret['token'] === undefined) secret['token'] = await readHiddenSlackToken();
      if (!isSlackSendToken(secret['token'])) throw new HarnessError('SLACK_LIVE_TOKEN_FORMAT_INVALID');
      environment['SLACK_SEND_TOKEN'] = secret['token'];
    }
    delete secret['token'];
    const options: LiveSlackWorkerOptions = { ...parsed, sourceRoot, dataDirectory };
    const permissions = ['--permission', safeReadFlag(sourceRoot), safeReadFlag(dataDirectory), `--allow-fs-write=${dataDirectory}`];
    // Node 26의 --allow-net은 boolean 권한이다. 요청 URL 제한은 별도 HTTP 어댑터가 검사한다.
    if (live) permissions.push('--allow-net', '--disable-warning=ExperimentalWarning');
    const output = execFileSync(await realpath(process.execPath), [
      ...permissions, join(sourceRoot, 'dist', 'src', 'cli', 'live-slack-worker.js'), JSON.stringify(options),
    ], { cwd: sourceRoot, env: environment, encoding: 'utf8', timeout: 60_000, maxBuffer: 512_000, stdio: ['ignore', 'pipe', 'pipe'] });
    delete environment['SLACK_SEND_TOKEN'];
    process.stdout.write(output);
    const result = JSON.parse(output) as { attempt?: { status: string } };
    if (result.attempt && result.attempt.status !== 'SENT') process.exitCode = 1;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new HarnessError(/^[A-Z][A-Z0-9_]{1,80}$/.test(stderr) ? stderr : 'SLACK_LIVE_WORKER_FAILED');
  } finally {
    delete secret['token'];
    delete environment['SLACK_SEND_TOKEN'];
    release();
  }
};
