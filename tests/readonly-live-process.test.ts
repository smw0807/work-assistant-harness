import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { RestrictedReadonlyLiveCodex } from '../src/adapters/readonly-live-codex.js';
import { SqliteReadonlyLiveStore } from '../src/adapters/sqlite-readonly-live-store.js';
import { ReadonlyLiveService } from '../src/application/investigate-live.js';
import { createReadonlyLiveLifecycle, readonlyLiveCleanupConfirmed, readonlyLiveScratchIdentity, removeReadonlyLiveScratch } from '../src/adapters/readonly-live-lifecycle.js';
import { runReadonlyLiveProcess } from '../src/adapters/readonly-live-runner.js';
import { collectReadonlyPayload, prepareReadonlyRepository, assertReadonlyRepository } from '../src/adapters/readonly-repository.js';
import type { ReadonlyLiveConfig } from '../src/domain/readonly-live.js';
import { createReadonlyLivePayload, createReadonlyLivePlan } from '../src/policy/readonly-live-policy.js';
import { defaultReadonlySelection } from '../src/policy/readonly-investigation-policy.js';

const hashes = { requestBodyHash: 'a'.repeat(64), requestEnvelopeHash: 'b'.repeat(64), connectionProfileHash: 'c'.repeat(64) };
const skip = process.platform === 'darwin' && process.env.HARNESS_NATIVE_CODEX_PROBE === '1' ? false : 'native macOS probe opt-in required';
const prepare = (t: TestContext): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-live-process-'))); chmodSync(directory, 0o700);
  t.after(() => {
    const unlock = (path: string): void => { if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); } };
    unlock(directory); rmSync(directory, { recursive: true, force: true });
  });
  return directory;
};

test('live cleanup requires durable closed evidence bound to the exact approved hashes', (t) => {
  const dataDirectory = prepare(t); const id = randomUUID();
  assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, id, hashes), false);
  const lifecycle = createReadonlyLiveLifecycle({ dataDirectory, investigationId: id }, hashes);
  assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, id, hashes), false);
  lifecycle.running(); assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, id, hashes), false);
  lifecycle.closed(); assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, id, hashes), true);
  assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, id, { ...hashes, requestBodyHash: 'd'.repeat(64) }), false);
  assert.throws(() => createReadonlyLiveLifecycle({ dataDirectory, investigationId: id }, hashes));
  writeFileSync(join(lifecycle.directory, 'lifecycle.json'), '{partial');
  assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, id, hashes), false);
});

test('live scratch cleanup rejects root replacement and never follows links to outside canaries', (t) => {
  const dataDirectory = prepare(t); const investigationId = randomUUID(); const where = { dataDirectory, investigationId };
  const lifecycle = createReadonlyLiveLifecycle(where, hashes); const scratch = join(lifecycle.directory, 'sandbox');
  const outside = join(dataDirectory, 'outside'); mkdirSync(outside, { mode: 0o700 });
  const canary = join(outside, 'canary.txt'); writeFileSync(canary, 'preserve this', { mode: 0o600 });
  mkdirSync(scratch, { mode: 0o700 }); const identity = readonlyLiveScratchIdentity(where);
  const saved = join(lifecycle.directory, 'original-sandbox'); renameSync(scratch, saved);
  symlinkSync(outside, scratch);
  assert.throws(() => removeReadonlyLiveScratch(where, identity), /READONLY_LIVE_LIFECYCLE_UNSAFE/);
  assert.equal(readFileSync(canary, 'utf8'), 'preserve this'); rmSync(scratch);
  mkdirSync(scratch, { mode: 0o700 });
  assert.throws(() => removeReadonlyLiveScratch(where, identity), /READONLY_LIVE_LIFECYCLE_UNSAFE/);
  assert.equal(readFileSync(canary, 'utf8'), 'preserve this'); rmdirSync(scratch); renameSync(saved, scratch);
  symlinkSync(outside, join(scratch, 'external-link'));
  removeReadonlyLiveScratch(where, identity);
  assert.equal(readFileSync(canary, 'utf8'), 'preserve this'); assert.throws(() => lstatSync(scratch), { code: 'ENOENT' });
  lifecycle.closed(); assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, investigationId, hashes), true);
});

