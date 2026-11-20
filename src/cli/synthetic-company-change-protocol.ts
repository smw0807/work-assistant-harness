import type { SyntheticCompanyChangeSnapshot } from '../domain/synthetic-company-change.js';
import { HarnessError } from '../domain/errors.js';
import { isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';

export const syntheticChangeCommands = ['init', 'plan', 'approve', 'apply', 'inspect', 'cancel', 'recover'] as const;
export type SyntheticChangeCommand = typeof syntheticChangeCommands[number];
export interface SyntheticChangeWorkerOptions {
  version: 'synthetic-change-worker-input-v1';
  command: SyntheticChangeCommand;
  harnessDirectory: string;
  runtimeDirectory: string;
  taskId: string | null;
  draftFile: string | null;
  planHash: string | null;
  expiresInMinutes: number | null;
}
export const syntheticChangeBoundary = Object.freeze({ scope: 'synthetic-only' as const,
  productChecks: 'not_run' as const, transmissionAllowed: false as const, nativeExecution: 'not_run' as const,
  realModel: 'not_run' as const, credentialAccess: 'not_run' as const, osIsolation: false as const, automaticRetry: false as const });
export interface SyntheticChangeSummary {
  version: 'synthetic-change-result-v1';
  command: SyntheticChangeCommand;
  taskId: string | null;
  status: SyntheticCompanyChangeSnapshot['status'] | 'INITIALIZED';
  planHash: string | null;
  draftHash: string | null;
  baseCommit: string;
  indexHash: string;
  changeCount: number;
  journalCount: number;
  approvalExpiresAt: string | null;
  failureCode: SyntheticCompanyChangeSnapshot['failureCode'];
  reportAvailable: boolean;
  observationAvailable: boolean;
  scope: 'synthetic-only';
  productChecks: 'not_run';
  transmissionAllowed: false;
  nativeExecution: 'not_run';
  realModel: 'not_run';
  credentialAccess: 'not_run';
  osIsolation: false;
  automaticRetry: false;
}
const fail = (): never => { throw new HarnessError('SYNTHETIC_COMPANY_CHANGE_INVALID_PROTOCOL'); };
const digest = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown): boolean => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const parseSyntheticChangeWorkerOptions = (raw: string): SyntheticChangeWorkerOptions => {
  const value = parseReadonlyTransportJson(raw, 16_384) as SyntheticChangeWorkerOptions;
  const draftCommands: string[] = ['plan', 'approve', 'apply'];
  const hashCommands: string[] = ['approve', 'apply', 'recover'];
  if (!readonlyExactKeys(value, ['version', 'command', 'harnessDirectory', 'runtimeDirectory', 'taskId', 'draftFile', 'planHash', 'expiresInMinutes'])
    || value.version !== 'synthetic-change-worker-input-v1' || !syntheticChangeCommands.includes(value.command)
    || typeof value.harnessDirectory !== 'string' || typeof value.runtimeDirectory !== 'string'
    || (value.command === 'init' ? value.taskId !== null : !isReadonlyId(value.taskId))
    || (draftCommands.includes(value.command) ? typeof value.draftFile !== 'string' : value.draftFile !== null)
    || (hashCommands.includes(value.command) ? !digest(value.planHash) : value.planHash !== null)
    || (value.command === 'approve' ? !Number.isSafeInteger(value.expiresInMinutes) || value.expiresInMinutes! < 1
      || value.expiresInMinutes! > 60 : value.expiresInMinutes !== null)) fail();
  return value;
};
export const parseSyntheticChangeSummary = (raw: string, options: SyntheticChangeWorkerOptions): SyntheticChangeSummary => {
  const value = parseReadonlyTransportJson(raw, 16_384) as SyntheticChangeSummary;
  if (!readonlyExactKeys(value, ['version', 'command', 'taskId', 'status', 'planHash', 'draftHash', 'baseCommit', 'indexHash',
    'changeCount', 'journalCount', 'approvalExpiresAt', 'failureCode', 'reportAvailable', 'observationAvailable', ...Object.keys(syntheticChangeBoundary)])
    || value.version !== 'synthetic-change-result-v1' || value.command !== options.command || value.taskId !== options.taskId
    || !['INITIALIZED', 'AWAITING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLIED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(value.status)
    || typeof value.baseCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(value.baseCommit) || !digest(value.indexHash)
    || ![value.planHash, value.draftHash].every(item => item === null || digest(item))
    || !Number.isSafeInteger(value.changeCount) || value.changeCount < 1 || value.changeCount > 8
    || !Number.isSafeInteger(value.journalCount) || value.journalCount < 0 || value.journalCount > 18
    || value.approvalExpiresAt !== null && !timestamp(value.approvalExpiresAt)
    || value.failureCode !== null && !['SYNTHETIC_COMPANY_CHANGE_APPLY_FAILED', 'SYNTHETIC_COMPANY_CHANGE_INTERRUPTED'].includes(value.failureCode)
    || typeof value.reportAvailable !== 'boolean' || typeof value.observationAvailable !== 'boolean'
    || Object.entries(syntheticChangeBoundary).some(([key, expected]) => value[key as keyof SyntheticChangeSummary] !== expected)) fail();
  if (options.command === 'init' ? value.status !== 'INITIALIZED' || value.planHash !== null || value.draftHash !== null
      || value.journalCount !== 0 || value.approvalExpiresAt !== null || value.failureCode !== null || value.reportAvailable || value.observationAvailable
    : value.status === 'INITIALIZED' || value.planHash === null || value.draftHash === null) fail();
  if (options.planHash !== null && value.planHash !== options.planHash
    || (value.status === 'FAILED') !== (value.failureCode !== null)
    || value.observationAvailable !== (options.command === 'recover')
    || ['inspect', 'recover'].includes(options.command) !== value.reportAvailable) fail();
  if (options.command === 'plan' && value.status !== 'AWAITING_APPROVAL'
    || options.command === 'approve' && value.status !== 'APPROVED'
    || options.command === 'apply' && !['APPLIED', 'FAILED'].includes(value.status)
    || options.command === 'recover' && (value.status !== 'FAILED' || value.failureCode !== 'SYNTHETIC_COMPANY_CHANGE_INTERRUPTED')
    || options.command === 'cancel' && !['CANCELLED', 'EXPIRED'].includes(value.status)
    || ['AWAITING_APPROVAL', 'APPROVED', 'CANCELLED', 'EXPIRED'].includes(value.status) && value.journalCount !== 0
    || ['APPROVED', 'APPLYING', 'APPLIED', 'FAILED'].includes(value.status) && value.approvalExpiresAt === null
    || value.status === 'APPLIED' && value.journalCount !== 2 * (value.changeCount + 1)) fail();
  return value;
};
