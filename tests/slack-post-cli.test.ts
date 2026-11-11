import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import type { SlackPostWorkerOptions } from '../src/cli/slack-post.js';
import { slackPostFixtures, type SlackPostCheckReport } from '../src/domain/slack-post.js';
import { offlinePostBody, offlineThreadMessages } from '../src/policy/slack-post-policy.js';

interface CliReport extends SlackPostCheckReport {
  reportPath: string;
  dataDirectory: string;
}

const createCli = async (context: TestContext) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'harness-slack-post-cli-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const execute = (arguments_: string[] = [], environment: Record<string, string> = {}) => spawnSync(process.execPath, [
    resolve('dist/src/cli/main.js'), 'slack-post-check', ...arguments_, '--data-dir', directory,
  ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 128_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment } });
  const run = (arguments_: string[] = [], environment?: Record<string, string>): CliReport => {
    const result = execute(arguments_, environment);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout) as CliReport;
    assert.equal(report.status, 'passed');
    assert.equal(report.mode, 'offline-http');
    assert.equal(report.liveEnabled, false);
    assert.equal(report.dataDirectory, directory);
    return report;
  };
  const reject = (arguments_: string[], code: string): void => {
    const result = execute(arguments_);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr.split('\n')[0], code, result.stderr);
    assert.equal(result.stdout, '');
  };
  return { directory, execute, run, reject };
};

test('Slack post CLI는 15개 고정 HTTP 사례를 기본 검증하고 본문 없는 private 보고서를 저장한다', async (context) => {
  const cli = await createCli(context);
  const report = cli.run([], {
    SLACK_APP_TOKEN: 'SYNTHETIC_DO_NOT_INHERIT_APP', SLACK_WEB_TOKEN: 'SYNTHETIC_DO_NOT_INHERIT_WEB',
    SLACK_BOT_TOKEN: 'SYNTHETIC_DO_NOT_INHERIT_BOT', HARNESS_OWNER_ID: 'os-user:999999',
  });
  assert.equal(report.scenarios.length, 15);
  assert.deepEqual(report.scenarios.map(({ fixture }) => fixture), [...slackPostFixtures]);
  assert.ok(report.scenarios.every(({ status }) => status === 'passed'));
  assert.equal(report.checks.find(({ name }) => name === 'external_message_delivery')?.status, 'not_run');
  assert.equal(report.reportPath, join(cli.directory, 'slack-post-checks', report.verificationId, 'report.json'));
  const persisted = await readFile(report.reportPath, 'utf8');
  const expected = { ...report } as Partial<CliReport>;
  delete expected.reportPath;
  delete expected.dataDirectory;
  assert.deepEqual(JSON.parse(persisted), expected);
  assert.ok(Buffer.byteLength(persisted) <= 65_536);
  for (const value of [offlinePostBody, ...offlineThreadMessages.map(({ text }) => text), 'SYNTHETIC_DO_NOT_INHERIT', 'Authorization', 'Bearer ', 'rawResponse']) {
    assert.equal(persisted.includes(value), false, value);
  }
  for (const directory of [cli.directory, join(cli.directory, 'slack-post-checks'), join(cli.directory, 'slack-post-checks', report.verificationId)]) {
    const metadata = await lstat(directory);
    assert.equal(metadata.mode & 0o777, 0o700);
    assert.equal(metadata.uid, process.getuid?.());
  }
  const metadata = await lstat(report.reportPath);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
  assert.deepEqual((await readdir(cli.directory)).sort(), ['harness-lock.sqlite', 'slack-post-checks']);
});

test('단일 성공·차단·미전송·불확실 응답도 예상 결과가 일치하면 검증 passed와 exit 0이다', async (context) => {
  const cli = await createCli(context);
  for (const [fixture, status] of [['success', 'OFFLINE_CONFIRMED'], ['disabled', 'BLOCKED'], ['denied', 'NOT_SENT'], ['timeout', 'UNKNOWN']]) {
    const report = cli.run(['--fixture', fixture!]);
    assert.equal(report.scenarios.length, 1);
    assert.equal(report.scenarios[0]?.fixture, fixture);
    assert.equal(report.scenarios[0]?.result.status, status);
  }
});

test('Slack post CLI는 실제 토큰·이벤트·본문·대상·URL·설정을 받지 않고 strict 옵션만 허용한다', async (context) => {
  const cli = await createCli(context);
  for (const arguments_ of [
    ['--token', 'SYNTHETIC_TOKEN'], ['--config', 'unused.json'], ['--events', 'unused.json'],
    ['--body', 'SYNTHETIC_CUSTOM_BODY'], ['--channel', 'C_OTHER'], ['--url', 'https://example.invalid'],
    ['--owner-id', 'os-user:999999'], ['--live-enabled', 'true'], ['--task', randomUUID()],
    ['--fixture', 'missing'], ['--fixture'], ['--fixture', 'success', '--fixture', 'disabled'],
    ['--data-dir', cli.directory], ['success'], ['--fixture', '--data-dir'],
  ]) cli.reject(arguments_, 'INVALID_ARGUMENTS');
  assert.deepEqual(await readdir(cli.directory), []);
});

test('Slack post CLI는 기존 수신·승인·답장 DB를 열거나 변경하지 않는다', async (context) => {
  const cli = await createCli(context);
  const databases = ['tasks.sqlite', 'slack-inbox.sqlite', 'execution.sqlite', 'replies.sqlite'];
  for (const database of databases) await writeFile(join(cli.directory, database), 'SYNTHETIC_NOT_A_DATABASE', { mode: 0o600 });
  cli.run(['--fixture', 'success']);
  for (const database of databases) assert.equal(await readFile(join(cli.directory, database), 'utf8'), 'SYNTHETIC_NOT_A_DATABASE');
  assert.deepEqual((await readdir(cli.directory)).sort(), [...databases, 'harness-lock.sqlite', 'slack-post-checks'].sort());
});

