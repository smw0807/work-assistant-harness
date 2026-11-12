import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteExecutionStore } from '../src/adapters/sqlite-execution-store.js';
import type { BranchWorkType } from '../src/domain/branch.js';
import {
  BRANCH_EXECUTION_POLICY_VERSION, EXECUTION_POLICY_VERSION,
  type ExecutionApproval, type ExecutionApprovalRequest, type ExecutionPlan, type ExecutionTask,
} from '../src/domain/execution.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import {
  assertExecutionConfig, assertExecutionPlan, assertExecutionPlanReady, createExecutionPolicy,
  getExecutionCommand, hashExecutionPlan, sha256,
} from '../src/policy/execution-policy.js';

const now = new Date('2026-11-12T00:00:00.000Z');
const ownerId = `os-user:${process.getuid?.()}`;
const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-docker.sock', serverVersion: '29.4.3',
  imageId: `sha256:${'c'.repeat(64)}`, nodeVersion: '24.22.2',
};
const context = (offsetMs = 0) => ({ ownerId, now: new Date(now.getTime() + offsetMs) });

const plannedTask = (workType: BranchWorkType = 'feature', legacy = false): ExecutionTask => {
  const taskId = randomUUID();
  const sourceRoot = `/private/tmp/synthetic/branch-executions/${taskId}/source`;
  const name = `${workType}/task-${taskId}`;
  const content: Omit<ExecutionPlan, 'planHash'> = {
    planId: randomUUID(), version: 1, taskId, requestRevision: 'synthetic-1',
    repoId: legacy ? 'synthetic-execution' : 'synthetic-branch-execution',
    baseCommit: 'a'.repeat(40), sourceHash: 'b'.repeat(64), allowedFiles: ['src/message.mjs'],
    patches: [{ operation: 'replace', path: 'src/message.mjs', beforeHash: sha256('old\n'), afterHash: sha256('new\n'), content: 'new\n' }],
    commands: [getExecutionCommand('synthetic-check-v1')],
    policy: createExecutionPolicy(config, legacy ? EXECUTION_POLICY_VERSION : BRANCH_EXECUTION_POLICY_VERSION),
    ...(!legacy ? { branch: {
      workType, name, baseBranch: 'main' as const, headRef: `refs/heads/${name}`, ownerId, sourceRoot,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    } } : {}),
  };
  return {
    taskId, status: 'AWAITING_APPROVAL', requestRevision: content.requestRevision, baseCommit: content.baseCommit,
    sourceRoot, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    plan: { ...content, planHash: hashExecutionPlan(content) },
  };
};
const runRequest = (task: ExecutionTask) => ({ taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit });
const approvalRequest = (task: ExecutionTask, expiresInMinutes = 30): ExecutionApprovalRequest => ({ ...runRequest(task), expiresInMinutes });
const rehash = (plan: ExecutionPlan): void => { plan.planHash = hashExecutionPlan(plan); };

const openStore = async (t: TestContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-branch-execution-store-')));
  await chmod(directory, 0o700);
  const path = join(directory, 'branch-execution.sqlite');
  let store = new SqliteExecutionStore(path, BRANCH_EXECUTION_POLICY_VERSION);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    path, directory, get store() { return store; },
    reopen: () => { store.close(); store = new SqliteExecutionStore(path, BRANCH_EXECUTION_POLICY_VERSION); return store; },
  };
};
const withDatabase = <T>(path: string, operation: (database: DatabaseSync) => T): T => {
  const database = new DatabaseSync(path);
  try { return operation(database); } finally { database.close(); }
};
const rewriteApproval = (path: string, approval: ExecutionApproval): void => withDatabase(path, (database) => {
  database.prepare('UPDATE execution_approvals SET payload = ? WHERE approval_id = ?').run(JSON.stringify(approval), approval.approvalId);
});

