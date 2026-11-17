import type { CompanyInvestigationSnapshot, CompanyInvestigationStatus } from '../domain/company-investigation.js';
import { HarnessError } from '../domain/errors.js';
import { isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import { companyPath } from './company-readonly-files.js';

export type CompanyInvestigationCommand = 'plan' | 'inspect' | 'approve' | 'run' | 'cancel' | 'recover' | 'prune';
export interface CompanyInvestigationWorkerOptions {
  version: 'company-investigation-worker-v1';
  command: CompanyInvestigationCommand;
  sourceDirectory: string;
  runtimeDirectory: string;
  preparationDirectory: string | null;
  preparationId: string | null;
  taskId: string | null;
  planHash: string | null;
  expiresInMinutes: number | null;
}
export const companyInvestigationDisabled = Object.freeze({
  mode: 'mock' as const, transmissionAllowed: false as const, executionAllowed: false as const,
  nativeExecution: 'not_run' as const, realModel: 'not_run' as const,
  credentialAccess: 'not_run' as const, externalTransmission: 'not_run' as const,
});
export interface CompanyInvestigationSummary {
  version: 'company-investigation-result-v1';
  command: CompanyInvestigationCommand;
  taskId: string | null;
  status: CompanyInvestigationStatus | 'PRUNED' | 'NOT_FOUND';
  planHash: string | null;
  expiresAt: string | null;
  auditExpiresAt: string | null;
  approval: 'none' | 'active' | 'used' | 'revoked';
  attempts: number;
  mockCalls: number;
  reportAvailable: boolean;
  prunedPayloads: number;
  prunedReports: number;
  prunedRecords: number;
  mode: 'mock';
  transmissionAllowed: false;
  executionAllowed: false;
  nativeExecution: 'not_run';
  realModel: 'not_run';
  credentialAccess: 'not_run';
  externalTransmission: 'not_run';
}
const reject = (): never => { throw new HarnessError('COMPANY_INVESTIGATION_INVALID_PROTOCOL'); };
const commands = ['plan', 'inspect', 'approve', 'run', 'cancel', 'recover', 'prune'];
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const parseCompanyInvestigationWorkerOptions = (raw: string): CompanyInvestigationWorkerOptions => {
  const input = parseReadonlyTransportJson(raw, 16_384);
  if (!readonlyExactKeys(input, ['version', 'command', 'sourceDirectory', 'runtimeDirectory', 'preparationDirectory', 'preparationId', 'taskId', 'planHash', 'expiresInMinutes'])) reject();
  const value = input as unknown as CompanyInvestigationWorkerOptions;
  if (value.version !== 'company-investigation-worker-v1' || !commands.includes(value.command)) reject();
  companyPath(value.sourceDirectory); companyPath(value.runtimeDirectory);
  const preparing = ['plan', 'approve', 'run'].includes(value.command);
  if (preparing) companyPath(value.preparationDirectory);
  else if (value.preparationDirectory !== null) reject();
  if (value.command === 'plan' ? !isReadonlyId(value.preparationId!) : value.preparationId !== null) reject();
  if (value.command === 'prune' ? value.taskId !== null : !isReadonlyId(value.taskId!)) reject();
  if (['approve', 'run'].includes(value.command) ? !hash(value.planHash) : value.planHash !== null) reject();
  if (value.command === 'approve' ? !Number.isInteger(value.expiresInMinutes) || value.expiresInMinutes! < 1 || value.expiresInMinutes! > 60 : value.expiresInMinutes !== null) reject();
  return value;
};
export const companyInvestigationSummary = (command: CompanyInvestigationCommand, id: string | null,
  snapshot: CompanyInvestigationSnapshot | null = null): CompanyInvestigationSummary => ({
  version: 'company-investigation-result-v1', command, taskId: snapshot?.plan.id ?? id,
  status: snapshot?.status ?? (command === 'prune' ? 'PRUNED' : 'NOT_FOUND'),
  planHash: snapshot?.plan.planHash ?? null, expiresAt: snapshot?.plan.expiresAt ?? null, auditExpiresAt: snapshot?.plan.auditExpiresAt ?? null,
  approval: !snapshot?.approval ? 'none' : snapshot.approval.usedAt ? 'used' : snapshot.approval.revokedAt ? 'revoked' : 'active',
  attempts: snapshot?.attempt ? 1 : 0, mockCalls: snapshot?.attempt?.dispatchedAt ? 1 : 0,
  reportAvailable: snapshot?.report !== null && snapshot?.report !== undefined,
  prunedPayloads: 0, prunedReports: 0, prunedRecords: 0, ...companyInvestigationDisabled,
});
export const parseCompanyInvestigationSummary = (raw: string, command: CompanyInvestigationCommand, id: string | null): CompanyInvestigationSummary => {
  const input = parseReadonlyTransportJson(raw.trim(), 65_536);
  const template = companyInvestigationSummary(command, id);
  if (!readonlyExactKeys(input, Object.keys(template))) reject();
  const value = input as unknown as CompanyInvestigationSummary;
  if (value.version !== template.version || value.command !== command || (command === 'plan' ? !isReadonlyId(value.taskId!) : value.taskId !== id)
    || Object.entries(companyInvestigationDisabled).some(([key, expected]) => value[key as keyof CompanyInvestigationSummary] !== expected)
    || !['none', 'active', 'used', 'revoked'].includes(value.approval)
    || ![0, 1].includes(value.attempts) || ![0, 1].includes(value.mockCalls) || value.mockCalls > value.attempts
    || typeof value.reportAvailable !== 'boolean'
    || [value.prunedPayloads, value.prunedReports, value.prunedRecords].some(count => !Number.isSafeInteger(count) || count < 0)) reject();
  if (command !== 'prune' && [value.prunedPayloads, value.prunedReports, value.prunedRecords].some(count => count !== 0)) reject();
  if (value.status === 'PRUNED' || value.status === 'NOT_FOUND') {
    if ((value.status === 'PRUNED') !== (command === 'prune') || value.planHash !== null || value.expiresAt !== null || value.auditExpiresAt !== null
      || value.reportAvailable || value.approval !== 'none' || value.attempts !== 0 || value.mockCalls !== 0 || command === 'plan') reject();
  } else {
    if (!['AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'REPORTED', 'FAILED', 'CANCELLED', 'EXPIRED', 'BLOCKED'].includes(value.status)
      || command === 'prune' || !hash(value.planHash) || !value.expiresAt || !value.auditExpiresAt
      || !Number.isFinite(Date.parse(value.expiresAt)) || !Number.isFinite(Date.parse(value.auditExpiresAt))
      || new Date(value.expiresAt).toISOString() !== value.expiresAt || new Date(value.auditExpiresAt).toISOString() !== value.auditExpiresAt
      || value.expiresAt > value.auditExpiresAt || (value.reportAvailable && value.status !== 'REPORTED')) reject();
    if (value.status === 'AWAITING_APPROVAL' && (value.approval !== 'none' || value.attempts !== 0 || value.mockCalls !== 0)
      || value.status === 'APPROVED' && (value.approval !== 'active' || value.attempts !== 0 || value.mockCalls !== 0)
      || value.status === 'RUNNING' && (value.approval !== 'used' || value.attempts !== 1)
      || value.status === 'REPORTED' && (value.approval !== 'used' || value.attempts !== 1 || value.mockCalls !== 1 || !value.reportAvailable)
      || ['FAILED', 'BLOCKED'].includes(value.status) && (value.approval !== 'used' || value.attempts !== 1)) reject();
  }
  return value;
};
