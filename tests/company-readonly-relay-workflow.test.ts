import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CompanyRelayService } from '../src/application/investigate-company-relay.js';
import { CompanyReadonlyPreparationServiceV3 } from '../src/application/prepare-company-readonly-v3.js';
import { CompanyInvestigationSourceAdapter } from '../src/adapters/company-investigation-source.js';
import { RestrictedCompanyRelayCodex } from '../src/adapters/company-relay-codex.js';
import { inspectCompanyCodexIpcDirectory } from '../src/adapters/codex-isolation.js';
import { startReadonlyRelayBroker } from '../src/adapters/readonly-relay-broker.js';
import { SqliteCompanyRelayStore } from '../src/adapters/sqlite-company-relay-store.js';
import { SqliteCompanyReadonlyV3Store } from '../src/adapters/sqlite-company-readonly-v3-store.js';
import type { CompanyRelayAuthorization } from '../src/domain/company-relay.js';
import { HarnessError } from '../src/domain/errors.js';
import type { ReadonlyEvidence } from '../src/domain/readonly-investigation.js';
import type { ReadonlyRelayDispatch } from '../src/domain/readonly-relay.js';
import type { ReadonlyRelayPort, ReadonlyRelayTransmissionResult } from '../src/ports/readonly-relay.js';
import { assertCompanyRelayAccount, assertCompanyRelayDispatch } from '../src/policy/company-relay.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { createCompanyReadonlyV3Fixture } from './company-readonly-v3-fixture.js';

const declaration = (): CompanyRelayAuthorization => ({ version: 'company-relay-authorization-v1', enabled: true,
  companyTransmissionApproved: true, providerTermsConfirmed: true, accountIdHash: hashReadonlyValue('synthetic-company-account'),
  config: { enabled: true, policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/codex', codexSha256: 'a'.repeat(64),
    model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 } });
