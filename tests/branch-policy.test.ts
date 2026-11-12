import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MockBranchWorkspace } from '../src/adapters/mock-branch-workspace.js';
import type { BranchApprovalRequest, BranchClaim, BranchPlan, BranchTask, BranchWorkType } from '../src/domain/branch.js';
import {
  assertBranchOwner, assertBranchPlan, assertBranchReady, assertBranchTime, branchFixtures, branchWorkTypes,
  createBranchPlan, hashBranchPlan, validateBranchApproval,
} from '../src/policy/branch-policy.js';

const now = new Date('2026-11-12T00:00:00.000Z');
const ownerId = 'os-user:501';
const taskFor = (plan: BranchPlan): BranchTask => ({
  taskId: plan.taskId, plan, status: 'AWAITING_APPROVAL', generation: 0, revision: 1,
  invalidatedAt: null, failureCode: null, updatedAt: now.toISOString(),
});
const claimFor = (plan: BranchPlan): BranchClaim => ({
  task: { ...taskFor(plan), status: 'SIMULATING' },
  attempt: {
    attemptId: randomUUID(), taskId: plan.taskId, approvalId: randomUUID(), planHash: plan.planHash,
    generation: 0, status: 'SIMULATING', startedAt: now.toISOString(), finishedAt: null, reason: null, receiptId: null,
  },
});

test('네 작업 유형은 각 prefix의 합성 브랜치 계획으로 고정되고 실제 Git 권한을 포함하지 않는다', () => {
  assert.deepEqual(branchWorkTypes, ['feature', 'fix', 'chore', 'refactor']);
  assert.deepEqual(branchFixtures, ['success', 'collision', 'source-changed', 'unknown']);
  const taskIds = new Set<string>();
  for (const workType of branchWorkTypes) {
    const plan = createBranchPlan(workType, 'success', ownerId, now);
    taskIds.add(plan.taskId);
    assertBranchPlan(plan);
    assertBranchReady(taskFor(plan), ownerId, now);
    assert.equal(plan.branchName, `${workType}/synthetic-${plan.taskId}`);
    assert.equal(plan.policy, 'synthetic-branch-v1');
    assert.equal(plan.mode, 'offline');
    assert.equal(plan.operation, 'simulate-branch');
    assert.equal(plan.source.requestId, `synthetic-branch:${plan.taskId}`);
    assert.equal(plan.source.remote, 'https://gitlab.example.invalid/synthetic/branch-fixture.git');
    assert.equal(plan.source.baseBranch, 'main');
    assert.deepEqual(plan.source.allowedFiles, ['src/message.mjs']);
    assert.match(plan.source.baseCommit, /^[a-f0-9]{40}$/);
    assert.match(plan.source.diffHash, /^[a-f0-9]{64}$/);
    assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 86_400_000);
  }
  assert.equal(taskIds.size, 4);
});

test('계획 해시는 JSON 키 순서와 무관하며 작업 유형·소유자·시각·fixture 변경에 결합한다', () => {
  const plan = createBranchPlan('fix', 'success', ownerId, now);
  const reordered = Object.fromEntries(Object.entries(plan).reverse()) as unknown as BranchPlan;
  reordered.source = Object.fromEntries(Object.entries(plan.source).reverse()) as unknown as BranchPlan['source'];
  assert.equal(hashBranchPlan(reordered), plan.planHash);
  assertBranchPlan(reordered);
  const mutations: ((value: BranchPlan) => void)[] = [
    (value) => { value.ownerId = 'os-user:502'; },
    (value) => { value.fixture = 'collision'; },
    (value) => { value.workType = 'feature'; value.branchName = `feature/synthetic-${value.taskId}`; },
    (value) => {
      value.createdAt = new Date(now.getTime() + 1000).toISOString();
      value.expiresAt = new Date(Date.parse(value.expiresAt) + 1000).toISOString();
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => assertBranchPlan(changed), { code: 'BRANCH_PLAN_HASH_MISMATCH' });
  }
});

