import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RestrictedReadonlyRelayCodex } from '../src/adapters/readonly-relay-codex.js';
import { readonlyRelayCleanupConfirmed } from '../src/adapters/readonly-relay-lifecycle.js';
import { assertReadonlyRepository, collectReadonlyPayload, prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { SqliteReadonlyRelayStore } from '../src/adapters/sqlite-readonly-relay-store.js';
import { ReadonlyRelayService } from '../src/application/investigate-relay.js';
import type { ReadonlyRelayConfig, ReadonlyRelayProfileId } from '../src/domain/readonly-relay.js';
import { createReadonlyRelayCapacityFixture } from '../src/policy/readonly-relay-capacity-fixtures.js';
import { copyReadonlyRelayReceptionDiagnostic } from '../src/policy/readonly-relay-reception-diagnostics.js';
import { createReadonlyRelayPayload, createReadonlyRelayPlan, getReadonlyRelayLimits } from '../src/policy/readonly-relay-policy.js';
import { defaultReadonlySelection, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const skip = process.platform === 'darwin' && process.env.HARNESS_NATIVE_CODEX_PROBE === '1' ? false : 'native macOS probe opt-in required';
const credential = { kind: 'chatgpt' as const, accessToken: 'synthetic.test.only', accountId: 'synthetic-account' };
const nativeConfig = (version: 'v1' | 'v2'): ReadonlyRelayConfig => ({ enabled: true, policyVersion: `readonly-relay-codex-${version}`,
  codexPath: process.env.HARNESS_NATIVE_CODEX_PATH ?? '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex',
  codexSha256: '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc',
  model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 });
const legacyCallReportKeys = ['policy', 'model', 'authMode', 'binaryHash', 'phase', 'requestBodyHash', 'requestEnvelopeHash',
  'connectionProfileHash', 'responseValidation', 'unverifiedResponseChecks', 'isolation', 'credentialAccess', 'transport',
  'upstreamCalls', 'cleanupConfirmed', 'http', 'relay', 'finalTextHash', 'failureCode'];
const prepare = (context: TestContext, beforeRemove: () => void): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-relay-budget-adapter-'))); chmodSync(directory, 0o700);
  context.after(() => {
    beforeRemove();
    const unlock = (path: string): void => {
      if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); }
    };
    unlock(directory); rmSync(directory, { recursive: true, force: true });
  });
  return directory;
};
const upstream = (body: Buffer) => {
  const observation = { deliveredBytes: 0, eof: false, cancellations: 0 };
  return { observation, response: new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (observation.deliveredBytes === body.length) { observation.eof = true; controller.close(); return; }
    const end = Math.min(body.length, observation.deliveredBytes + 16384);
    controller.enqueue(body.subarray(observation.deliveredBytes, end)); observation.deliveredBytes = end;
  }, cancel() { observation.cancellations++; } }), { headers: { 'Content-Type': 'text/event-stream' } }) };
};
const setup = async (context: TestContext, version: 'v1' | 'v2') => {
  const connection: { store: SqliteReadonlyRelayStore | null } = { store: null };
  const directory = prepare(context, () => connection.store?.close()); const id = randomUUID(); const config = nativeConfig(version);
  const now = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  const source = await collectReadonlyPayload(await prepareReadonlyRepository(directory, id), defaultReadonlySelection(), now);
  const profile = `codex-chatgpt-relay-${version}` as ReadonlyRelayProfileId;
  const payload = createReadonlyRelayPayload(source, profile, config); const plan = createReadonlyRelayPlan(payload, now, config);
  const fixture = createReadonlyRelayCapacityFixture('stress-metadata');
  assert.ok(fixture.bodyBytes > 256 * 1024 && fixture.bodyBytes < 4 * 1024 * 1024);
  assert.ok(fixture.maxFrameBytes <= 64 * 1024 && fixture.frames <= 2048 && fixture.finalBytes <= 16384);
  const transport = upstream(fixture.body); let calls = 0;
  const adapter = new RestrictedReadonlyRelayCodex(config, directory, id, { credential, transport: async (approved) => {
    calls++; assert.equal(approved.requestEnvelope.body, payload.requestBody);
    return transport.response;
  } });
  const store = new SqliteReadonlyRelayStore(join(directory, 'readonly-relay.sqlite')); connection.store = store;
  store.create(plan, payload, now);
  const service = new ReadonlyRelayService(store, adapter, directory, config,
    (taskId, hashes) => readonlyRelayCleanupConfirmed(directory, taskId, hashes));
  const request = { investigationId: id, planHash: plan.planHash }; service.approve({ ...request, expiresInMinutes: 5 }, now);
  return { directory, id, now, source, payload, fixture, transport, service, request, calls: () => calls };
};
const assertCleanup = async (harness: Awaited<ReturnType<typeof setup>>) => {
  await assertReadonlyRepository(harness.source.repository);
  const run = join(harness.directory, 'readonly-relay-runs', harness.id);
  const child = JSON.parse(readFileSync(join(run, 'child.json'), 'utf8'));
  assert.equal(child.state, 'closed');
  for (const pid of [child.guardianPid, child.childPid, -child.childPid]) {
    assert.ok(Number.isSafeInteger(pid) && Math.abs(pid) > 1); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  assert.throws(() => lstatSync(join(run, 'sandbox')), { code: 'ENOENT' });
  assert.equal(readonlyRelayCleanupConfirmed(harness.directory, harness.id, {
    requestBodyHash: harness.payload.requestBodyHash, requestEnvelopeHash: harness.payload.requestEnvelopeHash,
    connectionProfileHash: harness.payload.connectionProfileHash,
  }), true);
  const path = join(run, 'call-report.json'); assert.equal(lstatSync(path).mode & 0o777, 0o600);
  const audit = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(audit.transport, 'fake'); assert.equal(audit.credentialAccess, 'not_run');
  assert.equal(audit.cleanupConfirmed, true); assert.equal(audit.upstreamCalls, 1);
  assert.doesNotMatch(JSON.stringify(audit), /synthetic\.test\.only|synthetic-account|opaque_padding|resp_capacity_synthetic|msg_capacity_synthetic/);
  return audit;
};

test('native relay v2 accepts the large synthetic metadata stream and records current EOF counters with a valid final result', { skip, timeout: 60000 }, async (context) => {
  assert.equal(getReadonlyRelayLimits('codex-chatgpt-relay-v2').responseBytes, 4 * 1024 * 1024);
  const harness = await setup(context, 'v2');
  const completed = await harness.service.run(harness.request, harness.now);
  assert.equal(completed.task.status, 'REPORTED', completed.task.failureCode ?? 'missing report'); assert.equal(harness.calls(), 1);
  assert.deepEqual(completed.report?.result, JSON.parse(harness.fixture.finalText));
  assert.equal(completed.report?.responseHash, hashReadonlyValue(harness.fixture.body));
  assert.equal(completed.report?.finalTextHash, hashReadonlyValue(harness.fixture.finalText));
  assert.equal(completed.report?.verification.transport, 'fake'); assert.equal(completed.report?.checks.realModel, 'not_run');
  assert.equal(completed.report?.verification.credentialAccess, 'not_run'); assert.ok(completed.approvals[0]?.usedAt);
  assert.equal(harness.transport.observation.eof, true); assert.equal(harness.transport.observation.cancellations, 0);
  const audit = await assertCleanup(harness);
  assert.deepEqual(Object.keys(audit).sort(), [...legacyCallReportKeys, 'reception'].sort());
  assert.deepEqual(copyReadonlyRelayReceptionDiagnostic(audit.reception), {
    receivedBytes: harness.fixture.bodyBytes, bufferedBytes: harness.fixture.bodyBytes, inspectedBytes: harness.fixture.bodyBytes,
    chunks: Math.ceil(harness.fixture.bodyBytes / 16384), maxChunkBytes: 16384,
    completedFrames: harness.fixture.frames, maxFrameBytes: harness.fixture.maxFrameBytes, partialFrameBytes: 0,
    eof: true, termination: 'eof', failedLimit: 'none',
  });
  assert.equal(audit.relay.relayCompleted, true); assert.equal(audit.relay.bodyBytes, harness.fixture.bodyBytes); assert.equal(audit.failureCode, null);
  await assert.rejects(harness.service.run(harness.request, harness.now)); assert.equal(harness.calls(), 1);
});

test('native relay v1 rejects the same large stream before EOF and preserves the existing call-report shape', { skip, timeout: 60000 }, async (context) => {
  assert.equal(getReadonlyRelayLimits('codex-chatgpt-relay-v1').responseBytes, 256 * 1024);
  const harness = await setup(context, 'v1');
  const failed = await harness.service.run(harness.request, harness.now);
  assert.equal(failed.task.status, 'FAILED'); assert.equal(failed.report, null); assert.equal(failed.attempt?.responseHash, null);
  assert.equal(failed.attempt?.finalTextHash, null); assert.ok(failed.approvals[0]?.usedAt); assert.equal(harness.calls(), 1);
  assert.equal(harness.transport.observation.eof, false); assert.equal(harness.transport.observation.cancellations, 1);
  assert.ok(harness.transport.observation.deliveredBytes < harness.fixture.bodyBytes);
  const audit = await assertCleanup(harness);
  assert.deepEqual(Object.keys(audit).sort(), [...legacyCallReportKeys].sort()); assert.equal(Object.hasOwn(audit, 'reception'), false);
  assert.equal(audit.failureCode, 'READONLY_RELAY_RESPONSE_LIMIT'); assert.equal(audit.relay, null); assert.equal(audit.finalTextHash, null);
  await assert.rejects(harness.service.run(harness.request, harness.now)); assert.equal(harness.calls(), 1);
});
