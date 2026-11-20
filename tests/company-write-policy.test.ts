import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CompanyWritePlan, CompanyWriteRegistration, CompanyWriteSource } from '../src/domain/company-write.js';
import { HarnessError } from '../src/domain/errors.js';
import { getCompanyChangeLimitsHash, hashCompanyChangeValue } from '../src/policy/company-change.js';
import { getSyntheticCompanyChangeLimitsHash } from '../src/policy/synthetic-company-change.js';
import { canonicalReadonlyJson } from '../src/policy/readonly-investigation-policy.js';
import { assertCompanyWriteApproval, assertCompanyWriteApprovalRequest, assertCompanyWriteContext, assertCompanyWriteDraftForPlan,
  assertCompanyWritePlan, assertCompanyWriteSource, copyCompanyWriteData, createCompanyWriteApproval, createCompanyWritePlan,
  getCompanyWriteLimits, getCompanyWriteLimitsHash, hashCompanyWriteRegistration, parseCompanyWriteRegistration } from '../src/policy/company-write.js';
import { createCompanyChangeDraft, createCompanyChangeFixture } from './company-change-fixture.js';

const fixture = () => {
  const draft = createCompanyChangeDraft();
  const registration: CompanyWriteRegistration = { version: 'company-write-registration-v1', repoId: draft.repoId,
    sourceRoot: '/private/tmp/declared-only-company-write-example/repository', baseBranch: draft.baseBranch,
    baseCommit: draft.baseCommit, baseIndexHash: draft.baseIndexHash,
    writeAllowedFiles: draft.changes.map(change => change.path), enabled: true, localRead: 'allowed', localWrite: 'allowed' };
  const source: CompanyWriteSource = { rootIdentityHash: '3'.repeat(64),
    headHash: hashCompanyChangeValue('ref: refs/heads/main\n'), indexHash: registration.baseIndexHash,
    baseRefHash: hashCompanyChangeValue(`${registration.baseCommit}\n`), files: draft.changes.map(change => ({
      path: change.path, beforeHash: change.beforeHash, mode: change.operation === 'replace' ? 0o644 : null,
      identityHash: change.operation === 'replace' ? '4'.repeat(64) : null, parentIdentityHash: '5'.repeat(64),
    })) };
  const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date('2026-01-01T00:00:00.000Z') };
  const id = '11111111-1111-4111-8111-111111111111', { plan } = createCompanyWritePlan(draft, registration, source, context, id);
  return { draft, registration, source, context, id, plan };
};
const requestFor = (plan: CompanyWritePlan, expiresInMinutes = 10) => ({ taskId: plan.id, planHash: plan.planHash, expiresInMinutes });
const rehash = (value: CompanyWritePlan): CompanyWritePlan => ({ ...value,
  planHash: hashCompanyChangeValue(canonicalReadonlyJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'planHash')))) });
const fixedFailure = (operation: () => unknown, code: string): void => {
  assert.throws(operation, error => {
    assert.ok(error instanceof HarnessError); assert.equal(error.code, `COMPANY_WRITE_${code}`); assert.equal(error.message, error.code); return true;
  });
};

test('public registration example is disabled and unconfirmed; parser performs declared-input validation only', () => {
  const example = parseCompanyWriteRegistration(JSON.parse(readFileSync('config/company-write-registration.example.json', 'utf8')));
  assert.equal(example.enabled, false); assert.equal(example.localRead, 'unconfirmed'); assert.equal(example.localWrite, 'unconfirmed');
  const { draft, source, context, registration } = fixture();
  assert.equal(parseCompanyWriteRegistration(registration).sourceRoot, registration.sourceRoot);
  for (const disabled of [{ ...registration, enabled: false }, { ...registration, localRead: 'unconfirmed' },
    { ...registration, localWrite: 'unconfirmed' }]) {
    fixedFailure(() => createCompanyWritePlan(draft, disabled, source, context), 'REGISTRATION_DISABLED');
  }
});

test('registration rejects unknown authority, credentials and non-normalized or secret directory declarations', () => {
  const { registration } = fixture();
  for (const modified of [{ ...registration, envFile: '/synthetic/.env' }, { ...registration, auth: 'synthetic-only' },
    { ...registration, version: 'company-readonly-registration-v3' }, { ...registration, enabled: 'true' },
    { ...registration, localRead: true }, { ...registration, localWrite: 'approved' }]) {
    fixedFailure(() => parseCompanyWriteRegistration(modified), 'INVALID_REGISTRATION');
  }
  for (const sourceRoot of ['relative/root', '/', '/private/tmp/a/../b', '/private//tmp/a', '/private/tmp/a/',
    '/private/tmp/.git/repository', '/private/tmp/.ssh/repository', '/private/tmp/.env/repository', '/private/tmp/a\\b',
    '/private/tmp/"quoted"', "/private/tmp/'quoted'", '/private/tmp/`quoted`', '/private/tmp/control\nvalue', '/private/tmp/\ud800']) {
    fixedFailure(() => parseCompanyWriteRegistration({ ...registration, sourceRoot }), 'INVALID_REGISTRATION');
  }
  parseCompanyWriteRegistration({ ...registration, sourceRoot: '/private/tmp/space in declared root/repository' });
});

