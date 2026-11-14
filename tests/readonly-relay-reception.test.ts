import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { collectReadonlyRelayResponse, type ReadonlyRelayReceptionOptions } from '../src/policy/readonly-relay-protocol.js';
import type { ReadonlyRelayReceptionDiagnostic } from '../src/policy/readonly-relay-reception-diagnostics.js';

const credential = { accessToken: 'synthetic-reception-access-token', accountId: 'synthetic-reception-account-id' };
const hash = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const sse = (value: unknown) => Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
const memoryResponse = (chunks: Uint8Array[]): Response => {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (index < chunks.length) controller.enqueue(chunks[index++]!); else controller.close();
  } }));
};
const collect = (chunks: Uint8Array[], options?: ReadonlyRelayReceptionOptions) =>
  collectReadonlyRelayResponse(memoryResponse(chunks), new AbortController().signal, credential, options);

test('registered response budgets preserve default 256KiB and exact accepted wire bytes/hash under larger budgets', async () => {
  const raw = Buffer.concat(Array.from({ length: 10 }, () => sse({ text: 'x'.repeat(30000) })));
  await assert.rejects(collect([raw]), { code: 'READONLY_RELAY_RESPONSE_LIMIT' });
  for (const responseBytes of [1048576, 2097152, 4194304] as const) {
    let observed: ReadonlyRelayReceptionDiagnostic | undefined;
    const result = await collect([raw], { responseBytes, observeDiagnostic: (value) => { observed = value; } });
    assert.deepEqual(result.body, raw); assert.equal(result.responseHash, hash(raw));
    assert.equal(result.body.buffer.byteLength, responseBytes);
    assert.deepEqual(observed && { received: observed.receivedBytes, buffered: observed.bufferedBytes, inspected: observed.inspectedBytes,
      eof: observed.eof, termination: observed.termination, failedLimit: observed.failedLimit, frames: observed.completedFrames },
    { received: raw.length, buffered: raw.length, inspected: raw.length, eof: true, termination: 'eof', failedLimit: 'none', frames: 10 });
  }
});

test('wire counters observe CRLF, CR, LF and a split BOM without changing the semantic SSE validator', async () => {
  const frames = ['data: {"x":1}\r\n\r\n', ': synthetic\r\r', 'data: [DONE]\n\n'];
  const raw = Buffer.from('\uFEFF' + frames.join('')); let observed: ReadonlyRelayReceptionDiagnostic | undefined;
  const result = await collect([...raw].map((byte) => Uint8Array.of(byte)), { observeDiagnostic: (value) => { observed = value; } });
  assert.deepEqual(result.body, raw); assert.equal(result.responseHash, hash(raw));
  assert.equal(observed!.chunks, raw.length); assert.equal(observed!.maxChunkBytes, 1);
  assert.equal(observed!.completedFrames, 3); assert.equal(observed!.maxFrameBytes, Math.max(...frames.map((frame) => Buffer.byteLength(frame))));
  assert.equal(observed!.partialFrameBytes, 0); assert.equal(observed!.inspectedBytes, raw.length);
});

test('an overflow trigger chunk is counted completely but only its bounded prefix is inspected and none is buffered', async () => {
  const first = Buffer.alloc(100, 65); const trigger = Buffer.alloc(262164, 66);
  let observed: ReadonlyRelayReceptionDiagnostic | undefined;
  await assert.rejects(collect([first, trigger], { observeDiagnostic: (value) => { observed = value; } }), { code: 'READONLY_RELAY_RESPONSE_LIMIT' });
  assert.deepEqual(observed, { receivedBytes: first.length + trigger.length, bufferedBytes: first.length, inspectedBytes: 262144,
    chunks: 2, maxChunkBytes: trigger.length, completedFrames: 0, maxFrameBytes: 262144, partialFrameBytes: 262144,
    eof: false, termination: 'response-limit', failedLimit: 'response-bytes' });
  // The observed prefix already exceeds the frame cap, but response reception still rejects first, before EOF inspection.
  assert.ok(observed!.maxFrameBytes > 65536);
});

test('the first byte over a registered budget is not buffered and EOF is not fabricated', async () => {
  for (const responseBytes of [262144, 1048576, 2097152, 4194304] as const) {
    let observed: ReadonlyRelayReceptionDiagnostic | undefined;
    await assert.rejects(collect([Buffer.alloc(responseBytes, 65), Uint8Array.of(66)],
      { responseBytes, observeDiagnostic: (value) => { observed = value; } }), { code: 'READONLY_RELAY_RESPONSE_LIMIT' });
    assert.equal(observed!.receivedBytes, responseBytes + 1); assert.equal(observed!.bufferedBytes, responseBytes);
    assert.equal(observed!.inspectedBytes, responseBytes); assert.equal(observed!.partialFrameBytes, responseBytes);
    assert.equal(observed!.eof, false); assert.equal(observed!.failedLimit, 'response-bytes');
  }
});

test('diagnostic wire observation never promotes frame inspection ahead of invalid UTF8 or reflection checks', async () => {
  for (const [raw, code, termination, failedLimit] of [
    [Buffer.concat([Buffer.alloc(70000, 65), Buffer.from([255])]), 'INVALID_UTF8', 'invalid-utf8', 'none'],
    [Buffer.from(`data: {"x":"${credential.accessToken}${'x'.repeat(70000)}"}\n\n`), 'CREDENTIAL_REFLECTION', 'credential-reflection', 'none'],
    [sse({ x: 'x'.repeat(70000) }), 'FRAME_LIMIT', 'frame-limit', 'frame'],
  ] as const) {
    let observed: ReadonlyRelayReceptionDiagnostic | undefined;
    await assert.rejects(collect([raw], { observeDiagnostic: (value) => { observed = value; } }), { code: `READONLY_RELAY_${code}` });
    assert.equal(observed!.termination, termination); assert.equal(observed!.failedLimit, failedLimit); assert.equal(observed!.eof, true);
    assert.ok(observed!.maxFrameBytes > 65536);
  }
});

