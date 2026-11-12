export type BranchWorkType = 'feature' | 'fix' | 'chore' | 'refactor';
export type BranchFixture = 'success' | 'collision' | 'source-changed' | 'unknown';
export type BranchStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'SIMULATING' | 'SIMULATED'
  | 'FAILED' | 'UNKNOWN' | 'BLOCKED' | 'CANCELLED';

/** 실제 저장소의 실행 결과나 기존 실행 승인을 입력으로 받지 않는 합성 전용 계약이다. */
export interface BranchPlan {
  taskId: string;
  ownerId: string;
  policy: 'synthetic-branch-v1';
  mode: 'offline';
  operation: 'simulate-branch';
  workType: BranchWorkType;
  fixture: BranchFixture;
  source: {
    requestId: string;
    revision: number;
    repoId: string;
    remote: string;
    baseBranch: string;
    baseCommit: string;
    diffHash: string;
    allowedFiles: string[];
  };
  branchName: string;
  createdAt: string;
  expiresAt: string;
  planHash: string;
}

export interface BranchTask {
  taskId: string;
  plan: BranchPlan;
  status: BranchStatus;
  generation: number;
  revision: number;
  invalidatedAt: string | null;
  failureCode: string | null;
  updatedAt: string;
}

export interface BranchApproval {
  approvalId: string;
  taskId: string;
  ownerId: string;
  planHash: string;
  planSnapshot: BranchPlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  reason: string | null;
}

export interface BranchApprovalRequest {
  taskId: string;
  planHash: string;
  expiresInMinutes: number;
}

export interface BranchAttempt {
  attemptId: string;
  taskId: string;
  approvalId: string;
  planHash: string;
  generation: number;
  status: 'SIMULATING' | 'SIMULATED' | 'NOT_CREATED' | 'UNKNOWN';
  startedAt: string;
  finishedAt: string | null;
  reason: string | null;
  receiptId: string | null;
}

export interface BranchResult {
  status: 'SIMULATED' | 'NOT_CREATED' | 'UNKNOWN';
  reason: string | null;
  receiptId: string | null;
}

export interface BranchClaim {
  task: BranchTask;
  attempt: BranchAttempt;
}

export type BranchControlKind = 'cancel' | 'edited' | 'deleted' | 'base-changed' | 'diff-changed' | 'branch-conflict';
export interface BranchControl {
  taskId: string;
  eventId: string;
  kind: BranchControlKind;
  revision: number;
}

export interface BranchSnapshot {
  task: BranchTask;
  approvals: BranchApproval[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
  attempt: BranchAttempt | null;
}
