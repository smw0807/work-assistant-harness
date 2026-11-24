import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseSlackEnvironment, readSlackEnvironmentFile, readSlackPrivateFile, SLACK_ENV_FILE_MAX_BYTES } from '../src/cli/slack-environment.js';

const sourceRoot = resolve('.');
const executable = join(sourceRoot, 'dist', 'src', 'cli', 'main.js');
const environment = (): Record<string, string> => ({
  SLACK_WORKSPACE_ID: 'W_LOCAL', SLACK_TARGET_USER_ID: 'U_OWNER', SLACK_CHANNEL_IDS: 'C_ALLOWED', SLACK_LIVE_READ_ENABLED: 'false',
});
const environmentText = (extra: Record<string, string> = {}): string => Object.entries({ ...environment(), ...extra })
  .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n');
const temporaryDirectory = async (context: TestContext): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-slack-environment-')));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const privateFile = async (directory: string, content = environmentText(), name = 'synthetic.env'): Promise<string> => {
  const path = join(directory, name);
  await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  return path;
};
const cli = (args: string[], directory: string, settings: Record<string, string> = {}, cwd = sourceRoot) => spawnSync(
  // Node also recognizes --env-file after a script path unless its own option parsing is ended explicitly.
  process.execPath, ['--', executable, ...args, '--data-dir', directory],
  { cwd, encoding: 'utf8', timeout: 10_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...settings } },
);

test('환경 설정은 명시된 Slack 키와 기존 자료 상한만 선택한다', () => {
  const input = { ...environment(), SLACK_CHANNEL_IDS: ' C_ALLOWED, C_SECOND ', SLACK_APP_TOKEN: 'synthetic-app-value', SLACK_WEB_TOKEN: 'synthetic-web-value' };
  let unknownReads = 0;
  Object.defineProperty(input, 'NODE_OPTIONS', { get: () => { unknownReads += 1; throw new Error('must not read'); } });
  const settings = parseSlackEnvironment(input);
  assert.deepEqual(settings.config, {
    workspaceId: 'W_LOCAL', targetUserId: 'U_OWNER', channelIds: ['C_ALLOWED', 'C_SECOND'], liveReadEnabled: false,
    retentionHours: 24, maxPending: 100, thread: { maxMessages: 30, maxPages: 3, maxBytes: 16_384 },
  });
  assert.equal(settings.appToken, 'synthetic-app-value');
  assert.equal(settings.webToken, 'synthetic-web-value');
  assert.equal(settings.analysisConfigPath, undefined);
  assert.equal(unknownReads, 0);
  assert.equal(JSON.stringify(settings.config).includes('synthetic-'), false);
});

test('필수 환경 설정·엄격한 boolean·빈 채널과 중복·채널 상한을 검증한다', () => {
  for (const key of ['SLACK_WORKSPACE_ID', 'SLACK_TARGET_USER_ID', 'SLACK_CHANNEL_IDS', 'SLACK_LIVE_READ_ENABLED']) {
    const missing = environment(); delete missing[key];
    assert.throws(() => parseSlackEnvironment(missing), { code: 'SLACK_INVALID_ENV' });
  }
  for (const value of ['', 'TRUE', '1', ' true', 'false ']) {
    for (const key of ['SLACK_LIVE_READ_ENABLED', 'SLACK_ANALYSIS_ENABLED']) {
      assert.throws(() => parseSlackEnvironment({ ...environment(), [key]: value }), { code: 'SLACK_INVALID_ENV' });
    }
  }
  for (const channels of ['', ',C_ALLOWED', 'C_ALLOWED,', 'C_ALLOWED,C_ALLOWED', Array.from({ length: 11 }, (_, index) => `C_${index}`).join(',')]) {
    assert.throws(() => parseSlackEnvironment({ ...environment(), SLACK_CHANNEL_IDS: channels }), { code: 'SLACK_INVALID_ENV' });
  }
  assert.equal(parseSlackEnvironment({ ...environment(), SLACK_LIVE_READ_ENABLED: 'true' }).config.liveReadEnabled, true);
});

