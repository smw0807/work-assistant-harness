import { HarnessError } from '../domain/errors.js';
import { getCompanyGitRangeProfileHash } from '../policy/company-git-range-budget.js';
import { isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';

export type CompanyV2Command = 'plan' | 'inspect' | 'cancel' | 'prune';
export interface CompanyV2WorkerOptions {
  command: CompanyV2Command;
  sourceDirectory: string;
  runtimeDirectory: string;
  taskId?: string;
  startedAt?: string;
  policyFile?: string;
  registrationFile?: string;
  policyHash?: string;
  registrationHash?: string;
}
export const companyV2Disabled = {
  approvalCreated: false, transmissionAllowed: false, executionAllowed: false, companyPolicyVerified: false,
  providerCompatibility: 'not_run', nativeExecution: 'not_run', realModel: 'not_run',
} as const;
export interface CompanyV2Summary {
  version: 'company-readonly-v2-result-v1';
  command: CompanyV2Command;
  taskId: string | null;
  status: 'AWAITING_APPROVAL' | 'CANCELLED' | 'EXPIRED' | 'NOT_FOUND' | 'PRUNED';
  planHash: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  auditExpiresAt: string | null;
  reviewAvailable: boolean;
  prunedPayloads: number;
  prunedRecords: number;
  gitProfileHash: string;
  peakRssBytes: number;
  oldSpaceMiB: 128;
  approvalCreated: false;
  transmissionAllowed: false;
  executionAllowed: false;
  companyPolicyVerified: false;
  providerCompatibility: 'not_run';
  nativeExecution: 'not_run';
  realModel: 'not_run';
}
const reject = (): never => { throw new HarnessError('COMPANY_READONLY_V2_INVALID_WORKER_OUTPUT'); };
const date = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

export const parseCompanyV2Summary = (text: string, command: CompanyV2Command, id: string | null): CompanyV2Summary => {
  const value = parseReadonlyTransportJson(text.trim(), 65_536) as CompanyV2Summary;
  const fields = ['version', 'command', 'taskId', 'status', 'planHash', 'createdAt', 'expiresAt', 'auditExpiresAt',
    'reviewAvailable', 'prunedPayloads', 'prunedRecords', 'gitProfileHash', 'peakRssBytes', 'oldSpaceMiB', ...Object.keys(companyV2Disabled)];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(key => !fields.includes(key)) || value.version !== 'company-readonly-v2-result-v1'
    || value.command !== command || value.taskId !== id || id !== null && !isReadonlyId(id)
    || value.gitProfileHash !== getCompanyGitRangeProfileHash() || value.oldSpaceMiB !== 128
    || !Number.isSafeInteger(value.peakRssBytes) || value.peakRssBytes <= 0
    || Object.entries(companyV2Disabled).some(([key, expected]) => value[key as keyof CompanyV2Summary] !== expected)
    || ![value.prunedPayloads, value.prunedRecords].every(count => Number.isSafeInteger(count) && count >= 0)) reject();
  if (command === 'prune') {
    if (value.status !== 'PRUNED' || id !== null || value.planHash !== null || value.reviewAvailable !== false
      || value.createdAt !== null || value.expiresAt !== null || value.auditExpiresAt !== null) reject();
  } else if (value.status === 'NOT_FOUND') {
    if (command === 'plan' || value.planHash !== null || value.reviewAvailable !== false
      || value.createdAt !== null || value.expiresAt !== null || value.auditExpiresAt !== null) reject();
  } else {
    if (!['AWAITING_APPROVAL', 'CANCELLED', 'EXPIRED'].includes(value.status)
      || command === 'plan' && value.status !== 'AWAITING_APPROVAL'
      || command === 'cancel' && value.status === 'AWAITING_APPROVAL'
      || typeof value.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.planHash)
      || ![value.createdAt, value.expiresAt, value.auditExpiresAt].every(date)
      || Date.parse(value.createdAt!) >= Date.parse(value.expiresAt!) || Date.parse(value.expiresAt!) > Date.parse(value.auditExpiresAt!)
      || value.reviewAvailable !== (value.status === 'AWAITING_APPROVAL')) reject();
  }
  if (command !== 'prune' && (value.prunedPayloads !== 0 || value.prunedRecords !== 0)) reject();
  return value;
};

export const parseCompanyV2WorkerOptions = (text: string): CompanyV2WorkerOptions => {
  const value = parseReadonlyTransportJson(text, 32_768) as CompanyV2WorkerOptions;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['plan', 'inspect', 'cancel', 'prune'].includes(value.command)) {
    throw new HarnessError('COMPANY_READONLY_V2_INVALID_WORKER_INPUT');
  }
  const fields = ['command', 'sourceDirectory', 'runtimeDirectory', ...(value.command === 'plan'
    ? ['taskId', 'startedAt', 'policyFile', 'registrationFile', 'policyHash', 'registrationHash'] : value.command === 'prune' ? [] : ['taskId'])];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
    || Object.values(value).some(item => typeof item !== 'string')
    || value.command !== 'prune' && !isReadonlyId(value.taskId!)
    || value.command === 'plan' && (!date(value.startedAt) || ![value.policyHash, value.registrationHash].every(hash => /^[a-f0-9]{64}$/.test(hash!)))) {
    throw new HarnessError('COMPANY_READONLY_V2_INVALID_WORKER_INPUT');
  }
  return value;
};
