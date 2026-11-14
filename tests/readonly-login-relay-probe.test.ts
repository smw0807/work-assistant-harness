import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseReadonlyLoginRelayProbeOutput, readonlyLoginRelayFixture, runReadonlyLoginRelayProbe,
  startReadonlyLoginRelayFixtureBroker, type ReadonlyLoginRelayProbeOptions } from '../src/adapters/readonly-login-relay-probe.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const expected = { classification: 'insufficient-evidence', summary: 'Synthetic raw SSE relay fixture.', facts: [], hypotheses: [],
  answerDraft: 'No real model or login was used.', questions: [], suggestions: [], limitations: ['Only fixed synthetic output was checked.'] };
const cliEvents = (text = JSON.stringify(expected)) => [{ type: 'thread.started', thread_id: 'synthetic-thread' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'synthetic-item', type: 'agent_message', text } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }];
const lines = (events = cliEvents()) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const request = (port: number, capability: string, body = JSON.stringify({ model: 'gpt-6.1-sol', stream: true })) => fetch(`http://127.0.0.1:${port}/v1/responses`, {
  method: 'POST', headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' }, body, redirect: 'error',
});

test('relay probe dependency graph has no live transport, credential loader, CLI registration or store', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return; seen.add(path);
    assert.doesNotMatch(path, /\/(?:codex-cli|codex-broker|codex-credentials|readonly-live-broker|readonly-live-codex|sqlite-[^/]+|runtime)\.js$/u);
    assert.doesNotMatch(path, /\/cli\//u);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /(?:node:https|sendReadonlyLiveRequest|loadCodexCredential|fetch\s*\()/u);
    for (const match of source.matchAll(/import\s+(?!type\b)[^;]*?from\s+['"](\.[^'"]+)['"]/gu)) visit(resolve(dirname(path), match[1]!));
  };
  visit(join(root, 'src/adapters/readonly-login-relay-probe.js'));
  assert.ok([...seen].some((path) => path.endsWith('/codex-cli-contract.js')));
});

