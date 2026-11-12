import type { BranchWorkType } from './branch.js';

export interface LocalBranchRepository {
  root: string;
  ownerToken: string;
  baseBranch: 'main';
  baseCommit: string;
  sourceHash: string;
  workspaceHash: string;
}

export interface LocalBranchPlan {
  taskId: string;
  ownerId: string;
  policy: 'local-synthetic-branch-v1';
  mode: 'local-synthetic';
  operation: 'create-branch';
  workType: BranchWorkType;
  branchName: string;
  repository: LocalBranchRepository;
  createdAt: string;
  expiresAt: string;
  planHash: string;
}

/** 관찰에 실패한 파일 이름이나 본문은 결과에 노출하지 않는다. */
export interface LocalBranchObservation {
  state: 'absent' | 'created' | 'unsafe';
  sourceHash: string | null;
  workspaceHash: string | null;
  baseOid: string | null;
  branchOid: string | null;
  reason: string | null;
}

export type LocalBranchStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'SUCCEEDED'
  | 'FAILED' | 'CANCELLED' | 'INTERRUPTED' | 'BLOCKED';

export interface LocalBranchTask {
  taskId: string;
  plan: LocalBranchPlan;
  status: LocalBranchStatus;
  generation: number;
  cancelledAt: string | null;
  failureCode: string | null;
  updatedAt: string;
}

export interface LocalBranchApproval {
  approvalId: string;
  taskId: string;
  ownerId: string;
  planHash: string;
  planSnapshot: LocalBranchPlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  reason: string | null;
}

export interface LocalBranchApprovalRequest {
  taskId: string;
  planHash: string;
  expiresInMinutes: number;
}

export interface LocalBranchAttempt {
  attemptId: string;
  taskId: string;
  approvalId: string;
  planHash: string;
  generation: number;
  phase: 'claimed' | 'writing' | 'created' | 'finished';
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED' | 'BLOCKED';
  startedAt: string;
  writeStartedAt: string | null;
  refCreatedAt: string | null;
  finishedAt: string | null;
  reason: string | null;
  before: LocalBranchObservation;
  after: LocalBranchObservation | null;
}

export interface LocalBranchSnapshot {
  task: LocalBranchTask;
  approvals: LocalBranchApproval[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
  attempt: LocalBranchAttempt | null;
}
