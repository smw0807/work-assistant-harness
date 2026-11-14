import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { RestrictedReadonlyRelayCodex, readonlyRelayCodexArguments } from '../src/adapters/readonly-relay-codex.js';
import { startReadonlyRelayBroker, selectReadonlyRelayResponseHeaders, type ReadonlyRelayBroker, type ReadonlyRelayTransport } from '../src/adapters/readonly-relay-broker.js';
import { SqliteReadonlyRelayStore } from '../src/adapters/sqlite-readonly-relay-store.js';
import { ReadonlyRelayService } from '../src/application/investigate-relay.js';
import { assertReadonlyRepository, collectReadonlyPayload, prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { readonlyRelayCleanupConfirmed } from '../src/adapters/readonly-relay-lifecycle.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../src/domain/readonly-relay.js';
import { READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS } from '../src/domain/readonly-relay.js';
import { createReadonlyRelayPayload, createReadonlyRelayPlan } from '../src/policy/readonly-relay-policy.js';
import { defaultReadonlySelection, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { codexProposalArguments } from '../src/adapters/codex-cli-contract.js';

const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v1', codexPath: '/opt/synthetic/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const credential = { kind: 'chatgpt' as const, accessToken: 'synthetic.test.only', accountId: 'synthetic-account' };
const skip = process.platform === 'darwin' && process.env.HARNESS_NATIVE_CODEX_PROBE === '1' ? false : 'native macOS probe opt-in required';
const nativeConfig = (): ReadonlyRelayConfig => ({ ...config,
  codexPath: process.env.HARNESS_NATIVE_CODEX_PATH ?? '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex',
  codexSha256: '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc' });
const report = { classification: 'insufficient-evidence', summary: 'Synthetic relay result.', facts: [], hypotheses: [],
  answerDraft: 'More evidence is needed.', questions: [], suggestions: [], limitations: ['Synthetic model only.'] };
const sse = (text = JSON.stringify(report), metadata: unknown = { nested: ['synthetic', true, 7] }): string => {
  const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: 'resp_synthetic', object: 'response', model: config.model, status: 'completed', output: [item],
    access_programs: { cyber: 'standard' }, unfamiliar_metadata: metadata };
  return [{ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item },
    { type: 'response.completed', sequence_number: 2, response }].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
};
const prepare = (context?: TestContext): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-relay-adapter-'))); chmodSync(directory, 0o700);
  const cleanup = (): void => {
    const unlock = (path: string): void => { if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); } };
    unlock(directory); rmSync(directory, { recursive: true, force: true });
  };
  if (context) context.after(cleanup); else after(cleanup);
  return directory;
};
let dispatch: ReadonlyRelayDispatch;
before(async () => {
  const directory = prepare();
  const source = await collectReadonlyPayload(await prepareReadonlyRepository(directory, randomUUID()), defaultReadonlySelection(),
    { ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
  const payload = createReadonlyRelayPayload(source, 'codex-chatgpt-relay-v1', config);
  dispatch = { requestEnvelope: payload.requestEnvelope, requestEnvelopeHash: payload.requestEnvelopeHash, requestBodyHash: payload.requestBodyHash };
});
const send = (broker: ReadonlyRelayBroker, capability = broker.capability, body = JSON.stringify({ model: config.model, stream: true,
  input: 'PRIVATE_CHILD_BODY', tools: [{ type: 'shell' }], headers: { Authorization: 'PRIVATE_CHILD_HEADER' } })) =>
  fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${capability}` }, body });

test('relay broker checks approval before authentication and dispatch, forwarding only immutable approved bytes once', async () => {
  const order: string[] = []; const raw = sse();
  const broker = await startReadonlyRelayBroker(config, dispatch, async () => { order.push('credential'); return credential; },
    new AbortController().signal, async (approved, authentication) => {
      order.push('transport'); assert.equal(approved.requestEnvelope.body, dispatch.requestEnvelope.body);
      assert.equal(Object.isFrozen(approved.requestEnvelope), true); assert.equal(Object.isFrozen(authentication), true); return new Response(Buffer.from(raw));
    }, () => { order.push('dispatch-guard'); }, () => { order.push('credential-guard'); });
  try {
    assert.equal((await send(broker, 'wrong-capability')).status, 403); assert.deepEqual(order, []);
    const response = await send(broker); assert.equal(response.status, 200); assert.equal(await response.text(), raw);
    assert.deepEqual(order, ['credential-guard', 'credential', 'dispatch-guard', 'transport']);
    assert.equal(broker.calls(), 1); assert.equal(broker.result()?.responseHash, hashReadonlyValue(raw));
    assert.equal(broker.result()?.relayCompleted, true); broker.verifyFinalText(JSON.stringify(report));
    assert.throws(() => broker.verifyFinalText(JSON.stringify({ summary: credential.accessToken })));
    assert.equal((await send(broker)).status, 403); assert.equal(broker.calls(), 1);
  } finally { await broker.close(); }
});

test('relay credential and dispatch guards independently reject expiry with no upstream call', async () => {
  for (const beforeCredential of [true, false]) {
    let loads = 0; let calls = 0;
    const broker = await startReadonlyRelayBroker(config, dispatch, async () => { loads++; return credential; }, new AbortController().signal,
      async () => { calls++; return new Response(Buffer.from(sse())); }, () => { if (!beforeCredential) throw new Error('expired'); },
      () => { if (beforeCredential) throw new Error('expired'); });
    try { const response = await send(broker); assert.equal(response.status, 502); await response.text();
      assert.equal(loads, beforeCredential ? 0 : 1); assert.equal(calls, 0); assert.equal(broker.calls(), 0); }
    finally { await broker.close(); }
  }
});

test('relay rejects credential reflection before child response bytes and never retries upstream failures', async () => {
  for (const upstream of [() => new Response(Buffer.from(sse(JSON.stringify(report), { reflected: credential.accessToken }))),
    () => new Response('PRIVATE_ERROR_BODY', { status: 302, headers: { Location: 'https://other.invalid' } }),
    () => new Response('PRIVATE_ERROR_BODY', { status: 401 }), () => new Response('PRIVATE_ERROR_BODY', { status: 429 }),
    () => new Response('PRIVATE_ERROR_BODY', { status: 500 })]) {
    let calls = 0;
    const broker = await startReadonlyRelayBroker(config, dispatch, async () => credential, new AbortController().signal,
      async () => { calls++; return upstream(); }, () => {}, () => {});
    try {
      const response = await send(broker); assert.equal(response.status, 502);
      assert.doesNotMatch(await response.text(), /synthetic\.test\.only|PRIVATE_ERROR_BODY|response\.created/);
      assert.equal(calls, 1); assert.equal(broker.result(), null); assert.match(broker.failure()!, /^READONLY_RELAY_[A-Z_]+$/u);
      assert.equal((await send(broker)).status, 403); assert.equal(calls, 1);
    } finally { await broker.close(); }
  }
});

test('native relay preserves uncertain upstream cancellation as BLOCKED even when the CLI exits with an error', { skip, timeout: 60000 }, async (context) => {
  const directory = prepare(context); const selected = nativeConfig(); const id = randomUUID();
  const now = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  const source = await collectReadonlyPayload(await prepareReadonlyRepository(directory, id), defaultReadonlySelection(), now);
  const payload = createReadonlyRelayPayload(source, 'codex-chatgpt-relay-v1', selected); const plan = createReadonlyRelayPlan(payload, now, selected);
  let calls = 0; let cancellations = 0;
  const adapter = new RestrictedReadonlyRelayCodex(selected, directory, id, { credential, transport: async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({ cancel: () => { cancellations++; throw new Error('PRIVATE_CANCELLATION_CANARY'); } }), { status: 401 });
  } });
  const store = new SqliteReadonlyRelayStore(join(directory, 'readonly-relay.sqlite'));
  try {
    store.create(plan, payload, now);
    const service = new ReadonlyRelayService(store, adapter, directory, selected, (taskId, hashes) => readonlyRelayCleanupConfirmed(directory, taskId, hashes));
    const request = { investigationId: id, planHash: plan.planHash }; service.approve({ ...request, expiresInMinutes: 5 }, now);
    const blocked = await service.run(request, now);
    assert.equal(blocked.task.status, 'BLOCKED'); assert.equal(blocked.task.failureCode, 'READONLY_RELAY_RECOVERY_UNCERTAIN');
    assert.equal(blocked.report, null); assert.equal(calls, 1); assert.equal(cancellations, 1); assert.ok(blocked.approvals[0]?.usedAt);
    await assert.rejects(service.run(request, now)); assert.equal(calls, 1);
  } finally { store.close(); }
  await assertReadonlyRepository(source.repository);
  const audit = JSON.parse(readFileSync(join(directory, 'readonly-relay-runs', id, 'call-report.json'), 'utf8'));
  assert.equal(audit.cleanupConfirmed, false); assert.equal(audit.failureCode, 'READONLY_RELAY_LIFECYCLE_UNSAFE');
  assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_CANCELLATION_CANARY|synthetic\.test\.only/);
});

test('relay reserves concurrent requests once and rejects malformed or oversized requests before credentials', async () => {
  let calls = 0;
  const broker = await startReadonlyRelayBroker(config, dispatch, async () => credential, new AbortController().signal,
    async () => { calls++; return new Response(Buffer.from(sse())); }, () => {}, () => {});
  try { const results = await Promise.all([send(broker), send(broker)]);
    assert.deepEqual(results.map((value) => value.status).sort(), [200, 403]); await Promise.all(results.map((value) => value.text())); assert.equal(calls, 1); }
  finally { await broker.close(); }
  for (const body of ['{', '{}', 'x'.repeat(256 * 1024 + 1)]) {
    let loads = 0;
    const denied = await startReadonlyRelayBroker(config, dispatch, async () => { loads++; return credential; }, new AbortController().signal,
      async () => { throw new Error('must not call'); }, () => {}, () => {});
    try { assert.ok((await send(denied, denied.capability, body)).status >= 400); assert.equal(loads, 0); }
    finally { await denied.close(); }
  }
});

test('relay raw header limits count discarded cookies and reject duplicates and control characters', () => {
  assert.equal(selectReadonlyRelayResponseHeaders(['Set-Cookie', 'synthetic=one', 'Set-Cookie', 'synthetic=two']).has('set-cookie'), false);
  for (const values of [['a'], ['X-Test', 'one', 'x-test', 'two'], ['X-Test', 'bad\rvalue'], ['bad:name', 'value'],
    ['X-Test', 'a'.repeat(16385)], Array.from({ length: 65 }, () => ['Set-Cookie', 'synthetic=bounded']).flat()]) {
    assert.throws(() => selectReadonlyRelayResponseHeaders(values));
  }
});

test('relay rejects missing fake transport and tampered approval without authentication or fallback', async () => {
  await assert.rejects(startReadonlyRelayBroker(config, dispatch, async () => credential, new AbortController().signal,
    undefined as unknown as ReadonlyRelayTransport, () => {}, () => {}), /READONLY_RELAY_INVALID_TRANSPORT/);
  await assert.rejects(startReadonlyRelayBroker(config, { ...dispatch, requestBodyHash: 'b'.repeat(64) }, async () => credential,
    new AbortController().signal, async () => new Response(sse()), () => {}, () => {}));
  await assert.rejects(new RestrictedReadonlyRelayCodex({ ...config, enabled: false }, '/synthetic', randomUUID()).verifyReady(), /READONLY_RELAY_DISABLED/);
});

test('relay idle allowance is separate while old CLI arguments remain unchanged', () => {
  const legacy = { ...config, policyVersion: 'codex-cli-proposal-v1' as const };
  const previous = codexProposalArguments(legacy, '/synthetic', 12345);
  const next = readonlyRelayCodexArguments(legacy, '/synthetic', 12345);
  assert.deepEqual(next, previous.map((argument) => argument === 'model_providers.harness.stream_idle_timeout_ms=30000'
    ? 'model_providers.harness.stream_idle_timeout_ms=55000' : argument));
  assert.ok(previous.includes('model_providers.harness.request_max_retries=0'));
  assert.ok(previous.includes('model_providers.harness.stream_idle_timeout_ms=30000'));
});

test('native relay service enforces approval and persists distinct raw and final proofs without claiming metadata validation', { skip, timeout: 60000 }, async (context) => {
  const directory = prepare(context); const id = randomUUID(); const selected = nativeConfig(); const now = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  const source = await collectReadonlyPayload(await prepareReadonlyRepository(directory, id), defaultReadonlySelection(), now);
  const payload = createReadonlyRelayPayload(source, 'codex-chatgpt-relay-v1', selected); const plan = createReadonlyRelayPlan(payload, now, selected);
  const raw = sse(); let calls = 0;
  const adapter = new RestrictedReadonlyRelayCodex(selected, directory, id, { credential, transport: async (approved) => {
    calls++; assert.equal(approved.requestEnvelope.body, payload.requestBody); return new Response(Buffer.from(raw));
  } });
  const store = new SqliteReadonlyRelayStore(join(directory, 'readonly-relay.sqlite'));
  try {
    store.create(plan, payload, now);
    const service = new ReadonlyRelayService(store, adapter, directory, selected, (taskId, hashes) => readonlyRelayCleanupConfirmed(directory, taskId, hashes));
    const request = { investigationId: id, planHash: plan.planHash };
    await assert.rejects(service.run(request, now), /READONLY_RELAY_APPROVAL_REQUIRED/); assert.equal(calls, 0);
    service.approve({ ...request, expiresInMinutes: 5 }, now);
    const completed = await service.run(request, now);
    assert.equal(completed.task.status, 'REPORTED', completed.task.failureCode ?? 'missing report'); assert.equal(calls, 1);
    assert.deepEqual(completed.report?.result, report);
    assert.equal(completed.report?.responseHash, hashReadonlyValue(raw)); assert.equal(completed.report?.finalTextHash, hashReadonlyValue(JSON.stringify(report)));
    assert.deepEqual(completed.report?.unverifiedResponseChecks, READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS);
    assert.deepEqual(completed.report?.contractVerified, { profile: 'passed', envelope: 'passed', cliOutput: 'passed', evidence: 'passed' });
    assert.equal(completed.report?.checks.realModel, 'not_run'); assert.equal(completed.report?.verification.credentialAccess, 'not_run');
    await assert.rejects(service.run(request, now)); assert.equal(calls, 1);
  } finally { store.close(); }
  await assertReadonlyRepository(source.repository);
  const audit = JSON.parse(readFileSync(join(directory, 'readonly-relay-runs', id, 'call-report.json'), 'utf8'));
  assert.equal(audit.cleanupConfirmed, true); assert.equal(audit.upstreamCalls, 1); assert.equal(audit.relay.relayCompleted, true);
  assert.equal(audit.credentialAccess, 'not_run'); assert.doesNotMatch(JSON.stringify(audit), /synthetic\.test\.only|unfamiliar_metadata/);
  assert.throws(() => lstatSync(join(directory, 'readonly-relay-runs', id, 'sandbox')), { code: 'ENOENT' });
});

test('native relay rejects reflected credentials, malformed final JSON and invented citations with no retry', { skip, timeout: 60000 }, async (context) => {
  const directory = prepare(context); const selected = nativeConfig();
  for (const kind of ['reflection', 'invalid-json', 'citation'] as const) {
    const id = randomUUID(); const now = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
    const source = await collectReadonlyPayload(await prepareReadonlyRepository(directory, id), defaultReadonlySelection(), now);
    const payload = createReadonlyRelayPayload(source, 'codex-chatgpt-relay-v1', selected); const plan = createReadonlyRelayPlan(payload, now, selected);
    const text = kind === 'invalid-json' ? '{"commands":["PRIVATE_COMMAND_CANARY"]}' : JSON.stringify(kind === 'citation'
      ? { ...report, classification: 'inquiry', facts: [{ text: 'Invented evidence.', references: [{ evidenceId: `evidence-${'f'.repeat(64)}`, startLine: 1, endLine: 1 }] }] } : report);
    let calls = 0;
    const adapter = new RestrictedReadonlyRelayCodex(selected, directory, id, { credential,
      transport: async () => { calls++; return new Response(Buffer.from(sse(text, kind === 'reflection' ? { value: credential.accessToken } : null))); } });
    const store = new SqliteReadonlyRelayStore(join(directory, 'readonly-relay.sqlite'));
    try {
      store.create(plan, payload, now);
      const service = new ReadonlyRelayService(store, adapter, directory, selected, (taskId, hashes) => readonlyRelayCleanupConfirmed(directory, taskId, hashes));
      const request = { investigationId: id, planHash: plan.planHash }; service.approve({ ...request, expiresInMinutes: 5 }, now);
      const failed = await service.run(request, now); assert.equal(failed.task.status, 'FAILED', kind); assert.equal(failed.report, null);
      assert.equal(calls, 1); assert.ok(failed.approvals[0]?.usedAt); await assert.rejects(service.run(request, now)); assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_COMMAND_CANARY|synthetic\.test\.only/);
    } finally { store.close(); }
    await assertReadonlyRepository(source.repository);
    const audit = JSON.parse(readFileSync(join(directory, 'readonly-relay-runs', id, 'call-report.json'), 'utf8'));
    assert.equal(audit.cleanupConfirmed, true); assert.equal(audit.upstreamCalls, 1); assert.equal(audit.credentialAccess, 'not_run');
    assert.throws(() => lstatSync(join(directory, 'readonly-relay-runs', id, 'sandbox')), { code: 'ENOENT' });
  }
});
