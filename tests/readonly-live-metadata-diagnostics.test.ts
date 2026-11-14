import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyReadonlyLiveMetadataDiagnostic } from '../src/policy/readonly-live-metadata-diagnostics.js';

const events = ['direct-response', 'created', 'in-progress', 'completed'] as const;
const fields = ['tool-usage', 'access-programs', 'error', 'incomplete-details', 'tools', 'tool-choice', 'store', 'background',
  'created-at', 'completed-at', 'max-output-tokens', 'max-tool-calls', 'top-logprobs', 'temperature', 'top-p',
  'parallel-tool-calls', 'instructions', 'previous-response-id', 'prompt-cache-key', 'prompt-cache-retention',
  'safety-identifier', 'service-tier', 'truncation', 'user', 'reasoning', 'reasoning-context', 'reasoning-mode',
  'metadata', 'usage', 'usage-counts', 'usage-input-details', 'usage-output-details', 'text', 'text-verbosity', 'text-format',
  'text-format-description', 'text-format-type', 'text-format-strict', 'text-format-name'] as const;
const reasons = ['shape', 'value', 'integer', 'number', 'text', 'size'] as const;
const valid = () => ({ event: 'created', field: 'reasoning-mode', reason: 'value' });

test('metadata diagnostics retain only registered event, field and reason labels', () => {
  for (const event of events) for (const field of fields) for (const reason of reasons) {
    const value = { event, field, reason };
    const copy = copyReadonlyLiveMetadataDiagnostic(value);
    assert.deepEqual(copy, value); assert.notEqual(copy, value); assert.equal(Object.isFrozen(copy), true);
  }
});

test('metadata diagnostic copying rejects raw fields, missing labels, invalid enums and unexpected prototypes', () => {
  for (const key of Object.keys(valid())) {
    const value: Record<string, unknown> = valid(); delete value[key];
    assert.equal(copyReadonlyLiveMetadataDiagnostic(value), null);
  }
  for (const value of [null, undefined, true, 1, 'PRIVATE_METADATA_CANARY', [], new Date(), new Map(),
    { ...valid(), raw: 'PRIVATE_METADATA_CANARY' }, { ...valid(), [Symbol('PRIVATE_METADATA_CANARY')]: true },
    { ...valid(), event: 'PRIVATE_METADATA_EVENT' }, { ...valid(), field: 'PRIVATE_METADATA_FIELD' },
    { ...valid(), reason: 'PRIVATE_METADATA_REASON' }, { ...valid(), event: ['created'] },
    { ...valid(), field: { name: 'reasoning-mode' } }, { ...valid(), reason: null },
    Object.assign(Object.create({ raw: 'PRIVATE_METADATA_CANARY' }), valid())]) {
    assert.equal(copyReadonlyLiveMetadataDiagnostic(value), null);
  }
  const hidden = { ...valid() }; Object.defineProperty(hidden, 'PRIVATE_METADATA_CANARY', { value: true });
  assert.equal(copyReadonlyLiveMetadataDiagnostic(hidden), null);
});

test('metadata diagnostic copying never evaluates getters or inherited values and contains inspection failures', () => {
  let reads = 0; const get = () => { reads++; throw new Error('PRIVATE_METADATA_CANARY'); };
  for (const key of Object.keys(valid())) {
    const accessor = { ...valid() }; Object.defineProperty(accessor, key, { enumerable: true, get });
    assert.equal(copyReadonlyLiveMetadataDiagnostic(accessor), null);
    const hidden = { ...valid() }; Object.defineProperty(hidden, key, { value: valid()[key as keyof ReturnType<typeof valid>], enumerable: false });
    assert.equal(copyReadonlyLiveMetadataDiagnostic(hidden), null);
    const inherited = Object.create(Object.defineProperty({}, key, { get })) as Record<string, unknown>;
    for (const [name, value] of Object.entries(valid())) if (name !== key) inherited[name] = value;
    assert.equal(copyReadonlyLiveMetadataDiagnostic(inherited), null);
  }
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(copyReadonlyLiveMetadataDiagnostic(revoked.proxy), null); assert.equal(reads, 0);
});

test('metadata diagnostics detach mutable and null-prototype sources and freeze every returned copy', () => {
  const source = valid(); const copy = copyReadonlyLiveMetadataDiagnostic(source)!;
  source.field = 'tools'; assert.equal(copy.field, 'reasoning-mode');
  assert.equal(Reflect.set(copy, 'reason', 'shape'), false); assert.equal(copy.reason, 'value');
  assert.deepEqual(copyReadonlyLiveMetadataDiagnostic(Object.freeze(valid())), valid());
  const nullPrototype = Object.assign(Object.create(null), valid());
  const fromNull = copyReadonlyLiveMetadataDiagnostic(nullPrototype)!;
  assert.deepEqual(fromNull, valid()); assert.equal(Object.isFrozen(fromNull), true);
  const repeated = copyReadonlyLiveMetadataDiagnostic(copy)!;
  assert.notEqual(repeated, copy); assert.deepEqual(repeated, copy); assert.equal(Object.isFrozen(repeated), true);
  assert.doesNotMatch(JSON.stringify([copy, fromNull, repeated]), /PRIVATE_METADATA_CANARY/);
});
