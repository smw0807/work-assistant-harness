import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyReadonlyLiveSseEnvelope, copyReadonlyLiveSseEnvelopeDiagnostic,
  type ReadonlyLiveSseEnvelopeDiagnostic } from '../src/policy/readonly-live-sse-envelope-diagnostics.js';

const required = ['type', 'sequence_number', 'response'] as const;
const empty = (): ReadonlyLiveSseEnvelopeDiagnostic => ({ missing: [], unexpected: [], observedUnexpected: 0, overflow: false });
const fieldNames = ['type', 'sequence_number', 'response', 'response_id', 'output_index', 'item', 'item_id',
  'content_index', 'part', 'delta', 'text', 'summary_index', 'obfuscation', 'logprobs',
  'event_id', 'id', 'created_at', 'stream_id', 'object', 'model', 'status', 'usage', 'tools'];
const types = [[null, 'null'], [true, 'boolean'], [0, 'nonnegative-integer'], [-2, 'negative-integer'],
  [1.5, 'number'], ['PRIVATE_VALUE_CANARY', 'string'], [[], 'array'], [{ nested: 'PRIVATE_VALUE_CANARY' }, 'object']] as const;

test('SSE envelope diagnostics distinguish missing required and unexpected fields without authorizing metadata', () => {
  assert.deepEqual(classifyReadonlyLiveSseEnvelope({ type: 'response.created', sequence_number: 0, response: {} }, required, []), empty());
  assert.deepEqual(classifyReadonlyLiveSseEnvelope({ type: 'response.created', sequence_number: 0, event_id: 'PRIVATE_ID_CANARY' }, required, []), {
    missing: ['response'], unexpected: [{ field: 'event-id', valueType: 'string', count: 1 }], observedUnexpected: 1, overflow: false,
  });
  assert.deepEqual(classifyReadonlyLiveSseEnvelope({ type: '', response_id: '' }, required, ['response_id']), {
    ...empty(), missing: ['response', 'sequence-number'],
  });
  assert.deepEqual(classifyReadonlyLiveSseEnvelope({}, ['text', 'type', 'item_id'], []), {
    ...empty(), missing: ['item-id', 'text', 'type'],
  });
});

test('SSE envelope diagnostics map only fixed field names and top-level value types', () => {
  for (const name of fieldNames) for (const [value, valueType] of types) {
    const result = classifyReadonlyLiveSseEnvelope({ [name]: value }, [], []);
    assert.deepEqual(result, { ...empty(), unexpected: [{ field: name.replaceAll('_', '-'), valueType, count: 1 }], observedUnexpected: 1 });
    assert.deepEqual(copyReadonlyLiveSseEnvelopeDiagnostic(result), result);
  }
  for (const number of [-0, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const result = classifyReadonlyLiveSseEnvelope({ unknown: number }, [], []);
    const expected = Number.isSafeInteger(number) ? number >= 0 ? 'nonnegative-integer' : 'negative-integer' : 'number';
    assert.equal(result?.unexpected[0]?.valueType, expected);
  }
});

test('SSE unknown fields aggregate by type without raw keys, strings, nested contents or paths', () => {
  const value = { PRIVATE_KEY_CANARY: 'PRIVATE_VALUE_CANARY', anotherUnknown: 'PRIVATE_OTHER_CANARY',
    'authorization=PRIVATE_TOKEN_CANARY': { secret: 'PRIVATE_NESTED_CANARY' }, id: 'PRIVATE_ID_CANARY' };
  const result = classifyReadonlyLiveSseEnvelope(value, [], []);
  assert.deepEqual(result, { missing: [], unexpected: [
    { field: 'id', valueType: 'string', count: 1 }, { field: 'other', valueType: 'object', count: 1 },
    { field: 'other', valueType: 'string', count: 2 },
  ], observedUnexpected: 4, overflow: false });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|authorization|anotherUnknown|secret/);
  assert.deepEqual(copyReadonlyLiveSseEnvelopeDiagnostic(result), result);
});