test('네 유형의 작업 브랜치 metadata를 해시에 결합하고 기존 계획의 내용과 정책 기본값을 보존한다', () => {
  for (const workType of ['feature', 'fix', 'chore', 'refactor'] as const) {
    const { plan } = plannedTask(workType);
    assertExecutionPlan(plan);
    assertExecutionConfig(plan, config);
    const reordered = structuredClone(plan);
    reordered.branch = Object.fromEntries(Object.entries(plan.branch!).reverse()) as unknown as NonNullable<typeof plan.branch>;
    assert.equal(hashExecutionPlan(reordered), plan.planHash);
    assertExecutionPlan(reordered);
    const changed = structuredClone(plan);
    changed.branch!.ownerId = 'os-user:99999999';
    assert.notEqual(hashExecutionPlan(changed), plan.planHash);
    assert.throws(() => assertExecutionPlan(changed), { code: 'PLAN_HASH_MISMATCH' });
  }
  const { plan } = plannedTask('feature', true);
  const { planHash, ...content } = plan;
  assert.equal(planHash, sha256(JSON.stringify(content)));
  assert.deepEqual(createExecutionPolicy(config), plan.policy);
  assert.equal(Object.hasOwn(plan, 'branch'), false);
  assertExecutionPlan(plan);
  assertExecutionConfig(plan, config);
});

test('정책·저장소·branch 존재를 함께 묶어 기존 승인 shape의 혼용을 거부한다', () => {
  for (const mutate of [
    (plan: ExecutionPlan) => { delete plan.branch; },
    (plan: ExecutionPlan) => { plan.repoId = 'synthetic-execution'; },
    (plan: ExecutionPlan) => { plan.policy.version = EXECUTION_POLICY_VERSION; },
    (plan: ExecutionPlan) => { plan.policy.version = 'local-synthetic-branch-v1' as never; },
    (plan: ExecutionPlan) => { Object.assign(plan, { mode: 'local-synthetic' }); },
    (plan: ExecutionPlan) => { Object.assign(plan.branch!, { remote: 'ssh://company.invalid/repo' }); },
    (plan: ExecutionPlan) => { Object.assign(plan.branch!, { createMergeRequest: true }); },
    (plan: ExecutionPlan) => { Object.assign(plan.policy, { live: true }); },
  ]) {
    const { plan } = plannedTask(); mutate(plan); rehash(plan);
    assert.throws(() => assertExecutionPlan(plan));
  }
  const legacy = plannedTask('feature', true).plan;
  legacy.branch = plannedTask().plan.branch!;
  rehash(legacy);
  assert.throws(() => assertExecutionPlan(legacy), { code: 'INVALID_EXECUTION_PLAN' });
});

test('재해시한 브랜치·기준·경로·소유자·기간 변조와 잘못된 JSON 구조를 거부한다', () => {
  for (const mutate of [
    (plan: ExecutionPlan) => { plan.branch!.name = 'feature/arbitrary'; },
    (plan: ExecutionPlan) => { plan.branch!.workType = 'hotfix' as never; },
    (plan: ExecutionPlan) => { plan.branch!.headRef = 'refs/heads/main'; },
    (plan: ExecutionPlan) => { plan.branch!.baseBranch = 'production' as never; },
    (plan: ExecutionPlan) => { plan.branch!.sourceRoot = plan.branch!.sourceRoot.replace('/synthetic/', '/synthetic/../'); },
    (plan: ExecutionPlan) => { plan.branch!.sourceRoot = plan.branch!.sourceRoot.replace('/branch-executions/', '/executions/'); },
    (plan: ExecutionPlan) => { plan.branch!.sourceRoot = plan.branch!.sourceRoot.replace(plan.taskId, randomUUID()); },
    (plan: ExecutionPlan) => { plan.branch!.sourceRoot += '/'; },
    (plan: ExecutionPlan) => { plan.branch!.sourceRoot = `relative${plan.branch!.sourceRoot}`; },
    (plan: ExecutionPlan) => { plan.branch!.sourceRoot = `/private/tmp/a\n${plan.branch!.sourceRoot}`; },
    (plan: ExecutionPlan) => { plan.branch!.ownerId = 'os-user:01'; },
    (plan: ExecutionPlan) => { plan.branch!.expiresAt = new Date(now.getTime() + 86_400_001).toISOString(); },
    (plan: ExecutionPlan) => { plan.branch!.createdAt = '2026-11-12'; },
    (plan: ExecutionPlan) => { plan.allowedFiles = ['../private']; },
    (plan: ExecutionPlan) => { plan.commands[0]!.argv.push('--eval', 'arbitrary'); },
  ]) {
    const { plan } = plannedTask(); mutate(plan); rehash(plan);
    assert.throws(() => assertExecutionPlan(plan));
  }
  for (const value of [null, undefined, [], 'text', 1, { ...plannedTask().plan, branch: null },
    { ...plannedTask().plan, branch: [] }, { ...plannedTask().plan, policy: null }]) {
    assert.throws(() => assertExecutionPlan(value as unknown as ExecutionPlan));
  }
});

