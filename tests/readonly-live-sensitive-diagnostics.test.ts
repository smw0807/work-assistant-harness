import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalReadonlyJson } from '../src/policy/readonly-investigation-policy.js';
import { classifyReadonlyLiveSensitiveContent, copyReadonlyLiveSensitiveDiagnostic,
  classifyReadonlyLiveSensitiveAttribution, copyReadonlyLiveSensitiveAttribution,
  classifyReadonlyLiveSensitiveMatches, copyReadonlyLiveSensitiveMatches,
  type ReadonlyLiveSensitiveDiagnostic, type ReadonlyLiveSensitiveAttribution } from '../src/policy/readonly-live-sensitive-diagnostics.js';
import { containsSensitiveText, getSensitivePatternDefinitions, redactSensitiveText } from '../src/policy/redaction.js';

const other: ReadonlyLiveSensitiveDiagnostic = { pattern: 'other', area: 'other', usageField: 'not-applicable', usageShape: 'not-applicable' };
const classify = (original: unknown, redacted: unknown = original, origin: 'response' | 'sse' = 'response') =>
  classifyReadonlyLiveSensitiveContent({ original, redacted, canonical: canonicalReadonlyJson(redacted), origin });
const pair = (details: unknown, view: unknown = details, key = 'input_tokens_details') => ({
  original: { object: 'response', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: details }, user: null },
  redacted: { object: 'response', usage: { count_input_units: 3, count_output_units: 2, count_total_units: 5, [key]: view }, user: null },
});
const known = (details: unknown) => pair({ cached_tokens: 1, cache_write_tokens: 2, cache_write_tokens_details: details },
  { count_cached_units: 1, count_cache_write_units: 2, cache_write_tokens_details: details });
const inspectPair = (value: ReturnType<typeof pair>) => classify(value.original, value.redacted);
const safe = (value: ReadonlyLiveSensitiveDiagnostic): void => {
  assert.deepEqual(Object.keys(value).sort(), ['area', 'pattern', 'usageField', 'usageShape']);
  assert.ok(copyReadonlyLiveSensitiveDiagnostic(value));
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_CANARY|sk-proj-|Bearer |password|offset|matched|raw/);
};
const attribute = (original: unknown, redacted: unknown = original, origin: 'response' | 'sse' = 'response') =>
  classifyReadonlyLiveSensitiveAttribution({ original, redacted, canonical: canonicalReadonlyJson(redacted), origin });
const eventPair = (value: ReturnType<typeof pair>, type = 'response.created') => ({
  original: { type, sequence_number: 0, response: value.original }, redacted: { type, sequence_number: 0, response: value.redacted },
});
const attributionKeys = ['event', 'responseMarker', 'responseStatus', 'reason', 'matchExtent', 'field', 'valueType', 'usageValidation', 'providerError', 'providerParameter'];
const safeAttribution = (value: ReadonlyLiveSensitiveAttribution): void => {
  assert.deepEqual(Object.keys(value).sort(), [...attributionKeys].sort());
  assert.deepEqual(copyReadonlyLiveSensitiveAttribution(value), value);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_CANARY|password|access_token|input_tokens|offset|matched|raw/);
};
const matched = (original: unknown, redacted: unknown = original, origin: 'response' | 'sse' = 'response') =>
  classifyReadonlyLiveSensitiveMatches({ original, redacted, canonical: canonicalReadonlyJson(redacted), origin });

test('classifier attributes the actual parent counter match and does not report unrelated known usage', () => {
  const value = known(null);
  assert.equal(containsSensitiveText(canonicalReadonlyJson(value.redacted)), true);
  assert.deepEqual(inspectPair(value), { pattern: 'credential-assignment', area: 'known-usage-counter', usageField: 'input-details', usageShape: 'count-object' });
  const counts = known({ ttl_12h_tokens: 1, ttl_30m_tokens: 2 });
  const result = inspectPair(counts); assert.equal(result.area, 'known-usage-counter'); assert.equal(result.pattern, 'credential-assignment'); safe(result);
  const ordinary = pair({ cached_tokens: 1, cache_write_tokens: 2 }, { count_cached_units: 1, count_cache_write_units: 2 }, 'count_input_units_details');
  assert.equal(containsSensitiveText(canonicalReadonlyJson(ordinary.redacted)), false); assert.deepEqual(inspectPair(ordinary), other);
  const original = { ...ordinary.original, metadata: { access_token: 'PRIVATE_CANARY' } };
  const redacted = { ...ordinary.redacted, metadata: { access_token: 'PRIVATE_CANARY' } };
  assert.equal(classify(original, redacted).area, 'metadata');
  assert.equal(classify({ ...value.original, metadata: original.metadata }, { ...value.redacted, metadata: redacted.metadata }).area, 'multiple');
  // The assignment pattern can consume closing delimiters beyond usage; do not claim a narrower area.
  const crossing = pair(null);
  const originalEnd = { object: crossing.original.object, usage: crossing.original.usage };
  const redactedEnd = { object: crossing.redacted.object, usage: crossing.redacted.usage };
  assert.equal(classify(originalEnd, redactedEnd).area, 'other');
});

