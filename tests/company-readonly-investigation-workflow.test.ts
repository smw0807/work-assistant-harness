import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CompanyInvestigationService } from '../src/application/investigate-company.js';
import { CompanyReadonlyPreparationServiceV3 } from '../src/application/prepare-company-readonly-v3.js';
import { FixedCompanyInvestigationModel } from '../src/adapters/company-investigation-model.js';
import { CompanyInvestigationSourceAdapter } from '../src/adapters/company-investigation-source.js';
import { SqliteCompanyInvestigationStore } from '../src/adapters/sqlite-company-investigation-store.js';
import { SqliteCompanyReadonlyV3Store } from '../src/adapters/sqlite-company-readonly-v3-store.js';
import type { CompanyInvestigationModelPort } from '../src/domain/company-investigation.js';
import { HarnessError } from '../src/domain/errors.js';
import { hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { createCompanyReadonlyV3Fixture } from './company-readonly-v3-fixture.js';

const setup = async (context: TestContext) => {
  const fixture = await createCompanyReadonlyV3Fixture(context), before = fixture.snapshot();
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-investigation-workflow-')));
  fs.chmodSync(directory, 0o700);
  const prepDirectory = join(directory, 'preparation'), investigationDirectory = join(directory, 'investigation');
  fs.mkdirSync(prepDirectory, { mode: 0o700 }); fs.mkdirSync(investigationDirectory, { mode: 0o700 });
  const preparations = new SqliteCompanyReadonlyV3Store(join(prepDirectory, 'company-readonly-v3.sqlite'));
  new CompanyReadonlyPreparationServiceV3(preparations, fixture.source).prepare(fixture.registration, fixture.policy, fixture.context, fixture.id);
  const file = join(investigationDirectory, 'company-investigation.sqlite');
  let store = new SqliteCompanyInvestigationStore(file), now = fixture.context.now.getTime(), calls = 0;
  const fixed = new FixedCompanyInvestigationModel();
  let implementation: CompanyInvestigationModelPort = fixed;
  const model: CompanyInvestigationModelPort = { mode: 'mock', investigate: (text, signal) => { calls++; return implementation.investigate(text, signal); } };
  const source = new CompanyInvestigationSourceAdapter();
  const preparation = { runtimeHash: hashReadonlyValue(prepDirectory), inspect: preparations.inspect.bind(preparations) };
  const service = () => new CompanyInvestigationService(store, preparation, source, model, () => new Date(now));
  context.after(() => { store.close(); preparations.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const approve = () => {
    const planned = service().plan(fixture.id, fixture.context);
    const request = { investigationId: planned.plan.id, planHash: planned.plan.planHash };
    service().approve({ ...request, expiresInMinutes: 10 }, fixture.context);
    return { planned, request };
  };
  return { fixture, before, preparations, preparation, source, model, fixed, file, service, approve, store: () => store,
    calls: () => calls, useModel: (value: CompanyInvestigationModelPort) => { implementation = value; },
    advance: (milliseconds: number) => { now += milliseconds; },
    reopen: () => { store.close(); store = new SqliteCompanyInvestigationStore(file); },
  };
};
const settleMicrotasks = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('company mock approval consumes once, persists validated evidence report and preserves the synthetic source', async context => {
  const run = await setup(context), { planned, request } = run.approve();
  run.useModel({ mode: 'mock', investigate: async (text, signal) => {
    const reserved = run.store().inspect(request.investigationId, run.fixture.context);
    assert.equal(reserved.status, 'RUNNING'); assert.ok(reserved.approval?.usedAt); assert.ok(reserved.attempt?.dispatchedAt);
    return run.fixed.investigate(text, signal);
  } });
  const result = await run.service().run(request, run.fixture.context);
  assert.equal(result.status, 'REPORTED'); assert.equal(run.calls(), 1); assert.ok(result.report);
  assert.equal(result.report.mode, 'mock'); assert.equal(result.report.result.classification, 'insufficient-evidence');
  assert.equal(result.report.realModel, 'not_run'); assert.equal(result.report.nativeExecution, 'not_run');
  assert.equal(result.report.externalTransmission, 'not_run'); assert.equal(result.report.semanticAccuracyVerified, false);
  assert.equal(result.plan.expiresAt, planned.plan.preparation.expiresAt);
  assert.equal(result.plan.auditExpiresAt, planned.plan.preparation.auditExpiresAt);
  assert.equal(run.fixture.snapshot(), run.before);
  run.reopen();
  assert.deepEqual(run.service().inspect(request.investigationId, run.fixture.context), result);
  await assert.rejects(run.service().run(request, run.fixture.context));
  assert.equal(run.calls(), 1);
});

test('company preparation pending state never serves as investigation approval', async context => {
  const run = await setup(context), pending = run.service().plan(run.fixture.id, run.fixture.context);
  const request = { investigationId: pending.plan.id, planHash: pending.plan.planHash };
  await assert.rejects(run.service().run(request, run.fixture.context), { code: 'COMPANY_INVESTIGATION_APPROVAL_REQUIRED' });
  assert.equal(run.calls(), 0); assert.equal(run.service().inspect(request.investigationId, run.fixture.context).attempt, null);
  assert.throws(() => run.service().approve({ ...request, planHash: '0'.repeat(64), expiresInMinutes: 10 }, run.fixture.context),
    { code: 'COMPANY_INVESTIGATION_PLAN_MISMATCH' });
  assert.equal(run.service().inspect(request.investigationId, run.fixture.context).approval, null);
});

for (const stage of ['approve', 'run'] as const) {
  test(`company source mutation before ${stage} blocks the action without a model invocation`, async context => {
    const run = await setup(context), planned = run.service().plan(run.fixture.id, run.fixture.context);
    const request = { investigationId: planned.plan.id, planHash: planned.plan.planHash };
    if (stage === 'run') run.service().approve({ ...request, expiresInMinutes: 10 }, run.fixture.context);
    fs.appendFileSync(join(run.fixture.root, 'src/main.ts'), '// Synthetic mutation.\n');
    if (stage === 'approve') assert.throws(() => run.service().approve({ ...request, expiresInMinutes: 10 }, run.fixture.context),
      { code: 'COMPANY_INVESTIGATION_SOURCE_CHANGED' });
    else await assert.rejects(run.service().run(request, run.fixture.context), { code: 'COMPANY_INVESTIGATION_SOURCE_CHANGED' });
    assert.equal(run.calls(), 0); assert.equal(run.service().inspect(request.investigationId, run.fixture.context).attempt, null);
  });
}

test('mutation during a mock invocation discards the result and permanently consumes the attempt', async context => {
  const run = await setup(context), { request } = run.approve();
  run.useModel({ mode: 'mock', investigate: async (text, signal) => {
    fs.appendFileSync(join(run.fixture.root, 'src/main.ts'), '// Synthetic mutation during mock operation.\n');
    return run.fixed.investigate(text, signal);
  } });
  const result = await run.service().run(request, run.fixture.context);
  assert.equal(result.status, 'FAILED'); assert.equal(result.report, null);
  assert.equal(result.attempt?.failureCode, 'COMPANY_INVESTIGATION_SOURCE_CHANGED');
  assert.ok(result.approval?.usedAt); assert.equal(run.calls(), 1);
  await assert.rejects(run.service().run(request, run.fixture.context)); assert.equal(run.calls(), 1);
});

test('a source change before the invocation microtask prevents even the single dispatch reservation', async context => {
  const run = await setup(context), { request } = run.approve();
  const pending = run.service().run(request, run.fixture.context);
  fs.appendFileSync(join(run.fixture.root, 'src/main.ts'), '// Synthetic mutation before invocation.\n');
  const result = await pending;
  assert.equal(result.status, 'FAILED'); assert.equal(result.report, null); assert.ok(result.approval?.usedAt);
  assert.equal(result.attempt?.dispatchedAt, null); assert.equal(run.calls(), 0);
});

test('preparation cancellation and runtime substitution cannot be hidden by a copied payload', async context => {
  const run = await setup(context), { request } = run.approve();
  const wrongRuntime = new CompanyInvestigationService(run.store(), { ...run.preparation, runtimeHash: '0'.repeat(64) },
    run.source, run.model, () => run.fixture.context.now);
  await assert.rejects(wrongRuntime.run(request, run.fixture.context), { code: 'COMPANY_INVESTIGATION_PREPARATION_UNAVAILABLE' });
  run.preparations.cancel(run.fixture.id, run.fixture.context);
  await assert.rejects(run.service().run(request, run.fixture.context), { code: 'COMPANY_INVESTIGATION_SOURCE_CHANGED' });
  assert.equal(run.calls(), 0);
});

test('cancellation of preparation during mock work invalidates its otherwise valid report', async context => {
  const run = await setup(context), { request } = run.approve();
  run.useModel({ mode: 'mock', investigate: async (text, signal) => {
    run.preparations.cancel(run.fixture.id, run.fixture.context); return run.fixed.investigate(text, signal);
  } });
  const result = await run.service().run(request, run.fixture.context);
  assert.equal(result.status, 'FAILED'); assert.equal(result.report, null);
  assert.equal(result.attempt?.failureCode, 'COMPANY_INVESTIGATION_SOURCE_CHANGED');
});

for (const malformed of ['json', 'reference', 'extra-command', 'duplicate-key'] as const) {
  test(`company mock result rejects ${malformed} and never stores an invalid report`, async context => {
    const run = await setup(context), { request } = run.approve();
    run.useModel({ mode: 'mock', investigate: async (text, signal) => {
      if (malformed === 'json') return '{';
      const raw = await run.fixed.investigate(text, signal);
      if (malformed === 'duplicate-key') return raw.replace('{', '{"summary":"Injected duplicate",');
      const result = JSON.parse(raw);
      if (malformed === 'reference') result.facts[0].references[0].evidenceId = `evidence-${'0'.repeat(64)}`;
      else result.commands = ['run an arbitrary command'];
      return JSON.stringify(result);
    } });
    const result = await run.service().run(request, run.fixture.context);
    assert.equal(result.status, 'FAILED'); assert.equal(result.report, null); assert.equal(run.calls(), 1);
    assert.equal(result.attempt?.failureCode, 'COMPANY_INVESTIGATION_INVALID_RESPONSE');
    assert.equal(run.fixture.snapshot(), run.before);
  });
}

test('expired approval and payload cannot call the model or be renewed by another plan request', async context => {
  const run = await setup(context), { request } = run.approve();
  run.advance(10 * 60_000);
  await assert.rejects(run.service().run(request, run.fixture.context)); assert.equal(run.calls(), 0);
  run.advance(50 * 60_000);
  assert.throws(() => run.service().plan(run.fixture.id, run.fixture.context));
  assert.equal(run.service().inspect(request.investigationId, run.fixture.context).payload, null);
});

test('expiry during mock work discards the response and keeps the consumed approval', async context => {
  const run = await setup(context), { request } = run.approve();
  run.useModel({ mode: 'mock', investigate: async (text, signal) => {
    run.advance(10 * 60_000); return run.fixed.investigate(text, signal);
  } });
  const result = await run.service().run(request, run.fixture.context);
  assert.equal(result.status, 'EXPIRED'); assert.equal(result.report, null); assert.ok(result.approval?.usedAt);
  assert.equal(run.calls(), 1);
});

test('concurrent second run and cancellation cannot turn a late fixed response into a report', async context => {
  const run = await setup(context), { request } = run.approve();
  let started: () => void = () => {}, resolve: (value: string) => void = () => {}, response = '';
  const entered = new Promise<void>(ready => { started = ready; });
  run.useModel({ mode: 'mock', investigate: async (text, signal) => {
    response = await run.fixed.investigate(text, signal); started(); return new Promise<string>(ready => { resolve = ready; });
  } });
  const pending = run.service().run(request, run.fixture.context); await entered;
  await assert.rejects(run.service().run(request, run.fixture.context));
  run.service().cancel(request.investigationId, run.fixture.context); resolve(response);
  const result = await pending;
  assert.equal(result.status, 'CANCELLED'); assert.equal(result.payload, null); assert.equal(result.report, null); assert.equal(run.calls(), 1);
});

test('abort before invocation consumes nothing', async context => {
  const run = await setup(context), { request } = run.approve(), aborted = new AbortController();
  aborted.abort();
  const cancelled = await run.service().run(request, run.fixture.context, aborted.signal);
  assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.attempt, null); assert.equal(run.calls(), 0);
});

test('cancellation observed during pre-claim source verification does not consume approval', async context => {
  const run = await setup(context), { request } = run.approve(), controller = new AbortController();
  const service = new CompanyInvestigationService(run.store(), run.preparation, {
    verify: payload => { run.source.verify(payload); controller.abort(); },
  }, run.model, () => run.fixture.context.now);
  const result = await service.run(request, run.fixture.context, controller.signal);
  assert.equal(result.status, 'CANCELLED'); assert.equal(result.attempt, null); assert.equal(result.approval?.usedAt, null);
  assert.equal(run.calls(), 0);
});

test('abort during mock work waits for its settled response but never publishes it', async context => {
  const run = await setup(context), { request } = run.approve(), controller = new AbortController();
  let started: () => void = () => {};
  const entered = new Promise<void>(ready => { started = ready; });
  run.useModel({ mode: 'mock', investigate: async (text, signal) => {
    const response = await run.fixed.investigate(text, signal);
    return new Promise<string>(resolve => {
      signal.addEventListener('abort', () => resolve(response), { once: true }); started();
    });
  } });
  const pending = run.service().run(request, run.fixture.context, controller.signal);
  await entered; controller.abort();
  const result = await pending;
  assert.equal(result.status, 'CANCELLED'); assert.equal(result.report, null); assert.ok(result.approval?.usedAt);
  assert.equal(run.calls(), 1);
});

test('uncertain cleanup after timeout blocks recovery without another invocation', async context => {
  const run = await setup(context), { request, planned } = run.approve();
  let started: () => void = () => {};
  const entered = new Promise<void>(ready => { started = ready; });
  run.useModel({ mode: 'mock', investigate: async () => { started(); return new Promise<string>(() => {}); } });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = run.service().run(request, run.fixture.context); await entered;
    context.mock.timers.tick(planned.plan.executionBudget.workTimeoutMs); await settleMicrotasks();
    context.mock.timers.tick(planned.plan.executionBudget.cleanupTimeoutMs); await settleMicrotasks();
    const result = await pending;
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.report, null);
    assert.equal(result.attempt?.failureCode, 'COMPANY_INVESTIGATION_RECOVERY_UNCERTAIN');
    assert.equal(run.calls(), 1);
    run.reopen();
    const recovered = run.service().recover(request.investigationId, run.fixture.context);
    assert.equal(recovered.status, 'BLOCKED');
    await assert.rejects(run.service().run(request, run.fixture.context)); assert.equal(run.calls(), 1);
  } finally { context.mock.timers.reset(); }
});