test('신규 계획의 소유자와 정확한 24시간 경계를 승인·실행 준비 때 확인하고 만료 조회는 허용한다', () => {
  const { plan } = plannedTask();
  assertExecutionPlanReady(plan, ownerId, now);
  assertExecutionPlanReady(plan, ownerId, new Date(now.getTime() + 86_400_000 - 1));
  assert.throws(() => assertExecutionPlanReady(plan, 'os-user:99999999', now), { code: 'APPROVAL_OWNER_MISMATCH' });
  assert.throws(() => assertExecutionPlanReady(plan, ownerId, new Date(now.getTime() - 1)), { code: 'INVALID_APPROVAL_TIME' });
  assert.throws(() => assertExecutionPlanReady(plan, ownerId, new Date(NaN)), { code: 'INVALID_APPROVAL_TIME' });
  assert.throws(() => assertExecutionPlanReady(plan, ownerId, new Date(now.getTime() + 86_400_000)), { code: 'EXECUTION_PLAN_EXPIRED' });
  assertExecutionPlan(plan);
  assert.throws(() => assertExecutionConfig(plan, { ...config, enabled: false }), { code: 'EXECUTION_POLICY_CHANGED' });
});

test('별도 store는 기존 정책 task·승인·run을 양방향으로 읽거나 소비하지 않는다', async (t) => {
  const harness = await openStore(t);
  const legacyPath = join(harness.directory, 'execution.sqlite');
  const legacy = new SqliteExecutionStore(legacyPath);
  const legacyViewOfNew = new SqliteExecutionStore(harness.path);
  const newViewOfLegacy = new SqliteExecutionStore(legacyPath, BRANCH_EXECUTION_POLICY_VERSION);
  t.after(() => { legacy.close(); legacyViewOfNew.close(); newViewOfLegacy.close(); });
  const task = plannedTask();
  const oldTask = plannedTask('fix', true);
  assert.throws(() => harness.store.create(oldTask), { code: 'EXECUTION_POLICY_MISMATCH' });
  assert.throws(() => legacy.create(task), { code: 'EXECUTION_POLICY_MISMATCH' });
  harness.store.create(task); legacy.create(oldTask);
  harness.store.approve(approvalRequest(task), context()); legacy.approve(approvalRequest(oldTask, 1_440), context());
  const run = harness.store.beginRun(runRequest(task), context(), harness.directory);
  const oldRun = legacy.beginRun(runRequest(oldTask), context(), harness.directory);
  for (const [reader, storedTask, storedRun] of [[legacyViewOfNew, task, run], [newViewOfLegacy, oldTask, oldRun]] as const) {
    assert.throws(() => reader.find(storedTask.taskId), { code: 'EXECUTION_POLICY_MISMATCH' });
    assert.throws(() => reader.listApprovals(storedTask.taskId), { code: 'INVALID_STORED_EXECUTION_APPROVAL' });
    assert.throws(() => reader.findRun(storedRun.runId), { code: 'EXECUTION_POLICY_MISMATCH' });
    assert.throws(() => reader.listRuns(storedTask.taskId), { code: 'EXECUTION_POLICY_MISMATCH' });
    assert.throws(() => reader.beginRun(runRequest(storedTask), context(), harness.directory), { code: 'EXECUTION_POLICY_MISMATCH' });
    assert.throws(() => reader.control({ taskId: storedTask.taskId, eventId: randomUUID(), kind: 'cancel', revision: 1 }, context()));
  }
  assert.equal(harness.store.listRuns(task.taskId).length, 1);
  assert.equal(legacy.listRuns(oldTask.taskId).length, 1);
});

test('task의 source·생성 시각·OS 소유자는 새 계획 metadata와 같아야 한다', async (t) => {
  const { store } = await openStore(t);
  const task = plannedTask();
  for (const changed of [{ ...task, sourceRoot: '/private/tmp/other' },
    { ...task, createdAt: new Date(now.getTime() - 1).toISOString() }]) {
    assert.throws(() => store.create(changed), { code: 'EXECUTION_CONTEXT_MISMATCH' });
  }
  const otherOwner = structuredClone(task);
  otherOwner.plan.branch!.ownerId = 'os-user:99999999'; rehash(otherOwner.plan);
  assert.throws(() => store.create(otherOwner), { code: 'APPROVAL_OWNER_MISMATCH' });
  assert.equal(store.find(task.taskId), null);
  store.create(task);
  assert.deepEqual(store.find(task.taskId), task);
});

