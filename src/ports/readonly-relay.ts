import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { ReadonlyRelayPayload, ReadonlyRelayPlan, ReadonlyRelayResult, ReadonlyRelayDispatch, ReadonlyRelayDecodedResponse } from '../domain/readonly-relay.js';
import type { READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS } from '../domain/readonly-relay.js';

export interface ReadonlyRelayVerification {
  transport: 'live' | 'fake';
  upstreamCalls: 1;
  isolation: 'passed' | 'not_run';
  credentialAccess: 'passed' | 'not_run';
  responseValidation: 'codex-native-output-v1';
  relayCompleted: true;
  credentialReflection: 'passed';
}
export interface ReadonlyRelayTransmissionResult extends ReadonlyRelayDecodedResponse {
  verification: ReadonlyRelayVerification;
}

/** 승인된 최종 요청 하나만 전달한다. 저장소 identity와 인증은 이 입력에 포함하지 않는다. */
export interface ReadonlyRelayPort {
  readonly mode: 'live';
  readonly transport: 'codex-cli-relay';
  /** Local read-only readiness only; must not load credentials, start a process, or open a connection. */
  verifyReady?(): Promise<void>;
  /** Resolve/reject only after the worker and its transport have closed. */
  transmit(request: ReadonlyRelayDispatch, signal: AbortSignal, beforeTransmission: () => void,
    beforeCredentialAccess: () => void): Promise<ReadonlyRelayTransmissionResult>;
}
export type ReadonlyRelayStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'REPORTED'
  | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'INTERRUPTED';
export interface ReadonlyRelayTask {
  investigationId: string;
  plan: ReadonlyRelayPlan;
  status: ReadonlyRelayStatus;
  generation: number;
  updatedAt: string;
  terminalAt: string | null;
  failureCode: string | null;
  reportHash: string | null;
}
export interface ReadonlyRelayApprovalRequest { investigationId: string; planHash: string; expiresInMinutes: number }
export interface ReadonlyRelayRunRequest { investigationId: string; planHash: string }
export interface ReadonlyRelayApproval {
  approvalId: string;
  investigationId: string;
  ownerId: string;
  planHash: string;
  planSnapshot: ReadonlyRelayPlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}
export interface ReadonlyRelayAttempt {
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
  status: Exclude<ReadonlyRelayStatus, 'AWAITING_APPROVAL' | 'APPROVED'>;
  startedAt: string;
  dispatchedAt: string | null;
  finishedAt: string | null;
  failureCode: string | null;
  responseHash: string | null;
  finalTextHash: string | null;
}
export interface ReadonlyRelayReport {
  mode: 'live';
  transport: 'codex-cli-relay';
  responseOrigin: 'model';
  investigationId: string;
  planHash: string;
  contextHash: string;
  inputHash: string;
  requestBodyHash: string;
  connectionProfileHash: string;
  requestEnvelopeHash: string;
  responseHash: string;
  finalTextHash: string;
  result: Omit<ReadonlyRelayResult, 'mode' | 'transport' | 'responseOrigin' | 'responseHash'>;
  createdAt: string;
  targetUnchanged: true;
  executionAllowed: false;
  semanticAccuracyVerified: false;
  verification: ReadonlyRelayVerification;
  contractVerified: { profile: 'passed'; envelope: 'passed'; cliOutput: 'passed'; evidence: 'passed' };
  unverifiedResponseChecks: typeof READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS;
  excludedOperationsReason: 'readonly-relay-only';
  checks: { sourceUnchanged: 'passed'; targetCodeExecution: 'not_run'; realModel: 'passed' | 'not_run'; externalTransmission: 'passed' | 'not_run'; credentialAccess: 'passed' | 'not_run'; providerCompatibility: 'passed' | 'not_run'; liveIsolation: 'passed' | 'not_run'; semanticAccuracy: 'not_run' };
}
export interface ReadonlyRelaySnapshot {
  task: ReadonlyRelayTask;
  approvals: ReadonlyRelayApproval[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
  attempt: ReadonlyRelayAttempt | null;
  payload: ReadonlyRelayPayload | null;
  report: ReadonlyRelayReport | null;
  payloadExpired: boolean;
}
export interface ReadonlyRelayPruneResult { payloadsRemoved: number; auditsRemoved: number }
export interface ReadonlyRelayStore {
  create(plan: ReadonlyRelayPlan, payload: ReadonlyRelayPayload, context: ReadonlyContext): ReadonlyRelaySnapshot;
  inspect(id: string, context: ReadonlyContext, offset?: number): ReadonlyRelaySnapshot;
  approve(request: ReadonlyRelayApprovalRequest, context: ReadonlyContext): ReadonlyRelayApproval;
  claim(request: ReadonlyRelayRunRequest, context: ReadonlyContext): ReadonlyRelayAttempt;
  assertRunnable(id: string, generation: number, context: ReadonlyContext): void;
  dispatch<T>(id: string, generation: number, context: ReadonlyContext, invoke: (request: ReadonlyRelayDispatch) => T): T;
  finish(id: string, generation: number, report: ReadonlyRelayReport | null, failureCode: string | null, context: ReadonlyContext): ReadonlyRelaySnapshot;
  cancel(id: string, context: ReadonlyContext): ReadonlyRelaySnapshot;
  invalidate(id: string, context: ReadonlyContext): ReadonlyRelaySnapshot;
  recover(id: string, context: ReadonlyContext, cleanupConfirmed?: boolean): ReadonlyRelaySnapshot;
  prune(context: ReadonlyContext): ReadonlyRelayPruneResult;
  close(): void;
}