test('only exact numeric/null counter shapes at the real response usage path can receive a known-counter label', () => {
  for (const details of [null, { cached_tokens: 0 }, { cache_write_tokens: 0 }, { cache_write_tokens_details: null },
    { cached_tokens: 0, cache_write_tokens_details: { ttl_12h_tokens: 0, ttl_30m_tokens: Number.MAX_SAFE_INTEGER } }]) {
    assert.equal(inspectPair(pair(details)).area, 'known-usage-counter');
  }
  for (const details of [{ cached_tokens: 'PRIVATE_CANARY' }, { cached_tokens: -1 }, { cached_tokens: 0.5 },
    { cached_tokens: Number.MAX_SAFE_INTEGER + 1 }, { cached_tokens: Infinity }, { cache_write_tokens_details: Infinity },
    { cached_tokens: 0, access_token: 1 }, { cache_write_tokens_details: {} }, { cache_write_tokens_details: [] },
    { cache_write_tokens_details: { ttl_12h_tokens: 1 } }, { cache_write_tokens_details: { ttl_12h_tokens: 1, ttl_30m_tokens: 2, extra: 0 } },
    { cache_write_tokens_details: { ttl_12h_tokens: '1', ttl_30m_tokens: 2 } }]) {
    assert.notEqual(inspectPair(pair(details)).area, 'known-usage-counter');
  }
  const value = known(null);
  assert.notEqual(classify(value.original, { ...value.redacted, usage: { ...value.redacted.usage, input_tokens_details: { access_token: 'PRIVATE_CANARY' } } }).area, 'known-usage-counter');
  for (const wrong of [
    { object: 'response', metadata: { usage: value.original.usage } }, { object: 'response', other: { usage: value.original.usage } },
    { type: 'unknown.event', response: value.original }, { type: 'response.completed', other: { response: value.original } },
  ]) assert.notEqual(classify(wrong, wrong, 'sse').area, 'known-usage-counter');
  const original = { type: 'response.completed', sequence_number: 0, response: value.original };
  const redacted = { type: 'response.completed', sequence_number: 0, response: value.redacted };
  assert.equal(classify(original, redacted, 'sse').area, 'known-usage-counter');
  assert.notEqual(classify(original, redacted, 'response').area, 'known-usage-counter');
});

test('fixed text areas identify real response and SSE fields without interpreting JSON-looking strings as metadata', () => {
  const text = 'Bearer syntheticPRIVATE_CANARY';
  const output = { object: 'response', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
  assert.equal(classify(output).area, 'output-text');
  assert.equal(classify({ object: 'response', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text }] }] }).area, 'reasoning-text');
  assert.equal(classify({ object: 'response', instructions: text }).area, 'instructions');
  assert.equal(classify({ object: 'response', text: { format: { type: 'json_schema', schema: { properties: { token: { type: 'string' } } } } } }).area, 'schema');
  assert.equal(classify({ object: 'response', metadata: { note: text } }).area, 'metadata');
  for (const [type, area] of [['response.output_text.delta', 'output-text'], ['response.reasoning_summary_text.delta', 'reasoning-text']] as const) {
    const event = { type, delta: text, sequence_number: 0 }; assert.equal(classify(event, event, 'sse').area, area);
  }
  const disguised = { type: 'response.output_text.delta', delta: '{"usage":{"input_tokens_details":{"access_token":"PRIVATE_CANARY"}}}', sequence_number: 0 };
  assert.notEqual(classify(disguised, disguised, 'sse').area, 'known-usage-counter');
  const wrong = { type: 'unknown', delta: text }; assert.equal(classify(wrong, wrong, 'sse').area, 'other');
});

