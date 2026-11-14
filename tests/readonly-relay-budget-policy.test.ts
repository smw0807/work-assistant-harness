import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareReadonlyRepository, collectReadonlyPayload } from '../src/adapters/readonly-repository.js';
import { SqliteReadonlyRelayStore } from '../src/adapters/sqlite-readonly-relay-store.js';
import { ReadonlyRelayService } from '../src/application/investigate-relay.js';
import type { ReadonlyRelayConfig, ReadonlyRelayPlan } from '../src/domain/readonly-relay.js';
import { defaultReadonlySelection, getReadonlyRequest } from '../src/policy/readonly-investigation-policy.js';
import { assertReadonlyRelayDispatch, assertReadonlyRelayPlan, createReadonlyRelayPayload, createReadonlyRelayPlan,
  getReadonlyRelayConfig, getReadonlyRelayConfigHash, getReadonlyRelayLimits, getReadonlyRelayProfile,
  getReadonlyRelayProfileHash, getReadonlyRelayProfileId, hashReadonlyRelayConfig, hashReadonlyRelayEnvelope,
  hashReadonlyRelayPlan, parseReadonlyRelayConfig, READONLY_RELAY_LIMITS, READONLY_RELAY_V2_LIMITS,
  READONLY_RELAY_V2_RESPONSE_BYTES, validateReadonlyRelayPayload } from '../src/policy/readonly-relay-policy.js';
import type { ReadonlyRelayPort, ReadonlyRelaySnapshot } from '../src/ports/readonly-relay.js';

const v1: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v1', codexPath: '/synthetic/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const v2: ReadonlyRelayConfig = { ...v1, policyVersion: 'readonly-relay-codex-v2' };
// Recorded from the pre-budget source, after verifying its emitted JS was byte-identical to the installed build.
const v1Golden = Object.freeze({
  rawConfigHash: '35923d03f95638594802b166dbd6122837e3b8678eba2639136da9f982757dfa',
  profileHash: '38fb48473357ca3b403ce883df9024c8a2bf84c5e6363c1945a1a5f202cfeae8',
  configHash: 'd0043ce3015e032963473ea994c52354578811996bb15449471a682f1f19be35',
  envelopeHash: '1e79d8777992d11d80a6c75222ddb5bd2481340d07a3b4f487c86e2d2ae1ba77',
  planHash: '5dd6b357378ff2d76d40b8a48cc1175545ad6b74ee6eac55271b8edbff7d20aa',
  bodyHash: 'bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe',
});
const oldLimits = Object.freeze({ files: 8, ranges: 16, linesPerRange: 200, fileBytes: 32768, evidenceBytes: 65536,
  inputBytes: 131072, outputBytes: 16384, calls: 1, timeoutSeconds: 60, requestBytes: 262144, responseBytes: 262144,
  envelopeBytes: 278528, headerBytes: 8192, headers: 32, frameBytes: 65536, frames: 2048,
  responseTimeoutMs: 55000, cleanupTimeoutMs: 5000, stderrBytes: 16384, responseHeaderBytes: 16384, responseHeaders: 64 });
const remove = async (directory: string): Promise<void> => {
  chmodSync(directory, 0o700);
  for (const item of await readdir(directory, { withFileTypes: true })) if (item.isDirectory()) await remove(join(directory, item.name));
  await rm(directory, { recursive: true, force: true });
};
const setup = async () => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'readonly-relay-budget-policy-'))); chmodSync(directory, 0o700);
  const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date(Date.now() + 10000) };
  const source = await collectReadonlyPayload(await prepareReadonlyRepository(directory, randomUUID()), defaultReadonlySelection(), context);
  const payload1 = createReadonlyRelayPayload(source, 'codex-chatgpt-relay-v1', v1);
  const payload2 = createReadonlyRelayPayload(source, 'codex-chatgpt-relay-v2', v2);
  const plan1 = createReadonlyRelayPlan(payload1, context, v1); const plan2 = createReadonlyRelayPlan(payload2, context, v2);
  return { directory, context, payload1, payload2, plan1, plan2, close: () => remove(directory) };
};

const goldenPlan = (requestBodyHash: string, requestEnvelopeHash: string): ReadonlyRelayPlan => {
  const request = getReadonlyRequest('flow-question', 1);
  const fields: Omit<ReadonlyRelayPlan, 'planHash'> = {
    id: '11111111-1111-1111-1111-111111111111', ownerId: 'os-user:501', policy: 'synthetic-readonly-relay-v1', fixtureId: 'flow',
    repoId: 'synthetic-flow-v1', baseCommit: '771f50f53f04fedb1a043c50654c0236e42cdd06',
    sourceManifestHash: 'a'.repeat(64), repositoryIdentityHash: 'b'.repeat(64), requestId: request.id,
    requestRevision: request.revision, requestHash: request.hash, readAllowedFiles: ['src/controller.ts'],
    readRanges: [{ path: 'src/controller.ts', startLine: 1, endLine: 6 }], transferEvidenceIds: ['evidence-' + 'c'.repeat(64)],
    writeAllowedFiles: [], testCommandIds: [], executionAllowed: false, contextHash: 'd'.repeat(64), inputHash: 'e'.repeat(64),
    requestBodyHash, requestEnvelopeHash, ...getReadonlyRelayConfig('codex-chatgpt-relay-v1', v1),
    configHash: getReadonlyRelayConfigHash('codex-chatgpt-relay-v1', v1),
    createdAt: '2026-11-14T00:00:00.000Z', expiresAt: '2026-11-15T00:00:00.000Z',
  };
  return { ...fields, planHash: hashReadonlyRelayPlan(fields) };
};