test('선언된 키의 accessor와 Proxy를 실행하지 않으며 오류에 값이 나오지 않는다', () => {
  let reads = 0;
  const getter = environment();
  Object.defineProperty(getter, 'SLACK_APP_TOKEN', { get: () => { reads += 1; return 'SYNTHETIC_SECRET'; } });
  for (const input of [getter, new Proxy(environment(), { getOwnPropertyDescriptor: () => { reads += 1; throw new Error('SYNTHETIC_SECRET'); } }),
    { ...environment(), SLACK_APP_TOKEN: 'SYNTHETIC_SECRET\n' }, { ...environment(), SLACK_WEB_TOKEN: 's'.repeat(4097) },
    { ...environment(), SLACK_WORKSPACE_ID: '\ud800' }]) {
    assert.throws(() => parseSlackEnvironment(input), error => {
      assert.equal((error as { code: string }).code, 'SLACK_INVALID_ENV');
      assert.equal(String(error).includes('SYNTHETIC_SECRET'), false);
      return true;
    });
  }
  assert.equal(reads, 0);
});

test('리스트 하나를 채널과 함께 또는 단독으로 지정하고 잘못된 대상은 거부한다', () => {
  const settings = { ...environment(), SLACK_LIST_ID: 'FTEST123' };
  assert.deepEqual(parseSlackEnvironment(settings).config.channelIds, ['C_ALLOWED']);
  assert.equal(parseSlackEnvironment(settings).config.listId, 'FTEST123');
  assert.deepEqual(parseSlackEnvironment({ ...settings, SLACK_CHANNEL_IDS: undefined }).config.channelIds, []);
  assert.equal(parseSlackEnvironment({ ...settings, SLACK_CHANNEL_IDS: '', SLACK_ANALYSIS_ENABLED: 'true' }).analysisConfigPath, undefined);
  for (const invalid of ['*', '', 'C123', 'FTEST,FB', 'https://app.slack.com/list/FTEST', ' FTEST']) {
    assert.throws(() => parseSlackEnvironment({ ...settings, SLACK_LIST_ID: invalid }), { code: 'SLACK_INVALID_ENV' });
  }
});

test('분석 활성화는 절대 경로를 요구하며 비활성 설정은 파일을 읽지 않는다', () => {
  const path = '/synthetic-not-created/private/codex.json';
  assert.equal(parseSlackEnvironment({ ...environment(), SLACK_ANALYSIS_ENABLED: 'true', SLACK_ANALYSIS_CODEX_CONFIG: path }).analysisConfigPath, path);
  for (const invalid of [undefined, '', 'codex.json', '/synthetic/../codex.json', '/synthetic/codex.json\n']) {
    assert.throws(() => parseSlackEnvironment({ ...environment(), SLACK_ANALYSIS_ENABLED: 'true', SLACK_ANALYSIS_CODEX_CONFIG: invalid }), { code: 'SLACK_INVALID_ENV' });
  }
  assert.equal(parseSlackEnvironment({ ...environment(), SLACK_ANALYSIS_ENABLED: 'false', SLACK_ANALYSIS_CODEX_CONFIG: 'ignored-relative-path' }).analysisConfigPath, undefined);
});

test('명시한 0600 파일은 Node dotenv 문법으로 읽고 설정만 반환한다', async context => {
  const directory = await temporaryDirectory(context);
  const path = await privateFile(directory, `# synthetic only\nexport SLACK_WORKSPACE_ID='W_LOCAL'\nSLACK_TARGET_USER_ID=U_OWNER\nSLACK_CHANNEL_IDS=" C_ALLOWED, C_SECOND "\nSLACK_LIVE_READ_ENABLED=false\nSLACK_APP_TOKEN='synthetic-app-value'\nNODE_OPTIONS='--require=/synthetic-not-created.js'\n`);
  const settings = await readSlackEnvironmentFile(path);
  assert.deepEqual(settings.config.channelIds, ['C_ALLOWED', 'C_SECOND']);
  assert.equal(settings.appToken, 'synthetic-app-value');
  assert.equal(Object.hasOwn(settings, 'NODE_OPTIONS'), false);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
});

