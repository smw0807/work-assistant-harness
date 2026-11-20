import type { CompanyWriteDescriptor, CompanyWriteRegistration, CompanyWriteSource } from './company-write.js';

/** Registration v1 stays a declaration; only this separate plan and approval permit a local apply. */
export type CompanyApplyRegistration = CompanyWriteRegistration;
export type CompanyApplyDescriptor = CompanyWriteDescriptor;

export interface CompanyApplySource {
  workspace: CompanyWriteSource;
  packedRefsHash: string | null;
  baseRefKind: 'loose' | 'packed';
  gitProofHash: string;
}

export interface CompanyApplyPlan {
  version: 'company-apply-plan-v1';
  id: string;
  ownerId: string;
  registrationHash: string;
  draftHash: string;
  source: CompanyApplySource;
  branch: string;
  changes: CompanyApplyDescriptor[];
  createdAt: string;
  expiresAt: string;
  limitsHash: string;
  planHash: string;
  scope: 'company-local-write';
  checks: 'not_run';
  transmissionAllowed: false;
}

export interface CompanyApplyRequest {
  taskId: string;
  planHash: string;
}

export interface CompanyApplyApprovalRequest extends CompanyApplyRequest {
  expiresInMinutes: number;
}

export interface CompanyApplyApproval {
  version: 'company-apply-approval-v1';
  id: string;
  taskId: string;
  ownerId: string;
  planHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  scope: 'company-local-write';
}
