import type {
  Evidence, MessageEvent, ModelSummary, ReadRequest, Task, TriageDecision,
} from '../domain/types.js';
import type { ApprovalContext, ApprovalHistoryPage, ApprovalRecord, ApprovalRequest } from '../domain/approval.js';

export interface MessageSource {
  read(): Promise<unknown[]>;
}

export interface ModelPort {
  triage(event: MessageEvent): Promise<string>;
  summarize(event: MessageEvent, decision: TriageDecision, evidence: Evidence[]): Promise<string>;
}

export interface RepoReadPort {
  read(request: ReadRequest): Promise<Evidence>;
}

export interface ApprovalPort {
  approve(request: ApprovalRequest, context: ApprovalContext): ApprovalRecord;
}

export interface ApprovalStore extends ApprovalPort {
  cancelApproval(taskId: string, ownerId: string, now: Date): Task;
  listApprovals(taskId: string): ApprovalRecord[];
  listApprovalHistory(taskId: string, offset: number): ApprovalHistoryPage;
  reconcileApprovals(now: Date): number;
}

export interface ExecutionPort {
  execute(taskId: string): never;
}

export interface ReportSink {
  write(task: Task): Promise<string>;
}

export interface TaskStore {
  create(task: Task): boolean;
  save(task: Task): void;
  find(taskId: string): Task | null;
  list(): Task[];
  recoverInterrupted(): number;
  close(): void;
}

export interface ModelOutputValidator {
  triage(output: string): TriageDecision;
  summary(output: string, evidenceCount: number): ModelSummary;
}