test('SSE property bounds preserve deterministic partial counts and all supported type correlations', () => {
  for (const count of [127, 128, 129, 260]) {
    const entries = Array.from({ length: count }, (_, index) => [`unknown-${index}`, 'PRIVATE_VALUE_CANARY']);
    const result = classifyReadonlyLiveSseEnvelope(Object.fromEntries(entries), [], []);
    assert.deepEqual(result, { missing: [], unexpected: [{ field: 'other', valueType: 'string', count: Math.min(count, 128) }],
      observedUnexpected: Math.min(count, 128), overflow: count > 128 });
    assert.deepEqual(classifyReadonlyLiveSseEnvelope(Object.fromEntries(entries.reverse()), [], []), result);
    assert.deepEqual(copyReadonlyLiveSseEnvelopeDiagnostic(result), result);
  }
  const value = Object.fromEntries([...fieldNames.map((name) => [name, 'PRIVATE']),
    ...types.map(([item], index) => [`unknown-${index}`, item])]);
  const result = classifyReadonlyLiveSseEnvelope(value, [], []);
  assert.equal(result?.unexpected.length, 31); assert.equal(result?.observedUnexpected, 31); assert.equal(result?.overflow, false);
  assert.deepEqual(copyReadonlyLiveSseEnvelopeDiagnostic(result), result);
});

test('SSE classifier rejects invalid helper contracts and non-plain roots', () => {
  for (const root of [undefined, null, [], '', 0, true, new Date(), new Map(), Object.create({ inherited: true })]) {
    assert.equal(classifyReadonlyLiveSseEnvelope(root, required, []), null);
  }
  assert.deepEqual(classifyReadonlyLiveSseEnvelope(Object.create(null), required, []), { ...empty(), missing: ['response', 'sequence-number', 'type'] });
  for (const names of [['PRIVATE_KEY_CANARY'], ['type', 'type'], ['event_id'], ['stream_id'], ['model'], ['sequence-number'],
    [null], [1], new Array(1), 'type', null]) {
    assert.equal(classifyReadonlyLiveSseEnvelope({}, names as readonly string[], []), null);
    assert.equal(classifyReadonlyLiveSseEnvelope({}, [], names as readonly string[]), null);
  }
  assert.equal(classifyReadonlyLiveSseEnvelope({}, ['type'], ['type']), null);
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('PRIVATE'), () => 'PRIVATE']) {
    assert.equal(classifyReadonlyLiveSseEnvelope({ type: value }, [], []), null);
  }
});

test('SSE classifier never invokes root or contract getters and rejects symbols and hidden fields', () => {
  let getters = 0;
  const accessor = { get type() { getters += 1; throw new Error('PRIVATE'); } };
  assert.equal(classifyReadonlyLiveSseEnvelope(accessor, required, []), null);
  const names = ['type']; Object.defineProperty(names, '0', { get: () => { getters += 1; return 'type'; } });
  assert.equal(classifyReadonlyLiveSseEnvelope({}, names, []), null);
  const lateAccessor = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`a${index}`, 0]));
  Object.defineProperty(lateAccessor, 'z', { enumerable: true, get: () => { getters += 1; return 'PRIVATE'; } });
  assert.equal(classifyReadonlyLiveSseEnvelope(lateAccessor, [], []), null);
  for (const root of [{ [Symbol('PRIVATE')]: true }, Object.defineProperty({}, 'PRIVATE', { value: true })]) {
    assert.equal(classifyReadonlyLiveSseEnvelope(root, [], []), null);
  }
  const nested = { get secret() { getters += 1; return 'PRIVATE'; } };
  assert.deepEqual(classifyReadonlyLiveSseEnvelope({ extra: nested }, [], []), {
    ...empty(), unexpected: [{ field: 'other', valueType: 'object', count: 1 }], observedUnexpected: 1,
  });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(classifyReadonlyLiveSseEnvelope(revoked.proxy, [], []), null); assert.equal(getters, 0);
});

test('SSE classification and copying preserve frozen inputs and return independent nested structures', () => {
  const source = Object.freeze({ sequence_number: 0, PRIVATE: 'PRIVATE_VALUE_CANARY' });
  const requiredFields = Object.freeze([...required]); const optionalFields = Object.freeze(['response_id']);
  const result = classifyReadonlyLiveSseEnvelope(source, requiredFields, optionalFields)!;
  Object.freeze(result.missing); result.unexpected.forEach(Object.freeze); Object.freeze(result.unexpected); Object.freeze(result);
  const copied = copyReadonlyLiveSseEnvelopeDiagnostic(result)!;
  assert.deepEqual(copied, result); assert.notEqual(copied, result); assert.notEqual(copied.missing, result.missing);
  assert.notEqual(copied.unexpected, result.unexpected); assert.notEqual(copied.unexpected[0], result.unexpected[0]);
  copied.missing.pop(); copied.unexpected[0]!.count = 100;
  assert.deepEqual(source, { sequence_number: 0, PRIVATE: 'PRIVATE_VALUE_CANARY' });
  assert.deepEqual(result.missing, ['response', 'type']); assert.equal(result.unexpected[0]?.count, 1);
  assert.deepEqual(requiredFields, required); assert.deepEqual(optionalFields, ['response_id']);
});

