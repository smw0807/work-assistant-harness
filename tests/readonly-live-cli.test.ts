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
import type { ReadonlyLiveConfig } from '../src/domain/readonly-live.js';
import type { ReadonlyLiveSnapshot } from '../src/ports/readonly-live.js';

const config: ReadonlyLiveConfig = {
  enabled: true, policyVersion: 'readonly-live-codex-v1', codexPath: '/synthetic/nonexistent/codex',
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
const request = (snapshot: ReadonlyLiveSnapshot): string[] => [
  '--task', snapshot.task.investigationId, '--plan-hash', snapshot.task.plan.planHash,
];

const prepare = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-readonly-live-cli-')));
  await chmod(root, 0o700); t.after(() => removeFixture(root));
  const data = join(root, 'data'); const configPath = join(root, 'live.json');
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
  const plan = (extra: string[] = []) => run<ReadonlyLiveSnapshot & { configuration: ReadonlyLiveConfig }>([
    'readonly-live-plan', '--fixture', 'flow', '--config', configPath, ...extra,
  ]);
  const approve = (snapshot: ReadonlyLiveSnapshot) => run<ReadonlyLiveSnapshot>([
    'readonly-live-approve', ...request(snapshot), '--expires-in-minutes', '30', '--config', configPath,
  ]);
  const inspect = (snapshot: ReadonlyLiveSnapshot) => run<ReadonlyLiveSnapshot>([
    'readonly-live-inspect', '--task', snapshot.task.investigationId,
  ]);
  return { root, data, configPath, execute, run, rejected, plan, approve, inspect };
};

test('live CLI는 선택한 합성 입력·정확한 요청·고정 연결 설정을 보여 주고 승인 전 무변경을 유지한다', async (t) => {
  const cli = await prepare(t);
  const planned = cli.plan(['--selection', 'all', '--transfer', 'controller']);
  const plan = planned.task.plan; const payload = planned.payload!;
  assert.equal(planned.task.status, 'AWAITING_APPROVAL'); assert.equal(planned.attempt, null); assert.equal(planned.report, null);
  assert.equal(plan.mode, 'live'); assert.equal(plan.transport, 'codex-cli-broker');
  assert.equal(plan.policy, 'synthetic-readonly-live-v1'); assert.equal(plan.profileId, 'codex-chatgpt-sse-v1');
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
  cli.rejected(['readonly-live-run', ...request(planned), '--config', cli.configPath]);
  assert.equal(cli.inspect(planned).attempt, null);
  const approved = cli.approve(planned);
  assert.equal(approved.task.status, 'APPROVED'); assert.equal(approved.approvals[0]?.usedAt, null);
  assert.deepEqual(approved.approvals[0]?.planSnapshot, plan);
  assert.equal(cli.inspect(planned).task.status, 'APPROVED');
  await assertReadonlyRepository(payload.repository); assert.equal(await hashRepository(payload.repository.sourceRoot), before);
  assert.equal((await lstat(join(cli.data, 'readonly-live.sqlite'))).mode & 0o077, 0);
  await assert.rejects(lstat(join(cli.root, '.codex')), { code: 'ENOENT' });
});