test('Slack post CLI는 전역 lease·잠금 sidecar 링크·공개 report 폴더를 거부한다', async (context) => {
  const cli = await createCli(context);
  const previousUmask = process.umask(0o077);
  const release = acquireRuntimeLease(cli.directory);
  process.umask(previousUmask);
  try { cli.reject([], 'HARNESS_ALREADY_RUNNING'); } finally { release(); }
  const target = join(cli.directory, 'synthetic-unchanged.txt');
  await writeFile(target, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = join(cli.directory, `harness-lock.sqlite${suffix}`);
    await symlink(target, sidecar);
    cli.reject([], 'UNSAFE_RUNTIME_FILE');
    await rm(sidecar);
    await link(target, sidecar);
    cli.reject([], 'UNSAFE_RUNTIME_FILE');
    await rm(sidecar);
  }
  const reportsDirectory = join(cli.directory, 'slack-post-checks');
  const outside = await mkdtemp(join(await realpath(tmpdir()), 'harness-slack-post-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, reportsDirectory);
  cli.reject([], 'SLACK_POST_REPORT_DIRECTORY_NOT_PRIVATE');
  await rm(reportsDirectory);
  await mkdir(reportsDirectory, { mode: 0o700 });
  await chmod(reportsDirectory, 0o755);
  cli.reject([], 'SLACK_POST_REPORT_DIRECTORY_NOT_PRIVATE');
  await chmod(reportsDirectory, 0o700);
  assert.equal(await readFile(target, 'utf8'), 'SYNTHETIC_UNCHANGED');
  assert.deepEqual(await readdir(outside), []);
});

test('Slack post worker는 무제한·network·child·source 쓰기·상속 토큰 권한과 위조 입력을 거부한다', async (context) => {
  const cli = await createCli(context);
  const sourceRoot = await realpath(resolve('.'));
  const options: SlackPostWorkerOptions = {
    command: 'slack-post-check', sourceRoot, dataDirectory: cli.directory, fixture: 'success', verificationId: randomUUID(),
  };
  const permissions = ['--permission', `--allow-fs-read=${sourceRoot}`, `--allow-fs-read=${cli.directory}`, `--allow-fs-write=${cli.directory}`];
  const worker = join(sourceRoot, 'dist/src/cli/slack-post-worker.js');
  const execute = (permissionArguments: string[], value: object = options, environment: Record<string, string> = {}) => spawnSync(process.execPath, [
    ...permissionArguments, worker, JSON.stringify(value),
  ], { encoding: 'utf8', timeout: 10_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment } });
  for (const arguments_ of [[], [...permissions, '--allow-net'], [...permissions, '--allow-child-process'], [...permissions, `--allow-fs-write=${sourceRoot}`]]) {
    const result = execute(arguments_);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr.trim().split('\n').at(-1), 'SLACK_POST_UNSAFE_WORKER_PERMISSIONS');
    assert.equal(result.stdout, '');
  }
  const inherited = execute(permissions, options, { SLACK_BOT_TOKEN: 'SYNTHETIC_MUST_NOT_BE_INHERITED' });
  assert.equal(inherited.status, 1);
  assert.equal(inherited.stderr.trim(), 'SLACK_POST_UNSAFE_WORKER_ENVIRONMENT');
  for (const value of [
    { ...options, body: 'SYNTHETIC_CUSTOM_BODY' }, { ...options, fixture: 'other' },
    { ...options, verificationId: '../escaped' }, { ...options, ownerId: 'os-user:999999' },
  ]) {
    const result = execute(permissions, value);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'INVALID_ARGUMENTS');
  }
  assert.deepEqual(await readdir(cli.directory), []);
});

test('Slack post worker는 report 대상의 symlink·hardlink·기존 파일을 덮어쓰지 않는다', async (context) => {
  const cli = await createCli(context);
  const sourceRoot = await realpath(resolve('.'));
  const verificationId = randomUUID();
  const verificationDirectory = join(cli.directory, 'slack-post-checks', verificationId);
  await mkdir(verificationDirectory, { recursive: true, mode: 0o700 });
  const reportPath = join(verificationDirectory, 'report.json');
  const target = join(cli.directory, 'synthetic-unchanged.txt');
  await writeFile(target, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  const options: SlackPostWorkerOptions = {
    command: 'slack-post-check', sourceRoot, dataDirectory: cli.directory, fixture: 'success', verificationId,
  };
  const execute = () => spawnSync(process.execPath, [
    '--permission', `--allow-fs-read=${sourceRoot}`, `--allow-fs-read=${cli.directory}`, `--allow-fs-write=${cli.directory}`,
    join(sourceRoot, 'dist/src/cli/slack-post-worker.js'), JSON.stringify(options),
  ], { encoding: 'utf8', timeout: 10_000, env: { LANG: 'C.UTF-8', TZ: 'UTC' } });
  await symlink(target, reportPath);
  assert.equal(execute().stderr.trim(), 'UNSAFE_RUNTIME_FILE');
  await rm(reportPath);
  await link(target, reportPath);
  assert.equal(execute().stderr.trim(), 'UNSAFE_RUNTIME_FILE');
  await rm(reportPath);
  await writeFile(reportPath, 'SYNTHETIC_EXISTING_REPORT', { mode: 0o600 });
  assert.equal(execute().stderr.trim(), 'SLACK_POST_REPORT_CREATE_FAILED');
  assert.equal(await readFile(reportPath, 'utf8'), 'SYNTHETIC_EXISTING_REPORT');
  assert.equal(await readFile(target, 'utf8'), 'SYNTHETIC_UNCHANGED');
});
