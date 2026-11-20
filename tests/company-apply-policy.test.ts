import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompanyApplyPlan } from '../src/domain/company-apply.js';
import { HarnessError } from '../src/domain/errors.js';
import { assertCompanyApplyApproval, assertCompanyApplyApprovalRequest, assertCompanyApplyContext,
  assertCompanyApplyDraftForPlan, assertCompanyApplyPlan, assertCompanyApplyRequest, assertCompanyApplySource,
  assertCompanyApplyTaskId, copyCompanyApplyData, createCompanyApplyApproval, createCompanyApplyPlan,
  getCompanyApplyLimits, getCompanyApplyLimitsHash, hashCompanyApplyValue, parseCompanyApplyDraft,
  parseCompanyApplyRegistration } from '../src/policy/company-apply.js';
import { createCompanyWriteApproval, createCompanyWritePlan, getCompanyWriteLimits, getCompanyWriteLimitsHash } from '../src/policy/company-write.js';
import { getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';
import { canonicalReadonlyJson } from '../src/policy/readonly-investigation-policy.js';
import { createCompanyApplyFixture } from './company-apply-fixture.js';

const fixedFailure = (operation: () => unknown, code: string): void => {
  assert.throws(operation, error => {
    assert.ok(error instanceof HarnessError); assert.equal(error.code, `COMPANY_APPLY_${code}`);
    assert.equal(error.message, error.code); return true;
  });
};
const requestFor = (plan: Pick<CompanyApplyPlan, 'id' | 'planHash'>, expiresInMinutes = 10) => ({ taskId: plan.id, planHash: plan.planHash, expiresInMinutes });
const rehash = (value: CompanyApplyPlan): CompanyApplyPlan => ({ ...value,
  planHash: hashCompanyApplyValue(canonicalReadonlyJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'planHash')))) });

test('apply reuses registration v1 and strict drafts but requires all declared local permissions', () => {
  const { draft, registration, source, context } = createCompanyApplyFixture();
  assert.deepEqual(parseCompanyApplyRegistration(registration), registration);
  assert.deepEqual(parseCompanyApplyDraft(draft, registration), draft);
  for (const changed of [{ ...registration, enabled: false }, { ...registration, localRead: 'unconfirmed' },
    { ...registration, localWrite: 'unconfirmed' }]) {
    fixedFailure(() => createCompanyApplyPlan(draft, changed, source, context), 'REGISTRATION_DISABLED');
  }
  for (const changed of [{ ...registration, envFile: '/synthetic/.env' }, { ...registration, sourceRoot: '/private/tmp/../escape' },
    { ...registration, writeAllowedFiles: ['.git/config'] }, { ...registration, writeAllowedFiles: ['src/a.ts', 'SRC/A.ts'] }]) {
    fixedFailure(() => parseCompanyApplyRegistration(changed), 'INVALID_REGISTRATION');
  }
  fixedFailure(() => parseCompanyApplyDraft({ ...draft, branch: 'fix/nested/leaf' }, registration), 'WRITE_SCOPE_MISMATCH');
  fixedFailure(() => parseCompanyApplyDraft(draft, { ...registration, writeAllowedFiles: ['src/other.ts'] }), 'WRITE_SCOPE_MISMATCH');
  fixedFailure(() => parseCompanyApplyDraft({ ...draft, baseCommit: 'a'.repeat(40) }, registration), 'REGISTRATION_MISMATCH');
});

test('plan binds Git proof, packed refs presence and base-ref representation independently', () => {
  const { draft, registration, source, context, id, plan } = createCompanyApplyFixture();
  const withPacked = { ...source, packedRefsHash: '7'.repeat(64) };
  const packedBase = { ...withPacked, baseRefKind: 'packed' as const };
  const plans = [plan, createCompanyApplyPlan(draft, registration, withPacked, context, id).plan,
    createCompanyApplyPlan(draft, registration, packedBase, context, id).plan,
    createCompanyApplyPlan(draft, registration, { ...source, gitProofHash: '8'.repeat(64) }, context, id).plan];
  assert.equal(new Set(plans.map(value => value.planHash)).size, plans.length);
  for (const changed of [{ ...source, baseRefKind: 'packed' }, { ...source, baseRefKind: 'unknown' },
    { ...source, packedRefsHash: '' }, { ...source, gitProofHash: null }, { ...source, unvisitedObjects: 'checked' }]) {
    fixedFailure(() => assertCompanyApplySource(changed), 'INVALID_SOURCE');
  }
});

