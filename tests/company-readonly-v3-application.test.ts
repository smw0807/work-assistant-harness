import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CompanyReadonlyPreparationServiceV3 } from '../src/application/prepare-company-readonly-v3.js';
import { SqliteCompanyReadonlyV3Store } from '../src/adapters/sqlite-company-readonly-v3-store.js';
import type { CompanyReadonlySourceV3, CompanyReadonlyStoreV3 } from '../src/domain/company-readonly-v3.js';
import { HarnessError } from '../src/domain/errors.js';
import { CompanyGitRangeUnitBudget, extractCompanyGitRangeUnitFailure, getCompanyGitRangeUnitGuardPolicyHash,
  getCompanyGitRangeUnitProfile } from '../src/policy/company-git-range-unit-budget.js';
import { createCompanyReadonlyV2Fixture } from './company-readonly-v2-fixture.js';
import { createCompanyReadonlyV3Fixture } from './company-readonly-v3-fixture.js';

const rejectingStore = () => {
  let calls = 0;
  const reject = (): never => { calls++; throw new Error('UNEXPECTED_STORE_ACCESS'); };
  const store: CompanyReadonlyStoreV3 = { create: reject, inspect: reject, cancel: reject, prune: reject, close: reject };
  return { store, calls: () => calls };
};

test('unconfirmed company policy blocks registration access, source opening and every storage operation', async context => {
  const fixture = await createCompanyReadonlyV3Fixture(context), persistence = rejectingStore();
  let sourceCalls = 0, registrationReads = 0;
  const source: CompanyReadonlySourceV3 = { open: () => { sourceCalls++; throw new Error('UNEXPECTED_SOURCE_ACCESS'); } };
  const service = new CompanyReadonlyPreparationServiceV3(persistence.store, source);
  const registration = Object.defineProperty({}, 'version', { enumerable: true, get: () => { registrationReads++; return 'company-readonly-registration-v3'; } });
  for (const policy of [{ ...fixture.policy, readPermission: 'unconfirmed' }, { ...fixture.policy, storagePermission: 'unconfirmed' },
    { ...fixture.policy, policyReference: null }, { ...fixture.policy, payloadRetentionHours: null }, { ...fixture.policy, auditRetentionDays: null }]) {
    assert.throws(() => service.prepare(registration, policy, fixture.context, fixture.id), { code: 'COMPANY_READONLY_POLICY_UNCONFIRMED' });
  }
  assert.equal(sourceCalls, 0); assert.equal(persistence.calls(), 0); assert.equal(registrationReads, 0);
});

test('invalid IDs and registration profiles stop before source or storage capabilities are invoked', async context => {
  const fixture = await createCompanyReadonlyV3Fixture(context), persistence = rejectingStore(); let opened = 0;
  const source: CompanyReadonlySourceV3 = { open: () => { opened++; throw new Error('UNEXPECTED_SOURCE_ACCESS'); } };
  const service = new CompanyReadonlyPreparationServiceV3(persistence.store, source);
  assert.throws(() => service.prepare(fixture.registration, fixture.policy, fixture.context, 'invalid-id'),
    { code: 'COMPANY_READONLY_V3_INVALID_ID' });
  assert.throws(() => service.prepare({ ...fixture.registration, gitProfileHash: '0'.repeat(64) }, fixture.policy, fixture.context, fixture.id));
  assert.equal(opened, 0); assert.equal(persistence.calls(), 0);
});

test('actual v2 registrations, legacy profiles and missing or altered guard policies cannot invoke v3 source or storage', async context => {
  const fixture = await createCompanyReadonlyV3Fixture(context), legacy = await createCompanyReadonlyV2Fixture(context);
  const persistence = rejectingStore(); let opened = 0;
  const service = new CompanyReadonlyPreparationServiceV3(persistence.store, {
    open: () => { opened++; throw new Error('UNEXPECTED_SOURCE_ACCESS'); },
  });
  const missingGuard = Object.fromEntries(Object.entries(fixture.registration).filter(([key]) => key !== 'guardPolicyHash'));
  for (const registration of [legacy.registration, { ...legacy.registration, version: 'company-readonly-registration-v3',
    guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash() }, missingGuard, { ...fixture.registration, guardPolicyHash: '0'.repeat(64) }]) {
    assert.throws(() => service.prepare(registration, fixture.policy, fixture.context, fixture.id), { code: 'COMPANY_READONLY_V3_INVALID_REGISTRATION' });
  }
  assert.equal(opened, 0); assert.equal(persistence.calls(), 0);
});

