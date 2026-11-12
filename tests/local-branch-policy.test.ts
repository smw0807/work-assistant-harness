import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { BranchWorkType } from '../src/domain/branch.js';
import type {
  LocalBranchApprovalRequest, LocalBranchObservation, LocalBranchPlan, LocalBranchRepository,
} from '../src/domain/local-branch.js';
import {
  assertLocalBranchApprovalRequest, assertLocalBranchObservation, assertLocalBranchOwner, assertLocalBranchPlan,
  assertLocalBranchTime, createLocalBranchPlan, hashLocalBranchPlan,
} from '../src/policy/local-branch-policy.js';

const now = new Date('2026-11-13T00:00:00.000Z');
const ownerId = 'os-user:501';
const repositoryFor = (taskId: string): LocalBranchRepository => ({
  root: `/private/tmp/local-branch-policy-fixture/git-branches/${taskId}`,
  ownerToken: 'a'.repeat(64), baseBranch: 'main', baseCommit: 'b'.repeat(40),
  sourceHash: 'c'.repeat(64), workspaceHash: 'd'.repeat(64),
});
const planFor = (workType: BranchWorkType = 'fix'): LocalBranchPlan => {
  const taskId = randomUUID();
  return createLocalBranchPlan(taskId, workType, ownerId, repositoryFor(taskId), now);
};
const observationFor = (plan: LocalBranchPlan, state: 'absent' | 'created'): LocalBranchObservation => ({
  state, sourceHash: plan.repository.sourceHash, workspaceHash: plan.repository.workspaceHash,
  baseOid: plan.repository.baseCommit, branchOid: state === 'created' ? plan.repository.baseCommit : null, reason: null,
});

test('실제 합성 브랜치 계획은 네 작업 유형·독립 정책·24시간 유효기한과 prepare metadata를 결합한다', () => {
  for (const workType of ['feature', 'fix', 'chore', 'refactor'] as const) {
    const taskId = randomUUID();
    const repository = repositoryFor(taskId);
    const plan = createLocalBranchPlan(taskId, workType, ownerId, repository, now);
    assertLocalBranchPlan(plan);
    assert.equal(plan.taskId, taskId);
    assert.equal(plan.branchName, `${workType}/task-${taskId}`);
    assert.equal(plan.policy, 'local-synthetic-branch-v1');
    assert.equal(plan.mode, 'local-synthetic');
    assert.equal(plan.operation, 'create-branch');
    assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 86_400_000);
    assert.deepEqual(plan.repository, repository);
    repository.ownerToken = 'e'.repeat(64);
    assert.equal(plan.repository.ownerToken, 'a'.repeat(64));
  }
});

test('실제 합성 계획의 해시는 키 순서와 무관하고 저장소·소유자·브랜치·만료 변경을 감지한다', () => {
  const plan = planFor();
  const reordered = Object.fromEntries(Object.entries(plan).reverse()) as unknown as LocalBranchPlan;
  reordered.repository = Object.fromEntries(Object.entries(plan.repository).reverse()) as unknown as LocalBranchRepository;
  assert.equal(hashLocalBranchPlan(reordered), plan.planHash);
  assertLocalBranchPlan(reordered);
  const mutations: ((value: LocalBranchPlan) => void)[] = [
    (value) => { value.ownerId = 'os-user:502'; },
    (value) => { value.workType = 'feature'; value.branchName = `feature/task-${value.taskId}`; },
    (value) => { value.repository.root = `/private/tmp/other/git-branches/${value.taskId}`; },
    (value) => { value.repository.ownerToken = 'e'.repeat(64); },
    (value) => { value.repository.baseCommit = 'e'.repeat(40); },
    (value) => { value.repository.sourceHash = 'e'.repeat(64); },
    (value) => { value.repository.workspaceHash = 'e'.repeat(64); },
    (value) => {
      value.createdAt = new Date(Date.parse(value.createdAt) + 1000).toISOString();
      value.expiresAt = new Date(Date.parse(value.expiresAt) + 1000).toISOString();
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => assertLocalBranchPlan(changed), { code: 'LOCAL_BRANCH_PLAN_HASH_MISMATCH' });
  }
});