const respond = (dispatch: ReadonlyRelayDispatch): ReadonlyRelayTransmissionResult => {
  const body = JSON.parse(dispatch.requestEnvelope.body) as { input: { content: { text: string }[] }[] };
  const input = JSON.parse(body.input[0]!.content[0]!.text) as { evidence: ReadonlyEvidence[] };
  const text = canonicalReadonlyJson({ classification: 'insufficient-evidence', summary: 'Synthetic company relay report.',
    facts: input.evidence.map(item => ({ text: 'The selected synthetic excerpt is available.',
      references: [{ evidenceId: item.evidenceId, startLine: item.startLine, endLine: item.endLine }] })),
    hypotheses: [], answerDraft: 'Only the fake transport workflow was checked.', questions: [], suggestions: [],
    limitations: ['Synthetic transport only; semantic accuracy remains unverified.'] });
  return { text, responseHash: hashReadonlyValue('synthetic company response stream'), finalTextHash: hashReadonlyValue(text),
    verification: { transport: 'fake', upstreamCalls: 1, isolation: 'not_run', credentialAccess: 'not_run',
      responseValidation: 'codex-native-output-v1', relayCompleted: true, credentialReflection: 'passed' } };
};
const setup = async (context: TestContext) => {
  const fixture = await createCompanyReadonlyV3Fixture(context), before = fixture.snapshot();
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-relay-workflow-')));
  fs.chmodSync(directory, 0o700);
  const prepDirectory = join(directory, 'preparation'), relayDirectory = join(directory, 'relay');
  fs.mkdirSync(prepDirectory, { mode: 0o700 }); fs.mkdirSync(relayDirectory, { mode: 0o700 });
  const preparations = new SqliteCompanyReadonlyV3Store(join(prepDirectory, 'company-readonly-v3.sqlite'));
  new CompanyReadonlyPreparationServiceV3(preparations, fixture.source).prepare(fixture.registration, fixture.policy, fixture.context, fixture.id);
  const file = join(relayDirectory, 'company-relay.sqlite');
  let store = new SqliteCompanyRelayStore(file), now = fixture.context.now.getTime(), factories = 0, probes = 0, calls = 0;
  const authorization = declaration();
  let implementation: ReadonlyRelayPort = { mode: 'live', transport: 'codex-cli-relay', transmit: async (dispatch, _signal, before, beforeCredential) => {
    beforeCredential(); before(); calls++; return respond(dispatch);
  } };
  const factory = () => {
    factories++;
    return { mode: 'live' as const, transport: 'codex-cli-relay' as const,
      verifyReady: async () => { probes++; await implementation.verifyReady?.(); },
      transmit: (dispatch: ReadonlyRelayDispatch, signal: AbortSignal, before: () => void, beforeCredential: () => void) =>
        implementation.transmit(dispatch, signal, before, beforeCredential) };
  };
  const source = new CompanyInvestigationSourceAdapter();
  const preparation = { runtimeHash: hashReadonlyValue(prepDirectory), inspect: preparations.inspect.bind(preparations) };
  const service = () => new CompanyRelayService(store, preparation, source, factory, authorization, () => new Date(now));
  context.after(() => { store.close(); preparations.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const approve = () => {
    const planned = service().plan(fixture.id, fixture.context);
    const request = { investigationId: planned.plan.id, planHash: planned.plan.planHash };
    service().approve({ ...request, expiresInMinutes: 10 }, fixture.context);
    return { planned, request };
  };
  return { fixture, before, preparations, preparation, source, factory, file, service, approve, authorization, store: () => store,
    counts: () => ({ factories, probes, calls }), usePort: (value: ReadonlyRelayPort) => { implementation = value; },
    advance: (milliseconds: number) => { now += milliseconds; },
    reopen: () => { store.close(); store = new SqliteCompanyRelayStore(file); } };
};
const settleMicrotasks = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

test('company relay has separate approval, consumes once and records a fake report without native/auth claims', async context => {
  const run = await setup(context), { planned, request } = run.approve();
  assert.deepEqual(run.counts(), { factories: 0, probes: 0, calls: 0 });
  const result = await run.service().run(request, run.fixture.context);
  assert.equal(result.status, 'REPORTED'); assert.ok(result.approval?.usedAt); assert.ok(result.attempt?.dispatchedAt);
  assert.deepEqual(run.counts(), { factories: 1, probes: 1, calls: 1 }); assert.ok(result.report);
  assert.equal(result.report.mode, 'live'); assert.equal(result.report.verification.transport, 'fake');
  assert.equal(result.report.realModel, 'not_run'); assert.equal(result.report.nativeExecution, 'not_run');
  assert.equal(result.report.credentialAccess, 'not_run'); assert.equal(result.report.externalTransmission, 'not_run');
  assert.equal(result.report.semanticAccuracyVerified, false); assert.equal(result.plan.expiresAt, planned.plan.preparation.expiresAt);
  assert.equal(result.plan.auditExpiresAt, planned.plan.preparation.auditExpiresAt); assert.equal(run.fixture.snapshot(), run.before);
  run.reopen(); assert.deepEqual(run.service().inspect(request.investigationId, run.fixture.context), result);
  await assert.rejects(run.service().run(request, run.fixture.context)); assert.equal(run.counts().calls, 1);
});

test('company preparation pending state and mismatched plan do not construct or probe any relay', async context => {
  const run = await setup(context), planned = run.service().plan(run.fixture.id, run.fixture.context);
  const request = { investigationId: planned.plan.id, planHash: planned.plan.planHash };
  await assert.rejects(run.service().run(request, run.fixture.context), { code: 'COMPANY_RELAY_APPROVAL_REQUIRED' });
  assert.throws(() => run.service().approve({ ...request, planHash: '0'.repeat(64), expiresInMinutes: 10 }, run.fixture.context),
    { code: 'COMPANY_RELAY_PLAN_MISMATCH' });
  assert.deepEqual(run.counts(), { factories: 0, probes: 0, calls: 0 });
  assert.equal(run.store().inspect(planned.plan.id, run.fixture.context).attempt, null);
});

test('claim precedes readiness and the dispatch reservation precedes the fake upstream call', async context => {
  const run = await setup(context), { request } = run.approve(); let checked = false;
  run.usePort({ mode: 'live', transport: 'codex-cli-relay', verifyReady: async () => {
    const snapshot = run.store().inspect(request.investigationId, run.fixture.context);
    assert.ok(snapshot.approval?.usedAt); assert.equal(snapshot.status, 'RUNNING'); assert.equal(snapshot.attempt?.dispatchedAt, null);
  }, transmit: async (dispatch, _signal, before, beforeCredential) => {
    assert.equal(Object.isFrozen(dispatch), true); assert.equal(Object.isFrozen(dispatch.requestEnvelope), true);
    assert.equal(Object.isFrozen(dispatch.requestEnvelope.headers), true);
    beforeCredential(); assert.equal(run.store().inspect(request.investigationId, run.fixture.context).attempt?.dispatchedAt, null);
    before(); assert.ok(run.store().inspect(request.investigationId, run.fixture.context).attempt?.dispatchedAt);
    checked = true; return respond(dispatch);
  } });
  assert.equal((await run.service().run(request, run.fixture.context)).status, 'REPORTED'); assert.equal(checked, true);
});

test('unconfirmed transmission policy blocks even preparation inspection', async context => {
  const run = await setup(context); run.authorization.enabled = false;
  const service = new CompanyRelayService(run.store(), { ...run.preparation, inspect: () => assert.fail('Unexpected preparation access') },
    run.source, run.factory, run.authorization, () => run.fixture.context.now);
  assert.throws(() => service.plan(run.fixture.id, run.fixture.context), { code: 'COMPANY_RELAY_AUTHORIZATION_UNCONFIRMED' });
  assert.equal(run.counts().factories, 0);
});

test('an abort before claim consumes no approval and creates no relay', async context => {
  const run = await setup(context), { request } = run.approve(), controller = new AbortController(); controller.abort();
  const result = await run.service().run(request, run.fixture.context, controller.signal);
  assert.equal(result.status, 'CANCELLED'); assert.equal(result.approval?.usedAt, null); assert.equal(result.attempt, null);
  assert.equal(run.counts().factories, 0);
});

test('changed account declaration after fake credential access blocks dispatch', async context => {
  const run = await setup(context), { request } = run.approve();
  run.usePort({ mode: 'live', transport: 'codex-cli-relay', transmit: async (dispatch, _signal, before, beforeCredential) => {
    beforeCredential(); run.authorization.accountIdHash = '0'.repeat(64); before(); return respond(dispatch);
  } });
  const result = await run.service().run(request, run.fixture.context);
  assert.equal(result.status, 'FAILED'); assert.equal(result.report, null); assert.equal(result.attempt?.dispatchedAt, null);
  assert.equal(result.attempt?.failureCode, 'COMPANY_RELAY_CONFIG_CHANGED');
});

for (const stage of ['approve', 'run', 'credential', 'transmission', 'result'] as const) {
  test(`company relay rejects source changes at ${stage}`, async context => {
    const run = await setup(context), planned = run.service().plan(run.fixture.id, run.fixture.context);
    const request = { investigationId: planned.plan.id, planHash: planned.plan.planHash };
    const change = () => fs.appendFileSync(join(run.fixture.root, 'src/main.ts'), '// Synthetic mutation.\n');
    if (stage !== 'approve') run.service().approve({ ...request, expiresInMinutes: 10 }, run.fixture.context);
    if (stage === 'approve' || stage === 'run') {
      change();
      if (stage === 'approve') assert.throws(() => run.service().approve({ ...request, expiresInMinutes: 10 }, run.fixture.context),
        { code: 'COMPANY_RELAY_SOURCE_CHANGED' });
      else await assert.rejects(run.service().run(request, run.fixture.context), { code: 'COMPANY_RELAY_SOURCE_CHANGED' });
      assert.equal(run.counts().factories, 0); assert.equal(run.store().inspect(request.investigationId, run.fixture.context).attempt, null);
    } else {
      run.usePort({ mode: 'live', transport: 'codex-cli-relay', transmit: async (dispatch, _signal, before, beforeCredential) => {
        if (stage === 'credential') change(); beforeCredential();
        if (stage === 'transmission') change(); before();
        if (stage === 'result') change(); return respond(dispatch);
      } });
      const result = await run.service().run(request, run.fixture.context);
      assert.equal(result.status, 'FAILED'); assert.equal(result.report, null); assert.ok(result.approval?.usedAt);
      assert.equal(result.attempt?.failureCode, 'COMPANY_RELAY_SOURCE_CHANGED');
      if (stage !== 'result') assert.equal(result.attempt?.dispatchedAt, null);
    }
  });
}

for (const field of ['accountIdHash', 'providerTermsConfirmed', 'enabled', 'config'] as const) {
  test(`company relay rejects changed ${field} before claim without constructing a transport`, async context => {
    const run = await setup(context), { request } = run.approve();
    if (field === 'accountIdHash') run.authorization.accountIdHash = '0'.repeat(64);
    else if (field === 'config') run.authorization.config.codexSha256 = 'b'.repeat(64);
    else run.authorization[field] = false;
    await assert.rejects(run.service().run(request, run.fixture.context), { code: 'COMPANY_RELAY_CONFIG_CHANGED' });
    assert.equal(run.counts().factories, 0); assert.equal(run.store().inspect(request.investigationId, run.fixture.context).attempt, null);
  });
}

for (const behavior of ['skip', 'reverse', 'duplicate-credential', 'duplicate-transmission', 'swallowed-guard'] as const) {
  test(`company relay rejects ${behavior} guard protocol even when a fake port returns valid JSON`, async context => {
    const run = await setup(context), { request } = run.approve();
    run.usePort({ mode: 'live', transport: 'codex-cli-relay', transmit: async (dispatch, _signal, before, beforeCredential) => {
      if (behavior === 'reverse') before();
      else if (behavior === 'duplicate-credential') { beforeCredential(); beforeCredential(); }
      else if (behavior === 'duplicate-transmission') { beforeCredential(); before(); before(); }
      else if (behavior === 'swallowed-guard') { try { before(); } catch { /* Deliberately broken fake. */ } }
      return respond(dispatch);
    } });
    const result = await run.service().run(request, run.fixture.context);
    assert.equal(result.status, 'FAILED'); assert.equal(result.report, null); assert.ok(result.approval?.usedAt);
    assert.equal(result.attempt?.failureCode, 'COMPANY_RELAY_INVALID_TRANSPORT');
  });
}

for (const corruption of ['json', 'evidence', 'final-hash', 'fake-credential-claim'] as const) {
  test(`company relay rejects ${corruption} in a completed fake result`, async context => {
    const run = await setup(context), { request } = run.approve();
    run.usePort({ mode: 'live', transport: 'codex-cli-relay', transmit: async (dispatch, _signal, before, beforeCredential) => {
      beforeCredential(); before(); const response = respond(dispatch);
      if (corruption === 'json') response.text = '{';
      if (corruption === 'evidence') {
        const result = JSON.parse(response.text); result.facts[0].references[0].evidenceId = `evidence-${'0'.repeat(64)}`;
        response.text = canonicalReadonlyJson(result);
      }
      response.finalTextHash = hashReadonlyValue(response.text);
      if (corruption === 'final-hash') response.finalTextHash = '0'.repeat(64);
      if (corruption === 'fake-credential-claim') response.verification.credentialAccess = 'passed';
      return response;
    } });
    const result = await run.service().run(request, run.fixture.context);
    assert.equal(result.status, 'FAILED'); assert.equal(result.report, null); assert.ok(result.approval?.usedAt);
    assert.equal(run.fixture.snapshot(), run.before);
  });
}

test('company preparation cancellation, runtime mismatch and approval expiry prevent relay creation', async context => {
  const run = await setup(context), { request } = run.approve();
  const wrong = new CompanyRelayService(run.store(), { ...run.preparation, runtimeHash: '0'.repeat(64) }, run.source,
    run.factory, run.authorization, () => run.fixture.context.now);
  await assert.rejects(wrong.run(request, run.fixture.context), { code: 'COMPANY_RELAY_PREPARATION_UNAVAILABLE' });
  run.advance(10 * 60_000); await assert.rejects(run.service().run(request, run.fixture.context));
  run.preparations.cancel(run.fixture.id, run.fixture.context); await assert.rejects(run.service().run(request, run.fixture.context));
  assert.equal(run.counts().factories, 0);
});

test('cancellation while readiness waits consumes approval but prevents later native/credential/transmit work', async context => {
  const run = await setup(context), { request } = run.approve(), controller = new AbortController();
  let entered: () => void = () => {}, finish: () => void = () => {}, transmissions = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  run.usePort({ mode: 'live', transport: 'codex-cli-relay', verifyReady: () => { entered(); return new Promise<void>(resolve => { finish = resolve; }); },
    transmit: async dispatch => { transmissions++; return respond(dispatch); } });
  const pending = run.service().run(request, run.fixture.context, controller.signal); await started;
  controller.abort(); finish(); const result = await pending;
  assert.equal(result.status, 'CANCELLED'); assert.ok(result.approval?.usedAt); assert.equal(result.attempt?.dispatchedAt, null);
  assert.equal(result.report, null); assert.equal(transmissions, 0);
});

test('late fake success cannot overwrite cancellation or allow concurrent second dispatch', async context => {
  const run = await setup(context), { request } = run.approve();
  let entered: () => void = () => {}, finish: () => void = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  run.usePort({ mode: 'live', transport: 'codex-cli-relay', transmit: async (dispatch, _signal, before, beforeCredential) => {
    beforeCredential(); before(); entered(); await new Promise<void>(resolve => { finish = resolve; }); return respond(dispatch);
  } });
  const pending = run.service().run(request, run.fixture.context); await started;
  await assert.rejects(run.service().run(request, run.fixture.context)); run.service().cancel(request.investigationId, run.fixture.context); finish();
  const result = await pending; assert.equal(result.status, 'CANCELLED'); assert.equal(result.report, null); assert.equal(result.payload, null);
});

test('timeout with unclosed fake transport is BLOCKED after the unchanged shared cleanup budget', async context => {
  const run = await setup(context), { request, planned } = run.approve();
  let entered: () => void = () => {}; const started = new Promise<void>(resolve => { entered = resolve; });
  run.usePort({ mode: 'live', transport: 'codex-cli-relay', transmit: async (_dispatch, _signal, before, beforeCredential) => {
    beforeCredential(); before(); entered(); return new Promise<ReadonlyRelayTransmissionResult>(() => {});
  } });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = run.service().run(request, run.fixture.context); await started;
    context.mock.timers.tick(planned.plan.executionBudget.workTimeoutMs); await settleMicrotasks();
    context.mock.timers.tick(planned.plan.executionBudget.cleanupTimeoutMs); await settleMicrotasks();
    const result = await pending; assert.equal(result.status, 'BLOCKED'); assert.equal(result.report, null);
    assert.equal(result.attempt?.failureCode, 'COMPANY_RELAY_RECOVERY_UNCERTAIN');
    run.reopen(); assert.equal(run.service().recover(request.investigationId, run.fixture.context).status, 'BLOCKED');
    await assert.rejects(run.service().run(request, run.fixture.context)); assert.equal(run.counts().factories, 1);
  } finally { context.mock.timers.reset(); }
});

test('native cleanup uncertainty remains BLOCKED even if the source changed too', async context => {
  const run = await setup(context), { request } = run.approve();
  run.usePort({ mode: 'live', transport: 'codex-cli-relay', transmit: async (_dispatch, _signal, before, beforeCredential) => {
    beforeCredential(); before(); fs.appendFileSync(join(run.fixture.root, 'src/main.ts'), '// Synthetic change.\n');
    throw new HarnessError('READONLY_RELAY_LIFECYCLE_UNSAFE');
  } });
  const result = await run.service().run(request, run.fixture.context);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.attempt?.failureCode, 'COMPANY_RELAY_RECOVERY_UNCERTAIN');
});