test('SSE diagnostic copies reject missing, extra, raw and non-enum fields at every level', () => {
  const valid = { ...empty(), unexpected: [{ field: 'other', valueType: 'string', count: 1 }], observedUnexpected: 1 };
  for (const key of Object.keys(valid)) {
    const missing = { ...valid } as Record<string, unknown>; delete missing[key];
    assert.equal(copyReadonlyLiveSseEnvelopeDiagnostic(missing), null);
  }
  for (const value of [null, undefined, [], new Date(), { ...valid, raw: 'PRIVATE' }, { ...valid, [Symbol('PRIVATE')]: 1 },
    { ...valid, missing: ['PRIVATE'] }, { ...valid, missing: ['event-id'] }, { ...valid, missing: ['type', 'type'] },
    { ...valid, unexpected: [{ ...valid.unexpected[0], field: 'PRIVATE' }] },
    { ...valid, unexpected: [{ ...valid.unexpected[0], valueType: 'PRIVATE' }] },
    { ...valid, unexpected: [{ ...valid.unexpected[0], raw: 'PRIVATE' }] }]) {
    assert.equal(copyReadonlyLiveSseEnvelopeDiagnostic(value), null);
  }
  for (const key of ['field', 'valueType', 'count']) {
    const entry = { ...valid.unexpected[0] } as Record<string, unknown>; delete entry[key];
    assert.equal(copyReadonlyLiveSseEnvelopeDiagnostic({ ...valid, unexpected: [entry] }), null);
  }
});

test('SSE diagnostic copies reject inconsistent counts, duplicate tuples, impossible named counts and false overflow claims', () => {
  const entry = { field: 'other', valueType: 'string', count: 1 };
  for (const count of [-1, 0, 0.5, 129, NaN, Infinity, '1', null, undefined]) {
    assert.equal(copyReadonlyLiveSseEnvelopeDiagnostic({ ...empty(), unexpected: [{ ...entry, count }], observedUnexpected: count }), null);
  }
  for (const value of [
    { ...empty(), unexpected: [entry] }, { ...empty(), observedUnexpected: 1 }, { ...empty(), overflow: true },
    { ...empty(), overflow: 1 }, { ...empty(), unexpected: [entry, entry], observedUnexpected: 2 },
    { ...empty(), unexpected: Array.from({ length: 33 }, () => entry), observedUnexpected: 33 },
    { ...empty(), unexpected: [{ ...entry, field: 'id', count: 2 }], observedUnexpected: 2 },
    { ...empty(), unexpected: [{ ...entry, field: 'id' }, { ...entry, field: 'id', valueType: 'number' }], observedUnexpected: 2 },
    { ...empty(), missing: ['type'], unexpected: [{ ...entry, field: 'type' }], observedUnexpected: 1 },
    { ...empty(), unexpected: [{ ...entry, count: 113 }], observedUnexpected: 113, overflow: true },
  ]) assert.equal(copyReadonlyLiveSseEnvelopeDiagnostic(value), null);
  assert.notEqual(copyReadonlyLiveSseEnvelopeDiagnostic({ ...empty(), unexpected: [{ ...entry, count: 128 }], observedUnexpected: 128, overflow: true }), null);
});

test('SSE diagnostic copies reject accessors, holes, symbols and hidden array properties without evaluation', () => {
  let getters = 0;
  const get = () => { getters += 1; throw new Error('PRIVATE'); };
  for (const key of Object.keys(empty())) {
    const candidate = { ...empty() }; Object.defineProperty(candidate, key, { get });
    assert.equal(copyReadonlyLiveSseEnvelopeDiagnostic(candidate), null);
  }
  for (const key of ['field', 'valueType', 'count']) {
    const entry = { field: 'other', valueType: 'string', count: 1 }; Object.defineProperty(entry, key, { get });
    assert.equal(copyReadonlyLiveSseEnvelopeDiagnostic({ ...empty(), unexpected: [entry], observedUnexpected: 1 }), null);
  }
  for (const key of ['missing', 'unexpected']) {
    const accessor = ['type']; Object.defineProperty(accessor, '0', { get });
    const hidden: unknown[] = []; Object.defineProperty(hidden, 'PRIVATE', { value: true });
    for (const value of [new Array(1), accessor, hidden, Object.assign([], { [Symbol('PRIVATE')]: true })]) {
      assert.equal(copyReadonlyLiveSseEnvelopeDiagnostic({ ...empty(), [key]: value }), null);
    }
  }
  assert.equal(getters, 0);
});