const controllerScript = String.raw`
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const [directory,id,runnerUrl,lifecycleUrl,nodePath,hashesJson] = process.argv.slice(1);
const { createReadonlyLiveLifecycle } = await import(lifecycleUrl);
const { runReadonlyLiveProcess } = await import(runnerUrl);
const location={dataDirectory:directory,investigationId:id};
const lifecycle=createReadonlyLiveLifecycle(location,JSON.parse(hashesJson));
const workspace=join(lifecycle.directory,'sandbox'); mkdirSync(workspace,{mode:0o700}); lifecycle.running();
const pending=runReadonlyLiveProcess(nodePath,['--no-addons','-e',"setInterval(()=>{},1000)"],workspace,12345,
 {HOME:workspace,PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},'',new AbortController().signal,location);
void pending.catch(()=>{});
for(let i=0;i<500;i++){ const child=JSON.parse(readFileSync(join(lifecycle.directory,'child.json'),'utf8'));
 if(child.state==='spawned'){process.stdout.write(JSON.stringify(child)+'\n');break;} await delay(10); }
await pending;
`;
test('live guardian records child closure after controller SIGKILL; fresh process verifies recovery', { skip, timeout: 15000 }, async (t) => {
  const directory = prepare(t); const id = randomUUID();
  const child = spawn(process.execPath, ['--input-type=module', '-e', controllerScript, directory, id,
    new URL('../src/adapters/readonly-live-runner.js', import.meta.url).href,
    new URL('../src/adapters/readonly-live-lifecycle.js', import.meta.url).href, realpathSync(process.execPath), JSON.stringify(hashes)],
  { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready: { guardianPid: number; childPid: number } | null = null;
  t.after(() => {
    try { child.kill('SIGKILL'); } catch { /* exited */ }
    if (ready) for (const pid of [ready.guardianPid, -ready.childPid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
  });
  ready = await new Promise((resolve, reject) => {
    let text = ''; let error = ''; const timer = setTimeout(() => reject(new Error(`native ready timeout ${error}`)), 6000);
    child.stderr.on('data', (part: Buffer) => { error = (error + part.toString()).slice(0, 1024); });
    child.stdout.on('data', (part: Buffer) => { text += part.toString(); if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0]!)); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`native early exit ${error}`)); });
  });
  assert.ok(ready); assert.equal(readonlyLiveCleanupConfirmed(directory, id, hashes), false);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
  for (let i = 0; i < 100 && !readonlyLiveCleanupConfirmed(directory, id, hashes); i += 1) await delay(25);
  assert.equal(readonlyLiveCleanupConfirmed(directory, id, hashes), true);
  assert.throws(() => process.kill(ready!.childPid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(-ready!.childPid, 0), { code: 'ESRCH' });
  const verifier = spawn(process.execPath, ['--input-type=module', '-e',
    `const {readonlyLiveCleanupConfirmed}=await import(${JSON.stringify(new URL('../src/adapters/readonly-live-lifecycle.js', import.meta.url).href)}); if(!readonlyLiveCleanupConfirmed(process.argv[1],process.argv[2],JSON.parse(process.argv[3])))process.exit(1);`,
    directory, id, JSON.stringify(hashes)], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  const code = await new Promise((resolve) => verifier.once('exit', resolve)); assert.equal(code, 0);
});

test('native readonly Codex uses one fake upstream with no real login and preserves synthetic source', { skip, timeout: 60000 }, async (t) => {
  const dataDirectory = prepare(t); const id = randomUUID();
  const config: ReadonlyLiveConfig = { enabled: true, policyVersion: 'readonly-live-codex-v5',
    codexPath: process.env.HARNESS_NATIVE_CODEX_PATH ?? '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex',
    codexSha256: '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc',
    model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
  const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  const source = await collectReadonlyPayload(await prepareReadonlyRepository(dataDirectory, id), defaultReadonlySelection(), context);
  const payload = createReadonlyLivePayload(source, 'codex-chatgpt-sse-v5', config);
  const text = JSON.stringify({ classification: 'insufficient-evidence', summary: 'Synthetic response', facts: [], hypotheses: [], answerDraft: 'More evidence is needed.',
    questions: ['What should be investigated?'], suggestions: [], limitations: ['Synthetic transport does not evaluate model reasoning.'] });
  let calls = 0;
  const adapter = new RestrictedReadonlyLiveCodex(config, dataDirectory, id, {
    credential: { kind: 'chatgpt', accessToken: 'synthetic.test.only', accountId: 'synthetic-account' },
    transport: async (dispatch, credential) => {
      calls += 1; assert.equal(dispatch.requestEnvelope.body, payload.requestBody); assert.equal(credential.accessToken, 'synthetic.test.only');
      return new Response(Buffer.from(JSON.stringify({ id: 'resp_synthetic', object: 'response', status: 'completed', model: config.model,
        access_programs: null, reasoning: null, metadata: null,
        usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        output: [{ id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }] }] })), { headers: {
        'X_Synthetic': 'bounded\tvalue', 'Content-Encoding': 'IDENTITY',
      } });
    },
  });
  const store = new SqliteReadonlyLiveStore(join(dataDirectory, 'readonly-live.sqlite'));
  try {
    const plan = createReadonlyLivePlan(payload, context, config); store.create(plan, payload, context);
    const service = new ReadonlyLiveService(store, adapter, dataDirectory, config,
      (taskId, values) => readonlyLiveCleanupConfirmed(dataDirectory, taskId, values));
    const run = { investigationId: id, planHash: plan.planHash };
    await assert.rejects(service.run(run, context), /READONLY_LIVE_APPROVAL_REQUIRED/); assert.equal(calls, 0);
    service.approve({ ...run, expiresInMinutes: 5 }, context);
    const completed = await service.run(run, context);
    assert.equal(completed.task.status, 'REPORTED', completed.task.failureCode ?? 'missing report'); assert.equal(calls, 1);
    assert.deepEqual(completed.report?.result, JSON.parse(text));
    assert.deepEqual(completed.report?.verification, { transport: 'fake', upstreamCalls: 1, isolation: 'passed', credentialAccess: 'not_run' });
    assert.equal(completed.report?.checks.realModel, 'not_run'); assert.ok(completed.approvals[0]?.usedAt);
    await assert.rejects(service.run(run, context)); assert.equal(calls, 1);
  } finally { store.close(); }
  await assertReadonlyRepository(source.repository);
  assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, id, { requestBodyHash: payload.requestBodyHash,
    requestEnvelopeHash: payload.requestEnvelopeHash, connectionProfileHash: payload.connectionProfileHash }), true);
  const report = JSON.parse(readFileSync(join(dataDirectory, 'readonly-live-runs', id, 'call-report.json'), 'utf8'));
  assert.equal(report.credentialAccess, 'not_run'); assert.equal(report.upstreamCalls, 1); assert.equal(report.phase, 'completed');
  assert.equal(report.json, null);
  assert.equal(report.sensitive, null);
  assert.equal(report.sensitiveAttribution, null);
  assert.equal(report.sensitiveMatches, null);
  const home = join(dataDirectory, 'readonly-live-runs', id, 'sandbox', 'home');
  assert.throws(() => lstatSync(home), { code: 'ENOENT' });
  assert.throws(() => lstatSync(join(dataDirectory, 'readonly-live-runs', id, 'sandbox')), { code: 'ENOENT' });
});

