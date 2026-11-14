import assert from 'node:assert/strict';
import { chmodSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteReadonlyRelayStore } from '../src/adapters/sqlite-readonly-relay-store.js';
import { assertReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { ReadonlyRelayService } from '../src/application/investigate-relay.js';
import { READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS, type ReadonlyRelayConfig, type ReadonlyRelayDispatch } from '../src/domain/readonly-relay.js';
import { buildReadonlyMockResponse, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import type { ReadonlyRelayPort, ReadonlyRelaySnapshot, ReadonlyRelayTransmissionResult } from '../src/ports/readonly-relay.js';

const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v1', codexPath: '/synthetic/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const respond = (request: ReadonlyRelayDispatch): ReadonlyRelayTransmissionResult => {
  const body = JSON.parse(request.requestEnvelope.body) as { input: { content: { text: string }[] }[] };
  const text = buildReadonlyMockResponse(body.input[0]!.content[0]!.text);
  return { text, responseHash: hashReadonlyValue('synthetic raw SSE bytes'), finalTextHash: hashReadonlyValue(text),
    verification: { transport: 'fake', upstreamCalls: 1, isolation: 'not_run', credentialAccess: 'not_run',
      responseValidation: 'codex-native-output-v1', relayCompleted: true, credentialReflection: 'passed' } };
};
const request = (snapshot: ReadonlyRelaySnapshot) => ({ investigationId: snapshot.task.investigationId, planHash: snapshot.task.plan.planHash });
const remove = async (directory: string): Promise<void> => {
  chmodSync(directory, 0o700);
  for (const item of await readdir(directory, { withFileTypes: true })) if (item.isDirectory()) await remove(join(directory, item.name));
  await rm(directory, { recursive: true, force: true });
};
const setup = async (port?: ReadonlyRelayPort, cleanupConfirmed = true) => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'readonly-relay-workflow-'))); chmodSync(directory, 0o700);
  const file = join(directory, 'readonly-relay.sqlite'); let store = new SqliteReadonlyRelayStore(file);
  const received: ReadonlyRelayDispatch[] = [];
  const model: ReadonlyRelayPort = port ?? { mode: 'live', transport: 'codex-cli-relay', transmit: async (input, _signal, before, beforeCredential) => {
    beforeCredential(); before(); received.push(input); return respond(input);
  } };
  let service = new ReadonlyRelayService(store, model, directory, config, () => cleanupConfirmed);
  const ctx = { ownerId: `os-user:${process.getuid!()}`, now: new Date(Date.now() + 10000) };
  return { directory, file, ctx, received, get store() { return store; }, get service() { return service; },
    reopen: () => { store.close(); store = new SqliteReadonlyRelayStore(file); service = new ReadonlyRelayService(store, model, directory, config, () => cleanupConfirmed); },
    close: async () => { store.close(); await remove(directory); } };
};

test('relay waits for its own approval, forwards reviewed bytes once and persists accurate response checks after restart', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx, 'controller');
    await assert.rejects(h.service.run(request(plan), h.ctx), { code: 'READONLY_RELAY_APPROVAL_REQUIRED' }); assert.equal(h.received.length, 0);
    const approval = h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.ctx);
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt), 600000);
    const done = await h.service.run(request(plan), h.ctx); assert.equal(done.task.status, 'REPORTED'); assert.equal(h.received.length, 1);
    assert.deepEqual(h.received[0]!.requestEnvelope, plan.payload!.requestEnvelope);
    assert.equal(done.attempt!.finalTextHash, done.report!.finalTextHash); assert.equal(done.attempt!.responseHash, done.report!.responseHash);
    assert.deepEqual(done.report!.contractVerified, { profile: 'passed', envelope: 'passed', cliOutput: 'passed', evidence: 'passed' });
    assert.deepEqual(done.report!.unverifiedResponseChecks, READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS);
    assert.equal(done.report!.checks.realModel, 'not_run'); assert.equal(done.report!.semanticAccuracyVerified, false);
    await assertReadonlyRepository(plan.payload!.repository);
    h.reopen(); assert.deepEqual(h.service.inspect(plan.task.investigationId, h.ctx).report, done.report);
    await assert.rejects(h.service.run(request(plan), h.ctx), { code: 'READONLY_RELAY_APPROVAL_REQUIRED' }); assert.equal(h.received.length, 1);
  } finally { await h.close(); }
});

