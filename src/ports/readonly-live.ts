import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { ReadonlyLivePayload, ReadonlyLivePlan, ReadonlyLiveResult, ReadonlyLiveDispatch, ReadonlyLiveDecodedResponse } from '../domain/readonly-live.js';

export interface ReadonlyLiveVerification {
  transport: 'live' | 'fake';
  upstreamCalls: 1;
  isolation: 'passed' | 'not_run';
  credentialAccess: 'passed' | 'not_run';
}
export interface ReadonlyLiveTransmissionResult extends ReadonlyLiveDecodedResponse {
  verification: ReadonlyLiveVerification;
}

/** 승인된 최종 요청 하나만 전달한다. 저장소 identity와 인증은 이 입력에 포함하지 않는다. */
export interface ReadonlyLivePort {
  readonly mode: 'live';
  readonly transport: 'codex-cli-broker';
  /** Local read-only readiness only; must not load credentials, start a process, or open a connection. */
  verifyReady?(): Promise<void>;
  /** Resolve/reject only after the worker and its transport have closed. */
  transmit(request: ReadonlyLiveDispatch, signal: AbortSignal, beforeTransmission: () => void): Promise<ReadonlyLiveTransmissionResult>;
}
export type ReadonlyLiveStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'REPORTED'
  | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'INTERRUPTED';
export interface ReadonlyLiveTask {
  investigationId: string;
  plan: ReadonlyLivePlan;
  status: ReadonlyLiveStatus;
  generation: number;
  updatedAt: string;
  terminalAt: string | null;
  failureCode: string | null;
  reportHash: string | null;
}
export interface ReadonlyLiveApprovalRequest { investigationId: string; planHash: string; expiresInMinutes: number }
export interface ReadonlyLiveRunRequest { investigationId: string; planHash: string }
export interface ReadonlyLiveApproval {
  approvalId: string;
  investigationId: string;
  ownerId: string;
  planHash: string;
  planSnapshot: ReadonlyLivePlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}
export interface ReadonlyLiveAttempt {
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
  status: Exclude<ReadonlyLiveStatus, 'AWAITING_APPROVAL' | 'APPROVED'>;
  startedAt: string;
  dispatchedAt: string | null;
  finishedAt: string | null;
  failureCode: string | null;
  responseHash: string | null;
}
export interface ReadonlyLiveReport {
  mode: 'live';
  transport: 'codex-cli-broker';
  responseOrigin: 'model';
  investigationId: string;
  planHash: string;
  contextHash: string;
  inputHash: string;
  requestBodyHash: string;
  connectionProfileHash: string;
  requestEnvelopeHash: string;
  responseHash: string;
  result: Omit<ReadonlyLiveResult, 'mode' | 'transport' | 'responseOrigin' | 'responseHash'>;
  createdAt: string;
  targetUnchanged: true;
  executionAllowed: false;
  semanticAccuracyVerified: false;
  verification: ReadonlyLiveVerification;
  contractVerified: { profile: 'passed'; envelope: 'passed'; response: 'passed'; evidence: 'passed' };
  excludedOperationsReason: 'readonly-live-only';
  checks: { sourceUnchanged: 'passed'; targetCodeExecution: 'not_run'; realModel: 'passed' | 'not_run'; externalTransmission: 'passed' | 'not_run'; credentialAccess: 'passed' | 'not_run'; providerCompatibility: 'passed' | 'not_run'; liveIsolation: 'passed' | 'not_run'; semanticAccuracy: 'not_run' };
}
export interface ReadonlyLiveSnapshot {
  task: ReadonlyLiveTask;
  approvals: ReadonlyLiveApproval[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
  attempt: ReadonlyLiveAttempt | null;
  payload: ReadonlyLivePayload | null;
  report: ReadonlyLiveReport | null;
  payloadExpired: boolean;
}
export interface ReadonlyLivePruneResult { payloadsRemoved: number; auditsRemoved: number }
export interface ReadonlyLiveStore {
  create(plan: ReadonlyLivePlan, payload: ReadonlyLivePayload, context: ReadonlyContext): ReadonlyLiveSnapshot;
  inspect(id: string, context: ReadonlyContext, offset?: number): ReadonlyLiveSnapshot;
  approve(request: ReadonlyLiveApprovalRequest, context: ReadonlyContext): ReadonlyLiveApproval;
  claim(request: ReadonlyLiveRunRequest, context: ReadonlyContext): ReadonlyLiveAttempt;
  assertRunnable(id: string, generation: number, context: ReadonlyContext): void;
  dispatch<T>(id: string, generation: number, context: ReadonlyContext, invoke: (request: ReadonlyLiveDispatch) => T): T;
  finish(id: string, generation: number, report: ReadonlyLiveReport | null, failureCode: string | null, context: ReadonlyContext): ReadonlyLiveSnapshot;
  cancel(id: string, context: ReadonlyContext): ReadonlyLiveSnapshot;
  invalidate(id: string, context: ReadonlyContext): ReadonlyLiveSnapshot;
  recover(id: string, context: ReadonlyContext, cleanupConfirmed?: boolean): ReadonlyLiveSnapshot;
  prune(context: ReadonlyContext): ReadonlyLivePruneResult;
  close(): void;
}
