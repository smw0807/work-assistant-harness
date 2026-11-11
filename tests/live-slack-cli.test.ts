import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import type { ReadStream, WriteStream } from 'node:tty';
import { SqliteLiveSlackStore } from '../src/adapters/sqlite-live-slack-store.js';
import {
  parseLiveSlackArguments, readHiddenSlackToken, type LiveSlackWorkerOptions,
} from '../src/cli/live-slack.js';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import { createLivePlan, liveTestBody } from '../src/policy/live-slack-policy.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const planHash = 'a'.repeat(64);
const targetFlags = ['--workspace-id', 'T_SYNTHETIC', '--channel-id', 'C_SYNTHETIC', '--thread-ts', '1000000000.000001'];

const createCli = async (context: TestContext) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'harness-live-slack-cli-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const execute = (arguments_: string[], environment: Record<string, string> = {}) => spawnSync(process.execPath, [
    resolve('dist/src/cli/main.js'), ...arguments_, '--data-dir', directory,
  ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 128_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment } });
  const reject = (arguments_: string[], code: string, environment: Record<string, string> = {}): void => {
    const result = execute(arguments_, environment);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr.split('\n')[0], code, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('SYNTHETIC_DO_NOT_LOG'), false);
  };
  return { directory, execute, reject };
};

test('live Slack CLI는 plan·approve·send를 명시적 활성화 없이 거부하고 네트워크 worker를 시작하지 않는다', async (context) => {
  const cli = await createCli(context);
  const targets = ['--workspace-id', 'TSYNTHETIC', '--channel-id', 'CSYNTHETIC', '--thread-ts', '1000000000.000001'];
  for (const arguments_ of [
    ['slack-live-plan', ...targets], ['slack-live-plan', ...targets, '--live-enabled', 'false'],
    ['slack-live-approve', taskId, '--plan-hash', planHash, '--expires-in-minutes', '30'],
    ['slack-live-send', taskId, '--plan-hash', planHash],
  ]) cli.reject(arguments_, 'SLACK_LIVE_SEND_DISABLED');
  assert.deepEqual(await readdir(cli.directory), []);
});

test('live Slack CLI는 토큰 argv·외부 본문·설정·잘못된 identity·TTL·중복 옵션을 거부한다', async (context) => {
  const cli = await createCli(context);
  for (const arguments_ of [
    ['slack-live-plan', '--token', 'SYNTHETIC_DO_NOT_LOG'],
    ['slack-live-plan', '--body', 'SYNTHETIC_DO_NOT_LOG'],
    ['slack-live-plan', '--config', 'unused.json'],
    ['slack-live-plan', ...targetFlags],
    ['slack-live-plan', '--workspace-id', 'TSYNTHETIC', '--channel-id', 'GSYNTHETIC', '--thread-ts', '1000000000.000001'],
    ['slack-live-plan', '--workspace-id', 'TSYNTHETIC', '--channel-id', 'CSYNTHETIC', '--thread-ts', '1e10'],
    ['slack-live-inspect', '../escaped'],
    ['slack-live-inspect', taskId, '--live-enabled', 'true'],
    ['slack-live-send', taskId, '--plan-hash', 'invalid'],
    ['slack-live-send', taskId, '--plan-hash', planHash, '--live-enabled', 'yes'],
    ['slack-live-approve', taskId, '--plan-hash', planHash],
    ['slack-live-approve', taskId, '--plan-hash', planHash, '--expires-in-minutes', '0'],
    ['slack-live-approve', taskId, '--plan-hash', planHash, '--expires-in-minutes', '61'],
    ['slack-live-approve', taskId, '--plan-hash', planHash, '--expires-in-minutes', '1.5'],
    ['slack-live-list', '--data-dir', cli.directory],
    ['slack-live-list', '--token', 'SYNTHETIC_DO_NOT_LOG'],
  ]) cli.reject(arguments_, 'INVALID_ARGUMENTS');
  assert.deepEqual(await readdir(cli.directory), []);
});

test('live Slack CLI는 토큰 없는 비TTY와 잘못된 환경 토큰을 전송 전 거부한다', async (context) => {
  const cli = await createCli(context);
  const send = ['slack-live-send', taskId, '--plan-hash', planHash, '--live-enabled', 'true'];
  cli.reject(send, 'SLACK_LIVE_TOKEN_FORMAT_INVALID', { SLACK_SEND_TOKEN: 'SYNTHETIC_DO_NOT_LOG' });
  assert.deepEqual(await readdir(cli.directory), []);
  cli.reject(send, 'SLACK_LIVE_TOKEN_TTY_REQUIRED');
  assert.deepEqual(await readdir(cli.directory), ['harness-lock.sqlite']);
});

