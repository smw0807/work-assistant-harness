import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanyReadonlyPreparationService } from '../src/application/prepare-company-readonly.js';
import { HarnessError } from '../src/domain/errors.js';
import type { CompanyReadonlySourcePort, CompanyReadonlyStore } from '../src/ports/company-readonly.js';
import { companyReadonlyFixture } from './company-readonly-fixture.js';

const setup = () => {
  const fixture = companyReadonlyFixture();
  const calls: string[] = [];
  const source: CompanyReadonlySourcePort = {
    inspect: async () => { calls.push('inspect-source'); return structuredClone(fixture.repository); },
    collect: async () => { calls.push('collect'); return structuredClone(fixture.collected); },
    assertUnchanged: () => { calls.push('source-guard'); },
  };
  const store: CompanyReadonlyStore = {
    create: (plan, payload, context) => {
      calls.push('persist');
      return { plan, payload, status: 'AWAITING_APPROVAL', updatedAt: context.now.toISOString(),
        approvalCreated: false, transmissionAllowed: false, executionAllowed: false, companyPolicyVerified: false };
    },
    inspect: () => { throw new Error('Unexpected inspection'); },
    cancel: () => { throw new Error('Unexpected cancellation'); },
    prune: () => { throw new Error('Unexpected pruning'); }, close: () => { calls.push('close'); },
  };
  return { fixture, calls, source, store, service: new CompanyReadonlyPreparationService(store, source) };
};

test('company preparation checks policy before registration getters, source calls or store mutation', async () => {
  const { fixture, calls, service } = setup();
  let evaluated = false;
  const registration = { get version() { evaluated = true; return 'company-readonly-registration-v1'; } };
  for (const patch of [{ readPermission: 'unconfirmed' }, { storagePermission: 'unconfirmed' }, { policyReference: null }]) {
    await assert.rejects(service.prepare(registration, { ...fixture.policy, ...patch }, fixture.context),
      (error: unknown) => error instanceof HarnessError && error.code === 'COMPANY_READONLY_POLICY_UNCONFIRMED');
  }
  assert.equal(evaluated, false); assert.deepEqual(calls, []);
});

test('company preparation checks current source before storing a disabled draft and has no approval or transport capability', async () => {
  const { fixture, calls, service } = setup();
  const snapshot = await service.prepare(fixture.registration, fixture.policy, fixture.context);
  assert.deepEqual(calls, ['inspect-source', 'collect', 'source-guard', 'persist']);
  assert.equal(snapshot.status, 'AWAITING_APPROVAL');
  for (const key of ['approvalCreated', 'transmissionAllowed', 'executionAllowed', 'companyPolicyVerified'] as const) assert.equal(snapshot[key], false);
  for (const method of ['approve', 'run', 'dispatch', 'transmit']) assert.equal(method in service, false);
});

test('company preparation refuses source changes and forged collected evidence before persistence', async () => {
  const first = setup();
  first.source.assertUnchanged = () => { first.calls.push('source-guard'); throw new HarnessError('COMPANY_READONLY_SOURCE_CHANGED'); };
  await assert.rejects(first.service.prepare(first.fixture.registration, first.fixture.policy, first.fixture.context),
    (error: unknown) => error instanceof HarnessError && error.code === 'COMPANY_READONLY_SOURCE_CHANGED');
  assert.equal(first.calls.includes('persist'), false);
  const second = setup();
  second.source.collect = async () => {
    const collected = structuredClone(second.fixture.collected); collected.evidence[0]!.excerpt = 'forged'; return collected;
  };
  await assert.rejects(second.service.prepare(second.fixture.registration, second.fixture.policy, second.fixture.context));
  assert.equal(second.calls.includes('persist'), false);
});

test('company preparation captures registration and time before asynchronous collection', async () => {
  const { fixture, calls, source, service } = setup();
  source.inspect = async registration => {
    fixture.registration.question = 'Changed after admission'; fixture.context.now.setUTCFullYear(2030);
    assert.notEqual(registration.question, fixture.registration.question); calls.push('inspect-source');
    return structuredClone(fixture.repository);
  };
  const snapshot = await service.prepare(fixture.registration, fixture.policy, fixture.context);
  assert.equal(snapshot.plan.createdAt, '2026-11-16T00:00:00.000Z');
  assert.notEqual(snapshot.payload!.registration.question, fixture.registration.question);
});