test('live v2 계획은 별도 응답 헤더 한도를 표시하고 v1 기록과 승인 경계를 보존한다', async (t) => {
  const cli = await prepare(t);
  const previous = cli.plan(); cli.approve(previous);
  const upgraded: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v2' };
  await writeFile(cli.configPath, JSON.stringify(upgraded));
  const planned = cli.plan(); const plan = planned.task.plan;
  assert.equal(plan.profileId, 'codex-chatgpt-sse-v2');
  assert.deepEqual(planned.configuration, upgraded); assert.deepEqual(plan.configSnapshot, upgraded);
  assert.equal(plan.limits.headers, 32); assert.equal(plan.limits.headerBytes, 8192);
  assert.equal(plan.limits.responseHeaders, 64); assert.equal(plan.limits.responseHeaderBytes, 16384);
  assert.equal(previous.task.plan.limits.responseHeaders, undefined);
  assert.equal(previous.task.plan.limits.responseHeaderBytes, undefined);
  assert.equal(planned.payload!.requestBody, previous.payload!.requestBody);
  assert.equal(plan.requestBodyHash, previous.task.plan.requestBodyHash);
  assert.notEqual(plan.connectionProfileHash, previous.task.plan.connectionProfileHash);
  assert.notEqual(plan.configHash, previous.task.plan.configHash);
  const inspected = cli.inspect(previous);
  assert.deepEqual(inspected.task.plan, previous.task.plan);
  assert.equal(inspected.task.status, 'APPROVED'); assert.equal(inspected.approvals[0]?.usedAt, null);
  cli.rejected(['readonly-live-run', ...request(previous), '--config', cli.configPath]);
  assert.equal(cli.inspect(previous).attempt, null);
  await writeFile(cli.configPath, JSON.stringify(config));
  cli.rejected(['readonly-live-approve', ...request(planned), '--expires-in-minutes', '30', '--config', cli.configPath]);
  assert.equal(cli.inspect(planned).task.status, 'AWAITING_APPROVAL');
  await writeFile(cli.configPath, JSON.stringify(upgraded));
  assert.equal(cli.approve(planned).task.status, 'APPROVED');
  cli.run(['readonly-live-cancel', '--task', previous.task.investigationId]);
  const recovered = cli.run<ReadonlyLiveSnapshot>(['readonly-live-recover', '--task', previous.task.investigationId]);
  assert.equal(recovered.task.status, 'CANCELLED'); assert.equal(recovered.attempt, null);
  await assertReadonlyRepository(previous.payload!.repository);
  await assertReadonlyRepository(planned.payload!.repository);
  await assert.rejects(lstat(join(cli.root, '.codex')), { code: 'ENOENT' });
});

test('live v3 계획은 새 응답 계약을 구분하고 v1·v2 계획 조회와 교차 승인 거부를 유지한다', async (t) => {
  const cli = await prepare(t);
  const legacy: ReadonlyLiveSnapshot[] = [];
  for (const policyVersion of ['readonly-live-codex-v1', 'readonly-live-codex-v2'] as const) {
    await writeFile(cli.configPath, JSON.stringify({ ...config, policyVersion }));
    const planned = cli.plan(); cli.approve(planned); legacy.push(planned);
  }
  const upgraded: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v3' };
  await writeFile(cli.configPath, JSON.stringify(upgraded));
  const current = cli.plan(); const plan = current.task.plan;
  assert.equal(plan.profileId, 'codex-chatgpt-sse-v3');
  assert.deepEqual(current.configuration, upgraded); assert.deepEqual(plan.configSnapshot, upgraded);
  assert.deepEqual(plan.limits, legacy[1]!.task.plan.limits);
  assert.equal(plan.limits.responseHeaders, 64); assert.equal(plan.limits.responseHeaderBytes, 16384);
  for (const previous of legacy) {
    assert.equal(current.payload!.requestBody, previous.payload!.requestBody);
    assert.equal(plan.requestBodyHash, previous.task.plan.requestBodyHash);
    assert.notEqual(plan.connectionProfileHash, previous.task.plan.connectionProfileHash);
    assert.notEqual(plan.configHash, previous.task.plan.configHash);
    const inspected = cli.inspect(previous);
    assert.deepEqual(inspected.task.plan, previous.task.plan);
    assert.equal(inspected.task.status, 'APPROVED'); assert.equal(inspected.approvals[0]?.usedAt, null);
    cli.rejected(['readonly-live-run', ...request(previous), '--config', cli.configPath]);
    assert.equal(cli.inspect(previous).attempt, null);
  }
  for (const previous of legacy) {
    await writeFile(cli.configPath, JSON.stringify(previous.task.plan.configSnapshot));
    cli.rejected(['readonly-live-approve', ...request(current), '--expires-in-minutes', '30', '--config', cli.configPath]);
    assert.equal(cli.inspect(current).task.status, 'AWAITING_APPROVAL');
  }
  await writeFile(cli.configPath, JSON.stringify(upgraded));
  assert.equal(cli.approve(current).task.status, 'APPROVED');
  for (const previous of legacy) {
    cli.run(['readonly-live-cancel', '--task', previous.task.investigationId]);
    const recovered = cli.run<ReadonlyLiveSnapshot>(['readonly-live-recover', '--task', previous.task.investigationId]);
    assert.equal(recovered.task.status, 'CANCELLED'); assert.equal(recovered.attempt, null);
    await assertReadonlyRepository(previous.payload!.repository);
  }
  await assertReadonlyRepository(current.payload!.repository);
  await assert.rejects(lstat(join(cli.root, '.codex')), { code: 'ENOENT' });
});

