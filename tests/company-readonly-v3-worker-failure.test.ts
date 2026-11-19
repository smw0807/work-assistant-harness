import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessError } from '../src/domain/errors.js';
import { companyV3WorkerFailureCode, formatCompanyV3WorkerFailure, isCompanyV3WorkerFailureCode,
  parseCompanyV3WorkerFailure, parseCompanyV3WorkerFailureDetails, type CompanyV3WorkerFailureCode } from '../src/cli/company-readonly-v3-worker-failure.js';
import type { CompanyGitRangeSourceFailureReason } from '../src/policy/company-git-range-source-failure.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const version = 'company-readonly-v3-worker-failure-v1';
const prefix = 'COMPANY_READONLY_V3_WORKER_FAILURE_V1 ';
const code: CompanyV3WorkerFailureCode = 'COMPANY_GIT_RANGE_SOURCE_CHANGED';
const fallback = 'COMPANY_READONLY_V3_PREPARATION_FAILED';
const frame = (value: unknown): Buffer => Buffer.from(`${prefix}${JSON.stringify(value)}\n`);
const value = { version, taskId, code };

test('the worker diagnostic carries an allowlisted source mismatch or fixed fallback only', () => {
  for (const selected of [code, fallback, 'COMPANY_READONLY_V3_INPUT_CHANGED', 'COMPANY_READONLY_V3_INVALID_EVIDENCE',
    'COMPANY_GIT_RANGE_LIMIT', 'COMPANY_GIT_RANGE_TIMEOUT', 'PERSONAL_COLLECTION_INVALID_VIEW'] as const) {
    assert.equal(companyV3WorkerFailureCode(new HarnessError(selected)), selected);
    assert.equal(isCompanyV3WorkerFailureCode(selected), true);
    const encoded = formatCompanyV3WorkerFailure(taskId, selected);
    assert.ok(Buffer.byteLength(encoded) <= 1024);
    assert.equal(parseCompanyV3WorkerFailure(Buffer.from(encoded), taskId), selected);
    assert.deepEqual(JSON.parse(encoded.slice(prefix.length)), { version, taskId, code: selected });
  }
  for (const unknown of [new Error('SYNTHETIC_PRIVATE_MESSAGE'), new HarnessError('COMPANY_GIT_RANGE_NEW_PRIVATE_CODE'),
    new HarnessError('COMPANY_READONLY_V2_SOURCE_CHANGED'), { code }, null, undefined, code]) {
    assert.equal(companyV3WorkerFailureCode(unknown), fallback);
  }
  for (const unknown of ['COMPANY_GIT_RANGE_NEW_PRIVATE_CODE', `${code}\nSYNTHETIC_PRIVATE_TEXT`, null, {}, 1]) {
    assert.equal(isCompanyV3WorkerFailureCode(unknown), false);
  }
});

test('error selection never evaluates getters, proxy traps, message, stack or inherited code', () => {
  let accesses = 0;
  const hostile = (): never => { accesses++; throw new Error('SYNTHETIC_PRIVATE_HOOK'); };
  const getter = Object.defineProperty(new HarnessError(code), 'code', { get: hostile });
  const textGetters = new HarnessError(code);
  for (const name of ['message', 'stack']) Object.defineProperty(textGetters, name, { get: hostile });
  assert.equal(companyV3WorkerFailureCode(textGetters), code);
  const errorProxy = new Proxy(new HarnessError(code), { get: hostile, getPrototypeOf: hostile, getOwnPropertyDescriptor: hostile });
  const revoked = Proxy.revocable(new HarnessError(code), {}); revoked.revoke();
  const inherited = Object.create(new HarnessError(code)) as unknown;
  const proxyPrototype = Object.setPrototypeOf(new HarnessError(code), new Proxy({}, { getPrototypeOf: hostile }));
  for (const foreign of [getter, errorProxy, revoked.proxy, inherited, proxyPrototype]) {
    assert.equal(companyV3WorkerFailureCode(foreign), fallback);
  }
  assert.equal(accesses, 0);
});

