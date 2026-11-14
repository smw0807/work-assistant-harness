import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assertReadonlyRelayCredentialText, collectReadonlyRelayResponse, parseReadonlyRelayCodexOutput,
  READONLY_RELAY_RESPONSE_LIMITS } from '../src/policy/readonly-relay-protocol.js';

const credential = { accessToken: 'synthetic-access-token-0000', accountId: 'synthetic-account-id-1111' };
const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const response = (body: string | Uint8Array, headers: Record<string, string> = {}, status = 200): Response =>
  new Response(typeof body === 'string' ? Buffer.from(body) : Buffer.from(body), { headers, status });
const collect = (body: string | Uint8Array) => collectReadonlyRelayResponse(response(body), new AbortController().signal, credential);
const rejects = (code: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: unknown }).code, `READONLY_RELAY_${code}`);
  assert.doesNotMatch(String(error) + JSON.stringify(error), /synthetic-access-token-0000|synthetic-account-id-1111|PRIVATE_CANARY/);
  return true;
};
const escaped = (value: string): string => [...value].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');

test('relay collector preserves opaque metadata, raw bytes and hash without validating provider event semantics', async () => {
  const raw = ': synthetic comment\r\nevent: synthetic.extension\r\ndata: {"type":"unknown","sequence_number":999,"access_programs":{"cyber":"synthetic"},"tool_usage":{"arbitrary":7},"api_token":"not-an-actual-credential","text":"한글"}\r\n\r\ndata: [DONE]\n\n';
  const result = await collect(raw);
  assert.deepEqual(result.body, Buffer.from(raw));
  assert.equal(result.responseHash, createHash('sha256').update(raw).digest('hex'));
  const multiline = 'data: {"extra":\ndata: [true,null,4]}\n\n';
  assert.deepEqual((await collect(multiline)).body, Buffer.from(multiline));
});

test('relay collector returns no body before EOF and handles UTF8 code points split across network chunks', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const raw = Buffer.from(sse({ text: '합성' })); let settled = false;
  const pending = collectReadonlyRelayResponse(new Response(stream), new AbortController().signal, credential);
  void pending.then(() => { settled = true; });
  for (const byte of raw) controller!.enqueue(Uint8Array.of(byte));
  await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false);
  controller!.close(); assert.deepEqual((await pending).body, raw);
});

test('relay HTTP contract accepts only 200, missing or SSE UTF8 MIME, and missing or identity encoding', async () => {
  for (const headers of [{}, { 'content-type': 'text/event-stream; charset="UTF-8"', 'content-encoding': 'IDENTITY' }]) {
    await collectReadonlyRelayResponse(response(sse({ safe: true }), headers), new AbortController().signal, credential);
  }
  for (const [headers, status] of [
    [{}, 201], [{}, 302], [{ 'content-type': 'application/json' }, 200],
    [{ 'content-type': 'text/event-stream,text/event-stream' }, 200],
    [{ 'content-type': 'text/event-stream; charset=latin1' }, 200],
    [{ 'content-encoding': 'gzip' }, 200], [{ 'content-encoding': 'identity,identity' }, 200],
    [{ location: 'https://PRIVATE_CANARY.invalid' }, 200], [{ 'retry-after': '1' }, 200],
  ] as [Record<string, string>, number][]) {
    await assert.rejects(collectReadonlyRelayResponse(response(sse({ safe: true }), headers, status), new AbortController().signal, credential), rejects('INVALID_HTTP'));
  }
});

test('relay rejects invalid framing, duplicate decoded JSON keys, deep JSON, nonfinite numbers and invalid Unicode', async () => {
  for (const raw of ['data: {"x":1,"x":2}\n\n', 'data: {"x":1,"\\u0078":2}\n\n',
    'data: {"x":"\\ud800"}\n\n', 'data: 1e999\n\n', `data: ${'['.repeat(18)}0${']'.repeat(18)}\n\n`,
    'data: {"x":}\n\n', 'data:\n\n']) await assert.rejects(collect(raw), rejects('INVALID_JSON'));
  for (const raw of ['', ': comment\n\n', 'data: {}\n', 'data: {}']) await assert.rejects(collect(raw), rejects('INVALID_SSE'));
  await assert.rejects(collect(Buffer.from([0xff])), rejects('INVALID_UTF8'));
});