test('relay probe accepts only registered fixtures and own option data, with no fallback or inherited getter access', async () => {
  let reads = 0; const base = { dataDirectory: '/synthetic-unused', codexPath: '/synthetic-unused', fixtureId: 'access-programs' };
  for (const fixture of [undefined, null, 'live', 'https://example.invalid', {}]) {
    assert.throws(() => readonlyLoginRelayFixture(fixture as 'access-programs'), /READONLY_LOGIN_RELAY_INVALID_FIXTURE/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(startReadonlyLoginRelayFixtureBroker('access-programs', controller.signal), /READONLY_LOGIN_RELAY_ABORTED/);
  for (const options of [undefined, {}, { ...base, transport: () => { reads++; } }, { ...base, credential: 'PRIVATE_RELAY_CANARY' },
    Object.assign(Object.create({ get timeoutMs() { reads++; return 1; } }), base),
    Object.defineProperty({ ...base }, 'signal', { enumerable: true, get: () => { reads++; return controller.signal; } }),
    { ...base, timeoutMs: 55_001 }, { ...base, fixtureId: undefined }]) {
    await assert.rejects(runReadonlyLoginRelayProbe(options as ReadonlyLoginRelayProbeOptions));
  }
  assert.equal(reads, 0);
  const raced = new AbortController(); const pending = startReadonlyLoginRelayFixtureBroker('access-programs', raced.signal); raced.abort();
  await assert.rejects(pending, /READONLY_LOGIN_RELAY_ABORTED/);
});

test('fake relay forwards exact raw metadata bytes and only the fixed approved request once', async () => {
  const broker = await startReadonlyLoginRelayFixtureBroker('access-programs', new AbortController().signal);
  try {
    const fixture = readonlyLoginRelayFixture('access-programs');
    const response = await request(broker.port, broker.capability, JSON.stringify({ model: 'gpt-6.1-sol', stream: true,
      input: 'PRIVATE_CHILD_BODY', tools: [{ type: 'PRIVATE_CHILD_TOOL' }], headers: { authorization: 'PRIVATE_CHILD_HEADER' } }));
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.responseBody);
    await delay(0);
    const observation = broker.observation();
    assert.equal(observation.fakeDispatches, 1); assert.equal(observation.requestBodyHash, hash(fixture.requestBody));
    assert.equal(observation.responseBodyHash, hash(fixture.responseBody)); assert.equal(observation.relayedBytes, fixture.responseBody.length);
    assert.equal(observation.relayCompleted, true); assert.equal(observation.failureCode, null);
    assert.match(fixture.responseBody.toString(), /"access_programs":\{"cyber":"standard"\}/u);
    assert.match(fixture.responseBody.toString(), /"opaque_metadata":\{"enabled":true,"label":"synthetic"\}/u);
    assert.equal((await request(broker.port, broker.capability)).status, 403); assert.equal(broker.observation().fakeDispatches, 1);
    assert.doesNotMatch(JSON.stringify(broker.observation()), /PRIVATE_CHILD/);
  } finally { await broker.close(); }
});

test('capability, endpoint, method, encoding and malformed or oversized bodies cannot create a fake dispatch', async () => {
  const broker = await startReadonlyLoginRelayFixtureBroker('access-programs', new AbortController().signal);
  try {
    assert.equal((await request(broker.port, 'wrong-capability')).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${broker.port}/v1/other`, { method: 'POST', headers: { Authorization: `Bearer ${broker.capability}` } })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { headers: { Authorization: `Bearer ${broker.capability}` } })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${broker.capability}`, 'Content-Encoding': 'gzip' }, body: '{}' })).status, 403);
    for (const [body, status] of [['{', 400], ['[]', 403], ['{"model":"other","stream":true}', 403], ['x'.repeat(256 * 1024 + 1), 413]] as const) {
      assert.equal((await request(broker.port, broker.capability, body)).status, status);
    }
    assert.equal(broker.observation().fakeDispatches, 0); assert.equal(broker.observation().requestBodyHash, null);
  } finally { await broker.close(); }
});

test('concurrent requests reserve at most one fake dispatch', async () => {
  const broker = await startReadonlyLoginRelayFixtureBroker('access-programs', new AbortController().signal);
  try {
    const responses = await Promise.all([request(broker.port, broker.capability), request(broker.port, broker.capability)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 403]);
    await Promise.all(responses.map((response) => response.arrayBuffer())); assert.equal(broker.observation().fakeDispatches, 1);
  } finally { await broker.close(); }
});

test('response size rejection and early connection close remain distinct from completed raw relay', async () => {
  for (const id of ['oversized', 'early-close'] as const) {
    const broker = await startReadonlyLoginRelayFixtureBroker(id, new AbortController().signal);
    try {
      if (id === 'oversized') assert.equal((await request(broker.port, broker.capability)).status, 502);
      else await assert.rejects(async () => { const response = await request(broker.port, broker.capability); await response.arrayBuffer(); });
      const observation = broker.observation(); assert.equal(observation.fakeDispatches, 1); assert.equal(observation.relayCompleted, false);
      assert.equal(observation.relayedBytes, id === 'oversized' ? 0 : 17);
      assert.equal(observation.responseBodyHash === null, id === 'oversized');
    } finally { await broker.close(); }
  }
});

test('abort closes a stalled fake response without retry and broker cleanup finishes', async () => {
  const controller = new AbortController(); const broker = await startReadonlyLoginRelayFixtureBroker('stall', controller.signal);
  const pending = request(broker.port, broker.capability); void pending.catch(() => {});
  try {
    for (let attempt = 0; attempt < 100 && broker.observation().fakeDispatches === 0; attempt++) await delay(5);
    assert.equal(broker.observation().fakeDispatches, 1); controller.abort(); await assert.rejects(pending);
    assert.equal(broker.observation().relayCompleted, false); assert.equal(broker.observation().fakeDispatches, 1);
  } finally { await broker.close(); }
});