test('registered write paths use the existing strict file policy and reject count, casefold and parent collisions', () => {
  const { registration } = fixture();
  for (const writeAllowedFiles of [[], ['../outside.ts'], ['.git/config'], ['.env'], ['node_modules/a.ts'],
    ['src/a.ts', 'SRC/A.ts'], ['src/a', 'src/a/b.ts'], Array.from({ length: 9 }, (_, index) => `src/${index}.ts`)]) {
    fixedFailure(() => parseCompanyWriteRegistration({ ...registration, writeAllowedFiles }), 'INVALID_REGISTRATION');
  }
  parseCompanyWriteRegistration({ ...registration, writeAllowedFiles: Array.from({ length: 8 }, (_, index) => `src/${index}.ts`) });
});

test('source evidence requires paired absence metadata, non-executable permission bits and exact safe paths', () => {
  const { source } = fixture(); assertCompanyWriteSource(source);
  for (const file of [{ ...source.files[0], mode: 0o100644 }, { ...source.files[0], mode: 0o755 },
    { ...source.files[0], mode: -1 }, { ...source.files[0], identityHash: null },
    { ...source.files[1], mode: 0o600 }, { ...source.files[1], identityHash: '6'.repeat(64) },
    { ...source.files[1], parentIdentityHash: null }, { ...source.files[0], path: '.git/HEAD' }]) {
    fixedFailure(() => assertCompanyWriteSource({ ...source, files: [file] }), 'INVALID_SOURCE');
  }
  fixedFailure(() => assertCompanyWriteSource({ ...source, sourceRoot: '/unbound' }), 'INVALID_SOURCE');
  fixedFailure(() => assertCompanyWriteSource({ ...source, files: [source.files[0], source.files[0]] }), 'INVALID_SOURCE');
});

test('plans bind exact raw HEAD, loose base ref, index hash and ordered selected-file evidence', () => {
  const { draft, registration, source, context } = fixture();
  for (const changed of [{ ...source, headHash: '6'.repeat(64) }, { ...source, indexHash: '7'.repeat(64) },
    { ...source, baseRefHash: hashCompanyChangeValue(registration.baseCommit) }, { ...source, files: [...source.files].reverse() },
    { ...source, files: source.files.slice(0, 1) },
    { ...source, files: [{ ...source.files[0]!, beforeHash: '8'.repeat(64) }, source.files[1]!] }]) {
    fixedFailure(() => createCompanyWritePlan(draft, registration, changed, context), 'SOURCE_MISMATCH');
  }
});

test('the draft must match registration baseline and its exact allowlist; the target branch has one leaf', () => {
  const { draft, registration, source, context } = fixture();
  for (const changed of [{ ...draft, repoId: 'other-synthetic-id' }, { ...draft, baseCommit: '6'.repeat(40) },
    { ...draft, baseIndexHash: '6'.repeat(64) }, { ...draft, baseBranch: 'other-base' }]) {
    fixedFailure(() => createCompanyWritePlan(changed, registration, source, context), 'REGISTRATION_MISMATCH');
  }
  fixedFailure(() => createCompanyWritePlan(draft, { ...registration, writeAllowedFiles: ['src/other.ts'] }, source, context), 'WRITE_SCOPE_MISMATCH');
  fixedFailure(() => createCompanyWritePlan({ ...draft, branch: 'fix/nested/leaf' }, registration, source, context), 'WRITE_SCOPE_MISMATCH');
  fixedFailure(() => createCompanyWritePlan({ ...draft, changes: [{ ...draft.changes[0], content: 'Bearer syntheticCredentialValue' }] }, registration, source, context), 'INVALID_DRAFT');
});

test('plans contain no source root, objective or body, and do not inherit company or product-check authority', () => {
  const { draft, registration, source, context, id, plan } = fixture();
  assertCompanyWritePlan(plan); assertCompanyWriteDraftForPlan(plan, draft, registration);
  assert.equal(plan.scope, 'synthetic-validation'); assert.equal(plan.checks, 'not_run'); assert.equal(plan.transmissionAllowed, false);
  assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 86_400_000);
  for (const body of [registration.sourceRoot, draft.objective, ...draft.changes.map(change => change.content)]) {
    assert.equal(JSON.stringify(plan).includes(body), false);
  }
  const result = createCompanyWritePlan(draft, registration, source, context, id);
  registration.sourceRoot = '/private/tmp/changed'; source.files[0]!.mode = 0o600; draft.changes[0]!.content = 'caller mutation';
  assert.notEqual(result.plan.source.files[0]!.mode, source.files[0]!.mode);
  assert.notEqual(result.draft.changes[0]!.content, draft.changes[0]!.content);
  const copied = copyCompanyWriteData(result.plan); copied.changes[0]!.path = 'changed.ts'; assertCompanyWritePlan(result.plan);
});

