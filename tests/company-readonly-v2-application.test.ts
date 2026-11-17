import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CompanyReadonlyPreparationServiceV2 } from '../src/application/prepare-company-readonly-v2.js';
import { SqliteCompanyReadonlyV2Store } from '../src/adapters/sqlite-company-readonly-v2-store.js';
import type { CompanyReadonlySourceV2, CompanyReadonlyStoreV2 } from '../src/domain/company-readonly-v2.js';
import { HarnessError } from '../src/domain/errors.js';
import { createCompanyReadonlyV2Fixture } from './company-readonly-v2-fixture.js';

const rejectingStore = () => {
  let calls = 0;
  const reject = (): never => { calls++; throw new Error('UNEXPECTED_STORE_ACCESS'); };
  const store: CompanyReadonlyStoreV2 = { create: reject, inspect: reject, cancel: reject, prune: reject, close: reject };
  return { store, calls: () => calls };
};

test('unconfirmed company policy blocks registration access, source opening and every storage operation', async context => {
  const fixture = await createCompanyReadonlyV2Fixture(context), persistence = rejectingStore();
  let sourceCalls = 0, registrationReads = 0;
  const source: CompanyReadonlySourceV2 = { open: () => { sourceCalls++; throw new Error('UNEXPECTED_SOURCE_ACCESS'); } };
  const service = new CompanyReadonlyPreparationServiceV2(persistence.store, source);
  const registration = Object.defineProperty({}, 'version', { enumerable: true, get: () => { registrationReads++; return 'company-readonly-registration-v2'; } });
  for (const policy of [{ ...fixture.policy, readPermission: 'unconfirmed' }, { ...fixture.policy, storagePermission: 'unconfirmed' },
    { ...fixture.policy, policyReference: null }, { ...fixture.policy, payloadRetentionHours: null }, { ...fixture.policy, auditRetentionDays: null }]) {
    assert.throws(() => service.prepare(registration, policy, fixture.context, fixture.id), { code: 'COMPANY_READONLY_POLICY_UNCONFIRMED' });
  }
  assert.equal(sourceCalls, 0); assert.equal(persistence.calls(), 0); assert.equal(registrationReads, 0);
});

test('invalid IDs and registration profiles stop before source or storage capabilities are invoked', async context => {
  const fixture = await createCompanyReadonlyV2Fixture(context), persistence = rejectingStore(); let opened = 0;
  const source: CompanyReadonlySourceV2 = { open: () => { opened++; throw new Error('UNEXPECTED_SOURCE_ACCESS'); } };
  const service = new CompanyReadonlyPreparationServiceV2(persistence.store, source);
  assert.throws(() => service.prepare(fixture.registration, fixture.policy, fixture.context, 'invalid-id'),
    { code: 'COMPANY_READONLY_V2_INVALID_ID' });
  assert.throws(() => service.prepare({ ...fixture.registration, gitProfileHash: '0'.repeat(64) }, fixture.policy, fixture.context, fixture.id));
  assert.equal(opened, 0); assert.equal(persistence.calls(), 0);
});

test('a source change during final verification closes the real session once and stores no preparation', async context => {
  const fixture = await createCompanyReadonlyV2Fixture(context), persistence = rejectingStore(); let closed = 0;
  const source: CompanyReadonlySourceV2 = { open: registration => {
    const session = fixture.source.open(registration);
    return { inspect: session.inspect, verify: () => {
      fs.appendFileSync(join(fixture.root, 'src/main.ts'), '// Synthetic mutation between content passes.\n');
      return session.verify();
    }, close: () => { closed++; session.close(); } };
  } };
  const service = new CompanyReadonlyPreparationServiceV2(persistence.store, source);
  assert.throws(() => service.prepare(fixture.registration, fixture.policy, fixture.context, fixture.id),
    { code: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' });
  assert.equal(closed, 1); assert.equal(persistence.calls(), 0);
});

test('mismatched inspect and verify proof identities are rejected before a store write', async context => {
  const fixture = await createCompanyReadonlyV2Fixture(context), prepared = fixture.prepareInput(), persistence = rejectingStore(); let closed = 0;
  const source: CompanyReadonlySourceV2 = { open: () => ({
    inspect: () => ({ observation: prepared.observation, collected: prepared.collected }),
    verify: () => ({ observation: { ...prepared.observation, proofHash: '0'.repeat(64) }, budget: prepared.budget }),
    close: () => { closed++; },
  }) };
  const service = new CompanyReadonlyPreparationServiceV2(persistence.store, source);
  assert.throws(() => service.prepare(fixture.registration, fixture.policy, fixture.context, fixture.id),
    { code: 'COMPANY_READONLY_V2_SOURCE_CHANGED' });
  assert.equal(closed, 1); assert.equal(persistence.calls(), 0);
});

test('a cleanup failure after successful verification prevents persistence', async context => {
  const fixture = await createCompanyReadonlyV2Fixture(context), persistence = rejectingStore(); let closed = 0;
  const source: CompanyReadonlySourceV2 = { open: registration => {
    const session = fixture.source.open(registration);
    return { inspect: session.inspect, verify: session.verify, close: () => {
      closed++; session.close(); throw new HarnessError('COMPANY_READONLY_V2_CLEANUP_FAILED');
    } };
  } };
  const service = new CompanyReadonlyPreparationServiceV2(persistence.store, source);
  assert.throws(() => service.prepare(fixture.registration, fixture.policy, fixture.context, fixture.id),
    { code: 'COMPANY_READONLY_V2_CLEANUP_FAILED' });
  assert.equal(closed, 1); assert.equal(persistence.calls(), 0);
});

test('real preparation persists AWAITING_APPROVAL and later inspect/cancel/prune never reopen the source', async context => {
  const fixture = await createCompanyReadonlyV2Fixture(context), before = fixture.snapshot();
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v2-application-'))); fs.chmodSync(directory, 0o700);
  const store = new SqliteCompanyReadonlyV2Store(join(directory, 'company-readonly-v2.sqlite')); let opened = 0, closed = 0;
  const source: CompanyReadonlySourceV2 = { open: registration => {
    opened++; const session = fixture.source.open(registration);
    return { inspect: session.inspect, verify: session.verify, close: () => { closed++; session.close(); } };
  } };
  const service = new CompanyReadonlyPreparationServiceV2(store, source);
  try {
    const prepared = service.prepare(fixture.registration, fixture.policy, fixture.context, fixture.id);
    assert.equal(prepared.status, 'AWAITING_APPROVAL'); assert.equal(prepared.plan.id, fixture.id);
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