test('probe-only output parser accepts one thread, turn and final fixture JSON without changing the legacy parser', () => {
  assert.deepEqual(parseReadonlyLoginRelayProbeOutput(lines()), expected);
  const started = cliEvents(); started.splice(2, 0, { type: 'item.started', item: { id: 'synthetic-item', type: 'agent_message', text: '' } });
  assert.deepEqual(parseReadonlyLoginRelayProbeOutput(lines(started)), expected);
});

test('probe-only parser rejects tools, extra turns, duplicate finals, malformed JSON, duplicate keys, Unicode and incomplete output', () => {
  const mutations: unknown[][] = [cliEvents().slice(1), cliEvents().slice(0, -1), [...cliEvents(), { type: 'turn.started' }],
    [cliEvents()[0], cliEvents()[0], ...cliEvents().slice(1)], [...cliEvents().slice(0, 3), cliEvents()[2], cliEvents()[3]],
    [cliEvents()[0], cliEvents()[1], { type: 'item.started', item: { type: 'agent_message' } },
      { type: 'item.started', item: { type: 'agent_message' } }, ...cliEvents().slice(2)]];
  for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'reasoning', 'function_call']) {
    mutations.push([cliEvents()[0], cliEvents()[1], { type: 'item.completed', item: { type, text: 'PRIVATE_OUTPUT_CANARY' } }, ...cliEvents().slice(2)]);
  }
  for (const values of mutations) assert.throws(() => parseReadonlyLoginRelayProbeOutput(values.map((value) => JSON.stringify(value)).join('\n')));
  for (const raw of [lines().replace('"type":"turn.started"', '"type":"turn.failed","type":"turn.started"'),
    lines().replace('"thread_id":"synthetic-thread"', '"thread_id":"\\ud800"'), lines() + '{', 'x'.repeat(128 * 1024 + 1),
    lines(cliEvents(JSON.stringify(expected).replace('"summary":', '"summary":"PRIVATE_OUTPUT_CANARY","summary":'))),
    lines(cliEvents('{"commands":["PRIVATE_OUTPUT_CANARY"]}'))]) {
    assert.throws(() => parseReadonlyLoginRelayProbeOutput(raw), (error: unknown) => {
      assert.doesNotMatch(String(error), /PRIVATE_OUTPUT_CANARY/); return true;
    });
  }
});

const skip = process.platform === 'darwin' && process.env.HARNESS_NATIVE_CODEX_PROBE === '1' ? false : 'native macOS probe opt-in required';
const prepare = (context: TestContext): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-login-relay-'))); chmodSync(directory, 0o700);
  context.after(() => rmSync(directory, { recursive: true, force: true })); return directory;
};
const binary = () => process.env.HARNESS_NATIVE_CODEX_PATH ?? '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex';

test('native pinned Codex consumes raw access_programs and unknown metadata without projection and returns fixed investigation JSON', { skip, timeout: 60_000 }, async (context) => {
  const directory = prepare(context);
  const result = await runReadonlyLoginRelayProbe({ dataDirectory: directory, codexPath: binary(), fixtureId: 'access-programs' });
  assert.equal(result.status, 'passed', result.failureCode ?? 'missing report'); assert.deepEqual(result.finalJson, expected);
  assert.equal(result.fakeDispatches, 1); assert.equal(result.rejectedRequests, 0); assert.equal(result.relayCompleted, true);
  assert.equal(result.requestBodyHash, result.dispatchedRequestBodyHash); assert.equal(result.responseBodyHash, hash(readonlyLoginRelayFixture('access-programs').responseBody));
  assert.equal(result.realCredentialAccess, 'not_run'); assert.equal(result.externalModelCalls, 0); assert.equal(result.liveReady, false);
  assert.equal(result.isolation, 'passed'); assert.equal(result.cleanupConfirmed, true);
  const run = join(directory, 'readonly-live-runs', result.investigationId);
  assert.throws(() => lstatSync(join(run, 'sandbox')), { code: 'ENOENT' });
  const recorded = JSON.parse(readFileSync(join(run, 'relay-probe-report.json'), 'utf8'));
  assert.deepEqual(recorded, result); assert.equal(lstatSync(join(run, 'relay-probe-report.json')).mode & 0o777, 0o600);
});