test('patterns share the existing definitions and overlapping or different areas are reported conservatively', () => {
  const examples = [
    ['-----BEGIN PRIVATE KEY-----\nPRIVATE_CANARY\n-----END PRIVATE KEY-----', 'private-key-block'],
    ['sk-proj-syntheticPRIVATE_CANARY1234', 'provider-key-prefix'], ['Bearer syntheticPRIVATE_CANARY', 'bearer-token'],
    ['password=PRIVATE_CANARY', 'credential-assignment'],
  ] as const;
  for (const [text, expected] of examples) {
    const value = { object: 'response', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
    const result = classify(value); assert.equal(result.pattern, expected); assert.equal(result.area, 'output-text'); safe(result);
    assert.equal(containsSensitiveText(canonicalReadonlyJson(value)), true);
  }
  const overlap = { object: 'response', metadata: { access_token: 'sk-proj-syntheticPRIVATE_CANARY1234' } };
  assert.deepEqual(classify(overlap), { pattern: 'multiple', area: 'metadata', usageField: 'not-applicable', usageShape: 'not-applicable' });
  const both = { ...overlap, instructions: 'Bearer syntheticPRIVATE_CANARY' };
  assert.equal(classify(both).area, 'multiple'); assert.equal(classify(both).pattern, 'multiple');
  const before = redactSensitiveText('password=PRIVATE_CANARY');
  for (const definition of getSensitivePatternDefinitions()) definition.pattern.lastIndex = 100000;
  assert.equal(redactSensitiveText('password=PRIVATE_CANARY'), before); assert.equal(containsSensitiveText('password=PRIVATE_CANARY'), true);
});

test('canonical equality, UTF16 offsets, escaping and numeric-key ordering prevent projection misattribution', () => {
  const value = { object: 'response', metadata: { '10': 'safe', '2': 'safe', note: '가😀\\" Bearer syntheticPRIVATE_CANARY' } };
  const frozen = structuredClone(value); const result = classify(value); assert.equal(result.area, 'metadata'); safe(result);
  assert.deepEqual(value, frozen);
  assert.deepEqual(classifyReadonlyLiveSensitiveContent({ original: value, redacted: value, canonical: JSON.stringify(value), origin: 'response' }), other);
  const collision = pair({ cached_tokens: 1, count_cached_units: 'PRIVATE_CANARY' }, { count_cached_units: 'PRIVATE_CANARY' });
  assert.notEqual(inspectPair(collision).area, 'known-usage-counter');
  const knownValue = known(null);
  assert.deepEqual(classifyReadonlyLiveSensitiveContent({ original: knownValue.original, redacted: knownValue.redacted,
    canonical: canonicalReadonlyJson({ metadata: { access_token: 'PRIVATE_CANARY' } }), origin: 'response' }), other);
});

test('accessors, proxies, non-JSON objects and excessive matches return bounded static fallback without raw disclosure', () => {
  let accessed = 0;
  const accessor = Object.defineProperty({ object: 'response' }, 'usage', { enumerable: true, get: () => { accessed++; throw new Error('PRIVATE_CANARY'); } });
  const canonical = '{"object":"response","usage":null}';
  assert.deepEqual(classifyReadonlyLiveSensitiveContent({ original: accessor, redacted: {}, canonical, origin: 'response' }), other);
  const input = Object.defineProperty({ redacted: {}, canonical, origin: 'response' }, 'original', { get: () => { accessed++; return {}; } });
  assert.deepEqual(classifyReadonlyLiveSensitiveContent(input as never), other); assert.equal(accessed, 0);
  for (const value of [new Date(), new Map(), { value: 1n }, { [Symbol('private')]: 'PRIVATE_CANARY' },
    new Proxy({}, { ownKeys: () => { throw new Error('PRIVATE_CANARY'); } })]) {
    assert.deepEqual(classifyReadonlyLiveSensitiveContent({ original: value, redacted: {}, canonical: '{}', origin: 'response' }), other);
  }
  const excessive = { object: 'response', metadata: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, 'Bearer syntheticPRIVATE_CANARY'])) };
  assert.deepEqual(classify(excessive), other);
});

test('diagnostic copy enforces exact enum combinations, rejects accessors and never shares the input object', () => {
  const value: ReadonlyLiveSensitiveDiagnostic = { pattern: 'credential-assignment', area: 'known-usage-counter', usageField: 'input-details', usageShape: 'count-object' };
  const copied = copyReadonlyLiveSensitiveDiagnostic(value)!; value.area = 'other'; assert.equal(copied.area, 'known-usage-counter');
  let accessed = 0; const getter = Object.defineProperty({ ...copied }, 'pattern', { get: () => { accessed++; return 'credential-assignment'; } });
  for (const invalid of [null, [], 'PRIVATE_CANARY', { ...copied, extra: 'PRIVATE_CANARY' }, { ...copied, [Symbol('private')]: 'PRIVATE_CANARY' },
    { ...copied, pattern: 'PRIVATE_CANARY' }, { ...copied, area: 'PRIVATE_CANARY' }, { ...copied, usageField: 'PRIVATE_CANARY' }, { ...copied, usageShape: 'PRIVATE_CANARY' },
    { ...copied, pattern: 'multiple' }, { ...copied, pattern: 'other' }, { ...copied, usageField: 'not-applicable' },
    { ...copied, usageShape: 'other' }, { ...other, usageField: 'input-details' }, Object.create(copied), getter,
    new Proxy({}, { ownKeys: () => { throw new Error('PRIVATE_CANARY'); } }),
  ]) assert.equal(copyReadonlyLiveSensitiveDiagnostic(invalid), null);
  assert.equal(accessed, 0); safe(copied);
});

