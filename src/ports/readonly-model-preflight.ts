import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { ReadonlyModelPreflightPayload, ReadonlyModelPreflightPlan, ReadonlyModelPreflightResult, ReadonlyModelPreflightDispatch, ReadonlyModelPreflightDecodedResponse } from '../domain/readonly-model-preflight.js';

/** 가짜 전송기는 승인한 최종 요청 본문 하나만 받는다. 로컬 저장소 identity는 이 경계를 넘지 않는다. */
export interface ReadonlyModelPreflightPort {
  readonly mode: 'offline';
  readonly transport: 'in-memory-fake';
  /** Resolve/reject only after the worker and its transport have closed. */
  transmit(request: ReadonlyModelPreflightDispatch, signal: AbortSignal): Promise<ReadonlyModelPreflightDecodedResponse>;
}
export type ReadonlyModelPreflightStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'REPORTED'
  | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'INTERRUPTED';
export interface ReadonlyModelPreflightTask {
  investigationId: string;
  plan: ReadonlyModelPreflightPlan;
  status: ReadonlyModelPreflightStatus;
  generation: number;
  updatedAt: string;
  terminalAt: string | null;
  failureCode: string | null;
  reportHash: string | null;
}
export interface ReadonlyModelPreflightApprovalRequest { investigationId: string; planHash: string; expiresInMinutes: number }
export interface ReadonlyModelPreflightRunRequest { investigationId: string; planHash: string }
export interface ReadonlyModelPreflightApproval {
  approvalId: string;
  investigationId: string;
  ownerId: string;
  planHash: string;
  planSnapshot: ReadonlyModelPreflightPlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}
export interface ReadonlyModelPreflightAttempt {
  attemptId: string;
  investigationId: string;
  approvalId: string;
  planHash: string;
  inputHash: string;
  requestBodyHash: string;
  connectionProfileHash: string;
  requestEnvelopeHash: string;
  configHash: string;
  generation: number;
  status: Exclude<ReadonlyModelPreflightStatus, 'AWAITING_APPROVAL' | 'APPROVED'>;
  startedAt: string;
  dispatchedAt: string | null;
  finishedAt: string | null;
  failureCode: string | null;
  responseHash: string | null;
}
export interface ReadonlyModelPreflightReport {
  mode: 'offline';
  transport: 'in-memory-fake';
  responseOrigin: 'synthetic';
  investigationId: string;
  planHash: string;
  contextHash: string;
  inputHash: string;
  requestBodyHash: string;
  connectionProfileHash: string;
  requestEnvelopeHash: string;
  responseHash: string;
  result: Omit<ReadonlyModelPreflightResult, 'mode' | 'transport' | 'responseOrigin' | 'responseHash'>;
  createdAt: string;
  targetUnchanged: true;
  executionAllowed: false;
  semanticAccuracyVerified: false;
  liveReady: false;
  offlineContractVerified: { profile: 'passed'; envelope: 'passed'; response: 'passed'; evidence: 'passed' };
  excludedOperationsReason: 'offline-fake-only';
  checks: { sourceUnchanged: 'passed'; targetCodeExecution: 'not_run'; realModel: 'not_run'; externalTransmission: 'not_run'; credentialAccess: 'not_run'; providerCompatibility: 'not_run'; liveIsolation: 'not_run'; semanticAccuracy: 'not_run' };
}
export interface ReadonlyModelPreflightSnapshot {
  task: ReadonlyModelPreflightTask;
  approvals: ReadonlyModelPreflightApproval[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
  attempt: ReadonlyModelPreflightAttempt | null;
  payload: ReadonlyModelPreflightPayload | null;
  report: ReadonlyModelPreflightReport | null;
  payloadExpired: boolean;
}
export interface ReadonlyModelPreflightPruneResult { payloadsRemoved: number; auditsRemoved: number }
export interface ReadonlyModelPreflightStore {
  create(plan: ReadonlyModelPreflightPlan, payload: ReadonlyModelPreflightPayload, context: ReadonlyContext): ReadonlyModelPreflightSnapshot;
  inspect(id: string, context: ReadonlyContext, offset?: number): ReadonlyModelPreflightSnapshot;
  approve(request: ReadonlyModelPreflightApprovalRequest, context: ReadonlyContext): ReadonlyModelPreflightApproval;
  claim(request: ReadonlyModelPreflightRunRequest, context: ReadonlyContext): ReadonlyModelPreflightAttempt;
  assertRunnable(id: string, generation: number, context: ReadonlyContext): void;
  dispatch<T>(id: string, generation: number, context: ReadonlyContext, invoke: (request: ReadonlyModelPreflightDispatch) => T): T;
  finish(id: string, generation: number, report: ReadonlyModelPreflightReport | null, failureCode: string | null, context: ReadonlyContext): ReadonlyModelPreflightSnapshot;
  cancel(id: string, context: ReadonlyContext): ReadonlyModelPreflightSnapshot;
  invalidate(id: string, context: ReadonlyContext): ReadonlyModelPreflightSnapshot;
  recover(id: string, context: ReadonlyContext, cleanupConfirmed?: boolean): ReadonlyModelPreflightSnapshot;
  prune(context: ReadonlyContext): ReadonlyModelPreflightPruneResult;
  close(): void;
}