test('모의 승인·실전송 정책과 임의 동작·PR/MR·token·shell 필드는 해시를 재계산해도 거부한다', () => {
  const plan = planFor();
  const mutations: ((value: LocalBranchPlan) => void)[] = [
    (value) => { Object.assign(value, { policy: 'synthetic-branch-v1' }); },
    (value) => { Object.assign(value, { policy: 'approval-only-v1' }); },
    (value) => { Object.assign(value, { policy: 'slack-live-test-v1' }); },
    (value) => { Object.assign(value, { mode: 'offline' }); },
    (value) => { Object.assign(value, { mode: 'live' }); },
    ...['simulate-branch', 'commit', 'push', 'pull-request', 'merge-request', 'execute-code'].map((operation) =>
      (value: LocalBranchPlan) => { Object.assign(value, { operation }); }),
    (value) => { Object.assign(value, { workType: 'hotfix' }); },
    (value) => { value.branchName = 'main'; },
    (value) => { value.branchName = `feature/task-${value.taskId}`; },
    (value) => { value.branchName = `fix/task-${randomUUID()}`; },
    (value) => { Object.assign(value.repository, { baseBranch: 'release' }); },
  ];
  for (const field of ['fixture', 'planSnapshot', 'token', 'shell', 'push', 'pullRequest', 'mergeRequest', 'remote']) {
    mutations.push((value) => { Object.assign(value, { [field]: 'SYNTHETIC_UNTRUSTED' }); });
    mutations.push((value) => { Object.assign(value.repository, { [field]: 'SYNTHETIC_UNTRUSTED' }); });
  }
  for (const mutate of mutations) {
    const changed = structuredClone(plan);
    mutate(changed);
    changed.planHash = hashLocalBranchPlan(changed);
    assert.throws(() => assertLocalBranchPlan(changed));
  }
});

test('저장소 root는 동일 작업의 정규 절대 경로만 허용하고 경로 탈출·분리자·제어문자를 거부한다', () => {
  const plan = planFor();
  const roots = [
    `relative/git-branches/${plan.taskId}`, `/private/tmp/../git-branches/${plan.taskId}`,
    `/private/tmp/./git-branches/${plan.taskId}`, `/private//tmp/git-branches/${plan.taskId}`,
    `${plan.repository.root}/`, `${plan.repository.root}/nested`,
    `/private/tmp/git-branches/${randomUUID()}`, `/private/tmp/other-branches/${plan.taskId}`,
    `/private/tmp/space\nname/git-branches/${plan.taskId}`, `/private/tmp/space\u0000name/git-branches/${plan.taskId}`,
    `/private/tmp/back\\slash/git-branches/${plan.taskId}`, `/private/tmp/*/git-branches/${plan.taskId}`,
    `/private/tmp/a,b/git-branches/${plan.taskId}`, `/${'a'.repeat(4096)}/git-branches/${plan.taskId}`,
  ];
  for (const root of roots) {
    const changed = { ...plan, repository: { ...plan.repository, root } };
    changed.planHash = hashLocalBranchPlan(changed);
    assert.throws(() => assertLocalBranchPlan(changed), { code: 'LOCAL_BRANCH_INVALID_REPOSITORY' });
  }
  const hiddenDirectory = { ...plan, repository: { ...plan.repository, root: `/private/tmp/.harness/git-branches/${plan.taskId}` } };
  hiddenDirectory.planHash = hashLocalBranchPlan(hiddenDirectory);
  assertLocalBranchPlan(hiddenDirectory);
});

test('잘못된 JSON 구조·hash·소유자·시각과 24시간이 아닌 계획 만료는 거부한다', () => {
  const plan = planFor();
  for (const invalid of [null, undefined, [], {}, 'invalid-json',
    { ...plan, taskId: '../task' }, { ...plan, repository: null }, { ...plan, repository: [] },
    { ...plan, repository: { ...plan.repository, ownerToken: 'token' } },
    { ...plan, repository: { ...plan.repository, baseCommit: 'f'.repeat(64) } },
    { ...plan, repository: { ...plan.repository, sourceHash: 7 } },
    { ...plan, repository: { ...plan.repository, workspaceHash: 'not-hash' } },
    { ...plan, createdAt: 'invalid' }, { ...plan, planHash: 'f'.repeat(40) }]) {
    assert.throws(() => assertLocalBranchPlan(invalid as unknown as LocalBranchPlan));
  }
  for (const hours of [-1, 0, 23, 25]) {
    const changed = { ...plan, expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString() };
    changed.planHash = hashLocalBranchPlan(changed);
    assert.throws(() => assertLocalBranchPlan(changed), { code: 'LOCAL_BRANCH_INVALID_PLAN' });
  }
  for (const invalid of ['os-user:-1', 'os-user:01', 'os-user:1.5', 'slack:U_SYNTHETIC', null]) {
    assert.throws(() => assertLocalBranchOwner(invalid as string), { code: 'LOCAL_BRANCH_INVALID_OWNER' });
  }
  for (const invalid of [new Date(NaN), null, now.toISOString()]) {
    assert.throws(() => assertLocalBranchTime(invalid as Date), { code: 'LOCAL_BRANCH_INVALID_TIME' });
  }
  assert.throws(() => createLocalBranchPlan('../task', 'fix', ownerId, plan.repository, now), { code: 'LOCAL_BRANCH_INVALID_TASK_ID' });
  assert.throws(() => createLocalBranchPlan(plan.taskId, 'push' as BranchWorkType, ownerId, plan.repository, now),
    { code: 'LOCAL_BRANCH_INVALID_WORK_TYPE' });
  assert.throws(() => createLocalBranchPlan(plan.taskId, 'fix', ownerId, plan.repository, new Date(8_640_000_000_000_000)),
    { code: 'LOCAL_BRANCH_INVALID_TIME' });
});

