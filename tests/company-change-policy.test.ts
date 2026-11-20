import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompanyChangeApproval, CompanyChangeDraft } from '../src/domain/company-change.js';
import { HarnessError } from '../src/domain/errors.js';
import { assertCompanyChangeApproval, assertCompanyChangeApprovalRequest, assertCompanyChangeContext,
  assertCompanyChangeDraftForPlan, assertCompanyChangePlan, copyCompanyChangeData, createCompanyChangePlan,
  getCompanyChangeLimits, getCompanyChangeLimitsHash, hashCompanyChangeValue, parseCompanyChangeDraft } from '../src/policy/company-change.js';
import { canonicalReadonlyJson } from '../src/policy/readonly-investigation-policy.js';
import { createCompanyChangeDraft, createCompanyChangeFixture } from './company-change-fixture.js';

const invalidDraft = (value: unknown): void => {
  assert.throws(() => parseCompanyChangeDraft(value), error => {
    assert.ok(error instanceof HarnessError); assert.equal(error.code, 'COMPANY_CHANGE_INVALID_DRAFT');
    assert.equal(error.message, error.code); return true;
  });
};
const creations = (contents: string[]): CompanyChangeDraft => ({ ...createCompanyChangeDraft(),
  changes: contents.map((content, index) => ({ operation: 'create', path: `src/file-${index}.ts`, beforeHash: null, content })) });

test('declared replacement/create plans expose no source verification or execution authority and detach their input', () => {
  const { draft, plan, context, id } = createCompanyChangeFixture();
  assertCompanyChangePlan(plan); assertCompanyChangeDraftForPlan(plan, draft);
  assert.equal(plan.id, id); assert.equal(plan.sourceVerification, 'not_run'); assert.equal(plan.approvalScope, 'review-only');
  assert.equal(plan.executionAllowed, false); assert.equal(plan.transmissionAllowed, false); assert.equal(plan.changeCount, 2);
  assert.equal(plan.createdAt, context.now.toISOString());
  assert.equal(Date.parse(plan.expiresAt) - context.now.getTime(), 86_400_000);
  assert.equal(Date.parse(plan.auditExpiresAt) - context.now.getTime(), 30 * 86_400_000);
  for (const body of [draft.objective, draft.changes[0]!.content, draft.changes[0]!.path]) assert.equal(JSON.stringify(plan).includes(body), false);
  const result = createCompanyChangePlan(draft, context, id);
  draft.changes[0]!.content = 'changed caller value';
  assert.notEqual(result.draft.changes[0]!.content, draft.changes[0]!.content);
  const copied = copyCompanyChangeData(result.draft); copied.changes[0]!.content = 'changed copied value';
  assertCompanyChangeDraftForPlan(result.plan, result.draft);
});

test('canonical plans are stable across object key order but bind every declared change and baseline', () => {
  const { draft, plan, context, id } = createCompanyChangeFixture();
  const reordered = Object.fromEntries(Object.entries(draft).reverse());
  assert.deepEqual(createCompanyChangePlan(reordered, context, id), { plan, draft });
  for (const modified of [
    { ...draft, objective: 'Another synthetic objective.' }, { ...draft, requestRevision: 2 },
    { ...draft, baseCommit: '3'.repeat(40) }, { ...draft, baseIndexHash: '4'.repeat(64) },
    { ...draft, branch: 'fix/another-declared-branch' }, { ...draft, repoId: 'another-synthetic-repo' },
    { ...draft, changes: [...draft.changes].reverse() },
  ]) {
    const changed = createCompanyChangePlan(modified, context, id);
    assert.notEqual(changed.plan.draftHash, plan.draftHash); assert.notEqual(changed.plan.planHash, plan.planHash);
    assert.throws(() => assertCompanyChangeDraftForPlan(plan, modified), { code: 'COMPANY_CHANGE_DRAFT_PLAN_MISMATCH' });
  }
});

test('drafts reject unknown fields, missing fields, legacy contracts, accessors and sparse changes without invoking getters', () => {
  const draft = createCompanyChangeDraft();
  for (const value of [null, [], {}, { ...draft, sourceRoot: '/synthetic/undeclared' }, { ...draft, executionAllowed: true },
    { ...draft, version: 'synthetic-codex-execution-v1' }, { ...draft, changes: [{ ...draft.changes[0], afterHash: '0'.repeat(64) }] },
    { ...draft, requestRevision: 0 }, { ...draft, requestRevision: 1.5 }, { ...draft, requestRevision: '1' }]) invalidDraft(value);
  const missing = { ...draft } as Partial<CompanyChangeDraft>; delete missing.baseIndexHash; invalidDraft(missing);
  let getters = 0;
  const accessor = { ...draft }; Object.defineProperty(accessor, 'objective', { enumerable: true, get: () => { getters++; return 'unexpected'; } });
  invalidDraft(accessor);
  const changes = [...draft.changes]; Object.defineProperty(changes, '0', { enumerable: true, get: () => { getters++; return draft.changes[0]; } });
  invalidDraft({ ...draft, changes });
  invalidDraft({ ...draft, changes: Array(2) });
  invalidDraft({ ...draft, changes: [{ ...draft.changes[0], operation: { toString: () => { getters++; return 'replace'; } } }] });
  assert.equal(getters, 0);
});