test('registration and plan hashes bind location, owner, policy, scope, selected metadata and canonical input values', () => {
  const { draft, registration, source, context, id, plan } = fixture();
  const reordered = Object.fromEntries(Object.entries(registration).reverse());
  assert.equal(hashCompanyWriteRegistration(reordered), plan.registrationHash);
  for (const changed of [{ ...registration, sourceRoot: '/private/tmp/another-declared-root' },
    { ...registration, writeAllowedFiles: [...registration.writeAllowedFiles].reverse() }]) {
    assert.notEqual(createCompanyWritePlan(draft, changed, source, context, id).plan.planHash, plan.planHash);
    fixedFailure(() => assertCompanyWriteDraftForPlan(plan, draft, changed), 'REGISTRATION_MISMATCH');
  }
  const otherIdentity = { ...source, rootIdentityHash: '7'.repeat(64) };
  assert.notEqual(createCompanyWritePlan(draft, registration, otherIdentity, context, id).plan.planHash, plan.planHash);
  fixedFailure(() => assertCompanyWriteDraftForPlan(plan, { ...draft, requestRevision: 2 }, registration), 'DRAFT_PLAN_MISMATCH');
});

test('plan validation rejects contract promotion, malformed descriptors and mismatched source entries even after rehashing', () => {
  const { plan } = fixture();
  for (const input of [createCompanyChangeFixture().plan, { ...plan, version: 'synthetic-company-change-apply-v1' },
    { ...plan, scope: 'company' }, { ...plan, checks: 'passed' }, { ...plan, transmissionAllowed: true },
    { ...plan, sourceRoot: '/unbound/path' }, { ...plan, limitsHash: '0'.repeat(64) }, { ...plan, planHash: '0'.repeat(64) }]) {
    fixedFailure(() => assertCompanyWritePlan(input), 'INVALID_PLAN');
  }
  for (const changed of [{ ...plan.changes[0]!, path: 'src/other.ts' }, { ...plan.changes[0]!, bytes: 65_537 },
    { ...plan.changes[0]!, afterHash: plan.changes[0]!.beforeHash! }, { ...plan.changes[0]!, bytes: 0 },
    { ...plan.changes[0]!, operation: 'create' as const }, { ...plan.changes[0]!, content: 'body must not persist' }]) {
    fixedFailure(() => assertCompanyWritePlan(rehash({ ...plan, changes: [changed, plan.changes[1]!] })), 'INVALID_PLAN');
  }
});

test('new immutable limits fix worker and selected-input budgets without modifying old policy hashes', () => {
  const legacy = [getCompanyChangeLimitsHash(), getSyntheticCompanyChangeLimitsHash()], limits = getCompanyWriteLimits();
  assert.deepEqual(limits, { maxChanges: 8, maxContentBytes: 65_536, maxTotalContentBytes: 131_072, maxDraftJsonBytes: 262_144,
    maxRegistrationJsonBytes: 16_384, maxPlanJsonBytes: 16_384, maxWorkerInputBytes: 327_680, maxIndexBytes: 1_048_576,
    maxGitTextBytes: 1024, planLifetimeMs: 86_400_000, minApprovalMinutes: 1, maxApprovalMinutes: 60,
    workerWallTimeMs: 30_000, terminationGraceMs: 250, maxWorkerOutputBytes: 16_384, workerOldSpaceMiB: 128 });
  assert.equal(Object.isFrozen(limits), true); assert.throws(() => Object.assign(limits, { maxChanges: 9 }), TypeError);
  assert.equal(legacy.includes(getCompanyWriteLimitsHash()), false);
  assert.deepEqual([getCompanyChangeLimitsHash(), getSyntheticCompanyChangeLimitsHash()], legacy);
});