test('새 승인 TTL은 필수 정수 1~60분이며 계획 만료를 넘거나 과거·만료 계획을 승인하지 않는다', async (t) => {
  const { store } = await openStore(t);
  const task = plannedTask(); store.create(task);
  for (const ttl of [undefined, 0, -1, 1.5, 61, NaN, Infinity]) {
    assert.throws(() => store.approve({ ...approvalRequest(task), expiresInMinutes: ttl } as ExecutionApprovalRequest, context()),
      { code: 'INVALID_EXECUTION_APPROVAL_REQUEST' });
  }
  assert.throws(() => store.approve({ ...approvalRequest(task), mode: 'live' } as ExecutionApprovalRequest, context()),
    { code: 'INVALID_EXECUTION_APPROVAL_REQUEST' });
  assert.throws(() => store.approve(approvalRequest(task), context(-1)), { code: 'INVALID_APPROVAL_TIME' });
  assert.throws(() => store.approve(approvalRequest(task, 1), context(86_400_000 - 30_000)),
    { code: 'EXECUTION_APPROVAL_EXCEEDS_PLAN_EXPIRY' });
  assert.throws(() => store.approve(approvalRequest(task, 1), context(86_400_000)), { code: 'EXECUTION_PLAN_EXPIRED' });
  assert.deepEqual(store.listApprovals(task.taskId), []);
  const approval = store.approve(approvalRequest(task, 60), context());
  assert.equal(approval.executionPolicy, BRANCH_EXECUTION_POLICY_VERSION);
  assert.equal(approval.expiresAt, new Date(now.getTime() + 3_600_000).toISOString());
  assert.deepEqual(approval.planSnapshot, task.plan);
});

test('계획 만료에 맞춘 승인은 경계에서 취소 기록을 남기고 재승인·자동 실행하지 않는다', async (t) => {
  const harness = await openStore(t);
  const task = plannedTask(); harness.store.create(task);
  const approval = harness.store.approve(approvalRequest(task, 1), context(86_400_000 - 60_000));
  assert.equal(approval.expiresAt, task.plan.branch!.expiresAt);
  assert.throws(() => harness.store.beginRun(runRequest(task), context(86_400_000), harness.directory), { code: 'APPROVAL_EXPIRED' });
  assert.equal(harness.store.listApprovals(task.taskId)[0]?.revokedAt, task.plan.branch!.expiresAt);
  assert.equal(harness.reopen().find(task.taskId)?.status, 'AWAITING_APPROVAL');
  assert.throws(() => harness.store.approve(approvalRequest(task), context(86_400_000)), { code: 'EXECUTION_PLAN_EXPIRED' });
  assert.deepEqual(harness.store.listRuns(task.taskId), []);
});

test('승인 snapshot의 정책·브랜치·소유자·만료 변조는 claim 전에 거부하고 소비를 남기지 않는다', async (t) => {
  const { store, path, directory } = await openStore(t);
  for (const mutate of [
    (approval: ExecutionApproval) => { approval.executionPolicy = EXECUTION_POLICY_VERSION; },
    (approval: ExecutionApproval) => { approval.planSnapshot.policy.version = EXECUTION_POLICY_VERSION; rehash(approval.planSnapshot); },
    (approval: ExecutionApproval) => { approval.planSnapshot.branch!.name = 'fix/other'; rehash(approval.planSnapshot); },
    (approval: ExecutionApproval) => { approval.planSnapshot.branch!.ownerId = 'os-user:99999999'; rehash(approval.planSnapshot); },
    (approval: ExecutionApproval) => { approval.expiresAt = new Date(now.getTime() + 61 * 60_000).toISOString(); },
  ]) {
    const task = plannedTask(); store.create(task);
    const approval = store.approve(approvalRequest(task), context());
    const changed = structuredClone(approval); mutate(changed); rewriteApproval(path, changed);
    assert.throws(() => store.beginRun(runRequest(task), context(), directory));
    assert.deepEqual(store.listRuns(task.taskId), []);
    assert.equal(store.find(task.taskId)?.status, 'APPROVED');
    rewriteApproval(path, approval);
    assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, null);
  }
});

