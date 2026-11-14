import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { collectReadonlyPayload, prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { selectReadonlyLiveResponseHeaders, startReadonlyLiveBroker, type ReadonlyLiveBroker, type ReadonlyLiveTransport } from '../src/adapters/readonly-live-broker.js';
import type { ReadonlyLiveConfig, ReadonlyLiveDispatch } from '../src/domain/readonly-live.js';
import { createReadonlyLivePayload } from '../src/policy/readonly-live-policy.js';
import { defaultReadonlySelection, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { buildReadonlyLiveRequestEnvelope, hashReadonlyLiveEnvelope } from '../src/policy/readonly-live-policy.js';
import { classifyReadonlyLiveHeaders } from '../src/policy/readonly-live-http-diagnostics.js';
import { HarnessError } from '../src/domain/errors.js';
import { decodeReadonlyLiveResponse, getReadonlyLiveMetadataDiagnostic } from '../src/policy/readonly-live-protocol.js';

const config: ReadonlyLiveConfig = { enabled: true, policyVersion: 'readonly-live-codex-v1', codexPath: '/private/tmp/synthetic-codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const credential = { kind: 'chatgpt' as const, accessToken: 'synthetic.test.only', accountId: 'synthetic-account' };
let directory: string; let dispatch: ReadonlyLiveDispatch;
const response = (text = 'synthetic output'): Response => new Response(JSON.stringify({ id: 'resp_synthetic', object: 'response',
  status: 'completed', model: config.model, error: null, incomplete_details: null,
  output: [{ id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] }] }), { headers: { 'Content-Type': 'application/json' } });
before(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-live-broker-'))); chmodSync(directory, 0o700);
  const source = await collectReadonlyPayload(await prepareReadonlyRepository(directory, randomUUID()), defaultReadonlySelection(),
    { ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
  const payload = createReadonlyLivePayload(source, 'codex-chatgpt-sse-v1', config);
  dispatch = { requestEnvelope: payload.requestEnvelope, requestBodyHash: payload.requestBodyHash, requestEnvelopeHash: payload.requestEnvelopeHash };
});
after(() => {
  const unlock = (path: string): void => { if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); } };
  if (directory) { unlock(directory); rmSync(directory, { recursive: true, force: true }); }
});
const send = (broker: ReadonlyLiveBroker, options: { path?: string; capability?: string; body?: string } = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${broker.port}${options.path ?? '/v1/responses'}`, { method: 'POST',
    headers: { Authorization: `Bearer ${options.capability ?? broker.capability}` },
    body: options.body ?? JSON.stringify({ model: config.model, stream: true, input: 'UNAPPROVED CHILD TEXT', tools: [{ type: 'shell' }] }) });

test('live broker loads no credential for invalid child requests and sends exactly the approved bytes once', async () => {
  let loads = 0; let calls = 0; let guards = 0;
  const transport: ReadonlyLiveTransport = async (request, auth) => {
    calls += 1; assert.deepEqual(auth, credential); assert.equal(request.requestEnvelope.body, dispatch.requestEnvelope.body);
    assert.equal(hashReadonlyValue(request.requestEnvelope.body), dispatch.requestBodyHash);
    assert.equal(Object.isFrozen(request.requestEnvelope), true); return response();
  };
  const broker = await startReadonlyLiveBroker(config, dispatch, async () => { loads += 1; return credential; }, new AbortController().signal, transport, () => { guards += 1; });
  try {
    for (const options of [{ capability: 'wrong' }, { path: '/v1/responses/other' }, { body: '{}' }]) assert.ok((await send(broker, options)).status >= 400);
    assert.equal(loads, 0); assert.equal(calls, 0);
    const result = await send(broker); assert.equal(result.status, 200);
    const text = await result.text(); assert.match(text, /response.completed/); assert.match(text, /synthetic output/);
    assert.ok(!text.includes(credential.accessToken)); assert.ok(!text.includes('usage'));
    assert.equal(loads, 1); assert.equal(calls, 1); assert.equal(guards, 1);
    assert.equal((await send(broker)).status, 403); assert.equal(loads, 1); assert.equal(broker.calls(), 1);
    assert.equal(broker.result()?.text, 'synthetic output');
  } finally { await broker.close(); }
});

test('live broker rejects tampered approval and absent transport before opening a listener', async () => {
  await assert.rejects(startReadonlyLiveBroker(config, { ...dispatch, requestBodyHash: 'f'.repeat(64) }, async () => credential,
    new AbortController().signal, async () => response(), () => {}));
  await assert.rejects(startReadonlyLiveBroker(config, dispatch, async () => credential, new AbortController().signal,
    undefined as unknown as ReadonlyLiveTransport, () => {}), /READONLY_LIVE_INVALID_TRANSPORT/);
});

test('live broker serializes parallel requests and bounds incoming bytes before authentication', async () => {
  for (const oversized of [false, true]) {
    let loads = 0; let calls = 0;
    const broker = await startReadonlyLiveBroker(config, dispatch, async () => { loads += 1; return credential; }, new AbortController().signal,
      async () => { calls += 1; return response(); }, () => {});
    try {
      const replies = await Promise.all([send(broker, oversized ? { body: 'x'.repeat(256 * 1024 + 1) } : {}),
        send(broker, oversized ? { body: 'x'.repeat(256 * 1024 + 1) } : {})]);
      await Promise.all(replies.map((reply) => reply.text()));
      assert.equal(calls, oversized ? 0 : 1); assert.equal(loads, oversized ? 0 : 1);
      assert.ok(replies.some((reply) => reply.status === (oversized ? 413 : 200)));
    } finally { await broker.close(); }
  }
});

test('live broker rechecks cancellation after async credential loading, before upstream', async () => {
  let stopped = false; let calls = 0;
  const broker = await startReadonlyLiveBroker(config, dispatch, async () => { stopped = true; return credential; }, new AbortController().signal,
    async () => { calls += 1; return response(); }, () => { if (stopped) throw new Error('cancelled'); });
  try { const reply = await send(broker); assert.equal(reply.status, 502); await reply.text(); assert.equal(calls, 0); assert.equal(broker.calls(), 0); }
  finally { await broker.close(); }
});

test('live broker rejects redirect/auth/server failures without retry or raw-error logging', async () => {
  for (const status of [302, 401, 429, 500]) {
    let calls = 0;
    const broker = await startReadonlyLiveBroker(config, dispatch, async () => credential, new AbortController().signal,
      async () => { calls += 1; return new Response('PRIVATE ERROR CANARY', { status, headers: { 'Content-Type': 'text/plain' } }); }, () => {});
    try {
      const reply = await send(broker); assert.equal(reply.status, 502); assert.ok(!(await reply.text()).includes('PRIVATE'));
      assert.equal(calls, 1); assert.equal(broker.result(), null); assert.ok(!broker.failure()?.includes('PRIVATE'));
    } finally { await broker.close(); }
  }
});

test('live broker abort reaches pending transport and closure awaits its completion', async () => {
  const controller = new AbortController(); let stopped = false; let started = false;
  const broker = await startReadonlyLiveBroker(config, dispatch, async () => credential, controller.signal,
    async (_request, _auth, signal) => new Promise((_resolve, reject) => {
      started = true; signal.addEventListener('abort', () => { stopped = true; reject(new Error('PRIVATE')); }, { once: true });
    }), () => {});
  try {
    const pending = send(broker);
    while (!started) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(); const result = await pending; assert.equal(result.status, 502); await result.text();
    assert.equal(stopped, true); assert.equal(broker.result(), null); assert.equal(broker.calls(), 1);
  } finally { await broker.close(); }
});

test('versioned response-header allowance and value-free diagnostics preserve v1 approval boundaries', async () => {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (let index = 0; index < 40; index += 1) headers.set(`x-synthetic-${index}`, 'bounded');
  const replyBody = await response().text();
  for (const version of [1, 2] as const) {
    const selected: ReadonlyLiveConfig = { ...config, policyVersion: version === 1 ? 'readonly-live-codex-v1' : 'readonly-live-codex-v2' };
    const requestEnvelope = buildReadonlyLiveRequestEnvelope(dispatch.requestEnvelope.body,
      version === 1 ? 'codex-chatgpt-sse-v1' : 'codex-chatgpt-sse-v2', selected);
    const request = { requestEnvelope, requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: hashReadonlyLiveEnvelope(requestEnvelope) };
    let calls = 0;
    const broker = await startReadonlyLiveBroker(selected, request, async () => credential, new AbortController().signal,
      async (sent, _credential, _signal, observe) => {
        calls += 1; assert.equal(sent.requestEnvelope.body, dispatch.requestEnvelope.body);
        observe({ status: 200, headerCount: 41, headerBytes: 1234 });
        return new Response(replyBody, { headers });
      }, () => {});
    try {
      const result = await send(broker); assert.equal(result.status, version === 1 ? 502 : 200); await result.text();
      assert.equal(calls, 1); assert.deepEqual(broker.httpObservation(), { status: 200, headerCount: 41, headerBytes: 1234 });
      assert.equal(broker.failure(), version === 1 ? 'READONLY_LIVE_HEADER_LIMIT' : null);
      const copied = broker.httpObservation()!; copied.headerCount = 999;
      assert.equal(broker.httpObservation()!.headerCount, 41);
    } finally { await broker.close(); }
  }
});

test('HTTP diagnostics reject header values and retain no credential or raw header material', async () => {
  const broker = await startReadonlyLiveBroker(config, dispatch, async () => credential, new AbortController().signal,
    async (_request, _auth, _signal, observe) => {
      observe({ status: 401, headerCount: 1, headerBytes: 20, raw: 'PRIVATE CANARY' } as never); return response();
    }, () => {});
  try {
    const reply = await send(broker); assert.equal(reply.status, 502); assert.ok(!(await reply.text()).includes('PRIVATE'));
    assert.equal(broker.httpObservation(), null); assert.equal(broker.failure(), 'READONLY_LIVE_INVALID_RESPONSE');
  } finally { await broker.close(); }
});

test('v3 drops all response cookies while preserving duplicate rejection for every other header and legacy profiles', () => {
  const pairs = ['Content-Type', 'application/json', 'Set-Cookie', 'first=PRIVATE_COOKIE_CANARY', 'set-cookie', 'second=PRIVATE_COOKIE_CANARY'];
  const selected = selectReadonlyLiveResponseHeaders(pairs, 'codex-chatgpt-sse-v3');
  assert.deepEqual([...selected], [['content-type', 'application/json']]);
  for (const profile of ['codex-chatgpt-sse-v1', 'codex-chatgpt-sse-v2'] as const) {
    assert.throws(() => selectReadonlyLiveResponseHeaders(pairs, profile), /^HarnessError: READONLY_LIVE_INVALID_RESPONSE$/);
    assert.equal(selectReadonlyLiveResponseHeaders(pairs.slice(0, 4), profile).get('set-cookie'), 'first=PRIVATE_COOKIE_CANARY');
  }
  assert.throws(() => selectReadonlyLiveResponseHeaders(['Content-Type', 'application/json', 'content-type', 'text/event-stream'],
    'codex-chatgpt-sse-v3'), /READONLY_LIVE_INVALID_RESPONSE_DUPLICATE_HEADER/);
});

test('v3 discarded cookies still count against raw header limits and must have valid characters', () => {
  const pairs = ['Content-Type', 'application/json', ...Array.from({ length: 63 }, () => ['Set-Cookie', 'a=b']).flat()];
  assert.equal([...selectReadonlyLiveResponseHeaders(pairs, 'codex-chatgpt-sse-v3')].length, 1);
  assert.throws(() => selectReadonlyLiveResponseHeaders([...pairs, 'Set-Cookie', 'a=b'], 'codex-chatgpt-sse-v3'), /READONLY_LIVE_HEADER_LIMIT/);
  assert.throws(() => selectReadonlyLiveResponseHeaders(['Set-Cookie', 'a'.repeat(16 * 1024)], 'codex-chatgpt-sse-v3'), /READONLY_LIVE_HEADER_LIMIT/);
  assert.throws(() => selectReadonlyLiveResponseHeaders(['Set-Cookie', 'a=b\r\nx-hidden: unsafe'], 'codex-chatgpt-sse-v3'), /READONLY_LIVE_INVALID_RESPONSE_HTTP_HEADERS/);
});

test('v3 broker reports a static decoding stage without retaining unknown response fields', async () => {
  const selected: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v3' };
  const requestEnvelope = buildReadonlyLiveRequestEnvelope(dispatch.requestEnvelope.body, 'codex-chatgpt-sse-v3', selected);
  const request = { requestEnvelope, requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: hashReadonlyLiveEnvelope(requestEnvelope) };
  const raw = JSON.parse(await response().text()) as Record<string, unknown>; raw.unknown_provider_field = 'PRIVATE_RESPONSE_CANARY';
  const broker = await startReadonlyLiveBroker(selected, request, async () => credential, new AbortController().signal,
    async () => new Response(JSON.stringify(raw), { headers: { 'Content-Type': 'application/json' } }), () => {});
  try {
    const reply = await send(broker); assert.equal(reply.status, 502); assert.ok(!(await reply.text()).includes('PRIVATE_RESPONSE_CANARY'));
    assert.equal(broker.failure(), 'READONLY_LIVE_INVALID_RESPONSE_RESPONSE_FIELDS');
    assert.equal(broker.jsonDiagnostic(), null);
    assert.equal(broker.result(), null); assert.equal(broker.calls(), 1);
  } finally { await broker.close(); }
});

test('broker retains copied JSON failure categories for response and SSE without retaining raw content', async () => {
  const selected: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v5' };
  const requestEnvelope = buildReadonlyLiveRequestEnvelope(dispatch.requestEnvelope.body, 'codex-chatgpt-sse-v5', selected);
  const request = { requestEnvelope, requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: hashReadonlyLiveEnvelope(requestEnvelope) };
  for (const origin of ['response', 'sse'] as const) {
    const raw = '{"PRIVATE_RESPONSE_CANARY":1,"PRIVATE_RESPONSE_CANARY":2}';
    const body = origin === 'response' ? raw : `data: ${raw}\n\n`;
    const broker = await startReadonlyLiveBroker(selected, request, async () => credential, new AbortController().signal,
      async () => new Response(Buffer.from(body)), () => {});
    try {
      const reply = await send(broker); assert.equal(reply.status, 502); assert.doesNotMatch(await reply.text(), /PRIVATE/);
      assert.equal(broker.failure(), 'READONLY_LIVE_INVALID_RESPONSE_JSON');
      assert.deepEqual(broker.jsonDiagnostic(), { origin, reason: 'duplicate-key' });
      assert.equal(broker.sensitiveDiagnostic(), null);
      assert.equal(broker.sensitiveAttribution(), null);
      assert.equal(broker.sensitiveMatches(), null);
      assert.equal(broker.sseDiagnostic(), null);
      const diagnostic = broker.jsonDiagnostic()!; diagnostic.reason = 'syntax';
      assert.deepEqual(broker.jsonDiagnostic(), { origin, reason: 'duplicate-key' });
      assert.doesNotMatch(JSON.stringify(broker.jsonDiagnostic()), /PRIVATE/);
      assert.equal(broker.result(), null); assert.equal(broker.calls(), 1);
    } finally { await broker.close(); }
  }
});

test('broker ignores JSON diagnostic claims from a failed transport', async () => {
  const error = new HarnessError('READONLY_LIVE_INVALID_RESPONSE');
  Object.defineProperty(error, 'jsonDiagnostic', { value: { origin: 'response', reason: 'sensitive-content' } });
  Object.defineProperty(error, 'sensitiveDiagnostic', { value: { pattern: 'credential-assignment', area: 'output-text',
    usageField: 'not-applicable', usageShape: 'not-applicable' } });
  Object.defineProperty(error, 'attributionDiagnostic', { value: { event: 'direct-response', responseMarker: 'response',
    responseStatus: 'completed', reason: 'text-content', matchExtent: 'text', field: 'not-property', valueType: 'string',
    providerError: 'none', providerParameter: 'none', usageValidation: 'missing' } });
  Object.defineProperty(error, 'matchDiagnostics', { value: { entries: [], observedMatches: 0, overflow: false } });
  Object.defineProperty(error, 'sseDiagnostic', { value: { event: 'created', reason: 'sequence-start', sequence: 'one', position: 'first' } });
  const broker = await startReadonlyLiveBroker(config, dispatch, async () => credential, new AbortController().signal,
    async () => { throw error; }, () => {});
  try {
    const reply = await send(broker); assert.equal(reply.status, 502); await reply.text();
    assert.equal(broker.jsonDiagnostic(), null); assert.equal(broker.calls(), 1); assert.equal(broker.result(), null);
    assert.equal(broker.sensitiveDiagnostic(), null);
    assert.equal(broker.sensitiveAttribution(), null);
    assert.equal(broker.sensitiveMatches(), null);
    assert.equal(broker.sseDiagnostic(), null);
  } finally { await broker.close(); }
});

test('broker records only copied static sensitive areas from the rejected local decoder', async () => {
  const selected: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v5' };
  const requestEnvelope = buildReadonlyLiveRequestEnvelope(dispatch.requestEnvelope.body, 'codex-chatgpt-sse-v5', selected);
  const request = { requestEnvelope, requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: hashReadonlyLiveEnvelope(requestEnvelope) };
  const broker = await startReadonlyLiveBroker(selected, request, async () => credential, new AbortController().signal,
    async () => response('password=PRIVATE_RESPONSE_CANARY'), () => {});
  try {
    const reply = await send(broker); assert.equal(reply.status, 502); assert.doesNotMatch(await reply.text(), /PRIVATE/);
    assert.equal(broker.failure(), 'READONLY_LIVE_INVALID_RESPONSE_JSON');
    assert.deepEqual(broker.jsonDiagnostic(), { origin: 'response', reason: 'sensitive-content' });
    const expected = { pattern: 'credential-assignment', area: 'output-text', usageField: 'not-applicable', usageShape: 'not-applicable' };
    assert.deepEqual(broker.sensitiveDiagnostic(), expected);
    broker.sensitiveDiagnostic()!.area = 'other';
    assert.deepEqual(broker.sensitiveDiagnostic(), expected);
    assert.doesNotMatch(JSON.stringify(broker.sensitiveDiagnostic()), /PRIVATE|password/);
    const attribution = broker.sensitiveAttribution()!;
    assert.equal(attribution.event, 'direct-response'); assert.equal(attribution.responseMarker, 'response');
    assert.equal(attribution.responseStatus, 'completed'); assert.equal(attribution.valueType, 'string');
    assert.equal(attribution.providerError, 'none'); assert.equal(attribution.providerParameter, 'none');
    attribution.event = 'other'; assert.equal(broker.sensitiveAttribution()!.event, 'direct-response');
    assert.doesNotMatch(JSON.stringify(broker.sensitiveAttribution()), /PRIVATE|password/);
    const matches = broker.sensitiveMatches()!;
    assert.equal(matches.observedMatches, 1); assert.equal(matches.entries[0]!.count, 1); assert.equal(matches.overflow, false);
    matches.entries[0]!.count = 99;
    assert.equal(broker.sensitiveMatches()!.entries[0]!.count, 1);
    assert.doesNotMatch(JSON.stringify(broker.sensitiveMatches()), /PRIVATE|password/);
    assert.equal(broker.result(), null); assert.equal(broker.calls(), 1);
  } finally { await broker.close(); }
});

test('broker records copied SSE classes only from its decoder and ignores a transport-forged diagnostic', async () => {
  const selected: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v7' };
  const requestEnvelope = buildReadonlyLiveRequestEnvelope(dispatch.requestEnvelope.body, 'codex-chatgpt-sse-v7', selected);
  const request = { requestEnvelope, requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: hashReadonlyLiveEnvelope(requestEnvelope) };
  for (const local of [false, true]) {
    const expected = { event: 'created', reason: 'sequence-start', sequence: 'later', position: 'first' };
    const broker = await startReadonlyLiveBroker(selected, request, async () => credential, new AbortController().signal, async () => {
      if (!local) {
        const error = new HarnessError('READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT');
        Object.defineProperty(error, 'sseDiagnostic', { value: expected }); throw error;
      }
      return new Response(Buffer.from('event: response.created\ndata: {"type":"response.created","sequence_number":2,"response":{"id":"resp_PRIVATE_EVENT"}}\n\n'));
    }, () => {});
    try {
      const reply = await send(broker); assert.equal(reply.status, 502); await reply.text();
      assert.equal(broker.failure(), 'READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT');
      assert.deepEqual(broker.sseDiagnostic(), local ? expected : null);
      if (local) {
        broker.sseDiagnostic()!.reason = 'state'; assert.deepEqual(broker.sseDiagnostic(), expected);
        assert.doesNotMatch(JSON.stringify(broker.sseDiagnostic()), /PRIVATE_EVENT|resp_/);
      }
      assert.equal(broker.jsonDiagnostic(), null); assert.equal(broker.calls(), 1); assert.equal(broker.result(), null);
    } finally { await broker.close(); }
  }
});

test('broker records SSE envelope structure from its decoder with deep copies and ignores forged transport details', async () => {
  const selected: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v7' };
  const requestEnvelope = buildReadonlyLiveRequestEnvelope(dispatch.requestEnvelope.body, 'codex-chatgpt-sse-v7', selected);
  const request = { requestEnvelope, requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: hashReadonlyLiveEnvelope(requestEnvelope) };
  const expected = { missing: ['response'], unexpected: [{ field: 'obfuscation', valueType: 'string', count: 1 }], observedUnexpected: 1, overflow: false };
  for (const local of [false, true]) {
    const broker = await startReadonlyLiveBroker(selected, request, async () => credential, new AbortController().signal, async () => {
      if (!local) {
        const error = new HarnessError('READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT');
        Object.defineProperty(error, 'sseDiagnostic', { value: { event: 'created', reason: 'envelope', sequence: 'zero', position: 'first' } });
        Object.defineProperty(error, 'sseEnvelopeDiagnostic', { value: expected }); throw error;
      }
      return new Response(Buffer.from('data: {"type":"response.created","sequence_number":0,"obfuscation":"PRIVATE_PADDING_CANARY"}\n\n'));
    }, () => {});
    try {
      const reply = await send(broker); assert.equal(reply.status, 502); assert.doesNotMatch(await reply.text(), /PRIVATE/);
      assert.equal(broker.failure(), 'READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT');
      assert.deepEqual(broker.sseEnvelopeDiagnostic(), local ? expected : null);
      if (local) {
        broker.sseEnvelopeDiagnostic()!.missing.length = 0; broker.sseEnvelopeDiagnostic()!.unexpected[0]!.count = 99;
        assert.deepEqual(broker.sseEnvelopeDiagnostic(), expected);
        assert.doesNotMatch(JSON.stringify(broker.sseEnvelopeDiagnostic()), /PRIVATE/);
      }
      assert.equal(broker.jsonDiagnostic(), null); assert.equal(broker.calls(), 1); assert.equal(broker.result(), null);
    } finally { await broker.close(); }
  }
});

test('broker copies response-fields diagnostics from local decoding and ignores transport-forged response evidence', async () => {
  const selected: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v8' };
  const requestEnvelope = buildReadonlyLiveRequestEnvelope(dispatch.requestEnvelope.body, 'codex-chatgpt-sse-v8', selected);
  const request = { requestEnvelope, requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: hashReadonlyLiveEnvelope(requestEnvelope) };
  const expected = { event: 'created', reason: 'envelope', envelope: { missing: ['model'], unexpected: [
    { field: 'conversation', valueType: 'null', count: 1 }], observedUnexpected: 1, overflow: false } };
  for (const local of [false, true]) {
    const broker = await startReadonlyLiveBroker(selected, request, async () => credential, new AbortController().signal, async () => {
      if (!local) {
        const error = new HarnessError('READONLY_LIVE_INVALID_RESPONSE_RESPONSE_FIELDS');
        Object.defineProperty(error, 'responseDiagnostic', { value: expected }); throw error;
      }
      return new Response(Buffer.from('data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_PRIVATE_CANARY","object":"response","status":"in_progress","output":[],"conversation":null}}\n\n'));
    }, () => {});
    try {
      const reply = await send(broker); assert.equal(reply.status, 502); assert.doesNotMatch(await reply.text(), /PRIVATE/);
      assert.equal(broker.failure(), 'READONLY_LIVE_INVALID_RESPONSE_RESPONSE_FIELDS');
      assert.deepEqual(broker.responseDiagnostic(), local ? expected : null);
      if (local) {
        broker.responseDiagnostic()!.envelope!.missing.length = 0;
        broker.responseDiagnostic()!.envelope!.unexpected[0]!.count = 99;
        assert.deepEqual(broker.responseDiagnostic(), expected);
        assert.doesNotMatch(JSON.stringify(broker.responseDiagnostic()), /PRIVATE|resp_/);
      }
      assert.equal(broker.jsonDiagnostic(), null); assert.equal(broker.sseDiagnostic(), null);
      assert.equal(broker.calls(), 1); assert.equal(broker.result(), null);
    } finally { await broker.close(); }
  }
});

test('broker retains frozen metadata categories only from its decoder and never trusts transport-forged diagnostics', async () => {
  const selected: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v9' };
  const requestEnvelope = buildReadonlyLiveRequestEnvelope(dispatch.requestEnvelope.body, 'codex-chatgpt-sse-v9', selected);
  const request = { requestEnvelope, requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: hashReadonlyLiveEnvelope(requestEnvelope) };
  const expected = { event: 'created', field: 'text-format-type', reason: 'value' };
  const invalidResponse = { id: 'resp_PRIVATE_METADATA_CANARY', object: 'response', model: config.model, status: 'in_progress', output: [],
    text: { format: { type: 'PRIVATE_METADATA_TYPE_CANARY' } } };
  const raw = Buffer.from(`data: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: invalidResponse })}\n\n`);
  for (const origin of ['transport', 'stream', 'replayed-stream', 'decoder']) {
    const local = origin === 'decoder';
    let replayed: unknown;
    const broker = await startReadonlyLiveBroker(selected, request, async () => credential, new AbortController().signal, async () => {
      if (!local) {
        let error: unknown = new HarnessError('READONLY_LIVE_INVALID_RESPONSE_RESPONSE_METADATA');
        if (origin === 'replayed-stream') {
          try { await decodeReadonlyLiveResponse(new Response(raw), new AbortController().signal, { profileId: 'codex-chatgpt-sse-v9' }); }
          catch (failure) { error = failure; replayed = failure; }
          assert.deepEqual(getReadonlyLiveMetadataDiagnostic(error), expected);
        } else Object.defineProperty(error, 'metadataDiagnostic', { value: expected });
        if (origin === 'transport') throw error;
        return { status: 200, headers: [['content-type', 'application/json']], body: {
          [Symbol.asyncIterator]: () => ({ next: async () => { throw error; }, return: async () => ({ done: true }) }),
        } } as unknown as Response;
      }
      return new Response(raw);
    }, () => {});
    try {
      const reply = await send(broker); assert.equal(reply.status, 502); assert.doesNotMatch(await reply.text(), /PRIVATE/);
      assert.equal(broker.failure(), 'READONLY_LIVE_INVALID_RESPONSE_RESPONSE_METADATA');
      assert.deepEqual(broker.metadataDiagnostic(), local ? expected : null);
      if (local) {
        const diagnostic = broker.metadataDiagnostic()!;
        assert.equal(Object.isFrozen(diagnostic), true);
        assert.notEqual(diagnostic, broker.metadataDiagnostic());
        assert.equal(Reflect.set(diagnostic, 'reason', 'shape'), false);
        assert.deepEqual(broker.metadataDiagnostic(), expected);
        assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE|resp_|metadataDiagnostic/);
      }
      assert.equal(broker.responseDiagnostic(), null); assert.equal(broker.jsonDiagnostic(), null); assert.equal(broker.sseDiagnostic(), null);
      if (replayed) assert.deepEqual(getReadonlyLiveMetadataDiagnostic(replayed), expected);
      assert.equal(broker.calls(), 1); assert.equal(broker.result(), null);
      assert.equal((await send(broker)).status, 403); assert.equal(broker.calls(), 1);
    } finally { await broker.close(); }
  }
});

test('successful metadata validation leaves the broker metadata diagnostic empty', async () => {
  const selected: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v9' };
  const requestEnvelope = buildReadonlyLiveRequestEnvelope(dispatch.requestEnvelope.body, 'codex-chatgpt-sse-v9', selected);
  const request = { requestEnvelope, requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: hashReadonlyLiveEnvelope(requestEnvelope) };
  const broker = await startReadonlyLiveBroker(selected, request, async () => credential, new AbortController().signal, async () => response(), () => {});
  try {
    const reply = await send(broker); assert.equal(reply.status, 200); await reply.text();
    assert.equal(broker.metadataDiagnostic(), null); assert.equal(broker.failure(), null); assert.equal(broker.calls(), 1);
  } finally { await broker.close(); }
});

test('v4 raw header diagnostics distinguish shape, names, values and duplicates without echoing input', () => {
  const profile = 'codex-chatgpt-sse-v4';
  const cases: [string[], string][] = [
    [['missing-value'], 'PAIR_SHAPE'],
    [['private header name', 'safe'], 'NAME_TOKEN'],
    [['x-private', 'PRIVATE\r\nVALUE'], 'VALUE_CHARACTER'],
    [['x-private', '한글'], 'VALUE_CHARACTER'],
    [['x-private', 'first', 'X-Private', 'second'], 'DUPLICATE_HEADER'],
  ];
  for (const [pairs, suffix] of cases) {
    assert.throws(() => selectReadonlyLiveResponseHeaders(pairs, profile), {
      name: 'HarnessError', message: `READONLY_LIVE_INVALID_RESPONSE_RAW_${suffix}`,
    });
  }
  const headers = selectReadonlyLiveResponseHeaders(['x_synthetic', 'safe\tvalue', '1synthetic', 'safe',
    'Set-Cookie', 'PRIVATE_COOKIE', 'set-cookie', 'PRIVATE_COOKIE'], profile);
  assert.deepEqual([...headers], [['1synthetic', 'safe'], ['x_synthetic', 'safe\tvalue']]);
  assert.throws(() => selectReadonlyLiveResponseHeaders(['x_synthetic', 'safe\tvalue'], 'codex-chatgpt-sse-v3'),
    { message: 'READONLY_LIVE_INVALID_RESPONSE_HTTP_HEADERS' });
});

test('v4 broker preserves a precise header refusal while keeping one call and no raw response', async () => {
  const selected: ReadonlyLiveConfig = { ...config, policyVersion: 'readonly-live-codex-v4' };
  const requestEnvelope = buildReadonlyLiveRequestEnvelope(dispatch.requestEnvelope.body, 'codex-chatgpt-sse-v4', selected);
  const request = { requestEnvelope, requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: hashReadonlyLiveEnvelope(requestEnvelope) };
  let calls = 0;
  const broker = await startReadonlyLiveBroker(selected, request, async () => credential, new AbortController().signal,
    async () => { calls += 1; return new Response(new Uint8Array([123, 125]), { headers: { 'x-private': 'PRIVATE_RESPONSE_CANARY' } }); }, () => {});
  try {
    const reply = await send(broker); assert.equal(reply.status, 502); assert.ok(!(await reply.text()).includes('PRIVATE_RESPONSE_CANARY'));
    assert.equal(broker.failure(), 'READONLY_LIVE_INVALID_RESPONSE_DECODE_CONTENT_TYPE_MISSING');
    assert.equal(broker.result(), null); assert.equal(calls, 1);
  } finally { await broker.close(); }
});

test('broker retains only copied header categories, including on a rejected response', async () => {
  const headerDiagnostics = classifyReadonlyLiveHeaders(['Content-Type', 'application/json', 'Content-Encoding', 'gzip',
    'Set-Cookie', 'PRIVATE_COOKIE_CANARY', 'x-private', 'PRIVATE_HEADER_CANARY']);
  const broker = await startReadonlyLiveBroker(config, dispatch, async () => credential, new AbortController().signal,
    async (_request, _auth, _signal, observe) => {
      observe({ status: 200, headerCount: 4, headerBytes: 123, headerDiagnostics });
      headerDiagnostics.contentEncoding = 'other';
      return new Response('PRIVATE_RESPONSE_CANARY', { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } });
    }, () => {});
  try {
    const reply = await send(broker); assert.equal(reply.status, 502); await reply.text();
    assert.equal(broker.result(), null); assert.equal(broker.calls(), 1);
    const observation = broker.httpObservation()!;
    assert.equal(observation.headerDiagnostics!.contentEncoding, 'gzip');
    observation.headerDiagnostics!.contentEncoding = 'other';
    assert.equal(broker.httpObservation()!.headerDiagnostics!.contentEncoding, 'gzip');
    assert.doesNotMatch(JSON.stringify(broker.httpObservation()), /PRIVATE|x-private|Set-Cookie/);
  } finally { await broker.close(); }
});

test('broker rejects raw or unregistered material inside diagnostic categories before persistence', async () => {
  for (const headerDiagnostics of [
    { ...classifyReadonlyLiveHeaders([]), mediaType: 'PRIVATE_MEDIA_CANARY' },
    { ...classifyReadonlyLiveHeaders([]), raw: 'PRIVATE_HEADER_CANARY' },
    undefined,
  ]) {
    const broker = await startReadonlyLiveBroker(config, dispatch, async () => credential, new AbortController().signal,
      async (_request, _auth, _signal, observe) => {
        observe({ status: 200, headerCount: 1, headerBytes: 20, headerDiagnostics } as never); return response();
      }, () => {});
    try {
      const reply = await send(broker); assert.equal(reply.status, 502); await reply.text();
      assert.equal(broker.httpObservation(), null); assert.equal(broker.result(), null);
      assert.equal(broker.failure(), 'READONLY_LIVE_INVALID_RESPONSE');
    } finally { await broker.close(); }
  }
});