test('파일에 없는 토큰·설정은 합성 ambient 값으로 보충하지 않고 process.env를 바꾸지 않는다', async context => {
  const directory = await temporaryDirectory(context);
  const path = await privateFile(directory);
  const helperUrl = new URL('../src/cli/slack-environment.js', import.meta.url).href;
  const code = `import { readSlackEnvironmentFile } from ${JSON.stringify(helperUrl)};
    const before = JSON.stringify(process.env);
    const settings = await readSlackEnvironmentFile(${JSON.stringify(path)});
    process.stdout.write(JSON.stringify({ appAbsent: settings.appToken === undefined, webAbsent: settings.webToken === undefined,
      target: settings.config.targetUserId, unchanged: before === JSON.stringify(process.env) }));`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: sourceRoot, encoding: 'utf8', timeout: 5_000,
    env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment(), SLACK_TARGET_USER_ID: 'U_AMBIENT', SLACK_APP_TOKEN: 'synthetic-ambient-app', SLACK_WEB_TOKEN: 'synthetic-ambient-web' },
  });
  assert.deepEqual(JSON.parse(result), { appAbsent: true, webAbsent: true, target: 'U_OWNER', unchanged: true });
  await writeFile(path, 'SLACK_LIVE_READ_ENABLED=false\n');
  const failed = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: sourceRoot, encoding: 'utf8', timeout: 5_000, env: { LANG: 'C.UTF-8', TZ: 'UTC', ...environment() },
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /SLACK_INVALID_ENV/);
});

test('환경 파일은 symlink·hardlink·비공개 모드 위반·디렉터리를 거부하고 원본을 보존한다', async context => {
  const directory = await temporaryDirectory(context);
  const original = await privateFile(directory);
  const linked = join(directory, 'symlink.env');
  await symlink(original, linked);
  await assert.rejects(readSlackEnvironmentFile(linked), { code: 'SLACK_ENV_FILE_INVALID' });
  const linkedParent = join(directory, 'linked-parent');
  const actualParent = join(directory, 'actual-parent');
  await mkdir(actualParent, { mode: 0o700 });
  await symlink(actualParent, linkedParent);
  await privateFile(actualParent);
  await assert.rejects(readSlackEnvironmentFile(join(linkedParent, 'synthetic.env')), { code: 'SLACK_ENV_FILE_INVALID' });
  const hardlink = join(directory, 'hardlink.env');
  await link(original, hardlink);
  await assert.rejects(readSlackEnvironmentFile(original), { code: 'SLACK_ENV_FILE_INVALID' });
  await assert.rejects(readSlackEnvironmentFile(hardlink), { code: 'SLACK_ENV_FILE_INVALID' });
  const publicFile = await privateFile(directory, environmentText(), 'public.env');
  await chmod(publicFile, 0o644);
  await assert.rejects(readSlackEnvironmentFile(publicFile), { code: 'SLACK_ENV_FILE_INVALID' });
  await assert.rejects(readSlackEnvironmentFile(actualParent), { code: 'SLACK_ENV_FILE_INVALID' });
  assert.equal(await readFile(original, 'utf8'), environmentText());
});

test('환경 파일은 바이트 한도를 읽기 전에 적용하고 잘못된 UTF8·설정을 거부한다', async context => {
  const directory = await temporaryDirectory(context);
  const oversized = await privateFile(directory, 'x'.repeat(SLACK_ENV_FILE_MAX_BYTES + 1), 'oversized.env');
  await assert.rejects(readSlackEnvironmentFile(oversized), { code: 'SLACK_ENV_FILE_INVALID' });
  const invalidUtf8 = await privateFile(directory, '', 'invalid-utf8.env');
  await writeFile(invalidUtf8, Buffer.from([0xc0, 0xaf]));
  await assert.rejects(readSlackEnvironmentFile(invalidUtf8), { code: 'SLACK_ENV_FILE_INVALID' });
  const invalidConfig = await privateFile(directory, environmentText({ SLACK_LIVE_READ_ENABLED: 'TRUE' }), 'invalid-config.env');
  await assert.rejects(readSlackEnvironmentFile(invalidConfig), { code: 'SLACK_INVALID_ENV' });
});

