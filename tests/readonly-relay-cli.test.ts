import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { hashRepository } from '../src/adapters/demo-repository.js';
import { assertReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import type { ReadonlyRelayConfig } from '../src/domain/readonly-relay.js';
import type { ReadonlyRelaySnapshot } from '../src/ports/readonly-relay.js';
import type { ReadonlyLiveSnapshot } from '../src/ports/readonly-live.js';

const config: ReadonlyRelayConfig = {
  enabled: true, policyVersion: 'readonly-relay-codex-v1', codexPath: '/synthetic/nonexistent/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384,
};
const removeFixture = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await removeFixture(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
};
const fileHash = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex');
const request = (snapshot: ReadonlyRelaySnapshot): string[] => [
  '--task', snapshot.task.investigationId, '--plan-hash', snapshot.task.plan.planHash,
];

const prepare = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-readonly-relay-cli-')));
  await chmod(root, 0o700); t.after(() => removeFixture(root));
  const data = join(root, 'data'); const configPath = join(root, 'relay.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const execute = (args: string[], directory = data, preload?: string) => spawnSync(process.execPath,
    [...(preload ? ['--import', pathToFileURL(preload).href] : []), resolve('dist/src/cli/main.js'), ...args, '--data-dir', directory], {
      env: { HOME: root, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', SYNTHETIC_HOST_SECRET: 'SYNTHETIC_NOT_FOR_MODEL' },
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
  const run = <T>(args: string[]): T => {
    const result = execute(args);
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, ''); assert.doesNotMatch(result.stdout, /SYNTHETIC_NOT_FOR_MODEL/);
    return JSON.parse(result.stdout) as T;
  };
  const rejected = (args: string[], code?: string): void => {
    const result = execute(args);
    assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stdout); assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /SYNTHETIC_NOT_FOR_MODEL/);
    if (code) assert.equal(result.stderr.split('\n')[0], code);
  };
  const plan = (extra: string[] = []) => run<ReadonlyRelaySnapshot & { configuration: ReadonlyRelayConfig }>([
    'readonly-relay-plan', '--fixture', 'flow', '--config', configPath, ...extra,
  ]);
  const approve = (snapshot: ReadonlyRelaySnapshot) => run<ReadonlyRelaySnapshot>([
    'readonly-relay-approve', ...request(snapshot), '--expires-in-minutes', '30', '--config', configPath,
  ]);
  const inspect = (snapshot: ReadonlyRelaySnapshot) => run<ReadonlyRelaySnapshot>([
    'readonly-relay-inspect', '--task', snapshot.task.investigationId,
  ]);
  return { root, data, configPath, execute, run, rejected, plan, approve, inspect };
};

test('relay CLI는 선택한 합성 입력·정확한 요청·고정 연결 설정을 보여 주고 승인 전 무변경을 유지한다', async (t) => {
  const cli = await prepare(t);
  const planned = cli.plan(['--selection', 'all', '--transfer', 'controller']);
  const plan = planned.task.plan; const payload = planned.payload!;
  assert.equal(planned.task.status, 'AWAITING_APPROVAL'); assert.equal(planned.attempt, null); assert.equal(planned.report, null);
  assert.equal(plan.mode, 'live'); assert.equal(plan.transport, 'codex-cli-relay');
  assert.equal(plan.policy, 'synthetic-readonly-relay-v1'); assert.equal(plan.profileId, 'codex-chatgpt-relay-v1');
  assert.equal(plan.model, 'gpt-6.1-sol'); assert.equal(plan.authentication, 'chatgpt');
  assert.equal(plan.destination, 'https://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(planned.configuration, config); assert.deepEqual(plan.configSnapshot, config);
  assert.deepEqual(plan.writeAllowedFiles, []); assert.deepEqual(plan.testCommandIds, []); assert.equal(plan.executionAllowed, false);
  assert.equal(payload.context.evidence.length, 4);
  const input = JSON.parse(payload.inputText); assert.equal(input.evidence.length, 1);
  assert.equal(input.evidence[0].path, 'src/controller.ts');
  const body = JSON.parse(payload.requestBody);
  assert.equal(body.input[0].content[0].text, payload.inputText); assert.deepEqual(body.tools, []);
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.text.format.name, 'readonly_report');
  assert.equal(plan.requestBodyHash, createHash('sha256').update(payload.requestBody).digest('hex'));
  assert.equal(payload.requestEnvelope.body, payload.requestBody); assert.equal(payload.requestEnvelope.retries, 0);
  assert.equal(payload.requestEnvelope.redirect, 'error');
  assert.ok(!payload.requestBody.includes(cli.root)); assert.ok(!payload.requestBody.includes('configSnapshot'));
  const before = await hashRepository(payload.repository.sourceRoot);
  cli.rejected(['readonly-relay-run', ...request(planned), '--config', cli.configPath]);
  assert.equal(cli.inspect(planned).attempt, null);
  const approved = cli.approve(planned);
  assert.equal(approved.task.status, 'APPROVED'); assert.equal(approved.approvals[0]?.usedAt, null);
  assert.deepEqual(approved.approvals[0]?.planSnapshot, plan);
  assert.equal(cli.inspect(planned).task.status, 'APPROVED');
  await assertReadonlyRepository(payload.repository); assert.equal(await hashRepository(payload.repository.sourceRoot), before);
  assert.equal((await lstat(join(cli.data, 'readonly-relay.sqlite'))).mode & 0o077, 0);
  await assert.rejects(lstat(join(cli.root, '.codex')), { code: 'ENOENT' });
});

