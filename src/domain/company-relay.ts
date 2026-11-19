import type { CompanyInvestigationAttempt, CompanyInvestigationPayload, CompanyInvestigationPreparationPort,
  CompanyInvestigationSourcePort, CompanyInvestigationStatus } from './company-investigation.js';
import type { CompanyReadonlyPlanV3 } from './company-readonly-v3.js';
import type { ReadonlyContext, ReadonlyReport } from './readonly-investigation.js';
import type { ReadonlyRelayExecutionBudget } from './readonly-relay-budget.js';
import type { ReadonlyRelayConfig, ReadonlyRelayRequestEnvelope, READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS } from './readonly-relay.js';
import type { ReadonlyRelayVerification } from '../ports/readonly-relay.js';

/** Operator declarations and account binding are separate from a single-use plan approval. */
export interface CompanyRelayAuthorization {
  version: 'company-relay-authorization-v1';
  enabled: boolean;
  companyTransmissionApproved: boolean;
  providerTermsConfirmed: boolean;
  accountIdHash: string;
  config: ReadonlyRelayConfig;
}
export interface CompanyRelayPlan {
  version: 'company-relay-plan-v1';
  id: string;
  ownerId: string;
  preparation: CompanyReadonlyPlanV3;
  preparationRuntimeHash: string;
  mode: 'live';
  model: 'gpt-6.1-sol';
  destination: 'https://chatgpt.com/backend-api/codex/responses';
  authentication: 'chatgpt';
  transport: 'codex-cli-relay';
  profileId: 'codex-chatgpt-relay-v3';
  serializerVersion: 'readonly-relay-json-v1';
  configSnapshot: ReadonlyRelayConfig;
  configHash: string;
  policyDeclaration: CompanyRelayAuthorization;
  policyDeclarationHash: string;
  accountIdHash: string;
  inputHash: string;
  requestBodyHash: string;
  requestEnvelopeHash: string;
  connectionProfileHash: string;
  executionBudget: ReadonlyRelayExecutionBudget;
  executionBudgetHash: string;
  createdAt: string;
  expiresAt: string;
  auditExpiresAt: string;
  preparationKey: string;
  planHash: string;
  transmissionAllowed: true;
  executionAllowed: false;
}
export interface CompanyRelayPayload extends CompanyInvestigationPayload {
  profileId: 'codex-chatgpt-relay-v3';
  requestBody: string;
  requestBodyHash: string;
  requestEnvelope: ReadonlyRelayRequestEnvelope;
  requestEnvelopeHash: string;
  connectionProfileHash: string;
}
export interface CompanyRelayReport {
  version: 'company-relay-report-v1';
  investigationId: string;
  planHash: string;
  preparationId: string;
  createdAt: string;
  mode: 'live';
  transport: 'codex-cli-relay';
  result: ReadonlyReport;
  resultHash: string;
  responseHash: string;
  finalTextHash: string;
  verification: ReadonlyRelayVerification;
  unverifiedResponseChecks: typeof READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS;
  sourceUnchanged: true;
  semanticAccuracyVerified: false;
  realModel: 'passed' | 'not_run';
  nativeExecution: 'passed' | 'not_run';
  credentialAccess: 'passed' | 'not_run';
  externalTransmission: 'passed' | 'not_run';
  executionAllowed: false;
}
export interface CompanyRelayRequest { investigationId: string; planHash: string }
export interface CompanyRelayApprovalRequest extends CompanyRelayRequest { expiresInMinutes: number }
export interface CompanyRelayApproval {
  id: string;
  investigationId: string;
  ownerId: string;
  planHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  mode: 'live';
  transmissionAllowed: true;
  executionAllowed: false;
}
export type CompanyRelayAttempt = CompanyInvestigationAttempt;
export type CompanyRelayStatus = CompanyInvestigationStatus;
export interface CompanyRelaySnapshot {
  plan: CompanyRelayPlan;
  status: CompanyRelayStatus;
  updatedAt: string;
  payload: CompanyRelayPayload | null;
  approval: CompanyRelayApproval | null;
  attempt: CompanyRelayAttempt | null;
  report: CompanyRelayReport | null;
}
export interface CompanyRelayPruneResult { payloads: number; reports: number; records: number }
export interface CompanyRelayStore {
  create(plan: CompanyRelayPlan, payload: CompanyRelayPayload, context: ReadonlyContext): CompanyRelaySnapshot;
  inspect(id: string, context: ReadonlyContext): CompanyRelaySnapshot;
  approve(request: CompanyRelayApprovalRequest, context: ReadonlyContext): CompanyRelaySnapshot;
  claim(request: CompanyRelayRequest, context: ReadonlyContext): CompanyRelaySnapshot;
  dispatch(id: string, attemptId: string, context: ReadonlyContext): CompanyRelayPayload;
  assertRunnable(id: string, attemptId: string, context: ReadonlyContext): void;
  finish(id: string, attemptId: string, report: CompanyRelayReport | null, failureCode: string | null, context: ReadonlyContext): CompanyRelaySnapshot;
  cancel(id: string, context: ReadonlyContext): CompanyRelaySnapshot;
  recover(id: string, context: ReadonlyContext): CompanyRelaySnapshot;
  prune(context: ReadonlyContext): CompanyRelayPruneResult;
  close(): void;
}
export type CompanyRelayPreparationPort = CompanyInvestigationPreparationPort;
export type CompanyRelaySourcePort = CompanyInvestigationSourcePort;
