import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SyntheticCompanyChangeApproval, SyntheticCompanyChangePlan, SyntheticCompanyChangeSource } from '../src/domain/synthetic-company-change.js';
import { HarnessError } from '../src/domain/errors.js';
import { getCompanyChangeLimitsHash, hashCompanyChangeValue } from '../src/policy/company-change.js';
import { canonicalReadonlyJson } from '../src/policy/readonly-investigation-policy.js';
import { assertSyntheticCompanyChangeApproval, assertSyntheticCompanyChangeApprovalRequest, assertSyntheticCompanyChangeClaimRequest,
  assertSyntheticCompanyChangeContext, assertSyntheticCompanyChangeDraftForPlan, assertSyntheticCompanyChangePlan,
  assertSyntheticCompanyChangeSource, copySyntheticCompanyChangeData, createSyntheticCompanyChangePlan,
  getSyntheticCompanyChangeLimits, getSyntheticCompanyChangeLimitsHash } from '../src/policy/synthetic-company-change.js';
import { createCompanyChangeDraft, createCompanyChangeFixture } from './company-change-fixture.js';

const fixture = () => {
  const draft = { ...createCompanyChangeDraft(), repoId: 'synthetic-company-change' };
  const source: SyntheticCompanyChangeSource = { repositoryId: 'synthetic-company-change', rootHash: '3'.repeat(64),
    baseCommit: draft.baseCommit, baseBranch: draft.baseBranch, indexHash: draft.baseIndexHash, sourceHash: '4'.repeat(64) };
  const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date('2026-01-01T00:00:00.000Z') };
  const id = '11111111-1111-4111-8111-111111111111';
  const { plan } = createSyntheticCompanyChangePlan(draft, source, context, id);
  return { draft, source, context, id, plan };
};
const rehashPlan = (value: SyntheticCompanyChangePlan): SyntheticCompanyChangePlan => {
  const content = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'planHash'));
  return { ...value, planHash: hashCompanyChangeValue(canonicalReadonlyJson(content)) };
};
const approvalFor = (plan: SyntheticCompanyChangePlan): SyntheticCompanyChangeApproval => ({
  id: '22222222-2222-4222-8222-222222222222', taskId: plan.id, ownerId: plan.ownerId, planHash: plan.planHash,
  createdAt: plan.createdAt, expiresAt: new Date(Date.parse(plan.createdAt) + 60_000).toISOString(), usedAt: null, scope: 'synthetic-apply',
});

test('synthetic apply plans bind supplied bodies and observed source metadata without persisting content', () => {
  const { draft, source, context, id, plan } = fixture();
  assertSyntheticCompanyChangePlan(plan); assertSyntheticCompanyChangeDraftForPlan(plan, draft);
  assert.equal(plan.version, 'synthetic-company-change-apply-v1'); assert.equal(plan.scope, 'synthetic-only');
  assert.equal(plan.checks, 'not_run'); assert.equal(plan.transmissionAllowed, false);
  assert.equal(plan.branch, draft.branch); assert.equal(plan.requestRevision, draft.requestRevision);
  assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 86_400_000);
  assert.deepEqual(plan.changes, draft.changes.map(change => ({ operation: change.operation, path: change.path,
    beforeHash: change.beforeHash, afterHash: hashCompanyChangeValue(change.content), bytes: Buffer.byteLength(change.content) })));
  for (const body of [draft.objective, ...draft.changes.map(change => change.content)]) assert.equal(JSON.stringify(plan).includes(body), false);
  const result = createSyntheticCompanyChangePlan(draft, source, context, id);
  source.sourceHash = '5'.repeat(64); draft.changes[0]!.content = 'caller-mutated content';
  assert.notEqual(result.plan.source.sourceHash, source.sourceHash);
  assert.notEqual(result.draft.changes[0]!.content, draft.changes[0]!.content);
  const copied = copySyntheticCompanyChangeData(result.plan); copied.changes[0]!.path = 'caller-mutated.ts';
  assertSyntheticCompanyChangeDraftForPlan(result.plan, result.draft);
});

