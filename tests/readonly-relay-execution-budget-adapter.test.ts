import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RestrictedPersonalReadonlyCodex } from '../src/adapters/personal-readonly-codex.js';
import { startReadonlyRelayBroker, type ReadonlyRelayBroker } from '../src/adapters/readonly-relay-broker.js';
import { readonlyRelayCodexArguments } from '../src/adapters/readonly-relay-codex.js';
import { readonlyRelayCleanupConfirmed } from '../src/adapters/readonly-relay-lifecycle.js';
import { runReadonlyRelayProcess } from '../src/adapters/readonly-relay-runner.js';
import { prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { SqlitePersonalReadonlyStore } from '../src/adapters/sqlite-personal-readonly-store.js';
import { PersonalReadonlyService } from '../src/application/investigate-personal-readonly.js';
import type { PersonalBudgetRegistration } from '../src/domain/personal-readonly-budget.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../src/domain/readonly-relay.js';
import { assertAnyPersonalDispatch } from '../src/policy/personal-readonly-contract.js';
import { buildReadonlyMockResponse, DEFAULT_READONLY_RANGES, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { getReadonlyRelayExecutionBudget, getReadonlyRelayExecutionBudgetHash } from '../src/policy/readonly-relay-budget-policy.js';

const credential = { kind: 'chatgpt' as const, accessToken: 'synthetic.test.only', accountId: 'synthetic-account' };
const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/codex',
  codexSha256: '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc',
  model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 };
const skip = process.platform === 'darwin' && process.env.HARNESS_NATIVE_CODEX_PROBE === '1' ? false : 'native macOS probe opt-in required';
const fixture = async (context: TestContext, selected = config) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'readonly-relay-execution-budget-'))); chmodSync(directory, 0o700);
  let store: SqlitePersonalReadonlyStore | null = null;
  context.after(() => {
    store?.close();
    const unlock = (path: string): void => { if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); } };
    unlock(directory); rmSync(directory, { recursive: true, force: true });
  });
  const source = await prepareReadonlyRepository(directory, randomUUID()); const runtime = join(directory, 'runtime'); mkdirSync(runtime, { mode: 0o700 });
  const registration: PersonalBudgetRegistration = { version: 'personal-readonly-registration-v3', collectionPolicy: 'personal-readonly-collection-v2',
    executionBudgetPolicy: 'readonly-relay-execution-budget-v1', repoId: 'budget-test', sourceRoot: source.sourceRoot, baseCommit: source.baseCommit,
    question: 'Explain only selected synthetic derived evidence.', readRanges: DEFAULT_READONLY_RANGES.map(range => ({ ...range })), transferPaths: ['src/service.ts'] };
  store = new SqlitePersonalReadonlyStore(join(runtime, 'personal-readonly.sqlite'));
  const service = new PersonalReadonlyService(store, { mode: 'live', transport: 'codex-cli-relay', transmit: async () => { throw new Error('unexpected'); } }, runtime, selected);
  const now = { ownerId: `os-user:${process.getuid!()}`, now: new Date() }; const prepared = await service.plan(registration, now);
  const payload = prepared.payload!;
  const dispatch: ReadonlyRelayDispatch = { requestEnvelope: payload.requestEnvelope, requestEnvelopeHash: payload.requestEnvelopeHash, requestBodyHash: payload.requestBodyHash };
  return { directory, runtime, store, registration, now, prepared, dispatch };
};
const send = (broker: ReadonlyRelayBroker) => fetch(`http://127.0.0.1:${broker.port}/v1/responses`, {
  method: 'POST', headers: { Authorization: `Bearer ${broker.capability}` }, body: JSON.stringify({ model: config.model, stream: true, input: 'untrusted child request' }),
});
const wire = (dispatch: ReadonlyRelayDispatch) => {
  const input = JSON.parse(dispatch.requestEnvelope.body).input[0].content[0].text;
  const text = buildReadonlyMockResponse(input);
  const item = { id: 'msg_budget_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: 'resp_budget_synthetic', object: 'response', model: config.model, status: 'completed', output: [item] };
  const events = [{ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item }, { type: 'response.completed', sequence_number: 2, response }];
  const body = Buffer.from(': synthetic budget framing\n\n'.repeat(2500) + events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  return { body, text, frames: 2503 };
};

test('execution budget selects one native idle value and rejects unregistered guardian limits before spawning', async () => {
  const legacy = { ...config, policyVersion: 'codex-cli-proposal-v1' as const, timeoutMs: 60000 as const };
  const original = readonlyRelayCodexArguments(legacy, '/synthetic/workspace', 42000);
  const selected = readonlyRelayCodexArguments(legacy, '/synthetic/workspace', 42000, getReadonlyRelayExecutionBudget(config));
  assert.deepEqual(selected, original.map(argument => argument === 'model_providers.harness.stream_idle_timeout_ms=55000'
    ? 'model_providers.harness.stream_idle_timeout_ms=120000' : argument));
  assert.throws(() => readonlyRelayCodexArguments(legacy, '/synthetic/workspace', 42000,
    { ...getReadonlyRelayExecutionBudget(config), workTimeoutMs: 120001 }), { code: 'READONLY_RELAY_INVALID_EXECUTION_BUDGET' });
  await assert.rejects(runReadonlyRelayProcess('/synthetic/never-spawn', [], '/synthetic/workspace', 42000, {}, '', new AbortController().signal,
    { dataDirectory: '/synthetic/runtime', investigationId: randomUUID() }, { ...getReadonlyRelayExecutionBudget(config), frames: 8193 }),
  { code: 'READONLY_RELAY_INVALID_EXECUTION_BUDGET' });
});

test('v3 broker requires its fixed validator, accepts more than 2048 frames once and preserves EOF before child bytes', async context => {
  const h = await fixture(context); const raw = wire(h.dispatch); let loads = 0, calls = 0; let complete!: () => void;
  await assert.rejects(startReadonlyRelayBroker(config, h.dispatch, async () => { loads++; return credential; }, new AbortController().signal,
    async () => { calls++; return new Response(raw.body); }, () => {}, () => {}));
  assert.equal(loads, 0); assert.equal(calls, 0);
  const upstream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw.body); complete = () => controller.close(); } });
  const broker = await startReadonlyRelayBroker(config, h.dispatch, async () => { loads++; return credential; }, new AbortController().signal,
    async approved => { calls++; assert.equal(approved.requestEnvelope.body, h.dispatch.requestEnvelope.body); return new Response(upstream); }, () => {}, () => {}, assertAnyPersonalDispatch);
  try {
    let delivered = false; const pending = send(broker).then(response => { delivered = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(delivered, false); assert.equal(broker.result(), null);
    complete(); const response = await pending; assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), raw.body);
    assert.equal(broker.receptionDiagnostic()!.completedFrames, raw.frames); assert.equal(broker.receptionDiagnostic()!.eof, true);
    assert.equal(broker.result()!.responseHash, hashReadonlyValue(raw.body)); assert.equal(broker.failure(), null); assert.equal(calls, 1); assert.equal(loads, 1);
    await (await send(broker)).arrayBuffer(); assert.equal(calls, 1);
  } finally { await broker.close(); }
});

