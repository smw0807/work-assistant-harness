import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyReadonlyRelayReceptionDiagnostic } from '../src/policy/readonly-relay-reception-diagnostics.js';

const valid = () => ({ receivedBytes: 32, bufferedBytes: 32, inspectedBytes: 32, chunks: 2, maxChunkBytes: 16,
  completedFrames: 2, maxFrameBytes: 16, partialFrameBytes: 0, eof: true, termination: 'eof', failedLimit: 'none' });

test('reception diagnostics contain exactly eleven detached immutable counter and enum properties', () => {
  const source = valid(); const first = copyReadonlyRelayReceptionDiagnostic(source)!;
  assert.deepEqual(first, source); assert.equal(Reflect.ownKeys(first).length, 11); assert.equal(Object.isFrozen(first), true);
  source.receivedBytes = 64; assert.equal(first.receivedBytes, 32); assert.equal(Reflect.set(first, 'receivedBytes', 64), false);
  const repeated = copyReadonlyRelayReceptionDiagnostic(first)!;
  assert.notEqual(repeated, first); assert.deepEqual(repeated, first); assert.equal(Object.isFrozen(repeated), true);
  assert.deepEqual(copyReadonlyRelayReceptionDiagnostic(Object.assign(Object.create(null), valid())), valid());
});

test('reception diagnostic copying rejects accessors, inherited/hidden data, symbols, raw extras and inspection failures', () => {
  let reads = 0;
  for (const key of Object.keys(valid())) {
    const missing: Record<string, unknown> = valid(); delete missing[key]; assert.equal(copyReadonlyRelayReceptionDiagnostic(missing), null);
    const accessor = Object.defineProperty(valid(), key, { enumerable: true, get: () => { reads++; throw new Error('PRIVATE_RECEPTION_CANARY'); } });
    assert.equal(copyReadonlyRelayReceptionDiagnostic(accessor), null);
    const hidden = Object.defineProperty(valid(), key, { enumerable: false }); assert.equal(copyReadonlyRelayReceptionDiagnostic(hidden), null);
  }
  for (const value of [null, [], true, { ...valid(), raw: 'PRIVATE_RECEPTION_CANARY' },
    { ...valid(), [Symbol('PRIVATE_RECEPTION_CANARY')]: true }, Object.assign(Object.create({ extra: true }), valid())]) {
    assert.equal(copyReadonlyRelayReceptionDiagnostic(value), null);
  }
  const revoked = Proxy.revocable({}, {}); revoked.revoke(); assert.equal(copyReadonlyRelayReceptionDiagnostic(revoked.proxy), null);
  assert.equal(reads, 0);
});

test('reception counters enforce safe integers, bounded observed prefixes and consistent counter relationships', () => {
  for (const key of ['receivedBytes', 'bufferedBytes', 'inspectedBytes', 'chunks', 'maxChunkBytes', 'completedFrames', 'maxFrameBytes', 'partialFrameBytes']) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '1', null]) {
      assert.equal(copyReadonlyRelayReceptionDiagnostic({ ...valid(), [key]: value }), null);
    }
  }
  for (const patch of [{ bufferedBytes: 33 }, { inspectedBytes: 33 }, { inspectedBytes: 4194305, receivedBytes: 4194305 },
    { maxChunkBytes: 33 }, { maxFrameBytes: 33 }, { partialFrameBytes: 17 }, { completedFrames: 33 },
    { chunks: 0 }, { maxChunkBytes: 0 }, { chunks: 1 }, { eof: false }, { eof: 'true' },
    { termination: 'PRIVATE_RECEPTION_CANARY' }, { failedLimit: 'PRIVATE_RECEPTION_CANARY' },
    { termination: 'response-limit', failedLimit: 'response-bytes', eof: false }]) {
    assert.equal(copyReadonlyRelayReceptionDiagnostic({ ...valid(), ...patch }), null);
  }
});

test('failed response limits retain the overflow bytes independently of buffered and observed prefixes', () => {
  const overflow = { receivedBytes: 262145, bufferedBytes: 0, inspectedBytes: 262144, chunks: 1, maxChunkBytes: 262145,
    completedFrames: 0, maxFrameBytes: 262144, partialFrameBytes: 262144, eof: false,
    termination: 'response-limit', failedLimit: 'response-bytes' };
  assert.deepEqual(copyReadonlyRelayReceptionDiagnostic(overflow), overflow);
  const uncertain = { ...overflow, termination: 'cleanup-uncertain' };
  assert.deepEqual(copyReadonlyRelayReceptionDiagnostic(uncertain), uncertain);
  assert.equal(copyReadonlyRelayReceptionDiagnostic({ ...overflow, eof: true }), null);
  assert.equal(copyReadonlyRelayReceptionDiagnostic({ ...overflow, failedLimit: 'frame' }), null);
});
