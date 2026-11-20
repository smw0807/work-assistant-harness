import type { CompanyChangeSnapshot } from '../domain/company-change.js';
import { HarnessError } from '../domain/errors.js';
import { isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';

export const companyChangeCommands = ['plan', 'review', 'approve', 'inspect', 'cancel', 'prune'] as const;
export type CompanyChangeCommand = typeof companyChangeCommands[number];
export const companyChangeDisabled = Object.freeze({
  sourceVerification: 'not_run' as const, approvalScope: 'review-only' as const,
  executionAllowed: false as const, transmissionAllowed: false as const, nativeExecution: 'not_run' as const,
  realModel: 'not_run' as const, credentialAccess: 'not_run' as const, productChecks: 'not_run' as const,
});
export interface CompanyChangeWorkerOptions {
  version: 'company-change-worker-input-v1';
  command: CompanyChangeCommand;
  harnessDirectory: string;
  runtimeDirectory: string;
  taskId: string | null;
  draftFile: string | null;
  planHash: string | null;
  expiresInMinutes: number | null;
}
export interface CompanyChangeSummary {
  version: 'company-change-result-v1';
  command: CompanyChangeCommand;
  taskId: string | null;
  status: CompanyChangeSnapshot['status'] | 'PRUNED' | 'NOT_FOUND';
  planHash: string | null;
  draftHash: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  auditExpiresAt: string | null;
  changeCount: number;
  draftAvailable: boolean;
  reviewFileAvailable: boolean;
  approvalId: string | null;
  approvalExpiresAt: string | null;
  prunedDrafts: number;
  prunedRecords: number;
  prunedReviews: number;
  sourceVerification: 'not_run';
  approvalScope: 'review-only';
  executionAllowed: false;
  transmissionAllowed: false;
  nativeExecution: 'not_run';
  realModel: 'not_run';
  credentialAccess: 'not_run';
  productChecks: 'not_run';
}
const fail = (): never => { throw new HarnessError('COMPANY_CHANGE_INVALID_PROTOCOL'); };
const digest = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
export const parseCompanyChangeWorkerOptions = (raw: string): CompanyChangeWorkerOptions => {
  const value = parseReadonlyTransportJson(raw, 16_384) as CompanyChangeWorkerOptions;
  if (!readonlyExactKeys(value, ['version', 'command', 'harnessDirectory', 'runtimeDirectory', 'taskId', 'draftFile', 'planHash', 'expiresInMinutes'])
    || value.version !== 'company-change-worker-input-v1' || !companyChangeCommands.includes(value.command)
    || typeof value.harnessDirectory !== 'string' || typeof value.runtimeDirectory !== 'string'
    || (value.command === 'prune' ? value.taskId !== null : !isReadonlyId(value.taskId))
    || (value.command === 'plan' ? typeof value.draftFile !== 'string' : value.draftFile !== null)
    || (value.command === 'approve' ? !digest(value.planHash) || !Number.isSafeInteger(value.expiresInMinutes)
      || value.expiresInMinutes! < 1 || value.expiresInMinutes! > 60 : value.planHash !== null || value.expiresInMinutes !== null)) fail();
  return value;
};
export const emptyCompanyChangeSummary = (options: CompanyChangeWorkerOptions): CompanyChangeSummary => ({
  version: 'company-change-result-v1', command: options.command, taskId: options.taskId,
  status: options.command === 'prune' ? 'PRUNED' : 'NOT_FOUND', planHash: null, draftHash: null,
  createdAt: null, expiresAt: null, auditExpiresAt: null, changeCount: 0, draftAvailable: false, reviewFileAvailable: false,
  approvalId: null, approvalExpiresAt: null, prunedDrafts: 0, prunedRecords: 0, prunedReviews: 0, ...companyChangeDisabled,
});
export const parseCompanyChangeSummary = (raw: string, options: CompanyChangeWorkerOptions): CompanyChangeSummary => {
  const value = parseReadonlyTransportJson(raw, 16_384) as CompanyChangeSummary;
  if (!readonlyExactKeys(value, Object.keys(emptyCompanyChangeSummary(options))) || value.version !== 'company-change-result-v1'
    || value.command !== options.command || value.taskId !== options.taskId
    || !['AWAITING_APPROVAL', 'APPROVED', 'CANCELLED', 'EXPIRED', 'PRUNED', 'NOT_FOUND'].includes(value.status)
    || Object.entries(companyChangeDisabled).some(([key, expected]) => value[key as keyof CompanyChangeSummary] !== expected)
    || ![value.planHash, value.draftHash].every(item => item === null || digest(item))
    || ![value.createdAt, value.expiresAt, value.auditExpiresAt, value.approvalExpiresAt].every(item => item === null || timestamp(item))
    || ![value.changeCount, value.prunedDrafts, value.prunedRecords, value.prunedReviews].every(item => Number.isSafeInteger(item) && item >= 0)
    || typeof value.draftAvailable !== 'boolean' || typeof value.reviewFileAvailable !== 'boolean'
    || value.approvalId !== null && !isReadonlyId(value.approvalId)) fail();
  const absent = ['NOT_FOUND', 'PRUNED'].includes(value.status);
  if (absent ? [value.planHash, value.draftHash, value.createdAt, value.expiresAt, value.auditExpiresAt, value.approvalId, value.approvalExpiresAt].some(item => item !== null)
      || value.changeCount !== 0 || value.draftAvailable || value.reviewFileAvailable
    : [value.planHash, value.draftHash, value.createdAt, value.expiresAt, value.auditExpiresAt].some(item => item === null)
      || value.changeCount < 1 || value.changeCount > 8) fail();
  if (value.status === 'APPROVED' && (value.approvalId === null || value.approvalExpiresAt === null || !value.draftAvailable)
    || ['CANCELLED', 'EXPIRED'].includes(value.status) && (value.draftAvailable || value.reviewFileAvailable)
    || value.reviewFileAvailable && !value.draftAvailable
    || (options.command === 'prune') !== (value.status === 'PRUNED')) fail();
  return value;
};
