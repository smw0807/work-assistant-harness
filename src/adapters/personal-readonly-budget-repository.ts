import { HarnessError } from '../domain/errors.js';
import type { PersonalBudgetPayload, PersonalBudgetRegistration } from '../domain/personal-readonly-budget.js';
import { PERSONAL_COLLECTION_PLAN_POLICY, type PersonalCollectionPayload, type PersonalCollectionRegistration } from '../domain/personal-readonly-collection.js';
import { parsePersonalBudgetRegistration } from '../policy/personal-readonly-budget-policy.js';
import { getReadonlyRelayExecutionBudgetHash } from '../policy/readonly-relay-budget-policy.js';
import { assertPersonalCollectionPayloadNow, collectPersonalCollectionEvidence, inspectPersonalCollectionRepository } from './personal-readonly-collection-repository.js';

const reject = (): never => { throw new HarnessError('PERSONAL_BUDGET_SOURCE_CHANGED'); };
const copyData = <T>(value: T): T => {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 32768 || depth > 24) return reject();
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && Buffer.byteLength(item) <= 262144) return item;
    if (!item || typeof item !== 'object') return reject();
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 4096 || Reflect.ownKeys(item).length !== item.length + 1) return reject();
      return Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject();
        return visit(descriptor.value, depth + 1);
      });
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) return reject();
    return Object.fromEntries(Reflect.ownKeys(item).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
        || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject();
      return [key, visit(descriptor.value, depth + 1)];
    }));
  };
  return visit(value, 0) as T;
};
/** This local projection selects the unchanged source/view collector, never an approved input contract. */
const sourceRegistration = (input: PersonalBudgetRegistration): PersonalCollectionRegistration => {
  const registration = parsePersonalBudgetRegistration(copyData(input));
  return { version: 'personal-readonly-registration-v2', collectionPolicy: registration.collectionPolicy,
    repoId: registration.repoId, sourceRoot: registration.sourceRoot, baseCommit: registration.baseCommit,
    question: registration.question, readRanges: registration.readRanges, transferPaths: registration.transferPaths };
};
export const inspectPersonalBudgetRepository = (registration: PersonalBudgetRegistration, id: string) =>
  inspectPersonalCollectionRepository(sourceRegistration(registration), id);
export const collectPersonalBudgetEvidence = (repository: PersonalBudgetPayload['repository'], registration: PersonalBudgetRegistration) =>
  collectPersonalCollectionEvidence(repository, sourceRegistration(registration));

export const assertPersonalBudgetPayloadNow = (input: PersonalBudgetPayload): void => {
  try {
    const payload = copyData(input);
    if (payload.executionBudgetHash !== getReadonlyRelayExecutionBudgetHash(payload.executionBudget)
      || payload.executionBudgetHash !== getReadonlyRelayExecutionBudgetHash()) return reject();
    // Only source metadata, safe-view proofs and evidence are inspected by this legacy source guard.
    const sourceView: PersonalCollectionPayload = { ...payload, registration: sourceRegistration(payload.registration),
      context: { ...payload.context, policy: PERSONAL_COLLECTION_PLAN_POLICY }, profileId: 'codex-chatgpt-relay-v2' };
    assertPersonalCollectionPayloadNow(sourceView);
  } catch { reject(); }
};
export const assertPersonalBudgetPayload = async (payload: PersonalBudgetPayload): Promise<void> => { assertPersonalBudgetPayloadNow(payload); };