test('attribution separates the six previously identical other-area failures using the exact match start', () => {
  const value = known(null);
  const normal = eventPair(value);
  const baseline = classify(normal.original, normal.redacted, 'sse');
  const expected = attribute(normal.original, normal.redacted, 'sse');
  assert.deepEqual(expected, { event: 'created', responseMarker: 'response', responseStatus: 'missing', reason: 'attributed',
    matchExtent: 'property', field: 'input-details', valueType: 'object', usageValidation: 'valid-known', providerError: 'none', providerParameter: 'none' });
  assert.deepEqual(classify(normal.original, normal.redacted, 'sse'), baseline);
  for (const [type, event] of [['response.failed', 'failed'], ['error', 'error']]) {
    const frame = eventPair(value, type); const result = attribute(frame.original, frame.redacted, 'sse');
    assert.equal(classify(frame.original, frame.redacted, 'sse').area, 'other');
    assert.equal(result.event, event); assert.equal(result.reason, 'event-gate'); safeAttribution(result);
  }
  const missing = { original: { usage: value.original.usage, user: null }, redacted: { usage: value.redacted.usage, user: null } };
  const missingResult = attribute({ type: 'response.created', response: missing.original }, { type: 'response.created', response: missing.redacted }, 'sse');
  assert.equal(missingResult.responseMarker, 'missing'); assert.equal(missingResult.reason, 'response-marker-gate'); assert.equal(missingResult.usageValidation, 'valid-known');
  const invalid = { ...value.original, usage: { ...value.original.usage, total_tokens: -1 } };
  const invalidResult = attribute(invalid, value.redacted);
  assert.equal(invalidResult.reason, 'usage-shape'); assert.equal(invalidResult.usageValidation, 'invalid-shape');
  const crossing = pair(null);
  const crossingResult = attribute({ object: 'response', usage: crossing.original.usage }, { object: 'response', usage: crossing.redacted.usage });
  assert.equal(crossingResult.reason, 'parent-span'); assert.equal(crossingResult.matchExtent, 'parent');
  assert.equal(crossingResult.field, 'input-details'); assert.equal(crossingResult.valueType, 'null');
  const unknown = attribute({ object: 'response', access_token: 'PRIVATE_CANARY' });
  assert.equal(unknown.reason, 'unmapped-property'); assert.equal(unknown.field, 'credential-field'); assert.equal(unknown.valueType, 'string');
  for (const result of [expected, missingResult, invalidResult, crossingResult, unknown]) safeAttribution(result);
});

test('envelope observations and usage validation stay independent of marker gates in both origins', () => {
  const value = known(null);
  for (const origin of ['response', 'sse'] as const) {
    const inspect = (original: unknown, redacted: unknown) => origin === 'response' ? attribute(original, redacted)
      : attribute({ type: 'response.completed', response: original }, { type: 'response.completed', response: redacted }, origin);
    for (const marker of [null, 'PRIVATE_CANARY', undefined]) {
      const original = { ...value.original, object: marker, status: 'completed' };
      const redacted = { ...value.redacted, object: marker, status: 'completed' };
      if (marker === undefined) { delete (original as { object?: unknown }).object; delete (redacted as { object?: unknown }).object; }
      const result = inspect(original, redacted);
      assert.equal(result.responseMarker, marker === undefined ? 'missing' : marker === null ? 'null' : 'other');
      assert.equal(result.responseStatus, 'completed'); assert.equal(result.usageValidation, 'valid-known'); assert.equal(result.reason, 'response-marker-gate'); safeAttribution(result);
    }
    const projection = inspect(value.original, { ...value.redacted, usage: { ...value.redacted.usage, count_input_units: 999 } });
    assert.equal(projection.usageValidation, 'invalid-projection'); assert.equal(projection.reason, 'usage-projection');
    const invalid = inspect({ ...value.original, usage: { ...value.original.usage, extra: 1 } }, value.redacted);
    assert.equal(invalid.usageValidation, 'invalid-shape');
    const missing = inspect({ object: 'response', access_token: 'PRIVATE_CANARY', status: ['completed'] }, { object: 'response', access_token: 'PRIVATE_CANARY', status: ['completed'] });
    assert.equal(missing.usageValidation, 'missing'); assert.equal(missing.responseStatus, 'other'); safeAttribution(missing);
  }
  const rootError = attribute({ type: 'error', code: 'invalid_prompt', message: 'password=PRIVATE_CANARY', param: 'input' }, undefined, 'sse');
  assert.equal(rootError.event, 'error'); assert.equal(rootError.responseMarker, 'not-applicable'); assert.equal(rootError.usageValidation, 'not-applicable');
});