test('relay consumes one approval under concurrent runs and never retries a failed response', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.ctx);
    const results = await Promise.allSettled([h.service.run(request(plan), h.ctx), h.service.run(request(plan), h.ctx)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(h.received.length, 1);
    const state = h.service.inspect(plan.task.investigationId, h.ctx); assert.ok(state.approvals[0]!.usedAt); assert.ok(state.attempt?.dispatchedAt);
  } finally { await h.close(); }
});

for (const mutation of ['hash', 'reflection', 'relay-complete', 'provider-proof', 'live-proof'] as const) {
  test(`relay rejects invalid ${mutation} attestation and retains consumed approval`, async () => {
    let calls = 0;
    const h = await setup({ mode: 'live', transport: 'codex-cli-relay', transmit: async (input, _signal, before) => {
      before(); calls++; const result = respond(input);
      if (mutation === 'hash') result.finalTextHash = '0'.repeat(64);
      if (mutation === 'reflection') result.verification.credentialReflection = 'not_run' as never;
      if (mutation === 'relay-complete') result.verification.relayCompleted = false as never;
      if (mutation === 'provider-proof') Object.assign(result.verification, { providerMetadata: 'passed' });
      if (mutation === 'live-proof') result.verification.transport = 'live';
      return result;
    } });
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.ctx);
      const done = await h.service.run(request(plan), h.ctx); assert.equal(done.task.status, 'FAILED'); assert.equal(done.report, null);
      assert.equal(done.task.failureCode, 'READONLY_RELAY_INVALID_RESPONSE'); assert.ok(done.approvals[0]!.usedAt);
      await assert.rejects(h.service.run(request(plan), h.ctx)); assert.equal(calls, 1);
    } finally { await h.close(); }
  });
}

test('relay rechecks fresh TTL before credentials and again before network without restoring the claim', async (t) => {
  for (const stage of ['credentials', 'network'] as const) {
    let fakeCredentialReads = 0; let fakeNetworkCalls = 0; let now = Date.now() + 10000;
    t.mock.method(Date, 'now', () => now);
    const h = await setup({ mode: 'live', transport: 'codex-cli-relay', transmit: async (input, _signal, before, beforeCredential) => {
      if (stage === 'credentials') now += 120000;
      beforeCredential(); fakeCredentialReads++;
      if (stage === 'network') now += 120000;
      before(); fakeNetworkCalls++; return respond(input);
    } });
    try {
      now = h.ctx.now.getTime(); const plan = await h.service.plan('flow', undefined, h.ctx); h.service.approve({ ...request(plan), expiresInMinutes: 1 }, h.ctx);
      const done = await h.service.run(request(plan), h.ctx); assert.equal(done.task.status, 'FAILED'); assert.equal(done.task.failureCode, 'READONLY_RELAY_EXPIRED');
      assert.equal(fakeCredentialReads, stage === 'credentials' ? 0 : 1); assert.equal(fakeNetworkCalls, 0);
      assert.ok(done.approvals[0]!.usedAt); assert.ok(done.attempt); assert.equal(done.report, null);
    } finally { await h.close(); t.mock.restoreAll(); }
  }
});

test('relay local readiness failure does not claim an approval or invoke any credential/network guard', async () => {
  let transmissions = 0;
  const h = await setup({ mode: 'live', transport: 'codex-cli-relay', verifyReady: async () => { throw new Error('synthetic unavailable'); },
    transmit: async () => { transmissions++; throw new Error('unexpected'); } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.ctx);
    await assert.rejects(h.service.run(request(plan), h.ctx)); const state = h.service.inspect(plan.task.investigationId, h.ctx);
    assert.equal(state.task.status, 'APPROVED'); assert.equal(state.attempt, null); assert.equal(state.approvals[0]!.usedAt, null); assert.equal(transmissions, 0);
  } finally { await h.close(); }
});