test('diagnostic observers receive one frozen copy and neither sync nor async failures replace acceptance/rejection', async () => {
  const raw = sse({ safe: true }); let calls = 0;
  const result = await collect([raw], { observeDiagnostic(value) {
    calls++; assert.equal(Object.isFrozen(value), true); assert.equal(Reflect.set(value, 'receivedBytes', 0), false);
    throw new Error('PRIVATE_OBSERVER_CANARY');
  } });
  assert.equal(calls, 1); assert.deepEqual(result.body, raw); assert.equal(result.responseHash, hash(raw));
  await assert.rejects(collect([sse({ x: 'x'.repeat(70000) })], { observeDiagnostic() { throw new Error('PRIVATE_OBSERVER_CANARY'); } }), { code: 'READONLY_RELAY_FRAME_LIMIT' });
  await collect([raw], { observeDiagnostic: async () => { throw new Error('PRIVATE_OBSERVER_CANARY'); } });
  await yieldImmediate();
});

test('replayed real local errors preserve their old public code but cannot attest a current limit failure', async () => {
  let prior: unknown;
  await assert.rejects(collect([Buffer.alloc(262145)]), (error: unknown) => { prior = error; return true; });
  Object.defineProperty(prior, 'receptionDiagnostic', { value: { receivedBytes: 999999, termination: 'response-limit' } });
  for (const origin of ['reader', 'header']) {
    const response = new Response(); let observed: ReadonlyRelayReceptionDiagnostic | undefined;
    Object.defineProperty(response, 'body', { value: { getReader: () => ({
      read: async () => { throw prior; }, cancel: async () => {}, releaseLock: () => {},
    }) } });
    if (origin === 'header') Object.defineProperty(response, 'status', { get: () => { throw prior; } });
    await assert.rejects(collectReadonlyRelayResponse(response, new AbortController().signal, credential,
      { observeDiagnostic: (value) => { observed = value; } }), { code: 'READONLY_RELAY_RESPONSE_LIMIT' });
    assert.equal(observed!.receivedBytes, 0); assert.equal(observed!.bufferedBytes, 0); assert.equal(observed!.inspectedBytes, 0);
    assert.equal(observed!.eof, false); assert.equal(observed!.termination, 'invalid-response'); assert.equal(observed!.failedLimit, 'none');
  }
});

test('options reject unsupported budgets, symbols, getters, inherited data and mutable overrides without side effects', async () => {
  let reads = 0;
  for (const options of [{ responseBytes: 512000 }, { responseBytes: undefined }, { responseBytes: '1048576' },
    { observeDiagnostic: 1 }, { transport: () => {} }, { [Symbol('PRIVATE_CANARY')]: true },
    Object.create({ responseBytes: 1048576 }), Object.defineProperty({}, 'responseBytes', { enumerable: true, get: () => { reads++; return 1048576; } })]) {
    await assert.rejects(collect([sse({})], options as ReadonlyRelayReceptionOptions), { code: 'READONLY_RELAY_INVALID_OPTIONS' });
  }
  assert.equal(reads, 0);
});

test('single-byte input retains one bounded zeroed storage buffer rather than a retained Buffer per chunk', async () => {
  const raw = sse({ text: 'x'.repeat(400) }); let observed: ReadonlyRelayReceptionDiagnostic | undefined;
  const result = await collect([...raw].flatMap((byte) => [new Uint8Array(), Uint8Array.of(byte)]),
    { responseBytes: 1048576, observeDiagnostic: (value) => { observed = value; } });
  assert.equal(result.body.buffer.byteLength, 1048576); assert.deepEqual(result.body, raw); assert.equal(result.responseHash, hash(raw));
  assert.equal(observed!.chunks, raw.length * 2); assert.equal(observed!.maxChunkBytes, 1);
  const remainder = new Uint8Array(result.body.buffer, result.body.byteOffset + result.body.byteLength);
  assert.equal(remainder.every((byte) => byte === 0), true);
});

test('immediate empty chunks yield to real abort timers instead of starving cancellation', { timeout: 3000 }, async () => {
  const controller = new AbortController(); let reads = 0; let cancelled = 0; let observed: ReadonlyRelayReceptionDiagnostic | undefined;
  const source = new ReadableStream<Uint8Array>({ pull(stream) {
    if (reads++ < 20000) stream.enqueue(new Uint8Array()); else stream.close();
  }, cancel() { cancelled++; } });
  const pending = collectReadonlyRelayResponse(new Response(source), controller.signal, credential,
    { responseBytes: 4194304, observeDiagnostic: (value) => { observed = value; } });
  const timer = setTimeout(() => controller.abort(), 0);
  try { await assert.rejects(pending, { code: 'READONLY_RELAY_CANCELLED' }); } finally { clearTimeout(timer); }
  assert.equal(cancelled, 1); assert.ok(observed!.chunks >= 128); assert.ok(observed!.chunks < 20000);
  assert.equal(observed!.receivedBytes, 0); assert.equal(observed!.bufferedBytes, 0); assert.equal(observed!.termination, 'cancelled');
});