test('fixed lexical fields are observations, never trusted usage or assistant roles at fake paths', () => {
  for (const value of [
    { object: 'response', metadata: { input_tokens_details: null }, user: null },
    { object: 'response', output: [{ type: 'message', role: 'user', content: [{ type: 'output_text', text: 'password=PRIVATE_CANARY' }] }] },
    { type: 'unknown.event', response: { object: 'response', usage: known(null).original.usage } },
  ]) {
    const origin = Object.hasOwn(value, 'type') ? 'sse' : 'response';
    const result = attribute(value, value, origin);
    assert.notEqual(classify(value, value, origin).area, 'known-usage-counter'); safeAttribution(result);
  }
  const text = attribute({ object: 'response', metadata: { text: 'input_tokens_details: PRIVATE_CANARY' } });
  assert.equal(text.field, 'not-property'); assert.equal(text.valueType, 'string'); assert.equal(text.matchExtent, 'text');
  const arbitrary = attribute({ object: 'response', PRIVATE_CANARY_token: 'PRIVATE_CANARY' });
  assert.equal(arbitrary.field, 'other'); assert.equal(arbitrary.reason, 'unmapped-property'); safeAttribution(arbitrary);
  const wrongError = attribute({ type: 'unknown.event', response: { error: { code: 'server_error', param: 'input' } }, message: 'password=PRIVATE_CANARY' }, undefined, 'sse');
  assert.equal(wrongError.providerError, 'none'); assert.equal(wrongError.providerParameter, 'none');
});

test('multiple paths, nested overlapping assignments and actual parent extent cannot look like one field', () => {
  const sameEnum = attribute({ object: 'response', first: { token: 'PRIVATE_CANARY' }, second: { token: 'PRIVATE_CANARY' } });
  assert.equal(sameEnum.reason, 'multiple'); assert.equal(sameEnum.field, 'multiple'); assert.equal(sameEnum.valueType, 'multiple'); safeAttribution(sameEnum);
  const differentUnknown = attribute({ object: 'response', one_secret: 'PRIVATE_CANARY', two_secret: 'PRIVATE_CANARY' });
  assert.equal(differentUnknown.reason, 'multiple'); safeAttribution(differentUnknown);
  const overlapping = attribute({ object: 'response', access_token: 'sk-proj-abcdefghijklmnopqrst' });
  assert.equal(overlapping.reason, 'multiple'); safeAttribution(overlapping);
  const value = known(null); const result = attribute(value.original, value.redacted);
  assert.equal(result.field, 'input-details'); assert.equal(result.valueType, 'object'); assert.equal(result.matchExtent, 'property');
  const closing = pair(null); const ending = attribute({ object: 'response', usage: closing.original.usage }, { object: 'response', usage: closing.redacted.usage });
  assert.equal(ending.field, 'input-details'); assert.equal(ending.valueType, 'null'); assert.equal(ending.matchExtent, 'parent');
});

test('provider classifications use only fixed error-code and parameter paths and never infer from messages', () => {
  const cases = [['server_error', 'server-error'], ['rate_limit_exceeded', 'rate-limit'], ['invalid_prompt', 'invalid-request'],
    ['context_length_exceeded', 'context-limit'], ['model_not_found', 'model-unavailable'], ['unauthorized', 'authentication'], ['forbidden', 'permission']] as const;
  for (const [code, expected] of cases) {
    const direct = { object: 'response', error: { code, param: 'text.format.schema', message: 'password=PRIVATE_CANARY' } };
    for (const origin of ['response', 'sse'] as const) {
      const value = origin === 'response' ? direct : { type: 'response.failed', response: direct };
      const result = attribute(value, value, origin);
      assert.equal(result.providerError, expected); assert.equal(result.providerParameter, 'text-format'); safeAttribution(result);
    }
  }
  const root = attribute({ type: 'error', code: 'server_error', param: 'input', message: 'password=PRIVATE_CANARY' }, undefined, 'sse');
  assert.equal(root.providerError, 'server-error'); assert.equal(root.providerParameter, 'input');
  const unknown = attribute({ type: 'error', code: 'PRIVATE_CANARY', param: 'input.PRIVATE_CANARY', message: 'invalid_prompt password=PRIVATE_CANARY' }, undefined, 'sse');
  assert.equal(unknown.providerError, 'other'); assert.equal(unknown.providerParameter, 'other'); safeAttribution(unknown);
  const typed = attribute({ object: 'response', error: { type: 'invalid_request_error', message: 'password=PRIVATE_CANARY', param: 'model' } });
  assert.equal(typed.providerError, 'invalid-request'); assert.equal(typed.providerParameter, 'model');
  const hidden = attribute({ object: 'response', metadata: { error: { code: 'server_error', param: 'input' }, note: 'password=PRIVATE_CANARY' } });
  assert.equal(hidden.providerError, 'none'); assert.equal(hidden.providerParameter, 'none');
});

