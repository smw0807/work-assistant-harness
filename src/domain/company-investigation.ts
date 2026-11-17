import type { CompanyReadonlyPayloadV3, CompanyReadonlyPlanV3, CompanyReadonlySnapshotV3 } from './company-readonly-v3.js';
import type { ReadonlyContext, ReadonlyReport } from './readonly-investigation.js';
import type { ReadonlyRelayExecutionBudget } from './readonly-relay-budget.js';

/** This contract authorizes only the local fixed-response adapter, never a live relay. */
export interface CompanyInvestigationPlan {
  version: 'company-investigation-plan-v1';
  id: string;
  ownerId: string;
  preparation: CompanyReadonlyPlanV3;
  preparationRuntimeHash: string;
  mode: 'mock';
  model: 'company-fixed-response-v1';
  destination: 'local:fixed-response';
  authentication: 'none';
  inputHash: string;
  executionBudget: ReadonlyRelayExecutionBudget;
  executionBudgetHash: string;
  createdAt: string;
  expiresAt: string;
  auditExpiresAt: string;
  preparationKey: string;
  planHash: string;
  transmissionAllowed: false;
  executionAllowed: false;
}

export interface CompanyInvestigationPayload {
  preparation: CompanyReadonlyPayloadV3;
  inputText: string;
}

export interface CompanyInvestigationReport {
  version: 'company-investigation-report-v1';
  investigationId: string;
  planHash: string;
  preparationId: string;
  createdAt: string;
  mode: 'mock';
  result: ReadonlyReport;
  responseHash: string;
  sourceUnchanged: true;
  semanticAccuracyVerified: false;
  realModel: 'not_run';
  nativeExecution: 'not_run';
  credentialAccess: 'not_run';
  externalTransmission: 'not_run';
  executionAllowed: false;
}

export interface CompanyInvestigationRequest { investigationId: string; planHash: string }
export interface CompanyInvestigationApprovalRequest extends CompanyInvestigationRequest { expiresInMinutes: number }
export interface CompanyInvestigationApproval {
  id: string;
  investigationId: string;
  ownerId: string;
  planHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  mode: 'mock';
  transmissionAllowed: false;
  executionAllowed: false;
}
export interface CompanyInvestigationAttempt {
  id: string;
  startedAt: string;
  dispatchedAt: string | null;
  endedAt: string | null;
  failureCode: string | null;
}
export type CompanyInvestigationStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'REPORTED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'BLOCKED';
export interface CompanyInvestigationSnapshot {
  plan: CompanyInvestigationPlan;
  status: CompanyInvestigationStatus;
  updatedAt: string;
  payload: CompanyInvestigationPayload | null;
  approval: CompanyInvestigationApproval | null;
  attempt: CompanyInvestigationAttempt | null;
  report: CompanyInvestigationReport | null;
}
export interface CompanyInvestigationPruneResult { payloads: number; reports: number; records: number }

export interface CompanyInvestigationStore {
  create(plan: CompanyInvestigationPlan, payload: CompanyInvestigationPayload, context: ReadonlyContext): CompanyInvestigationSnapshot;
  inspect(id: string, context: ReadonlyContext): CompanyInvestigationSnapshot;
  approve(request: CompanyInvestigationApprovalRequest, context: ReadonlyContext): CompanyInvestigationSnapshot;
  claim(request: CompanyInvestigationRequest, context: ReadonlyContext): CompanyInvestigationSnapshot;
  dispatch(id: string, attemptId: string, context: ReadonlyContext): CompanyInvestigationPayload;
  assertRunnable(id: string, attemptId: string, context: ReadonlyContext): void;
  finish(id: string, attemptId: string, report: CompanyInvestigationReport | null, failureCode: string | null, context: ReadonlyContext): CompanyInvestigationSnapshot;
  cancel(id: string, context: ReadonlyContext): CompanyInvestigationSnapshot;
  recover(id: string, context: ReadonlyContext): CompanyInvestigationSnapshot;
  prune(context: ReadonlyContext): CompanyInvestigationPruneResult;
  close(): void;
}

export interface CompanyInvestigationPreparationPort {
  readonly runtimeHash: string;
  inspect(id: string, context: ReadonlyContext): CompanyReadonlySnapshotV3;
}
export interface CompanyInvestigationSourcePort { verify(payload: CompanyReadonlyPayloadV3): void }
export interface CompanyInvestigationModelPort {
  readonly mode: 'mock';
  investigate(inputText: string, signal: AbortSignal): Promise<string>;
}