test('live v5 본문 형식 계약 계획은 구형 네 버전의 해시·기록과 승인 소비 경계를 보존한다', async (t) => {
  const cli = await prepare(t);
  const legacy: ReadonlyLiveSnapshot[] = [];
  const frozenProfiles = [
    ['readonly-live-codex-v1', 'abad063562297daa1041190cc93cbae53bef722180eb8e7df85e5d5bbd7fc478', '425aa6bf9038590f6e9323bbaff87a32205f3e669e646b64bff7b159df72a8f5'],
    ['readonly-live-codex-v2', '75d2919f4a536de29f1dca50f9e0a552703f7aac84208f4618c3ed21509e13bc', '7ee80db1923059928fe7c15bab3e47cd2448262142fc2403ca3e043d95bdeebc'],
    ['readonly-live-codex-v3', 'ba6403665cfa47beddb3ebaaece4d28d728f865fa404dbf140df84ab8d12fa1f', 'c35e2c481ab07030dd6f75820a25a9ce8e654b319bd2bbb46f7ad7422626e431'],
    ['readonly-live-codex-v4', '6995c929e5aed242f9ebc3033844221d1d04de3d840ef96508d907fce0512f05', '703357cf175841861819ea1b3a507e3e7418a96678a3efa17574fa0fab2bc788'],
  ] as const;
  for (const [policyVersion, profileHash, configHash] of frozenProfiles) {
    await writeFile(cli.configPath, JSON.stringify({ ...config, policyVersion }));
    const planned = cli.plan();
    assert.equal(planned.task.plan.connectionProfileHash, profileHash);
    assert.equal(planned.task.plan.configHash, configHash);
    cli.approve(planned); legacy.push(planned);
  }
  const upgraded: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v5' };
  await writeFile(cli.configPath, JSON.stringify(upgraded));
  const current = cli.plan(); const plan = current.task.plan;
  assert.equal(plan.profileId, 'codex-chatgpt-sse-v5');
  assert.deepEqual(current.configuration, upgraded); assert.deepEqual(plan.configSnapshot, upgraded);
  assert.deepEqual(plan.limits, legacy[3]!.task.plan.limits);
  assert.equal(plan.model, legacy[3]!.task.plan.model);
  assert.equal(plan.requestBodyHash, 'bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe');
  for (const previous of legacy) {
    assert.equal(current.payload!.requestBody, previous.payload!.requestBody);
    assert.equal(plan.requestBodyHash, previous.task.plan.requestBodyHash);
    assert.deepEqual(current.payload!.requestEnvelope.headers, previous.payload!.requestEnvelope.headers);
    assert.notEqual(plan.connectionProfileHash, previous.task.plan.connectionProfileHash);
    assert.notEqual(plan.configHash, previous.task.plan.configHash);
    assert.notEqual(plan.requestEnvelopeHash, previous.task.plan.requestEnvelopeHash);
    const inspected = cli.inspect(previous);
    assert.deepEqual(inspected.task.plan, previous.task.plan);
    assert.deepEqual(inspected.approvals[0]?.planSnapshot, previous.task.plan);
    cli.rejected(['readonly-live-run', ...request(previous), '--config', cli.configPath]);
    assert.equal(cli.inspect(previous).attempt, null); assert.equal(cli.inspect(previous).approvals[0]?.usedAt, null);
  }
  for (const previous of legacy) {
    await writeFile(cli.configPath, JSON.stringify(previous.task.plan.configSnapshot));
    cli.rejected(['readonly-live-approve', ...request(current), '--expires-in-minutes', '30', '--config', cli.configPath]);
    assert.equal(cli.inspect(current).task.status, 'AWAITING_APPROVAL');
  }
  await writeFile(cli.configPath, JSON.stringify(upgraded));
  assert.equal(cli.approve(current).task.status, 'APPROVED');
  for (const previous of legacy) {
    await writeFile(cli.configPath, JSON.stringify(previous.task.plan.configSnapshot));
    cli.rejected(['readonly-live-run', ...request(current), '--config', cli.configPath]);
    assert.equal(cli.inspect(current).attempt, null); assert.equal(cli.inspect(current).approvals[0]?.usedAt, null);
    cli.run(['readonly-live-cancel', '--task', previous.task.investigationId]);
    const recovered = cli.run<ReadonlyLiveSnapshot>(['readonly-live-recover', '--task', previous.task.investigationId]);
    assert.equal(recovered.task.status, 'CANCELLED'); assert.equal(recovered.attempt, null);
    await assertReadonlyRepository(previous.payload!.repository);
  }
  await assertReadonlyRepository(current.payload!.repository);
  await assert.rejects(lstat(join(cli.root, '.codex')), { code: 'ENOENT' });
});