test('attribution copy and classifiers reject unknown values, accessors, noncanonical input and impossible combinations', () => {
  const value = attribute(known(null).original, known(null).redacted); const copied = copyReadonlyLiveSensitiveAttribution(value)!;
  assert.deepEqual(copied, value); assert.notEqual(copied, value);
  for (const invalid of [
    { ...value, raw: 'PRIVATE_CANARY' }, { ...value, [Symbol('PRIVATE_CANARY')]: true }, { ...value, field: 'PRIVATE_CANARY' },
    { ...value, reason: 'multiple' }, { ...value, field: 'not-property' }, { ...value, reason: 'parent-span' },
    { ...value, responseMarker: 'not-applicable' }, { ...value, reason: 'usage-shape' }, { ...value, providerParameter: 'input' },
    Object.defineProperty({ ...value }, 'event', { get() { throw new Error('PRIVATE_CANARY'); } }),
    new Proxy({}, { ownKeys() { throw new Error('PRIVATE_CANARY'); } }),
  ]) assert.equal(copyReadonlyLiveSensitiveAttribution(invalid), null);
  let reads = 0;
  const accessor = Object.defineProperty({}, 'token', { enumerable: true, get() { reads++; return 'PRIVATE_CANARY'; } });
  const input = { original: accessor, redacted: accessor, canonical: '{}', origin: 'response' as const };
  assert.equal(classifyReadonlyLiveSensitiveAttribution(input).reason, 'unresolved'); assert.equal(reads, 0);
  const pairValue = known(null); const canonical = canonicalReadonlyJson(pairValue.redacted);
  assert.equal(classifyReadonlyLiveSensitiveAttribution({ ...pairValue, canonical: canonical + ' ', origin: 'response' }).reason, 'unresolved');
  const huge = { object: 'response', metadata: Array.from({ length: 129 }, () => ({ token: 'PRIVATE_CANARY' })) };
  assert.equal(attribute(huge).reason, 'unresolved');
  const noMatch = attribute({ object: 'response', usage: null }); assert.equal(noMatch.reason, 'unresolved'); safeAttribution(noMatch);
});

test('match tuples retain field/type/extent correlation when nullable usage produces multiple attribution', () => {
  const original = { object: 'response', status: 'in_progress', usage: { input_tokens: null, output_tokens: null, total_tokens: null,
    input_tokens_details: null, output_tokens_details: null }, user: null };
  const redacted = { ...original, usage: { count_input_units: null, count_output_units: null, count_total_units: null,
    input_tokens_details: null, output_tokens_details: null } };
  for (const origin of ['response', 'sse'] as const) {
    const source = origin === 'response' ? original : { type: 'response.created', response: original };
    const view = origin === 'response' ? redacted : { type: 'response.created', response: redacted };
    const old = classify(source, view, origin); const attribution = attribute(source, view, origin);
    assert.equal(old.pattern, 'credential-assignment'); assert.equal(old.area, 'other');
    assert.equal(attribution.reason, 'multiple'); assert.equal(attribution.usageValidation, 'invalid-shape');
    const result = matched(source, view, origin)!;
    assert.deepEqual(result, { entries: [
      { pattern: 'credential-assignment', region: 'usage', reason: 'usage-shape', matchExtent: 'parent', field: 'output-details', valueType: 'null', count: 1 },
      { pattern: 'credential-assignment', region: 'usage', reason: 'usage-shape', matchExtent: 'property', field: 'input-details', valueType: 'null', count: 1 },
    ], observedMatches: 2, overflow: false });
    assert.deepEqual(classify(source, view, origin), old); assert.deepEqual(attribute(source, view, origin), attribution);
    assert.doesNotMatch(JSON.stringify(result), /input_tokens|output_tokens|offset|path|PRIVATE_CANARY/);
  }
});