test('native rejected JSON report records only static categories and closes the one-shot process', { skip, timeout: 60000 }, async (t) => {
  const dataDirectory = prepare(t); const id = randomUUID();
  const config: ReadonlyLiveConfig = { enabled: true, policyVersion: 'readonly-live-codex-v5',
    codexPath: process.env.HARNESS_NATIVE_CODEX_PATH ?? '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex',
    codexSha256: '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc',
    model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
  const source = await collectReadonlyPayload(await prepareReadonlyRepository(dataDirectory, id), defaultReadonlySelection(),
    { ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
  const payload = createReadonlyLivePayload(source, 'codex-chatgpt-sse-v5', config);
  let calls = 0;
  const adapter = new RestrictedReadonlyLiveCodex(config, dataDirectory, id, {
    credential: { kind: 'chatgpt', accessToken: 'synthetic.test.only', accountId: 'synthetic-account' },
    transport: async () => {
      calls += 1;
      return new Response(Buffer.from('data: {"PRIVATE_RESPONSE_CANARY":1,"PRIVATE_RESPONSE_CANARY":2}\n\n'));
    },
  });
  const dispatch = { requestBodyHash: payload.requestBodyHash, requestEnvelopeHash: payload.requestEnvelopeHash,
    requestEnvelope: payload.requestEnvelope };
  await assert.rejects(adapter.transmit(dispatch, new AbortController().signal, () => {}));
  assert.equal(calls, 1); await assertReadonlyRepository(source.repository);
  const report = JSON.parse(readFileSync(join(dataDirectory, 'readonly-live-runs', id, 'call-report.json'), 'utf8'));
  assert.equal(report.failureCode, 'READONLY_LIVE_INVALID_RESPONSE_JSON');
  assert.deepEqual(report.json, { origin: 'sse', reason: 'duplicate-key' });
  assert.equal(report.sensitive, null);
  assert.equal(report.sensitiveAttribution, null);
  assert.equal(report.sensitiveMatches, null);
  assert.equal(report.credentialAccess, 'not_run'); assert.equal(report.transport, 'fake');
  assert.equal(report.upstreamCalls, 1); assert.equal(report.cleanupConfirmed, true);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_RESPONSE_CANARY|synthetic\.test\.only/);
  assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, id, { requestBodyHash: payload.requestBodyHash,
    requestEnvelopeHash: payload.requestEnvelopeHash, connectionProfileHash: payload.connectionProfileHash }), true);
  assert.throws(() => lstatSync(join(dataDirectory, 'readonly-live-runs', id, 'sandbox')), { code: 'ENOENT' });
});