test('framing preserves unrelated stderr while returning no text besides the fixed code', () => {
  const encoded = formatCompanyV3WorkerFailure(taskId, code);
  const bytes = Buffer.from(`SYNTHETIC_PRIVATE_STDERR\n${encoded}COMPANY_GIT_RANGE_SOURCE_CHANGED\n`);
  assert.equal(parseCompanyV3WorkerFailure(bytes, taskId), code);
  assert.equal(parseCompanyV3WorkerFailure(Buffer.from('COMPANY_GIT_RANGE_SOURCE_CHANGED\n'), taskId), null);
  assert.equal(parseCompanyV3WorkerFailure(Buffer.from(encoded), otherId), null);
  assert.equal(parseCompanyV3WorkerFailure(Buffer.from(encoded), '../invalid'), null);
  assert.equal(parseCompanyV3WorkerFailure(Buffer.from(`COMPANY_GIT_RANGE_DIAGNOSTIC_V2 {}\n${encoded}`), taskId), code);
});

test('duplicate frames, incomplete frames, carriage returns and malformed delimiters are rejected', () => {
  const encoded = formatCompanyV3WorkerFailure(taskId, code);
  for (const malformed of [encoded + encoded, encoded + formatCompanyV3WorkerFailure(otherId, code), encoded.trimEnd(),
    encoded.replace('\n', '\r\n'), encoded.replace(prefix, prefix.trimEnd()), encoded.replace(prefix, `${prefix.trimEnd()}\t`),
    `${encoded}${prefix}`, `${prefix.trimEnd()}_EXTRA {}\n${encoded}`]) {
    assert.equal(parseCompanyV3WorkerFailure(Buffer.from(malformed), taskId), null);
  }
});

test('the frame rejects unknown fields, values, versions, tasks and duplicate decoded JSON keys', () => {
  for (const changed of [null, [], true, {}, { ...value, path: '/synthetic/private' }, { ...value, stack: 'SYNTHETIC_STACK' },
    { ...value, version: 'other' }, { ...value, taskId: otherId }, { ...value, taskId: null }, { ...value, code: 'unknown' },
    { ...value, code: ['COMPANY_GIT_RANGE_SOURCE_CHANGED'] }, { ...value, code: undefined }]) {
    assert.equal(parseCompanyV3WorkerFailure(frame(changed), taskId), null);
  }
  const duplicate = `{"version":"${version}","taskId":"${taskId}","code":"${code}","c\\u006fde":"${fallback}"}`;
  assert.equal(parseCompanyV3WorkerFailure(Buffer.from(`${prefix}${duplicate}\n`), taskId), null);
  assert.equal(parseCompanyV3WorkerFailure(Buffer.from(`${prefix}{\n`), taskId), null);
});

test('UTF-8, per-frame and total stderr byte boundaries are enforced', () => {
  const encoded = formatCompanyV3WorkerFailure(taskId, code);
  const bytes = Buffer.from(encoded);
  assert.equal(parseCompanyV3WorkerFailure(Buffer.concat([bytes, Buffer.from([0xff])]), taskId), null);
  assert.equal(parseCompanyV3WorkerFailure(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]), taskId), null);
  const paddedFrame = `${prefix}${' '.repeat(1024 - Buffer.byteLength(encoded))}${JSON.stringify(value)}\n`;
  assert.equal(Buffer.byteLength(paddedFrame), 1024);
  assert.equal(parseCompanyV3WorkerFailure(Buffer.from(paddedFrame), taskId), code);
  assert.equal(parseCompanyV3WorkerFailure(Buffer.from(paddedFrame.replace(prefix, `${prefix} `)), taskId), null);
  const atLimit = Buffer.concat([Buffer.alloc(65536 - bytes.length - 1, 120), Buffer.from('\n'), bytes]);
  assert.equal(atLimit.length, 65536);
  assert.equal(parseCompanyV3WorkerFailure(atLimit, taskId), code);
  assert.equal(parseCompanyV3WorkerFailure(Buffer.concat([atLimit, Buffer.from('\n')]), taskId), null);
});

