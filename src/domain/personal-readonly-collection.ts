import type { ReadonlyEvidence, ReadonlyRange } from './readonly-investigation.js';
import type { PersonalReadonlyPayload, PersonalReadonlyPlan, PersonalReadonlyRegistration, PersonalReadonlySnapshot } from './personal-readonly.js';
import type { PersonalBudgetPayload, PersonalBudgetPlan, PersonalBudgetRegistration } from './personal-readonly-budget.js';

export const PERSONAL_COLLECTION_POLICY = 'personal-readonly-collection-v2' as const;
export const PERSONAL_COLLECTION_PLAN_POLICY = 'personal-readonly-investigation-v2' as const;
export const PERSONAL_COLLECTION_INPUT_POLICY = 'personal-readonly-input-v2' as const;
export const PERSONAL_COLLECTION_REDACTOR = 'line-preserving-sensitive-redaction-v1' as const;

export interface PersonalCollectionProfile {
  policy: typeof PERSONAL_COLLECTION_POLICY;
  redactor: typeof PERSONAL_COLLECTION_REDACTOR;
  rawSensitivePolicy: 'existing-full-file-rejection-v1';
  viewSensitivePolicy: 'same-full-file-check-v1';
  relayProfileScope: 'unchanged-transport-component';
  limits: {
    sourceFileBytes: 65536; fullViewBytes: 65536; excerptBytes: 32768; evidenceBytes: 65536;
    inputBytes: 131072; files: 8; ranges: 16; linesPerRange: 200; masks: 128;
  };
}
export interface PersonalCollectionRegistration extends Omit<PersonalReadonlyRegistration, 'version'> {
  version: 'personal-readonly-registration-v2';
  collectionPolicy: typeof PERSONAL_COLLECTION_POLICY;
}
/** Safe metadata only. Neither raw matches nor full source/view bodies are persisted. */
export interface PersonalSourceViewProof {
  path: string;
  sourceHash: string;
  sourceBytes: number;
  sourceLines: number;
  viewHash: string;
  viewBytes: number;
  viewLines: number;
  rawSensitiveCheck: 'passed' | 'rejected';
  viewSensitiveCheck: 'passed';
  maskCount: number;
  maskedLines: { startLine: number; endLine: number }[];
}
export interface PersonalCollectionEvidence {
  evidence: ReadonlyEvidence[];
  sourceViews: PersonalSourceViewProof[];
}
export interface PersonalCollectionContext extends Omit<PersonalReadonlySnapshot, 'policy'> {
  policy: typeof PERSONAL_COLLECTION_PLAN_POLICY;
}
export interface PersonalCollectionPayload extends Omit<PersonalReadonlyPayload, 'registration' | 'context'> {
  registration: PersonalCollectionRegistration;
  context: PersonalCollectionContext;
  collectionProfile: PersonalCollectionProfile;
  collectionProfileHash: string;
  sourceViews: PersonalSourceViewProof[];
  sourceViewsHash: string;
}
export interface PersonalCollectionPlan extends Omit<PersonalReadonlyPlan, 'policy' | 'inputPolicyVersion'> {
  policy: typeof PERSONAL_COLLECTION_PLAN_POLICY;
  inputPolicyVersion: typeof PERSONAL_COLLECTION_INPUT_POLICY;
  collectionProfile: PersonalCollectionProfile;
  collectionProfileHash: string;
  sourceViewsHash: string;
}
export type AnyPersonalRegistration = PersonalReadonlyRegistration | PersonalCollectionRegistration | PersonalBudgetRegistration;
export type AnyPersonalPayload = PersonalReadonlyPayload | PersonalCollectionPayload | PersonalBudgetPayload;
export type AnyPersonalPlan = PersonalReadonlyPlan | PersonalCollectionPlan | PersonalBudgetPlan;
export interface PersonalSourceView extends PersonalSourceViewProof { bytes: Uint8Array }
export type PersonalCollectionRange = ReadonlyRange;
