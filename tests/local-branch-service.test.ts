import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SyntheticLocalBranchWorkspace } from '../src/adapters/local-branch-workspace.js';
import { SqliteLocalBranchStore } from '../src/adapters/sqlite-local-branch-store.js';
import { LocalBranchService } from '../src/application/local-branch.js';
import type { LocalBranchObservation, LocalBranchPlan, LocalBranchTask } from '../src/domain/local-branch.js';
import type { LocalBranchWorkspacePort } from '../src/ports/local-branch.js';

type Phase = 'claimed' | 'writing' | 'created' | 'observed';

const removeFixture = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path)) await removeFixture(join(path, entry));
  }
  await rm(path, { recursive: true, force: true });
};

const setup = async (context: TestContext) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'harness-local-branch-service-'));
  const store = new SqliteLocalBranchStore(join(directory, 'git-branches.sqlite'));
  const workspace = new SyntheticLocalBranchWorkspace(directory);
  const ownerId = `os-user:${process.getuid!()}`;
  let now = new Date('2026-11-12T00:00:00.000Z');
  let checkpoint: (phase: Phase) => void | Promise<void> = () => undefined;
  let observe: (plan: LocalBranchPlan) => LocalBranchObservation = (plan) => workspace.observe(plan);
  let createRef: (plan: LocalBranchPlan) => void = (plan) => workspace.createRef(plan);
  const calls = { observe: 0, createRef: 0 };
  const port: LocalBranchWorkspacePort = {
    mode: 'local-synthetic',
    prepare: (taskId, workType) => workspace.prepare(taskId, workType),
    observe: (plan) => { calls.observe += 1; return observe(plan); },
    createRef: (plan) => { calls.createRef += 1; createRef(plan); },
  };
  const service = new LocalBranchService(store, port, () => now, (phase) => checkpoint(phase));
  context.after(async () => { store.close(); await removeFixture(directory); });
  const plan = async (): Promise<LocalBranchTask> => (await service.plan('fix', ownerId, now)).task;
  const approve = (task: LocalBranchTask, expiresInMinutes = 30) => service.approve({
    taskId: task.taskId, planHash: task.plan.planHash, expiresInMinutes,
  }, ownerId, now);
  const create = (task: LocalBranchTask) => service.create(task.taskId, task.plan.planHash, ownerId, now);
  const inspect = (task: LocalBranchTask) => service.inspect(task.taskId, ownerId, now);
  const recover = (task: LocalBranchTask) => service.recover(task.taskId, ownerId, now);
  const cancel = (task: LocalBranchTask) => service.cancel(task.taskId, ownerId, now);
  return {
    workspace, calls, plan, approve, create, inspect, recover, cancel,
    setCheckpoint: (callback: typeof checkpoint) => { checkpoint = callback; },
    setObserve: (callback: typeof observe) => { observe = callback; },
    setCreateRef: (callback: typeof createRef) => { createRef = callback; },
    advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); },
  };
};

const refPath = (task: LocalBranchTask): string => join(task.plan.repository.root, 'workspace', '.git', 'refs', 'heads', task.plan.branchName);
const secret = 'SYNTHETIC_DO_NOT_LOG';

test('서비스는 승인 전과 재시도에 workspace를 호출하지 않고 완료 복구는 영속 결과만 반환한다', async (context) => {
  const fixture = await setup(context);
  const task = await fixture.plan();
  await assert.rejects(fixture.create(task), { code: 'LOCAL_BRANCH_NOT_READY' });
  assert.deepEqual(fixture.calls, { observe: 0, createRef: 0 });
  await assert.rejects(readFile(refPath(task)), { code: 'ENOENT' });
  await fixture.approve(task);
  const created = await fixture.create(task);
  assert.equal(created.task.status, 'SUCCEEDED');
  assert.equal(fixture.calls.createRef, 1);
  assert.equal((await readFile(refPath(task), 'utf8')).trim(), task.plan.repository.baseCommit);
  const beforeRetry = { ...fixture.calls };
  fixture.setObserve(() => { throw new Error(secret); });
  await assert.rejects(fixture.create(task), { code: 'LOCAL_BRANCH_NOT_READY' });
  await assert.rejects(fixture.approve(task), { code: 'LOCAL_BRANCH_NOT_READY' });
  assert.deepEqual(fixture.recover(task), created);
  assert.deepEqual(fixture.calls, beforeRetry);
});

