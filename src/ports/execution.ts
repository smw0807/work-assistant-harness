import type {
  ExecutionApproval, ExecutionApprovalContext, ExecutionApprovalRequest, ExecutionRun,
  ExecutionRunRequest, ExecutionTask, ExecutionControlRequest, ExecutionRequestState,
  ExecutionLifecycle, ExecutionPhase, ExecutionProgress, ExecutionSnapshot,
} from '../domain/execution.js';

export interface ExecutionStore {
  create(task: ExecutionTask): void;
  find(taskId: string): ExecutionTask | null;
  approve(request: ExecutionApprovalRequest, context: ExecutionApprovalContext): ExecutionApproval;
  listApprovals(taskId: string): ExecutionApproval[];
  listApprovalHistory(taskId: string, offset: number): {
    approvals: ExecutionApproval[]; approvalPage: { offset: number; total: number; nextOffset: number | null };
  };
  beginRun(request: ExecutionRunRequest, context: ExecutionApprovalContext, artifactDirectory: string): ExecutionRun;
  finishRun(run: ExecutionRun): void;
  findRun(runId: string): ExecutionRun | null;
  listRuns(taskId: string): ExecutionRun[];
  requestState(taskId: string): ExecutionRequestState;
  control(request: ExecutionControlRequest, context: ExecutionApprovalContext): ExecutionRequestState;
  lifecycle(runId: string): ExecutionLifecycle;
  assertRunnable(runId: string): ExecutionLifecycle;
  checkpoint(runId: string, phase: ExecutionPhase, progress?: ExecutionProgress): ExecutionLifecycle;
  guard<T>(runId: string, phase: ExecutionPhase, operation: () => Promise<T>): Promise<T>;
  dispatch<T>(runId: string, operation: () => T): T;
  inspect(taskId: string, approvalOffset: number): ExecutionSnapshot;
  close(): void;
}
