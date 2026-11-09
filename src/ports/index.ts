import type {
  Evidence, MessageEvent, ModelSummary, ReadRequest, Task, TriageDecision,
} from '../domain/types.js';

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
  approve(taskId: string, planHash: string): never;
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
