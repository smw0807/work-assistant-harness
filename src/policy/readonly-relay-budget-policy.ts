import { HarnessError } from '../domain/errors.js';
import { READONLY_RELAY_EXECUTION_BUDGET_POLICY, type ReadonlyRelayExecutionBudget } from '../domain/readonly-relay-budget.js';
import type { ReadonlyRelayConfig, ReadonlyRelayProfileId, ReadonlyRelayRequestEnvelope } from '../domain/readonly-relay.js';
import { canonicalReadonlyJson, hashReadonlyValue } from './readonly-investigation-policy.js';
import { buildReadonlyRelayRequestEnvelope, getReadonlyRelayConfig, getReadonlyRelayConfigHash, getReadonlyRelayLimits,
  getReadonlyRelayProfile, getReadonlyRelayProfileHash, getReadonlyRelayProfileId, normalizeReadonlyRelayHeaders,
  parseReadonlyRelayConfig, readonlyRelayEnvelopeBytes, READONLY_RELAY_V2_LIMITS } from './readonly-relay-policy.js';

const invalid = (suffix: string): never => { throw new HarnessError(`READONLY_RELAY_${suffix}`); };
const budget: ReadonlyRelayExecutionBudget = Object.freeze({ policy: READONLY_RELAY_EXECUTION_BUDGET_POLICY,
  workTimeoutMs: 120000, cleanupTimeoutMs: 5000, totalTimeoutMs: 125000, frames: 8192,
  responseBytes: 4194304, frameBytes: 65536, jsonDepth: 16, outputBytes: 16384, nativeOutputBytes: 131072, stderrBytes: 16384 });