test('공용 private reader는 별도 상한과 UTF8 본문만 제공하고 오류에 경로를 노출하지 않는다', async context => {
  const directory = await temporaryDirectory(context);
  const path = await privateFile(directory, '{"synthetic":true}', 'synthetic-relay.json');
  assert.equal(await readSlackPrivateFile(path), '{"synthetic":true}');
  for (const limit of [1, 0, -1, 1.5, SLACK_ENV_FILE_MAX_BYTES + 1]) {
    await assert.rejects(readSlackPrivateFile(path, limit), error => {
      assert.equal((error as { code: string }).code, 'SLACK_PRIVATE_FILE_INVALID');
      assert.equal(String(error).includes(path), false);
      return true;
    });
  }
});

test('CLI --env는 합성 환경으로 replay·list·inspect를 실행한다', async context => {
  const directory = await temporaryDirectory(context);
  const settings = { ...environment(), UNRELATED_SECRET: 'SYNTHETIC_HOST_SECRET' };
  for (const args of [['slack-replay', '--env'], ['slack-list', '--env'], ['slack-inspect', 'C_ALLOWED', '1700000000.000001', '--env']]) {
    const result = cli(args, directory, settings);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { requests?: unknown[]; request?: unknown };
    assert.ok(parsed.requests?.length === 1 || parsed.request);
    assert.equal(`${result.stdout}${result.stderr}`.includes('SYNTHETIC_HOST_SECRET'), false);
  }
});

test('CLI --env-file은 토큰·NODE_OPTIONS를 worker 설정에 전파하지 않고 replay한다', async context => {
  const directory = await temporaryDirectory(context);
  const path = await privateFile(directory, environmentText({
    SLACK_APP_TOKEN: 'synthetic-file-app', SLACK_WEB_TOKEN: 'synthetic-file-web', NODE_OPTIONS: '--require=/synthetic-not-created.js',
  }));
  const result = cli(['slack-replay', '--env-file', path], join(directory, 'runtime'), { SLACK_WORKSPACE_ID: 'W_AMBIENT' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((JSON.parse(result.stdout) as { accepted: number }).accepted, 2);
  for (const value of ['synthetic-file-app', 'synthetic-file-web', '/synthetic-not-created.js']) {
    assert.equal(`${result.stdout}${result.stderr}`.includes(value), false);
  }
});

test('설정 모드 충돌·중복·미지원 옵션은 설정 접근과 runtime 생성 전에 거부한다', async context => {
  const directory = await temporaryDirectory(context);
  const data = join(directory, 'must-not-create');
  for (const flags of [['--env', '--config', '/synthetic-missing.json'], ['--env', '--env-file', '/synthetic-missing.env'],
    ['--config', '/synthetic-missing.json', '--env-file', '/synthetic-missing.env'], ['--env', '--env'], ['--env', '--unknown', 'value']]) {
    const result = cli(['slack-replay', ...flags], data);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /INVALID_ARGUMENTS/);
  }
  await assert.rejects(lstat(data), { code: 'ENOENT' });
});

test('CLI는 .env를 자동 탐색하지 않고 기존 JSON 설정 경로를 유지한다', async context => {
  const directory = await temporaryDirectory(context);
  await privateFile(directory, 'SLACK_LIVE_READ_ENABLED=malformed\nNODE_OPTIONS=--invalid\n', '.env');
  const automatic = cli(['slack-replay'], join(directory, 'runtime-default'), {}, directory);
  assert.equal(automatic.status, 0, automatic.stderr);
  const json = cli(['slack-replay', '--config', join(sourceRoot, 'config', 'slack.example.json')], join(directory, 'runtime-json'));
  assert.equal(json.status, 0, json.stderr);
});

test('실연결 환경 옵션도 명시적 live 허용과 토큰 없이는 worker를 시작하지 않는다', async context => {
  const directory = await temporaryDirectory(context);
  const disabled = cli(['slack-listen', '--env'], join(directory, 'disabled'), environment());
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /SLACK_LIVE_READ_DISABLED/);
  await assert.rejects(lstat(join(directory, 'disabled')), { code: 'ENOENT' });
  const path = await privateFile(directory, environmentText({ SLACK_LIVE_READ_ENABLED: 'true' }));
  const absentTokens = cli(['slack-listen', '--env-file', path], join(directory, 'runtime'));
  assert.equal(absentTokens.status, 1);
  assert.match(absentTokens.stderr, /SLACK_TOKENS_REQUIRED/);
  assert.equal(absentTokens.stdout, '');
});
