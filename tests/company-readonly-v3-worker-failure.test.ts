import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessError } from '../src/domain/errors.js';
import { companyV3WorkerFailureCode, formatCompanyV3WorkerFailure, isCompanyV3WorkerFailureCode,
  parseCompanyV3WorkerFailure, type CompanyV3WorkerFailureCode } from '../src/cli/company-readonly-v3-worker-failure.js';

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
