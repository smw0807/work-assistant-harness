import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { sendReadonlyLiveRequest, type ReadonlyLiveHttpObservation } from '../src/adapters/readonly-live-broker.js';
import type { ReadonlyLiveConfig, ReadonlyLiveDispatch, ReadonlyLiveProfileId } from '../src/domain/readonly-live.js';
import { assertReadonlyLiveDispatch, buildReadonlyLiveInput, buildReadonlyLiveRequestBody, buildReadonlyLiveRequestEnvelope,
  hashReadonlyLiveEnvelope } from '../src/policy/readonly-live-policy.js';
import { decodeReadonlyLiveResponse } from '../src/policy/readonly-live-protocol.js';
import { canonicalReadonlyJson, getReadonlyRequest, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const credential = { kind: 'chatgpt' as const, accessToken: 'synthetic.test.only', accountId: 'synthetic-account' };
const output = '{"answer":"synthetic HTTP transport"}';
const message = { id: 'msg_http', type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: output, annotations: [] }] };
const completed = { id: 'resp_http', object: 'response', status: 'completed', model: 'gpt-6.1-sol', output: [message] };
const json = JSON.stringify(completed);
const sse = [
  { type: 'response.created', sequence_number: 0, response: { ...completed, status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', sequence_number: 1, output_index: 0,
    item: { ...message, status: 'in_progress', content: [] } },
  { type: 'response.output_text.delta', sequence_number: 2, output_index: 0, content_index: 0, item_id: message.id, delta: output },
  { type: 'response.output_text.done', sequence_number: 3, output_index: 0, content_index: 0, item_id: message.id, text: output },
  { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: message },
  { type: 'response.completed', sequence_number: 5, response: completed },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

const dispatchFor = (profileId: ReadonlyLiveProfileId): ReadonlyLiveDispatch => {
  const versions = { 'codex-chatgpt-sse-v1': 'readonly-live-codex-v1', 'codex-chatgpt-sse-v2': 'readonly-live-codex-v2',
    'codex-chatgpt-sse-v3': 'readonly-live-codex-v3', 'codex-chatgpt-sse-v4': 'readonly-live-codex-v4',
    'codex-chatgpt-sse-v5': 'readonly-live-codex-v5', 'codex-chatgpt-sse-v6': 'readonly-live-codex-v6',
    'codex-chatgpt-sse-v7': 'readonly-live-codex-v7', 'codex-chatgpt-sse-v8': 'readonly-live-codex-v8',
    'codex-chatgpt-sse-v9': 'readonly-live-codex-v9' } as const;
  const config: ReadonlyLiveConfig = { enabled: true, policyVersion: versions[profileId], codexPath: '/private/tmp/synthetic-codex',
    codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
  const excerpt = 'Synthetic approved input: 합성 자료 only.';
  const fields = { repoId: 'synthetic-flow-v1', baseCommit: 'a'.repeat(40), path: 'src/controller.ts', startLine: 1, endLine: 1,
    fileHash: hashReadonlyValue(excerpt), excerptHash: hashReadonlyValue(excerpt), excerpt };
  const evidence = { evidenceId: `evidence-${hashReadonlyValue(canonicalReadonlyJson(fields))}`, ...fields };
  const body = buildReadonlyLiveRequestBody(buildReadonlyLiveInput(getReadonlyRequest('flow-question'), [evidence]), profileId, config);
  const requestEnvelope = buildReadonlyLiveRequestEnvelope(body, profileId, config);
  const dispatch = { requestEnvelope, requestBodyHash: hashReadonlyValue(body), requestEnvelopeHash: hashReadonlyLiveEnvelope(requestEnvelope) };
  assertReadonlyLiveDispatch(dispatch, config);
  return dispatch;
};

class SyntheticIncoming extends Readable {
  readCalls = 0;
  constructor(readonly rawHeaders: string[], readonly statusCode = 200, private readonly bytes = Buffer.from(json)) { super(); }
  override _read(): void { this.readCalls++; this.push(this.bytes); this.push(null); }
}
interface CapturedRequest { url: string; options: RequestOptions; body: unknown }
interface HttpHarness { calls: CapturedRequest[]; observations: ReadonlyLiveHttpObservation[]; send(profileId?: ReadonlyLiveProfileId): Promise<Response> }

/** Stub only the native request boundary; execute the production callback, Web conversion and decoder. */
const withHttp = async (context: TestContext, incoming: SyntheticIncoming,
  check: (http: HttpHarness) => Promise<void>, requestError?: Error): Promise<void> => {
  const calls: CapturedRequest[] = []; const observations: ReadonlyLiveHttpObservation[] = [];
  const replacement = ((url: string, options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
    const request = new EventEmitter(); const captured: CapturedRequest = { url, options, body: undefined }; calls.push(captured);
    Object.assign(request, { end: (body: unknown) => {
      assert.equal(captured.body, undefined, 'one end call per native request'); captured.body = body;
      queueMicrotask(() => { if (requestError) request.emit('error', requestError); else callback(incoming as unknown as IncomingMessage); });
      return request;
    } });
    return request as ClientRequest;
  }) as typeof https.request;
  const mocked = context.mock.method(https, 'request', replacement);
  syncBuiltinESMExports();
  try {
    await check({ calls, observations, send: (profileId = 'codex-chatgpt-sse-v4') => sendReadonlyLiveRequest(dispatchFor(profileId),
      credential, new AbortController().signal, (value) => observations.push(value)) });
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); incoming.destroy(); }
};
const decode = (response: Response, profileId: ReadonlyLiveProfileId = 'codex-chatgpt-sse-v4') =>
  decodeReadonlyLiveResponse(response, new AbortController().signal, { profileId });
const headerBytes = (pairs: string[]): number => pairs.reduce((total, part) => total + Buffer.byteLength(part) + 2, 0);

test('native HTTP callback preserves exact approved bytes, fixed endpoint, parent credentials and streaming JSON/SSE', async (context) => {
  for (const [contentType, body] of [['application/json', json], ['text/event-stream; charset=utf-8', sse]]) {
    const pairs = ['Content-Type', contentType!, 'X-Synthetic', 'safe'];
    await withHttp(context, new SyntheticIncoming(pairs, 200, Buffer.from(body!)), async (http) => {
      const response = await http.send();
      assert.ok(response instanceof Response);
      assert.equal((await decode(response)).text, output);
      assert.equal(http.calls.length, 1);
      const sent = http.calls[0]!; const approved = dispatchFor('codex-chatgpt-sse-v4');
      assert.equal(sent.url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(sent.options.method, 'POST'); assert.equal(sent.options.agent, false); assert.equal(sent.options.maxHeaderSize, 16384);
      assert.ok(sent.options.signal instanceof AbortSignal);
      assert.equal(sent.body, approved.requestEnvelope.body);
      assert.equal(hashReadonlyValue(sent.body as string), approved.requestBodyHash);
      assert.deepEqual(sent.options.headers, { ...Object.fromEntries(approved.requestEnvelope.headers),
        Authorization: `Bearer ${credential.accessToken}`, 'ChatGPT-Account-ID': credential.accountId,
        'Content-Length': Buffer.byteLength(approved.requestEnvelope.body) });
      assert.doesNotMatch(JSON.stringify(approved), /synthetic\.test\.only|synthetic-account/);
      assert.equal(http.observations.length, 1);
      assert.equal(http.observations[0]!.status, 200); assert.equal(http.observations[0]!.headerCount, 2);
      assert.equal(http.observations[0]!.headerBytes, headerBytes(pairs));
    });
  }
});

test('native rawHeaders to Web Response accepts the recorded count/size independently of response field values', async (context) => {
  const pairs = ['Content-Type', 'application/json'];
  for (let index = 0; index < 34; index++) pairs.push(`X-Synthetic-${index}`, 'bounded');
  pairs[pairs.length - 1] += 'a'.repeat(3131 - headerBytes(pairs));
  for (const profileId of ['codex-chatgpt-sse-v3', 'codex-chatgpt-sse-v4'] as const) {
    await withHttp(context, new SyntheticIncoming(pairs), async (http) => {
      assert.equal((await decode(await http.send(profileId), profileId)).text, output);
      assert.equal(http.observations[0]!.status, 200); assert.equal(http.observations[0]!.headerCount, 35);
      assert.equal(http.observations[0]!.headerBytes, 3131); assert.equal(http.calls.length, 1);
    });
  }
});

test('native callback exposes the distinct v3 raw HTAB and decoder token-name failures that v4 accepts', async (context) => {
  for (const [name, value, rawFailure] of [['x_synthetic', 'bounded', false], ['x-synthetic', 'bounded\tvalue', true]] as const) {
    for (const profileId of ['codex-chatgpt-sse-v3', 'codex-chatgpt-sse-v4'] as const) {
      const incoming = new SyntheticIncoming(['Content-Type', 'application/json', name, value]);
      await withHttp(context, incoming, async (http) => {
        if (profileId === 'codex-chatgpt-sse-v4') assert.equal((await decode(await http.send(profileId), profileId)).text, output);
        else if (rawFailure) {
          await assert.rejects(http.send(profileId), { code: 'READONLY_LIVE_INVALID_RESPONSE_HTTP_HEADERS' });
          assert.equal(incoming.readCalls, 0); assert.equal(incoming.destroyed, true);
        } else {
          const native = await http.send(profileId);
          assert.equal(native.headers.get(name), value);
          await assert.rejects(decode(native, profileId), { code: 'READONLY_LIVE_INVALID_RESPONSE_HTTP_HEADERS' });
        }
        assert.equal(http.calls.length, 1);
      });
    }
  }
});

test('native Response wrapping preserves compressed bytes and the decoder rejects gzip without retry or decompression', async (context) => {
  const compressed = gzipSync(json); const pairs = ['Content-Type', 'application/json', 'Content-Encoding', 'gzip'];
  await withHttp(context, new SyntheticIncoming(pairs, 200, compressed), async (http) => {
    assert.deepEqual(Buffer.from(await (await http.send()).arrayBuffer()), compressed);
    assert.equal(http.calls.length, 1);
  });
  for (const profileId of ['codex-chatgpt-sse-v3', 'codex-chatgpt-sse-v4'] as const) {
    await withHttp(context, new SyntheticIncoming(pairs, 200, compressed), async (http) => {
      await assert.rejects(decode(await http.send(profileId), profileId), {
        code: profileId === 'codex-chatgpt-sse-v3' ? 'READONLY_LIVE_INVALID_RESPONSE_HTTP_HEADERS' : 'READONLY_LIVE_INVALID_RESPONSE_DECODE_CONTENT_ENCODING',
      });
      assert.equal(http.calls.length, 1);
    });
  }
});

test('memory fetch dispatcher decompresses gzip while the native sender Response retains the same compressed bytes', async (context) => {
  const compressed = gzipSync(json); let dispatches = 0;
  interface MemoryController { rawHeaders: string[]; abort(): void; pause(): void; resume(): void }
  interface MemoryHandler {
    onRequestStart(controller: MemoryController): void;
    onResponseStart(controller: MemoryController, status: number, headers: Record<string, string>, statusText: string): void;
    onResponseData(controller: MemoryController, data: Uint8Array): void;
    onResponseEnd(controller: MemoryController, trailers: Record<string, string>): void;
  }
  const dispatcher = { dispatch: (_options: unknown, handler: MemoryHandler): boolean => {
    dispatches++;
    queueMicrotask(() => {
      const controller: MemoryController = { rawHeaders: ['content-type', 'application/json', 'content-encoding', 'gzip'],
        abort: () => { throw new Error('UNEXPECTED_SYNTHETIC_ABORT'); }, pause: () => {}, resume: () => {} };
      handler.onRequestStart(controller);
      handler.onResponseStart(controller, 200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, 'OK');
      handler.onResponseData(controller, compressed); handler.onResponseEnd(controller, {});
    });
    return true;
  } };
  // This synthetic dispatcher supplies every response byte; it never opens a socket.
  // The transport distinction is reproducible, but says nothing about past unretained provider headers.
  const options: RequestInit & { dispatcher: typeof dispatcher } = { dispatcher };
  const fetched = await fetch('https://synthetic.invalid/memory-only', options);
  assert.equal(await fetched.text(), json); assert.equal(fetched.headers.get('content-encoding'), 'gzip');
  assert.equal(dispatches, 1);
  await withHttp(context, new SyntheticIncoming(['Content-Type', 'application/json', 'Content-Encoding', 'gzip'], 200, compressed), async (http) => {
    const native = await http.send(); const bytes = Buffer.from(await native.arrayBuffer());
    assert.equal(native.headers.get('content-encoding'), 'gzip'); assert.deepEqual(bytes, compressed);
    assert.notEqual(bytes.toString('utf8'), json); assert.equal(http.calls.length, 1);
  });
});

test('native callback discards repeated cookies before Web Headers and still counts each raw pair', async (context) => {
  const pairs = ['Content-Type', 'application/json', 'Set-Cookie', 'first=PRIVATE_COOKIE', 'set-cookie', 'second=PRIVATE_COOKIE'];
  for (const profileId of ['codex-chatgpt-sse-v3', 'codex-chatgpt-sse-v4'] as const) {
    await withHttp(context, new SyntheticIncoming(pairs), async (http) => {
      const response = await http.send(profileId);
      assert.equal(response.headers.get('set-cookie'), null); assert.deepEqual([...response.headers], [['content-type', 'application/json']]);
      const decoded = await decode(response, profileId); assert.equal(decoded.text, output);
      assert.doesNotMatch(JSON.stringify([decoded, http.observations]), /PRIVATE_COOKIE|first=|second=/);
      assert.equal(http.observations[0]!.headerCount, 3); assert.equal(http.observations[0]!.headerBytes, headerBytes(pairs));
      assert.equal(http.calls.length, 1);
    });
  }
});

test('native raw duplicate and count/byte bounds reject before consuming body; cookies cannot hide limits', async (context) => {
  const cases: [string[], string][] = [
    [['Content-Type', 'application/json', 'content-type', 'text/event-stream'], 'READONLY_LIVE_INVALID_RESPONSE_RAW_DUPLICATE_HEADER'],
    [['Content-Type', 'application/json', ...Array.from({ length: 64 }, () => ['Set-Cookie', 'a=b']).flat()], 'READONLY_LIVE_HEADER_LIMIT'],
    [['Content-Type', 'application/json', 'Set-Cookie', 'a'.repeat(16384)], 'READONLY_LIVE_HEADER_LIMIT'],
  ];
  for (const [pairs, code] of cases) {
    const incoming = new SyntheticIncoming(pairs);
    await withHttp(context, incoming, async (http) => {
      await assert.rejects(http.send(), { code });
      assert.equal(incoming.readCalls, 0); assert.equal(incoming.destroyed, true); assert.equal(http.calls.length, 1);
      assert.equal(http.observations[0]!.headerCount, pairs.length / 2);
    });
  }
  for (const pairs of [
    ['Content-Type', 'application/json', ...Array.from({ length: 63 }, () => ['Set-Cookie', 'a=b']).flat()],
    ['Content-Type', 'application/json', 'Set-Cookie', 'a'.repeat(16384 - headerBytes(['Content-Type', 'application/json', 'Set-Cookie', '']))],
  ]) await withHttp(context, new SyntheticIncoming(pairs), async (http) => {
    assert.equal((await decode(await http.send())).text, output); assert.equal(http.calls.length, 1);
  });
});

test('native request parser errors are static, value-free and never retried', async (context) => {
  for (const [nativeCode, code] of [['HPE_INVALID_HEADER_TOKEN', 'READONLY_LIVE_INVALID_RESPONSE_RAW_NODE_PARSE'],
    ['HPE_HEADER_OVERFLOW', 'READONLY_LIVE_HEADER_LIMIT'], ['ECONNRESET', 'READONLY_LIVE_CALL_FAILED']]) {
    const error = Object.assign(new Error('PRIVATE_NATIVE_HEADER_VALUE'), { code: nativeCode });
    await withHttp(context, new SyntheticIncoming([]), async (http) => {
      await assert.rejects(http.send(), (failure: unknown) => {
        assert.equal((failure as { code: string }).code, code); assert.doesNotMatch(String(failure), /PRIVATE_NATIVE_HEADER_VALUE|HPE_|ECONNRESET/); return true;
      });
      assert.equal(http.calls.length, 1); assert.deepEqual(http.observations, []);
    }, error);
  }
});

test('native HTTP 302, Location and Retry-After never cause a second request', async (context) => {
  for (const [status, pairs, code] of [
    [302, ['Content-Type', 'application/json', 'Location', 'https://synthetic.invalid/forbidden'], 'READONLY_LIVE_INVALID_RESPONSE_DECODE_STATUS'],
    [200, ['Content-Type', 'application/json', 'Location', 'https://synthetic.invalid/forbidden'], 'READONLY_LIVE_INVALID_RESPONSE_DECODE_LOCATION_POLICY'],
    [200, ['Content-Type', 'application/json', 'Retry-After', '1'], 'READONLY_LIVE_INVALID_RESPONSE_DECODE_RETRY_AFTER_POLICY'],
  ] as const) await withHttp(context, new SyntheticIncoming([...pairs], status), async (http) => {
    await assert.rejects(decode(await http.send()), { code }); assert.equal(http.calls.length, 1);
  });
});

test('v5 fixes the observed missing Content-Type boundary without bypassing response validation', async (context) => {
  const pairs = ['Set-Cookie', 'a=SYNTHETIC_COOKIE', 'set-cookie', 'b=SYNTHETIC_COOKIE', 'Set-Cookie', 'c=SYNTHETIC_COOKIE'];
  for (let index = 0; index < 32; index++) pairs.push(`x-synthetic-${index}`, 'safe');
  pairs[pairs.length - 1] += 'a'.repeat(3133 - headerBytes(pairs));
  for (const body of [json, sse]) {
    for (const profileId of ['codex-chatgpt-sse-v4', 'codex-chatgpt-sse-v5'] as const) {
      await withHttp(context, new SyntheticIncoming(pairs, 200, Buffer.from(body)), async (http) => {
        const native = await http.send(profileId);
        assert.equal(native.headers.has('content-type'), false);
        if (profileId === 'codex-chatgpt-sse-v4') await assert.rejects(decode(native, profileId), {
          code: 'READONLY_LIVE_INVALID_RESPONSE_DECODE_CONTENT_TYPE_MISSING',
        });
        else assert.equal((await decode(native, profileId)).text, output);
        assert.equal(http.calls.length, 1);
        assert.deepEqual(http.observations[0], { status: 200, headerCount: 35, headerBytes: 3133, headerDiagnostics: {
          mediaType: 'missing', contentEncoding: 'missing', invalidNameCount: 0, legacyInvalidNameCount: 0,
          invalidValueCount: 0, tabValueCount: 0, duplicateNonCookieCount: 0, cookieCount: 3,
          locationPresent: false, retryAfterPresent: false,
        } });
      });
    }
  }
  for (const body of ['<html>synthetic error</html>', '{"status":"completed"}', json.replace('"assistant"', '"tool"')]) {
    await withHttp(context, new SyntheticIncoming(pairs, 200, Buffer.from(body)), async (http) => {
      await assert.rejects(decode(await http.send('codex-chatgpt-sse-v5'), 'codex-chatgpt-sse-v5'));
      assert.equal(http.calls.length, 1);
    });
  }
});