test('absent와 created 관찰은 원본·작업영역·main을 보존하고 정확한 작업 ref만 구분한다', () => {
  const plan = planFor();
  for (const state of ['absent', 'created'] as const) {
    const observation = observationFor(plan, state);
    assertLocalBranchObservation(observation, plan);
    const mutations: Partial<LocalBranchObservation>[] = [
      { sourceHash: null }, { sourceHash: 'e'.repeat(64) }, { workspaceHash: null }, { workspaceHash: 'e'.repeat(64) },
      { baseOid: null }, { baseOid: 'e'.repeat(40) }, { branchOid: state === 'absent' ? plan.repository.baseCommit : null },
      { branchOid: 'e'.repeat(40) }, { reason: 'LOCAL_BRANCH_UNSAFE_WORKSPACE' },
    ];
    for (const mutation of mutations) {
      assert.throws(() => assertLocalBranchObservation({ ...observation, ...mutation }, plan),
        { code: 'LOCAL_BRANCH_INVALID_OBSERVATION' });
    }
  }
});

test('unsafe 관찰은 부분 해시 증거와 정적 오류 코드만 허용하고 원시 파일명·본문·오류를 받지 않는다', () => {
  const plan = planFor();
  const unsafe: LocalBranchObservation = {
    state: 'unsafe', sourceHash: null, workspaceHash: null, baseOid: null, branchOid: null,
    reason: 'LOCAL_BRANCH_UNSAFE_WORKSPACE',
  };
  assertLocalBranchObservation(unsafe, plan);
  assertLocalBranchObservation({ ...unsafe, sourceHash: 'e'.repeat(64), workspaceHash: 'e'.repeat(64),
    baseOid: 'e'.repeat(40), branchOid: 'e'.repeat(40) }, plan);
  for (const reason of [null, '', '/private/tmp/secret', 'Error: synthetic private value', 'BRANCH_UNSAFE',
    'LOCAL_BRANCH_secret', 'LOCAL_BRANCH_UNSAFE\nVALUE', `LOCAL_BRANCH_${'A'.repeat(81)}`]) {
    assert.throws(() => assertLocalBranchObservation({ ...unsafe, reason }, plan), { code: 'LOCAL_BRANCH_INVALID_OBSERVATION' });
  }
  for (const invalid of [null, [], {}, { ...unsafe, state: 'success' }, { ...unsafe, sourceHash: 'source text' },
    { ...unsafe, workspaceHash: 7 }, { ...unsafe, baseOid: 'f'.repeat(64) }, { ...unsafe, branchOid: 'path' },
    { ...unsafe, path: '/private/tmp/secret' }, { ...unsafe, output: 'SYNTHETIC_PRIVATE' }]) {
    assert.throws(() => assertLocalBranchObservation(invalid as unknown as LocalBranchObservation, plan),
      { code: 'LOCAL_BRANCH_INVALID_OBSERVATION' });
  }
});

test('새 local 승인 요청은 정확한 UUID·hash와 필수 정수 TTL 1~60분만 허용한다', () => {
  const plan = planFor();
  const request = { taskId: plan.taskId, planHash: plan.planHash, expiresInMinutes: 30 };
  for (const expiresInMinutes of [1, 30, 60]) assertLocalBranchApprovalRequest({ ...request, expiresInMinutes });
  for (const expiresInMinutes of [undefined, null, '30', 0, -1, 61, 1440, 1.5, NaN, Infinity]) {
    assert.throws(() => assertLocalBranchApprovalRequest({ ...request, expiresInMinutes } as LocalBranchApprovalRequest),
      { code: 'LOCAL_BRANCH_INVALID_APPROVAL' });
  }
  for (const invalid of [null, [], {}, { ...request, taskId: '../task' }, { ...request, planHash: 'not-hash' },
    { ...request, ownerId }, { ...request, policy: 'synthetic-branch-v1' },
    { ...request, planSnapshot: plan }, { ...request, mode: 'live' }]) {
    assert.throws(() => assertLocalBranchApprovalRequest(invalid as LocalBranchApprovalRequest),
      { code: 'LOCAL_BRANCH_INVALID_APPROVAL' });
  }
});
