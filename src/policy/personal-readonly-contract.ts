import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext, ReadonlyEvidence } from '../domain/readonly-investigation.js';
import { PERSONAL_READONLY_POLICY, type PersonalReadonlyPayload, type PersonalReadonlyPlan, type PersonalReadonlyRepository } from '../domain/personal-readonly.js';
import { PERSONAL_COLLECTION_PLAN_POLICY, type AnyPersonalPayload, type AnyPersonalPlan, type AnyPersonalRegistration,
  type PersonalCollectionEvidence, type PersonalCollectionPayload, type PersonalCollectionPlan } from '../domain/personal-readonly-collection.js';
import { PERSONAL_BUDGET_PLAN_POLICY, type PersonalBudgetPayload, type PersonalBudgetPlan } from '../domain/personal-readonly-budget.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch, ReadonlyRelayResult } from '../domain/readonly-relay.js';
import { assertPersonalReadonlyDispatch, assertPersonalReadonlyPlan, createPersonalReadonlyPayload, createPersonalReadonlyPlan,
  parsePersonalReadonlyRegistration, parsePersonalReadonlyResult, validatePersonalReadonlyPayload } from './personal-readonly-policy.js';
import { assertPersonalCollectionDispatch, assertPersonalCollectionPlan, createPersonalCollectionPayload, createPersonalCollectionPlan,
  parsePersonalCollectionRegistration, parsePersonalCollectionResult, validatePersonalCollectionPayload } from './personal-readonly-collection-policy.js';
import { assertPersonalBudgetDispatch, assertPersonalBudgetPlan, createPersonalBudgetPayload, createPersonalBudgetPlan,
  parsePersonalBudgetRegistration, parsePersonalBudgetResult, validatePersonalBudgetPayload } from './personal-readonly-budget-policy.js';
import { parseReadonlyTransportJson } from './readonly-transport-protocol.js';

const reject = (): never => { throw new HarnessError('PERSONAL_READONLY_INVALID_CONTRACT'); };
/** Contract selection reads own data only; each selected policy then validates the complete exact shape. */
const ownData = (value: unknown, key: string): unknown => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return reject();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((name) => typeof name !== 'string' || !descriptors[name]?.enumerable
      || !Object.hasOwn(descriptors[name]!, 'value'))) return reject();
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject();
    return descriptor.value;
  } catch { return reject(); }
};
const registrationVersion = (payload: unknown): unknown => ownData(ownData(payload, 'registration'), 'version');
const isReadonlyPayload = (payload: AnyPersonalPayload): payload is PersonalReadonlyPayload =>
  registrationVersion(payload) === 'personal-readonly-registration-v1' && ownData(ownData(payload, 'context'), 'policy') === PERSONAL_READONLY_POLICY;
const isCollectionPayload = (payload: AnyPersonalPayload): payload is PersonalCollectionPayload =>
  registrationVersion(payload) === 'personal-readonly-registration-v2' && ownData(ownData(payload, 'context'), 'policy') === PERSONAL_COLLECTION_PLAN_POLICY;
const isReadonlyPlan = (plan: AnyPersonalPlan): plan is PersonalReadonlyPlan => ownData(plan, 'policy') === PERSONAL_READONLY_POLICY;
const isCollectionPlan = (plan: AnyPersonalPlan): plan is PersonalCollectionPlan => ownData(plan, 'policy') === PERSONAL_COLLECTION_PLAN_POLICY;
const isBudgetPayload = (payload: AnyPersonalPayload): payload is PersonalBudgetPayload =>
  registrationVersion(payload) === 'personal-readonly-registration-v3' && ownData(ownData(payload, 'context'), 'policy') === PERSONAL_BUDGET_PLAN_POLICY;
const isBudgetPlan = (plan: AnyPersonalPlan): plan is PersonalBudgetPlan => ownData(plan, 'policy') === PERSONAL_BUDGET_PLAN_POLICY;