test('승인과 생성 전 실제 ref 충돌은 기존 ref를 보존하고 미소비 승인을 취소한다', async (context) => {
  for (const approved of [false, true]) {
    const fixture = await setup(context);
    const task = await fixture.plan();
    if (approved) await fixture.approve(task);
    fixture.workspace.createRef(task.plan);
    const original = await readFile(refPath(task));
    await assert.rejects(approved ? fixture.create(task) : fixture.approve(task), { code: 'LOCAL_BRANCH_REF_COLLISION' });
    const blocked = fixture.inspect(task);
    assert.equal(blocked.task.status, 'BLOCKED');
    assert.equal(blocked.attempt, null);
    if (approved) {
      assert.ok(blocked.approvals[0]?.revokedAt);
      assert.equal(blocked.approvals[0]?.usedAt, null);
    }
    assert.equal(fixture.calls.createRef, 0);
    assert.deepEqual(await readFile(refPath(task)), original);
    await assert.rejects(fixture.create(task), { code: 'LOCAL_BRANCH_NOT_READY' });
  }
});

test('ref 생성 전후 adapter 예외는 실제 관찰에 따라 FAILED와 BLOCKED로 분리하고 원시 오류를 숨긴다', async (context) => {
  for (const writeFirst of [false, true]) {
    const fixture = await setup(context);
    const task = await fixture.plan();
    await fixture.approve(task);
    fixture.setCreateRef((plan) => {
      if (writeFirst) fixture.workspace.createRef(plan);
      throw new Error(secret);
    });
    const failed = await fixture.create(task);
    assert.equal(failed.task.status, writeFirst ? 'BLOCKED' : 'FAILED');
    assert.equal(failed.task.failureCode, 'LOCAL_BRANCH_CREATE_FAILED');
    assert.equal(failed.attempt?.after?.state, writeFirst ? 'created' : 'absent');
    assert.equal(failed.attempt?.refCreatedAt, null);
    assert.ok(failed.attempt?.writeStartedAt);
    assert.ok(failed.approvals[0]?.usedAt);
    assert.equal(JSON.stringify(failed).includes(secret), false);
    assert.equal(fixture.calls.createRef, 1);
    if (writeFirst) assert.equal((await readFile(refPath(task), 'utf8')).trim(), task.plan.repository.baseCommit);
    else await assert.rejects(readFile(refPath(task)), { code: 'ENOENT' });
    await assert.rejects(fixture.create(task), { code: 'LOCAL_BRANCH_NOT_READY' });
    assert.deepEqual(fixture.recover(task).attempt, failed.attempt);
    assert.equal(fixture.calls.createRef, 1);
  }
});

test('쓰는 중과 생성 뒤 취소는 새 쓰기를 막고 이미 만들어진 ref와 소비 승인을 보존한다', async (context) => {
  for (const cancelAt of ['writing', 'created'] as const) {
    const fixture = await setup(context);
    const task = await fixture.plan();
    await fixture.approve(task);
    fixture.setCheckpoint((phase) => {
      if (phase !== cancelAt) return;
      const cancelled = fixture.cancel(task);
      assert.equal(cancelled.task.status, 'RUNNING');
      assert.ok(cancelled.task.cancelledAt);
    });
    const finished = await fixture.create(task);
    assert.equal(finished.task.status, 'CANCELLED');
    assert.equal(finished.attempt?.status, 'CANCELLED');
    assert.equal(finished.attempt?.after?.state, cancelAt === 'created' ? 'created' : 'absent');
    assert.equal(fixture.calls.createRef, cancelAt === 'created' ? 1 : 0);
    assert.ok(finished.approvals[0]?.usedAt);
    assert.equal(finished.approvals[0]?.revokedAt, null);
    if (cancelAt === 'created') assert.equal((await readFile(refPath(task), 'utf8')).trim(), task.plan.repository.baseCommit);
    else await assert.rejects(readFile(refPath(task)), { code: 'ENOENT' });
    assert.deepEqual(fixture.recover(task).attempt, finished.attempt);
    await assert.rejects(fixture.create(task), { code: 'LOCAL_BRANCH_NOT_READY' });
  }
});

