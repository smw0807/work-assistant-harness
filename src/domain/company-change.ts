export type CompanyChangeWorkType = 'feature' | 'fix' | 'chore' | 'refactor';

export interface CompanyChangeDraftChange {
  operation: 'replace' | 'create';
  path: string;
  beforeHash: string | null;
  content: string;
}

/** Supplied declarations only: no source root, filesystem proof or execution authority. */
export interface CompanyChangeDraft {
  version: 'company-change-draft-v1';
  repoId: string;
  requestRevision: number;
  objective: string;
  baseCommit: string;
  baseBranch: string;
  baseIndexHash: string;
  workType: CompanyChangeWorkType;
  branch: string;
  changes: CompanyChangeDraftChange[];
}

export interface CompanyChangePlan {
  version: 'company-change-review-v1';
  id: string;
  ownerId: string;
  draftHash: string;
  changeCount: number;
  createdAt: string;
  expiresAt: string;
  auditExpiresAt: string;
  limitsHash: string;
  sourceVerification: 'not_run';
  approvalScope: 'review-only';
  executionAllowed: false;
  transmissionAllowed: false;
  planHash: string;
}

export interface CompanyChangeApprovalRequest {
  taskId: string;
  planHash: string;
  expiresInMinutes: number;
}

export interface CompanyChangeApproval {
  id: string;
  taskId: string;
  ownerId: string;
  planHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  usedAt: null;
  scope: 'review-only';
  executionAllowed: false;
}

export type CompanyChangeStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'CANCELLED' | 'EXPIRED';

export interface CompanyChangeSnapshot {
  plan: CompanyChangePlan;
  status: CompanyChangeStatus;
  updatedAt: string;
  draft: CompanyChangeDraft | null;
  approval: CompanyChangeApproval | null;
}

export interface CompanyChangePruneResult {
  draftsRemoved: number;
  recordsRemoved: number;
}