export const parseAnyPersonalRegistration = (value: unknown): AnyPersonalRegistration => {
  switch (ownData(value, 'version')) {
    case 'personal-readonly-registration-v1': return parsePersonalReadonlyRegistration(value);
    case 'personal-readonly-registration-v2': return parsePersonalCollectionRegistration(value);
    case 'personal-readonly-registration-v3':
      try { return parsePersonalBudgetRegistration(value); } catch { return reject(); }
    default: return reject();
  }
};
export const createAnyPersonalPayload = (repository: PersonalReadonlyRepository, registration: AnyPersonalRegistration,
  collected: ReadonlyEvidence[] | PersonalCollectionEvidence, context: ReadonlyContext, config: ReadonlyRelayConfig): AnyPersonalPayload => {
  const parsed = parseAnyPersonalRegistration(registration);
  if (parsed.version === 'personal-readonly-registration-v1') {
    if (!Array.isArray(collected)) return reject();
    return createPersonalReadonlyPayload(repository, parsed, collected, context, config);
  }
  if (Array.isArray(collected)) return reject();
  return parsed.version === 'personal-readonly-registration-v2'
    ? createPersonalCollectionPayload(repository, parsed, collected, context, config)
    : createPersonalBudgetPayload(repository, parsed, collected, context, config);
};
export const createAnyPersonalPlan = (payload: AnyPersonalPayload, context: ReadonlyContext, config: ReadonlyRelayConfig): AnyPersonalPlan => {
  if (isReadonlyPayload(payload)) return createPersonalReadonlyPlan(payload, context, config);
  if (isCollectionPayload(payload)) return createPersonalCollectionPlan(payload, context, config);
  if (isBudgetPayload(payload)) return createPersonalBudgetPlan(payload, context, config);
  return reject();
};
export const assertAnyPersonalPlan = (plan: AnyPersonalPlan, config?: ReadonlyRelayConfig): void => {
  if (isReadonlyPlan(plan)) return assertPersonalReadonlyPlan(plan, config);
  if (isCollectionPlan(plan)) return assertPersonalCollectionPlan(plan, config);
  if (isBudgetPlan(plan)) return assertPersonalBudgetPlan(plan, config);
  return reject();
};
export const validateAnyPersonalPayload = (plan: AnyPersonalPlan, payload: AnyPersonalPayload, config?: ReadonlyRelayConfig): void => {
  if (isReadonlyPlan(plan) && isReadonlyPayload(payload)) return validatePersonalReadonlyPayload(plan, payload, config);
  if (isCollectionPlan(plan) && isCollectionPayload(payload)) return validatePersonalCollectionPayload(plan, payload, config);
  if (isBudgetPlan(plan) && isBudgetPayload(payload)) return validatePersonalBudgetPayload(plan, payload, config);
  return reject();
};
/** Only the fixed input policy inside an exact wire body chooses a trusted harness validator. */
export const assertAnyPersonalDispatch = (dispatch: ReadonlyRelayDispatch, config: ReadonlyRelayConfig): void => {
  const envelope = ownData(dispatch, 'requestEnvelope'); const body = ownData(envelope, 'body');
  if (typeof body !== 'string') return reject();
  const request = parseReadonlyTransportJson(body, 256 * 1024);
  const input = ownData(request, 'input');
  if (!Array.isArray(input) || input.length !== 1) return reject();
  const content = ownData(input[0], 'content');
  if (!Array.isArray(content) || content.length !== 1) return reject();
  const text = ownData(content[0], 'text');
  if (typeof text !== 'string') return reject();
  const value = parseReadonlyTransportJson(text, 128 * 1024);
  switch (ownData(value, 'inputPolicyVersion')) {
    case 'personal-readonly-input-v1': return assertPersonalReadonlyDispatch(dispatch, config);
    case 'personal-readonly-input-v2': return assertPersonalCollectionDispatch(dispatch, config);
    case 'personal-readonly-input-v3': return assertPersonalBudgetDispatch(dispatch, config);
    default: return reject();
  }
};
export const parseAnyPersonalResult = (raw: string, payload: AnyPersonalPayload): ReadonlyRelayResult => {
  if (isReadonlyPayload(payload)) return parsePersonalReadonlyResult(raw, payload);
  if (isCollectionPayload(payload)) return parsePersonalCollectionResult(raw, payload);
  if (isBudgetPayload(payload)) return parsePersonalBudgetResult(raw, payload);
  return reject();
};