test('native relay rejects wrong JSON, missing completion, oversized bytes and early close while retaining one fake dispatch', { skip, timeout: 60_000 }, async (context) => {
  const directory = prepare(context);
  for (const id of ['invalid-json', 'incomplete', 'oversized', 'early-close'] as const) {
    const result = await runReadonlyLoginRelayProbe({ dataDirectory: directory, codexPath: binary(), fixtureId: id, timeoutMs: 10_000 });
    assert.equal(result.status, 'failed', id); assert.equal(result.finalJson, null); assert.equal(result.fakeDispatches, 1);
    assert.equal(result.cleanupConfirmed, true); assert.equal(result.externalModelCalls, 0); assert.equal(result.realCredentialAccess, 'not_run');
    assert.throws(() => lstatSync(join(directory, 'readonly-live-runs', result.investigationId, 'sandbox')), { code: 'ENOENT' });
  }
});

test('native relay deadline stops a stalled fake response and confirms child and scratch cleanup', { skip, timeout: 15_000 }, async (context) => {
  const directory = prepare(context); const started = Date.now();
  const result = await runReadonlyLoginRelayProbe({ dataDirectory: directory, codexPath: binary(), fixtureId: 'stall', timeoutMs: 3000 });
  assert.equal(result.status, 'failed'); assert.equal(result.failureCode, 'READONLY_LOGIN_RELAY_TIMEOUT'); assert.equal(result.fakeDispatches, 1);
  assert.equal(result.finalJson, null); assert.equal(result.cleanupConfirmed, true); assert.ok(Date.now() - started < 10_000);
  const child = JSON.parse(readFileSync(join(directory, 'readonly-live-runs', result.investigationId, 'child.json'), 'utf8'));
  assert.equal(child.state, 'closed'); assert.throws(() => process.kill(child.childPid, 0), { code: 'ESRCH' });
});

test('native relay external abort closes the owned process before reporting cleanup', { skip, timeout: 15_000 }, async (context) => {
  const directory = prepare(context); const controller = new AbortController();
  const pending = runReadonlyLoginRelayProbe({ dataDirectory: directory, codexPath: binary(), fixtureId: 'stall', signal: controller.signal });
  let observed: { guardianPid: number; childPid: number } | null = null;
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      for (const id of readdirSync(join(directory, 'readonly-live-runs'))) {
        const child = JSON.parse(readFileSync(join(directory, 'readonly-live-runs', id, 'child.json'), 'utf8'));
        if (child.state === 'spawned') { observed = { guardianPid: child.guardianPid, childPid: child.childPid }; break; }
      }
    } catch { /* preflight is preparing owned records */ }
    if (observed) break; await delay(10);
  }
  controller.abort(); const result = await pending;
  assert.ok(observed, 'the native child must be observed before abort');
  assert.equal(result.status, 'failed'); assert.equal(result.failureCode, 'READONLY_LOGIN_RELAY_ABORTED'); assert.equal(result.cleanupConfirmed, true);
  assert.ok(result.fakeDispatches <= 1); assert.equal(result.externalModelCalls, 0);
  for (const pid of [observed.guardianPid, observed.childPid, -observed.childPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.throws(() => lstatSync(join(directory, 'readonly-live-runs', result.investigationId, 'sandbox')), { code: 'ENOENT' });
});
