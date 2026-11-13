import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READONLY_LIVE_RESPONSE_EXTENSION_LIMITS } from '../src/domain/readonly-live.js';
import { projectReadonlyLiveResponseExtensions as project } from '../src/policy/readonly-live-response-extensions.js';

const allowed = ['id', 'object', 'status', 'model', 'output', 'tools', 'tool_usage'];
const response = () => ({ id: 'resp_synthetic', object: 'response', status: 'completed', model: 'gpt-6.1-sol', output: [] });
const rejected = (reason: string) => ({ value: null, reason });
const extension = (value: unknown) => ({ ...response(), extra: value });

test('response extension projection leaves known fields and malformed roots for their original validators', () => {
  for (const value of [null, undefined, false, 1, 'PRIVATE_KNOWN', [], response(), { output: null }, { model: 'wrong' }]) {
    const result = project(value, allowed); assert.equal(result.reason, null); assert.equal(result.value, value);
  }
  const known = { ...response(), output: [{ type: 'function_call', arguments: 'PRIVATE_KNOWN' }], tools: ['wrong'], tool_usage: { invalid: true } };
  const original = { ...known, extra: null }; const result = project(original, allowed);
  assert.equal(result.reason, null); assert.deepEqual(result.value, known); assert.notEqual(result.value, original);
  for (const key of ['output', 'tools', 'tool_usage'] as const) assert.equal((result.value as typeof known)[key], known[key]);
  assert.ok(Object.hasOwn(original, 'extra'));
});

test('response extensions admit finite JSON values while rejecting values that serialization would lose or coerce', () => {
  for (const value of [null, true, false, 0, -0, -5, 1.25, 1e308, '한글', [], {}, [null, -1, false, 'text'],
    { child: { number: 0.5, array: [true, null] } }, Object.assign(Object.create(null), { child: 'text' })]) {
    assert.deepEqual(project(extension(value), allowed), { value: response(), reason: null });
  }
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('PRIVATE'), () => 'PRIVATE', new Date(), new Map(),
    Object.create({ inherited: 'PRIVATE' }), '\ud800', { nested: '\udfff' }, JSON.parse('{"nested":1e400}')]) {
    assert.deepEqual(project(extension(value), allowed), rejected('extension-value'));
  }
  const circular: unknown[] = []; circular.push(circular);
  assert.deepEqual(project(extension(circular), allowed), rejected('extension-value'));
  const reused = { safe: null };
  assert.deepEqual(project(extension([reused, reused]), allowed), { value: response(), reason: null });
});

test('response extension keys and field counts have exact boundaries without widening known control fields', () => {
  assert.deepEqual(READONLY_LIVE_RESPONSE_EXTENSION_LIMITS, { fields: 8, keyCharacters: 64, bytes: 16384, nodes: 256, depth: 8 });
  assert.equal(Object.isFrozen(READONLY_LIVE_RESPONSE_EXTENSION_LIMITS), true);
  for (const key of ['x', '_', '_X9', 'x'.repeat(64)]) {
    assert.deepEqual(project({ ...response(), [key]: null }, allowed), { value: response(), reason: null });
  }
  for (const key of ['', '9name', 'bad-name', 'bad name', '한글', 'x'.repeat(65)]) {
    assert.deepEqual(project({ ...response(), [key]: null }, allowed), rejected('extension-key'));
  }
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`field_${index}`, null]));
  assert.deepEqual(project({ ...response(), ...eight }, allowed), { value: response(), reason: null });
  assert.deepEqual(project({ ...response(), ...eight, ninth: null }, allowed), rejected('extension-limit'));
  const known = { ...response(), type: false };
  assert.deepEqual(project({ ...known, extra: null }, [...allowed, 'type']), { value: known, reason: null });
});

test('response extensions cannot discard registered action, role or prototype control names', () => {
  for (const key of ['type', 'role', 'content', 'input', 'tool_calls', 'function_call', 'function', 'refusal',
    'actions', 'commands', 'command', 'execution', 'tool_results', '__proto__', 'constructor', 'prototype']) {
    assert.deepEqual(project({ ...response(), [key]: null }, allowed), rejected('extension-control'));
  }
  // Unused nested data is copied safely and discarded; it is never interpreted as a command or a prototype.
  const nested = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"command":"data"}');
  assert.deepEqual(project(extension(nested), allowed), { value: response(), reason: null });
  assert.equal(Object.getPrototypeOf(nested), Object.prototype); assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  const knownPrototype = JSON.parse('{"__proto__":{"safe":true},"extra":null}');
  const copied = project(knownPrototype, ['__proto__']);
  assert.equal(copied.reason, null); assert.equal(Object.getPrototypeOf(copied.value), Object.prototype);
  assert.equal(Object.hasOwn(copied.value as object, '__proto__'), true);
  assert.equal((copied.value as Record<string, unknown>).__proto__, knownPrototype.__proto__);
});

test('response extension depth and aggregate node budgets include the outer extension bag', () => {
  const nested = (depth: number): unknown => {
    let value: unknown = null; for (let index = 1; index < depth; index++) value = [value]; return value;
  };
  assert.deepEqual(project(extension(nested(8)), allowed), { value: response(), reason: null });
  assert.deepEqual(project(extension(nested(9)), allowed), rejected('extension-limit'));
  assert.deepEqual(project(extension(Array.from({ length: 254 }, () => null)), allowed), { value: response(), reason: null });
  assert.deepEqual(project(extension(Array.from({ length: 255 }, () => null)), allowed), rejected('extension-limit'));
  const full = { ...response(), first: Array.from({ length: 126 }, () => null), second: Array.from({ length: 127 }, () => null) };
  assert.deepEqual(project(full, allowed), { value: response(), reason: null });
  full.first.push(null); assert.deepEqual(project(full, allowed), rejected('extension-limit'));
  const wide = Object.fromEntries(Array.from({ length: 255 }, (_, index) => [`k${index}`, null]));
  assert.deepEqual(project(extension(wide), allowed), rejected('extension-limit'));
});