test('native v3 completes a synthetic 60.5s EOF with 2503 frames and closes guardian, child, PGID and scratch', { skip, timeout: 135000 }, async context => {
  const selected: ReadonlyRelayConfig = { ...config, codexPath: process.env.HARNESS_NATIVE_CODEX_PATH ?? '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex' };
  const h = await fixture(context, selected); const raw = wire(h.dispatch); let calls = 0, eof = false, cancelled = false, eofMs = 0;
  let timer: ReturnType<typeof setTimeout> | undefined; let wake: (() => void) | undefined;
  context.after(() => { if (timer) clearTimeout(timer); wake?.(); });
  const adapter = new RestrictedPersonalReadonlyCodex(selected, h.runtime, h.prepared.task.investigationId, { credential,
    transport: async approved => {
      calls++; assert.equal(approved.requestEnvelope.body, h.dispatch.requestEnvelope.body); const started = performance.now(); let sent = false;
      return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
        if (!sent) { sent = true; controller.enqueue(raw.body); return; }
        await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 60500); });
        if (cancelled) return; eof = true; eofMs = performance.now() - started; controller.close();
      }, cancel() { cancelled = true; if (timer) clearTimeout(timer); wake?.(); } }));
    } });
  const service = new PersonalReadonlyService(h.store, adapter, h.runtime, selected, (id, hashes) => readonlyRelayCleanupConfirmed(h.runtime, id, hashes));
  const request = { investigationId: h.prepared.task.investigationId, planHash: h.prepared.task.plan.planHash };
  service.approve({ ...request, expiresInMinutes: 5 }, h.now);
  const done = await service.run(request, h.now);
  assert.equal(done.task.status, 'REPORTED', done.task.failureCode ?? 'missing report'); assert.equal(calls, 1); assert.equal(eof, true); assert.equal(cancelled, false);
  assert.ok(eofMs >= 60000 && eofMs < 65000, `EOF elapsed ${eofMs}`);
  assert.equal(done.report!.responseHash, hashReadonlyValue(raw.body)); assert.equal(done.report!.finalTextHash, hashReadonlyValue(raw.text));
  assert.equal(done.report!.verification.transport, 'fake'); assert.equal(done.report!.verification.credentialAccess, 'not_run');
  assert.ok('executionBudget' in done.report!); assert.equal(done.report.executionBudget.workTimeoutMs, 120000); assert.equal(done.report.executionBudget.frames, 8192);
  const run = join(h.runtime, 'readonly-relay-runs', request.investigationId), reportPath = join(run, 'call-report.json');
  const call = JSON.parse(readFileSync(reportPath, 'utf8')); assert.equal(lstatSync(reportPath).mode & 0o777, 0o600);
  assert.equal(call.policy, 'personal-readonly-investigation-v3'); assert.equal(call.executionBudgetHash, getReadonlyRelayExecutionBudgetHash());
  assert.deepEqual(call.executionBudget, getReadonlyRelayExecutionBudget(selected)); assert.equal(call.reception.completedFrames, raw.frames);
  assert.equal(call.reception.eof, true); assert.equal(call.relay.relayCompleted, true); assert.equal(call.cleanupConfirmed, true); assert.equal(call.failureCode, null);
  assert.equal(call.transport, 'fake'); assert.equal(call.credentialAccess, 'not_run'); assert.equal(call.upstreamCalls, 1);
  const child = JSON.parse(readFileSync(join(run, 'child.json'), 'utf8')); assert.equal(child.state, 'closed');
  for (const pid of [child.guardianPid, child.childPid, -child.childPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(existsSync(join(run, 'sandbox')), false); assert.doesNotMatch(JSON.stringify(call), /synthetic\.test\.only|synthetic-account|resp_budget_synthetic|msg_budget_synthetic/);
  await assert.rejects(service.run(request, h.now)); assert.equal(calls, 1);
  console.log(JSON.stringify({ kind: 'readonly-relay-execution-budget-native-v1', eofMs,
    bodyBytes: raw.body.length, frames: raw.frames, eof: true, upstreamCalls: calls, cleanupConfirmed: true,
    guardianAbsent: true, childAbsent: true, pgidAbsent: true, scratchAbsent: true,
    transport: 'fake', credentialAccess: 'not_run', responseHash: done.report!.responseHash, finalTextHash: done.report!.finalTextHash }));
});