test('live 문의·변경 요청의 취소·무효화·복구·정리는 인증 없는 로컬 제어로 남는다', async (t) => {
  const cli = await prepare(t);
  for (const action of ['cancel', 'invalidate']) {
    const planned = cli.plan(['--request', action === 'cancel' ? 'flow-question' : 'change-request', '--transfer', 'service']);
    cli.approve(planned);
    const controlled = cli.run<ReadonlyLiveSnapshot>([`readonly-live-${action}`, '--task', planned.task.investigationId]);
    assert.ok(['CANCELLED', 'BLOCKED'].includes(controlled.task.status)); assert.ok(controlled.approvals[0]?.revokedAt);
    assert.equal(controlled.attempt, null); assert.equal(controlled.report, null);
    const recovered = cli.run<ReadonlyLiveSnapshot>(['readonly-live-recover', '--task', planned.task.investigationId]);
    assert.equal(recovered.task.status, controlled.task.status);
    cli.rejected(['readonly-live-run', ...request(planned), '--config', cli.configPath]);
    assert.equal(cli.inspect(planned).attempt, null);
    await assertReadonlyRepository(planned.payload!.repository);
  }
  cli.run(['readonly-live-prune']);
  await assert.rejects(lstat(join(cli.root, '.codex')), { code: 'ENOENT' });
});

test('live CLI는 필수 설정·TTL과 등록 입력만 받고 임의 모델·전송·실행 옵션을 거부한다', async (t) => {
  const cli = await prepare(t); const id = '00000000-0000-0000-0000-000000000000'; const hash = 'a'.repeat(64);
  for (const args of [
    ['readonly-live-plan', '--fixture', 'flow'], ['readonly-live-plan', '--config', cli.configPath],
    ['readonly-live-plan', '--fixture', 'other', '--config', cli.configPath],
    ['readonly-live-plan', '--fixture', 'flow', '--config', cli.configPath, '--selection', 'all', '--selection', 'service'],
    ['readonly-live-plan', '--fixture', 'flow', '--config', cli.configPath, '--transfer', 'outside'],
    ['readonly-live-approve', '--task', id, '--plan-hash', hash, '--expires-in-minutes', '30'],
    ['readonly-live-run', '--task', id, '--plan-hash', hash],
    ['readonly-live-inspect', '--task', id, '--config', cli.configPath],
    ['readonly-live-inspect', '--task', '../escape'],
    ['readonly-live-inspect', '--task', id, '--approval-offset', '1000000001'],
    ...['0', '61', '1440', '01', '1.5'].map((ttl) => ['readonly-live-approve', '--task', id, '--plan-hash', hash,
      '--expires-in-minutes', ttl, '--config', cli.configPath]),
    ...['--profile', '--model', '--url', '--header', '--auth', '--token', '--repo', '--path', '--body', '--command', '--pr', '--mr', '--commit', '--push'].map((flag) => [
      'readonly-live-plan', '--fixture', 'flow', '--config', cli.configPath, flag, 'SYNTHETIC_FORBIDDEN',
    ]),
  ]) cli.rejected(args, 'INVALID_ARGUMENTS');
  for (const suffix of ['export', 'execute', 'commit', 'push', 'pr', 'mr']) cli.rejected([`readonly-live-${suffix}`], 'UNKNOWN_COMMAND');
  await assert.rejects(lstat(cli.data), { code: 'ENOENT' });
});