test('new limits remain immutable and enforce file count plus UTF-8 per-file and aggregate byte boundaries', () => {
  const limits = getCompanyChangeLimits(), before = getCompanyChangeLimitsHash();
  assert.equal(Object.isFrozen(limits), true);
  assert.throws(() => Object.assign(limits, { maxChanges: 999 }), TypeError); assert.equal(getCompanyChangeLimitsHash(), before);
  parseCompanyChangeDraft(creations(Array<string>(8).fill(''))); invalidDraft(creations([])); invalidDraft(creations(Array<string>(9).fill('')));
  const multibyte = '가'.repeat(21_845) + 'x'; assert.equal(Buffer.byteLength(multibyte), 65_536);
  parseCompanyChangeDraft(creations([multibyte])); invalidDraft(creations([multibyte + 'x']));
  parseCompanyChangeDraft(creations(['x'.repeat(65_536), 'y'.repeat(65_536)]));
  invalidDraft(creations(['x'.repeat(65_536), 'y'.repeat(65_536), 'z']));
});

test('draft JSON size counts encoded bytes including escapes and rejects exactly one byte over the limit', () => {
  const draft = creations(['']); draft.objective = '';
  const overhead = Buffer.byteLength(canonicalReadonlyJson(draft));
  draft.objective = 'x'.repeat(getCompanyChangeLimits().maxDraftJsonBytes - overhead);
  assert.equal(Buffer.byteLength(canonicalReadonlyJson(draft)), getCompanyChangeLimits().maxDraftJsonBytes);
  parseCompanyChangeDraft(draft); invalidDraft({ ...draft, objective: draft.objective + 'x' });
  const escaped = creations(['\\'.repeat(65_536), '\\'.repeat(65_536)]);
  assert.equal(escaped.changes.reduce((sum, change) => sum + Buffer.byteLength(change.content), 0), 131_072);
  invalidDraft(escaped);
});

test('source paths exclude escapes, Git/configuration credentials, dependency directories and ambiguous separators', () => {
  const paths = ['/absolute.ts', '../outside.ts', 'src/../outside.ts', './src/value.ts', 'src//value.ts', 'src\\value.ts',
    '.git/config', 'src/.GIT/HEAD', '.gitmodules', '.gitattributes', '.env', '.ENV.production', 'config/test.env',
    'node_modules/pkg/index.js', 'src/NODE_MODULES/file.ts', '.aws/config', '.ssh/config', '.codex/auth.json',
    '.config/tool/config', '.npmrc', '.netrc', '.yarnrc.yml', 'secrets/key.ts', 'src/credentials.json',
    'certificates/private.pem', 'src/id_ed25519', 'src/value.ts.', 'src/value.ts\0', 'src/a:b.ts', 'src/가.ts'];
  for (const path of paths) invalidDraft({ ...createCompanyChangeDraft(), changes: [{ operation: 'create', path, beforeHash: null, content: '' }] });
  parseCompanyChangeDraft({ ...createCompanyChangeDraft(), changes: [{ operation: 'create', path: 'app/components/Value.vue', beforeHash: null, content: '' }] });
});

test('duplicate and case-folded file/parent collisions are rejected in either order', () => {
  for (const paths of [['src/a.ts', 'src/a.ts'], ['src/a.ts', 'SRC/A.ts'], ['src/component', 'src/component/value.ts'],
    ['src/component/value.ts', 'SRC/Component']]) {
    invalidDraft({ ...createCompanyChangeDraft(), changes: paths.map(path => ({ operation: 'create', path, beforeHash: null, content: '' })) });
  }
});

test('new branch syntax matches its work type and never names the declared baseline even with different case', () => {
  const draft = createCompanyChangeDraft();
  for (const branch of ['main', 'feature/synthetic-change', 'fix/', 'fix//x', 'fix/../x', 'fix/.x', 'fix/x.lock', 'fix/x.', 'fix/x@{1}', '-fix/x']) {
    invalidDraft({ ...draft, branch });
  }
  invalidDraft({ ...draft, baseBranch: 'FIX/Synthetic-Change' });
  for (const baseBranch of ['HEAD', '../main', 'refs/heads/main', 'main.lock']) invalidDraft({ ...draft, baseBranch });
  for (const workType of ['feature', 'fix', 'chore', 'refactor'] as const) parseCompanyChangeDraft({ ...draft, workType, branch: `${workType}/synthetic-change` });
});

test('replace/create before hashes are explicit and unchanged replacements cannot be approved', () => {
  const draft = createCompanyChangeDraft(), replace = draft.changes[0]!, create = draft.changes[1]!;
  for (const change of [{ ...replace, beforeHash: null }, { ...replace, beforeHash: 'A'.repeat(64) },
    { ...replace, beforeHash: hashCompanyChangeValue(replace.content) }, { ...create, beforeHash: '0'.repeat(64) },
    { ...replace, operation: 'delete' }, { ...replace, operation: 'rename' }]) invalidDraft({ ...draft, changes: [change] });
});