test('source baseline and ordered before-file evidence must agree with the exact registered draft', () => {
  const { draft, registration, source, context } = createCompanyApplyFixture(), workspace = source.workspace;
  for (const changed of [{ ...workspace, headHash: '7'.repeat(64) }, { ...workspace, indexHash: '7'.repeat(64) },
    { ...workspace, baseRefHash: hashCompanyApplyValue(registration.baseCommit) }, { ...workspace, files: [...workspace.files].reverse() },
    { ...workspace, files: workspace.files.slice(1) }]) {
    fixedFailure(() => createCompanyApplyPlan(draft, registration, { ...source, workspace: changed }, context), 'SOURCE_MISMATCH');
  }
  fixedFailure(() => assertCompanyApplySource({ ...source, workspace: { ...workspace,
    files: [{ ...workspace.files[0], mode: 0o755 }, workspace.files[1]] } }), 'INVALID_SOURCE');
});

test('plan is body-free, copied and bound to all proposal data without claiming checks or transmission', () => {
  const { draft, registration, source, context, plan } = createCompanyApplyFixture();
  assertCompanyApplyPlan(plan); assertCompanyApplyDraftForPlan(plan, draft, registration);
  assert.equal(plan.scope, 'company-local-write'); assert.equal(plan.checks, 'not_run'); assert.equal(plan.transmissionAllowed, false);
  for (const privateValue of [registration.sourceRoot, draft.objective, ...draft.changes.map(change => change.content)]) {
    assert.equal(JSON.stringify(plan).includes(privateValue), false);
  }
  const fresh = createCompanyApplyPlan(draft, registration, source, context);
  source.workspace.files[0]!.mode = 0o600; draft.changes[0]!.content = 'caller mutation';
  assert.notEqual(fresh.plan.source.workspace.files[0]!.mode, source.workspace.files[0]!.mode);
  assert.notEqual(fresh.draft.changes[0]!.content, draft.changes[0]!.content);
  const copied = copyCompanyApplyData(fresh.plan); copied.source.gitProofHash = 'a'.repeat(64); assertCompanyApplyPlan(fresh.plan);
  fixedFailure(() => assertCompanyApplyDraftForPlan(plan, createCompanyApplyFixture().draft,
    { ...registration, sourceRoot: '/private/tmp/another-declared-root' }), 'REGISTRATION_MISMATCH');
  fixedFailure(() => assertCompanyApplyDraftForPlan(plan, { ...createCompanyApplyFixture().draft, requestRevision: 2 }, registration), 'DRAFT_PLAN_MISMATCH');
});

test('old synthetic plans and approvals are rejected and neither old contract hash nor reader budgets change', () => {
  const { draft, registration, source, context, plan, approval } = createCompanyApplyFixture();
  const oldHash = getCompanyWriteLimitsHash(), oldLimits = { ...getCompanyWriteLimits() };
  const oldPlan = createCompanyWritePlan(draft, registration, source.workspace, context).plan;
  const oldApproval = createCompanyWriteApproval(oldPlan, requestFor(oldPlan), context);
  fixedFailure(() => assertCompanyApplyPlan(oldPlan), 'INVALID_PLAN');
  fixedFailure(() => assertCompanyApplyApproval(plan, oldApproval), 'INVALID_APPROVAL');
  fixedFailure(() => assertCompanyApplyApproval(plan, { ...approval, scope: 'synthetic-validation' }), 'INVALID_APPROVAL');
  const limits = getCompanyApplyLimits(); assert.equal(Object.isFrozen(limits), true);
  assert.deepEqual(limits, { ...oldLimits, maxPackedRefsBytes: 1_048_576, maxTaskDirectories: 256 });
  assert.equal(getCompanyApplyLimitsHash(), hashCompanyApplyValue(canonicalReadonlyJson({ version: 'company-apply-plan-v1', limits,
    readerProfileHash: getCompanyGitRangeUnitProfileHash(), guardHash: getCompanyGitRangeUnitGuardPolicyHash() })));
  assert.notEqual(getCompanyApplyLimitsHash(), oldHash);
  assert.equal(getCompanyWriteLimitsHash(), oldHash); assert.deepEqual(getCompanyWriteLimits(), oldLimits);
});

test('even rehashed plans cannot expand authority, limits or malformed change descriptors', () => {
  const { plan } = createCompanyApplyFixture();
  for (const modified of [{ ...plan, scope: 'synthetic-validation' }, { ...plan, checks: 'passed' },
    { ...plan, transmissionAllowed: true }, { ...plan, limitsHash: '0'.repeat(64) }, { ...plan, sourceRoot: '/unbound' }]) {
    fixedFailure(() => assertCompanyApplyPlan(modified), 'INVALID_PLAN');
  }
  for (const descriptor of [{ ...plan.changes[0]!, path: 'src/other.ts' }, { ...plan.changes[0]!, bytes: 65_537 },
    { ...plan.changes[0]!, afterHash: plan.changes[0]!.beforeHash! }, { ...plan.changes[0]!, bytes: 0 },
    { ...plan.changes[0]!, content: 'unapproved body' }]) {
    fixedFailure(() => assertCompanyApplyPlan(rehash({ ...plan, changes: [descriptor, plan.changes[1]!] })), 'INVALID_PLAN');
  }
});

