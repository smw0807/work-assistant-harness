import type { CompanyReadonlyPolicy, CompanyReadonlyPruneResult, CompanyReadonlyStatus } from './company-readonly.js';
import type { CompanyGitRangeUnitBudgetSnapshot } from './company-git-range-unit.js';
import type { PersonalCollectionEvidence, PersonalCollectionProfile } from './personal-readonly-collection.js';
import type { ReadonlyContext, ReadonlyRange } from './readonly-investigation.js';
import type { CompanyGitRangeUnitSourceObservation } from '../adapters/company-git-range-unit-source.js';

export const COMPANY_PREPARATION_V3 = 'company-readonly-preparation-v3' as const;
export interface CompanyReadonlyRegistrationV3 {
  version: 'company-readonly-registration-v3';
  gitProfileHash: string;
  guardPolicyHash: string;
  repoId: string;
  sourceRoot: string;
  baseCommit: string;
  question: string;
  readRanges: ReadonlyRange[];
  reviewPaths: string[];
}
export interface CompanyReadonlyPayloadV3 {
  registration: CompanyReadonlyRegistrationV3;
  policy: CompanyReadonlyPolicy;
  observation: CompanyGitRangeUnitSourceObservation;
  collected: PersonalCollectionEvidence;
  budget: CompanyGitRangeUnitBudgetSnapshot;
  reviewInput: string;
}
export interface CompanyReadonlyPlanV3 {
  version: typeof COMPANY_PREPARATION_V3;
  id: string;
  ownerId: string;
  createdAt: string;
  expiresAt: string;
  auditExpiresAt: string;
  registrationHash: string;
  policyHash: string;
  sourceIdentityHash: string;
  sourceManifestHash: string;
  sourceViewsHash: string;
  evidenceHash: string;
  budgetHash: string;
  gitProfileHash: string;
  guardPolicyHash: string;
  reviewInputHash: string;
  collectionProfile: PersonalCollectionProfile;
  collectionProfileHash: string;
  preparationKey: string;
  planHash: string;
}
export interface CompanyReadonlySnapshotV3 {
  plan: CompanyReadonlyPlanV3;
  status: CompanyReadonlyStatus;
  updatedAt: string;
  payload: CompanyReadonlyPayloadV3 | null;
  approvalCreated: false;
  transmissionAllowed: false;
  executionAllowed: false;
  companyPolicyVerified: false;
}
/** The fixed collector exposes only safe evidence; no model, approval or execution capability exists. */
export interface CompanyReadonlySessionV3 {
  inspect(): { observation: CompanyGitRangeUnitSourceObservation; collected: PersonalCollectionEvidence };
  verify(): { observation: CompanyGitRangeUnitSourceObservation; budget: CompanyGitRangeUnitBudgetSnapshot };
  close(): void;
}
export interface CompanyReadonlySourceV3 {
  open(registration: CompanyReadonlyRegistrationV3): CompanyReadonlySessionV3;
}
export interface CompanyReadonlyStoreV3 {
  create(plan: CompanyReadonlyPlanV3, payload: CompanyReadonlyPayloadV3, context: ReadonlyContext): CompanyReadonlySnapshotV3;
  inspect(id: string, context: ReadonlyContext): CompanyReadonlySnapshotV3;
  cancel(id: string, context: ReadonlyContext): CompanyReadonlySnapshotV3;
  prune(context: ReadonlyContext): CompanyReadonlyPruneResult;
  close(): void;
}