test('content and objective reject malformed UTF-8, binary controls and supported sensitive patterns with fixed errors', () => {
  const draft = createCompanyChangeDraft();
  const sensitive = ['\ud800', '\udfff', 'value\0binary', '\u001b[31m', 'Bearer syntheticCredentialValue',
    'const password = "synthetic-only-value";', 'sk-' + 'A'.repeat(20),
    '-----BEGIN PRIVATE KEY-----\nsynthetic-only\n-----END PRIVATE KEY-----'];
  for (const content of sensitive) {
    invalidDraft({ ...draft, changes: [{ ...draft.changes[1], content }] });
    invalidDraft({ ...draft, objective: content });
  }
  invalidDraft({ ...draft, objective: ' \r\n\t' });
  parseCompanyChangeDraft({ ...draft, changes: [{ ...draft.changes[1], content: '안녕하세요 🌱\r\n\ttext\n' }] });
});

test('plan validation rejects authority, hash, lifetime, limit and version changes without trusting declared metadata', () => {
  const { plan } = createCompanyChangeFixture();
  for (const value of [{ ...plan, executionAllowed: true }, { ...plan, transmissionAllowed: true }, { ...plan, sourceVerification: 'passed' },
    { ...plan, approvalScope: 'apply' }, { ...plan, version: 'company-relay-plan-v1' }, { ...plan, draft: {} },
    { ...plan, changeCount: 9 }, { ...plan, changeCount: 0 }, { ...plan, limitsHash: '0'.repeat(64) },
    { ...plan, expiresAt: new Date(Date.parse(plan.expiresAt) + 1).toISOString() },
    { ...plan, auditExpiresAt: new Date(Date.parse(plan.auditExpiresAt) - 1).toISOString() }, { ...plan, planHash: '0'.repeat(64) }]) {
    assert.throws(() => assertCompanyChangePlan(value), { code: 'COMPANY_CHANGE_INVALID_PLAN' });
  }
});

test('invalid time, date overflow, owner and ID fail with fixed errors before a plan is returned', () => {
  const { draft, context } = createCompanyChangeFixture();
  for (const now of [new Date('invalid'), new Date(8_640_000_000_000_000), new Date('9999-12-31T00:00:00.000Z')]) {
    assert.throws(() => createCompanyChangePlan(draft, { ...context, now }), { code: 'COMPANY_CHANGE_INVALID_TIME' });
  }
  assert.throws(() => assertCompanyChangeContext({ ...context, ownerId: 'os-user:999999999' }), { code: 'COMPANY_CHANGE_OWNER_MISMATCH' });
  assert.throws(() => createCompanyChangePlan(draft, context, '../../id'), { code: 'COMPANY_CHANGE_INVALID_ID' });
});

test('review-only approval requests accept exact bounded integer TTLs and no extra authority', () => {
  const { plan } = createCompanyChangeFixture(), request = { taskId: plan.id, planHash: plan.planHash, expiresInMinutes: 10 };
  for (const expiresInMinutes of [1, 60]) assertCompanyChangeApprovalRequest({ ...request, expiresInMinutes });
  for (const value of [0, 61, 1.5, '10', NaN]) assert.throws(() => assertCompanyChangeApprovalRequest({ ...request, expiresInMinutes: value }), { code: 'COMPANY_CHANGE_INVALID_APPROVAL' });
  assert.throws(() => assertCompanyChangeApprovalRequest({ ...request, executionAllowed: true }), { code: 'COMPANY_CHANGE_INVALID_APPROVAL' });
});

test('approval metadata binds the plan and owner, forbids consumption, and cannot extend the plan deadline', () => {
  const { plan } = createCompanyChangeFixture();
  const approval: CompanyChangeApproval = { id: '22222222-2222-4222-8222-222222222222', taskId: plan.id, ownerId: plan.ownerId,
    planHash: plan.planHash, createdAt: plan.createdAt, expiresAt: new Date(Date.parse(plan.createdAt) + 60_000).toISOString(),
    revokedAt: null, usedAt: null, scope: 'review-only', executionAllowed: false };
  assertCompanyChangeApproval(plan, approval);
  assertCompanyChangeApproval(plan, { ...approval, revokedAt: approval.expiresAt });
  for (const value of [{ ...approval, taskId: approval.id }, { ...approval, ownerId: 'os-user:999999999' },
    { ...approval, planHash: '0'.repeat(64) }, { ...approval, usedAt: approval.createdAt }, { ...approval, scope: 'execute' },
    { ...approval, executionAllowed: true }, { ...approval, expiresAt: new Date(Date.parse(approval.expiresAt) + 1).toISOString() },
    { ...approval, revokedAt: new Date(Date.parse(approval.createdAt) - 1).toISOString() },
    { ...approval, createdAt: new Date(Date.parse(plan.expiresAt) - 30_000).toISOString(), expiresAt: new Date(Date.parse(plan.expiresAt) + 30_000).toISOString() }]) {
    assert.throws(() => assertCompanyChangeApproval(plan, value), { code: 'COMPANY_CHANGE_INVALID_APPROVAL' });
  }
});
