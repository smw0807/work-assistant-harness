import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessError } from '../src/domain/errors.js';
import { classifyReadonlyLiveHeaders, copyReadonlyLiveHeaderDiagnostics, type ReadonlyLiveHeaderDiagnostics } from '../src/policy/readonly-live-http-diagnostics.js';
import { decodeReadonlyLiveResponse } from '../src/policy/readonly-live-protocol.js';

const empty = (): ReadonlyLiveHeaderDiagnostics => ({ mediaType: 'missing', contentEncoding: 'missing',
  invalidNameCount: 0, legacyInvalidNameCount: 0, invalidValueCount: 0, tabValueCount: 0,
  duplicateNonCookieCount: 0, cookieCount: 0, locationPresent: false, retryAfterPresent: false });
const countKeys = ['invalidNameCount', 'legacyInvalidNameCount', 'invalidValueCount', 'tabValueCount', 'duplicateNonCookieCount', 'cookieCount'] as const;
const flags = ['locationPresent', 'retryAfterPresent'] as const;
const invalid = (error: unknown): boolean => error instanceof HarnessError && error.code === 'READONLY_LIVE_INVALID_RESPONSE'
  && !String(error).includes('PRIVATE_CANARY');
const completed = (): string => JSON.stringify({ id: 'resp_synthetic', object: 'response', status: 'completed', model: 'gpt-6.1-sol',
  output: [{ id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'synthetic result', annotations: [] }] }] });

test('HTTP diagnostics classify only fixed media and encoding categories', () => {
  assert.deepEqual(classifyReadonlyLiveHeaders([]), empty());
  for (const [value, expected] of [['application/json', 'json'], [' APPLICATION/JSON ; charset="UTF-8" ', 'json'],
    ['text/event-stream; charset=utf-8', 'event-stream'], ['TEXT/EVENT-STREAM', 'event-stream'],
    ['application/PRIVATE_CANARY', 'other'], ['', 'other']] as const) {
    assert.deepEqual(classifyReadonlyLiveHeaders(['CONTENT-TYPE', value]), { ...empty(), mediaType: expected });
  }
  for (const [value, expected] of [['identity', 'identity'], [' IDENTITY ', 'identity'], ['GZIP', 'gzip'], ['br', 'br'],
    ['Deflate', 'deflate'], ['gzip, br', 'other'], ['PRIVATE_CANARY', 'other'], ['', 'other']] as const) {
    assert.deepEqual(classifyReadonlyLiveHeaders(['Content-Encoding', value]), { ...empty(), contentEncoding: expected });
  }
});

test('HTTP diagnostics count duplicate pairs case insensitively while excluding repeated cookies', () => {
  const result = classifyReadonlyLiveHeaders(['Content-Type', 'application/json', 'content-type', 'text/event-stream', 'CONTENT-TYPE', 'PRIVATE_CANARY',
    'Content-Encoding', 'identity', 'content-encoding', 'gzip', 'X-Synthetic', 'one', 'x-synthetic', 'two',
    'Set-Cookie', 'first=PRIVATE_CANARY', 'set-cookie', 'second=PRIVATE_CANARY']);
  assert.deepEqual(result, { ...empty(), mediaType: 'duplicate', contentEncoding: 'duplicate', duplicateNonCookieCount: 4, cookieCount: 2 });
  assert.equal(JSON.stringify(result).includes('PRIVATE_CANARY'), false);
});

test('HTTP diagnostic counters overlap instead of claiming mutually exclusive rejection causes', () => {
  const result = classifyReadonlyLiveHeaders(['x_valid', 'safe', '1valid', 'safe', 'bad name', 'safe',
    'x-tab', 'one\ttwo', 'x-invalid', 'one\rtwo', 'x-both', 'one\t\ntwo', 'Set-Cookie', 'a=PRIVATE_CANARY\t\0']);
  assert.equal(result.invalidNameCount, 1);
  assert.equal(result.legacyInvalidNameCount, 3);
  assert.equal(result.invalidValueCount, 3);
  assert.equal(result.tabValueCount, 3);
  assert.equal(result.cookieCount, 1);
  assert.equal(result.duplicateNonCookieCount, 0);
  assert.ok(result.invalidNameCount <= result.legacyInvalidNameCount);
  assert.deepEqual(classifyReadonlyLiveHeaders(['bad name', '\t\n']), {
    ...empty(), invalidNameCount: 1, legacyInvalidNameCount: 1, invalidValueCount: 1, tabValueCount: 1,
  });
});

test('HTTP diagnostics retain presence flags without retaining unknown names, redirect destinations or cookie values', () => {
  const raw = ['X-PRIVATE_CANARY', 'PRIVATE_CANARY', 'Content-Type', 'application/PRIVATE_CANARY',
    'Content-Encoding', 'PRIVATE_CANARY', 'Location', 'https://PRIVATE_CANARY.invalid/private', 'Retry-After', 'PRIVATE_CANARY',
    'Set-Cookie', 'session=PRIVATE_CANARY'];
  const result = classifyReadonlyLiveHeaders(raw);
  assert.deepEqual(result, { ...empty(), mediaType: 'other', contentEncoding: 'other', cookieCount: 1, legacyInvalidNameCount: 1,
    locationPresent: true, retryAfterPresent: true });
  assert.deepEqual(Object.keys(result).sort(), Object.keys(empty()).sort());
  assert.equal(Object.values(result).every((value) => ['string', 'number', 'boolean'].includes(typeof value)), true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY|session=|https:|x-private/i);
});