test('byte parsing rejects proxies, shared memory and foreign values without invoking hooks', () => {
  const encoded = Buffer.from(formatCompanyV3WorkerFailure(taskId, code));
  let accesses = 0;
  const hostile = (): never => { accesses++; throw new Error('SYNTHETIC_BYTE_HOOK'); };
  const proxy = new Proxy(encoded, { get: hostile, getPrototypeOf: hostile });
  const revoked = Proxy.revocable(encoded, {}); revoked.revoke();
  const shared = new Uint8Array(new SharedArrayBuffer(encoded.length)); shared.set(encoded);
  for (const bytes of [proxy, revoked.proxy, shared, null, {}, new DataView(new ArrayBuffer(8))]) {
    assert.equal(parseCompanyV3WorkerFailure(bytes as Uint8Array, taskId), null);
  }
  assert.equal(accesses, 0);
});

test('formatting refuses unknown codes and invalid task identifiers instead of serializing foreign data', () => {
  assert.throws(() => formatCompanyV3WorkerFailure('../synthetic', code), { code: 'COMPANY_READONLY_V3_INVALID_DIAGNOSTIC' });
  assert.throws(() => formatCompanyV3WorkerFailure(taskId, 'COMPANY_GIT_RANGE_NEW_CODE' as CompanyV3WorkerFailureCode),
    { code: 'COMPANY_READONLY_V3_INVALID_DIAGNOSTIC' });
  let accesses = 0;
  const foreign = { toJSON: () => { accesses++; return code; } };
  assert.throws(() => formatCompanyV3WorkerFailure(taskId, foreign as unknown as CompanyV3WorkerFailureCode),
    { code: 'COMPANY_READONLY_V3_INVALID_DIAGNOSTIC' });
  assert.equal(accesses, 0);
});

const sourceCode = 'COMPANY_GIT_RANGE_INVALID_SOURCE';
const sourceVersion = 'company-readonly-v3-worker-failure-v2';
const sourcePrefix = 'COMPANY_READONLY_V3_WORKER_FAILURE_V2 ';
const sourceValue = { version: sourceVersion, taskId, code: sourceCode, sourceFailureReason: 'tree_selection' };
const sourceFrame = (input: unknown): Buffer => Buffer.from(`${sourcePrefix}${JSON.stringify(input)}\n`);

test('source reasons use a version-two frame while the original code-only API remains version-one only', () => {
  for (const reason of ['head_ref', 'delta_base', 'object_lookup', 'object_type', 'tree_selection', 'source_size',
    'safe_view', 'excerpt', 'unexpected'] as const) {
    const encoded = formatCompanyV3WorkerFailure(taskId, sourceCode, reason);
    assert.ok(Buffer.byteLength(encoded) <= 1024);
    assert.deepEqual(JSON.parse(encoded.slice(sourcePrefix.length)), { version: sourceVersion, taskId, code: sourceCode, sourceFailureReason: reason });
    assert.deepEqual(parseCompanyV3WorkerFailureDetails(Buffer.from(encoded), taskId), { code: sourceCode, sourceFailureReason: reason });
    assert.equal(parseCompanyV3WorkerFailure(Buffer.from(encoded), taskId), null);
  }
  const legacy = formatCompanyV3WorkerFailure(taskId, sourceCode);
  assert.deepEqual(parseCompanyV3WorkerFailureDetails(Buffer.from(legacy), taskId), { code: sourceCode });
  assert.equal(parseCompanyV3WorkerFailure(Buffer.from(legacy), taskId), sourceCode);
  assert.deepEqual(JSON.parse(legacy.slice(prefix.length)), { version, taskId, code: sourceCode });
});

test('source reasons cannot be attached to other codes, version-one frames or arbitrary JSON fields', () => {
  for (const changed of [{ ...sourceValue, code }, { ...sourceValue, code: fallback },
    { ...sourceValue, sourceFailureReason: undefined }, { ...sourceValue, sourceFailureReason: null },
    { ...sourceValue, sourceFailureReason: 'SYNTHETIC_PRIVATE_REASON' }, { ...sourceValue, sourceFailureReason: { reason: 'tree_selection' } },
    { ...sourceValue, sourceFailureReason: ['tree_selection'] }, { ...sourceValue, path: '/synthetic/private' },
    { ...sourceValue, version }, { ...sourceValue, taskId: otherId }]) {
    assert.equal(parseCompanyV3WorkerFailureDetails(sourceFrame(changed), taskId), null);
  }
  assert.equal(parseCompanyV3WorkerFailureDetails(frame({ ...sourceValue, version }), taskId), null);
  assert.equal(parseCompanyV3WorkerFailureDetails(frame(sourceValue), taskId), null);
  const duplicate = `{"version":"${sourceVersion}","taskId":"${taskId}","code":"${sourceCode}","sourceFailureReason":"tree_selection","sourceFailureReaso\\u006e":"excerpt"}`;
  assert.equal(parseCompanyV3WorkerFailureDetails(Buffer.from(`${sourcePrefix}${duplicate}\n`), taskId), null);
});