test('approval uses complete integer TTL, exact hash and owner and cannot be extended beyond the plan', () => {
  const { plan, context } = createCompanyApplyFixture();
  for (const minutes of [1, 60]) {
    const approval = createCompanyApplyApproval(plan, requestFor(plan, minutes), context);
    assertCompanyApplyApproval(plan, approval); assert.equal(approval.scope, 'company-local-write'); assert.equal(approval.usedAt, null);
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt), minutes * 60_000);
  }
  fixedFailure(() => createCompanyApplyApproval(plan, requestFor(plan, 1), { ...context,
    now: new Date(Date.parse(plan.expiresAt) - 59_999) }), 'APPROVAL_EXCEEDS_PLAN_TTL');
  assert.equal(createCompanyApplyApproval(plan, requestFor(plan, 1), { ...context,
    now: new Date(Date.parse(plan.expiresAt) - 60_000) }).expiresAt, plan.expiresAt);
  fixedFailure(() => createCompanyApplyApproval(plan, { ...requestFor(plan), planHash: '0'.repeat(64) }, context), 'PLAN_MISMATCH');
  fixedFailure(() => createCompanyApplyApproval(plan, requestFor(plan), { ...context, ownerId: 'os-user:99999999' }), 'OWNER_MISMATCH');
});

test('request and consumption metadata are exact, bounded and never substitute a different task', () => {
  const { plan, approval } = createCompanyApplyFixture();
  assertCompanyApplyTaskId(plan.id); assertCompanyApplyRequest({ taskId: plan.id, planHash: plan.planHash });
  for (const id of ['../outside', '', '11111111111141118111111111111111']) fixedFailure(() => assertCompanyApplyTaskId(id), 'INVALID_ID');
  for (const request of [{ taskId: plan.id, planHash: plan.planHash, execute: true }, { taskId: plan.id, planHash: '' },
    { taskId: 1, planHash: plan.planHash }]) fixedFailure(() => assertCompanyApplyRequest(request), 'INVALID_REQUEST');
  for (const minutes of [0, 61, 1.5, '10', NaN]) {
    fixedFailure(() => assertCompanyApplyApprovalRequest({ ...requestFor(plan), expiresInMinutes: minutes }), 'INVALID_APPROVAL');
  }
  for (const changed of [{ ...approval, usedAt: approval.expiresAt }, { ...approval, revokedAt: null },
    { ...approval, taskId: '22222222-2222-4222-8222-222222222222' },
    { ...approval, expiresAt: new Date(Date.parse(approval.expiresAt) + 1).toISOString() }]) {
    fixedFailure(() => assertCompanyApplyApproval(plan, changed), 'INVALID_APPROVAL');
  }
});

test('all new input boundaries reject proxies and accessors before invoking caller code', () => {
  const { draft, registration, source, context, plan, approval } = createCompanyApplyFixture(); let calls = 0;
  const handler = { get: () => { calls++; throw new Error('synthetic trap'); }, ownKeys: () => { calls++; throw new Error('synthetic trap'); } };
  const accessor = { ...source };
  Object.defineProperty(accessor, 'gitProofHash', { enumerable: true, get: () => { calls++; return source.gitProofHash; } });
  fixedFailure(() => parseCompanyApplyRegistration(new Proxy(registration, handler)), 'INVALID_REGISTRATION');
  fixedFailure(() => createCompanyApplyPlan(new Proxy(draft, handler), registration, source, context), 'INVALID_DRAFT');
  fixedFailure(() => assertCompanyApplySource(accessor), 'INVALID_SOURCE');
  fixedFailure(() => assertCompanyApplySource({ ...source, workspace: new Proxy(source.workspace, handler) }), 'INVALID_SOURCE');
  fixedFailure(() => assertCompanyApplyPlan(new Proxy(plan, handler)), 'INVALID_PLAN');
  fixedFailure(() => assertCompanyApplyApproval(plan, new Proxy(approval, handler)), 'INVALID_APPROVAL');
  fixedFailure(() => assertCompanyApplyRequest(new Proxy({ taskId: plan.id, planHash: plan.planHash }, handler)), 'INVALID_REQUEST');
  assert.equal(calls, 0);
});

test('invalid and overflowing dates fail with fixed errors and do not produce a partial plan', () => {
  const { draft, registration, source, context, plan } = createCompanyApplyFixture();
  for (const now of [new Date('invalid'), new Date(8_640_000_000_000_000), new Date('9999-12-31T00:00:00.000Z')]) {
    fixedFailure(() => createCompanyApplyPlan(draft, registration, source, { ...context, now }), 'INVALID_TIME');
  }
  fixedFailure(() => assertCompanyApplyContext({ ...context, ownerId: 'os-user:99999999' }), 'OWNER_MISMATCH');
  fixedFailure(() => createCompanyApplyApproval(plan, requestFor(plan), { ...context, now: new Date(plan.expiresAt) }), 'EXPIRED');
});
