import { types } from 'node:util';
import { HarnessError } from '../domain/errors.js';
import { isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';

const failureCodes = [
  'COMPANY_READONLY_V3_PREPARATION_FAILED',
  'COMPANY_READONLY_V3_UNSAFE_WORKER', 'COMPANY_READONLY_V3_INPUT_CHANGED',
  'COMPANY_READONLY_V3_UNSAFE_PRIVATE_FILE', 'COMPANY_READONLY_V3_INVALID_WORKER_INPUT',
  'COMPANY_READONLY_V3_INVALID_REGISTRATION', 'COMPANY_READONLY_V3_SOURCE_CHANGED',
  'COMPANY_READONLY_V3_INVALID_OBSERVATION', 'COMPANY_READONLY_V3_INVALID_BUDGET',
  'COMPANY_READONLY_V3_INVALID_EVIDENCE', 'COMPANY_READONLY_V3_INVALID_VIEW_PROOF',
  'COMPANY_READONLY_V3_INPUT_LIMIT', 'COMPANY_READONLY_V3_INVALID_PAYLOAD', 'COMPANY_READONLY_V3_INVALID_PLAN',
  'COMPANY_READONLY_V3_INVALID_RECORD', 'COMPANY_READONLY_V3_INVALID_STORE', 'COMPANY_READONLY_V3_INVALID_TIME',
  'COMPANY_READONLY_V3_INVALID_ID', 'COMPANY_READONLY_V3_OWNER_MISMATCH', 'COMPANY_READONLY_V3_NOT_FOUND',
  'COMPANY_READONLY_V3_ID_REUSED', 'COMPANY_READONLY_V3_EXPIRED', 'COMPANY_READONLY_V3_TIME_REVERSED',
  'COMPANY_READONLY_V3_STORE_BUSY', 'COMPANY_READONLY_V3_STORE_CLOSED',
  'COMPANY_READONLY_V3_TRANSACTION_IN_PROGRESS', 'COMPANY_READONLY_V3_UNSAFE_LOCATION',
  'COMPANY_READONLY_INVALID_POLICY', 'COMPANY_READONLY_POLICY_UNCONFIRMED',
  'COMPANY_READONLY_INVALID_PRIVATE_FILE', 'COMPANY_READONLY_UNSAFE_PATH',
  'COMPANY_GIT_RANGE_SOURCE_CHANGED', 'COMPANY_GIT_RANGE_INVALID_SOURCE', 'COMPANY_GIT_RANGE_INVALID_SOURCE_INPUT',
  'COMPANY_GIT_RANGE_INVALID_FILES', 'COMPANY_GIT_RANGE_INVALID_PATH', 'COMPANY_GIT_RANGE_INVALID_UNIT',
  'COMPANY_GIT_RANGE_INVALID_INDEX', 'COMPANY_GIT_RANGE_INVALID_INDEX_HANDLE', 'COMPANY_GIT_RANGE_INVALID_SPAN',
  'COMPANY_GIT_RANGE_INVALID_OID', 'COMPANY_GIT_RANGE_INVALID_PACK_HEADER', 'COMPANY_GIT_RANGE_INVALID_OBJECT',
  'COMPANY_GIT_RANGE_INVALID_BYTES', 'COMPANY_GIT_RANGE_INVALID_DELTA', 'COMPANY_GIT_RANGE_INVALID_GRAPH',
  'COMPANY_GIT_RANGE_INVALID_PAYLOAD', 'COMPANY_GIT_RANGE_INVALID_PROOF', 'COMPANY_GIT_RANGE_INVALID_BUDGET',
  'COMPANY_GIT_RANGE_ABORTED', 'COMPANY_GIT_RANGE_LIMIT', 'COMPANY_GIT_RANGE_TIMEOUT',
  'PERSONAL_COLLECTION_INVALID_VIEW',
] as const;
export type CompanyV3WorkerFailureCode = typeof failureCodes[number];
const allowedCodes: ReadonlySet<string> = new Set(failureCodes);
const fallback: CompanyV3WorkerFailureCode = 'COMPANY_READONLY_V3_PREPARATION_FAILED';
const version = 'company-readonly-v3-worker-failure-v1';
const marker = 'COMPANY_READONLY_V3_WORKER_FAILURE_V1';
const prefix = `${marker} `;
const frameBytes = 1024;
const stderrBytes = 65_536;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;

export const isCompanyV3WorkerFailureCode = (value: unknown): value is CompanyV3WorkerFailureCode =>
  typeof value === 'string' && allowedCodes.has(value);

/** Only a fixed own data code is inspected; foreign error text and property hooks never become diagnostic data. */
export const companyV3WorkerFailureCode = (error: unknown): CompanyV3WorkerFailureCode => {
  try {
    if (types.isProxy(error) || !types.isNativeError(error) || Object.getPrototypeOf(error) !== HarnessError.prototype) return fallback;
    const property = Object.getOwnPropertyDescriptor(error, 'code');
    return property && Object.hasOwn(property, 'value') && isCompanyV3WorkerFailureCode(property.value) ? property.value : fallback;
  } catch { return fallback; }
};

export const formatCompanyV3WorkerFailure = (taskId: string, code: CompanyV3WorkerFailureCode): string => {
  if (!isReadonlyId(taskId) || !isCompanyV3WorkerFailureCode(code)) throw new HarnessError('COMPANY_READONLY_V3_INVALID_DIAGNOSTIC');
  const frame = `${prefix}${JSON.stringify({ version, taskId, code })}\n`;
  if (Buffer.byteLength(frame) > frameBytes) throw new HarnessError('COMPANY_READONLY_V3_INVALID_DIAGNOSTIC');
  return frame;
};

/** A complete task-bound frame returns only its allowlisted code, never stderr or JSON supplied by the worker. */
export const parseCompanyV3WorkerFailure = (bytes: Uint8Array, taskId: string): CompanyV3WorkerFailureCode | null => {
  try {
    if (types.isProxy(bytes) || !types.isUint8Array(bytes) || byteLength.call(bytes) > stderrBytes
      || types.isSharedArrayBuffer(backingBuffer.call(bytes)) || !isReadonlyId(taskId)) return null;
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\r')) return null;
    const lines = text.split('\n');
    const candidates = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith(marker));
    if (candidates.length !== 1) return null;
    const candidate = candidates[0]!;
    if (candidate.index === lines.length - 1 || !candidate.line.startsWith(prefix)
      || Buffer.byteLength(candidate.line) + 1 > frameBytes) return null;
    const value = parseReadonlyTransportJson(candidate.line.slice(prefix.length), frameBytes) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'code,taskId,version'
      || value.version !== version || value.taskId !== taskId || !isCompanyV3WorkerFailureCode(value.code)) return null;
    return value.code;
  } catch { return null; }
};
