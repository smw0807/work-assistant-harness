import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { collectReadonlyPayload, prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { SqliteReadonlyLiveStore } from '../src/adapters/sqlite-readonly-live-store.js';
import { ReadonlyLiveService } from '../src/application/investigate-live.js';
import type { ReadonlyPayload } from '../src/domain/readonly-investigation.js';
import type { ReadonlyLiveConfig, ReadonlyLiveDispatch, ReadonlyLivePayload, ReadonlyLivePlan, ReadonlyLiveProfileId } from '../src/domain/readonly-live.js';
import { READONLY_LIVE_RESPONSE_EXTENSION_LIMITS } from '../src/domain/readonly-live.js';
import type { ReadonlyModelPreflightPlan } from '../src/domain/readonly-model-preflight.js';
import { canonicalReadonlyJson, defaultReadonlySelection, hashReadonlyValue, selectReadonlyTransfer } from '../src/policy/readonly-investigation-policy.js';
import { assertReadonlyModelPreflightPlan, createReadonlyModelPreflightPayload, createReadonlyModelPreflightPlan } from '../src/policy/readonly-model-preflight-policy.js';
import { assertReadonlyLiveDispatch, assertReadonlyLivePlan, assertReadonlyLiveRequestBody, buildReadonlyLiveRequestBody, createReadonlyLivePayload,
  createReadonlyLivePlan, getReadonlyLiveConfigHash, getReadonlyLiveProfile, getReadonlyLiveProfileHash, getReadonlyLiveProfileId, hashReadonlyLiveConfig,
  hashReadonlyLiveEnvelope, hashReadonlyLivePlan, parseReadonlyLiveConfig, parseReadonlyLiveResult,
  normalizeReadonlyLiveHeaders, validateReadonlyLivePayload } from '../src/policy/readonly-live-policy.js';
import { getReadonlyLiveHttpLimits } from '../src/policy/readonly-live-protocol.js';

const config: ReadonlyLiveConfig = { enabled: true, policyVersion: 'readonly-live-codex-v1', codexPath: '/opt/synthetic/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const profileId = 'codex-chatgpt-sse-v1';
const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
let directory: string; let source: ReadonlyPayload; let payload: ReadonlyLivePayload; let plan: ReadonlyLivePlan;
before(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-live-policy-'))); chmodSync(directory, 0o700);
  source = await collectReadonlyPayload(await prepareReadonlyRepository(directory, randomUUID()), defaultReadonlySelection(), context);
  payload = createReadonlyLivePayload(source, profileId, config); plan = createReadonlyLivePlan(payload, context, config);
});
after(() => {
  const unlock = (path: string): void => { if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); } };
  if (directory) { unlock(directory); rmSync(directory, { recursive: true, force: true }); }
});
const dispatch = (): ReadonlyLiveDispatch => ({ requestEnvelope: structuredClone(payload.requestEnvelope),
  requestEnvelopeHash: payload.requestEnvelopeHash, requestBodyHash: payload.requestBodyHash });

test('live config is exact, pinned, credential-free and canonically hashed', () => {
  assert.deepEqual(parseReadonlyLiveConfig(config), config);
  assert.deepEqual(parseReadonlyLiveConfig({ ...config, enabled: false }), { ...config, enabled: false });
  assert.equal(hashReadonlyLiveConfig(config), hashReadonlyLiveConfig(Object.fromEntries(Object.entries(config).reverse()) as unknown as ReadonlyLiveConfig));
  for (const [key, value] of Object.entries({ policyVersion: 'codex-cli-proposal-v1', model: 'gpt-other', authMode: 'api-key',
    enabled: 1, timeoutMs: 59999, maxResponseBytes: 8192, codexPath: '/opt/../codex', codexSha256: 'bad', credential: 'synthetic' })) {
    assert.throws(() => parseReadonlyLiveConfig({ ...config, [key]: value }), key);
  }
  for (const path of ['relative/codex', '/opt//codex', '/opt/codex/', '/opt/codex\n', '/opt/./codex']) assert.throws(() => parseReadonlyLiveConfig({ ...config, codexPath: path }));
  for (const malformed of [null, [], {}, undefined]) assert.throws(() => parseReadonlyLiveConfig(malformed));
});