test('live Slack 읽기·정리 명령은 별도 DB만 열고 호스트 토큰을 상속하거나 전송하지 않는다', async (context) => {
  const cli = await createCli(context);
  const databases = ['tasks.sqlite', 'slack-inbox.sqlite', 'execution.sqlite', 'replies.sqlite'];
  for (const database of databases) await writeFile(join(cli.directory, database), 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  for (const command of ['slack-live-list', 'slack-live-prune']) {
    const result = cli.execute([command], {
      SLACK_SEND_TOKEN: 'SYNTHETIC_DO_NOT_LOG', SLACK_APP_TOKEN: 'SYNTHETIC_DO_NOT_LOG',
      SLACK_WEB_TOKEN: 'SYNTHETIC_DO_NOT_LOG', HARNESS_OWNER_ID: 'os-user:999999',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout) as { liveEnabled: boolean; mode: string; body?: string; tasks?: unknown[] };
    assert.equal(report.liveEnabled, false);
    assert.equal(report.mode, 'live-test');
    assert.equal(report.body, undefined);
    if (command === 'slack-live-list') assert.deepEqual(report.tasks, []);
    assert.equal(result.stdout.includes('SYNTHETIC_DO_NOT_LOG'), false);
  }
  for (const database of databases) assert.equal(await readFile(join(cli.directory, database), 'utf8'), 'SYNTHETIC_UNCHANGED');
  assert.deepEqual((await readdir(cli.directory)).sort(), [...databases, 'harness-lock.sqlite', 'live-replies.sqlite'].sort());
});

test('live Slack inspect만 고정 전송 본문을 표시하고 list·cancel은 본문 없이 영속 상태를 반환한다', async (context) => {
  const cli = await createCli(context);
  const now = new Date();
  const plan = createLivePlan({
    policy: 'slack-live-test-v1', liveEnabled: true, workspaceId: 'TSYNTHETIC', channelId: 'CSYNTHETIC', threadTs: '1000000000.000001',
  }, {
    botId: 'BSYNTHETIC', botUserId: 'USYNTHETIC', rootRevision: '1000000000.000001', contextHash: 'b'.repeat(64), observedAt: now.toISOString(),
  }, `os-user:${process.getuid!()}`, now);
  const store = new SqliteLiveSlackStore(join(cli.directory, 'live-replies.sqlite'));
  try { store.create(plan, now); } finally { store.close(); }
  const inspected = cli.execute(['slack-live-inspect', plan.taskId]);
  assert.equal(inspected.status, 0, inspected.stderr);
  const snapshot = JSON.parse(inspected.stdout) as { body: string; task: { status: string } };
  assert.equal(snapshot.body, liveTestBody);
  assert.equal(snapshot.task.status, 'AWAITING_APPROVAL');
  for (const args of [['slack-live-list'], ['slack-live-cancel', plan.taskId]]) {
    const result = cli.execute(args, { SLACK_SEND_TOKEN: 'SYNTHETIC_DO_NOT_LOG' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Object.hasOwn(JSON.parse(result.stdout) as object, 'body'), false);
    assert.equal(result.stdout.includes(liveTestBody), false);
  }
  const cancelled = JSON.parse(cli.execute(['slack-live-inspect', plan.taskId]).stdout) as { task: { status: string }; attempts: unknown[] };
  assert.equal(cancelled.task.status, 'CANCELLED');
  assert.deepEqual(cancelled.attempts, []);
});

test('live Slack CLI는 전역 lease와 DB·sidecar의 링크·공개 권한을 거부한다', async (context) => {
  const cli = await createCli(context);
  const oldUmask = process.umask(0o077);
  const release = acquireRuntimeLease(cli.directory);
  process.umask(oldUmask);
  try { cli.reject(['slack-live-list'], 'HARNESS_ALREADY_RUNNING'); } finally { release(); }
  const target = join(cli.directory, 'synthetic-unchanged.txt');
  await writeFile(target, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const file = join(cli.directory, `live-replies.sqlite${suffix}`);
    await symlink(target, file);
    cli.reject(['slack-live-list'], 'UNSAFE_RUNTIME_FILE');
    await rm(file);
    await link(target, file);
    cli.reject(['slack-live-list'], 'UNSAFE_RUNTIME_FILE');
    await rm(file);
  }
  const database = join(cli.directory, 'live-replies.sqlite');
  await writeFile(database, 'SYNTHETIC_NOT_A_DATABASE', { mode: 0o600 });
  await chmod(database, 0o644);
  cli.reject(['slack-live-list'], 'SLACK_LIVE_DATABASE_NOT_PRIVATE');
  assert.equal(await readFile(database, 'utf8'), 'SYNTHETIC_NOT_A_DATABASE');
  assert.equal(await readFile(target, 'utf8'), 'SYNTHETIC_UNCHANGED');
});

test('live Slack worker는 추가 권한·상속 토큰·위조 옵션을 거부한다', async (context) => {
  const cli = await createCli(context);
  const sourceRoot = await realpath(resolve('.'));
  const parsed = parseLiveSlackArguments(['slack-live-list', '--data-dir', cli.directory]);
  const options: LiveSlackWorkerOptions = { ...parsed, sourceRoot };
  const permissions = ['--permission', `--allow-fs-read=${sourceRoot}`, `--allow-fs-read=${cli.directory}`, `--allow-fs-write=${cli.directory}`];
  const execute = (flags: string[], value: object = options, environment: Record<string, string> = {}) => spawnSync(process.execPath, [
    ...flags, '--disable-warning=ExperimentalWarning', join(sourceRoot, 'dist/src/cli/live-slack-worker.js'), JSON.stringify(value),
  ], { encoding: 'utf8', timeout: 10_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment } });
  for (const flags of [[], [...permissions, '--allow-net'], [...permissions, '--allow-child-process'],
    [...permissions, `--allow-fs-write=${sourceRoot}`], [...permissions, `--allow-fs-read=/`]]) {
    const result = execute(flags);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr.trim().split('\n').at(-1), 'SLACK_LIVE_UNSAFE_WORKER_PERMISSIONS');
    assert.equal(result.stdout, '');
  }
  for (const key of ['SLACK_SEND_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_WEB_TOKEN', 'OPENAI_API_KEY']) {
    const result = execute(permissions, options, { [key]: 'SYNTHETIC_DO_NOT_LOG' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'SLACK_LIVE_UNSAFE_WORKER_ENVIRONMENT');
    assert.equal(result.stdout, '');
  }
  for (const value of [{ ...options, token: 'SYNTHETIC_DO_NOT_LOG' }, { ...options, body: 'unused' },
    { ...options, taskId: randomUUID() }, { ...options, liveEnabled: true }, { ...options, expiresInMinutes: 30 }]) {
    const result = execute(permissions, value);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'INVALID_ARGUMENTS');
  }
  assert.deepEqual(await readdir(cli.directory), []);
});

test('hidden TTY 입력은 토큰을 echo하지 않고 이전 raw mode를 복구한다', async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (value: boolean) => void };
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  input.isRaw = false;
  output.isTTY = true;
  const modes: boolean[] = [];
  input.setRawMode = (value) => { input.isRaw = value; modes.push(value); };
  let echoed = '';
  output.on('data', (chunk: Buffer) => { echoed += chunk.toString(); });
  const secret = 'xoxb-SYNTHETIC-NONSECRET-TTY';
  const promise = readHiddenSlackToken(input as unknown as ReadStream, output as unknown as WriteStream);
  const chunk = Buffer.from(`${secret}\n`);
  input.write(chunk);
  assert.equal(await promise, secret);
  assert.ok(chunk.every((byte) => byte === 0));
  assert.deepEqual(modes, [true, false]);
  assert.equal(echoed.includes(secret), false);
  assert.equal(input.listenerCount('data'), 0);
});

