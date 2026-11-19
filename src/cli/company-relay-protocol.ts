import type { CompanyRelaySnapshot, CompanyRelayStatus } from '../domain/company-relay.js';
import { HarnessError } from '../domain/errors.js';
import { isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import { companyPath } from './company-readonly-files.js';

export type CompanyRelayCommand = 'plan' | 'inspect' | 'review' | 'approve' | 'run' | 'cancel' | 'recover' | 'prune';
export interface CompanyRelayWorkerOptions {
  version: 'company-relay-worker-v1'; command: CompanyRelayCommand;
  sourceDirectory: string; runtimeDirectory: string; preparationDirectory: string | null;
  authorizationFile: string | null; ipcDirectory: string | null; preparationId: string | null; taskId: string | null;
  planHash: string | null; expiresInMinutes: number | null;
}
export interface CompanyRelaySummary {
  version: 'company-relay-result-v1'; command: CompanyRelayCommand; taskId: string | null;
  status: CompanyRelayStatus | 'PRUNED' | 'NOT_FOUND'; planHash: string | null;
  expiresAt: string | null; auditExpiresAt: string | null;
  approval: 'none' | 'active' | 'used' | 'revoked'; attempts: number; dispatchReservations: number;
  reportAvailable: boolean; reviewAvailable: boolean; verification: 'not_run' | 'unknown' | 'fake' | 'live';
  prunedPayloads: number; prunedReports: number; prunedRecords: number;
  prunedArtifactRuns: number; prunedArtifactManifests: number; preservedUncertainArtifacts: number;
  mode: 'live'; executionAllowed: false;
}
const reject = (): never => { throw new HarnessError('COMPANY_RELAY_INVALID_PROTOCOL'); };
const commands = ['plan', 'inspect', 'review', 'approve', 'run', 'cancel', 'recover', 'prune'];
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const parseCompanyRelayWorkerOptions = (raw: string): CompanyRelayWorkerOptions => {
  const input = parseReadonlyTransportJson(raw, 16_384);
  if (!readonlyExactKeys(input, ['version', 'command', 'sourceDirectory', 'runtimeDirectory', 'preparationDirectory', 'authorizationFile', 'ipcDirectory', 'preparationId', 'taskId', 'planHash', 'expiresInMinutes'])) reject();
  const value = input as unknown as CompanyRelayWorkerOptions;
  if (value.version !== 'company-relay-worker-v1' || !commands.includes(value.command)) reject();
  companyPath(value.sourceDirectory); companyPath(value.runtimeDirectory);
  const preparing = ['plan', 'approve', 'run'].includes(value.command);
  if (preparing) { companyPath(value.preparationDirectory); companyPath(value.authorizationFile); }
  else if (value.preparationDirectory !== null || value.authorizationFile !== null) reject();
  if (value.command === 'run' ? typeof value.ipcDirectory !== 'string' || !/^\/private\/tmp\/hcri-[A-Za-z0-9]{6}$/.test(value.ipcDirectory) : value.ipcDirectory !== null) reject();
  if (value.command === 'plan' ? !isReadonlyId(value.preparationId!) : value.preparationId !== null) reject();
  if (value.command === 'prune' ? value.taskId !== null : !isReadonlyId(value.taskId!)) reject();
  if (['approve', 'run'].includes(value.command) ? !hash(value.planHash) : value.planHash !== null) reject();
  if (value.command === 'approve' ? !Number.isInteger(value.expiresInMinutes) || value.expiresInMinutes! < 1 || value.expiresInMinutes! > 60 : value.expiresInMinutes !== null) reject();
  return value;
};
export const companyRelaySummary = (command: CompanyRelayCommand, id: string | null,
  snapshot: CompanyRelaySnapshot | null = null): CompanyRelaySummary => ({
  version: 'company-relay-result-v1', command, taskId: snapshot?.plan.id ?? id,
  status: snapshot?.status ?? (command === 'prune' ? 'PRUNED' : 'NOT_FOUND'),
  planHash: snapshot?.plan.planHash ?? null, expiresAt: snapshot?.plan.expiresAt ?? null, auditExpiresAt: snapshot?.plan.auditExpiresAt ?? null,
  approval: !snapshot?.approval ? 'none' : snapshot.approval.usedAt ? 'used' : snapshot.approval.revokedAt ? 'revoked' : 'active',
  attempts: snapshot?.attempt ? 1 : 0, dispatchReservations: snapshot?.attempt?.dispatchedAt ? 1 : 0,
  reportAvailable: !!snapshot?.report, reviewAvailable: false,
  verification: snapshot?.report?.verification.transport ?? (snapshot?.attempt ? 'unknown' : 'not_run'),
  prunedPayloads: 0, prunedReports: 0, prunedRecords: 0, prunedArtifactRuns: 0, prunedArtifactManifests: 0, preservedUncertainArtifacts: 0, mode: 'live', executionAllowed: false,
});
export const parseCompanyRelaySummary = (raw: string, command: CompanyRelayCommand, id: string | null): CompanyRelaySummary => {
  const input = parseReadonlyTransportJson(raw.trim(), 65_536), template = companyRelaySummary(command, id);
  if (!readonlyExactKeys(input, Object.keys(template))) reject();
  const value = input as unknown as CompanyRelaySummary;
  if (value.version !== template.version || value.command !== command || (command === 'plan' ? !isReadonlyId(value.taskId!) : value.taskId !== id)
    || value.mode !== 'live' || value.executionAllowed !== false || !['none', 'active', 'used', 'revoked'].includes(value.approval)
    || ![0, 1].includes(value.attempts) || ![0, 1].includes(value.dispatchReservations) || value.dispatchReservations > value.attempts
    || typeof value.reportAvailable !== 'boolean' || typeof value.reviewAvailable !== 'boolean'
    || value.reviewAvailable && command !== 'review' || !['not_run', 'unknown', 'fake', 'live'].includes(value.verification)
    || [value.prunedPayloads, value.prunedReports, value.prunedRecords, value.prunedArtifactRuns, value.prunedArtifactManifests, value.preservedUncertainArtifacts].some(count => !Number.isSafeInteger(count) || count < 0)) reject();
  if (command !== 'prune' && [value.prunedPayloads, value.prunedReports, value.prunedRecords].some(count => count !== 0)) reject();
  if (['PRUNED', 'NOT_FOUND'].includes(value.status)) {
    if ((value.status === 'PRUNED') !== (command === 'prune') || value.planHash !== null || value.expiresAt !== null || value.auditExpiresAt !== null
      || value.reportAvailable || value.reviewAvailable || value.approval !== 'none' || value.attempts !== 0 || value.dispatchReservations !== 0
      || command === 'plan' || value.verification !== 'not_run') reject();
  } else {
    if (!['AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'REPORTED', 'FAILED', 'CANCELLED', 'EXPIRED', 'BLOCKED'].includes(value.status)
      || command === 'prune' || !hash(value.planHash) || !value.expiresAt || !value.auditExpiresAt
      || !Number.isFinite(Date.parse(value.expiresAt)) || !Number.isFinite(Date.parse(value.auditExpiresAt))
      || new Date(value.expiresAt).toISOString() !== value.expiresAt || new Date(value.auditExpiresAt).toISOString() !== value.auditExpiresAt
      || value.expiresAt > value.auditExpiresAt || (value.reportAvailable && value.status !== 'REPORTED')
      || value.verification !== (value.reportAvailable ? value.verification : value.attempts ? 'unknown' : 'not_run')
      || value.reportAvailable && !['fake', 'live'].includes(value.verification)
      || value.reviewAvailable && ['FAILED', 'CANCELLED', 'EXPIRED', 'BLOCKED'].includes(value.status)) reject();
    if (value.status === 'AWAITING_APPROVAL' && (value.approval !== 'none' || value.attempts !== 0)
      || value.status === 'APPROVED' && (value.approval !== 'active' || value.attempts !== 0)
      || value.status === 'RUNNING' && (value.approval !== 'used' || value.attempts !== 1)
      || value.status === 'REPORTED' && (value.approval !== 'used' || value.attempts !== 1 || value.dispatchReservations !== 1 || !value.reportAvailable)
      || ['FAILED', 'BLOCKED'].includes(value.status) && (value.approval !== 'used' || value.attempts !== 1)) reject();
  }
  return value;
};
