import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyReadonlyLiveResponseEnvelope, copyReadonlyLiveResponseEnvelopeDiagnostic,
  type ReadonlyLiveResponseEnvelopeDiagnostic } from '../src/policy/readonly-live-response-envelope-diagnostics.js';

const required = ['id', 'object', 'status', 'model', 'output'] as const;
const optional = ['created_at', 'completed_at', 'background', 'error', 'incomplete_details', 'instructions',
  'max_output_tokens', 'max_tool_calls', 'parallel_tool_calls', 'previous_response_id', 'prompt_cache_key', 'prompt_cache_retention',
  'reasoning', 'safety_identifier', 'service_tier', 'store', 'temperature', 'text', 'tool_choice', 'tools', 'top_logprobs', 'top_p',
  'truncation', 'usage', 'user', 'metadata', 'access_programs', 'tool_usage'] as const;
const diagnosticOnly = ['conversation', 'prompt_cache_diagnostics', 'max_completion_tokens', 'request_id', 'stream_id',
  'system_fingerprint', 'routing', 'prompt_cache_status'] as const;
const fields = [...required, ...optional, ...diagnosticOnly];
const types = [[null, 'null'], [true, 'boolean'], [0, 'nonnegative-integer'], [-2, 'negative-integer'],
  [1.5, 'number'], ['PRIVATE_VALUE_CANARY', 'string'], [[], 'array'], [{ nested: 'PRIVATE_VALUE_CANARY' }, 'object']] as const;
const empty = (): ReadonlyLiveResponseEnvelopeDiagnostic => ({ missing: [], unexpected: [], observedUnexpected: 0, overflow: false });

test('response envelope observations separate missing required fields from profile-specific optional and diagnostic-only fields', () => {
  const value = { id: 'resp_PRIVATE', object: 'response', status: 'in_progress', model: 'gpt-6.1-sol', output: [] };
  assert.deepEqual(classifyReadonlyLiveResponseEnvelope(value, required, optional), empty());
  assert.deepEqual(classifyReadonlyLiveResponseEnvelope({ id: 'resp_PRIVATE', access_programs: null }, required, []), {
    missing: ['model', 'object', 'output', 'status'], unexpected: [{ field: 'access-programs', valueType: 'null', count: 1 }],
    observedUnexpected: 1, overflow: false,
  });
  const allOptional = Object.fromEntries(optional.map((name) => [name, null]));
  assert.deepEqual(classifyReadonlyLiveResponseEnvelope({ ...value, ...allOptional }, required, optional), empty());
  for (const name of diagnosticOnly) {
    assert.equal(classifyReadonlyLiveResponseEnvelope({ ...value, [name]: null }, required, optional)?.unexpected[0]?.field, name.replaceAll('_', '-'));
    assert.equal(classifyReadonlyLiveResponseEnvelope(value, required, [name]), null);
  }
  // Observation checks presence only; protocol validation remains responsible for actual values.
  assert.deepEqual(classifyReadonlyLiveResponseEnvelope(Object.fromEntries(required.map((name) => [name, false])), required, []), empty());
});

test('response envelope labels and eight value categories never expose raw names, values or nested contents', () => {
  for (const name of fields) for (const [value, valueType] of types) {
    const diagnostic = classifyReadonlyLiveResponseEnvelope({ [name]: value }, [], []);
    assert.deepEqual(diagnostic, { ...empty(), unexpected: [{ field: name.replaceAll('_', '-'), valueType, count: 1 }], observedUnexpected: 1 });
    assert.deepEqual(copyReadonlyLiveResponseEnvelopeDiagnostic(diagnostic), diagnostic);
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE|nested/);
  }
  const diagnostic = classifyReadonlyLiveResponseEnvelope({ PRIVATE_NAME: 'PRIVATE_VALUE', anotherUnknown: 'PRIVATE_SECOND',
    'authorization=PRIVATE_TOKEN': { nested: 'PRIVATE_NESTED' } }, [], []);
  assert.deepEqual(diagnostic, { ...empty(), unexpected: [{ field: 'other', valueType: 'object', count: 1 },
    { field: 'other', valueType: 'string', count: 2 }], observedUnexpected: 3 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE|authorization|anotherUnknown|nested/);
  for (const number of [-0, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const result = classifyReadonlyLiveResponseEnvelope({ unknown: number }, [], []);
    assert.equal(result?.unexpected[0]?.valueType, Number.isSafeInteger(number) ? number >= 0 ? 'nonnegative-integer' : 'negative-integer' : 'number');
  }
});

test('response envelope property and tuple limits produce deterministic partial observations that remain copyable', () => {
  for (const count of [127, 128, 129, 260]) {
    const entries = Array.from({ length: count }, (_, index) => [`unknown-${index}`, 'PRIVATE_VALUE']);
    const diagnostic = classifyReadonlyLiveResponseEnvelope(Object.fromEntries(entries), [], []);
    assert.deepEqual(diagnostic, { ...empty(), unexpected: [{ field: 'other', valueType: 'string', count: Math.min(count, 128) }],
      observedUnexpected: Math.min(count, 128), overflow: count > 128 });
    assert.deepEqual(classifyReadonlyLiveResponseEnvelope(Object.fromEntries(entries.reverse()), [], []), diagnostic);
    assert.deepEqual(copyReadonlyLiveResponseEnvelopeDiagnostic(diagnostic), diagnostic);
  }
  const full = Object.fromEntries(fields.map((name) => [name, null]));
  const diagnostic = classifyReadonlyLiveResponseEnvelope(full, [], [])!;
  assert.equal(diagnostic.unexpected.length, 32); assert.equal(diagnostic.observedUnexpected, 32); assert.equal(diagnostic.overflow, true);
  assert.deepEqual(classifyReadonlyLiveResponseEnvelope(Object.fromEntries(Object.entries(full).reverse()), [], []), diagnostic);
  assert.deepEqual(copyReadonlyLiveResponseEnvelopeDiagnostic(diagnostic), diagnostic);
  const fullAllowed = Object.fromEntries([...required, ...optional].map((name) => [name, null]));
  const bounded = classifyReadonlyLiveResponseEnvelope({ ...fullAllowed,
    ...Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`z${index}`, true])) }, required, optional)!;
  assert.equal(bounded.observedUnexpected, 95); assert.equal(bounded.overflow, true);
  assert.deepEqual(copyReadonlyLiveResponseEnvelopeDiagnostic(bounded), bounded);
});

