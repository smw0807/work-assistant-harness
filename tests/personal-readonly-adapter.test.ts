import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RestrictedPersonalReadonlyCodex } from '../src/adapters/personal-readonly-codex.js';
import { assertPersonalReadonlyRepository, collectPersonalReadonlyEvidence, inspectPersonalReadonlyRepository } from '../src/adapters/personal-readonly-repository.js';
import { startReadonlyRelayBroker } from '../src/adapters/readonly-relay-broker.js';
import { readonlyRelayCleanupConfirmed } from '../src/adapters/readonly-relay-lifecycle.js';
import { prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { SqlitePersonalReadonlyStore } from '../src/adapters/sqlite-personal-readonly-store.js';
import { PersonalReadonlyService } from '../src/application/investigate-personal-readonly.js';
import type { PersonalReadonlyRegistration } from '../src/domain/personal-readonly.js';
import type { ReadonlyRelayConfig } from '../src/domain/readonly-relay.js';
import { createPersonalReadonlyPayload } from '../src/policy/personal-readonly-policy.js';
import { DEFAULT_READONLY_RANGES, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const credential = { kind: 'chatgpt' as const, accessToken: 'synthetic.test.only', accountId: 'synthetic-account' };
const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v2', codexPath: '/synthetic/codex',
  codexSha256: '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc',
  model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const skip = process.platform === 'darwin' && process.env.HARNESS_NATIVE_CODEX_PROBE === '1' ? false : 'native macOS probe opt-in required';
const prepare = async (context: TestContext) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'personal-readonly-native-'))); chmodSync(directory, 0o700);
  context.after(() => {
    const unlock = (path: string): void => { if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); } };
    unlock(directory); rmSync(directory, { recursive: true, force: true });
  });
  const target = join(directory, 'target'); const runtime = join(directory, 'runtime'); mkdirSync(target, { mode: 0o700 }); mkdirSync(runtime, { mode: 0o700 });
  const source = await prepareReadonlyRepository(target, randomUUID());
  const registration: PersonalReadonlyRegistration = { version: 'personal-readonly-registration-v1', repoId: 'personal-test',
    sourceRoot: source.sourceRoot, baseCommit: source.baseCommit, question: 'Explain the selected request flow and identify missing evidence.',
    readRanges: DEFAULT_READONLY_RANGES.map(range => ({ ...range })), transferPaths: ['src/service.ts'] };
  return { directory, runtime, registration };
};

test('personal input cannot enter the existing synthetic relay broker or select a v1 transport', async context => {
  const h = await prepare(context); const now = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  const repository = await inspectPersonalReadonlyRepository(h.registration, randomUUID());
  const evidence = await collectPersonalReadonlyEvidence(repository, h.registration);
  const payload = createPersonalReadonlyPayload(repository, h.registration, evidence, now, config);
  let credentialReads = 0; let transmissions = 0;
  await assert.rejects(startReadonlyRelayBroker(config, { requestEnvelope: payload.requestEnvelope, requestEnvelopeHash: payload.requestEnvelopeHash, requestBodyHash: payload.requestBodyHash }, async () => { credentialReads++; return credential; },
    new AbortController().signal, async () => { transmissions++; return new Response('unused'); }, () => {}, () => {}));
  assert.equal(credentialReads, 0); assert.equal(transmissions, 0);
  assert.throws(() => new RestrictedPersonalReadonlyCodex({ ...config, policyVersion: 'readonly-relay-codex-v1' }, h.runtime, repository.id));
});

test('native personal readonly reuses v2 transport with only approved personal bytes, final evidence and confirmed cleanup', { skip, timeout: 60000 }, async context => {
  const h = await prepare(context); const selected = { ...config, codexPath: process.env.HARNESS_NATIVE_CODEX_PATH ?? '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex' };
  let calls = 0; let body = ''; let expected = '';
  const idHolder = { id: '' };
  const port = { mode: 'live' as const, transport: 'codex-cli-relay' as const,
    transmit: async (...args: Parameters<RestrictedPersonalReadonlyCodex['transmit']>) => {
      const adapter = new RestrictedPersonalReadonlyCodex(selected, h.runtime, idHolder.id, { credential, transport: async dispatch => {
        calls++; body = dispatch.requestEnvelope.body;
        const input = JSON.parse(body).input[0].content[0].text;
        const evidence = JSON.parse(input).evidence[0];
        expected = JSON.stringify({ classification: 'question', summary: 'Selected synthetic service flow.',
          facts: [{ text: 'The supplied excerpt contains the service implementation.', references: [{ evidenceId: evidence.evidenceId, startLine: evidence.startLine, endLine: evidence.endLine }] }],
          hypotheses: [], answerDraft: 'Review the supplied service excerpt; omitted controller evidence limits the full flow.', questions: [], suggestions: [], limitations: ['Synthetic upstream only.'] });
        const item = { id: 'msg_personal_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: expected, annotations: [] }] };
        const response = { id: 'resp_personal_synthetic', object: 'response', model: config.model, status: 'completed', output: [item], unfamiliar_metadata: { inert: true } };
        const events = [{ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item }, { type: 'response.completed', sequence_number: 2, response }];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      } });
      return adapter.transmit(...args);
    } };
  const store = new SqlitePersonalReadonlyStore(join(h.runtime, 'personal-readonly.sqlite'));
  try {
    const service = new PersonalReadonlyService(store, port, h.runtime, selected, (id, hashes) => readonlyRelayCleanupConfirmed(h.runtime, id, hashes));
    const now = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() }; const prepared = await service.plan(h.registration, now);
    idHolder.id = prepared.task.investigationId;
    const request = { investigationId: idHolder.id, planHash: prepared.task.plan.planHash };
    service.approve({ ...request, expiresInMinutes: 5 }, now);
    const done = await service.run(request, now);
    assert.equal(done.task.status, 'REPORTED', done.task.failureCode ?? 'missing report'); assert.equal(calls, 1);
    assert.equal(body, prepared.payload!.requestBody); assert.equal(body.includes(h.registration.sourceRoot), false);
    assert.equal(JSON.parse(JSON.parse(body).input[0].content[0].text).evidence.length, 1);
    assert.deepEqual(done.report!.result, JSON.parse(expected)); assert.equal(done.report!.finalTextHash, hashReadonlyValue(expected));
    assert.equal(done.report!.checks.realModel, 'not_run'); assert.equal(done.report!.verification.credentialAccess, 'not_run');
    await assertPersonalReadonlyRepository(prepared.payload!.repository);
    const run = join(h.runtime, 'readonly-relay-runs', idHolder.id); const call = JSON.parse(readFileSync(join(run, 'call-report.json'), 'utf8'));
    assert.equal(call.policy, 'personal-readonly-investigation-v1'); assert.equal(call.cleanupConfirmed, true); assert.equal(call.reception.eof, true);
    assert.equal(call.transport, 'fake'); assert.equal(call.upstreamCalls, 1); assert.equal(call.failureCode, null);
    const child = JSON.parse(readFileSync(join(run, 'child.json'), 'utf8')); assert.equal(child.state, 'closed');
    for (const pid of [child.childPid, -child.childPid, child.guardianPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.throws(() => lstatSync(join(run, 'sandbox')), { code: 'ENOENT' });
    assert.doesNotMatch(JSON.stringify(call), /synthetic\.test\.only|synthetic-account|resp_personal_synthetic|msg_personal_synthetic/);
    await assert.rejects(service.run(request, now)); assert.equal(calls, 1);
  } finally { store.close(); }
});