test('live profiles bind the entire executable config, endpoint and parent-only authentication policy', () => {
  const profile = getReadonlyLiveProfile(profileId, config);
  assert.equal(profile.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(profile.authentication, { mode: 'chatgpt', location: 'trusted-parent', headers: ['Authorization', 'ChatGPT-Account-ID'] });
  assert.equal(profile.headers.length, 5); assert.equal(profile.stream, true); assert.equal(profile.retries, 0);
  const originalHash = getReadonlyLiveProfileHash(profileId, config);
  profile.headers.push(['authorization', 'synthetic']); profile.configSnapshot.codexSha256 = 'b'.repeat(64);
  assert.equal(getReadonlyLiveProfileHash(profileId, config), originalHash);
  for (const change of [{ enabled: false }, { codexPath: '/opt/another/codex' }, { codexSha256: 'b'.repeat(64) }]) {
    assert.notEqual(getReadonlyLiveProfileHash(profileId, { ...config, ...change }), originalHash);
  }
  for (const bad of ['responses-candidate-sse-v1', 'live', 'codex-chatgpt-json-v1']) assert.throws(() => getReadonlyLiveProfile(bad as ReadonlyLiveProfileId, config));
});

test('v1 approval hashes remain stable while v2 independently binds the larger response budget', () => {
  const configV2: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v2' };
  const profileV2 = 'codex-chatgpt-sse-v2';
  const payloadV2 = createReadonlyLivePayload(source, profileV2, configV2);
  const planV2 = createReadonlyLivePlan(payloadV2, context, configV2);
  assert.equal(plan.limits.headers, 32); assert.equal(plan.limits.headerBytes, 8192);
  assert.equal('responseHeaders' in plan.limits, false); assert.equal('responseHeaderBytes' in plan.limits, false);
  assert.equal(planV2.limits.headers, 32); assert.equal(planV2.limits.headerBytes, 8192);
  assert.equal(planV2.limits.responseHeaders, 64); assert.equal(planV2.limits.responseHeaderBytes, 16384);
  assert.equal(planV2.limits.responseHeaders, getReadonlyLiveHttpLimits(profileV2).headersCount);
  assert.equal(planV2.limits.responseHeaderBytes, getReadonlyLiveHttpLimits(profileV2).headersBytes);
  assert.equal(payloadV2.requestBody, payload.requestBody);
  assert.equal(hashReadonlyValue(buildReadonlyLiveRequestBody('synthetic input', profileId, config)),
    '0fe866c7423900326ae246b9f9f3de8e28c0b8992106c920843d4392b77f5aa1');
  assert.equal(hashReadonlyValue(buildReadonlyLiveRequestBody('synthetic input', profileV2, configV2)),
    '0fe866c7423900326ae246b9f9f3de8e28c0b8992106c920843d4392b77f5aa1');
  assert.equal(getReadonlyLiveProfileHash(profileId, config), '9ab335b40d37a3210a70c09c04b7d0a76ec2a011006db220a186700af2d1526a');
  assert.equal(getReadonlyLiveConfigHash(profileId, config), '4db42085516c53b5bd4f04572de183122585d9cd43d095a5788a277e7f2ecd2f');
  assert.notEqual(plan.connectionProfileHash, planV2.connectionProfileHash);
  assert.notEqual(plan.configHash, planV2.configHash); assert.notEqual(plan.planHash, planV2.planHash);
  assertReadonlyLivePlan(plan); validateReadonlyLivePayload(plan, payload);
  assertReadonlyLivePlan(planV2); validateReadonlyLivePayload(planV2, payloadV2);
  assert.throws(() => getReadonlyLiveProfile(profileId, configV2));
  assert.throws(() => getReadonlyLiveProfile(profileV2, config));
  assert.throws(() => validateReadonlyLivePayload(plan, payload, configV2));
  assert.throws(() => validateReadonlyLivePayload(planV2, payloadV2, config));
  const priorShape = structuredClone(planV2);
  delete (priorShape.limits as unknown as Record<string, unknown>).responseHeaders;
  delete (priorShape.limits as unknown as Record<string, unknown>).responseHeaderBytes;
  priorShape.planHash = hashReadonlyLivePlan(priorShape);
  assert.throws(() => assertReadonlyLivePlan(priorShape));
  const changedV1 = { ...plan, limits: { ...plan.limits, responseHeaders: 64, responseHeaderBytes: 16384 } };
  changedV1.planHash = hashReadonlyLivePlan(changedV1); assert.throws(() => assertReadonlyLivePlan(changedV1));
});

test('v3 binds the new decoder and cookie discard policy without changing old approval hashes or request bytes', () => {
  const configs: ReadonlyLiveConfig[] = [config, { ...config, policyVersion: 'readonly-live-codex-v2' }, { ...config, policyVersion: 'readonly-live-codex-v3' }];
  const plans = configs.map((item) => createReadonlyLivePlan(createReadonlyLivePayload(source, getReadonlyLiveProfileId(item), item), context, item));
  const profiles = configs.map((item) => getReadonlyLiveProfile(getReadonlyLiveProfileId(item), item));
  const normalizedPlanHash = (item: ReadonlyLivePlan): string => hashReadonlyLivePlan({ ...item,
    id: '00000000-0000-4000-8000-000000000001', ownerId: 'os-user:0', repositoryIdentityHash: '1'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z' });
  assert.equal(normalizedPlanHash(plans[0]!), '001df29ee51775f4db795d0d91f7c140127e74060b3255b8c5fbb5756b21ea90');
  assert.equal(normalizedPlanHash(plans[1]!), 'db9d7e0e370a5b51bb1ed217d790b2f48ea3780bf80554a30c191e904b594867');
  assert.equal(normalizedPlanHash(plans[2]!), '4f197feea02dcbf336afb0c5d633c4598d5b0d5a69db4e57aef27adb29aa261a');
  assert.equal(plans[0]!.connectionProfileHash, '9ab335b40d37a3210a70c09c04b7d0a76ec2a011006db220a186700af2d1526a');
  assert.equal(plans[0]!.configHash, '4db42085516c53b5bd4f04572de183122585d9cd43d095a5788a277e7f2ecd2f');
  assert.equal(plans[1]!.connectionProfileHash, '148ab325189b8b96db551d9d3cba8038e3181dae41013904f12716b703d73d57');
  assert.equal(plans[1]!.configHash, '1a04a9b3249e2bfd3f0b8b27ccb862fef75e3ef7b882dd48a9508c3e730acbcf');
  assert.equal(plans[2]!.connectionProfileHash, '9e7aa783d1c1c10d387234fdba04058cb780ac7ac66aa84aba35a200440557fd');
  assert.equal(plans[2]!.configHash, '47ef856d3c21b35bdde0771b01ebd682c9de9468e40d3e1bf8c44fb07cdc9f58');
  assert.deepEqual(plans[2]!.limits, plans[1]!.limits);
  assert.deepEqual(profiles.map((item) => item.decoderVersion), ['readonly-live-response-v1', 'readonly-live-response-v1', 'readonly-live-response-v2']);
  assert.equal('responseHeaderPolicy' in profiles[0]!, false); assert.equal('responseHeaderPolicy' in profiles[1]!, false);
  assert.equal(profiles[2]!.responseHeaderPolicy, 'discard-set-cookie-v1');
  for (const key of ['configHash', 'connectionProfileHash', 'requestEnvelopeHash', 'planHash'] as const) assert.equal(new Set(plans.map((item) => item[key])).size, 3);
  for (const item of configs) {
    const body = buildReadonlyLiveRequestBody(payload.inputText, getReadonlyLiveProfileId(item), item);
    assert.equal(body, payload.requestBody); assert.equal(Buffer.byteLength(body), 8897);
    assert.equal(hashReadonlyValue(body), 'bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe');
    const request = assertReadonlyLiveRequestBody(body, item);
    assert.deepEqual(request.tools, []); assert.equal(request.model, 'gpt-6.1-sol');
  }
});

test('v4 binds HTTP token normalization without changing v3 request content or limits', () => {
  const configV3: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v3' };
  const configV4: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v4' };
  const profileV3 = getReadonlyLiveProfile('codex-chatgpt-sse-v3', configV3);
  const profileV4 = getReadonlyLiveProfile('codex-chatgpt-sse-v4', configV4);
  assert.equal(profileV4.decoderVersion, 'readonly-live-response-v3');
  assert.equal(profileV4.responseHeaderPolicy, 'http-token-discard-set-cookie-v1');
  assert.deepEqual(profileV4, { ...profileV3, profileId: 'codex-chatgpt-sse-v4', configSnapshot: configV4,
    decoderVersion: 'readonly-live-response-v3', responseHeaderPolicy: 'http-token-discard-set-cookie-v1' });
  const v3 = createReadonlyLivePayload(source, 'codex-chatgpt-sse-v3', configV3);
  const v4 = createReadonlyLivePayload(source, 'codex-chatgpt-sse-v4', configV4);
  const planV3 = createReadonlyLivePlan(v3, context, configV3);
  const planV4 = createReadonlyLivePlan(v4, context, configV4);
  assert.deepEqual(planV4.limits, planV3.limits);
  assert.deepEqual(v4.requestEnvelope.headers, v3.requestEnvelope.headers);
  assert.equal(v4.requestEnvelope.url, v3.requestEnvelope.url);
  assert.equal(v4.requestBody, v3.requestBody); assert.equal(Buffer.byteLength(v4.requestBody), 8897);
  assert.equal(v4.requestBodyHash, 'bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe');
  assert.equal(assertReadonlyLiveRequestBody(v4.requestBody, configV4).model, 'gpt-6.1-sol');
  for (const key of ['configHash', 'connectionProfileHash', 'requestEnvelopeHash', 'planHash'] as const) assert.notEqual(planV4[key], planV3[key]);
  assertReadonlyLivePlan(planV3); validateReadonlyLivePayload(planV3, v3);
  assertReadonlyLivePlan(planV4); validateReadonlyLivePayload(planV4, v4);
});

test('all live profile versions reject each other config snapshots and dispatch approvals', () => {
  const configs: ReadonlyLiveConfig[] = [config, { ...config, policyVersion: 'readonly-live-codex-v2' },
    { ...config, policyVersion: 'readonly-live-codex-v3' }, { ...config, policyVersion: 'readonly-live-codex-v4' },
    { ...config, policyVersion: 'readonly-live-codex-v5' }, { ...config, policyVersion: 'readonly-live-codex-v6' },
    { ...config, policyVersion: 'readonly-live-codex-v7' }, { ...config, policyVersion: 'readonly-live-codex-v8' },
    { ...config, policyVersion: 'readonly-live-codex-v9' }];
  for (const [index, item] of configs.entries()) {
    const selected = getReadonlyLiveProfileId(item);
    const candidate = createReadonlyLivePayload(source, selected, item);
    const candidatePlan = createReadonlyLivePlan(candidate, context, item);
    const candidateDispatch = { requestEnvelope: candidate.requestEnvelope, requestEnvelopeHash: candidate.requestEnvelopeHash, requestBodyHash: candidate.requestBodyHash };
    assertReadonlyLivePlan(candidatePlan); validateReadonlyLivePayload(candidatePlan, candidate); assertReadonlyLiveDispatch(candidateDispatch, item);
    for (const [otherIndex, other] of configs.entries()) {
      if (index === otherIndex) continue;
      assert.throws(() => getReadonlyLiveProfile(selected, other));
      assert.throws(() => assertReadonlyLivePlan(candidatePlan, other));
      assert.throws(() => validateReadonlyLivePayload(candidatePlan, candidate, other));
      assert.throws(() => assertReadonlyLiveDispatch(candidateDispatch, other));
      const changed = { ...candidatePlan, profileId: getReadonlyLiveProfileId(other), configSnapshot: other };
      changed.planHash = hashReadonlyLivePlan(changed); assert.throws(() => assertReadonlyLivePlan(changed));
    }
  }
  for (const policyVersion of ['readonly-live-codex-v0', 'readonly-live-codex-v10', 'codex-chatgpt-sse-v4']) {
    assert.throws(() => getReadonlyLiveProfileId({ ...config, policyVersion } as ReadonlyLiveConfig));
  }
});

test('v5 binds missing Content-Type detection while preserving every v4 request byte and limit', () => {
  const v4Config: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v4' };
  const v5Config: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v5' };
  const v4Profile = getReadonlyLiveProfile('codex-chatgpt-sse-v4', v4Config);
  const v5Profile = getReadonlyLiveProfile('codex-chatgpt-sse-v5', v5Config);
  assert.equal('responseFormatPolicy' in v4Profile, false);
  assert.deepEqual(v5Profile, { ...v4Profile, profileId: 'codex-chatgpt-sse-v5', configSnapshot: v5Config,
    decoderVersion: 'readonly-live-response-v4', responseFormatPolicy: 'content-type-or-bounded-body-v1' });
  const v4 = createReadonlyLivePayload(source, 'codex-chatgpt-sse-v4', v4Config);
  const v5 = createReadonlyLivePayload(source, 'codex-chatgpt-sse-v5', v5Config);
  const v4Plan = createReadonlyLivePlan(v4, context, v4Config);
  const v5Plan = createReadonlyLivePlan(v5, context, v5Config);
  assert.equal(v5.requestBody, v4.requestBody);
  assert.equal(v5.requestBodyHash, 'bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe');
  assert.deepEqual(v5.requestEnvelope.headers, v4.requestEnvelope.headers);
  assert.deepEqual(v5Plan.limits, v4Plan.limits);
  for (const key of ['configHash', 'connectionProfileHash', 'requestEnvelopeHash', 'planHash'] as const) assert.notEqual(v5Plan[key], v4Plan[key]);
  assertReadonlyLivePlan(v4Plan); validateReadonlyLivePayload(v4Plan, v4);
  assertReadonlyLivePlan(v5Plan); validateReadonlyLivePayload(v5Plan, v5);
});

test('v6 binds zero-only tool usage metadata while all v1-v5 profile and config hashes stay unchanged', () => {
  const previousHashes = [
    ['readonly-live-codex-v1', '9ab335b40d37a3210a70c09c04b7d0a76ec2a011006db220a186700af2d1526a', '4db42085516c53b5bd4f04572de183122585d9cd43d095a5788a277e7f2ecd2f'],
    ['readonly-live-codex-v2', '148ab325189b8b96db551d9d3cba8038e3181dae41013904f12716b703d73d57', '1a04a9b3249e2bfd3f0b8b27ccb862fef75e3ef7b882dd48a9508c3e730acbcf'],
    ['readonly-live-codex-v3', '9e7aa783d1c1c10d387234fdba04058cb780ac7ac66aa84aba35a200440557fd', '47ef856d3c21b35bdde0771b01ebd682c9de9468e40d3e1bf8c44fb07cdc9f58'],
    ['readonly-live-codex-v4', 'fc44e51181661e17c18b1cb3c7bf5764d7283987ee94b5f1fe7a6f9f1c82a6bc', '92266bc58bd0124b3527b844c70cb71ac940082b2c8f04473aee36f7860e78a8'],
    ['readonly-live-codex-v5', '4c2698baaecea57415d8ccbb57136ef864f05d4004c90dec90ffea90157df60e', '1aafdaca87136dda39dd7de315a49ede34b1481c9b1f291c24e3f1d93ff80669'],
  ] as const;
  for (const [policyVersion, profileHash, configHash] of previousHashes) {
    const previous = { ...config, policyVersion }; const id = getReadonlyLiveProfileId(previous);
    assert.equal(getReadonlyLiveProfileHash(id, previous), profileHash); assert.equal(getReadonlyLiveConfigHash(id, previous), configHash);
    assert.equal('responseMetadataPolicy' in getReadonlyLiveProfile(id, previous), false);
  }
  const v5Config: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v5' };
  const v6Config: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v6' };
  const v5Profile = getReadonlyLiveProfile(getReadonlyLiveProfileId(v5Config), v5Config);
  const v6Profile = getReadonlyLiveProfile(getReadonlyLiveProfileId(v6Config), v6Config);
  assert.deepEqual(v6Profile, { ...v5Profile, profileId: 'codex-chatgpt-sse-v6', configSnapshot: v6Config,
    decoderVersion: 'readonly-live-response-v5', responseMetadataPolicy: 'zero-tool-usage-v1' });
  const v5 = createReadonlyLivePayload(source, getReadonlyLiveProfileId(v5Config), v5Config);
  const v6 = createReadonlyLivePayload(source, getReadonlyLiveProfileId(v6Config), v6Config);
  const oldPlan = createReadonlyLivePlan(v5, context, v5Config); const newPlan = createReadonlyLivePlan(v6, context, v6Config);
  assert.equal(v6.requestBody, v5.requestBody); assert.equal(v6.requestBodyHash, v5.requestBodyHash);
  assert.deepEqual(v6.requestEnvelope.headers, v5.requestEnvelope.headers); assert.deepEqual(newPlan.limits, oldPlan.limits);
  for (const key of ['configHash', 'connectionProfileHash', 'requestEnvelopeHash', 'planHash'] as const) assert.notEqual(newPlan[key], oldPlan[key]);
  assertReadonlyLivePlan(oldPlan); validateReadonlyLivePayload(oldPlan, v5);
  assertReadonlyLivePlan(newPlan); validateReadonlyLivePayload(newPlan, v6);
  assert.throws(() => parseReadonlyLiveConfig({ ...v6Config, responseMetadataPolicy: 'zero-tool-usage-v1' }));
});

test('v6 service selects a new profile and rejects every older config or approval without consuming it', async () => {
  const store = new SqliteReadonlyLiveStore(join(directory, 'profile-selection-v6.sqlite'));
  let readinessCalls = 0; let transmissions = 0;
  const port = { mode: 'live' as const, transport: 'codex-cli-broker' as const, verifyReady: async () => { readinessCalls++; },
    transmit: async (): Promise<never> => { transmissions++; throw new Error('must not call'); } };
  const v6Config: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v6' };
  try {
    const service = new ReadonlyLiveService(store, port, directory, v6Config);
    const selected = await service.plan('flow', undefined, context);
    assert.equal(selected.task.plan.profileId, 'codex-chatgpt-sse-v6');
    const approval = { investigationId: selected.task.investigationId, planHash: selected.task.plan.planHash, expiresInMinutes: 1 };
    for (const policyVersion of ['readonly-live-codex-v1', 'readonly-live-codex-v2', 'readonly-live-codex-v3', 'readonly-live-codex-v4', 'readonly-live-codex-v5'] as const) {
      const old = new ReadonlyLiveService(store, port, directory, { ...config, policyVersion });
      assert.throws(() => old.approve(approval, context));
    }
    assert.equal(store.inspect(selected.task.investigationId, context).approvals.length, 0);
    const oldService = new ReadonlyLiveService(store, port, directory, { ...config, policyVersion: 'readonly-live-codex-v5' });
    const oldTask = await oldService.plan('flow', undefined, context);
    const oldRequest = { investigationId: oldTask.task.investigationId, planHash: oldTask.task.plan.planHash };
    oldService.approve({ ...oldRequest, expiresInMinutes: 1 }, context);
    assert.throws(() => service.approve({ ...approval, planHash: oldRequest.planHash }, context));
    await assert.rejects(service.run(oldRequest, context));
    const previous = store.inspect(oldRequest.investigationId, context);
    assert.equal(previous.task.status, 'APPROVED'); assert.equal(previous.approvals[0]!.usedAt, null); assert.equal(previous.attempt, null);
    assert.equal(service.approve(approval, context).planSnapshot.profileId, 'codex-chatgpt-sse-v6');
    assert.equal(store.inspect(selected.task.investigationId, context).attempt, null);
    assert.equal(readinessCalls, 0); assert.equal(transmissions, 0);
  } finally { store.close(); }
});

test('v7 binds only the new sequence policy while v6 hashes and request bytes remain stable', () => {
  const v6Config: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v6' };
  const v7Config: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v7' };
  const v6Id = getReadonlyLiveProfileId(v6Config); const v7Id = getReadonlyLiveProfileId(v7Config);
  assert.equal(getReadonlyLiveProfileHash(v6Id, v6Config), '5350ba3be0896d7a61e4cfd90ca5ebd31a898affbb74885257faa80855b89e83');
  assert.equal(getReadonlyLiveConfigHash(v6Id, v6Config), '7e9b563baaf3ab2d1f1b50b30d7fe4adc31508ac8fde0a890de93b0a91b54789');
  const previous = getReadonlyLiveProfile(v6Id, v6Config); const next = getReadonlyLiveProfile(v7Id, v7Config);
  assert.equal('responseSequencePolicy' in previous, false);
  assert.deepEqual(next, { ...previous, profileId: 'codex-chatgpt-sse-v7', configSnapshot: v7Config,
    decoderVersion: 'readonly-live-response-v6', responseSequencePolicy: 'zero-or-one-start-contiguous-v1' });
  const v6 = createReadonlyLivePayload(source, v6Id, v6Config); const v7 = createReadonlyLivePayload(source, v7Id, v7Config);
  const oldPlan = createReadonlyLivePlan(v6, context, v6Config); const newPlan = createReadonlyLivePlan(v7, context, v7Config);
  assert.equal(v7.requestBody, v6.requestBody); assert.equal(v7.requestBodyHash, 'bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe');
  assert.deepEqual(v7.requestEnvelope.headers, v6.requestEnvelope.headers); assert.deepEqual(newPlan.limits, oldPlan.limits);
  for (const key of ['configHash', 'connectionProfileHash', 'requestEnvelopeHash', 'planHash'] as const) assert.notEqual(newPlan[key], oldPlan[key]);
  assertReadonlyLivePlan(oldPlan); validateReadonlyLivePayload(oldPlan, v6);
  assertReadonlyLivePlan(newPlan); validateReadonlyLivePayload(newPlan, v7);
  assert.throws(() => parseReadonlyLiveConfig({ ...v7Config, responseSequencePolicy: 'zero-or-one-start-contiguous-v1' }));
});

test('v7 requires its own approval and does not consume a v6 approval', async () => {
  const store = new SqliteReadonlyLiveStore(join(directory, 'profile-selection-v7.sqlite'));
  let readinessCalls = 0; let transmissions = 0;
  const port = { mode: 'live' as const, transport: 'codex-cli-broker' as const, verifyReady: async () => { readinessCalls++; },
    transmit: async (): Promise<never> => { transmissions++; throw new Error('must not call'); } };
  try {
    const service = new ReadonlyLiveService(store, port, directory, { ...config, policyVersion: 'readonly-live-codex-v7' });
    const selected = await service.plan('flow', undefined, context);
    assert.equal(selected.task.plan.profileId, 'codex-chatgpt-sse-v7');
    const approval = { investigationId: selected.task.investigationId, planHash: selected.task.plan.planHash, expiresInMinutes: 1 };
    for (const policyVersion of ['readonly-live-codex-v1', 'readonly-live-codex-v2', 'readonly-live-codex-v3', 'readonly-live-codex-v4', 'readonly-live-codex-v5', 'readonly-live-codex-v6'] as const) {
      assert.throws(() => new ReadonlyLiveService(store, port, directory, { ...config, policyVersion }).approve(approval, context));
    }
    assert.equal(store.inspect(selected.task.investigationId, context).approvals.length, 0);
    const previousService = new ReadonlyLiveService(store, port, directory, { ...config, policyVersion: 'readonly-live-codex-v6' });
    const previous = await previousService.plan('flow', undefined, context);
    const request = { investigationId: previous.task.investigationId, planHash: previous.task.plan.planHash };
    previousService.approve({ ...request, expiresInMinutes: 1 }, context);
    assert.throws(() => service.approve({ ...approval, planHash: request.planHash }, context));
    await assert.rejects(service.run(request, context));
    const unchanged = store.inspect(request.investigationId, context);
    assert.equal(unchanged.task.status, 'APPROVED'); assert.equal(unchanged.approvals[0]!.usedAt, null); assert.equal(unchanged.attempt, null);
    assert.equal(service.approve(approval, context).planSnapshot.profileId, 'codex-chatgpt-sse-v7');
    assert.equal(store.inspect(selected.task.investigationId, context).attempt, null);
    assert.equal(readinessCalls, 0); assert.equal(transmissions, 0);
  } finally { store.close(); }
});

test('v8 binds only the created boolean extension policy while all earlier contracts remain unchanged', () => {
  const v7Config: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v7' };
  const v8Config: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v8' };
  const v7Id = getReadonlyLiveProfileId(v7Config); const v8Id = getReadonlyLiveProfileId(v8Config);
  assert.equal(getReadonlyLiveProfileHash(v7Id, v7Config), '145094ce754c4a89491f59fd9d4e58dc42afe090e03ab4b7458fa3d69fe0acc0');
  assert.equal(getReadonlyLiveConfigHash(v7Id, v7Config), '860489f9900c0e670adfc0db19932b6ae6f2c66f3e102766f1ac549ef9be4ffd');
  for (const policyVersion of ['readonly-live-codex-v1', 'readonly-live-codex-v2', 'readonly-live-codex-v3',
    'readonly-live-codex-v4', 'readonly-live-codex-v5', 'readonly-live-codex-v6', 'readonly-live-codex-v7'] as const) {
    const previousConfig = { ...config, policyVersion };
    assert.equal('responseEnvelopePolicy' in getReadonlyLiveProfile(getReadonlyLiveProfileId(previousConfig), previousConfig), false);
  }
  const previous = getReadonlyLiveProfile(v7Id, v7Config); const next = getReadonlyLiveProfile(v8Id, v8Config);
  assert.deepEqual(next, { ...previous, profileId: 'codex-chatgpt-sse-v8', configSnapshot: v8Config,
    decoderVersion: 'readonly-live-response-v7', responseEnvelopePolicy: 'created-boolean-extension-v1' });
  const v7 = createReadonlyLivePayload(source, v7Id, v7Config); const v8 = createReadonlyLivePayload(source, v8Id, v8Config);
  const oldPlan = createReadonlyLivePlan(v7, context, v7Config); const newPlan = createReadonlyLivePlan(v8, context, v8Config);
  assert.equal(v8.requestBody, v7.requestBody); assert.equal(v8.requestBodyHash, 'bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe');
  assert.deepEqual(v8.requestEnvelope.headers, v7.requestEnvelope.headers); assert.deepEqual(newPlan.limits, oldPlan.limits);
  for (const key of ['configHash', 'connectionProfileHash', 'requestEnvelopeHash', 'planHash'] as const) assert.notEqual(newPlan[key], oldPlan[key]);
  assertReadonlyLivePlan(oldPlan); validateReadonlyLivePayload(oldPlan, v7);
  assertReadonlyLivePlan(newPlan); validateReadonlyLivePayload(newPlan, v8);
  assert.throws(() => parseReadonlyLiveConfig({ ...v8Config, responseEnvelopePolicy: 'created-boolean-extension-v1' }));
  const forged = { ...newPlan, responseEnvelopePolicy: 'allow-any-extension' };
  forged.planHash = hashReadonlyLivePlan(forged); assert.throws(() => assertReadonlyLivePlan(forged));
});

test('v8 requires a new approval and cannot consume the approved v7 task', async () => {
  const store = new SqliteReadonlyLiveStore(join(directory, 'profile-selection-v8.sqlite'));
  let readinessCalls = 0; let transmissions = 0;
  const port = { mode: 'live' as const, transport: 'codex-cli-broker' as const, verifyReady: async () => { readinessCalls++; },
    transmit: async (): Promise<never> => { transmissions++; throw new Error('must not call'); } };
  try {
    const service = new ReadonlyLiveService(store, port, directory, { ...config, policyVersion: 'readonly-live-codex-v8' });
    const selected = await service.plan('flow', undefined, context);
    assert.equal(selected.task.plan.profileId, 'codex-chatgpt-sse-v8');
    const approval = { investigationId: selected.task.investigationId, planHash: selected.task.plan.planHash, expiresInMinutes: 1 };
    for (const policyVersion of ['readonly-live-codex-v1', 'readonly-live-codex-v2', 'readonly-live-codex-v3',
      'readonly-live-codex-v4', 'readonly-live-codex-v5', 'readonly-live-codex-v6', 'readonly-live-codex-v7'] as const) {
      assert.throws(() => new ReadonlyLiveService(store, port, directory, { ...config, policyVersion }).approve(approval, context));
    }
    assert.equal(store.inspect(selected.task.investigationId, context).approvals.length, 0);
    const previousService = new ReadonlyLiveService(store, port, directory, { ...config, policyVersion: 'readonly-live-codex-v7' });
    const previous = await previousService.plan('flow', undefined, context);
    const request = { investigationId: previous.task.investigationId, planHash: previous.task.plan.planHash };
    previousService.approve({ ...request, expiresInMinutes: 1 }, context);
    assert.throws(() => service.approve({ ...approval, planHash: request.planHash }, context));
    await assert.rejects(service.run(request, context));
    const unchanged = store.inspect(request.investigationId, context);
    assert.equal(unchanged.task.status, 'APPROVED'); assert.equal(unchanged.approvals[0]!.usedAt, null); assert.equal(unchanged.attempt, null);
    assert.equal(service.approve(approval, context).planSnapshot.profileId, 'codex-chatgpt-sse-v8');
    assert.equal(store.inspect(selected.task.investigationId, context).attempt, null);
    assert.equal(readinessCalls, 0); assert.equal(transmissions, 0);
  } finally { store.close(); }
});

test('v9 binds inert extension limits while all v1-v8 hashes and outgoing request bytes stay unchanged', () => {
  const previousHashes = [
    ['readonly-live-codex-v1', '9ab335b40d37a3210a70c09c04b7d0a76ec2a011006db220a186700af2d1526a', '4db42085516c53b5bd4f04572de183122585d9cd43d095a5788a277e7f2ecd2f'],
    ['readonly-live-codex-v2', '148ab325189b8b96db551d9d3cba8038e3181dae41013904f12716b703d73d57', '1a04a9b3249e2bfd3f0b8b27ccb862fef75e3ef7b882dd48a9508c3e730acbcf'],
    ['readonly-live-codex-v3', '9e7aa783d1c1c10d387234fdba04058cb780ac7ac66aa84aba35a200440557fd', '47ef856d3c21b35bdde0771b01ebd682c9de9468e40d3e1bf8c44fb07cdc9f58'],
    ['readonly-live-codex-v4', 'fc44e51181661e17c18b1cb3c7bf5764d7283987ee94b5f1fe7a6f9f1c82a6bc', '92266bc58bd0124b3527b844c70cb71ac940082b2c8f04473aee36f7860e78a8'],
    ['readonly-live-codex-v5', '4c2698baaecea57415d8ccbb57136ef864f05d4004c90dec90ffea90157df60e', '1aafdaca87136dda39dd7de315a49ede34b1481c9b1f291c24e3f1d93ff80669'],
    ['readonly-live-codex-v6', '5350ba3be0896d7a61e4cfd90ca5ebd31a898affbb74885257faa80855b89e83', '7e9b563baaf3ab2d1f1b50b30d7fe4adc31508ac8fde0a890de93b0a91b54789'],
    ['readonly-live-codex-v7', '145094ce754c4a89491f59fd9d4e58dc42afe090e03ab4b7458fa3d69fe0acc0', '860489f9900c0e670adfc0db19932b6ae6f2c66f3e102766f1ac549ef9be4ffd'],
    ['readonly-live-codex-v8', '0e1c5bf8be3c8509d498eb0d18e5156731bae97d7cc8a59ee85fb6cc7f3cc07f', '621ad7db05bc32bc8e3720c33046a89218d36d3715766dc017559394d44186f2'],
  ] as const;
  for (const [policyVersion, profileHash, configHash] of previousHashes) {
    const previousConfig = { ...config, policyVersion }; const id = getReadonlyLiveProfileId(previousConfig);
    assert.equal(getReadonlyLiveProfileHash(id, previousConfig), profileHash);
    assert.equal(getReadonlyLiveConfigHash(id, previousConfig), configHash);
    const profile = getReadonlyLiveProfile(id, previousConfig);
    assert.equal('responseExtensionPolicy' in profile, false); assert.equal('responseExtensionLimits' in profile, false);
  }
  const v8Config: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v8' };
  const v9Config: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v9' };
  const previousProfile = getReadonlyLiveProfile('codex-chatgpt-sse-v8', v8Config);
  const nextProfile = getReadonlyLiveProfile('codex-chatgpt-sse-v9', v9Config);
  const limits = { fields: 8, keyCharacters: 64, bytes: 16384, nodes: 256, depth: 8 };
  assert.deepEqual(nextProfile, { ...previousProfile, profileId: 'codex-chatgpt-sse-v9', configSnapshot: v9Config,
    decoderVersion: 'readonly-live-response-v8', responseExtensionPolicy: 'bounded-inert-json-v1', responseExtensionLimits: limits });
  assert.deepEqual(READONLY_LIVE_RESPONSE_EXTENSION_LIMITS, limits); assert.equal(Object.isFrozen(READONLY_LIVE_RESPONSE_EXTENSION_LIMITS), true);
  const v8 = createReadonlyLivePayload(source, 'codex-chatgpt-sse-v8', v8Config);
  const v9 = createReadonlyLivePayload(source, 'codex-chatgpt-sse-v9', v9Config);
  const previousPlan = createReadonlyLivePlan(v8, context, v8Config); const nextPlan = createReadonlyLivePlan(v9, context, v9Config);
  assert.equal(v9.requestBody, v8.requestBody); assert.equal(Buffer.byteLength(v9.requestBody), 8897);
  assert.equal(v9.requestBodyHash, 'bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe');
  assert.deepEqual(v9.requestEnvelope, { ...v8.requestEnvelope, profileId: 'codex-chatgpt-sse-v9', connectionProfileHash: v9.connectionProfileHash });
  assert.deepEqual(nextPlan.limits, previousPlan.limits);
  for (const key of ['configHash', 'connectionProfileHash', 'requestEnvelopeHash', 'planHash'] as const) assert.notEqual(nextPlan[key], previousPlan[key]);
  assertReadonlyLivePlan(nextPlan); validateReadonlyLivePayload(nextPlan, v9);
  for (const extra of [{ responseExtensionPolicy: 'allow-anything' }, { responseExtensionLimits: { ...limits, fields: 9 } }]) {
    assert.throws(() => parseReadonlyLiveConfig({ ...v9Config, ...extra }));
    const forged = { ...nextPlan, ...extra }; forged.planHash = hashReadonlyLivePlan(forged);
    assert.throws(() => assertReadonlyLivePlan(forged));
  }
  const pinnedHash = getReadonlyLiveProfileHash('codex-chatgpt-sse-v9', v9Config);
  Object.assign(nextProfile.responseExtensionLimits!, { fields: 9 });
  assert.equal(getReadonlyLiveProfileHash('codex-chatgpt-sse-v9', v9Config), pinnedHash);
  assert.deepEqual(READONLY_LIVE_RESPONSE_EXTENSION_LIMITS, limits);
  const changedEnvelope = { ...v9.requestEnvelope, connectionProfileHash: hashReadonlyValue(canonicalReadonlyJson(nextProfile)) };
  assert.throws(() => assertReadonlyLiveDispatch({ requestEnvelope: changedEnvelope,
    requestEnvelopeHash: hashReadonlyLiveEnvelope(changedEnvelope), requestBodyHash: v9.requestBodyHash }, v9Config));
});

test('v9 and older approvals are incompatible before readiness, claim or dispatch', async () => {
  const store = new SqliteReadonlyLiveStore(join(directory, 'profile-selection-v9.sqlite'));
  let readinessCalls = 0; let transmissions = 0;
  const port = { mode: 'live' as const, transport: 'codex-cli-broker' as const, verifyReady: async () => { readinessCalls++; },
    transmit: async (): Promise<never> => { transmissions++; throw new Error('must not call'); } };
  try {
    const service = new ReadonlyLiveService(store, port, directory, { ...config, policyVersion: 'readonly-live-codex-v9' });
    const selected = await service.plan('flow', undefined, context);
    assert.equal(selected.task.plan.profileId, 'codex-chatgpt-sse-v9');
    const request = { investigationId: selected.task.investigationId, planHash: selected.task.plan.planHash };
    for (const policyVersion of ['readonly-live-codex-v1', 'readonly-live-codex-v2', 'readonly-live-codex-v3', 'readonly-live-codex-v4',
      'readonly-live-codex-v5', 'readonly-live-codex-v6', 'readonly-live-codex-v7', 'readonly-live-codex-v8'] as const) {
      assert.throws(() => new ReadonlyLiveService(store, port, directory, { ...config, policyVersion })
        .approve({ ...request, expiresInMinutes: 1 }, context));
    }
    assert.equal(store.inspect(request.investigationId, context).approvals.length, 0);
    const previousService = new ReadonlyLiveService(store, port, directory, { ...config, policyVersion: 'readonly-live-codex-v8' });
    const previous = await previousService.plan('flow', undefined, context);
    const previousRequest = { investigationId: previous.task.investigationId, planHash: previous.task.plan.planHash };
    previousService.approve({ ...previousRequest, expiresInMinutes: 1 }, context);
    assert.throws(() => service.approve({ ...request, planHash: previousRequest.planHash, expiresInMinutes: 1 }, context));
    await assert.rejects(service.run(previousRequest, context));
    service.approve({ ...request, expiresInMinutes: 1 }, context);
    await assert.rejects(previousService.run(request, context));
    for (const id of [request.investigationId, previousRequest.investigationId]) {
      const unchanged = store.inspect(id, context);
      assert.equal(unchanged.task.status, 'APPROVED'); assert.equal(unchanged.approvals.length, 1);
      assert.equal(unchanged.approvals[0]!.usedAt, null); assert.equal(unchanged.attempt, null);
    }
    assert.equal(readinessCalls, 0); assert.equal(transmissions, 0);
  } finally { store.close(); }
});

test('live service selects v3 explicitly and cannot approve its plan with older config', async () => {
  const store = new SqliteReadonlyLiveStore(join(directory, 'profile-selection.sqlite'));
  const port = { mode: 'live' as const, transport: 'codex-cli-broker' as const, transmit: async (): Promise<never> => { throw new Error('must not call'); } };
  const configV3: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v3' };
  try {
    const service = new ReadonlyLiveService(store, port, directory, configV3);
    const selected = await service.plan('flow', undefined, context);
    assert.equal(selected.task.plan.profileId, 'codex-chatgpt-sse-v3');
    const approval = { investigationId: selected.task.investigationId, planHash: selected.task.plan.planHash, expiresInMinutes: 1 };
    for (const policyVersion of ['readonly-live-codex-v1', 'readonly-live-codex-v2'] as const) {
      const old = new ReadonlyLiveService(store, port, directory, { ...config, policyVersion });
      assert.throws(() => old.approve(approval, context));
    }
    assert.equal(store.inspect(selected.task.investigationId, context).task.status, 'AWAITING_APPROVAL');
    assert.equal(service.approve(approval, context).planSnapshot.profileId, 'codex-chatgpt-sse-v3');
    assert.equal(store.inspect(selected.task.investigationId, context).attempt, null);
  } finally { store.close(); }
});

test('live service selects v4 through the central profile map and rejects all older config approvals', async () => {
  const store = new SqliteReadonlyLiveStore(join(directory, 'profile-selection-v4.sqlite'));
  const port = { mode: 'live' as const, transport: 'codex-cli-broker' as const, transmit: async (): Promise<never> => { throw new Error('must not call'); } };
  const configV4: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v4' };
  try {
    const service = new ReadonlyLiveService(store, port, directory, configV4);
    const selected = await service.plan('flow', undefined, context);
    assert.equal(selected.task.plan.profileId, 'codex-chatgpt-sse-v4');
    const approval = { investigationId: selected.task.investigationId, planHash: selected.task.plan.planHash, expiresInMinutes: 1 };
    for (const policyVersion of ['readonly-live-codex-v1', 'readonly-live-codex-v2', 'readonly-live-codex-v3'] as const) {
      const old = new ReadonlyLiveService(store, port, directory, { ...config, policyVersion });
      assert.throws(() => old.approve(approval, context));
    }
    assert.equal(store.inspect(selected.task.investigationId, context).task.status, 'AWAITING_APPROVAL');
    assert.equal(service.approve(approval, context).planSnapshot.profileId, 'codex-chatgpt-sse-v4');
    assert.equal(store.inspect(selected.task.investigationId, context).attempt, null);
  } finally { store.close(); }
});

test('request header limits remain 32 headers and 8KiB for all profiles', () => {
  const headers: [string, string][] = Array.from({ length: 32 }, (_, index) => [`x-${index}`, 'a']);
  assert.equal(normalizeReadonlyLiveHeaders(headers).length, 32);
  assert.throws(() => normalizeReadonlyLiveHeaders([...headers, ['x-extra', 'a']]), { code: 'READONLY_LIVE_HEADER_LIMIT' });
  assert.equal(normalizeReadonlyLiveHeaders([['x', 'a'.repeat(8192 - 5)]])[0]![1].length, 8192 - 5);
  assert.throws(() => normalizeReadonlyLiveHeaders([['x', 'a'.repeat(8193 - 5)]]), { code: 'READONLY_LIVE_HEADER_LIMIT' });
});

test('old approvals and live approvals cannot cross policy boundaries', () => {
  validateReadonlyLivePayload(plan, payload, config); validateReadonlyLivePayload(plan, payload);
  assertReadonlyLivePlan(plan); assert.equal(plan.policy, 'synthetic-readonly-live-v1');
  assert.equal(plan.mode, 'live'); assert.equal(plan.responseOrigin, 'model'); assert.equal(plan.transport, 'codex-cli-broker');
  assert.deepEqual(plan.configSnapshot, config); assert.deepEqual(plan.writeAllowedFiles, []); assert.deepEqual(plan.testCommandIds, []);
  assert.equal(plan.executionAllowed, false); assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 86_400_000);
  const old = createReadonlyModelPreflightPlan(createReadonlyModelPreflightPayload(source), context);
  assert.throws(() => assertReadonlyLivePlan(old as unknown as ReadonlyLivePlan));
  assert.throws(() => assertReadonlyModelPreflightPlan(plan as unknown as ReadonlyModelPreflightPlan));
  assertReadonlyModelPreflightPlan(old);
});

test('changed config is rejected with and without external snapshot validation', () => {
  for (const change of [{ enabled: false }, { codexPath: '/other/codex' }, { codexSha256: 'b'.repeat(64) }]) {
    assert.throws(() => assertReadonlyLivePlan(plan, { ...config, ...change }));
    assert.throws(() => validateReadonlyLivePayload(plan, payload, { ...config, ...change }));
    const altered = { ...plan, configSnapshot: { ...config, ...change } };
    altered.planHash = hashReadonlyLivePlan(altered); assert.throws(() => assertReadonlyLivePlan(altered));
  }
});

test('selected evidence alone crosses the request boundary with no tools or filesystem identity', () => {
  const evidence = source.context.evidence.find((item) => item.path === 'src/controller.ts')!;
  const selected = createReadonlyLivePayload(selectReadonlyTransfer(source, [evidence.evidenceId]), profileId, config);
  const selectedPlan = createReadonlyLivePlan(selected, context, config);
  assert.equal(selected.context.evidence.length, 4); assert.equal(JSON.parse(selected.inputText).evidence.length, 1);
  assert.equal(selectedPlan.contextHash, source.context.contextHash);
  for (const raw of [selected.inputText, selected.requestBody, canonicalReadonlyJson(selected.requestEnvelope)]) {
    for (const forbidden of [source.repository.sourceRoot, config.codexPath, 'src/service.ts', '.git', 'README.md']) assert.equal(raw.includes(forbidden), false);
  }
  const request = assertReadonlyLiveRequestBody(selected.requestBody, config);
  assert.deepEqual(request.tools, []); assert.equal(request.store, false); assert.equal(request.stream, true);
  assert.equal(request.text.format.strict, true); assert.equal('mode' in (request.text.format.schema as Record<string, unknown>), false);
});

test('every envelope field and recomputed dispatch hash still requires exact approved body and headers', () => {
  assertReadonlyLiveDispatch(dispatch(), config);
  for (const [key, value] of Object.entries({ url: 'https://chatgpt.com/backend-api/codex/responses?extra=1', method: 'GET',
    profileId: 'responses-candidate-sse-v1', connectionProfileHash: 'b'.repeat(64), redirect: 'follow', retries: 1,
    headers: [...payload.requestEnvelope.headers, ['authorization', 'synthetic']], body: payload.requestBody + ' ' })) {
    const changed = dispatch(); Object.assign(changed.requestEnvelope, { [key]: value });
    changed.requestEnvelopeHash = hashReadonlyLiveEnvelope(changed.requestEnvelope); changed.requestBodyHash = hashReadonlyValue(changed.requestEnvelope.body);
    assert.throws(() => assertReadonlyLiveDispatch(changed, config), key);
  }
  assert.throws(() => assertReadonlyLiveDispatch({ ...dispatch(), credentials: {} } as ReadonlyLiveDispatch, config));
});

test('unapproved request forms, duplicate keys, tools, schema changes and extra histories fail', () => {
  const body = JSON.parse(payload.requestBody);
  for (const changed of [{ ...body, tools: [{ type: 'function' }] }, { ...body, model: 'other' }, { ...body, stream: false },
    { ...body, store: true }, { ...body, previous_response_id: 'resp_other' }, { ...body, tool_choice: 'auto' },
    { ...body, input: [...body.input, ...body.input] }, { ...body, text: {} }]) {
    assert.throws(() => assertReadonlyLiveRequestBody(canonicalReadonlyJson(changed), config));
  }
  assert.throws(() => assertReadonlyLiveRequestBody(payload.requestBody.replace('"model":"gpt-6.1-sol"', '"model":"gpt-6.1-sol","model":"gpt-6.1-sol"'), config));
});

test('plan hashes bind permissions, fixed limits, timestamps, source and connection identity', () => {
  for (const [key, value] of Object.entries({ policy: 'synthetic-readonly-model-preflight-v1', mode: 'offline', responseOrigin: 'synthetic',
    ownerId: 'os-user:99999', writeAllowedFiles: ['src/controller.ts'], executionAllowed: true, authentication: 'none',
    expiresAt: '2099-01-01T00:00:00.000Z', inputHash: 'e'.repeat(64), requestBodyHash: 'd'.repeat(64), limits: { ...plan.limits, calls: 2 } })) {
    const changed = { ...plan, [key]: value } as ReadonlyLivePlan; assert.notEqual(hashReadonlyLivePlan(changed), plan.planHash);
    assert.throws(() => assertReadonlyLivePlan(changed));
  }
  for (const key of ['configSnapshot', 'requestEnvelopeHash', 'writeAllowedFiles']) {
    const changed = { ...plan } as unknown as Record<string, unknown>; delete changed[key]; assert.throws(() => assertReadonlyLivePlan(changed as unknown as ReadonlyLivePlan));
  }
  const altered = structuredClone(payload); altered.context.evidence[0]!.excerpt += ' changed';
  assert.throws(() => validateReadonlyLivePayload(plan, altered));
});

test('controller adds live provenance after shared evidence validation; model cannot forge flags', () => {
  const raw = { classification: 'insufficient-evidence', summary: '추가 확인이 필요합니다.', facts: [], hypotheses: [], answerDraft: '제공된 범위만으로 확정할 수 없습니다.',
    questions: ['추가 근거를 제공할 수 있나요?'], suggestions: [], limitations: ['선택된 합성 코드만 조사했습니다.'] };
  const result = parseReadonlyLiveResult(JSON.stringify(raw), payload);
  assert.equal(result.mode, 'live'); assert.equal(result.responseOrigin, 'model'); assert.equal(result.transport, 'codex-cli-broker');
  assert.throws(() => parseReadonlyLiveResult(JSON.stringify({ ...raw, mode: 'live' }), payload));
  assert.throws(() => parseReadonlyLiveResult(JSON.stringify({ ...raw, facts: [{ text: '발견', references: [{ evidenceId: 'evidence-' + 'f'.repeat(64), startLine: 1, endLine: 1 }] }] }), payload));
});