test('response envelope helper contracts cannot promote diagnostic names or malformed arrays into allowed fields', () => {
  for (const names of [['PRIVATE'], ['id', 'id'], ['usage'], ['conversation'], ['sequence_number'], ['request-id'],
    [null], [1], new Array(1), 'id', null]) {
    assert.equal(classifyReadonlyLiveResponseEnvelope({}, names as readonly string[], []), null);
  }
  for (const names of [['PRIVATE'], ['usage', 'usage'], ['id'], ['conversation'], ['request_id'], [null], [1], new Array(1), 'usage', null]) {
    assert.equal(classifyReadonlyLiveResponseEnvelope({}, [], names as readonly string[]), null);
  }
  assert.equal(classifyReadonlyLiveResponseEnvelope({}, ['id'], ['id']), null);
  class Names extends Array<string> {}
  assert.equal(classifyReadonlyLiveResponseEnvelope({}, new Names('id'), []), null);
  for (const value of [null, undefined, [], '', 1, true, new Date(), new Map(), Object.create({ id: 'PRIVATE' })]) {
    assert.equal(classifyReadonlyLiveResponseEnvelope(value, required, optional), null);
  }
  assert.deepEqual(classifyReadonlyLiveResponseEnvelope(Object.create(null), required, optional), { ...empty(), missing: ['id', 'model', 'object', 'output', 'status'] });
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('PRIVATE'), () => 'PRIVATE']) {
    assert.equal(classifyReadonlyLiveResponseEnvelope({ unknown: value }, [], []), null);
  }
});

test('response envelope observation rejects accessors, symbols and hidden root fields without evaluating nested values', () => {
  let reads = 0; const get = () => { reads++; throw new Error('PRIVATE'); };
  assert.equal(classifyReadonlyLiveResponseEnvelope(Object.defineProperty({}, 'id', { enumerable: true, get }), required, []), null);
  const late = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`a${index}`, 0]));
  Object.defineProperty(late, 'z', { enumerable: true, get });
  assert.equal(classifyReadonlyLiveResponseEnvelope(late, [], []), null);
  for (const argument of ['required', 'optional']) {
    const names = [argument === 'required' ? 'id' : 'usage']; Object.defineProperty(names, '0', { get });
    assert.equal(classifyReadonlyLiveResponseEnvelope({}, argument === 'required' ? names : [], argument === 'optional' ? names : []), null);
  }
  for (const value of [{ [Symbol('PRIVATE')]: true }, Object.defineProperty({}, 'PRIVATE', { value: true })]) {
    assert.equal(classifyReadonlyLiveResponseEnvelope(value, [], []), null);
  }
  const nested = Object.defineProperty({}, 'PRIVATE', { enumerable: true, get });
  assert.deepEqual(classifyReadonlyLiveResponseEnvelope({ conversation: nested }, [], []), { ...empty(),
    unexpected: [{ field: 'conversation', valueType: 'object', count: 1 }], observedUnexpected: 1 });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(classifyReadonlyLiveResponseEnvelope(revoked.proxy, [], []), null);
  assert.equal(reads, 0);
});

