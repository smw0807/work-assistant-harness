import { types } from 'node:util';
import type { CompanyGitRangeFailure } from '../domain/company-git-range-diagnostic.js';
import { HarnessError } from '../domain/errors.js';
import { parseCompanyGitRangeFailure, COMPANY_GIT_RANGE_DIAGNOSTIC_BYTES } from '../policy/company-git-range-diagnostic.js';
import { isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';

export const COMPANY_V2_DIAGNOSTIC_VERSION = 'company-git-range-failure-v1';
const prefix = 'COMPANY_GIT_RANGE_DIAGNOSTIC_V1 ';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
export const formatCompanyV2Diagnostic = (taskId: string, failure: CompanyGitRangeFailure): string => {
  if (!isReadonlyId(taskId)) throw new HarnessError('COMPANY_READONLY_V2_INVALID_DIAGNOSTIC');
  const value = { version: COMPANY_V2_DIAGNOSTIC_VERSION, taskId, failure: parseCompanyGitRangeFailure(failure) };
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > COMPANY_GIT_RANGE_DIAGNOSTIC_BYTES) throw new HarnessError('COMPANY_READONLY_V2_INVALID_DIAGNOSTIC');
  return `${prefix}${text}\n`;
};

/** An incomplete, duplicate, unrelated or malformed frame never becomes a persisted diagnostic. */
export const parseCompanyV2Diagnostic = (bytes: Uint8Array, taskId: string): CompanyGitRangeFailure | null => {
  try {
    if (types.isProxy(bytes) || !types.isUint8Array(bytes) || byteLength.call(bytes) > 65_536
      || types.isSharedArrayBuffer(backingBuffer.call(bytes)) || !isReadonlyId(taskId)) return null;
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), lines = text.split('\n');
    const candidates = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith(prefix));
    if (candidates.length !== 1 || candidates[0]!.index === lines.length - 1 || candidates[0]!.line.includes('\r')) return null;
    const value = parseReadonlyTransportJson(candidates[0]!.line.slice(prefix.length), COMPANY_GIT_RANGE_DIAGNOSTIC_BYTES) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'failure,taskId,version'
      || value.version !== COMPANY_V2_DIAGNOSTIC_VERSION || value.taskId !== taskId) return null;
    return parseCompanyGitRangeFailure(value.failure);
  } catch { return null; }
};
