import type { CompanyReadonlyPolicy, CompanyReadonlyPruneResult, CompanyReadonlyStatus } from './company-readonly.js';
import type { CompanyGitRangeBudgetSnapshot } from './company-git-range.js';
import type { PersonalCollectionEvidence, PersonalCollectionProfile } from './personal-readonly-collection.js';
import type { ReadonlyContext, ReadonlyRange } from './readonly-investigation.js';
import type { CompanyGitRangeSourceObservation } from '../adapters/company-git-range-source.js';

export const COMPANY_PREPARATION_V2 = 'company-readonly-preparation-v2' as const;
export interface CompanyReadonlyRegistrationV2 {
  version: 'company-readonly-registration-v2';
  gitProfileHash: string;
  repoId: string;
  sourceRoot: string;
  baseCommit: string;
  question: string;
  readRanges: ReadonlyRange[];
  reviewPaths: string[];
}
export interface CompanyReadonlyPayloadV2 {
  registration: CompanyReadonlyRegistrationV2;
  policy: CompanyReadonlyPolicy;
  observation: CompanyGitRangeSourceObservation;
  collected: PersonalCollectionEvidence;
  budget: CompanyGitRangeBudgetSnapshot;
  reviewInput: string;
}
export interface CompanyReadonlyPlanV2 {
  version: typeof COMPANY_PREPARATION_V2;
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
  reviewInputHash: string;
  collectionProfile: PersonalCollectionProfile;
  collectionProfileHash: string;
  preparationKey: string;
  planHash: string;
}
export interface CompanyReadonlySnapshotV2 {
  plan: CompanyReadonlyPlanV2;
  status: CompanyReadonlyStatus;
  updatedAt: string;
  payload: CompanyReadonlyPayloadV2 | null;
  approvalCreated: false;
  transmissionAllowed: false;
  executionAllowed: false;
  companyPolicyVerified: false;
}
/** The fixed collector exposes only safe evidence; no model, approval or execution capability exists. */
export interface CompanyReadonlySessionV2 {
  inspect(): { observation: CompanyGitRangeSourceObservation; collected: PersonalCollectionEvidence };
  verify(): { observation: CompanyGitRangeSourceObservation; budget: CompanyGitRangeBudgetSnapshot };
  close(): void;
}
export interface CompanyReadonlySourceV2 {
  open(registration: CompanyReadonlyRegistrationV2): CompanyReadonlySessionV2;
}
export interface CompanyReadonlyStoreV2 {
  create(plan: CompanyReadonlyPlanV2, payload: CompanyReadonlyPayloadV2, context: ReadonlyContext): CompanyReadonlySnapshotV2;
  inspect(id: string, context: ReadonlyContext): CompanyReadonlySnapshotV2;
  cancel(id: string, context: ReadonlyContext): CompanyReadonlySnapshotV2;
  prune(context: ReadonlyContext): CompanyReadonlyPruneResult;
  close(): void;
}