test('native sensitive report preserves distinct static match categories without storing response material', { skip, timeout: 60000 }, async (t) => {
  const dataDirectory = prepare(t); const id = randomUUID();
  const config: ReadonlyLiveConfig = { enabled: true, policyVersion: 'readonly-live-codex-v5',
    codexPath: process.env.HARNESS_NATIVE_CODEX_PATH ?? '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex',
    codexSha256: '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc',
    model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
  const source = await collectReadonlyPayload(await prepareReadonlyRepository(dataDirectory, id), defaultReadonlySelection(),
    { ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
  const payload = createReadonlyLivePayload(source, 'codex-chatgpt-sse-v5', config);
  let calls = 0;
  const adapter = new RestrictedReadonlyLiveCodex(config, dataDirectory, id, {
    credential: { kind: 'chatgpt', accessToken: 'synthetic.test.only', accountId: 'synthetic-account' },
    transport: async () => {
      calls += 1;
      const event = { type: 'response.created', sequence_number: 0, response: {
        id: 'resp_synthetic', object: 'response', status: 'in_progress', model: config.model, output: [], usage: null,
        prompt_cache_diagnostics: { type: 'cache_miss', reason: 'input_changed', cache_missed_tokens: 0, comparison_reusable_tokens: 0 },
      } };
      return new Response(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
    },
  });
  await assert.rejects(adapter.transmit({ requestBodyHash: payload.requestBodyHash, requestEnvelopeHash: payload.requestEnvelopeHash,
    requestEnvelope: payload.requestEnvelope }, new AbortController().signal, () => {}));
  assert.equal(calls, 1); await assertReadonlyRepository(source.repository);
  const report = JSON.parse(readFileSync(join(dataDirectory, 'readonly-live-runs', id, 'call-report.json'), 'utf8'));
  assert.equal(report.failureCode, 'READONLY_LIVE_INVALID_RESPONSE_JSON');
  assert.deepEqual(report.json, { origin: 'sse', reason: 'sensitive-content' });
  assert.deepEqual(report.sensitive, { pattern: 'credential-assignment', area: 'other',
    usageField: 'not-applicable', usageShape: 'not-applicable' });
  assert.equal(report.sensitiveAttribution.event, 'created');
  assert.equal(report.sensitiveAttribution.responseMarker, 'response');
  assert.equal(report.sensitiveAttribution.responseStatus, 'in-progress');
  assert.equal(report.sensitiveAttribution.reason, 'multiple');
  assert.equal(report.sensitiveAttribution.usageValidation, 'invalid-shape');
  assert.equal(report.sensitiveMatches.observedMatches, 2); assert.equal(report.sensitiveMatches.overflow, false);
  assert.deepEqual(report.sensitiveMatches.entries.map((entry: {field: string}) => entry.field).sort(), ['cache-missed-tokens', 'comparison-reusable-tokens']);
  for (const entry of report.sensitiveMatches.entries) {
    assert.equal(entry.valueType, 'nonnegative-integer'); assert.equal(entry.region, 'prompt-cache-diagnostics'); assert.equal(entry.count, 1);
  }
  assert.equal(report.credentialAccess, 'not_run'); assert.equal(report.upstreamCalls, 1); assert.equal(report.cleanupConfirmed, true);
  assert.doesNotMatch(JSON.stringify(report), /cache_missed_tokens|comparison_reusable_tokens|synthetic\.test\.only/);
  assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, id, { requestBodyHash: payload.requestBodyHash,
    requestEnvelopeHash: payload.requestEnvelopeHash, connectionProfileHash: payload.connectionProfileHash }), true);
  assert.throws(() => lstatSync(join(dataDirectory, 'readonly-live-runs', id, 'sandbox')), { code: 'ENOENT' });
});

const toolUsageStream = (text: string, requests: number, sequenceStart = 0, sequenceGap = false, createdExtension?: unknown,
  responseExtras: Record<string, unknown> = {}): string => {
  const accounting = (numRequests: number) => ({
    image_gen: { input_tokens: 0, input_tokens_details: { image_tokens: 0, text_tokens: 0 },
      output_tokens: 0, total_tokens: 0, cached_tokens: 0,
      cached_tokens_details: { cached_image_tokens: 0, cached_text_tokens: 0 },
      output_tokens_details: { image_tokens: 0, text_tokens: 0 } },
    web_search: { num_requests: numRequests },
  });
  const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: 'resp_synthetic', object: 'response', model: 'gpt-6.1-sol', tools: [], usage: null, ...responseExtras };
  const events = [
    { type: 'response.created', sequence_number: 0, ...(createdExtension === undefined ? {} : { synthetic_extension: createdExtension }),
      response: { ...response, status: 'in_progress', output: [], tool_usage: accounting(0) } },
    { type: 'response.output_item.added', sequence_number: 1, response_id: response.id, output_index: 0,
      item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', sequence_number: 2, response_id: response.id,
      item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', sequence_number: 3, response_id: response.id,
      item_id: item.id, output_index: 0, content_index: 0, text },
    { type: 'response.output_item.done', sequence_number: 4, response_id: response.id, output_index: 0, item },
    { type: 'response.completed', sequence_number: 5,
      response: { ...response, status: 'completed', output: [item], tool_usage: accounting(requests) } },
  ];
  return events.map((event, index) => ({ ...event,
    sequence_number: event.sequence_number + sequenceStart + (sequenceGap && index > 0 ? 1 : 0),
  })).map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
};

for (const scenario of [
  { name: 'v6 tool accounting accepts zero metadata', version: 'v6', requests: 0, sequenceStart: 0, sequenceGap: false, failureCode: null },
  { name: 'v6 tool accounting rejects nonzero final metadata', version: 'v6', requests: 1, sequenceStart: 0, sequenceGap: false,
    failureCode: 'READONLY_LIVE_INVALID_RESPONSE_TOOL_USAGE_ACTIVITY' },
  { name: 'v7 accepts one-based contiguous SSE events', version: 'v7', requests: 0, sequenceStart: 1, sequenceGap: false, failureCode: null },
  { name: 'v7 rejects an SSE sequence gap after one-based start', version: 'v7', requests: 0, sequenceStart: 1, sequenceGap: true,
    failureCode: 'READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT' },
  { name: 'v7 reports missing and unexpected envelope fields without raw values', version: 'v7', requests: 0,
    sequenceStart: 0, sequenceGap: false, envelopeError: true, failureCode: 'READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT' },
  { name: 'v8 discards a first-created boolean extension and reports complete output', version: 'v8', requests: 0,
    sequenceStart: 0, sequenceGap: false, createdExtension: true, failureCode: null },
  { name: 'v8 rejects a nonboolean extension with safe envelope diagnosis', version: 'v8', requests: 0,
    sequenceStart: 0, sequenceGap: false, createdExtension: 'PRIVATE_EXTENSION_CANARY', failureCode: 'READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT' },
  { name: 'v8 rejects nonzero tool accounting even after discarding a boolean extension', version: 'v8', requests: 1,
    sequenceStart: 1, sequenceGap: false, createdExtension: false, failureCode: 'READONLY_LIVE_INVALID_RESPONSE_TOOL_USAGE_ACTIVITY' },
  { name: 'v8 reports only fixed nested response envelope classes', version: 'v8', requests: 0,
    sequenceStart: 0, sequenceGap: false, responseError: true, failureCode: 'READONLY_LIVE_INVALID_RESPONSE_RESPONSE_FIELDS' },
  { name: 'v9 ignores five bounded response additions without altering the investigation report', version: 'v9', requests: 0,
    sequenceStart: 1, sequenceGap: false, createdExtension: true, responseExtras: {
      opaque_array: ['synthetic'], opaque_integer: 3, opaque_other_integer: 0, opaque_null: null, opaque_object: { enabled: true },
    }, failureCode: null },
  { name: 'v9 blocks a sensitive extension hidden by count-alias collision', version: 'v9', requests: 0,
    sequenceStart: 0, sequenceGap: false, responseExtras: { count_max_output_units: 'sk-' + 'synthetic'.repeat(6), max_output_tokens: 0 },
    extensionSensitive: true, failureCode: 'READONLY_LIVE_INVALID_RESPONSE_RESPONSE_FIELDS' },
] as const) {
  test(`native ${scenario.name} with source and cleanup preserved`,
    { skip, timeout: 60000 }, async (t) => {
      const dataDirectory = prepare(t); const id = randomUUID();
      const succeeds = scenario.failureCode === null;
      const envelopeError = 'envelopeError' in scenario;
      const invalidExtension = 'createdExtension' in scenario && typeof scenario.createdExtension !== 'boolean';
      const responseError = 'responseError' in scenario;
      const extensionSensitive = 'extensionSensitive' in scenario;
      const config: ReadonlyLiveConfig = { enabled: true, policyVersion: `readonly-live-codex-${scenario.version}`,
        codexPath: process.env.HARNESS_NATIVE_CODEX_PATH ?? '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex',
        codexSha256: '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc',
        model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
      const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
      const source = await collectReadonlyPayload(await prepareReadonlyRepository(dataDirectory, id), defaultReadonlySelection(), context);
      const payload = createReadonlyLivePayload(source, `codex-chatgpt-sse-${scenario.version}`, config);
      const result = { classification: 'insufficient-evidence', summary: 'Synthetic accounting compatibility response.',
        facts: [], hypotheses: [], answerDraft: 'More evidence is needed.', questions: ['What should be investigated?'],
        suggestions: [], limitations: ['Synthetic transport does not evaluate model reasoning or prove tool inactivity.'] };
      let calls = 0;
      const adapter = new RestrictedReadonlyLiveCodex(config, dataDirectory, id, {
        credential: { kind: 'chatgpt', accessToken: 'synthetic.test.only', accountId: 'synthetic-account' },
        transport: async (dispatch, credential) => {
          calls += 1; assert.equal(dispatch.requestEnvelope.body, payload.requestBody);
          assert.equal(credential.accessToken, 'synthetic.test.only');
          const raw = envelopeError ? 'data: {"type":"response.created","sequence_number":0,"obfuscation":"PRIVATE_PADDING_CANARY"}\n\n'
            : responseError ? 'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_PRIVATE_CANARY","object":"response","model":"gpt-6.1-sol","status":"in_progress","output":[],"conversation":null}}\n\n'
            : toolUsageStream(JSON.stringify(result), scenario.requests, scenario.sequenceStart, scenario.sequenceGap,
              'createdExtension' in scenario ? scenario.createdExtension : undefined,
              'responseExtras' in scenario ? scenario.responseExtras : {});
          return new Response(Buffer.from(raw));
        },
      });
      const store = new SqliteReadonlyLiveStore(join(dataDirectory, 'readonly-live.sqlite'));
      try {
        const plan = createReadonlyLivePlan(payload, context, config); store.create(plan, payload, context);
        const service = new ReadonlyLiveService(store, adapter, dataDirectory, config,
          (taskId, values) => readonlyLiveCleanupConfirmed(dataDirectory, taskId, values));
        const run = { investigationId: id, planHash: plan.planHash };
        await assert.rejects(service.run(run, context), /READONLY_LIVE_APPROVAL_REQUIRED/); assert.equal(calls, 0);
        service.approve({ ...run, expiresInMinutes: 5 }, context);
        const completed = await service.run(run, context);
        assert.equal(calls, 1); assert.equal(completed.approvals.length, 1);
        assert.equal(completed.approvals[0]?.usedAt, completed.attempt?.startedAt);
        assert.ok(completed.approvals[0]?.usedAt); assert.ok(completed.attempt?.dispatchedAt);
        assert.equal(completed.task.status, succeeds ? 'REPORTED' : 'FAILED', completed.task.failureCode ?? 'missing report');
        if (succeeds) {
          assert.deepEqual(completed.report?.result, result);
          assert.deepEqual(completed.report?.verification, { transport: 'fake', upstreamCalls: 1,
            isolation: 'passed', credentialAccess: 'not_run' });
          assert.equal(completed.report?.checks.realModel, 'not_run');
        } else {
          assert.equal(completed.report, null); assert.equal(completed.attempt?.responseHash, null);
        }
        await assert.rejects(service.run(run, context)); assert.equal(calls, 1);
      } finally { store.close(); }
      await assertReadonlyRepository(source.repository);
      const directory = join(dataDirectory, 'readonly-live-runs', id);
      const report = JSON.parse(readFileSync(join(directory, 'call-report.json'), 'utf8'));
      assert.equal(report.failureCode, scenario.failureCode);
      assert.equal(report.phase, succeeds ? 'completed' : 'request');
      assert.equal(report.json, null); assert.equal(report.sensitive, null);
      assert.equal(report.sensitiveAttribution, null); assert.equal(report.sensitiveMatches, null);
      assert.deepEqual(report.sse, scenario.sequenceGap
        ? { event: 'output-item', reason: 'sequence-step', sequence: 'later', position: 'later' }
        : envelopeError || invalidExtension ? { event: 'created', reason: 'envelope', sequence: 'zero', position: 'first' } : null);
      assert.deepEqual(report.sseEnvelope, envelopeError ? { missing: ['response'],
        unexpected: [{ field: 'obfuscation', valueType: 'string', count: 1 }], observedUnexpected: 1, overflow: false }
        : invalidExtension ? { missing: [], unexpected: [{ field: 'other', valueType: 'string', count: 1 }], observedUnexpected: 1, overflow: false } : null);
      assert.deepEqual(report.response, responseError ? { event: 'created', reason: 'envelope', envelope: { missing: [],
        unexpected: [{ field: 'conversation', valueType: 'null', count: 1 }], observedUnexpected: 1, overflow: false } }
        : extensionSensitive ? { event: 'created', reason: 'extension-sensitive', envelope: null } : null);
      assert.equal(report.transport, 'fake'); assert.equal(report.credentialAccess, 'not_run');
      assert.equal(report.isolation, 'passed'); assert.equal(report.upstreamCalls, 1); assert.equal(report.cleanupConfirmed, true);
      assert.equal(report.requestBodyHash, payload.requestBodyHash);
      assert.equal(report.requestEnvelopeHash, payload.requestEnvelopeHash);
      assert.equal(report.connectionProfileHash, payload.connectionProfileHash);
      assert.doesNotMatch(JSON.stringify(report), /synthetic\.test\.only|tool_usage|image_gen|num_requests|PRIVATE_PADDING_CANARY|PRIVATE_EXTENSION_CANARY|synthetic_extension|resp_PRIVATE_CANARY|opaque_array|sk-/);
      assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, id, { requestBodyHash: payload.requestBodyHash,
        requestEnvelopeHash: payload.requestEnvelopeHash, connectionProfileHash: payload.connectionProfileHash }), true);
      const child = JSON.parse(readFileSync(join(directory, 'child.json'), 'utf8'));
      assert.equal(child.state, 'closed');
      for (const pid of [child.guardianPid, child.childPid, -child.childPid]) {
        assert.ok(Number.isSafeInteger(pid) && pid !== 0); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      }
      assert.throws(() => lstatSync(join(directory, 'sandbox')), { code: 'ENOENT' });
    });
}

