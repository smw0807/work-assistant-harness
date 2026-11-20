import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompanyChangeStore } from '../src/ports/company-change.js';
import type { CompanyChangeSnapshot } from '../src/domain/company-change.js';
import { CompanyChangePreparationService } from '../src/application/prepare-company-change.js';
import { createCompanyChangeFixture } from './company-change-fixture.js';

test('company change service binds declared draft bytes and exposes only review operations', () => {
  const fixture = createCompanyChangeFixture(), calls: string[] = [];
  const snapshot: CompanyChangeSnapshot = { plan: fixture.plan, draft: fixture.draft, status: 'AWAITING_APPROVAL',
    updatedAt: fixture.plan.createdAt, approval: null };
  const store: CompanyChangeStore = {
    create: (plan, draft, context) => {
      calls.push('create'); assert.deepEqual(plan, fixture.plan); assert.deepEqual(draft, fixture.draft);
      assert.equal(context.ownerId, fixture.context.ownerId); return snapshot;
    },
    inspect: () => { calls.push('inspect'); return snapshot; }, review: () => { calls.push('review'); return snapshot; },
    approve: () => { calls.push('approve'); return snapshot; }, cancel: () => { calls.push('cancel'); return snapshot; },
    prune: () => { calls.push('prune'); return { draftsRemoved: 0, recordsRemoved: 0 }; }, close: () => {},
  };
  const service = new CompanyChangePreparationService(store);
  assert.equal(service.prepare(fixture.draft, fixture.context, fixture.id), snapshot);
  assert.equal(service.review(fixture.id, fixture.context), snapshot);
  service.inspect(fixture.id, fixture.context);
  service.approve({ taskId: fixture.id, planHash: fixture.plan.planHash, expiresInMinutes: 10 }, fixture.context);
  service.cancel(fixture.id, fixture.context); service.prune(fixture.context);
  assert.deepEqual(calls, ['create', 'review', 'inspect', 'approve', 'cancel', 'prune']);
  assert.equal(snapshot.plan.sourceVerification, 'not_run'); assert.equal(snapshot.plan.executionAllowed, false);
  for (const name of ['apply', 'run', 'claim', 'execute', 'dispatch', 'transmit', 'recover']) assert.equal(name in service, false);
});

test('invalid identity, owner and draft fail before a service can touch storage', () => {
  const fixture = createCompanyChangeFixture(); let accesses = 0;
  const store = new Proxy({}, { get: () => { accesses++; throw new Error('Unexpected store access'); } }) as CompanyChangeStore;
  const service = new CompanyChangePreparationService(store);
  assert.throws(() => service.inspect('../outside', fixture.context), { code: 'COMPANY_CHANGE_INVALID_ID' });
  assert.throws(() => service.review(fixture.id, { ...fixture.context, ownerId: 'os-user:999999' }), { code: 'COMPANY_CHANGE_OWNER_MISMATCH' });
  assert.throws(() => service.prepare({ ...fixture.draft, sourceRoot: '/not-followed' }, fixture.context, fixture.id), { code: 'COMPANY_CHANGE_INVALID_DRAFT' });
  assert.equal(accesses, 0);
});
