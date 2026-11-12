import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodexConfig } from '../src/domain/codex-config.js';
import { parseCodexConfig, hashCodexConfig } from '../src/policy/codex-config.js';
import { parseCodexCredential } from '../src/adapters/codex-credentials.js';
import { codexProposalArguments, parseCodexEvents } from '../src/adapters/codex-cli.js';
import { codexSandboxProfile } from '../src/adapters/codex-isolation.js';
import { startCodexBroker, normalizeCodexResponse, type CodexTransport } from '../src/adapters/codex-broker.js';

const config: CodexConfig = { enabled: true, policyVersion: 'codex-cli-proposal-v1', codexPath: '/private/tmp/codex',
  codexSha256: 'a'.repeat(64), model: 'synthetic-model', authMode: 'api-key', timeoutMs: 60000, maxResponseBytes: 16384 };
const credential = { kind: 'api-key' as const, apiKey: 'synthetic-test-only' };
const completedResponse = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic' }] }] };
const response = (): Response => new Response(JSON.stringify(completedResponse), { headers: { 'Content-Type': 'application/json' } });

test('broker normalizes complete JSON/SSE only and rejects upstream tool calls or incomplete output', () => {
  const raw = JSON.stringify(completedResponse);
  assert.ok(normalizeCodexResponse(raw, config.model, 16384).includes('response.completed'));
  assert.ok(normalizeCodexResponse(`data: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n`, config.model, 16384).includes('synthetic'));
  for (const invalid of ['{}', JSON.stringify({ ...completedResponse, status: 'incomplete' }),
    JSON.stringify({ status: 'completed', output: [{ type: 'function_call' }] }), 'data: {"type":"response.failed"}\n']) {
    assert.throws(() => normalizeCodexResponse(invalid, config.model, 16384), /CODEX_UPSTREAM_INVALID_RESPONSE/);
  }
  assert.throws(() => normalizeCodexResponse(raw, config.model, 1), /CODEX_UPSTREAM_INVALID_RESPONSE/);
});

test('Codex config binds auth/model/binary and rejects arbitrary endpoint/limits', () => {
  assert.deepEqual(parseCodexConfig(config), config);
  for (const change of [{ endpoint: 'http://other' }, { model: 'bad\nname' }, { timeoutMs: 60001 }, { enabled: 'true' },
    { codexPath: '/tmp/../codex' }, { codexSha256: 'bad' }, { authMode: 'implicit' }]) {
    assert.throws(() => parseCodexConfig({ ...config, ...change }), /INVALID_CODEX_CONFIG/);
  }
  assert.notEqual(hashCodexConfig(config), hashCodexConfig({ ...config, authMode: 'chatgpt' }));
});

test('existing login parsing returns only access/account and rejects expired credential without raw error', () => {
  const now = Date.now();
  const token = (exp: number): string => `test.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.test`;
  const raw = (access: string): string => JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: access, account_id: 'synthetic-account', refresh_token: 'never-return', id_token: 'never-return',
  } });
  assert.deepEqual(parseCodexCredential(raw(token(now / 1000 + 600)), now), {
    kind: 'chatgpt', accessToken: token(now / 1000 + 600), accountId: 'synthetic-account',
  });
  for (const text of [raw(token(now / 1000)), raw('sensitive-unparseable-token'), '{}', 'x'.repeat(32769)]) {
    assert.throws(() => parseCodexCredential(text, now), /^HarnessError: CODEX_LOGIN_REQUIRED$/);
  }
});