test('disabled live adapter rejects before lifecycle creation or any authentication', async (t) => {
  const directory = prepare(t);
  const adapter = new RestrictedReadonlyLiveCodex({ enabled: false, policyVersion: 'readonly-live-codex-v1', codexPath: '/private/tmp/synthetic',
    codexSha256: 'a'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 }, directory, randomUUID());
  await assert.rejects(adapter.transmit({ requestBodyHash: 'a'.repeat(64), requestEnvelopeHash: 'b'.repeat(64), requestEnvelope: {} } as never,
    new AbortController().signal, () => {}), /READONLY_LIVE_DISABLED/);
  assert.deepEqual(readdirSync(directory), []);
});

test('live guardian bounds discarded native stderr and closes its process group', { skip, timeout: 10000 }, async (t) => {
  const dataDirectory = prepare(t); const investigationId = randomUUID(); const location = { dataDirectory, investigationId };
  const lifecycle = createReadonlyLiveLifecycle(location, hashes);
  const workspace = join(lifecycle.directory, 'sandbox'); mkdirSync(workspace, { mode: 0o700 }); lifecycle.running();
  await assert.rejects(runReadonlyLiveProcess(realpathSync(process.execPath), ['--no-addons', '-e',
    "process.stderr.write('S'.repeat(16385)); setInterval(()=>{},1000)"], workspace, 12345,
  { HOME: workspace, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, '', AbortSignal.timeout(5000), location), /READONLY_LIVE_PROCESS_FAILED/);
  const record = JSON.parse(readFileSync(join(lifecycle.directory, 'child.json'), 'utf8'));
  assert.equal(record.state, 'closed'); assert.throws(() => process.kill(-record.childPid, 0), { code: 'ESRCH' });
  lifecycle.closed(); assert.equal(readonlyLiveCleanupConfirmed(dataDirectory, investigationId, hashes), true);
});