test('restart recovery of a claimed attempt records uncertainty and does not restore approval', async context => {
  const run = await setup(context), { request } = run.approve();
  const claimed = run.store().claim(request, run.fixture.context);
  assert.ok(claimed.attempt); run.reopen();
  const recovered = run.service().recover(request.investigationId, run.fixture.context);
  assert.equal(recovered.status, 'BLOCKED'); assert.ok(recovered.approval?.usedAt); assert.equal(recovered.report, null);
  await assert.rejects(run.service().run(request, run.fixture.context)); assert.equal(run.calls(), 0);
});

test('live model mode is rejected before claiming an otherwise valid local approval', async context => {
  const run = await setup(context), { request } = run.approve();
  const mode = { mode: 'live', investigate: async () => { throw new Error('UNEXPECTED_MODEL_ACCESS'); } } as unknown as CompanyInvestigationModelPort;
  const service = new CompanyInvestigationService(run.store(), run.preparation, run.source, mode, () => run.fixture.context.now);
  await assert.rejects(service.run(request, run.fixture.context), { code: 'COMPANY_INVESTIGATION_MODEL_NOT_ALLOWED' });
  assert.equal(run.store().inspect(request.investigationId, run.fixture.context).attempt, null);
});

test('source descriptor cleanup failure blocks new investigation creation', async context => {
  const run = await setup(context);
  const source = new CompanyInvestigationSourceAdapter({ open: registration => {
    const session = run.fixture.source.open(registration);
    return { inspect: session.inspect, verify: session.verify, close: () => {
      session.close(); throw new HarnessError('SYNTHETIC_CLEANUP_FAILURE');
    } };
  } });
  const service = new CompanyInvestigationService(run.store(), run.preparation, source, run.model, () => run.fixture.context.now);
  assert.throws(() => service.plan(run.fixture.id, run.fixture.context), { code: 'COMPANY_INVESTIGATION_SOURCE_CHANGED' });
  assert.equal(run.calls(), 0);
});
