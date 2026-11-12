import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ReadonlyModelPreflightBroker } from '../src/adapters/readonly-model-preflight-broker.js';
import { collectReadonlyPayload, prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import type { ReadonlyModelPreflightDispatch, ReadonlyModelPreflightPayload } from '../src/domain/readonly-model-preflight.js';
import type { ReadonlyModelPreflightPort } from '../src/ports/readonly-model-preflight.js';
import { defaultReadonlySelection, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { createReadonlyModelPreflightPayload } from '../src/policy/readonly-model-preflight-policy.js';

let directory: string;
let payload: ReadonlyModelPreflightPayload;
const signal = () => new AbortController().signal;
const request = (): ReadonlyModelPreflightDispatch => structuredClone({ requestEnvelope: payload.requestEnvelope,
  requestEnvelopeHash: payload.requestEnvelopeHash, requestBodyHash: payload.requestBodyHash });
const response = () => ({ text: '{}', responseHash: hashReadonlyValue('synthetic raw response') });
before(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-model-preflight-broker-'))); chmodSync(directory, 0o700);
  payload = createReadonlyModelPreflightPayload(await collectReadonlyPayload(await prepareReadonlyRepository(directory, randomUUID()), defaultReadonlySelection()));
});
after(() => {
  const unlock = (path: string): void => {
    if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); }
  };
  if (directory) { unlock(directory); rmSync(directory, { recursive: true, force: true }); }
});

test('135 fake exchange is mandatory and old/mock/live/missing ports have no fallback', () => {
  for (const port of [undefined, null, {}, { mode: 'mock', transport: 'in-memory-fake', transmit: async () => response() },
    { mode: 'offline', transport: 'fake', transmit: async () => response() },
    { mode: 'live', transport: 'in-memory-fake', transmit: async () => response() }, { mode: 'offline', transport: 'in-memory-fake' }]) {
    assert.throws(() => new ReadonlyModelPreflightBroker(port as ReadonlyModelPreflightPort), { code: 'READONLY_MODEL_PREFLIGHT_FAKE_REQUIRED' });
  }
  const port: ReadonlyModelPreflightPort = { mode: 'offline', transport: 'in-memory-fake', transmit: async () => response() };
  for (const limits of [{ workTimeoutMs: 55_001, cleanupTimeoutMs: 5_000 }, { workTimeoutMs: 0, cleanupTimeoutMs: 1 },
    { workTimeoutMs: 1, cleanupTimeoutMs: 5_001 }]) assert.throws(() => new ReadonlyModelPreflightBroker(port, limits));
});

test('139/141 broker forwards the approved envelope exactly once and rejects tampering before delivery', async () => {
  const received: ReadonlyModelPreflightDispatch[] = [];
  const broker = new ReadonlyModelPreflightBroker({ mode: 'offline', transport: 'in-memory-fake', transmit: async (value) => {
    received.push(value); return response();
  } });
  await assert.rejects(broker.transmit({ ...request(), requestBodyHash: '0'.repeat(64) }, signal()));
  await assert.rejects(broker.transmit({ ...request(), requestEnvelopeHash: '0'.repeat(64) }, signal()));
  await assert.rejects(broker.transmit({ ...request(), url: 'https://invalid.example' } as never, signal()));
  const changed = request(); changed.requestEnvelope.headers.push(['Authorization', '']);
  await assert.rejects(broker.transmit(changed, signal()));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(broker.transmit(request(), aborted.signal), { code: 'READONLY_MODEL_PREFLIGHT_CANCELLED' });
  assert.equal(received.length, 0);
  const approved = request(); const expected = structuredClone(approved);
  const result = broker.transmit(approved, signal());
  assert.equal(received.length, 1, 'dispatch starts synchronously inside the store transaction');
  approved.requestEnvelope.body = 'changed after validation';
  approved.requestEnvelope.headers[0]![1] = 'changed after validation';
  await result;
  assert.deepEqual(received, [expected]);
  assert.equal(Object.isFrozen(received[0]!.requestEnvelope.headers[0]), true);
  await assert.rejects(broker.transmit(request(), signal()), { code: 'READONLY_MODEL_PREFLIGHT_ALREADY_DISPATCHED' });
  assert.equal(received.length, 1);
});

test('141 concurrent calls consume once and raw failures never restore authority or leak details', async () => {
  let calls = 0; let release: () => void = () => {};
  const broker = new ReadonlyModelPreflightBroker({ mode: 'offline', transport: 'in-memory-fake', transmit: async () => {
    calls++; await new Promise<void>((resolve) => { release = resolve; }); throw new Error('SYNTHETIC_PRIVATE_ERROR');
  } });
  const first = broker.transmit(request(), signal());
  await assert.rejects(broker.transmit(request(), signal()), { code: 'READONLY_MODEL_PREFLIGHT_ALREADY_DISPATCHED' });
  release();
  await assert.rejects(first, { code: 'READONLY_MODEL_PREFLIGHT_CALL_FAILED', message: 'READONLY_MODEL_PREFLIGHT_CALL_FAILED' });
  await assert.rejects(broker.transmit(request(), signal()), { code: 'READONLY_MODEL_PREFLIGHT_ALREADY_DISPATCHED' });
  assert.equal(calls, 1);
});

test('145 broker rejects malformed/oversize decoded results without retry', async () => {
  for (const value of [null, { ...response(), extra: true }, { ...response(), responseHash: 'invalid' },
    { ...response(), text: '\ud800' }, { ...response(), text: 'x'.repeat(16 * 1024 + 1) }]) {
    let calls = 0;
    const broker = new ReadonlyModelPreflightBroker({ mode: 'offline', transport: 'in-memory-fake', transmit: async () => {
      calls++; return value as never;
    } });
    await assert.rejects(broker.transmit(request(), signal()));
    await assert.rejects(broker.transmit(request(), signal()), { code: 'READONLY_MODEL_PREFLIGHT_ALREADY_DISPATCHED' });
    assert.equal(calls, 1);
  }
});

test('146 cancellation waits for closure and refuses a late successful result', async () => {
  let closed = false; let calls = 0;
  const controller = new AbortController();
  const broker = new ReadonlyModelPreflightBroker({ mode: 'offline', transport: 'in-memory-fake', transmit: async (_request, abortSignal) => {
    calls++; await new Promise<void>((resolve) => abortSignal.addEventListener('abort', () => { closed = true; resolve(); }, { once: true }));
    return response();
  } }, { workTimeoutMs: 100, cleanupTimeoutMs: 50 });
  const pending = broker.transmit(request(), controller.signal);
  await Promise.resolve(); controller.abort();
  await assert.rejects(pending, { code: 'READONLY_MODEL_PREFLIGHT_CANCELLED' });
  assert.equal(closed, true); assert.equal(calls, 1);
});

test('146 abort-ignoring transport has a bounded cleanup deadline and remains consumed', async () => {
  let calls = 0;
  const broker = new ReadonlyModelPreflightBroker({ mode: 'offline', transport: 'in-memory-fake', transmit: async () => {
    calls++; return new Promise(() => {});
  } }, { workTimeoutMs: 10, cleanupTimeoutMs: 10 });
  const started = performance.now();
  await assert.rejects(broker.transmit(request(), signal()), { code: 'READONLY_MODEL_PREFLIGHT_LIFECYCLE_UNSAFE' });
  assert.ok(performance.now() - started < 1000);
  await assert.rejects(broker.transmit(request(), signal()), { code: 'READONLY_MODEL_PREFLIGHT_ALREADY_DISPATCHED' });
  assert.equal(calls, 1);
});