test('relay cancellation blocks late results and survives restart with consumed approval', async () => {
  let started!: () => void; const entered = new Promise<void>(r => { started = r; });
  const h = await setup({ mode: 'live', transport: 'codex-cli-relay', transmit: async (input, signal, before) => {
    before(); started(); await new Promise<void>(r => { signal.addEventListener('abort', () => r(), { once: true }); }); return respond(input);
  } });
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.ctx);
    const pending = h.service.run(request(plan), h.ctx); await entered; h.service.cancel(plan.task.investigationId, h.ctx);
    const done = await pending; assert.equal(done.task.status, 'CANCELLED'); assert.equal(done.report, null); assert.ok(done.approvals[0]!.usedAt);
    h.reopen(); const recovered = await h.service.recover(plan.task.investigationId, h.ctx); assert.equal(recovered.task.status, 'CANCELLED');
    await assert.rejects(h.service.run(request(plan), h.ctx));
  } finally { await h.close(); }
});

for (const confirmed of [false, true]) {
  test(`relay restart recovery preserves consumption and ${confirmed ? 'confirms interruption' : 'blocks uncertain cleanup'}`, async () => {
    const h = await setup(undefined, confirmed);
    try {
      const plan = await h.service.plan('flow', undefined, h.ctx); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.ctx);
      const attempt = h.store.claim(request(plan), h.ctx); h.store.dispatch(plan.task.investigationId, attempt.generation, h.ctx, () => undefined);
      h.reopen(); const done = await h.service.recover(plan.task.investigationId, h.ctx);
      assert.equal(done.task.status, confirmed ? 'INTERRUPTED' : 'BLOCKED'); assert.ok(done.approvals[0]!.usedAt); assert.equal(done.report, null);
      await assert.rejects(h.service.run(request(plan), h.ctx)); assert.equal(h.received.length, 0);
    } finally { await h.close(); }
  });
}

test('relay retention removes payloads and audits without removing the consumed marker', async () => {
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.ctx);
    const done = await h.service.run(request(plan), h.ctx); const future = { ...h.ctx, now: new Date(Date.parse(done.task.terminalAt!) + 31 * 86400000) };
    assert.deepEqual(h.store.prune(future), { payloadsRemoved: 1, auditsRemoved: 1 });
    assert.throws(() => h.store.create(plan.task.plan, plan.payload!, h.ctx), { code: 'READONLY_RELAY_ID_REUSED' });
  } finally { await h.close(); }
});

test('relay store refuses legacy databases before schema writes and rejects persisted false verification claims', async () => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'readonly-relay-foreign-'))); chmodSync(directory, 0o700);
  const foreign = join(directory, 'readonly-relay.sqlite'); const raw = new DatabaseSync(foreign);
  raw.exec('CREATE TABLE readonly_live_markers (id TEXT)'); raw.close(); chmodSync(foreign, 0o600); const before = hashReadonlyValue(readFileSync(foreign));
  assert.throws(() => new SqliteReadonlyRelayStore(foreign), { code: 'READONLY_RELAY_INVALID_STORE' });
  assert.equal(hashReadonlyValue(readFileSync(foreign)), before);
  assert.throws(() => new SqliteReadonlyRelayStore(join(directory, 'readonly-live.sqlite')), { code: 'UNSAFE_RUNTIME_PATH' });
  await remove(directory);
  const h = await setup();
  try {
    const plan = await h.service.plan('flow', undefined, h.ctx); h.service.approve({ ...request(plan), expiresInMinutes: 10 }, h.ctx); await h.service.run(request(plan), h.ctx);
    const db = new DatabaseSync(h.file); const row = db.prepare('SELECT payload FROM readonly_relay_payloads').get()!;
    const record = JSON.parse(String(row.payload)); record.report.unverifiedResponseChecks.providerMetadata = 'passed';
    const body = JSON.stringify(record); db.prepare('UPDATE readonly_relay_payloads SET payload=?,payload_hash=?').run(body, hashReadonlyValue(body)); db.close();
    assert.throws(() => h.service.inspect(plan.task.investigationId, h.ctx), { code: 'READONLY_RELAY_INVALID_RECORD' });
  } finally { await h.close(); }
});