const ownSnapshot = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length) return invalid('INVALID_CONFIG');
  return Object.fromEntries(keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid('INVALID_CONFIG');
    return [key, descriptor.value];
  }));
};
/** Exact registered v3 tuple only; callers receive a detached frozen copy without invoking accessors. */
export const copyReadonlyRelayExecutionBudget = (value: unknown): ReadonlyRelayExecutionBudget | null => {
  try {
    const snapshot = ownSnapshot(value, Object.keys(budget));
    if (Object.keys(budget).some((key) => snapshot[key] !== budget[key as keyof ReadonlyRelayExecutionBudget])) return null;
    return Object.freeze({ ...snapshot }) as unknown as ReadonlyRelayExecutionBudget;
  } catch { return null; }
};
const configKeys = ['enabled', 'policyVersion', 'codexPath', 'codexSha256', 'model', 'authMode', 'timeoutMs', 'maxResponseBytes'];
export const parseAnyReadonlyRelayConfig = (value: unknown): ReadonlyRelayConfig => {
  try {
    const version = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'policyVersion') : undefined;
    if (version && Object.hasOwn(version, 'value') && ['readonly-relay-codex-v1', 'readonly-relay-codex-v2'].includes(version.value)) {
      return parseReadonlyRelayConfig(value);
    }
    const snapshot = ownSnapshot(value, configKeys);
    if (snapshot.policyVersion !== 'readonly-relay-codex-v3') return parseReadonlyRelayConfig(snapshot);
    if (snapshot.timeoutMs !== 125000) return invalid('INVALID_CONFIG');
    const legacy = parseReadonlyRelayConfig({ ...snapshot, policyVersion: 'readonly-relay-codex-v2', timeoutMs: 60000 });
    return { ...legacy, policyVersion: 'readonly-relay-codex-v3', timeoutMs: 125000 };
  } catch { return invalid('INVALID_CONFIG'); }
};
export const getAnyReadonlyRelayProfileId = (config: ReadonlyRelayConfig): ReadonlyRelayProfileId => {
  const version = Object.getOwnPropertyDescriptor(config, 'policyVersion');
  if (version && Object.hasOwn(version, 'value') && version.value !== 'readonly-relay-codex-v3') return getReadonlyRelayProfileId(config);
  const snapshot = parseAnyReadonlyRelayConfig(config);
  return snapshot.policyVersion === 'readonly-relay-codex-v3' ? 'codex-chatgpt-relay-v3' : getReadonlyRelayProfileId(snapshot);
};
export const getReadonlyRelayExecutionBudget = (config: ReadonlyRelayConfig): ReadonlyRelayExecutionBudget => {
  const snapshot = parseAnyReadonlyRelayConfig(config);
  if (snapshot.policyVersion === 'readonly-relay-codex-v3') return budget;
  return Object.freeze({ ...budget, policy: 'readonly-relay-legacy-execution-budget-v1', workTimeoutMs: 55000,
    totalTimeoutMs: 60000, frames: 2048, responseBytes: snapshot.policyVersion === 'readonly-relay-codex-v1' ? 262144 : 4194304 });
};
export const getReadonlyRelayExecutionBudgetHash = (value?: ReadonlyRelayExecutionBudget): string => {
  const snapshot = value === undefined ? budget : copyReadonlyRelayExecutionBudget(value);
  if (!snapshot) return invalid('INVALID_EXECUTION_BUDGET');
  return hashReadonlyValue(canonicalReadonlyJson(snapshot));
};
export const getAnyReadonlyRelayLimits = (profileId: ReadonlyRelayProfileId) => {
  if (profileId !== 'codex-chatgpt-relay-v3') return getReadonlyRelayLimits(profileId);
  return { ...READONLY_RELAY_V2_LIMITS, timeoutSeconds: 125, responseTimeoutMs: budget.workTimeoutMs,
    cleanupTimeoutMs: budget.cleanupTimeoutMs, frames: budget.frames };
};
const assertProfile = (profileId: ReadonlyRelayProfileId, config: ReadonlyRelayConfig): ReadonlyRelayConfig => {
  const snapshot = parseAnyReadonlyRelayConfig(config);
  if (profileId !== getAnyReadonlyRelayProfileId(snapshot)) return invalid('INVALID_PROFILE'); return snapshot;
};
export const getAnyReadonlyRelayProfile = (profileId: ReadonlyRelayProfileId, config: ReadonlyRelayConfig) => {
  if (profileId === 'codex-chatgpt-relay-v1' || profileId === 'codex-chatgpt-relay-v2') return getReadonlyRelayProfile(profileId, config);
  const snapshot = assertProfile(profileId, config);
  if (profileId !== 'codex-chatgpt-relay-v3') return getReadonlyRelayProfile(profileId, snapshot);
  const previous = getReadonlyRelayProfile('codex-chatgpt-relay-v2', { ...snapshot, policyVersion: 'readonly-relay-codex-v2', timeoutMs: 60000 });
  return { ...previous, profileId, configSnapshot: snapshot, cliIdleTimeoutMs: budget.workTimeoutMs,
    limits: getAnyReadonlyRelayLimits(profileId), executionBudget: budget, executionBudgetHash: getReadonlyRelayExecutionBudgetHash() };
};
export const getAnyReadonlyRelayProfileHash = (profileId: ReadonlyRelayProfileId, config: ReadonlyRelayConfig): string => {
  if (profileId === 'codex-chatgpt-relay-v1' || profileId === 'codex-chatgpt-relay-v2') return getReadonlyRelayProfileHash(profileId, config);
  const snapshot = assertProfile(profileId, config);
  return profileId === 'codex-chatgpt-relay-v3' ? hashReadonlyValue(canonicalReadonlyJson(getAnyReadonlyRelayProfile(profileId, snapshot)))
    : getReadonlyRelayProfileHash(profileId, snapshot);
};
export const getAnyReadonlyRelayConfig = (profileId: ReadonlyRelayProfileId, config: ReadonlyRelayConfig) => {
  if (profileId === 'codex-chatgpt-relay-v1' || profileId === 'codex-chatgpt-relay-v2') return getReadonlyRelayConfig(profileId, config);
  const snapshot = assertProfile(profileId, config);
  if (profileId !== 'codex-chatgpt-relay-v3') return getReadonlyRelayConfig(profileId, snapshot);
  const previous = getReadonlyRelayConfig('codex-chatgpt-relay-v2', { ...snapshot, policyVersion: 'readonly-relay-codex-v2', timeoutMs: 60000 });
  return { ...previous, profileId, configSnapshot: snapshot, connectionProfileHash: getAnyReadonlyRelayProfileHash(profileId, snapshot),
    limits: getAnyReadonlyRelayLimits(profileId), executionBudget: budget, executionBudgetHash: getReadonlyRelayExecutionBudgetHash() };
};
export const getAnyReadonlyRelayConfigHash = (profileId: ReadonlyRelayProfileId, config: ReadonlyRelayConfig): string => {
  if (profileId === 'codex-chatgpt-relay-v1' || profileId === 'codex-chatgpt-relay-v2') return getReadonlyRelayConfigHash(profileId, config);
  const snapshot = assertProfile(profileId, config);
  return profileId === 'codex-chatgpt-relay-v3' ? hashReadonlyValue(canonicalReadonlyJson(getAnyReadonlyRelayConfig(profileId, snapshot)))
    : getReadonlyRelayConfigHash(profileId, snapshot);
};
export const buildAnyReadonlyRelayRequestEnvelope = (body: string, profileId: ReadonlyRelayProfileId, config: ReadonlyRelayConfig): ReadonlyRelayRequestEnvelope => {
  if (profileId === 'codex-chatgpt-relay-v1' || profileId === 'codex-chatgpt-relay-v2') return buildReadonlyRelayRequestEnvelope(body, profileId, config);
  const snapshot = assertProfile(profileId, config);
  if (profileId !== 'codex-chatgpt-relay-v3') return buildReadonlyRelayRequestEnvelope(body, profileId, snapshot);
  const profile = getAnyReadonlyRelayProfile(profileId, snapshot);
  if (typeof body !== 'string' || Buffer.byteLength(body) > READONLY_RELAY_V2_LIMITS.requestBytes || Buffer.from(body).toString('utf8') !== body) return invalid('REQUEST_LIMIT');
  const envelope: ReadonlyRelayRequestEnvelope = { profileId, connectionProfileHash: getAnyReadonlyRelayProfileHash(profileId, snapshot),
    method: 'POST', url: 'https://chatgpt.com/backend-api/codex/responses', headers: normalizeReadonlyRelayHeaders(profile.headers), body, redirect: 'error', retries: 0 };
  if (readonlyRelayEnvelopeBytes(envelope) > READONLY_RELAY_V2_LIMITS.envelopeBytes) return invalid('ENVELOPE_LIMIT'); return envelope;
};
