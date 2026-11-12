import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ReadonlyTransportBroker } from '../src/adapters/readonly-transport-broker.js';
import { collectReadonlyPayload, prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import type { ReadonlyTransportPayload } from '../src/domain/readonly-transport.js';
import type { ReadonlyTransportPort } from '../src/ports/readonly-transport.js';
import { defaultReadonlySelection, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { buildReadonlyTransportFakeResponse, createReadonlyTransportPayload } from '../src/policy/readonly-transport-policy.js';

let directory: string;
let payload: ReadonlyTransportPayload;
const signal = () => new AbortController().signal;
const request = () => ({ requestBody: payload.requestBody, requestBodyHash: payload.requestBodyHash });
before(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-transport-broker-'))); chmodSync(directory, 0o700);
  payload = createReadonlyTransportPayload(await collectReadonlyPayload(await prepareReadonlyRepository(directory, randomUUID()), defaultReadonlySelection()));
});
after(() => {
  const unlock = (path: string): void => {
    if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); }
  };
  if (directory) { unlock(directory); rmSync(directory, { recursive: true, force: true }); }
});

test('119 fake transport is mandatory, old/mock/live/missing ports never select a fallback', () => {
  for (const port of [undefined, null, {}, { mode: 'mock', transport: 'fake', transmit: async () => new Uint8Array() },
    { mode: 'offline', transport: 'real', transmit: async () => new Uint8Array() },
    { mode: 'live', transport: 'fake', transmit: async () => new Uint8Array() }, { mode: 'offline', transport: 'fake' }]) {
    assert.throws(() => new ReadonlyTransportBroker(port as ReadonlyTransportPort), { code: 'READONLY_TRANSPORT_FAKE_REQUIRED' });
  }
});

test('121/126 broker passes exactly the approved final bytes and rejects replaced fields before transmission', async () => {
  const received: string[] = [];
  const port: ReadonlyTransportPort = { mode: 'offline', transport: 'fake', transmit: async (body) => {
    received.push(body); return buildReadonlyTransportFakeResponse(body);
  } };
  const broker = new ReadonlyTransportBroker(port);
  await assert.rejects(broker.transmit({ ...request(), requestBodyHash: '0'.repeat(64) }, signal()));
  await assert.rejects(broker.transmit({ ...request(), url: 'https://invalid.example' } as never, signal()));
  const changed = JSON.stringify({ ...JSON.parse(payload.requestBody), model: 'external-model' });
  await assert.rejects(broker.transmit({ requestBody: changed, requestBodyHash: hashReadonlyValue(changed) }, signal()));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(broker.transmit(request(), controller.signal), { code: 'READONLY_TRANSPORT_CANCELLED' });
  assert.equal(received.length, 0);
  const raw = await broker.transmit(request(), signal());
  assert.ok(raw.byteLength > 0); assert.deepEqual(received, [payload.requestBody]);
  assert.equal(hashReadonlyValue(received[0]!), payload.requestBodyHash);
  await assert.rejects(broker.transmit(request(), signal()), { code: 'READONLY_TRANSPORT_ALREADY_DISPATCHED' });
  assert.equal(received.length, 1);
});

test('125 concurrent broker requests reserve once and failed delivery never restores authority or exposes raw errors', async () => {
  let calls = 0;
  let release: () => void = () => {};
  const port: ReadonlyTransportPort = { mode: 'offline', transport: 'fake', transmit: async () => {
    calls++; await new Promise<void>((resolve) => { release = resolve; });
    throw new Error('SYNTHETIC_PRIVATE_TRANSPORT_ERROR');
  } };
  const broker = new ReadonlyTransportBroker(port);
  const first = broker.transmit(request(), signal());
  await assert.rejects(broker.transmit(request(), signal()), { code: 'READONLY_TRANSPORT_ALREADY_DISPATCHED' });
  release();
  await assert.rejects(first, { code: 'READONLY_TRANSPORT_CALL_FAILED', message: 'READONLY_TRANSPORT_CALL_FAILED' });
  await assert.rejects(broker.transmit(request(), signal()), { code: 'READONLY_TRANSPORT_ALREADY_DISPATCHED' });
  assert.equal(calls, 1);
});

test('123/129 response overflow and abort after dispatch reject without retry', async () => {
  for (const abortAfter of [false, true]) {
    let calls = 0; const controller = new AbortController();
    const broker = new ReadonlyTransportBroker({ mode: 'offline', transport: 'fake', transmit: async () => {
      calls++; if (abortAfter) controller.abort(); return new Uint8Array(256 * 1024 + 1);
    } });
    await assert.rejects(broker.transmit(request(), controller.signal), {
      code: abortAfter ? 'READONLY_TRANSPORT_CANCELLED' : 'READONLY_TRANSPORT_RESPONSE_LIMIT',
    });
    await assert.rejects(broker.transmit(request(), signal()), { code: 'READONLY_TRANSPORT_ALREADY_DISPATCHED' });
    assert.equal(calls, 1);
  }
});