test('relay 문의·변경 요청의 취소·무효화·복구·정리는 인증 없는 로컬 제어로 남는다', async (t) => {
  const cli = await prepare(t);
  for (const action of ['cancel', 'invalidate']) {
    const planned = cli.plan(['--request', action === 'cancel' ? 'flow-question' : 'change-request', '--transfer', 'service']);
    cli.approve(planned);
    const controlled = cli.run<ReadonlyRelaySnapshot>([`readonly-relay-${action}`, '--task', planned.task.investigationId]);
    assert.ok(['CANCELLED', 'BLOCKED'].includes(controlled.task.status)); assert.ok(controlled.approvals[0]?.revokedAt);
    assert.equal(controlled.attempt, null); assert.equal(controlled.report, null);
    const recovered = cli.run<ReadonlyRelaySnapshot>(['readonly-relay-recover', '--task', planned.task.investigationId]);
    assert.equal(recovered.task.status, controlled.task.status);
    cli.rejected(['readonly-relay-run', ...request(planned), '--config', cli.configPath]);
    assert.equal(cli.inspect(planned).attempt, null);
    await assertReadonlyRepository(planned.payload!.repository);
  }
  cli.run(['readonly-relay-prune']);
  await assert.rejects(lstat(join(cli.root, '.codex')), { code: 'ENOENT' });
});

test('relay CLI는 필수 설정·TTL과 등록 입력만 받고 임의 모델·전송·실행 옵션을 거부한다', async (t) => {
  const cli = await prepare(t); const id = '00000000-0000-0000-0000-000000000000'; const hash = 'a'.repeat(64);
  for (const args of [
    ['readonly-relay-plan', '--fixture', 'flow'], ['readonly-relay-plan', '--config', cli.configPath],
    ['readonly-relay-plan', '--fixture', 'other', '--config', cli.configPath],
    ['readonly-relay-plan', '--fixture', 'flow', '--config', cli.configPath, '--selection', 'all', '--selection', 'service'],
    ['readonly-relay-plan', '--fixture', 'flow', '--config', cli.configPath, '--transfer', 'outside'],
    ['readonly-relay-approve', '--task', id, '--plan-hash', hash, '--expires-in-minutes', '30'],
    ['readonly-relay-run', '--task', id, '--plan-hash', hash],
    ['readonly-relay-inspect', '--task', id, '--config', cli.configPath],
    ['readonly-relay-inspect', '--task', '../escape'],
    ['readonly-relay-inspect', '--task', id, '--approval-offset', '1000000001'],
    ...['0', '61', '1440', '01', '1.5'].map((ttl) => ['readonly-relay-approve', '--task', id, '--plan-hash', hash,
      '--expires-in-minutes', ttl, '--config', cli.configPath]),
    ...['--profile', '--model', '--url', '--header', '--auth', '--token', '--repo', '--path', '--body', '--command', '--pr', '--mr', '--commit', '--push'].map((flag) => [
      'readonly-relay-plan', '--fixture', 'flow', '--config', cli.configPath, flag, 'SYNTHETIC_FORBIDDEN',
    ]),
  ]) cli.rejected(args, 'INVALID_ARGUMENTS');
  for (const suffix of ['export', 'execute', 'commit', 'push', 'pr', 'mr']) cli.rejected([`readonly-relay-${suffix}`], 'UNKNOWN_COMMAND');
  await assert.rejects(lstat(cli.data), { code: 'ENOENT' });
});

