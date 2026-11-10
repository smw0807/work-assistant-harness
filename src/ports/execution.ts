import type {
  ExecutionApproval, ExecutionApprovalContext, ExecutionApprovalRequest, ExecutionRun,
  ExecutionRunRequest, ExecutionTask,
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
  close(): void;
}