test('a source change during final verification closes the real session once and stores no preparation', async context => {
  const fixture = await createCompanyReadonlyV3Fixture(context), persistence = rejectingStore(); let closed = 0;
  const source: CompanyReadonlySourceV3 = { open: registration => {
    const session = fixture.source.open(registration);
    return { inspect: session.inspect, verify: () => {
      fs.appendFileSync(join(fixture.root, 'src/main.ts'), '// Synthetic mutation between content passes.\n');
      return session.verify();
    }, close: () => { closed++; session.close(); } };
  } };
  const service = new CompanyReadonlyPreparationServiceV3(persistence.store, source);
  assert.throws(() => service.prepare(fixture.registration, fixture.policy, fixture.context, fixture.id),
    { code: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' });
  assert.equal(closed, 1); assert.equal(persistence.calls(), 0);
});

test('mismatched inspect and verify proof identities are rejected before a store write', async context => {
  const fixture = await createCompanyReadonlyV3Fixture(context), prepared = fixture.prepareInput(), persistence = rejectingStore(); let closed = 0;
  const source: CompanyReadonlySourceV3 = { open: () => ({
    inspect: () => ({ observation: prepared.observation, collected: prepared.collected }),
    verify: () => ({ observation: { ...prepared.observation, proofHash: '0'.repeat(64) }, budget: prepared.budget }),
    close: () => { closed++; },
  }) };
  const service = new CompanyReadonlyPreparationServiceV3(persistence.store, source);
  assert.throws(() => service.prepare(fixture.registration, fixture.policy, fixture.context, fixture.id),
    { code: 'COMPANY_READONLY_V3_SOURCE_CHANGED' });
  assert.equal(closed, 1); assert.equal(persistence.calls(), 0);
});

test('a cleanup failure after successful verification prevents persistence', async context => {
  const fixture = await createCompanyReadonlyV3Fixture(context), persistence = rejectingStore(); let closed = 0;
  const source: CompanyReadonlySourceV3 = { open: registration => {
    const session = fixture.source.open(registration);
    return { inspect: session.inspect, verify: session.verify, close: () => {
      closed++; session.close(); throw new HarnessError('COMPANY_READONLY_V3_CLEANUP_FAILED');
    } };
  } };
  const service = new CompanyReadonlyPreparationServiceV3(persistence.store, source);
  assert.throws(() => service.prepare(fixture.registration, fixture.policy, fixture.context, fixture.id),
    { code: 'COMPANY_READONLY_V3_CLEANUP_FAILED' });
  assert.equal(closed, 1); assert.equal(persistence.calls(), 0);
});

test('inspect or final verification failures keep their first diagnostic when source cleanup also fails', async context => {
  const fixture = await createCompanyReadonlyV3Fixture(context), prepared = fixture.prepareInput();
  for (const phase of ['inspect', 'verify'] as const) {
    const persistence = rejectingStore(), budget = new CompanyGitRangeUnitBudget(0);
    budget.beginPass('inspect', 0);
    if (phase === 'verify') { budget.endPass(0); budget.beginPass('verify', 0); }
    budget.setStage('final_guard');
    let primary: unknown;
    const maximum = getCompanyGitRangeUnitProfile().limits.metadataCalls;
    try { budget.failLimit('metadataCalls', maximum, 1, maximum); } catch (error) { primary = error; }
    const diagnostic = extractCompanyGitRangeUnitFailure(primary); assert.ok(diagnostic);
    let closes = 0;
    const source: CompanyReadonlySourceV3 = { open: () => ({
      inspect: () => {
        if (phase === 'inspect') throw primary;
        return { observation: prepared.observation, collected: prepared.collected };
      },
      verify: () => { throw primary; },
      close: () => { closes++; throw new HarnessError('COMPANY_READONLY_V3_CLEANUP_FAILED'); },
    }) };
    const service = new CompanyReadonlyPreparationServiceV3(persistence.store, source);
    assert.throws(() => service.prepare(fixture.registration, fixture.policy, fixture.context, fixture.id), error => {
      assert.equal(error, primary); assert.deepEqual(extractCompanyGitRangeUnitFailure(error), diagnostic); return true;
    });
    assert.equal(closes, 1); assert.equal(persistence.calls(), 0);
  }
});

test('real preparation persists AWAITING_APPROVAL and later inspect/cancel/prune never reopen the source', async context => {
  const fixture = await createCompanyReadonlyV3Fixture(context), before = fixture.snapshot();
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v3-application-'))); fs.chmodSync(directory, 0o700);
  const store = new SqliteCompanyReadonlyV3Store(join(directory, 'company-readonly-v3.sqlite')); let opened = 0, closed = 0;
  const source: CompanyReadonlySourceV3 = { open: registration => {
    opened++; const session = fixture.source.open(registration);
    return { inspect: session.inspect, verify: session.verify, close: () => { closed++; session.close(); } };
  } };
  const service = new CompanyReadonlyPreparationServiceV3(store, source);
  try {
    const prepared = service.prepare(fixture.registration, fixture.policy, fixture.context, fixture.id);
    assert.equal(prepared.status, 'AWAITING_APPROVAL'); assert.equal(prepared.plan.id, fixture.id);
    assert.equal(prepared.plan.guardPolicyHash, getCompanyGitRangeUnitGuardPolicyHash());
    assert.deepEqual([prepared.approvalCreated, prepared.transmissionAllowed, prepared.executionAllowed, prepared.companyPolicyVerified],
      [false, false, false, false]);
    assert.equal(prepared.payload!.budget.phase, 'complete'); assert.equal(prepared.payload!.budget.completedPasses, 2);
    assert.equal(prepared.payload!.budget.openDescriptors, 0); assert.equal(prepared.payload!.budget.liveMemoryBytes, 0);
    assert.equal(prepared.payload!.collected.evidence.length, fixture.registration.readRanges.length);
    assert.deepEqual(service.inspect(fixture.id, fixture.context), prepared);
    const cancelled = service.cancel(fixture.id, { ...fixture.context, now: new Date(fixture.context.now.getTime() + 1000) });
    assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.payload, null);
    assert.equal(cancelled.plan.planHash, prepared.plan.planHash);
    assert.deepEqual(service.prune({ ...fixture.context, now: new Date(prepared.plan.auditExpiresAt) }), { payloadsRemoved: 0, recordsRemoved: 1 });
    assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(fixture.snapshot(), before);
    for (const name of ['approve', 'run', 'dispatch', 'transmit']) assert.equal(name in service, false);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a lost reply after a v3 store commit is recovered by the same ID without another source read or automatic prepare', async context => {
  const fixture = await createCompanyReadonlyV3Fixture(context), before = fixture.snapshot();
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v3-recovery-'))); fs.chmodSync(directory, 0o700);
  const file = join(directory, 'company-readonly-v3.sqlite'), store = new SqliteCompanyReadonlyV3Store(file);
  let recovered: SqliteCompanyReadonlyV3Store | undefined, opens = 0, closes = 0, creates = 0;
  const lostReply = new HarnessError('COMPANY_READONLY_V3_RESULT_LOST');
  const transport: CompanyReadonlyStoreV3 = {
    create: (plan, payload, context) => { creates++; store.create(plan, payload, context); throw lostReply; },
    inspect: (id, context) => store.inspect(id, context), cancel: (id, context) => store.cancel(id, context),
    prune: context => store.prune(context), close: () => store.close(),
  };
  const source: CompanyReadonlySourceV3 = { open: registration => {
    opens++; const session = fixture.source.open(registration);
    return { inspect: session.inspect, verify: session.verify, close: () => { closes++; session.close(); } };
  } };
  try {
    const service = new CompanyReadonlyPreparationServiceV3(transport, source);
    assert.throws(() => service.prepare(fixture.registration, fixture.policy, fixture.context, fixture.id), error => error === lostReply);
    store.close(); recovered = new SqliteCompanyReadonlyV3Store(file);
    const recovery = new CompanyReadonlyPreparationServiceV3(recovered, { open: () => { throw new Error('UNEXPECTED_SOURCE_RETRY'); } });
    const found = recovery.inspect(fixture.id, fixture.context);
    assert.equal(found.plan.id, fixture.id); assert.equal(found.status, 'AWAITING_APPROVAL'); assert.ok(found.payload);
    assert.deepEqual([found.approvalCreated, found.transmissionAllowed, found.executionAllowed, found.companyPolicyVerified], [false, false, false, false]);
    assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(creates, 1); assert.equal(fixture.snapshot(), before);
  } finally { recovered?.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
