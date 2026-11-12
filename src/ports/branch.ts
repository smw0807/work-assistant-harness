import type {
  BranchApproval, BranchApprovalRequest, BranchAttempt, BranchClaim, BranchControl,
  BranchPlan, BranchResult, BranchSnapshot, BranchTask,
} from '../domain/branch.js';

export interface BranchStore {
  create(plan: BranchPlan, now: Date): BranchTask;
  inspect(taskId: string, ownerId: string, now: Date, approvalOffset?: number): BranchSnapshot;
  approve(request: BranchApprovalRequest, ownerId: string, now: Date): BranchApproval;
  claim(taskId: string, planHash: string, ownerId: string, now: Date): BranchClaim;
  finish(attemptId: string, result: BranchResult, now: Date): BranchAttempt;
  control(event: BranchControl, ownerId: string, now: Date): BranchTask;
  recover(taskId: string, ownerId: string, now: Date): BranchSnapshot;
  close(): void;
}

/** 실제 Git/Codex 실행기로 교체해 사용할 수 있는 실행 권한이 아니다. */
export interface MockBranchWorkspacePort {
  readonly mode: 'offline';
  simulate(claim: BranchClaim): Promise<BranchResult>;
}
