import type { PersonalCollectionEvidence, PersonalCollectionProfile } from './personal-readonly-collection.js';
import type { PersonalReadonlyRepository } from './personal-readonly.js';
import type { ReadonlyRange } from './readonly-investigation.js';

export const COMPANY_PREPARATION_POLICY = 'company-readonly-preparation-v1' as const;
export interface CompanyReadonlyPolicy {
  version: 'company-readonly-policy-v1';
  enabled: false;
  readPermission: 'unconfirmed' | 'confirmed';
  storagePermission: 'unconfirmed' | 'confirmed';
  policyReference: string | null;
  payloadRetentionHours: number | null;
  auditRetentionDays: number | null;
}
export interface CompanyReadonlyRegistration {
  version: 'company-readonly-registration-v1';
  repoId: string;
  sourceRoot: string;
  baseCommit: string;
  question: string;
  readRanges: ReadonlyRange[];
  reviewPaths: string[];
}
export interface CompanyReadonlyRepository extends Omit<PersonalReadonlyRepository, 'kind'> { kind: 'company-git' }
export interface CompanyReadonlyPayload {
  registration: CompanyReadonlyRegistration;
  policy: CompanyReadonlyPolicy;
  repository: CompanyReadonlyRepository;
  collected: PersonalCollectionEvidence;
  reviewInput: string;
}
/** Hash-only review identity; source paths and excerpts stay in the expiring private payload. */
export interface CompanyReadonlyPlan {
  version: typeof COMPANY_PREPARATION_POLICY;
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
  reviewInputHash: string;
  collectionProfile: PersonalCollectionProfile;
  collectionProfileHash: string;
  preparationKey: string;
  planHash: string;
}
export type CompanyReadonlyStatus = 'AWAITING_APPROVAL' | 'CANCELLED' | 'EXPIRED';
export interface CompanyReadonlySnapshot {
  plan: CompanyReadonlyPlan;
  status: CompanyReadonlyStatus;
  updatedAt: string;
  payload: CompanyReadonlyPayload | null;
  approvalCreated: false;
  transmissionAllowed: false;
  executionAllowed: false;
  companyPolicyVerified: false;
}
export interface CompanyReadonlyPruneResult { payloadsRemoved: number; recordsRemoved: number }
