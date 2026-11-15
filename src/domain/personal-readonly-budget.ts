import type { PersonalCollectionContext, PersonalCollectionPayload, PersonalCollectionPlan, PersonalCollectionRegistration } from './personal-readonly-collection.js';
import type { AnyReadonlyRelayConfig, ReadonlyRelayExecutionBudget } from './readonly-relay-budget.js';

export const PERSONAL_BUDGET_PLAN_POLICY = 'personal-readonly-investigation-v3' as const;
export const PERSONAL_BUDGET_INPUT_POLICY = 'personal-readonly-input-v3' as const;
export const PERSONAL_BUDGET_POLICY = 'readonly-relay-execution-budget-v1' as const;

export interface PersonalBudgetRegistration extends Omit<PersonalCollectionRegistration, 'version'> {
  version: 'personal-readonly-registration-v3';
  executionBudgetPolicy: typeof PERSONAL_BUDGET_POLICY;
}
export interface PersonalBudgetContext extends Omit<PersonalCollectionContext, 'policy'> {
  policy: typeof PERSONAL_BUDGET_PLAN_POLICY;
}
export interface PersonalBudgetPayload extends Omit<PersonalCollectionPayload, 'registration' | 'context' | 'profileId'> {
  registration: PersonalBudgetRegistration;
  context: PersonalBudgetContext;
  profileId: 'codex-chatgpt-relay-v3';
  executionBudget: ReadonlyRelayExecutionBudget;
  executionBudgetHash: string;
}
export interface PersonalBudgetPlan extends Omit<PersonalCollectionPlan, 'policy' | 'inputPolicyVersion' | 'profileId' | 'configSnapshot'> {
  policy: typeof PERSONAL_BUDGET_PLAN_POLICY;
  inputPolicyVersion: typeof PERSONAL_BUDGET_INPUT_POLICY;
  configSnapshot: AnyReadonlyRelayConfig;
  profileId: 'codex-chatgpt-relay-v3';
  executionBudget: ReadonlyRelayExecutionBudget;
  executionBudgetHash: string;
}