test('relay applies response, frame, frame-count and normalized header caps', async () => {
  await assert.rejects(collect(Buffer.alloc(READONLY_RELAY_RESPONSE_LIMITS.responseBytes + 1)), rejects('RESPONSE_LIMIT'));
  await assert.rejects(collect(sse({ text: 'x'.repeat(READONLY_RELAY_RESPONSE_LIMITS.frameBytes) })), rejects('FRAME_LIMIT'));
  await assert.rejects(collect(sse({}) + '\n'.repeat(READONLY_RELAY_RESPONSE_LIMITS.frames)), rejects('FRAME_LIMIT'));
  const headers = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`x-${index}`, 'safe']));
  await assert.rejects(collectReadonlyRelayResponse(response(sse({}), headers), new AbortController().signal, credential), rejects('HEADER_LIMIT'));
});

test('relay blocks literal and Unicode-escaped exact credentials in raw bodies, decoded JSON keys and values', async () => {
  for (const secret of Object.values(credential)) for (const raw of [
    sse({ text: `prefix-${secret}-suffix` }), `data: {"text":"${escaped(secret)}"}\n\n`,
    `data: {"${escaped(secret)}":"synthetic"}\n\n`, `: ${secret}\ndata: {}\n\n`,
  ]) await assert.rejects(collect(raw), rejects('CREDENTIAL_REFLECTION'));
  const bytes = Buffer.from(sse({ text: credential.accessToken })); let offset = 0;
  const source = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset)); else controller.close();
  } });
  await assert.rejects(collectReadonlyRelayResponse(new Response(source), new AbortController().signal, credential), rejects('CREDENTIAL_REFLECTION'));
});

test('relay blocks ordered credential fragments across values and frames while skipping unrelated metadata', async () => {
  for (const secret of Object.values(credential)) {
    const first = secret.slice(0, 10); const middle = secret.slice(10, 14); const last = secret.slice(14);
    const frames = sse({ delta: `unrelated-prefix${first}` }) + sse({ metadata: 'unrelated' })
      + sse({ delta: middle }) + sse({ delta: `${last}unrelated-suffix` });
    await assert.rejects(collect(frames), rejects('CREDENTIAL_REFLECTION'));
    await assert.rejects(collect(`data: {"9":"${first}","1":"${secret.slice(10)}"}\n\n`), rejects('CREDENTIAL_REFLECTION'));
  }
  await collect(sse({ pieces: ['not-a-secret', 'still-safe'] }));
});

test('ambiguous credential-prefix state growth fails closed at its fixed bound', async () => {
  const repetitive = { ...credential, accessToken: 'a'.repeat(100) };
  await assert.rejects(collectReadonlyRelayResponse(response(sse({ text: 'a'.repeat(70) })), new AbortController().signal, repetitive), rejects('CREDENTIAL_REFLECTION_LIMIT'));
});

test('final CLI JSON credential guard blocks escaped keys and ordered values without inspecting private provider fields', () => {
  assertReadonlyRelayCredentialText('{"safe":"synthetic"}', credential);
  for (const raw of [JSON.stringify({ answer: credential.accountId }), `{"answer":"${escaped(credential.accessToken)}"}`,
    JSON.stringify({ pieces: [credential.accessToken.slice(0, 12), 'unrelated', credential.accessToken.slice(12)] })]) {
    assert.throws(() => assertReadonlyRelayCredentialText(raw, credential), rejects('CREDENTIAL_REFLECTION'));
  }
  assert.throws(() => assertReadonlyRelayCredentialText('{"x":1,"x":2}', credential), rejects('INVALID_JSON'));
});

test('relay abort cancels unread input, sanitizes cancellation failures and cannot return a partial body', async () => {
  const controller = new AbortController(); let cancelled = 0;
  const source = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { cancelled++; } });
  const pending = collectReadonlyRelayResponse(new Response(source), controller.signal, credential);
  controller.abort(); await assert.rejects(pending, rejects('CANCELLED')); assert.equal(cancelled, 1);
  const broken = new ReadableStream<Uint8Array>({ cancel() { throw new Error('PRIVATE_CANARY'); } });
  await assert.rejects(collectReadonlyRelayResponse(new Response(broken, { status: 201 }), new AbortController().signal, credential), rejects('LIFECYCLE_UNSAFE'));
});

