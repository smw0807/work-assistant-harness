import type { ReadonlyContext, ReadonlyPayload, ReadonlyPlan, ReadonlyResult } from '../domain/readonly-investigation.js';

/** 모델은 승인한 직렬화 입력 하나만 받는다. 로컬 저장소 identity는 이 경계를 넘지 않는다. */
export interface ReadonlyModelPort {
  readonly mode: 'mock';
  /** Resolve/reject only after the worker and its transport have closed. */
  investigate(inputText: string, signal: AbortSignal): Promise<string>;
}
export type ReadonlyStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'REPORTED'
  | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'INTERRUPTED';
export interface ReadonlyTask {
  investigationId: string;
  plan: ReadonlyPlan;
  status: ReadonlyStatus;
  generation: number;
  updatedAt: string;
  terminalAt: string | null;
  failureCode: string | null;
  reportHash: string | null;
}
export interface ReadonlyApprovalRequest { investigationId: string; planHash: string; expiresInMinutes: number }
export interface ReadonlyRunRequest { investigationId: string; planHash: string }
export interface ReadonlyApproval {
  approvalId: string;
  investigationId: string;
  ownerId: string;
  planHash: string;
  planSnapshot: ReadonlyPlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}
export interface ReadonlyAttempt {
  attemptId: string;
  investigationId: string;
  approvalId: string;
  planHash: string;
  generation: number;
  status: Exclude<ReadonlyStatus, 'AWAITING_APPROVAL' | 'APPROVED'>;
  startedAt: string;
  dispatchedAt: string | null;
  finishedAt: string | null;
  failureCode: string | null;
  responseHash: string | null;
}
export interface ReadonlyReport {
  mode: 'mock';
  investigationId: string;
  planHash: string;
  contextHash: string;
  inputHash: string;
  responseHash: string;
  result: Omit<ReadonlyResult, 'mode' | 'responseHash'>;
  createdAt: string;
  targetUnchanged: true;
  executionAllowed: false;
  semanticAccuracyVerified: false;
  checks: { sourceUnchanged: 'passed'; targetCodeExecution: 'not_run'; realModel: 'not_run'; externalTransmission: 'not_run' };
}
export interface ReadonlySnapshot {
  task: ReadonlyTask;
  approvals: ReadonlyApproval[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
  attempt: ReadonlyAttempt | null;
  payload: ReadonlyPayload | null;
  report: ReadonlyReport | null;
  payloadExpired: boolean;
}
export interface ReadonlyPruneResult { payloadsRemoved: number; auditsRemoved: number }
export interface ReadonlyInvestigationStore {
  create(plan: ReadonlyPlan, payload: ReadonlyPayload, context: ReadonlyContext): ReadonlySnapshot;
  inspect(id: string, context: ReadonlyContext, offset?: number): ReadonlySnapshot;
  approve(request: ReadonlyApprovalRequest, context: ReadonlyContext): ReadonlyApproval;
  claim(request: ReadonlyRunRequest, context: ReadonlyContext): ReadonlyAttempt;
  assertRunnable(id: string, generation: number, context: ReadonlyContext): void;
  dispatch<T>(id: string, generation: number, context: ReadonlyContext, invoke: (inputText: string) => T): T;
  finish(id: string, generation: number, report: ReadonlyReport | null, failureCode: string | null, context: ReadonlyContext): ReadonlySnapshot;
  cancel(id: string, context: ReadonlyContext): ReadonlySnapshot;
  invalidate(id: string, context: ReadonlyContext): ReadonlySnapshot;
  recover(id: string, context: ReadonlyContext, cleanupConfirmed?: boolean): ReadonlySnapshot;
  prune(context: ReadonlyContext): ReadonlyPruneResult;
  close(): void;
}