test('budget support preserves the frozen relay v1 config, limits, profile, wire body, envelope and plan hashes', async () => {
  const h = await setup();
  try {
    assert.equal(hashReadonlyRelayConfig(v1), v1Golden.rawConfigHash);
    assert.equal(getReadonlyRelayProfileHash('codex-chatgpt-relay-v1', v1), v1Golden.profileHash);
    assert.equal(getReadonlyRelayConfigHash('codex-chatgpt-relay-v1', v1), v1Golden.configHash);
    assert.deepEqual(READONLY_RELAY_LIMITS, oldLimits); assert.deepEqual(getReadonlyRelayLimits('codex-chatgpt-relay-v1'), oldLimits);
    assert.equal(h.payload1.requestBodyHash, v1Golden.bodyHash); assert.equal(Buffer.byteLength(h.payload1.requestBody), 8897);
    assert.equal(hashReadonlyRelayEnvelope(h.payload1.requestEnvelope), v1Golden.envelopeHash);
    const plan = goldenPlan(h.payload1.requestBodyHash, h.payload1.requestEnvelopeHash);
    assert.equal(plan.planHash, v1Golden.planHash); assertReadonlyRelayPlan(plan, v1);
    const legacy = getReadonlyRelayProfile('codex-chatgpt-relay-v1', v1);
    assert.equal(Object.hasOwn(legacy, 'receptionDiagnosticsPolicy'), false); assert.equal(Object.hasOwn(legacy, 'responseBudgetPolicy'), false);
  } finally { await h.close(); }
});

test('v2 binds the selected 4MiB wire-response budget and static reception diagnostics without widening other limits', () => {
  assert.equal(getReadonlyRelayProfileId(v1), 'codex-chatgpt-relay-v1'); assert.equal(getReadonlyRelayProfileId(v2), 'codex-chatgpt-relay-v2');
  assert.deepEqual(parseReadonlyRelayConfig(v2), v2);
  assert.equal(READONLY_RELAY_V2_RESPONSE_BYTES, 4 * 1024 * 1024);
  const limits = getReadonlyRelayLimits('codex-chatgpt-relay-v2');
  assert.deepEqual(limits, { ...oldLimits, responseBytes: READONLY_RELAY_V2_RESPONSE_BYTES });
  assert.deepEqual(READONLY_RELAY_V2_LIMITS, limits); assert.equal(Object.isFrozen(READONLY_RELAY_V2_LIMITS), true);
  const profile = getReadonlyRelayProfile('codex-chatgpt-relay-v2', v2);
  assert.equal(profile.responseBudgetPolicy, 'finite-whole-response-v1');
  assert.equal(profile.receptionDiagnosticsPolicy, 'readonly-relay-reception-v1');
  assert.equal(profile.encoderVersion, 'readonly-relay-json-v1');
  assert.equal(profile.responseForwarding, 'after-eof-and-credential-check');
  assert.deepEqual(profile.credentialReflectionLimits, { prefixStateLimit: 64, jsonDepth: 16 });
  limits.responseBytes = 1;
  assert.equal(getReadonlyRelayLimits('codex-chatgpt-relay-v2').responseBytes, READONLY_RELAY_V2_RESPONSE_BYTES);
  assert.equal(getReadonlyRelayLimits('codex-chatgpt-relay-v1').responseBytes, 256 * 1024);
  for (const change of [{ responseBytes: 8 * 1024 * 1024 }, { maxResponseBytes: 2 * 1024 * 1024 },
    { policyVersion: 'readonly-relay-codex-v3' }, { model: 'other' }, { authMode: 'api-key' }, { timeoutMs: 120000 }]) {
    assert.throws(() => parseReadonlyRelayConfig({ ...v2, ...change }), { code: 'READONLY_RELAY_INVALID_CONFIG' });
  }
  assert.throws(() => getReadonlyRelayLimits('other' as never), { code: 'READONLY_RELAY_INVALID_PROFILE' });
});