test('비활성 설정과 native binary 설정 변경은 새 relay 승인과 실행 소비를 거부한다', async (t) => {
  const cli = await prepare(t);
  await writeFile(cli.configPath, JSON.stringify({ ...config, enabled: false }));
  const disabled = cli.plan();
  cli.rejected(['readonly-relay-approve', ...request(disabled), '--expires-in-minutes', '30', '--config', cli.configPath]);
  cli.rejected(['readonly-relay-run', ...request(disabled), '--config', cli.configPath]);
  assert.equal(cli.inspect(disabled).attempt, null);
  await writeFile(cli.configPath, JSON.stringify(config));
  cli.rejected(['readonly-relay-approve', ...request(disabled), '--expires-in-minutes', '30', '--config', cli.configPath]);
  const planned = cli.plan(); cli.approve(planned);
  await writeFile(cli.configPath, JSON.stringify({ ...config, codexSha256: 'b'.repeat(64) }));
  cli.rejected(['readonly-relay-run', ...request(planned), '--config', cli.configPath]);
  const inspected = cli.inspect(planned);
  assert.equal(inspected.task.status, 'APPROVED'); assert.equal(inspected.attempt, null); assert.equal(inspected.approvals[0]?.usedAt, null);
  await unlink(cli.configPath);
  assert.equal(cli.inspect(planned).task.status, 'APPROVED');
  cli.run(['readonly-relay-cancel', '--task', planned.task.investigationId]);
  cli.run(['readonly-relay-recover', '--task', planned.task.investigationId]);
  cli.run(['readonly-relay-prune']);
});