test('approval creation binds exact task, plan, OS owner and full integer TTL without clamping', () => {
  const { plan, context } = fixture();
  for (const minutes of [1, 60]) {
    const approval = createCompanyWriteApproval(plan, requestFor(plan, minutes), context);
    assertCompanyWriteApproval(plan, approval); assert.equal(approval.version, 'company-write-approval-v1');
    assert.equal(approval.scope, 'synthetic-validation'); assert.equal(approval.usedAt, null);
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt), minutes * 60_000);
  }
  const near = { ...context, now: new Date(Date.parse(plan.expiresAt) - 59_999) };
  fixedFailure(() => createCompanyWriteApproval(plan, requestFor(plan, 1), near), 'APPROVAL_EXCEEDS_PLAN_TTL');
  const exact = { ...context, now: new Date(Date.parse(plan.expiresAt) - 60_000) };
  assert.equal(createCompanyWriteApproval(plan, requestFor(plan, 1), exact).expiresAt, plan.expiresAt);
  fixedFailure(() => createCompanyWriteApproval(plan, { ...requestFor(plan), planHash: '0'.repeat(64) }, context), 'PLAN_MISMATCH');
  fixedFailure(() => createCompanyWriteApproval(plan, requestFor(plan), { ...context, ownerId: 'os-user:99999999' }), 'OWNER_MISMATCH');
});

test('review or synthetic approvals cannot be promoted and consumption metadata must fall before expiry', () => {
  const { plan, context } = fixture(), approval = createCompanyWriteApproval(plan, requestFor(plan), context);
  assertCompanyWriteApproval(plan, { ...approval, usedAt: approval.createdAt });
  for (const changed of [{ ...approval, version: 'company-change-review-v1' }, { ...approval, scope: 'review-only' },
    { ...approval, scope: 'synthetic-apply' }, { ...approval, revokedAt: null }, { ...approval, executionAllowed: true },
    { ...approval, usedAt: approval.expiresAt }, { ...approval, usedAt: new Date(Date.parse(approval.createdAt) - 1).toISOString() },
    { ...approval, expiresAt: new Date(Date.parse(approval.expiresAt) + 1).toISOString() }]) {
    fixedFailure(() => assertCompanyWriteApproval(plan, changed), 'INVALID_APPROVAL');
  }
  for (const minutes of [0, 61, 1.5, '10', NaN]) fixedFailure(() => assertCompanyWriteApprovalRequest({ ...requestFor(plan), expiresInMinutes: minutes }), 'INVALID_APPROVAL');
});

test('all contract boundaries reject accessors and proxies without invoking caller traps', () => {
  const { draft, registration, source, context, plan } = fixture(); let traps = 0;
  const accessor = { ...registration };
  Object.defineProperty(accessor, 'sourceRoot', { enumerable: true, get: () => { traps++; return registration.sourceRoot; } });
  fixedFailure(() => parseCompanyWriteRegistration(accessor), 'INVALID_REGISTRATION');
  const handler = { get: () => { traps++; throw new Error('synthetic proxy trap'); }, ownKeys: () => { traps++; throw new Error('synthetic proxy trap'); } };
  fixedFailure(() => parseCompanyWriteRegistration(new Proxy(registration, handler)), 'INVALID_REGISTRATION');
  fixedFailure(() => parseCompanyWriteRegistration({ ...registration, writeAllowedFiles: new Proxy(registration.writeAllowedFiles, handler) }), 'INVALID_REGISTRATION');
  fixedFailure(() => createCompanyWritePlan(new Proxy(draft, handler), registration, source, context), 'INVALID_DRAFT');
  fixedFailure(() => createCompanyWritePlan({ ...draft, changes: [new Proxy(draft.changes[0]!, handler)] }, registration, source, context), 'INVALID_DRAFT');
  fixedFailure(() => assertCompanyWriteSource({ ...source, files: new Proxy(source.files, handler) }), 'INVALID_SOURCE');
  fixedFailure(() => assertCompanyWritePlan(new Proxy(plan, handler)), 'INVALID_PLAN');
  fixedFailure(() => assertCompanyWriteApprovalRequest(new Proxy(requestFor(plan), handler)), 'INVALID_APPROVAL');
  assert.equal(traps, 0);
});

test('invalid, extended or overflowing dates and invalid IDs fail with fixed errors', () => {
  const { draft, registration, source, context, plan } = fixture();
  for (const now of [new Date('invalid'), new Date(8_640_000_000_000_000), new Date('9999-12-31T00:00:00.000Z')]) {
    fixedFailure(() => createCompanyWritePlan(draft, registration, source, { ...context, now }), 'INVALID_TIME');
  }
  fixedFailure(() => assertCompanyWriteContext({ ...context, ownerId: 'os-user:99999999' }), 'OWNER_MISMATCH');
  fixedFailure(() => createCompanyWritePlan(draft, registration, source, context, '../../id'), 'INVALID_ID');
  fixedFailure(() => createCompanyWriteApproval(plan, requestFor(plan), { ...context, now: new Date(plan.expiresAt) }), 'EXPIRED');
  const far = createCompanyWritePlan(draft, registration, source, { ...context, now: new Date('9999-12-30T23:59:59.999Z') }).plan;
  fixedFailure(() => createCompanyWriteApproval(far, requestFor(far, 1), { ...context, now: new Date('9999-12-31T23:59:30.000Z') }), 'APPROVAL_EXCEEDS_PLAN_TTL');
});
