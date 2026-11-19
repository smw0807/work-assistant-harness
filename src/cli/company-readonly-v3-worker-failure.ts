import { types } from 'node:util';
import { HarnessError } from '../domain/errors.js';
import { isCompanyGitRangeSourceFailureReason, type CompanyGitRangeSourceFailureReason } from '../policy/company-git-range-source-failure.js';
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
const sourceVersion = 'company-readonly-v3-worker-failure-v2';
const sourcePrefix = 'COMPANY_READONLY_V3_WORKER_FAILURE_V2 ';
const familyMarker = 'COMPANY_READONLY_V3_WORKER_FAILURE_V';
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

export type CompanyV3WorkerFailureDetails =
  | { code: CompanyV3WorkerFailureCode; sourceFailureReason?: never }
  | { code: 'COMPANY_GIT_RANGE_INVALID_SOURCE'; sourceFailureReason: CompanyGitRangeSourceFailureReason };

export const formatCompanyV3WorkerFailure = (taskId: string, code: CompanyV3WorkerFailureCode,
  sourceFailureReason?: CompanyGitRangeSourceFailureReason): string => {
  if (!isReadonlyId(taskId) || !isCompanyV3WorkerFailureCode(code)) throw new HarnessError('COMPANY_READONLY_V3_INVALID_DIAGNOSTIC');
  if (sourceFailureReason !== undefined && (code !== 'COMPANY_GIT_RANGE_INVALID_SOURCE'
    || !isCompanyGitRangeSourceFailureReason(sourceFailureReason))) throw new HarnessError('COMPANY_READONLY_V3_INVALID_DIAGNOSTIC');
  const frame = sourceFailureReason === undefined ? `${prefix}${JSON.stringify({ version, taskId, code })}\n`
    : `${sourcePrefix}${JSON.stringify({ version: sourceVersion, taskId, code, sourceFailureReason })}\n`;
  if (Buffer.byteLength(frame) > frameBytes) throw new HarnessError('COMPANY_READONLY_V3_INVALID_DIAGNOSTIC');
  return frame;
};

/** Both versions share one frame allowance; no mixed or duplicate frame can select a more detailed result. */
export const parseCompanyV3WorkerFailureDetails = (bytes: Uint8Array, taskId: string): CompanyV3WorkerFailureDetails | null => {
  try {
    if (types.isProxy(bytes) || !types.isUint8Array(bytes) || byteLength.call(bytes) > stderrBytes
      || types.isSharedArrayBuffer(backingBuffer.call(bytes)) || !isReadonlyId(taskId)) return null;
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\r')) return null;
    const lines = text.split('\n');
    const candidates = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith(familyMarker));
    if (candidates.length !== 1) return null;
    const candidate = candidates[0]!;
    const selectedPrefix = candidate.line.startsWith(prefix) ? prefix : candidate.line.startsWith(sourcePrefix) ? sourcePrefix : null;
    if (candidate.index === lines.length - 1 || selectedPrefix === null || Buffer.byteLength(candidate.line) + 1 > frameBytes) return null;
    const value = parseReadonlyTransportJson(candidate.line.slice(selectedPrefix.length), frameBytes) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.taskId !== taskId) return null;
    if (selectedPrefix === prefix) {
      if (Object.keys(value).sort().join() !== 'code,taskId,version' || value.version !== version || !isCompanyV3WorkerFailureCode(value.code)) return null;
      return { code: value.code };
    }
    if (Object.keys(value).sort().join() !== 'code,sourceFailureReason,taskId,version' || value.version !== sourceVersion
      || value.code !== 'COMPANY_GIT_RANGE_INVALID_SOURCE' || !isCompanyGitRangeSourceFailureReason(value.sourceFailureReason)) return null;
    return { code: value.code, sourceFailureReason: value.sourceFailureReason };
  } catch { return null; }
};

/** Preserve the original v1-only string result for callers that have not adopted source reasons. */
export const parseCompanyV3WorkerFailure = (bytes: Uint8Array, taskId: string): CompanyV3WorkerFailureCode | null => {
  const details = parseCompanyV3WorkerFailureDetails(bytes, taskId);
  return details && details.sourceFailureReason === undefined ? details.code : null;
};
