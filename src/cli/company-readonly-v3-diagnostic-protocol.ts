import { types } from 'node:util';
import type { CompanyGitRangeUnitFailure } from '../domain/company-git-range-unit.js';
import { HarnessError } from '../domain/errors.js';
import { parseCompanyGitRangeUnitFailure, COMPANY_GIT_RANGE_UNIT_DIAGNOSTIC_BYTES } from '../policy/company-git-range-unit-diagnostic.js';
import { isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';

export const COMPANY_V3_DIAGNOSTIC_VERSION = 'company-git-range-failure-v2';
const prefix = 'COMPANY_GIT_RANGE_DIAGNOSTIC_V2 ';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
export const formatCompanyV3Diagnostic = (taskId: string, failure: CompanyGitRangeUnitFailure): string => {
  if (!isReadonlyId(taskId)) throw new HarnessError('COMPANY_READONLY_V3_INVALID_DIAGNOSTIC');
  const value = { version: COMPANY_V3_DIAGNOSTIC_VERSION, taskId, failure: parseCompanyGitRangeUnitFailure(failure) };
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > COMPANY_GIT_RANGE_UNIT_DIAGNOSTIC_BYTES) throw new HarnessError('COMPANY_READONLY_V3_INVALID_DIAGNOSTIC');
  return `${prefix}${text}\n`;
};

/** An incomplete, duplicate, unrelated or malformed frame never becomes a persisted diagnostic. */
export const parseCompanyV3Diagnostic = (bytes: Uint8Array, taskId: string): CompanyGitRangeUnitFailure | null => {
  try {
    if (types.isProxy(bytes) || !types.isUint8Array(bytes) || byteLength.call(bytes) > 65_536
      || types.isSharedArrayBuffer(backingBuffer.call(bytes)) || !isReadonlyId(taskId)) return null;
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), lines = text.split('\n');
    const candidates = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith(prefix));
    if (candidates.length !== 1 || candidates[0]!.index === lines.length - 1 || candidates[0]!.line.includes('\r')) return null;
    const value = parseReadonlyTransportJson(candidates[0]!.line.slice(prefix.length), COMPANY_GIT_RANGE_UNIT_DIAGNOSTIC_BYTES) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'failure,taskId,version'
      || value.version !== COMPANY_V3_DIAGNOSTIC_VERSION || value.taskId !== taskId) return null;
    return parseCompanyGitRangeUnitFailure(value.failure);
  } catch { return null; }
};