test('response envelope copies preserve frozen inputs and independently clone every retained level', () => {
  const source = Object.freeze({ id: 'resp_PRIVATE', conversation: Object.freeze({ id: 'PRIVATE_CONVERSATION' }) });
  const names = Object.freeze([...required]);
  const original = classifyReadonlyLiveResponseEnvelope(source, names, Object.freeze([]))!;
  original.unexpected.forEach(Object.freeze); Object.freeze(original.unexpected); Object.freeze(original.missing); Object.freeze(original);
  const copied = copyReadonlyLiveResponseEnvelopeDiagnostic(original)!;
  assert.deepEqual(copied, original); assert.notEqual(copied, original); assert.notEqual(copied.missing, original.missing);
  assert.notEqual(copied.unexpected, original.unexpected); assert.notEqual(copied.unexpected[0], original.unexpected[0]);
  copied.missing.pop(); copied.unexpected[0]!.count = 99;
  assert.equal(original.missing.length, 4); assert.equal(original.unexpected[0]!.count, 1);
  assert.deepEqual(source, { id: 'resp_PRIVATE', conversation: { id: 'PRIVATE_CONVERSATION' } });
  assert.deepEqual(names, required); assert.doesNotMatch(JSON.stringify(original), /PRIVATE/);
});

test('response envelope copying rejects raw fields, invalid enums, duplicate tuples and inconsistent counts', () => {
  const entry = { field: 'other', valueType: 'string', count: 1 };
  const valid = { ...empty(), unexpected: [entry], observedUnexpected: 1 };
  for (const key of Object.keys(valid)) {
    const value = { ...valid } as Record<string, unknown>; delete value[key];
    assert.equal(copyReadonlyLiveResponseEnvelopeDiagnostic(value), null);
  }
  for (const key of ['field', 'valueType', 'count']) {
    const value = { ...entry } as Record<string, unknown>; delete value[key];
    assert.equal(copyReadonlyLiveResponseEnvelopeDiagnostic({ ...valid, unexpected: [value] }), null);
  }
  for (const value of [null, [], new Date(), { ...valid, raw: 'PRIVATE' }, { ...valid, [Symbol('PRIVATE')]: true },
    { ...valid, missing: ['PRIVATE'] }, { ...valid, missing: ['conversation'] }, { ...valid, missing: ['id', 'id'] },
    { ...valid, unexpected: [{ ...entry, field: 'PRIVATE' }] }, { ...valid, unexpected: [{ ...entry, valueType: 'PRIVATE' }] },
    { ...valid, unexpected: [{ ...entry, raw: 'PRIVATE' }] }, { ...valid, observedUnexpected: 0 },
    { ...valid, unexpected: [entry, entry], observedUnexpected: 2 }, { ...valid, overflow: true }, { ...valid, overflow: 1 },
    { ...valid, unexpected: [{ ...entry, field: 'conversation', count: 2 }], observedUnexpected: 2 },
    { ...valid, unexpected: [{ ...entry, field: 'conversation' }, { ...entry, field: 'conversation', valueType: 'null' }], observedUnexpected: 2 },
    { ...valid, missing: ['id'], unexpected: [{ ...entry, field: 'id' }] },
    { ...valid, unexpected: Array.from({ length: 33 }, () => entry), observedUnexpected: 33 },
    { ...valid, unexpected: [{ ...entry, count: 94 }], observedUnexpected: 94, overflow: true },
  ]) assert.equal(copyReadonlyLiveResponseEnvelopeDiagnostic(value), null);
  for (const count of [-1, 0, 0.5, 129, NaN, Infinity, '1', null, undefined]) {
    assert.equal(copyReadonlyLiveResponseEnvelopeDiagnostic({ ...valid, unexpected: [{ ...entry, count }], observedUnexpected: count }), null);
  }
});

test('response envelope copying rejects getters, sparse arrays and custom prototypes without accessing raw data', () => {
  let reads = 0; const get = () => { reads++; throw new Error('PRIVATE'); };
  for (const key of Object.keys(empty())) {
    const value = { ...empty() }; Object.defineProperty(value, key, { get });
    assert.equal(copyReadonlyLiveResponseEnvelopeDiagnostic(value), null);
  }
  for (const key of ['field', 'valueType', 'count']) {
    const entry = { field: 'other', valueType: 'string', count: 1 }; Object.defineProperty(entry, key, { get });
    assert.equal(copyReadonlyLiveResponseEnvelopeDiagnostic({ ...empty(), unexpected: [entry], observedUnexpected: 1 }), null);
  }
  class Entries extends Array<unknown> {}
  for (const key of ['missing', 'unexpected']) {
    const accessor = ['id']; Object.defineProperty(accessor, '0', { get });
    const hidden: unknown[] = []; Object.defineProperty(hidden, 'PRIVATE', { value: true });
    for (const value of [new Array(1), accessor, hidden, Object.assign([], { [Symbol('PRIVATE')]: true }), new Entries()]) {
      assert.equal(copyReadonlyLiveResponseEnvelopeDiagnostic({ ...empty(), [key]: value }), null);
    }
  }
  assert.equal(copyReadonlyLiveResponseEnvelopeDiagnostic(Object.assign(Object.create({ raw: 'PRIVATE' }), empty())), null);
  assert.equal(reads, 0);
});