test('private 설정·DB 링크를 거부하고 외부 파일과 기존 상태를 보존한다', async (t) => {
  const cli = await prepare(t); const planned = cli.plan();
  const alias = join(cli.root, 'alias.json');
  await symlink(cli.configPath, alias);
  cli.rejected(['readonly-relay-plan', '--fixture', 'flow', '--config', alias], 'INVALID_READONLY_RELAY_CONFIG');
  await unlink(alias); await link(cli.configPath, alias);
  cli.rejected(['readonly-relay-plan', '--fixture', 'flow', '--config', alias], 'INVALID_READONLY_RELAY_CONFIG');
  await unlink(alias); await chmod(cli.configPath, 0o644);
  cli.rejected(['readonly-relay-plan', '--fixture', 'flow', '--config', cli.configPath], 'INVALID_READONLY_RELAY_CONFIG');
  await chmod(cli.configPath, 0o600);
  for (const changed of [{ ...config, authMode: 'api-key' }, { ...config, model: 'other-model' }, { ...config, endpoint: 'https://other.invalid' }]) {
    await writeFile(alias, JSON.stringify(changed), { mode: 0o600 });
    cli.rejected(['readonly-relay-plan', '--fixture', 'flow', '--config', alias], 'INVALID_READONLY_RELAY_CONFIG');
  }
  const database = join(cli.data, 'readonly-relay.sqlite'); const saved = await readFile(database);
  const outside = join(cli.root, 'outside'); await writeFile(outside, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  const before = await fileHash(outside);
  await unlink(database); await symlink(outside, database);
  cli.rejected(['readonly-relay-inspect', '--task', planned.task.investigationId], 'UNSAFE_RUNTIME_FILE');
  await unlink(database); await link(outside, database);
  cli.rejected(['readonly-relay-inspect', '--task', planned.task.investigationId], 'UNSAFE_RUNTIME_FILE');
  await unlink(database); await writeFile(database, saved, { mode: 0o600 });
  assert.equal(await fileHash(outside), before); assert.equal(cli.inspect(planned).task.status, 'AWAITING_APPROVAL');
});

test('설정의 중복 키·잘못된 UTF-8·읽기 도중 변경은 상태 생성 전에 정적으로 거부한다', async (t) => {
  const cli = await prepare(t);
  for (const raw of [
    Buffer.from('{"enabled":false,' + JSON.stringify(config).slice(1)),
    Buffer.from('{"\\u0065nabled":false,' + JSON.stringify(config).slice(1)),
    Buffer.concat([Buffer.from('{"codexPath":"/synthetic/'), Buffer.from([0x80]), Buffer.from('"}')]),
    Buffer.from(' '.repeat(64_000) + JSON.stringify(config)),
  ]) {
    await writeFile(cli.configPath, raw);
    cli.rejected(['readonly-relay-plan', '--fixture', 'flow', '--config', cli.configPath], 'INVALID_READONLY_RELAY_CONFIG');
  }
  await writeFile(cli.configPath, JSON.stringify(config));
  const preload = join(cli.root, 'change-during-read.mjs');
  // 실제 FileHandle.read가 끝난 직후 같은 설정에 공백을 추가해 경합을 결정적으로 재현한다.
  await writeFile(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalOpen = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === ${JSON.stringify(cli.configPath)}) {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          await fs.promises.appendFile(${JSON.stringify(cli.configPath)}, ' ');
          return result;
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
  `, { mode: 0o600 });
  const changed = cli.execute(['readonly-relay-plan', '--fixture', 'flow', '--config', cli.configPath], cli.data, preload);
  assert.equal(changed.error, undefined); assert.equal(changed.status, 1); assert.equal(changed.stdout, '');
  assert.equal(changed.stderr.split('\n')[0], 'INVALID_READONLY_RELAY_CONFIG');
  await assert.rejects(lstat(join(cli.data, 'readonly-relay.sqlite')), { code: 'ENOENT' });
});

test('relay 조회·취소는 다른 실행 lease와 공존하고 승인·실행·복구·정리는 직렬화한다', async (t) => {
  const cli = await prepare(t); const planned = cli.plan(); cli.approve(planned);
  const release = acquireRuntimeLease(cli.data);
  try {
    assert.equal(cli.inspect(planned).task.status, 'APPROVED');
    for (const args of [
      ['readonly-relay-plan', '--fixture', 'flow', '--config', cli.configPath],
      ['readonly-relay-approve', ...request(planned), '--expires-in-minutes', '30', '--config', cli.configPath],
      ['readonly-relay-run', ...request(planned), '--config', cli.configPath],
      ['readonly-relay-recover', '--task', planned.task.investigationId], ['readonly-relay-prune'],
    ]) cli.rejected(args, 'HARNESS_ALREADY_RUNNING');
    assert.equal(cli.run<ReadonlyRelaySnapshot>(['readonly-relay-cancel', '--task', planned.task.investigationId]).task.status, 'CANCELLED');
  } finally { release(); }
  assert.equal(cli.inspect(planned).attempt, null);
});

test('mock·offline 승인과 relay 승인은 양방향 혼용되지 않고 기존 DB가 변하지 않는다', async (t) => {
  const cli = await prepare(t); const live = cli.plan();
  for (const [prefix, database] of [
    ['readonly-investigation', 'readonly-investigations.sqlite'], ['readonly-transport', 'readonly-transports.sqlite'],
    ['readonly-model-preflight', 'readonly-model-preflights.sqlite'],
  ]) {
    const old = cli.run<ReadonlyRelaySnapshot>([`${prefix}-plan`, '--fixture', 'flow']);
    cli.run([`${prefix}-approve`, ...request(old), '--expires-in-minutes', '30']);
    const before = await fileHash(join(cli.data, database!));
    cli.rejected(['readonly-relay-approve', ...request(old), '--expires-in-minutes', '30', '--config', cli.configPath]);
    cli.rejected([`${prefix}-approve`, ...request(live), '--expires-in-minutes', '30']);
    assert.equal(await fileHash(join(cli.data, database!)), before);
  }
  assert.equal(cli.inspect(live).task.status, 'AWAITING_APPROVAL'); assert.equal(cli.inspect(live).attempt, null);
});

test('승인 이후 합성 원본이 바뀌면 실제 adapter 호출 전에 거부하고 승인 소비를 남기지 않는다', async (t) => {
  const cli = await prepare(t); const planned = cli.plan(); cli.approve(planned);
  const path = join(planned.payload!.repository.sourceRoot, 'src/controller.ts');
  await chmod(path, 0o600); await writeFile(path, '// synthetic source changed\n');
  cli.rejected(['readonly-relay-run', ...request(planned), '--config', cli.configPath]);
  const inspected = cli.inspect(planned);
  assert.equal(inspected.attempt, null); assert.equal(inspected.approvals[0]?.usedAt, null); assert.equal(inspected.report, null);
  assert.equal(await readFile(path, 'utf8'), '// synthetic source changed\n');
  await assert.rejects(lstat(join(cli.root, '.codex')), { code: 'ENOENT' });
});

test('relay와 기존 v9 live의 승인·계획·DB는 서로 승격되거나 소비되지 않는다', async (context) => {
  const cli = await prepare(context); const relay = cli.plan();
  const legacyConfig = join(cli.root, 'legacy-v9.json');
  await writeFile(legacyConfig, JSON.stringify({ ...config, policyVersion: 'readonly-live-codex-v9' }), { mode: 0o600 });
  const legacy = cli.run<ReadonlyLiveSnapshot>(['readonly-live-plan', '--fixture', 'flow', '--config', legacyConfig]);
  const legacyRequest = ['--task', legacy.task.investigationId, '--plan-hash', legacy.task.plan.planHash];
  cli.run(['readonly-live-approve', ...legacyRequest, '--expires-in-minutes', '30', '--config', legacyConfig]);
  const legacyBefore = await fileHash(join(cli.data, 'readonly-live.sqlite'));
  const relayBefore = await fileHash(join(cli.data, 'readonly-relay.sqlite'));
  cli.rejected(['readonly-relay-approve', ...legacyRequest, '--expires-in-minutes', '30', '--config', cli.configPath]);
  cli.rejected(['readonly-live-approve', ...request(relay), '--expires-in-minutes', '30', '--config', legacyConfig]);
  assert.equal(await fileHash(join(cli.data, 'readonly-live.sqlite')), legacyBefore);
  assert.equal(await fileHash(join(cli.data, 'readonly-relay.sqlite')), relayBefore);
  const unchanged = cli.inspect(relay); assert.equal(unchanged.task.status, 'AWAITING_APPROVAL'); assert.equal(unchanged.attempt, null);
  const old = cli.run<ReadonlyLiveSnapshot>(['readonly-live-inspect', '--task', legacy.task.investigationId]);
  assert.equal(old.task.status, 'APPROVED'); assert.equal(old.approvals[0]?.usedAt, null);
});

test('relay 계획·조회·승인·취소·무효화·복구·정리는 로그인 경로 접근 없이 완료된다', async (context) => {
  const cli = await prepare(context); const preload = join(cli.root, 'deny-login.mjs');
  await writeFile(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    for (const name of ['open','readFile','lstat','stat','access','realpath']) {
      const original = fs.promises[name];
      fs.promises[name] = async (...args) => {
        if (String(args[0]).includes('/.codex')) throw new Error('FORBIDDEN_LOGIN_ACCESS');
        return original(...args);
      };
    }
    syncBuiltinESMExports();
  `, { mode: 0o600 });
  const execute = <T>(args: string[]): T => {
    const result = cli.execute(args, cli.data, preload);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    return JSON.parse(result.stdout) as T;
  };
  const planned = execute<ReadonlyRelaySnapshot>(['readonly-relay-plan', '--fixture', 'flow', '--config', cli.configPath]);
  execute(['readonly-relay-inspect', '--task', planned.task.investigationId]);
  execute(['readonly-relay-approve', ...request(planned), '--expires-in-minutes', '10', '--config', cli.configPath]);
  execute(['readonly-relay-cancel', '--task', planned.task.investigationId]);
  execute(['readonly-relay-invalidate', '--task', planned.task.investigationId]);
  execute(['readonly-relay-recover', '--task', planned.task.investigationId]);
  execute(['readonly-relay-prune']);
  await assert.rejects(lstat(join(cli.root, '.codex')), { code: 'ENOENT' });
});