test('claim 저장 실패는 승인 소비·Run·lifecycle을 원자적으로 되돌린다', async (t) => {
  const { store, path, directory } = await openStore(t);
  const task = plannedTask(); store.create(task); store.approve(approvalRequest(task), context());
  withDatabase(path, (database) => database.exec(`CREATE TRIGGER reject_branch_claim BEFORE INSERT ON execution_lifecycle_history
    BEGIN SELECT RAISE(ABORT, 'synthetic store failure'); END;`));
  assert.throws(() => store.beginRun(runRequest(task), context(), directory));
  assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, null);
  assert.equal(store.find(task.taskId)?.status, 'APPROVED');
  assert.deepEqual(store.listRuns(task.taskId), []);
  assert.equal(withDatabase(path, (database) => database.prepare('SELECT COUNT(*) AS count FROM execution_lifecycles').get()?.count), 0);
  withDatabase(path, (database) => database.exec('DROP TRIGGER reject_branch_claim'));
  const run = store.beginRun(runRequest(task), context(), directory);
  assert.equal(store.lifecycle(run.runId).phase, 'claimed');
});

test('두 store의 claim은 승인 한 번만 소비하며 재시작 후 lifecycle과 소비 기록이 남는다', async (t) => {
  const harness = await openStore(t);
  const second = new SqliteExecutionStore(harness.path, BRANCH_EXECUTION_POLICY_VERSION);
  t.after(() => second.close());
  const task = plannedTask(); harness.store.create(task);
  harness.store.approve(approvalRequest(task), context());
  assert.throws(() => harness.store.beginRun({ ...runRequest(task), mode: 'live' } as ReturnType<typeof runRequest>, context(), harness.directory),
    { code: 'INVALID_EXECUTION_APPROVAL_REQUEST' });
  const run = harness.store.beginRun(runRequest(task), context(), harness.directory);
  assert.throws(() => second.beginRun(runRequest(task), context(), harness.directory), { code: 'APPROVAL_ALREADY_USED' });
  const reopened = harness.reopen();
  assert.equal(reopened.find(task.taskId)?.status, 'RUNNING');
  assert.equal(reopened.listApprovals(task.taskId)[0]?.usedAt, now.toISOString());
  assert.equal(reopened.lifecycle(run.runId).phase, 'claimed');
  assert.equal(reopened.listRuns(task.taskId).length, 1);
});

test('취소 generation fence가 새 쓰기와 늦은 성공을 막고 사용 승인은 복원하지 않는다', async (t) => {
  const { store, directory } = await openStore(t);
  const task = plannedTask(); store.create(task); store.approve(approvalRequest(task), context());
  const run = store.beginRun(runRequest(task), context(), directory);
  const request = { taskId: task.taskId, eventId: randomUUID(), kind: 'cancel' as const, revision: 1 };
  const cancelled = store.control(request, context(1_000));
  assert.equal(cancelled.generation, 1);
  assert.deepEqual(store.control(request, context(2_000)), cancelled);
  let dispatched = false;
  assert.throws(() => store.dispatch(run.runId, () => { dispatched = true; }), { code: 'EXECUTION_CANCELLED' });
  await assert.rejects(store.guard(run.runId, 'patch_applying', async () => { dispatched = true; }), { code: 'EXECUTION_CANCELLED' });
  assert.equal(dispatched, false);
  store.finishRun({ ...run, status: 'SUCCEEDED', finishedAt: context(3_000).now.toISOString() });
  assert.equal(store.findRun(run.runId)?.status, 'CANCELLED');
  assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, now.toISOString());
  assert.throws(() => store.approve(approvalRequest(task), context(4_000)), { code: 'EXECUTION_CANCELLED' });
  assert.throws(() => store.beginRun(runRequest(task), context(4_000), directory), { code: 'EXECUTION_CANCELLED' });
});

test('승인 대기 취소는 활성 승인을 revoke하고 생성 전 새 작업을 차단한다', async (t) => {
  const { store, directory } = await openStore(t);
  const task = plannedTask(); store.create(task); store.approve(approvalRequest(task), context());
  store.control({ taskId: task.taskId, eventId: randomUUID(), kind: 'edited', revision: 2 }, context(1_000));
  assert.equal(store.find(task.taskId)?.status, 'CANCELLED');
  assert.equal(store.listApprovals(task.taskId)[0]?.revokedAt, context(1_000).now.toISOString());
  assert.throws(() => store.beginRun(runRequest(task), context(2_000), directory), { code: 'EXECUTION_CANCELLED' });
  assert.deepEqual(store.listRuns(task.taskId), []);
});