test('tuple regions identify start locations without trusting fake response or assistant roles', () => {
  const fields = [
    [{ object: 'response', reasoning: { token: null }, user: null }, 'reasoning-settings'],
    [{ object: 'response', text: { format: { schema: { token: null } } }, user: null }, 'schema'],
    [{ object: 'response', metadata: { token: null }, user: null }, 'metadata'],
    [{ object: 'response', instructions: 'password=PRIVATE_CANARY' }, 'instructions'],
    [{ object: 'response', error: { message: 'password=PRIVATE_CANARY' } }, 'provider-error'],
    [{ object: 'response', access_token: 'PRIVATE_CANARY' }, 'response-metadata'],
    [{ object: 'response', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'password=PRIVATE_CANARY' }] }] }, 'output-text'],
    [{ object: 'response', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'password=PRIVATE_CANARY' }] }] }, 'reasoning-text'],
  ] as const;
  for (const [value, region] of fields) assert.equal(matched(value)!.entries[0]!.region, region);
  const fake = { object: 'response', output: [{ type: 'message', role: 'user', content: [{ type: 'output_text', text: 'password=PRIVATE_CANARY' }] }] };
  assert.equal(matched(fake)!.entries[0]!.region, 'response-metadata');
  const eventRoot = { type: 'response.created', token: 'PRIVATE_CANARY', response: { object: 'response' } };
  assert.equal(matched(eventRoot, eventRoot, 'sse')!.entries[0]!.region, 'event-root');
  const wrong = { type: 'unknown', response: { usage: { token: 'PRIVATE_CANARY' } } };
  assert.equal(matched(wrong, wrong, 'sse')!.entries[0]!.region, 'other');
  assert.equal(matched({ type: 'error', message: 'password=PRIVATE_CANARY' }, undefined, 'sse')!.entries[0]!.region, 'provider-error');
});

test('a forged usage path in a text event remains observable without becoming official usage', () => {
  const value = { type: 'response.output_text.delta', response: { usage: { password: 'PRIVATE_CANARY' } } };
  const previous = attribute(value, value, 'sse');
  assert.equal(previous.reason, 'unmapped-property'); assert.equal(previous.usageValidation, 'not-applicable');
  assert.deepEqual(matched(value, value, 'sse'), { entries: [{ pattern: 'credential-assignment', region: 'other', reason: 'unmapped-property',
    matchExtent: 'property', field: 'credential-field', valueType: 'string', count: 1 }], observedMatches: 1, overflow: false });
  assert.deepEqual(attribute(value, value, 'sse'), previous);
  assert.equal(classify(value, value, 'sse').area, 'other');
});

test('histograms count same tuples across paths, preserve overlapping patterns, and distinguish safe integer signs', () => {
  const duplicates = { object: 'response', metadata: [{ token: 'PRIVATE_CANARY' }, { token: 'PRIVATE_CANARY' }] };
  assert.equal(attribute(duplicates).reason, 'multiple');
  const result = matched(duplicates)!;
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0]!.count, 2); assert.equal(result.observedMatches, 2);
  const overlap = matched({ object: 'response', metadata: { access_token: 'sk-proj-abcdefghijklmnopqrst' } })!;
  assert.equal(overlap.observedMatches, 2); assert.equal(overlap.entries.length, 2);
  assert.deepEqual(overlap.entries.map((entry) => entry.pattern), ['credential-assignment', 'provider-key-prefix']);
  const signs = matched({ object: 'response', metadata: [{ token: 0 }, { token: -1 }, { token: 1.5 }, { token: Number.MAX_SAFE_INTEGER + 1 }] })!;
  assert.deepEqual(signs.entries.map((entry) => [entry.valueType, entry.count]), [['negative-integer', 1], ['nonnegative-integer', 1], ['number', 2]]);
  const ordered = { object: 'response', metadata: { z: { token: 0 }, a: { token: -1 } } };
  const reversed = { object: 'response', metadata: { z: { token: -1 }, a: { token: 0 } } };
  assert.deepEqual(matched(ordered), matched(reversed));
});

