export type Classification = 'inquiry' | 'change' | 'unclear';
export type TaskStatus =
  | 'RECEIVED' | 'TRIAGED' | 'ANALYZED' | 'REPORTED'
  | 'NEEDS_CLARIFICATION' | 'AWAITING_APPROVAL' | 'APPROVED' | 'BLOCKED' | 'FAILED' | 'CANCELLED';

export interface MessageEvent {
  eventId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs?: string;
  requesterId: string;
  revision: string;
  text: string;
}

export interface IngestionPolicy {
  workspaceId: string;
  channelIds: string[];
  targetUserId: string;
}

export interface ReadRequest {
  repoId: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface RepositoryPolicy {
  repoId: string;
  root: string;
  baseCommit: string;
  allowedPaths: string[];
  maxFileBytes: number;
  maxEvidenceBytes: number;
}

export interface Evidence extends ReadRequest {
  baseCommit: string;
  excerpt: string;
}

export interface TriageDecision {
  kind: Classification;
  objective: string;
  reads: ReadRequest[];
  questions: string[];
}

export interface ModelSummary {
  facts: { evidenceIndex: number; text: string }[];
  hypotheses: string[];
  answerDraft: string;
  proposedChanges: string[];
  risks: string[];
}

export interface ChangePlan {
  planId: string;
  version: number;
  requestRevision: string;
  repoId: string;
  baseCommit: string;
  objective: string;
  allowedFiles: string[];
  proposedChanges: string[];
  testCommandIds: string[];
  risks: string[];
  planHash: string;
}

export interface CheckResult {
  name: string;
  status: 'passed' | 'failed' | 'not_run';
  reason: string;
}

export interface TaskReport {
  summary: string;
  facts: ModelSummary['facts'];
  hypotheses: string[];
  evidence: Evidence[];
  answerDraft: string;
  questions: string[];
  risks: string[];
  checks: CheckResult[];
  nextApproval: string;
}

export interface Task {
  taskId: string;
  eventId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs?: string;
  requesterId: string;
  requestRevision: string;
  classification: Classification | null;
  status: TaskStatus;
  repoId: string;
  baseCommit: string;
  createdAt: string;
  updatedAt: string;
  history: TaskStatus[];
  plan: ChangePlan | null;
  report: TaskReport | null;
  failureCode: string | null;
}