test('disabled company native adapter refuses without loading a binary, credential or starting a child', async context => {
  const run = await setup(context), planned = run.service().plan(run.fixture.id, run.fixture.context), payload = planned.payload!;
  const adapter = new RestrictedCompanyRelayCodex({ ...run.authorization.config, enabled: false }, '/synthetic/unavailable', planned.plan.id,
    run.authorization.accountIdHash);
  await assert.rejects(adapter.verifyReady(), { code: 'READONLY_RELAY_DISABLED' });
  await assert.rejects(adapter.transmit({ requestEnvelope: payload.requestEnvelope, requestEnvelopeHash: payload.requestEnvelopeHash,
    requestBodyHash: payload.requestBodyHash }, new AbortController().signal, () => assert.fail('Unexpected transmission'),
  () => assert.fail('Unexpected credential access')));
  assert.equal(run.counts().factories, 0);
});

test('company IPC permission target is one owned short empty directory, without native execution', async context => {
  const directory = fs.mkdtempSync('/private/tmp/hcri-'); fs.chmodSync(directory, 0o700);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identity = await inspectCompanyCodexIpcDirectory(directory);
  assert.equal(identity.device, fs.lstatSync(directory).dev); assert.equal(identity.inode, fs.lstatSync(directory).ino);
  await assert.rejects(inspectCompanyCodexIpcDirectory('/private/tmp'));
  fs.chmodSync(directory, 0o755); await assert.rejects(inspectCompanyCodexIpcDirectory(directory)); fs.chmodSync(directory, 0o700);
  fs.writeFileSync(join(directory, 'unexpected'), 'synthetic', { mode: 0o600 });
  await assert.rejects(inspectCompanyCodexIpcDirectory(directory)); fs.unlinkSync(join(directory, 'unexpected'));
  const link = `${directory}-link`; fs.symlinkSync(directory, link);
  try { await assert.rejects(inspectCompanyCodexIpcDirectory(link)); } finally { fs.unlinkSync(link); }
  assert.deepEqual(await inspectCompanyCodexIpcDirectory(directory), identity);
});

