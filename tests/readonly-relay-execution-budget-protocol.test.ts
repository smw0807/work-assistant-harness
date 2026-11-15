import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getReadonlyRelayExecutionBudget } from '../src/policy/readonly-relay-budget-policy.js';
import { collectReadonlyRelayResponse, inspectReadonlyRelayExecutionBudgetFixture } from '../src/policy/readonly-relay-protocol.js';

const budget = getReadonlyRelayExecutionBudget({ enabled: false, policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/codex',
  codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 });
const credential = { accessToken: 'SYNTHETIC_TOKEN_FOR_BUDGET_123', accountId: 'SYNTHETIC_ACCOUNT_FOR_BUDGET' };
const body = (frames: number): Buffer => Buffer.from('data: {"synthetic":true}\n\n'.repeat(frames));
const response = (bytes: Uint8Array): Response => new Response(Buffer.from(bytes), { headers: { 'content-type': 'text/event-stream' } });

test('execution budget collector opt-in accepts 6144/8192 frames while legacy default remains exactly 2048', async () => {
  for (const frames of [2048, 2049, 6144, 8192, 8193]) {
    const bytes = body(frames);
    if (frames <= 2048) await collectReadonlyRelayResponse(response(bytes), new AbortController().signal, credential);
    else await assert.rejects(collectReadonlyRelayResponse(response(bytes), new AbortController().signal, credential, { responseBytes: 4194304 }), { code: 'READONLY_RELAY_FRAME_LIMIT' });
    if (frames <= 8192) assert.deepEqual((await collectReadonlyRelayResponse(response(bytes), new AbortController().signal, credential, { executionBudget: budget })).body, bytes);
    else await assert.rejects(collectReadonlyRelayResponse(response(bytes), new AbortController().signal, credential, { executionBudget: budget }), { code: 'READONLY_RELAY_FRAME_LIMIT' });
  }
});

test('execution budget offline framing candidates share the same validator with independent byte/JSON/reflection bounds', () => {
  assert.throws(() => inspectReadonlyRelayExecutionBudgetFixture(body(6144), credential, 4096), { code: 'READONLY_RELAY_FRAME_LIMIT' });
  inspectReadonlyRelayExecutionBudgetFixture(body(6144), credential, 8192);
  assert.throws(() => inspectReadonlyRelayExecutionBudgetFixture(body(1), credential, 2048 as 4096));
  assert.throws(() => inspectReadonlyRelayExecutionBudgetFixture(Buffer.from('data: {"x":1,"x":2}\n\n'), credential, 8192), { code: 'READONLY_RELAY_INVALID_JSON' });
  assert.throws(() => inspectReadonlyRelayExecutionBudgetFixture(Buffer.from(`data: {"text":"${credential.accessToken}"}\n\n`), credential, 8192), { code: 'READONLY_RELAY_CREDENTIAL_REFLECTION' });
});

test('execution budget accepts only the whole fixed v3 tuple and compatible explicit responseBytes', async () => {
  for (const bad of [{ ...budget, frames: 4096 }, { ...budget, workTimeoutMs: 90000 }, { ...budget, responseBytes: 1048576 },
    { ...budget, jsonDepth: 17 }, undefined]) {
    await assert.rejects(collectReadonlyRelayResponse(response(body(1)), new AbortController().signal, credential,
      { executionBudget: bad } as Parameters<typeof collectReadonlyRelayResponse>[3]), { code: 'READONLY_RELAY_INVALID_OPTIONS' });
  }
  await assert.rejects(collectReadonlyRelayResponse(response(body(1)), new AbortController().signal, credential,
    { executionBudget: budget, responseBytes: 262144 }), { code: 'READONLY_RELAY_INVALID_OPTIONS' });
  let getters = 0;
  const forged = Object.defineProperty({ ...budget }, 'frames', { enumerable: true, get() { getters++; return 8192; } });
  await assert.rejects(collectReadonlyRelayResponse(response(body(1)), new AbortController().signal, credential, { executionBudget: forged }));
  assert.equal(getters, 0);
});