test('mixed-version, duplicate, malformed and partial source frames cannot choose a preferred diagnostic', () => {
  const legacy = formatCompanyV3WorkerFailure(taskId, sourceCode), detailed = formatCompanyV3WorkerFailure(taskId, sourceCode, 'excerpt');
  for (const text of [legacy + detailed, detailed + legacy, detailed + detailed, detailed + sourcePrefix,
    `${legacy}COMPANY_READONLY_V3_WORKER_FAILURE_V3 {}\n`, detailed.trimEnd(), detailed.replace('\n', '\r\n'),
    detailed.replace(sourcePrefix, sourcePrefix.trimEnd()), detailed.replace(taskId, otherId)]) {
    assert.equal(parseCompanyV3WorkerFailureDetails(Buffer.from(text), taskId), null);
    assert.equal(parseCompanyV3WorkerFailure(Buffer.from(text), taskId), null);
  }
});

test('version-two frames obey the existing byte limits and reject invalid byte containers', () => {
  const encoded = formatCompanyV3WorkerFailure(taskId, sourceCode, 'safe_view'), bytes = Buffer.from(encoded);
  const padded = `${sourcePrefix}${' '.repeat(1024 - bytes.length)}${encoded.slice(sourcePrefix.length)}`;
  assert.equal(Buffer.byteLength(padded), 1024);
  assert.deepEqual(parseCompanyV3WorkerFailureDetails(Buffer.from(padded), taskId), { code: sourceCode, sourceFailureReason: 'safe_view' });
  assert.equal(parseCompanyV3WorkerFailureDetails(Buffer.from(padded.replace(sourcePrefix, `${sourcePrefix} `)), taskId), null);
  const maximum = Buffer.concat([Buffer.alloc(65536 - bytes.length - 1, 120), Buffer.from('\n'), bytes]);
  assert.deepEqual(parseCompanyV3WorkerFailureDetails(maximum, taskId), { code: sourceCode, sourceFailureReason: 'safe_view' });
  assert.equal(parseCompanyV3WorkerFailureDetails(Buffer.concat([maximum, Buffer.from('\n')]), taskId), null);
  assert.equal(parseCompanyV3WorkerFailureDetails(Buffer.concat([bytes, Buffer.from([0xff])]), taskId), null);
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length)); shared.set(bytes);
  let accesses = 0;
  const hostile = (): never => { accesses++; throw new Error('SYNTHETIC_PRIVATE_HOOK'); };
  const proxy = new Proxy(bytes, { get: hostile, getPrototypeOf: hostile });
  for (const input of [proxy, shared]) assert.equal(parseCompanyV3WorkerFailureDetails(input, taskId), null);
  assert.equal(accesses, 0);
});

test('source formatting validates fixed reason and code before any foreign property hook can run', () => {
  let accesses = 0;
  const hostile = (): never => { accesses++; throw new Error('SYNTHETIC_PRIVATE_HOOK'); };
  for (const reason of [null, 'SYNTHETIC_PRIVATE_REASON', { toJSON: hostile }, new Proxy({}, { get: hostile, getPrototypeOf: hostile })]) {
    assert.throws(() => formatCompanyV3WorkerFailure(taskId, sourceCode, reason as CompanyGitRangeSourceFailureReason),
      { code: 'COMPANY_READONLY_V3_INVALID_DIAGNOSTIC' });
  }
  assert.throws(() => formatCompanyV3WorkerFailure(taskId, code, 'excerpt'), { code: 'COMPANY_READONLY_V3_INVALID_DIAGNOSTIC' });
  assert.equal(accesses, 0);
});