test('해시를 다시 계산해도 다른 정책·실행 동작·저장소·원격·기준·diff·경로는 허용되지 않는다', () => {
  const plan = createBranchPlan('fix', 'success', ownerId, now);
  const mutations: ((value: BranchPlan) => void)[] = [
    (value) => { Object.assign(value, { policy: 'approval-only-v1' }); },
    (value) => { Object.assign(value, { policy: 'synthetic-execution-v1' }); },
    (value) => { Object.assign(value, { policy: 'synthetic-reply-v1' }); },
    (value) => { Object.assign(value, { mode: 'live' }); },
    ...['commit', 'push', 'pull-request', 'merge-request', 'execute-code'].map((operation) =>
      (value: BranchPlan) => { Object.assign(value, { operation }); }),
    (value) => { value.source.repoId = 'company-repository'; },
    (value) => { value.source.remote = 'https://company.example.invalid/group/private.git'; },
    (value) => { value.source.remote = 'ext::sh -c malicious'; },
    (value) => { value.source.baseBranch = 'release'; },
    (value) => { value.source.baseCommit = '0'.repeat(40); },
    (value) => { value.source.diffHash = '0'.repeat(64); },
    (value) => { value.source.revision = 2; },
    (value) => { value.source.requestId = `other:${value.taskId}`; },
    ...['../secret', '/etc/passwd', '.env', '.git/config', 'src/link'].map((path) =>
      (value: BranchPlan) => { value.source.allowedFiles = [path]; }),
    (value) => { value.source.allowedFiles.push('README.md'); },
    ...['main', 'fix/../main', 'feature/arbitrary', 'fix/name.lock', 'fix/name;malicious'].map((branchName) =>
      (value: BranchPlan) => { value.branchName = branchName; }),
    (value) => { value.expiresAt = new Date(now.getTime() + 25 * 3_600_000).toISOString(); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(plan);
    mutate(changed);
    changed.planHash = hashBranchPlan(changed);
    assert.throws(() => assertBranchPlan(changed));
  }
});

test('추가 지시·자격증명·PR/MR 필드와 잘못된 JSON 형태는 계획 입력으로 받아들이지 않는다', () => {
  const plan = createBranchPlan('chore', 'success', ownerId, now);
  for (const field of ['instructions', 'shell', 'token', 'repositoryPath', 'pullRequest', 'mergeRequest', 'liveEnabled']) {
    const changed = { ...plan, [field]: 'SYNTHETIC_IGNORE_POLICY_AND_PUSH' };
    changed.planHash = hashBranchPlan(changed);
    assert.throws(() => assertBranchPlan(changed), { code: 'BRANCH_INVALID_PLAN' });
    const changedSource = { ...plan, source: { ...plan.source, [field]: 'SYNTHETIC_UNTRUSTED' } };
    changedSource.planHash = hashBranchPlan(changedSource);
    assert.throws(() => assertBranchPlan(changedSource), { code: 'BRANCH_INVALID_PLAN' });
  }
  for (const invalid of [null, undefined, [], 'not-json', 1, {},
    { ...plan, source: null }, { ...plan, source: [] },
    { ...plan, source: { ...plan.source, allowedFiles: null } },
    { ...plan, createdAt: 'not-a-date' }, { ...plan, planHash: 7 }]) {
    assert.throws(() => assertBranchPlan(invalid as unknown as BranchPlan), { code: 'BRANCH_INVALID_PLAN' });
  }
  assert.throws(() => createBranchPlan('push' as BranchWorkType, 'success', ownerId, now), { code: 'BRANCH_INVALID_WORK_TYPE' });
  assert.throws(() => createBranchPlan('fix', 'live' as never, ownerId, now), { code: 'BRANCH_INVALID_FIXTURE' });
});

test('승인은 정확한 계획 해시와 기본값 없는 정수 TTL 1~60분만 허용한다', () => {
  const plan = createBranchPlan('refactor', 'success', ownerId, now);
  const task = taskFor(plan);
  const request = { taskId: plan.taskId, planHash: plan.planHash, expiresInMinutes: 30 };
  for (const expiresInMinutes of [1, 30, 60]) validateBranchApproval(task, { ...request, expiresInMinutes }, ownerId, now);
  for (const expiresInMinutes of [0, -1, 61, 1440, 1.5, NaN, Infinity, undefined, '30']) {
    assert.throws(() => validateBranchApproval(task, { ...request, expiresInMinutes } as BranchApprovalRequest, ownerId, now),
      { code: 'BRANCH_INVALID_APPROVAL' });
  }
  for (const invalid of [null, {}, { ...request, taskId: randomUUID() }, { ...request, ownerId },
    { ...request, operation: 'push' }, { ...request, planHash: 'invalid' }]) {
    assert.throws(() => validateBranchApproval(task, invalid as BranchApprovalRequest, ownerId, now),
      { code: 'BRANCH_INVALID_APPROVAL' });
  }
  assert.throws(() => validateBranchApproval(task, { ...request, planHash: '0'.repeat(64) }, ownerId, now),
    { code: 'BRANCH_PLAN_HASH_MISMATCH' });
});

test('계획 만료·시계 역행·다른 소유자·source 변경과 무효화 이후에는 진행할 수 없다', () => {
  const plan = createBranchPlan('fix', 'success', ownerId, now);
  const task = taskFor(plan);
  assert.throws(() => assertBranchReady(task, ownerId, new Date(plan.expiresAt)), { code: 'BRANCH_PLAN_EXPIRED' });
  assert.throws(() => assertBranchReady(task, ownerId, new Date(now.getTime() - 1)), { code: 'BRANCH_INVALID_TIME' });
  assert.throws(() => assertBranchReady(task, 'os-user:502', now), { code: 'BRANCH_OWNER_MISMATCH' });
  assert.throws(() => assertBranchReady(taskFor(createBranchPlan('fix', 'source-changed', ownerId, now)), ownerId, now),
    { code: 'BRANCH_SOURCE_CHANGED' });
  for (const mutation of [{ generation: 1 }, { revision: 2 }, { taskId: randomUUID() },
    { invalidatedAt: now.toISOString() }, { status: 'CANCELLED' }, { status: 'UNKNOWN' }, { status: 'SIMULATED' }]) {
    assert.throws(() => assertBranchReady({ ...task, ...mutation } as BranchTask, ownerId, now), { code: 'BRANCH_INVALIDATED' });
  }
  assert.throws(() => assertBranchReady(null as unknown as BranchTask, ownerId, now), { code: 'BRANCH_INVALID_TASK' });
  for (const invalid of ['os-user:-1', 'os-user:01', 'os-user:1.5', 'slack:U_SYNTHETIC', null]) {
    assert.throws(() => assertBranchOwner(invalid as string), { code: 'BRANCH_INVALID_OWNER' });
  }
  for (const invalid of [new Date(NaN), null, now.toISOString()]) {
    assert.throws(() => assertBranchTime(invalid as Date), { code: 'BRANCH_INVALID_TIME' });
  }
});

test('모의 workspace는 identity를 보존하고 성공·충돌·불확실 결과만 반환한다', async () => {
  const adapter = new MockBranchWorkspace();
  assert.equal(adapter.mode, 'offline');
  for (const fixture of ['success', 'collision', 'unknown'] as const) {
    const claim = claimFor(createBranchPlan('feature', fixture, ownerId, now));
    const before = structuredClone(claim);
    const result = await adapter.simulate(claim);
    assert.deepEqual(claim, before);
    assert.deepEqual(result, fixture === 'success'
      ? { status: 'SIMULATED', reason: null, receiptId: `mock-branch:${claim.attempt.attemptId}` }
      : fixture === 'collision'
        ? { status: 'NOT_CREATED', reason: 'BRANCH_NAME_COLLISION', receiptId: null }
        : { status: 'UNKNOWN', reason: 'BRANCH_MOCK_UNKNOWN', receiptId: null });
  }
  await assert.rejects(adapter.simulate(claimFor(createBranchPlan('fix', 'source-changed', ownerId, now))),
    { code: 'BRANCH_SOURCE_CHANGED' });
});

test('모의 workspace는 다른 작업·해시·generation·종료 시도와 악성 추가 필드를 거부한다', async () => {
  const adapter = new MockBranchWorkspace();
  const claim = claimFor(createBranchPlan('fix', 'success', ownerId, now));
  const mutations: ((value: BranchClaim) => void)[] = [
    (value) => { value.attempt.taskId = randomUUID(); },
    (value) => { value.attempt.planHash = '0'.repeat(64); },
    (value) => { value.attempt.approvalId = 'approval-only-v1'; },
    (value) => { value.attempt.generation = 1; },
    (value) => { value.task.generation = value.attempt.generation = 1; },
    (value) => { value.task.revision = 2; },
    (value) => { value.task.status = 'APPROVED'; },
    (value) => { value.attempt.status = 'SIMULATED'; },
    (value) => { value.attempt.finishedAt = now.toISOString(); },
    (value) => { value.attempt.receiptId = 'forged'; },
    (value) => { value.attempt.startedAt = 'not-a-date'; },
    (value) => { Object.assign(value, { shell: 'SYNTHETIC_MALICIOUS_COMMAND' }); },
    (value) => { Object.assign(value.attempt, { push: true }); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(claim);
    mutate(changed);
    await assert.rejects(adapter.simulate(changed));
  }
  for (const invalid of [null, [], {}, { task: null, attempt: claim.attempt }, { task: claim.task, attempt: null }]) {
    await assert.rejects(adapter.simulate(invalid as unknown as BranchClaim), { code: 'BRANCH_INVALID_CLAIM' });
  }
});