test('new match-only field names distinguish documented metadata without changing the older lexicon or protocol trust', () => {
  const cases = [
    ['cache_missed_tokens', 'cache-missed-tokens', 'prompt_cache_diagnostics', 'prompt-cache-diagnostics'],
    ['comparison_reusable_tokens', 'comparison-reusable-tokens', 'prompt_cache_diagnostics', 'prompt-cache-diagnostics'],
    ['image_tokens', 'image-tokens', 'tool_usage', 'tool-usage'], ['text_tokens', 'text-tokens', 'tool_usage', 'tool-usage'],
    ['cached_image_tokens', 'cached-image-tokens', 'tool_usage', 'tool-usage'], ['cached_text_tokens', 'cached-text-tokens', 'tool_usage', 'tool-usage'],
    ['cached_tokens_details', 'cached-details', 'tool_usage', 'tool-usage'],
  ] as const;
  for (const [key, field, container, region] of cases) {
    const value = { object: 'response', [container]: { [key]: null, zz: false } };
    const previous = attribute(value); assert.equal(previous.field, 'other');
    const result = matched(value)!;
    assert.equal(result.entries[0]!.field, field); assert.equal(result.entries[0]!.region, region); assert.equal(result.entries[0]!.valueType, 'null');
    assert.deepEqual(attribute(value), previous); assert.notEqual(classify(value).area, 'known-usage-counter');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
  }
});

test('match and tuple limits preserve bounded recorded counts and explicit overflow', () => {
  for (const size of [127, 128, 129]) {
    const value = { object: 'response', metadata: Array.from({ length: size }, () => ({ token: 'PRIVATE_CANARY' })) };
    const result = matched(value)!;
    assert.equal(result.observedMatches, Math.min(size, 128)); assert.equal(result.entries[0]!.count, Math.min(size, 128));
    assert.equal(result.overflow, size > 128);
  }
  const names = ['input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details', 'cached_tokens',
    'cache_write_tokens', 'cache_write_tokens_details', 'ttl_12h_tokens', 'reasoning_tokens', 'max_output_tokens', 'token'];
  const value = { object: 'response', metadata: names.flatMap((name) => [null, 0, -1].map((number) => ({ [name]: number, zz: false }))) };
  const result = matched(value)!;
  assert.equal(result.entries.length, 32); assert.equal(result.observedMatches, 32); assert.equal(result.overflow, true);
  assert.equal(result.entries.reduce((sum, entry) => sum + entry.count, 0), result.observedMatches);
  assert.deepEqual(copyReadonlyLiveSensitiveMatches(result), result);
});

test('match histogram copy deeply validates bounded shape and never evaluates accessors or leaks unknown values', () => {
  const valid = matched({ object: 'response', token: 'PRIVATE_CANARY' })!; const entry = valid.entries[0]!;
  const copied = copyReadonlyLiveSensitiveMatches(valid)!;
  assert.deepEqual(copied, valid); assert.notEqual(copied, valid); assert.notEqual(copied.entries, valid.entries); assert.notEqual(copied.entries[0], entry);
  let reads = 0; const getter = { get() { reads++; return 'PRIVATE_CANARY'; }, enumerable: true };
  const hole = Array(1); const arrayAccessor = Object.defineProperty([], '0', getter);
  const invalid = [
    { ...valid, raw: 'PRIVATE_CANARY' }, { ...valid, [Symbol('PRIVATE_CANARY')]: true },
    { ...valid, observedMatches: 0 }, { ...valid, observedMatches: 129 }, { ...valid, overflow: true },
    { ...valid, entries: [{ ...entry, raw: 'PRIVATE_CANARY' }] }, { ...valid, entries: [{ ...entry, region: 'PRIVATE_CANARY' }] },
    { ...valid, entries: [{ ...entry, count: -1 }] }, { ...valid, entries: [{ ...entry, count: 1.5 }] },
    { ...valid, entries: [{ ...entry, valueType: 'integer' }] }, { ...valid, entries: [{ ...entry, field: 'not-property' }] },
    { ...valid, entries: [{ ...entry, reason: 'multiple' }] }, { ...valid, entries: [{ ...entry, matchExtent: 'text' }] },
    { ...valid, entries: [entry, { ...entry }], observedMatches: 2 }, { ...valid, entries: hole }, { ...valid, entries: arrayAccessor },
    { ...valid, entries: [Object.defineProperty({ ...entry }, 'count', getter)] }, Object.defineProperty({ ...valid }, 'entries', getter),
    new Proxy({}, { ownKeys() { throw new Error('PRIVATE_CANARY'); } }),
  ];
  for (const value of invalid) assert.equal(copyReadonlyLiveSensitiveMatches(value), null);
  assert.equal(reads, 0); assert.doesNotMatch(JSON.stringify(copied), /PRIVATE_CANARY|offset|path|access_token/);
  assert.deepEqual(matched({ object: 'response' }), { entries: [], observedMatches: 0, overflow: false });
  assert.equal(classifyReadonlyLiveSensitiveMatches({ original: {}, redacted: {}, canonical: ' {}', origin: 'response' }), null);
  const object = Object.defineProperty({}, 'token', getter);
  assert.equal(classifyReadonlyLiveSensitiveMatches({ original: object, redacted: object, canonical: '{}', origin: 'response' }), null); assert.equal(reads, 0);
});