test('synthetic plan hashes bind root identity, full source, target branch, request revision and ordered changes', () => {
  const { draft, source, context, id, plan } = fixture();
  for (const changed of [{ ...source, rootHash: '6'.repeat(64) }, { ...source, sourceHash: '7'.repeat(64) }]) {
    assert.notEqual(createSyntheticCompanyChangePlan(draft, changed, context, id).plan.planHash, plan.planHash);
  }
  for (const changed of [{ ...draft, branch: 'fix/another-branch' }, { ...draft, requestRevision: 2 },
    { ...draft, objective: 'Another synthetic change request.' }, { ...draft, changes: [...draft.changes].reverse() }]) {
    assert.notEqual(createSyntheticCompanyChangePlan(changed, source, context, id).plan.planHash, plan.planHash);
    assert.throws(() => assertSyntheticCompanyChangeDraftForPlan(plan, changed), { code: 'SYNTHETIC_COMPANY_CHANGE_DRAFT_PLAN_MISMATCH' });
  }
  const reordered = Object.fromEntries(Object.entries(draft).reverse());
  assert.deepEqual(createSyntheticCompanyChangePlan(reordered, source, context, id).plan, plan);
});

test('source identity is exact synthetic metadata and every declared baseline must match it', () => {
  const { draft, source, context } = fixture();
  for (const changed of [{ ...source, repositoryId: 'company-repository' }, { ...source, root: '/undeclared/path' },
    { ...source, baseBranch: 'HEAD' }, { ...source, baseBranch: 'refs/heads/main' }, { ...source, baseCommit: 'a'.repeat(64) },
    { ...source, rootHash: 'A'.repeat(64) }, { ...source, sourceHash: 'a'.repeat(63) }]) {
    assert.throws(() => assertSyntheticCompanyChangeSource(changed), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_SOURCE' });
  }
  for (const changed of [{ ...draft, repoId: 'other-synthetic-repository' }, { ...draft, baseCommit: '5'.repeat(40) },
    { ...draft, baseBranch: 'another-base' }, { ...draft, baseIndexHash: '5'.repeat(64) }]) {
    assert.throws(() => createSyntheticCompanyChangePlan(changed, source, context), { code: 'SYNTHETIC_COMPANY_CHANGE_SOURCE_MISMATCH' });
  }
});

test('draft validation reuses unchanged strict review-input limits, secret rules and replace/create path constraints', () => {
  const { draft, source, context } = fixture(), legacyHash = getCompanyChangeLimitsHash();
  for (const changed of [{ ...draft, command: 'synthetic-not-executed' }, { ...draft, changes: [] },
    { ...draft, changes: [{ ...draft.changes[0], path: '../outside.ts' }] },
    { ...draft, changes: [{ ...draft.changes[0], content: 'Bearer syntheticCredentialValue' }] },
    { ...draft, changes: [{ ...draft.changes[0], content: '\ud800' }] },
    { ...draft, changes: [{ ...draft.changes[0], content: 'x'.repeat(65_537) }] }]) {
    assert.throws(() => createSyntheticCompanyChangePlan(changed, source, context), error => {
      assert.ok(error instanceof HarnessError); assert.equal(error.code, 'SYNTHETIC_COMPANY_CHANGE_INVALID_DRAFT');
      assert.equal(error.message, error.code); return true;
    });
  }
  assert.equal(getCompanyChangeLimitsHash(), legacyHash);
});

test('new source-tree and journal limits are immutable and separately hashed from the review contract', () => {
  const limits = getSyntheticCompanyChangeLimits(), initialHash = getSyntheticCompanyChangeLimitsHash();
  assert.deepEqual(limits, { maxChanges: 8, maxContentBytes: 65_536, maxTotalContentBytes: 131_072,
    maxDraftJsonBytes: 262_144, maxPlanJsonBytes: 16_384, maxSourceBytes: 1_048_576, maxSourceEntries: 256,
    maxJournalEntries: 18, planLifetimeMs: 86_400_000, minApprovalMinutes: 1, maxApprovalMinutes: 60, busyTimeoutMs: 100 });
  assert.equal(Object.isFrozen(limits), true); assert.throws(() => Object.assign(limits, { maxSourceBytes: 9 }), TypeError);
  assert.equal(getSyntheticCompanyChangeLimitsHash(), initialHash); assert.notEqual(initialHash, getCompanyChangeLimitsHash());
});

test('plan validation rejects review-only plans and added execution or product-check authority', () => {
  const { plan } = fixture();
  for (const changed of [createCompanyChangeFixture().plan, { ...plan, version: 'company-change-review-v1' },
    { ...plan, scope: 'company' }, { ...plan, checks: 'passed' }, { ...plan, transmissionAllowed: true },
    { ...plan, executionAllowed: true }, { ...plan, draft: {} }, { ...plan, limitsHash: '0'.repeat(64) },
    { ...plan, expiresAt: new Date(Date.parse(plan.expiresAt) + 1).toISOString() },
    { ...plan, planHash: '0'.repeat(64) }]) {
    assert.throws(() => assertSyntheticCompanyChangePlan(changed), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_PLAN' });
  }
});

test('descriptor validation rejects malformed hashes, bodies, unsafe paths and collisions even with a recomputed plan hash', () => {
  const { plan } = fixture(), descriptor = plan.changes[0]!;
  for (const changed of [{ ...descriptor, operation: 'delete' }, { ...descriptor, beforeHash: null },
    { ...descriptor, afterHash: descriptor.beforeHash }, { ...descriptor, bytes: -1 }, { ...descriptor, bytes: 65_537 },
    { ...descriptor, bytes: 1.5 }, { ...descriptor, afterHash: 'A'.repeat(64) }, { ...descriptor, content: 'forbidden body' },
    { ...descriptor, path: '.git/config' }, { ...descriptor, path: '.env' }, { ...descriptor, path: 'node_modules/pkg/a.ts' }]) {
    const modified = rehashPlan({ ...plan, changes: [changed] } as SyntheticCompanyChangePlan);
    assert.throws(() => assertSyntheticCompanyChangePlan(modified), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_PLAN' });
  }
  for (const paths of [['src/a.ts', 'SRC/A.ts'], ['src/a', 'src/a/b.ts']]) {
    const modified = rehashPlan({ ...plan, changes: paths.map(path => ({ ...descriptor, path })) });
    assert.throws(() => assertSyntheticCompanyChangePlan(modified), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_PLAN' });
  }
  for (const branch of ['main', 'fix/../escape', 'unsafe/branch']) {
    assert.throws(() => assertSyntheticCompanyChangePlan(rehashPlan({ ...plan, branch })), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_PLAN' });
  }
});

test('descriptor paths are validated without mistaking placeholder metadata for real replacement content', () => {
  const { draft, source, context } = fixture();
  for (const before of ['', 'synthetic descriptor validation\n']) {
    const modified = { ...draft, changes: [{ ...draft.changes[0]!, beforeHash: hashCompanyChangeValue(before), content: 'actual new synthetic text\n' }] };
    const created = createSyntheticCompanyChangePlan(modified, source, context);
    assertSyntheticCompanyChangeDraftForPlan(created.plan, created.draft);
  }
  const { plan } = fixture();
  for (const changed of [{ ...plan, branch: 'fix/other-branch' }, { ...plan, requestRevision: 2 },
    { ...plan, changes: plan.changes.map((entry, index) => index ? entry : { ...entry, bytes: entry.bytes + 1 }) }]) {
    assert.throws(() => assertSyntheticCompanyChangeDraftForPlan(rehashPlan(changed), draft), { code: 'SYNTHETIC_COMPANY_CHANGE_DRAFT_PLAN_MISMATCH' });
  }
});

test('approval and claim requests reject unknown keys, invalid identifiers and unbounded TTLs', () => {
  const { plan } = fixture(), request = { taskId: plan.id, planHash: plan.planHash };
  assertSyntheticCompanyChangeClaimRequest(request);
  for (const expiresInMinutes of [1, 60]) assertSyntheticCompanyChangeApprovalRequest({ ...request, expiresInMinutes });
  for (const value of [0, 61, 1.5, '10', NaN]) {
    assert.throws(() => assertSyntheticCompanyChangeApprovalRequest({ ...request, expiresInMinutes: value }), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_APPROVAL' });
  }
  for (const changed of [{ ...request, apply: true }, { ...request, taskId: '../../path' }, { ...request, planHash: 'f'.repeat(40) }]) {
    assert.throws(() => assertSyntheticCompanyChangeClaimRequest(changed), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_REQUEST' });
  }
});

test('synthetic approvals bind exact plan and owner, fit the plan and can be consumed only before expiry', () => {
  const { plan } = fixture(), approval = approvalFor(plan);
  assertSyntheticCompanyChangeApproval(plan, approval);
  assertSyntheticCompanyChangeApproval(plan, { ...approval, usedAt: approval.createdAt });
  assertSyntheticCompanyChangeApproval(plan, { ...approval, usedAt: new Date(Date.parse(approval.expiresAt) - 1).toISOString() });
  for (const changed of [{ ...approval, scope: 'review-only' }, { ...approval, executionAllowed: false },
    { ...approval, ownerId: 'os-user:99999999' }, { ...approval, planHash: '0'.repeat(64) },
    { ...approval, taskId: approval.id }, { ...approval, usedAt: approval.expiresAt },
    { ...approval, usedAt: new Date(Date.parse(approval.createdAt) - 1).toISOString() },
    { ...approval, expiresAt: new Date(Date.parse(approval.expiresAt) + 1).toISOString() },
    { ...approval, createdAt: new Date(Date.parse(plan.expiresAt) - 30_000).toISOString(), expiresAt: new Date(Date.parse(plan.expiresAt) + 30_000).toISOString() }]) {
    assert.throws(() => assertSyntheticCompanyChangeApproval(plan, changed), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_APPROVAL' });
  }
});

test('context dates, ownership and factory IDs fail with fixed synthetic-policy errors', () => {
  const { draft, source, context } = fixture();
  for (const now of [new Date('invalid'), new Date(8_640_000_000_000_000), new Date('9999-12-31T00:00:00.000Z')]) {
    assert.throws(() => createSyntheticCompanyChangePlan(draft, source, { ...context, now }), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_TIME' });
  }
  assert.throws(() => assertSyntheticCompanyChangeContext({ ...context, ownerId: 'os-user:999999999' }), { code: 'SYNTHETIC_COMPANY_CHANGE_OWNER_MISMATCH' });
  assert.throws(() => createSyntheticCompanyChangePlan(draft, source, context, 'not-an-id'), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_ID' });
});

test('metadata accessors and sparse descriptors are rejected without invoking a caller getter', () => {
  const { source, plan } = fixture(); let reads = 0;
  const accessor = { ...source };
  Object.defineProperty(accessor, 'rootHash', { enumerable: true, get: () => { reads++; return source.rootHash; } });
  assert.throws(() => assertSyntheticCompanyChangeSource(accessor), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_SOURCE' });
  const descriptors = [...plan.changes];
  Object.defineProperty(descriptors, '0', { enumerable: true, get: () => { reads++; return plan.changes[0]; } });
  assert.throws(() => assertSyntheticCompanyChangePlan({ ...plan, changes: descriptors }), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_PLAN' });
  assert.throws(() => assertSyntheticCompanyChangePlan({ ...plan, changes: Array(2) }), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_PLAN' });
  assert.equal(reads, 0);
});