test('relay work timeout cancels the pending reader without retry', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] }); let cancelled = 0;
  const source = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { cancelled++; } });
  const pending = collectReadonlyRelayResponse(new Response(source), new AbortController().signal, credential);
  context.mock.timers.tick(READONLY_RELAY_RESPONSE_LIMITS.workTimeoutMs);
  await assert.rejects(pending, rejects('TIMEOUT')); assert.equal(cancelled, 1);
});

test('relay reports cleanup uncertainty when a source ignores cancellation', { timeout: 8000 }, async () => {
  const controller = new AbortController(); let cancelled = 0;
  const source = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { cancelled++; return new Promise(() => {}); } });
  const pending = collectReadonlyRelayResponse(new Response(source), controller.signal, credential);
  controller.abort(); await assert.rejects(pending, rejects('LIFECYCLE_UNSAFE')); assert.equal(cancelled, 1);
});

const finalText = '{"synthetic":true}';
const cli = (items: unknown[] = []): unknown[] => [{ type: 'thread.started' }, { type: 'turn.started' }, ...items,
  { type: 'item.completed', item: { type: 'agent_message', text: finalText } }, { type: 'turn.completed' }];
const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');

test('strict CLI parser accepts one turn and one final JSON with optional bounded reasoning and the exact catalog warning', () => {
  assert.equal(parseReadonlyRelayCodexOutput(jsonl(cli())), finalText);
  const events = cli([{ type: 'item.started', item: { type: 'reasoning' } }, { type: 'item.completed', item: { type: 'reasoning', text: 'Synthetic reasoning.' } },
    { type: 'item.started', item: { type: 'agent_message', text: '' } }]);
  events.splice(1, 0, { type: 'item.completed', item: { type: 'error', message: 'Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } });
  assert.equal(parseReadonlyRelayCodexOutput(jsonl(events)), finalText);
});

test('strict CLI parser rejects tools, commands, files, MCP, web, other errors and unfinished reasoning', () => {
  for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'function_call', 'error']) {
    assert.throws(() => parseReadonlyRelayCodexOutput(jsonl(cli([{ type: 'item.completed', item: { type, text: 'PRIVATE_CANARY' } }]))), rejects('INVALID_CLI_OUTPUT'));
  }
  assert.throws(() => parseReadonlyRelayCodexOutput(jsonl(cli([{ type: 'item.started', item: { type: 'reasoning' } }]))), rejects('INVALID_CLI_OUTPUT'));
});

test('strict CLI parser rejects duplicate keys, invalid Unicode, extra threads/turns/finals and incomplete output', () => {
  const events = cli();
  for (const invalid of [events.slice(1), events.slice(0, -1), [...events, { type: 'turn.completed' }],
    [events[0], events[0], ...events.slice(1)], [events[0], events[1], events[2], events[2], events[3]],
    [events[0], events[1], { type: 'turn.started' }, ...events.slice(2)]]) {
    assert.throws(() => parseReadonlyRelayCodexOutput(jsonl(invalid)), rejects('INVALID_CLI_OUTPUT'));
  }
  for (const invalid of [jsonl(events).replace('"type":"turn.started"', '"type":"turn.failed","type":"turn.started"'),
    jsonl([{ type: 'thread.started', extra: '\ud800' }, ...events.slice(1)]),
    jsonl([events[0], events[1], { type: 'item.completed', item: { type: 'agent_message', text: '{"x":1,"x":2}' } }, events[3]])]) {
    assert.throws(() => parseReadonlyRelayCodexOutput(invalid), rejects('INVALID_JSON'));
  }
});

test('strict CLI parser preserves fixed total and final byte caps', () => {
  assert.throws(() => parseReadonlyRelayCodexOutput('x'.repeat(128 * 1024 + 1)), rejects('OUTPUT_LIMIT'));
  const events = cli();
  events[2] = { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ text: 'x'.repeat(16384) }) } };
  assert.throws(() => parseReadonlyRelayCodexOutput(jsonl(events)), rejects('OUTPUT_LIMIT'));
  assert.throws(() => parseReadonlyRelayCodexOutput(jsonl(cli()), 16385), rejects('OUTPUT_LIMIT'));
});
