import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ReadonlyRelayConfig } from '../src/domain/readonly-relay.js';
import { buildAnyReadonlyRelayRequestEnvelope, copyReadonlyRelayExecutionBudget, getAnyReadonlyRelayConfig,
  getAnyReadonlyRelayConfigHash, getAnyReadonlyRelayProfile, getAnyReadonlyRelayProfileHash, getAnyReadonlyRelayProfileId,
  getReadonlyRelayExecutionBudget, getReadonlyRelayExecutionBudgetHash, parseAnyReadonlyRelayConfig } from '../src/policy/readonly-relay-budget-policy.js';
import { buildReadonlyRelayRequestEnvelope, getReadonlyRelayConfig, getReadonlyRelayConfigHash, getReadonlyRelayProfile,
  getReadonlyRelayProfileHash, parseReadonlyRelayConfig } from '../src/policy/readonly-relay-policy.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const base = { enabled: true, codexPath: '/synthetic/codex', codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol' as const,
  authMode: 'chatgpt' as const, maxResponseBytes: 16384 as const };
const v3: ReadonlyRelayConfig = { ...base, policyVersion: 'readonly-relay-codex-v3', timeoutMs: 125000 };

test('execution budget any helpers delegate old v1/v2 byte-identically without inserting budget metadata', () => {
  for (const version of ['v1', 'v2'] as const) {
    const config: ReadonlyRelayConfig = { ...base, policyVersion: `readonly-relay-codex-${version}`, timeoutMs: 60000 };
    const profileId = `codex-chatgpt-relay-${version}` as const;
    assert.deepEqual(parseAnyReadonlyRelayConfig(config), parseReadonlyRelayConfig(config));
    assert.equal(canonicalReadonlyJson(getAnyReadonlyRelayProfile(profileId, config)), canonicalReadonlyJson(getReadonlyRelayProfile(profileId, config)));
    assert.deepEqual(getAnyReadonlyRelayConfig(profileId, config), getReadonlyRelayConfig(profileId, config));
    assert.equal(getAnyReadonlyRelayProfileHash(profileId, config), getReadonlyRelayProfileHash(profileId, config));
    assert.equal(getAnyReadonlyRelayConfigHash(profileId, config), getReadonlyRelayConfigHash(profileId, config));
    assert.deepEqual(buildAnyReadonlyRelayRequestEnvelope('{}', profileId, config), buildReadonlyRelayRequestEnvelope('{}', profileId, config));
    assert.equal(Object.hasOwn(getAnyReadonlyRelayProfile(profileId, config), 'executionBudget'), false);
    const budget = getReadonlyRelayExecutionBudget(config);
    assert.deepEqual([budget.workTimeoutMs, budget.cleanupTimeoutMs, budget.totalTimeoutMs, budget.frames], [55000, 5000, 60000, 2048]);
    assert.equal(copyReadonlyRelayExecutionBudget(budget), null);
  }
});

test('execution budget v3 binds the fixed time/frame contract while independent byte/output limits stay unchanged', () => {
  assert.deepEqual(parseAnyReadonlyRelayConfig(v3), v3); assert.equal(getAnyReadonlyRelayProfileId(v3), 'codex-chatgpt-relay-v3');
  assert.throws(() => parseReadonlyRelayConfig(v3));
  const budget = getReadonlyRelayExecutionBudget(v3);
  assert.deepEqual(budget, { policy: 'readonly-relay-execution-budget-v1', workTimeoutMs: 120000, cleanupTimeoutMs: 5000,
    totalTimeoutMs: 125000, frames: 8192, responseBytes: 4194304, frameBytes: 65536, jsonDepth: 16,
    outputBytes: 16384, nativeOutputBytes: 131072, stderrBytes: 16384 });
  assert.equal(getReadonlyRelayExecutionBudgetHash(), hashReadonlyValue(canonicalReadonlyJson(budget)));
  assert.equal(getReadonlyRelayExecutionBudgetHash(budget), getReadonlyRelayExecutionBudgetHash());
  const profile = getAnyReadonlyRelayProfile('codex-chatgpt-relay-v3', v3);
  assert.equal(profile.cliIdleTimeoutMs, 120000); assert.equal(profile.limits.frames, 8192);
  assert.equal(profile.limits.responseTimeoutMs, 120000); assert.equal(profile.limits.timeoutSeconds, 125);
  assert.equal(profile.limits.cleanupTimeoutMs, 5000); assert.equal(profile.limits.responseBytes, 4194304);
  assert.equal(profile.limits.frameBytes, 65536); assert.equal(profile.limits.outputBytes, 16384);
  assert.ok('executionBudget' in profile); assert.deepEqual(profile.executionBudget, budget);
  const resolved = getAnyReadonlyRelayConfig('codex-chatgpt-relay-v3', v3);
  assert.equal(resolved.connectionProfileHash, getAnyReadonlyRelayProfileHash('codex-chatgpt-relay-v3', v3));
  const envelope = buildAnyReadonlyRelayRequestEnvelope('{}', 'codex-chatgpt-relay-v3', v3);
  assert.equal(envelope.retries, 0); assert.equal(envelope.redirect, 'error'); assert.equal(envelope.connectionProfileHash, resolved.connectionProfileHash);
});