test('hidden TTY 입력은 취소·잘못된 토큰·붙여넣은 추가 명령을 echo 없이 거부한다', async () => {
  for (const chunk of [Buffer.from('SYNTHETIC_INVALID\n'), Buffer.from([3]), Buffer.from('xoxb-SYNTHETIC\nSYNTHETIC_COMMAND')]) {
    const cancelled = chunk[0] === 3;
    const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (value: boolean) => void };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    input.isRaw = false;
    output.isTTY = true;
    input.setRawMode = (value) => { input.isRaw = value; };
    let echoed = '';
    output.on('data', (data: Buffer) => { echoed += data.toString(); });
    const promise = readHiddenSlackToken(input as unknown as ReadStream, output as unknown as WriteStream);
    input.write(chunk);
    await assert.rejects(promise, { code: cancelled ? 'SLACK_LIVE_TOKEN_INPUT_CANCELLED' : 'SLACK_LIVE_TOKEN_FORMAT_INVALID' });
    assert.ok(chunk.every((byte) => byte === 0));
    assert.equal(input.isRaw, false);
    assert.equal(echoed.includes('SYNTHETIC'), false);
    assert.equal(input.listenerCount('data'), 0);
  }
});

test('hidden TTY 입력은 raw mode가 실제 적용되지 않으면 READY와 입력 listener 없이 거부한다', async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (value: boolean) => void };
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = () => {};
  output.isTTY = true;
  let echoed = '';
  output.on('data', (chunk: Buffer) => { echoed += chunk.toString(); });
  await assert.rejects(readHiddenSlackToken(input as unknown as ReadStream, output as unknown as WriteStream), { code: 'SLACK_LIVE_TOKEN_INPUT_FAILED' });
  assert.equal(echoed.includes('SLACK_LIVE_TOKEN_READY'), false);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.isRaw, false);
});
