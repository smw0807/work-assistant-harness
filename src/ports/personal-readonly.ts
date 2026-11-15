import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { PersonalReadonlyPayload, PersonalReadonlyPlan } from '../domain/personal-readonly.js';
import type { ReadonlyRelayResult, ReadonlyRelayDispatch } from '../domain/readonly-relay.js';
import type { ReadonlyRelayVerification } from './readonly-relay.js';
import type { READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS } from '../domain/readonly-relay.js';

export type PersonalReadonlyStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'REPORTED'
  | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'INTERRUPTED';
export interface PersonalReadonlyTask {
  investigationId: string;
  plan: PersonalReadonlyPlan;
  status: PersonalReadonlyStatus;
  generation: number;
  updatedAt: string;
  terminalAt: string | null;
  failureCode: string | null;
  reportHash: string | null;
}
export interface PersonalReadonlyApprovalRequest { investigationId: string; planHash: string; expiresInMinutes: number }
export interface PersonalReadonlyRunRequest { investigationId: string; planHash: string }
export interface PersonalReadonlyApproval {
  approvalId: string;
  investigationId: string;
  ownerId: string;
  planHash: string;
  planSnapshot: PersonalReadonlyPlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}
export interface PersonalReadonlyAttempt {
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
  status: Exclude<PersonalReadonlyStatus, 'AWAITING_APPROVAL' | 'APPROVED'>;
  startedAt: string;
  dispatchedAt: string | null;
  finishedAt: string | null;
  failureCode: string | null;
  responseHash: string | null;
  finalTextHash: string | null;
}
export interface PersonalReadonlyReport {
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
export interface PersonalReadonlySnapshot {
  task: PersonalReadonlyTask;
  approvals: PersonalReadonlyApproval[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
  attempt: PersonalReadonlyAttempt | null;
  payload: PersonalReadonlyPayload | null;
  report: PersonalReadonlyReport | null;
  payloadExpired: boolean;
}
export interface PersonalReadonlyPruneResult { payloadsRemoved: number; auditsRemoved: number }
export interface PersonalReadonlyStore {
  create(plan: PersonalReadonlyPlan, payload: PersonalReadonlyPayload, context: ReadonlyContext): PersonalReadonlySnapshot;
  inspect(id: string, context: ReadonlyContext, offset?: number): PersonalReadonlySnapshot;
  approve(request: PersonalReadonlyApprovalRequest, context: ReadonlyContext): PersonalReadonlyApproval;
  claim(request: PersonalReadonlyRunRequest, context: ReadonlyContext): PersonalReadonlyAttempt;
  assertRunnable(id: string, generation: number, context: ReadonlyContext): void;
  dispatch<T>(id: string, generation: number, context: ReadonlyContext, invoke: (request: ReadonlyRelayDispatch) => T): T;
  finish(id: string, generation: number, report: PersonalReadonlyReport | null, failureCode: string | null, context: ReadonlyContext): PersonalReadonlySnapshot;
  cancel(id: string, context: ReadonlyContext): PersonalReadonlySnapshot;
  invalidate(id: string, context: ReadonlyContext): PersonalReadonlySnapshot;
  recover(id: string, context: ReadonlyContext, cleanupConfirmed?: boolean): PersonalReadonlySnapshot;
  prune(context: ReadonlyContext): PersonalReadonlyPruneResult;
  close(): void;
}