test('execution budget config/profile rejects mixed versions, arbitrary limits and accessors before evaluation', () => {
  for (const value of [{ ...v3, timeoutMs: 60000 }, { ...v3, timeoutMs: 120000 }, { ...v3, policyVersion: 'readonly-relay-codex-v2' },
    { ...v3, frames: 16384 }, { ...v3, maxResponseBytes: 32768 }, { ...v3, model: 'another-model' }]) assert.throws(() => parseAnyReadonlyRelayConfig(value));
  assert.throws(() => getAnyReadonlyRelayProfile('codex-chatgpt-relay-v2', v3));
  assert.throws(() => buildAnyReadonlyRelayRequestEnvelope('{}', 'codex-chatgpt-relay-v1', v3));
  let called = 0; const accessor = Object.defineProperty({ ...v3 }, 'policyVersion', { enumerable: true, get() { called++; return 'readonly-relay-codex-v3'; } });
  assert.throws(() => parseAnyReadonlyRelayConfig(accessor)); assert.equal(called, 0);
});

test('execution budget snapshot copier rejects symbols/prototypes/extra keys/getters and returns a detached frozen fixed tuple', () => {
  const fixed = getReadonlyRelayExecutionBudget(v3), mutable = { ...fixed };
  const copy = copyReadonlyRelayExecutionBudget(mutable)!; assert.deepEqual(copy, fixed); assert.notEqual(copy, mutable); assert.equal(Object.isFrozen(copy), true);
  mutable.frames = 999; assert.equal(copy.frames, 8192);
  let reads = 0;
  const getter = Object.defineProperty({ ...fixed }, 'frames', { enumerable: true, get() { reads++; return 8192; } });
  for (const value of [getter, { ...fixed, frames: 4096 }, { ...fixed, workTimeoutMs: 90000 }, { ...fixed, totalTimeoutMs: 120000 },
    { ...fixed, arbitrary: true }, { ...fixed, [Symbol('extra')]: true }, Object.assign(Object.create({ inherited: true }), fixed)]) {
    assert.equal(copyReadonlyRelayExecutionBudget(value), null);
  }
  assert.equal(reads, 0); assert.deepEqual(copyReadonlyRelayExecutionBudget(Object.assign(Object.create(null), fixed)), fixed);
  assert.throws(() => getReadonlyRelayExecutionBudgetHash({ ...fixed, frames: 4096 }));
});

test('execution budget example is disabled and accepts only the new v3 fixed contract', () => {
  const config = parseAnyReadonlyRelayConfig(JSON.parse(readFileSync('config/readonly-relay-execution-budget.example.json', 'utf8')));
  assert.equal(config.enabled, false); assert.equal(config.policyVersion, 'readonly-relay-codex-v3'); assert.equal(config.timeoutMs, 125000);
});

test('execution budget legacy-confirmed parser keeps old acceptance and rejection for non-JSON shapes', () => {
  const legacy: ReadonlyRelayConfig = { ...base, policyVersion: 'readonly-relay-codex-v2', timeoutMs: 60000 };
  const hidden = Object.defineProperty({ ...legacy }, 'hidden', { value: true });
  const inherited = Object.assign(Object.create({ inherited: true }), legacy);
  const symbol = { ...legacy, [Symbol('extra')]: true };
  const getter = Object.defineProperty({ ...legacy }, 'enabled', { enumerable: true, get: () => true });
  const vectors = [legacy, hidden, inherited, symbol, getter, { ...legacy, extra: true }, { ...legacy, timeoutMs: 125000 }, { ...legacy, enabled: 1 }];
  const outcome = (operation: () => unknown) => { try { return { passed: true, value: operation() }; } catch (error) { return { passed: false, error: String(error) }; } };
  for (const value of vectors) {
    assert.deepEqual(outcome(() => parseAnyReadonlyRelayConfig(value)), outcome(() => parseReadonlyRelayConfig(value)));
    assert.deepEqual(outcome(() => getAnyReadonlyRelayProfile('codex-chatgpt-relay-v2', value as ReadonlyRelayConfig)), outcome(() => getReadonlyRelayProfile('codex-chatgpt-relay-v2', value as ReadonlyRelayConfig)));
    assert.deepEqual(outcome(() => getAnyReadonlyRelayConfigHash('codex-chatgpt-relay-v2', value as ReadonlyRelayConfig)), outcome(() => getReadonlyRelayConfigHash('codex-chatgpt-relay-v2', value as ReadonlyRelayConfig)));
  }
});