test('Codex event parser accepts final JSON only after completion and rejects tool or extra message', () => {
  const message = { type: 'item.completed', item: { type: 'agent_message', text: '{"path":"src/message.mjs","content":"proposal"}' } };
  const completed = { type: 'turn.completed' };
  const events = (...items: unknown[]): string => items.map((item) => JSON.stringify(item)).join('\n');
  assert.equal(parseCodexEvents(events(message, completed), 16384), message.item.text);
  const metadata = { type: 'item.completed', item: { type: 'error', message:
    'Model metadata for `synthetic-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } };
  assert.equal(parseCodexEvents(events(metadata, message, completed), 16384, 'synthetic-model'), message.item.text);
  assert.throws(() => parseCodexEvents(events(metadata, message, completed), 16384, 'other-model'));
  for (const text of [events(message), events(message, message, completed), events({ type: 'turn.failed' }),
    events({ type: 'item.started', item: { type: 'command_execution' } }, completed), '{', events(null)]) {
    assert.throws(() => parseCodexEvents(text, 16384));
  }
  assert.throws(() => parseCodexEvents(events(message, completed), 2), /INVALID_CODEX_RESPONSE/);
});

test('Codex command/profile has no inherited auth, arbitrary exec or broad network permissions', () => {
  const args = codexProposalArguments(config, '/private/tmp/task/sandbox', 1234);
  assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules') && args.includes('--ephemeral'));
  assert.ok(args.includes('read-only') && args.includes('shell_tool') && args.includes('hooks'));
  assert.ok(args.includes('model_providers.harness.request_max_retries=0'));
  assert.ok(!args.join(' ').includes(credential.apiKey));
  const profile = codexSandboxProfile('/private/tmp/codex', '/private/tmp/task/sandbox', 1234);
  assert.ok(profile.includes('(deny default)') && profile.includes('localhost:1234'));
  assert.ok(!profile.includes('(allow process-fork)') && !profile.includes('(allow network*)'));
  assert.throws(() => codexSandboxProfile('/x', '/y', 0), /INVALID_CODEX_BROKER/);
});

test('broker permits one fixed upstream request, replaces CLI input/tools and never forwards capability as credential', async () => {
  let observed: Record<string, unknown> | null = null;
  let calls = 0;
  const transport: CodexTransport = async (body, auth) => { observed = JSON.parse(body) as Record<string, unknown>; calls += 1;
    assert.deepEqual(auth, credential); return response(); };
  const broker = await startCodexBroker(config, 'approved synthetic input', credential, new AbortController().signal, transport);
  const send = (path = '/v1/responses', capability = broker.capability, body: unknown = {
    model: config.model, stream: true, input: 'unapproved text', tools: [{ type: 'web_search' }],
  }): Promise<Response> => fetch(`http://127.0.0.1:${broker.port}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${capability}` }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await send('/v1/responses', 'wrong')).status, 403);
    assert.equal((await send('/v1/responses/other')).status, 403);
    assert.equal((await send('/v1/responses', broker.capability, { model: 'other', stream: true })).status, 403);
    assert.equal(calls, 0);
    const result = await send(); assert.equal(result.status, 200); await result.text();
    assert.equal(calls, 1); assert.equal(broker.calls(), 1);
    assert.ok(observed); const body = JSON.stringify(observed);
    assert.ok(body.includes('approved synthetic input')); assert.ok(!body.includes('unapproved text'));
    assert.deepEqual((observed as Record<string, unknown>).tools, []);
    assert.equal((observed as Record<string, unknown>).tool_choice, undefined);
    assert.ok(!body.includes(credential.apiKey) && !body.includes(broker.capability));
    assert.equal((await send()).status, 403); assert.equal(calls, 1);
  } finally { await broker.close(); }
});

test('broker handles parallel duplicate, oversized incoming body and upstream rejection without retry', async () => {
  for (const oversized of [true, false]) {
    let calls = 0;
    const broker = await startCodexBroker(config, 'synthetic', credential, new AbortController().signal,
      async () => { calls += 1; return new Response('not forwarded secret', { status: 401 }); });
    const send = (): Promise<Response> => fetch(`http://127.0.0.1:${broker.port}/v1/responses`, {
      method: 'POST', headers: { Authorization: `Bearer ${broker.capability}` },
      body: oversized ? 'x'.repeat(256 * 1024 + 1) : JSON.stringify({ model: config.model, stream: true }),
    });
    try {
      const results = await Promise.all([send(), send()]);
      assert.equal(calls, oversized ? 0 : 1);
      if (oversized) { assert.ok(results.some((result) => result.status === 413)); assert.ok(results.every((result) => [403, 413].includes(result.status))); }
      else assert.deepEqual(results.map((result) => result.status).sort(), [403, 502]);
      assert.ok((await results[0]!.text()).includes('CODEX_BROKER_REJECTED'));
      assert.equal(broker.failure(), oversized ? null : 'CODEX_UPSTREAM_HTTP_401');
    } finally { await broker.close(); }
  }
});

test('broker abort reaches transport and prevents later requests', async () => {
  const controller = new AbortController();
  let transportAborted = false;
  const broker = await startCodexBroker(config, 'synthetic', credential, controller.signal,
    async (_body, _credential, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { transportAborted = true; reject(new Error('secret upstream error')); });
    }));
  try {
    const pending = fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST',
      headers: { Authorization: `Bearer ${broker.capability}` }, body: JSON.stringify({ model: config.model, stream: true }) });
    while (!broker.calls()) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;
    assert.equal(result.status, 502); assert.equal(transportAborted, true);
    assert.equal(broker.failure(), 'CODEX_CALL_ABORTED');
    assert.ok(!(await result.text()).includes('secret'));
  } finally { await broker.close(); }
});
