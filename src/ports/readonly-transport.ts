import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { ReadonlyTransportPayload, ReadonlyTransportPlan, ReadonlyTransportResult } from '../domain/readonly-transport.js';

/** 가짜 전송기는 승인한 최종 요청 본문 하나만 받는다. 로컬 저장소 identity는 이 경계를 넘지 않는다. */
export interface ReadonlyTransportPort {
  readonly mode: 'offline';
  readonly transport: 'fake';
  /** Resolve/reject only after the worker and its transport have closed. */
  transmit(requestBody: string, signal: AbortSignal): Promise<Uint8Array>;
}
export type ReadonlyTransportStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'REPORTED'
  | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'INTERRUPTED';
export interface ReadonlyTransportTask {
  investigationId: string;
  plan: ReadonlyTransportPlan;
  status: ReadonlyTransportStatus;
  generation: number;
  updatedAt: string;
  terminalAt: string | null;
  failureCode: string | null;
  reportHash: string | null;
}
export interface ReadonlyTransportApprovalRequest { investigationId: string; planHash: string; expiresInMinutes: number }
export interface ReadonlyTransportRunRequest { investigationId: string; planHash: string }
export interface ReadonlyTransportApproval {
  approvalId: string;
  investigationId: string;
  ownerId: string;
  planHash: string;
  planSnapshot: ReadonlyTransportPlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}
export interface ReadonlyTransportAttempt {
  attemptId: string;
  investigationId: string;
  approvalId: string;
  planHash: string;
  inputHash: string;
  requestBodyHash: string;
  configHash: string;
  generation: number;
  status: Exclude<ReadonlyTransportStatus, 'AWAITING_APPROVAL' | 'APPROVED'>;
  startedAt: string;
  dispatchedAt: string | null;
  finishedAt: string | null;
  failureCode: string | null;
  responseHash: string | null;
}
export interface ReadonlyTransportReport {
  mode: 'offline';
  transport: 'fake';
  responseOrigin: 'synthetic';
  investigationId: string;
  planHash: string;
  contextHash: string;
  inputHash: string;
  requestBodyHash: string;
  responseHash: string;
  result: Omit<ReadonlyTransportResult, 'mode' | 'transport' | 'responseOrigin' | 'responseHash'>;
  createdAt: string;
  targetUnchanged: true;
  executionAllowed: false;
  semanticAccuracyVerified: false;
  excludedOperationsReason: 'offline-fake-only';
  checks: { sourceUnchanged: 'passed'; targetCodeExecution: 'not_run'; realModel: 'not_run'; externalTransmission: 'not_run'; credentialAccess: 'not_run'; providerCompatibility: 'not_run' };
}
export interface ReadonlyTransportSnapshot {
  task: ReadonlyTransportTask;
  approvals: ReadonlyTransportApproval[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
  attempt: ReadonlyTransportAttempt | null;
  payload: ReadonlyTransportPayload | null;
  report: ReadonlyTransportReport | null;
  payloadExpired: boolean;
}
export interface ReadonlyTransportPruneResult { payloadsRemoved: number; auditsRemoved: number }
export interface ReadonlyTransportStore {
  create(plan: ReadonlyTransportPlan, payload: ReadonlyTransportPayload, context: ReadonlyContext): ReadonlyTransportSnapshot;
  inspect(id: string, context: ReadonlyContext, offset?: number): ReadonlyTransportSnapshot;
  approve(request: ReadonlyTransportApprovalRequest, context: ReadonlyContext): ReadonlyTransportApproval;
  claim(request: ReadonlyTransportRunRequest, context: ReadonlyContext): ReadonlyTransportAttempt;
  assertRunnable(id: string, generation: number, context: ReadonlyContext): void;
  dispatch<T>(id: string, generation: number, context: ReadonlyContext, invoke: (requestBody: string) => T): T;
  finish(id: string, generation: number, report: ReadonlyTransportReport | null, failureCode: string | null, context: ReadonlyContext): ReadonlyTransportSnapshot;
  cancel(id: string, context: ReadonlyContext): ReadonlyTransportSnapshot;
  invalidate(id: string, context: ReadonlyContext): ReadonlyTransportSnapshot;
  recover(id: string, context: ReadonlyContext, cleanupConfirmed?: boolean): ReadonlyTransportSnapshot;
  prune(context: ReadonlyContext): ReadonlyTransportPruneResult;
  close(): void;
}
