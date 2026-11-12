import type { BranchWorkType } from '../domain/branch.js';
import type {
  LocalBranchApproval, LocalBranchApprovalRequest, LocalBranchAttempt, LocalBranchObservation,
  LocalBranchPlan, LocalBranchRepository, LocalBranchSnapshot, LocalBranchTask,
} from '../domain/local-branch.js';

/** 하네스가 생성한 독립 합성 저장소만 다룬다. 임의 대상 경로와 Git 명령을 받지 않는다. */
export interface LocalBranchWorkspacePort {
  readonly mode: 'local-synthetic';
  prepare(taskId: string, workType: BranchWorkType): Promise<LocalBranchRepository>;
  observe(plan: LocalBranchPlan): LocalBranchObservation;
  // 전용 store의 짧은 동기 guard 안에서만 호출한다. 기존 ref는 덮어쓰지 않는다.
  createRef(plan: LocalBranchPlan): void;
}

export interface LocalBranchStore {
  create(plan: LocalBranchPlan, now: Date): LocalBranchTask;
  inspect(taskId: string, ownerId: string, now: Date, offset?: number): LocalBranchSnapshot;
  approve(request: LocalBranchApprovalRequest, observation: LocalBranchObservation, ownerId: string, now: Date): LocalBranchApproval;
  claim(taskId: string, planHash: string, observation: LocalBranchObservation, ownerId: string, now: Date): LocalBranchAttempt;
  beginWrite(taskId: string, ownerId: string, now: Date): void;
  writeGuard(taskId: string, ownerId: string, now: Date, operation: () => void): void;
  finish(taskId: string, observation: LocalBranchObservation, failureCode: string | null, recovered: boolean, ownerId: string, now: Date): LocalBranchSnapshot;
  block(taskId: string, reason: string, ownerId: string, now: Date): void;
  cancel(taskId: string, ownerId: string, now: Date): LocalBranchSnapshot;
  close(): void;
}