test('claim과 쓰기 intent 뒤 TTL 만료는 승인 소비를 유지하면서 실제 ref 쓰기를 거부한다', async (context) => {
  for (const expireAt of ['claimed', 'writing'] as const) {
    const fixture = await setup(context);
    const task = await fixture.plan();
    await fixture.approve(task, 1);
    fixture.setCheckpoint((phase) => { if (phase === expireAt) fixture.advance(60_000); });
    const expired = await fixture.create(task);
    assert.equal(expired.task.status, 'FAILED');
    assert.equal(expired.task.failureCode, 'LOCAL_BRANCH_APPROVAL_EXPIRED');
    assert.equal(expired.attempt?.after?.state, 'absent');
    assert.equal(expired.attempt?.writeStartedAt === null, expireAt === 'claimed');
    assert.equal(fixture.calls.createRef, 0);
    assert.ok(expired.approvals[0]?.usedAt);
    await assert.rejects(readFile(refPath(task)), { code: 'ENOENT' });
    await assert.rejects(fixture.approve(task), { code: 'LOCAL_BRANCH_NOT_READY' });
    await assert.rejects(fixture.create(task), { code: 'LOCAL_BRANCH_NOT_READY' });
  }
});

test('잘못된 관찰과 관찰 예외는 승인 전에 차단하고 원시 오류나 파일 정보를 노출하지 않는다', async (context) => {
  for (const malformed of [false, true]) {
    const fixture = await setup(context);
    const task = await fixture.plan();
    fixture.setObserve((plan) => {
      if (!malformed) throw new Error(secret);
      return { ...fixture.workspace.observe(plan), state: 'created', branchOid: null };
    });
    await assert.rejects(fixture.approve(task), { code: 'LOCAL_BRANCH_OBSERVATION_FAILED' });
    const blocked = fixture.inspect(task);
    assert.equal(blocked.task.status, 'BLOCKED');
    assert.equal(blocked.task.failureCode, 'LOCAL_BRANCH_OBSERVATION_FAILED');
    assert.deepEqual(blocked.approvals, []);
    assert.equal(blocked.attempt, null);
    assert.equal(JSON.stringify(blocked).includes(secret), false);
    assert.equal(fixture.calls.createRef, 0);
    await assert.rejects(readFile(refPath(task)), { code: 'ENOENT' });
  }
});

test('ref 생성 뒤 관찰 실패는 성공을 선언하지 않고 잔여 ref와 소비 승인을 보존한다', async (context) => {
  const fixture = await setup(context);
  const task = await fixture.plan();
  await fixture.approve(task);
  fixture.setCheckpoint((phase) => {
    if (phase === 'created') fixture.setObserve(() => { throw new Error(secret); });
  });
  const blocked = await fixture.create(task);
  assert.equal(blocked.task.status, 'BLOCKED');
  assert.equal(blocked.task.failureCode, 'LOCAL_BRANCH_OBSERVATION_FAILED');
  assert.equal(blocked.attempt?.after?.state, 'unsafe');
  assert.ok(blocked.attempt?.refCreatedAt);
  assert.ok(blocked.approvals[0]?.usedAt);
  assert.equal((await readFile(refPath(task), 'utf8')).trim(), task.plan.repository.baseCommit);
  assert.equal(JSON.stringify(blocked).includes(secret), false);
  const calls = { ...fixture.calls };
  assert.deepEqual(fixture.recover(task).attempt, blocked.attempt);
  assert.deepEqual(fixture.calls, calls);
});