test('HTTP diagnostics and copies preserve frozen input and return independent plain objects', () => {
  const input = Object.freeze(['Content-Type', 'application/json', 'Set-Cookie', 'a=PRIVATE_CANARY']);
  const before = [...input];
  const classified = Object.freeze(classifyReadonlyLiveHeaders(input));
  const copied = copyReadonlyLiveHeaderDiagnostics(classified);
  assert.deepEqual(input, before); assert.deepEqual(copied, classified); assert.notEqual(copied, classified);
  copied.mediaType = 'other'; copied.cookieCount = 99;
  assert.equal(classified.mediaType, 'json'); assert.equal(classified.cookieCount, 1);
  const inherited = Object.assign(Object.create({ raw: 'PRIVATE_CANARY' }), empty()) as ReadonlyLiveHeaderDiagnostics;
  const plain = copyReadonlyLiveHeaderDiagnostics(inherited);
  assert.equal(Object.getPrototypeOf(plain), Object.prototype); assert.equal('raw' in plain, false);
});

test('HTTP diagnostic copies accept exactly the published enums and inclusive count bounds', () => {
  for (const mediaType of ['missing', 'duplicate', 'json', 'event-stream', 'other'] as const) {
    assert.equal(copyReadonlyLiveHeaderDiagnostics({ ...empty(), mediaType }).mediaType, mediaType);
  }
  for (const contentEncoding of ['missing', 'duplicate', 'identity', 'gzip', 'br', 'deflate', 'other'] as const) {
    assert.equal(copyReadonlyLiveHeaderDiagnostics({ ...empty(), contentEncoding }).contentEncoding, contentEncoding);
  }
  for (const key of countKeys) for (const count of [0, 1, 100_000]) {
    assert.equal(copyReadonlyLiveHeaderDiagnostics({ ...empty(), [key]: count })[key], count);
  }
  for (const key of flags) for (const value of [true, false]) assert.equal(copyReadonlyLiveHeaderDiagnostics({ ...empty(), [key]: value })[key], value);
});

test('HTTP diagnostic copies reject extra and missing fields without echoing raw material', () => {
  for (const key of Object.keys(empty())) {
    const missing = { ...empty() } as unknown as Record<string, unknown>; delete missing[key];
    assert.throws(() => copyReadonlyLiveHeaderDiagnostics(missing as unknown as ReadonlyLiveHeaderDiagnostics), invalid);
  }
  for (const extra of [{ raw: 'PRIVATE_CANARY' }, { headers: [['authorization', 'PRIVATE_CANARY']] },
    { headerName: 'PRIVATE_CANARY' }, { cookie: 'PRIVATE_CANARY' }]) {
    assert.throws(() => copyReadonlyLiveHeaderDiagnostics({ ...empty(), ...extra }), invalid);
  }
  for (const value of [undefined, null, [], {}, 'PRIVATE_CANARY', 1, true]) {
    assert.throws(() => copyReadonlyLiveHeaderDiagnostics(value as ReadonlyLiveHeaderDiagnostics), invalid);
  }
});

test('HTTP diagnostic copies reject non-enum values, nonintegers, invalid flags and nested payloads', () => {
  for (const key of ['mediaType', 'contentEncoding']) for (const value of ['PRIVATE_CANARY', '', null, undefined, 1, {}, []]) {
    assert.throws(() => copyReadonlyLiveHeaderDiagnostics({ ...empty(), [key]: value } as ReadonlyLiveHeaderDiagnostics), invalid);
  }
  for (const key of countKeys) for (const value of [-1, 0.5, 100_001, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null, undefined, {}, []]) {
    assert.throws(() => copyReadonlyLiveHeaderDiagnostics({ ...empty(), [key]: value } as ReadonlyLiveHeaderDiagnostics), invalid);
  }
  for (const key of flags) for (const value of [0, 1, 'true', null, undefined, {}, []]) {
    assert.throws(() => copyReadonlyLiveHeaderDiagnostics({ ...empty(), [key]: value } as ReadonlyLiveHeaderDiagnostics), invalid);
  }
});

test('identical HTTP diagnostics can describe success and distinct precise MIME rejection causes', async () => {
  const variants = [
    { value: 'application/json;charset=utf-8', failure: null },
    { value: 'application/json;charset=iso-8859-1', failure: 'READONLY_LIVE_INVALID_RESPONSE_DECODE_CONTENT_TYPE_CHARSET' },
    { value: 'application/json;boundary=PRIVATE_CANARY', failure: 'READONLY_LIVE_INVALID_RESPONSE_DECODE_CONTENT_TYPE_FORMAT' },
  ];
  const expected = classifyReadonlyLiveHeaders(['Content-Type', variants[0]!.value]);
  for (const variant of variants) {
    assert.deepEqual(classifyReadonlyLiveHeaders(['Content-Type', variant.value]), expected);
    const response = { status: 200, headers: [['Content-Type', variant.value]] as [string, string][],
      body: { async *[Symbol.asyncIterator]() { yield Buffer.from(completed()); } } };
    const result = decodeReadonlyLiveResponse(response, new AbortController().signal, { profileId: 'codex-chatgpt-sse-v4' });
    if (variant.failure) await assert.rejects(result, (error: unknown) => {
      assert.equal((error as HarnessError).code, variant.failure); assert.doesNotMatch(String(error), /PRIVATE_CANARY|iso-8859/); return true;
    });
    else assert.equal((await result).text, 'synthetic result');
  }
});
