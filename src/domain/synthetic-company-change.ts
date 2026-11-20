export interface SyntheticCompanyChangeSource {
  repositoryId: 'synthetic-company-change';
  rootHash: string;
  baseCommit: string;
  baseBranch: string;
  indexHash: string;
  sourceHash: string;
}

/** Immutable descriptors bind ordered writes without persisting replacement bodies. */
export interface SyntheticCompanyChangeDescriptor {
  operation: 'replace' | 'create';
  path: string;
  beforeHash: string | null;
  afterHash: string;
  bytes: number;
}

export interface SyntheticCompanyChangePlan {
  version: 'synthetic-company-change-apply-v1';
  id: string;
  ownerId: string;
  draftHash: string;
  branch: string;
  requestRevision: number;
  source: SyntheticCompanyChangeSource;
  changes: SyntheticCompanyChangeDescriptor[];
  createdAt: string;
  expiresAt: string;
  limitsHash: string;
  planHash: string;
  scope: 'synthetic-only';
  checks: 'not_run';
  transmissionAllowed: false;
}

export interface SyntheticCompanyChangeRequest {
  taskId: string;
  planHash: string;
}

export type SyntheticCompanyChangeClaimRequest = SyntheticCompanyChangeRequest;

export interface SyntheticCompanyChangeApprovalRequest extends SyntheticCompanyChangeRequest {
  expiresInMinutes: number;
}

export interface SyntheticCompanyChangeApproval {
  id: string;
  taskId: string;
  ownerId: string;
  planHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  scope: 'synthetic-apply';
}

export type SyntheticCompanyChangeStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'APPLYING' | 'APPLIED'
  | 'FAILED' | 'CANCELLED' | 'EXPIRED';

export type SyntheticCompanyChangeFailureCode = 'SYNTHETIC_COMPANY_CHANGE_APPLY_FAILED'
  | 'SYNTHETIC_COMPANY_CHANGE_INTERRUPTED';

export interface SyntheticCompanyChangeJournalEntry {
  /** Entry index, including each INTENT and DONE separately. */
  sequence: number;
  kind: 'branch' | 'file';
  path: string | null;
  state: 'INTENT' | 'DONE';
  at: string;
}

export interface SyntheticCompanyChangeSnapshot {
  plan: SyntheticCompanyChangePlan;
  status: SyntheticCompanyChangeStatus;
  approval: SyntheticCompanyChangeApproval | null;
  updatedAt: string;
  journal: SyntheticCompanyChangeJournalEntry[];
  failureCode: SyntheticCompanyChangeFailureCode | null;
}