test('v1 and v2 share input bytes but reject mismatched profile/config/payload/dispatch approval bindings', async () => {
  const h = await setup();
  try {
    assert.equal(h.payload1.requestBody, h.payload2.requestBody); assert.equal(h.payload1.inputText, h.payload2.inputText);
    assert.equal(h.plan1.requestBodyHash, h.plan2.requestBodyHash); assert.equal(h.plan1.inputHash, h.plan2.inputHash);
    assert.notEqual(h.plan1.configHash, h.plan2.configHash); assert.notEqual(h.plan1.connectionProfileHash, h.plan2.connectionProfileHash);
    assert.notEqual(h.plan1.requestEnvelopeHash, h.plan2.requestEnvelopeHash); assert.notEqual(h.plan1.planHash, h.plan2.planHash);
    for (const [plan, payload, config] of [[h.plan1, h.payload1, v1], [h.plan2, h.payload2, v2]] as const) {
      assertReadonlyRelayPlan(plan, config); validateReadonlyRelayPayload(plan, payload, config);
      assertReadonlyRelayDispatch({ requestEnvelope: payload.requestEnvelope, requestBodyHash: payload.requestBodyHash,
        requestEnvelopeHash: payload.requestEnvelopeHash }, config);
    }
    assert.throws(() => getReadonlyRelayProfile('codex-chatgpt-relay-v1', v2));
    assert.throws(() => getReadonlyRelayProfile('codex-chatgpt-relay-v2', v1));
    assert.throws(() => assertReadonlyRelayPlan(h.plan1, v2)); assert.throws(() => assertReadonlyRelayPlan(h.plan2, v1));
    assert.throws(() => validateReadonlyRelayPayload(h.plan1, h.payload2, v1));
    assert.throws(() => validateReadonlyRelayPayload(h.plan2, h.payload1, v2));
    assert.throws(() => assertReadonlyRelayDispatch({ requestEnvelope: h.payload1.requestEnvelope,
      requestBodyHash: h.payload1.requestBodyHash, requestEnvelopeHash: h.payload1.requestEnvelopeHash }, v2));
    const tampered = structuredClone(h.plan1); tampered.limits.responseBytes = READONLY_RELAY_V2_RESPONSE_BYTES;
    assert.throws(() => assertReadonlyRelayPlan(tampered, v1));
  } finally { await h.close(); }
});

test('stored v1/v2 approvals stay separate across service configuration changes and restart, with zero fake transmissions', async () => {
  const h = await setup(); let store = new SqliteReadonlyRelayStore(join(h.directory, 'readonly-relay.sqlite')); let calls = 0;
  const port: ReadonlyRelayPort = { mode: 'live', transport: 'codex-cli-relay', transmit: async () => { calls++; throw new Error('must remain local'); } };
  const service = (config: ReadonlyRelayConfig) => new ReadonlyRelayService(store, port, h.directory, config);
  const request = (plan: ReadonlyRelaySnapshot) => ({ investigationId: plan.task.investigationId, planHash: plan.task.plan.planHash });
  try {
    const first = await service(v1).plan('flow', undefined, h.context); const second = await service(v2).plan('flow', undefined, h.context);
    assert.throws(() => service(v2).approve({ ...request(first), expiresInMinutes: 10 }, h.context));
    assert.throws(() => service(v1).approve({ ...request(second), expiresInMinutes: 10 }, h.context));
    assert.equal(store.inspect(first.task.investigationId, h.context).approvals.length, 0);
    assert.equal(store.inspect(second.task.investigationId, h.context).approvals.length, 0);
    service(v1).approve({ ...request(first), expiresInMinutes: 10 }, h.context);
    service(v2).approve({ ...request(second), expiresInMinutes: 10 }, h.context);
    await assert.rejects(service(v2).run(request(first), h.context)); await assert.rejects(service(v1).run(request(second), h.context));
    assert.throws(() => store.claim({ investigationId: first.task.investigationId, planHash: second.task.plan.planHash }, h.context),
      { code: 'READONLY_RELAY_PLAN_HASH_MISMATCH' });
    store.close(); store = new SqliteReadonlyRelayStore(join(h.directory, 'readonly-relay.sqlite'));
    for (const plan of [first, second]) {
      const current = store.inspect(plan.task.investigationId, h.context);
      assert.equal(current.task.status, 'APPROVED'); assert.equal(current.approvals.length, 1);
      assert.equal(current.approvals[0]!.usedAt, null); assert.equal(current.attempt, null);
    }
    assert.equal(calls, 0);
  } finally { store.close(); await h.close(); }
});

test('the existing example stays disabled v1 and the separate bounded-budget example is disabled v2', () => {
  const original = parseReadonlyRelayConfig(JSON.parse(readFileSync(join(process.cwd(), 'config/readonly-relay.example.json'), 'utf8')));
  const budget = parseReadonlyRelayConfig(JSON.parse(readFileSync(join(process.cwd(), 'config/readonly-relay-budget.example.json'), 'utf8')));
  assert.equal(original.enabled, false); assert.equal(original.policyVersion, 'readonly-relay-codex-v1');
  assert.equal(budget.enabled, false); assert.equal(budget.policyVersion, 'readonly-relay-codex-v2');
  assert.equal(budget.model, original.model); assert.equal(budget.authMode, original.authMode);
  assert.equal(budget.maxResponseBytes, 16384); assert.equal(budget.timeoutMs, 60000);
});