test('response extension encoded byte limits include keys, escaping and multibyte text across all additions', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ extra: '' }));
  const maximum = 16384 - overhead;
  assert.deepEqual(project(extension('x'.repeat(maximum)), allowed), { value: response(), reason: null });
  assert.deepEqual(project(extension('x'.repeat(maximum + 1)), allowed), rejected('extension-limit'));
  assert.deepEqual(project(extension('x'.repeat(maximum - 3) + '한'), allowed), { value: response(), reason: null });
  assert.deepEqual(project(extension('x'.repeat(maximum - 2) + '한'), allowed), rejected('extension-limit'));
  assert.deepEqual(project(extension('\n'.repeat(maximum / 2)), allowed), { value: response(), reason: null });
  assert.deepEqual(project(extension('\n'.repeat(maximum / 2 + 1)), allowed), rejected('extension-limit'));
  const multiple = { ...response(), first: 'x'.repeat(8190), second: 'x'.repeat(8190) };
  assert.deepEqual(project(multiple, allowed), rejected('extension-limit'));
  const known = { ...response(), output: 'x'.repeat(20000) };
  assert.deepEqual(project({ ...known, extra: null }, allowed), { value: known, reason: null });
});

test('response extension sensitive scans use original values so count aliases cannot erase canaries', () => {
  const providerCanary = 'sk-1234567890abcdef';
  const collisions = [
    { count_input_units: providerCanary, input_tokens: 0 },
    { input_tokens: 0, count_input_units: providerCanary },
    { count_output_units_details: { value: providerCanary }, output_tokens_details: { reasoning_tokens: 0 } },
  ];
  for (const value of [...collisions, providerCanary, { text: `Bearer SYNTHETICCANARY123` }, { password: true },
    { nested: [providerCanary] }, { input_tokens: 0 }]) {
    const result = project(extension(value), allowed);
    assert.deepEqual(result, rejected('extension-sensitive'));
    assert.doesNotMatch(JSON.stringify(result), /1234567890abcdef|SYNTHETICCANARY|count_input|password|input_tokens/);
  }
  assert.deepEqual(project({ ...response(), password: true }, allowed), rejected('extension-sensitive'));
});

test('response extension validation never evaluates input getters at any level', () => {
  let reads = 0; const get = () => { reads++; throw new Error('PRIVATE_GETTER'); };
  for (const key of ['extra', 'model']) {
    const value = extension(null); Object.defineProperty(value, key, { enumerable: true, get });
    assert.deepEqual(project(value, allowed), rejected('extension-value'));
  }
  const nested = Object.defineProperty({}, 'child', { enumerable: true, get });
  assert.deepEqual(project(extension(nested), allowed), rejected('extension-value'));
  const array = [null]; Object.defineProperty(array, '0', { get });
  assert.deepEqual(project(extension(array), allowed), rejected('extension-value'));
  const names = ['id']; Object.defineProperty(names, '0', { get });
  assert.deepEqual(project(response(), names), rejected('extension-key'));
  assert.equal(reads, 0);
});

test('response extension validation rejects hidden data, symbols, sparse arrays and malformed allowed-key contracts', () => {
  const hidden = Object.defineProperty({}, 'PRIVATE', { value: true });
  const symbol = { [Symbol('PRIVATE')]: true };
  const arraySymbol = Object.assign([], { [Symbol('PRIVATE')]: true });
  const arrayHidden: unknown[] = []; Object.defineProperty(arrayHidden, 'PRIVATE', { value: true });
  class CustomArray extends Array<unknown> {}
  for (const value of [hidden, symbol, new Array(1), arraySymbol, arrayHidden, new CustomArray()]) {
    assert.deepEqual(project(extension(value), allowed), rejected('extension-value'));
  }
  for (const value of [hidden, symbol, Object.create({ extra: null })]) assert.deepEqual(project(value, allowed), rejected('extension-value'));
  for (const names of [null, {}, 'id', ['id', 'id'], ['bad-name'], ['x'.repeat(65)], [null], new Array(1), arraySymbol, arrayHidden,
    Array.from({ length: 129 }, (_, index) => `k${index}`)]) {
    assert.deepEqual(project(response(), names as readonly string[]), rejected('extension-key'));
  }
});

test('response extension projection preserves frozen and null-prototype input and suppresses arbitrary inspection failures', () => {
  const nested = Object.freeze({ safe: Object.freeze([null]) });
  const original = Object.freeze(Object.assign(Object.create(null), response(), { extra: nested }));
  const result = project(original, Object.freeze([...allowed]));
  assert.equal(result.reason, null); assert.equal(Object.getPrototypeOf(result.value), null);
  assert.equal((result.value as Record<string, unknown>).output, original.output);
  assert.equal(original.extra, nested); assert.equal(Object.hasOwn(original, 'extra'), true);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const malicious = new Proxy({}, { getPrototypeOf: () => { throw revoked.proxy; } });
  const rawError = new Proxy({}, { ownKeys: () => { throw new Error('PRIVATE_EXCEPTION_CANARY'); } });
  for (const value of [revoked.proxy, malicious, rawError]) {
    const failure = project(value, allowed); assert.deepEqual(failure, rejected('extension-value'));
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE/);
  }
});