test('비활성 설정과 native binary 설정 변경은 새 live 승인과 실행 소비를 거부한다', async (t) => {
  const cli = await prepare(t);
  await writeFile(cli.configPath, JSON.stringify({ ...config, enabled: false }));
  const disabled = cli.plan();
  cli.rejected(['readonly-live-approve', ...request(disabled), '--expires-in-minutes', '30', '--config', cli.configPath]);
  cli.rejected(['readonly-live-run', ...request(disabled), '--config', cli.configPath]);
  assert.equal(cli.inspect(disabled).attempt, null);
  await writeFile(cli.configPath, JSON.stringify(config));
  cli.rejected(['readonly-live-approve', ...request(disabled), '--expires-in-minutes', '30', '--config', cli.configPath]);
  const planned = cli.plan(); cli.approve(planned);
  await writeFile(cli.configPath, JSON.stringify({ ...config, codexSha256: 'b'.repeat(64) }));
  cli.rejected(['readonly-live-run', ...request(planned), '--config', cli.configPath]);
  const inspected = cli.inspect(planned);
  assert.equal(inspected.task.status, 'APPROVED'); assert.equal(inspected.attempt, null); assert.equal(inspected.approvals[0]?.usedAt, null);
  await unlink(cli.configPath);
  assert.equal(cli.inspect(planned).task.status, 'APPROVED');
  cli.run(['readonly-live-cancel', '--task', planned.task.investigationId]);
  cli.run(['readonly-live-recover', '--task', planned.task.investigationId]);
  cli.run(['readonly-live-prune']);
});