test('company broker rejects a different fake account before dispatch and upstream access', async context => {
  const run = await setup(context), planned = run.service().plan(run.fixture.id, run.fixture.context), payload = planned.payload!;
  const dispatch = { requestEnvelope: payload.requestEnvelope, requestEnvelopeHash: payload.requestEnvelopeHash, requestBodyHash: payload.requestBodyHash };
  const order: string[] = [];
  const broker = await startReadonlyRelayBroker(run.authorization.config, dispatch, async () => {
    order.push('fake-credential'); return { kind: 'chatgpt', accessToken: 'synthetic.test.only', accountId: 'synthetic-other-account' };
  }, new AbortController().signal, async () => { order.push('upstream'); return new Response('unused'); },
  () => { order.push('dispatch'); }, () => { order.push('credential-guard'); }, assertCompanyRelayDispatch,
  credential => { order.push('account-check'); assertCompanyRelayAccount(credential.accountId, run.authorization.accountIdHash); });
  try {
    const response = await fetch(`http://127.0.0.1:${broker.port}/v1/responses`, { method: 'POST',
      headers: { Authorization: `Bearer ${broker.capability}` }, body: JSON.stringify({ model: run.authorization.config.model, stream: true }) });
    assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /synthetic-other-account|synthetic\.test\.only/u);
    assert.deepEqual(order, ['credential-guard', 'fake-credential', 'account-check']); assert.equal(broker.calls(), 0);
  } finally { await broker.close(); }
});