test('execution budget preserves HTTP/UTF8/frame64KiB/depth/reflection/EOF restrictions', async () => {
  const cases = [new Response('data: {}\n\n', { status: 201 }), response(Buffer.from([255])),
    response(Buffer.from('data: ' + JSON.stringify({ x: 'x'.repeat(65536) }) + '\n\n')),
    response(Buffer.from('data: {"x":' + '['.repeat(18) + '0' + ']'.repeat(18) + '}\n\n')),
    response(Buffer.from(`data: {"x":"${credential.accountId}"}\n\n`)), response(Buffer.from('data: {}'))];
  for (const selected of cases) await assert.rejects(collectReadonlyRelayResponse(selected, new AbortController().signal, credential, { executionBudget: budget }));
  const extra = new Uint8Array(4194305);
  await assert.rejects(collectReadonlyRelayResponse(response(extra), new AbortController().signal, credential, { executionBudget: budget }), { code: 'READONLY_RELAY_RESPONSE_LIMIT' });
});

test('execution budget mocked clock enforces 120000ms work timeout and legacy still expires at 55000ms', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const selected of [undefined, budget]) {
    let cancelled = 0, settled = false;
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => { cancelled++; } });
    const pending = collectReadonlyRelayResponse(new Response(stream), new AbortController().signal, credential,
      selected ? { executionBudget: selected } : undefined).finally(() => { settled = true; });
    const rejected = assert.rejects(pending, { code: 'READONLY_RELAY_TIMEOUT' });
    await Promise.resolve(); context.mock.timers.tick((selected ? 120000 : 55000) - 1);
    await Promise.resolve(); assert.equal(settled, false);
    context.mock.timers.tick(1); await rejected; assert.equal(cancelled, 1);
  }
});

test('execution budget cancellation interrupts blocked source and produces one numeric diagnostic', async () => {
  const controller = new AbortController(); let calls = 0, cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => { cancelled++; } });
  const pending = collectReadonlyRelayResponse(new Response(stream), controller.signal, credential,
    { executionBudget: budget, observeDiagnostic: diagnostic => { calls++; assert.equal(diagnostic.termination, 'cancelled'); assert.equal(diagnostic.eof, false); } });
  controller.abort(); await assert.rejects(pending, { code: 'READONLY_RELAY_CANCELLED' }); assert.equal(cancelled, 1); assert.equal(calls, 1);
});

test('execution budget empty-chunk source yields to cancellation within the fixed cleanup observation gate', { timeout: 10000 }, async () => {
  const controller = new AbortController(); let cancelled = 0, chunks = 0;
  const baseline = process.memoryUsage(), cpu = process.cpuUsage(), started = performance.now();
  const stream = new ReadableStream<Uint8Array>({ pull: target => { chunks++; target.enqueue(new Uint8Array(0)); }, cancel: () => { cancelled++; } });
  const timer = setTimeout(() => controller.abort(), 5);
  try {
    await assert.rejects(collectReadonlyRelayResponse(new Response(stream), controller.signal, credential, { executionBudget: budget }), { code: 'READONLY_RELAY_CANCELLED' });
  } finally { clearTimeout(timer); }
  const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu);
  assert.ok(chunks > 0); assert.equal(cancelled, 1); assert.ok(elapsedMs <= 5000);
  console.log(JSON.stringify({ kind: 'readonly-relay-execution-budget-cancellation-v1', source: 'infinite-empty-chunks', chunks,
    elapsedMs, cpuMs: (used.user + used.system) / 1000, rssDeltaBytes: Math.max(0, process.memoryUsage().rss - baseline.rss), gateMs: 5000, passed: true }));
});

test('execution budget cleanup remains bounded at 5000ms for default and selected contracts', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const selected of [undefined, budget]) {
    const controller = new AbortController(); let settled = false;
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) });
    const pending = collectReadonlyRelayResponse(new Response(stream), controller.signal, credential,
      selected ? { executionBudget: selected } : undefined).finally(() => { settled = true; });
    const rejected = assert.rejects(pending, { code: 'READONLY_RELAY_LIFECYCLE_UNSAFE' });
    controller.abort(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    context.mock.timers.tick(4999); await Promise.resolve(); assert.equal(settled, false);
    context.mock.timers.tick(1); await rejected;
  }
});