test('private 설정·DB 링크를 거부하고 외부 파일과 기존 상태를 보존한다', async (t) => {
  const cli = await prepare(t); const planned = cli.plan();
  const alias = join(cli.root, 'alias.json');
  await symlink(cli.configPath, alias);
  cli.rejected(['readonly-live-plan', '--fixture', 'flow', '--config', alias], 'INVALID_READONLY_LIVE_CONFIG');
  await unlink(alias); await link(cli.configPath, alias);
  cli.rejected(['readonly-live-plan', '--fixture', 'flow', '--config', alias], 'INVALID_READONLY_LIVE_CONFIG');
  await unlink(alias); await chmod(cli.configPath, 0o644);
  cli.rejected(['readonly-live-plan', '--fixture', 'flow', '--config', cli.configPath], 'INVALID_READONLY_LIVE_CONFIG');
  await chmod(cli.configPath, 0o600);
  for (const changed of [{ ...config, authMode: 'api-key' }, { ...config, model: 'other-model' }, { ...config, endpoint: 'https://other.invalid' }]) {
    await writeFile(alias, JSON.stringify(changed), { mode: 0o600 });
    cli.rejected(['readonly-live-plan', '--fixture', 'flow', '--config', alias], 'INVALID_READONLY_LIVE_CONFIG');
  }
  const database = join(cli.data, 'readonly-live.sqlite'); const saved = await readFile(database);
  const outside = join(cli.root, 'outside'); await writeFile(outside, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  const before = await fileHash(outside);
  await unlink(database); await symlink(outside, database);
  cli.rejected(['readonly-live-inspect', '--task', planned.task.investigationId], 'UNSAFE_RUNTIME_FILE');
  await unlink(database); await link(outside, database);
  cli.rejected(['readonly-live-inspect', '--task', planned.task.investigationId], 'UNSAFE_RUNTIME_FILE');
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
    cli.rejected(['readonly-live-plan', '--fixture', 'flow', '--config', cli.configPath], 'INVALID_READONLY_LIVE_CONFIG');
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
  const changed = cli.execute(['readonly-live-plan', '--fixture', 'flow', '--config', cli.configPath], cli.data, preload);
  assert.equal(changed.error, undefined); assert.equal(changed.status, 1); assert.equal(changed.stdout, '');
  assert.equal(changed.stderr.split('\n')[0], 'INVALID_READONLY_LIVE_CONFIG');
  await assert.rejects(lstat(join(cli.data, 'readonly-live.sqlite')), { code: 'ENOENT' });
});

test('live 조회·취소는 다른 실행 lease와 공존하고 승인·실행·복구·정리는 직렬화한다', async (t) => {
  const cli = await prepare(t); const planned = cli.plan(); cli.approve(planned);
  const release = acquireRuntimeLease(cli.data);
  try {
    assert.equal(cli.inspect(planned).task.status, 'APPROVED');
    for (const args of [
      ['readonly-live-plan', '--fixture', 'flow', '--config', cli.configPath],
      ['readonly-live-approve', ...request(planned), '--expires-in-minutes', '30', '--config', cli.configPath],
      ['readonly-live-run', ...request(planned), '--config', cli.configPath],
      ['readonly-live-recover', '--task', planned.task.investigationId], ['readonly-live-prune'],
    ]) cli.rejected(args, 'HARNESS_ALREADY_RUNNING');
    assert.equal(cli.run<ReadonlyLiveSnapshot>(['readonly-live-cancel', '--task', planned.task.investigationId]).task.status, 'CANCELLED');
  } finally { release(); }
  assert.equal(cli.inspect(planned).attempt, null);
});

test('mock·offline 승인과 live 승인은 양방향 혼용되지 않고 기존 DB가 변하지 않는다', async (t) => {
  const cli = await prepare(t); const live = cli.plan();
  for (const [prefix, database] of [
    ['readonly-investigation', 'readonly-investigations.sqlite'], ['readonly-transport', 'readonly-transports.sqlite'],
    ['readonly-model-preflight', 'readonly-model-preflights.sqlite'],
  ]) {
    const old = cli.run<ReadonlyLiveSnapshot>([`${prefix}-plan`, '--fixture', 'flow']);
    cli.run([`${prefix}-approve`, ...request(old), '--expires-in-minutes', '30']);
    const before = await fileHash(join(cli.data, database!));
    cli.rejected(['readonly-live-approve', ...request(old), '--expires-in-minutes', '30', '--config', cli.configPath]);
    cli.rejected([`${prefix}-approve`, ...request(live), '--expires-in-minutes', '30']);
    assert.equal(await fileHash(join(cli.data, database!)), before);
  }
  assert.equal(cli.inspect(live).task.status, 'AWAITING_APPROVAL'); assert.equal(cli.inspect(live).attempt, null);
});

test('승인 이후 합성 원본이 바뀌면 실제 adapter 호출 전에 거부하고 승인 소비를 남기지 않는다', async (t) => {
  const cli = await prepare(t); const planned = cli.plan(); cli.approve(planned);
  const path = join(planned.payload!.repository.sourceRoot, 'src/controller.ts');
  await chmod(path, 0o600); await writeFile(path, '// synthetic source changed\n');
  cli.rejected(['readonly-live-run', ...request(planned), '--config', cli.configPath]);
  const inspected = cli.inspect(planned);
  assert.equal(inspected.attempt, null); assert.equal(inspected.approvals[0]?.usedAt, null); assert.equal(inspected.report, null);
  assert.equal(await readFile(path, 'utf8'), '// synthetic source changed\n');
  await assert.rejects(lstat(join(cli.root, '.codex')), { code: 'ENOENT' });
});
