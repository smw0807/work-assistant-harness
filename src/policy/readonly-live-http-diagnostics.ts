import { HarnessError } from '../domain/errors.js';
import { readonlyExactKeys } from './readonly-investigation-policy.js';

const mediaTypes = ['missing', 'duplicate', 'json', 'event-stream', 'other'] as const;
const encodings = ['missing', 'duplicate', 'identity', 'gzip', 'br', 'deflate', 'other'] as const;
const counts = ['invalidNameCount', 'legacyInvalidNameCount', 'invalidValueCount', 'tabValueCount',
  'duplicateNonCookieCount', 'cookieCount'] as const;
const flags = ['locationPresent', 'retryAfterPresent'] as const;
export interface ReadonlyLiveHeaderDiagnostics {
  mediaType: typeof mediaTypes[number];
  contentEncoding: typeof encodings[number];
  invalidNameCount: number;
  legacyInvalidNameCount: number;
  invalidValueCount: number;
  tabValueCount: number;
  duplicateNonCookieCount: number;
  cookieCount: number;
  locationPresent: boolean;
  retryAfterPresent: boolean;
}

/** Fixed categories only: never retain provider header names, values, cookies or unknown tokens. */
export const classifyReadonlyLiveHeaders = (pairs: readonly string[]): ReadonlyLiveHeaderDiagnostics => {
  const result: ReadonlyLiveHeaderDiagnostics = { mediaType: 'missing', contentEncoding: 'missing',
    invalidNameCount: 0, legacyInvalidNameCount: 0, invalidValueCount: 0, tabValueCount: 0,
    duplicateNonCookieCount: 0, cookieCount: 0, locationPresent: false, retryAfterPresent: false };
  const names = new Set<string>();
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    const name = pairs[index]!.toLowerCase(); const value = pairs[index + 1]!;
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)) result.invalidNameCount++;
    if (!/^[A-Za-z][A-Za-z0-9-]*$/u.test(name)) result.legacyInvalidNameCount++;
    if (/[^\t\x20-\x7e]/u.test(value)) result.invalidValueCount++;
    if (value.includes('\t')) result.tabValueCount++;
    if (name === 'set-cookie') result.cookieCount++;
    else if (names.has(name)) result.duplicateNonCookieCount++;
    if (name === 'content-type') {
      const mediaType = value.split(';', 1)[0]!.trim().toLowerCase();
      result.mediaType = names.has(name) ? 'duplicate' : mediaType === 'application/json' ? 'json'
        : mediaType === 'text/event-stream' ? 'event-stream' : 'other';
    }
    if (name === 'content-encoding') {
      const encoding = value.trim().toLowerCase();
      result.contentEncoding = names.has(name) ? 'duplicate'
        : encoding === 'identity' || encoding === 'gzip' || encoding === 'br' || encoding === 'deflate' ? encoding : 'other';
    }
    if (name === 'location') result.locationPresent = true;
    if (name === 'retry-after') result.retryAfterPresent = true;
    names.add(name);
  }
  return result;
};

/** Synthetic transports cannot smuggle raw header material into the persisted diagnostic report. */
export const copyReadonlyLiveHeaderDiagnostics = (value: ReadonlyLiveHeaderDiagnostics): ReadonlyLiveHeaderDiagnostics => {
  if (!readonlyExactKeys(value, ['mediaType', 'contentEncoding', ...counts, ...flags])
    || !mediaTypes.includes(value.mediaType) || !encodings.includes(value.contentEncoding)
    || counts.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 100_000)
    || flags.some((key) => typeof value[key] !== 'boolean')) throw new HarnessError('READONLY_LIVE_INVALID_RESPONSE');
  return { ...value };
};
