import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, realpathSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareReadonlyRepository, collectReadonlyPayload } from '../src/adapters/readonly-repository.js';
import { READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS, type ReadonlyRelayConfig } from '../src/domain/readonly-relay.js';
import { buildReadonlyMockResponse, defaultReadonlySelection } from '../src/policy/readonly-investigation-policy.js';
import { createReadonlyLivePayload, createReadonlyLivePlan } from '../src/policy/readonly-live-policy.js';
import { assertReadonlyRelayDispatch, assertReadonlyRelayPlan, createReadonlyRelayPayload, createReadonlyRelayPlan,
  getReadonlyRelayProfile, getReadonlyRelayProfileHash, parseReadonlyRelayConfig, parseReadonlyRelayResult,
  validateReadonlyRelayPayload } from '../src/policy/readonly-relay-policy.js';

const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v1', codexPath: '/synthetic/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const remove = async (directory: string): Promise<void> => {
  chmodSync(directory, 0o700);
  for (const item of await readdir(directory, { withFileTypes: true })) if (item.isDirectory()) await remove(join(directory, item.name));
  await rm(directory, { recursive: true, force: true });
};
const setup = async () => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'readonly-relay-policy-'))); chmodSync(directory, 0o700);
  const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date() };
  const repository = await prepareReadonlyRepository(directory, randomUUID());
  const source = await collectReadonlyPayload(repository, defaultReadonlySelection(), context);
  const payload = createReadonlyRelayPayload(source, 'codex-chatgpt-relay-v1', config);
  const plan = createReadonlyRelayPlan(payload, context, config);
  return { directory, context, source, payload, plan, close: () => remove(directory) };
};

test('relay request bytes retain the reviewed synthetic input while profile, serializer and approvals are separate', async () => {
  const h = await setup();
  try {
    const oldConfig = { ...config, policyVersion: 'readonly-live-codex-v9' as const };
    const oldPayload = createReadonlyLivePayload(h.source, 'codex-chatgpt-sse-v9', oldConfig);
    const oldPlan = createReadonlyLivePlan(oldPayload, h.context, oldConfig);
    assert.equal(h.payload.inputText, oldPayload.inputText); assert.equal(h.payload.requestBody, oldPayload.requestBody);
    assert.equal(h.plan.requestBodyHash, oldPlan.requestBodyHash); assert.notEqual(h.plan.connectionProfileHash, oldPlan.connectionProfileHash);
    assert.notEqual(h.plan.planHash, oldPlan.planHash); assert.equal(h.plan.policy, 'synthetic-readonly-relay-v1');
    assert.equal(h.plan.serializerVersion, 'readonly-relay-json-v1'); assert.equal(h.plan.transport, 'codex-cli-relay');
    assert.deepEqual(h.plan.writeAllowedFiles, []); assert.deepEqual(h.plan.testCommandIds, []); assert.equal(h.plan.executionAllowed, false);
    assert.throws(() => assertReadonlyRelayPlan(oldPlan as unknown as typeof h.plan));
    assert.throws(() => validateReadonlyRelayPayload(h.plan, oldPayload as unknown as typeof h.payload));
    assertReadonlyRelayDispatch({ requestEnvelope: h.payload.requestEnvelope, requestBodyHash: h.payload.requestBodyHash,
      requestEnvelopeHash: h.payload.requestEnvelopeHash }, config);
  } finally { await h.close(); }
});

test('relay config rejects old versions, endpoint/model overrides and unexpected properties', () => {
  assert.deepEqual(parseReadonlyRelayConfig(config), config);
  for (const mutation of [{ policyVersion: 'readonly-live-codex-v9' }, { policyVersion: 'readonly-relay-codex-v3' },
    { model: 'other' }, { authMode: 'api-key' }, { codexPath: '/synthetic/../codex' }, { timeoutMs: 60001 },
    { url: 'https://other.invalid' }, { maxResponseBytes: 16385 }]) {
    assert.throws(() => parseReadonlyRelayConfig({ ...config, ...mutation }), { code: 'READONLY_RELAY_INVALID_CONFIG' });
  }
});

test('relay profile binds buffering, credential guards and explicitly unverified response checks without accepting profile overrides', () => {
  const profile = getReadonlyRelayProfile('codex-chatgpt-relay-v1', config);
  assert.equal(profile.responseValidation, 'codex-native-output-v1');
  assert.equal(profile.authentication.guardPolicy, 'dispatch-and-credential-guard-v1');
  assert.equal(profile.credentialReflectionPolicy, 'bounded-credential-reflection-v1');
  assert.equal(profile.responseForwarding, 'after-eof-and-credential-check');
  assert.deepEqual(profile.unverifiedResponseChecks, READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS);
  const originalHash = getReadonlyRelayProfileHash('codex-chatgpt-relay-v1', config);
  profile.unverifiedResponseChecks.providerMetadata = 'not_inspected'; profile.limits.responseBytes = 1;
  assert.equal(getReadonlyRelayProfileHash('codex-chatgpt-relay-v1', config), originalHash);
  assert.equal(Object.isFrozen(READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS), true);
  assert.throws(() => getReadonlyRelayProfile('codex-chatgpt-sse-v9' as never, config));
});

test('relay rejects changed payload/body/envelope, write scope and a configuration change after planning', async () => {
  const h = await setup();
  try {
    for (const change of [(p: typeof h.payload) => { p.requestBody += ' '; },
      (p: typeof h.payload) => { p.inputText += ' '; }, (p: typeof h.payload) => { p.requestEnvelope.url = 'https://other.invalid' as never; },
      (p: typeof h.payload) => { p.transferEvidenceIds.pop(); }, (p: typeof h.payload) => { p.profileId = 'codex-chatgpt-sse-v9' as never; }]) {
      const changed = structuredClone(h.payload); change(changed);
      assert.throws(() => validateReadonlyRelayPayload(h.plan, changed, config));
    }
    const changedPlan = structuredClone(h.plan); changedPlan.executionAllowed = true as never;
    assert.throws(() => assertReadonlyRelayPlan(changedPlan));
    assert.throws(() => validateReadonlyRelayPayload(h.plan, h.payload, { ...config, enabled: false }));
  } finally { await h.close(); }
});

test('relay final JSON validation rejects invented citations, extra execution fields, malformed JSON and secrets', async () => {
  const h = await setup();
  try {
    const raw = buildReadonlyMockResponse(h.payload.inputText);
    const result = parseReadonlyRelayResult(raw, h.payload); assert.equal(result.transport, 'codex-cli-relay');
    const invalid = JSON.parse(raw) as { facts: { references: { evidenceId: string; startLine: number }[] }[] };
    invalid.facts[0]!.references[0]!.evidenceId = 'evidence-' + '0'.repeat(64);
    const wrongLine = JSON.parse(raw) as typeof invalid; wrongLine.facts[0]!.references[0]!.startLine = 999;
    for (const bad of [JSON.stringify(invalid), JSON.stringify(wrongLine), raw.slice(0, -1),
      JSON.stringify({ ...JSON.parse(raw), executionAllowed: true }), raw.replace('summary', 'summary","summary'),
      JSON.stringify({ ...JSON.parse(raw), answerDraft: 'sk-' + 'synthetic'.repeat(6) })]) {
      assert.throws(() => parseReadonlyRelayResult(bad, h.payload), { code: 'READONLY_RELAY_INVALID_RESPONSE' });
    }
  } finally { await h.close(); }
});
