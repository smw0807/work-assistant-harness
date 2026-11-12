import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { MockBranchWorkspace } from '../src/adapters/mock-branch-workspace.js';
import { SqliteBranchStore } from '../src/adapters/sqlite-branch-store.js';
import { SyntheticBranchService } from '../src/application/simulate-branch.js';
import type { BranchApprovalRequest, BranchControl, BranchPlan, BranchResult, BranchTask } from '../src/domain/branch.js';
import type { MockBranchWorkspacePort } from '../src/ports/branch.js';
import { createBranchPlan, hashBranchPlan } from '../src/policy/branch-policy.js';

const now = new Date('2026-11-12T00:00:00.000Z');
const ownerId = `os-user:${process.getuid?.()}`;
const later = (minutes: number): Date => new Date(now.getTime() + minutes * 60_000);
const request = (plan: BranchPlan, expiresInMinutes = 30): BranchApprovalRequest => ({ taskId: plan.taskId, planHash: plan.planHash, expiresInMinutes });
const event = (plan: BranchPlan, kind: BranchControl['kind'], revision = 2): BranchControl => ({
  taskId: plan.taskId, eventId: `${plan.taskId}:${kind}:${revision}`, kind, revision,
});
const openStore = async (context: TestContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-branch-store-')));
  await chmod(directory, 0o700);
  const path = join(directory, 'branches.sqlite');
  let store = new SqliteBranchStore(path);
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path, get store() { return store; },
    reopen: () => { store.close(); store = new SqliteBranchStore(path); return store; } };
};
const withDatabase = <T>(path: string, operation: (database: DatabaseSync) => T): T => {
  const database = new DatabaseSync(path);
  try { return operation(database); } finally { database.close(); }
};

test('브랜치 합성 계획은 동일 task/hash만 멱등 보관하고 별도 0600 DB에서 소유자를 검증한다', async (context) => {
  const { store, path } = await openStore(context);
  const plan = createBranchPlan('feature', 'success', ownerId, now);
  const created = store.create(plan, now);
  assert.equal(created.status, 'AWAITING_APPROVAL');
  assert.equal(created.plan.branchName, `feature/synthetic-${plan.taskId}`);
  assert.deepEqual(store.create(plan, now), created);
  const changed = { ...plan, fixture: 'unknown' as const };
  changed.planHash = hashBranchPlan(changed);
  assert.throws(() => store.create(changed, now), { code: 'BRANCH_TASK_CONFLICT' });
  assert.throws(() => store.inspect(plan.taskId, 'os-user:99999999', now), { code: 'BRANCH_OWNER_MISMATCH' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.throws(() => store.claim(plan.taskId, plan.planHash, ownerId, now), { code: 'BRANCH_APPROVAL_REQUIRED' });
  assert.equal(store.inspect(plan.taskId, ownerId, now).attempt, null);
});

test('브랜치 승인은 필수 TTL·정확한 해시·현재 OS 소유자를 확인하고 불변 snapshot을 저장한다', async (context) => {
  const { store } = await openStore(context);
  const plan = createBranchPlan('fix', 'success', ownerId, now);
  store.create(plan, now);
  for (const ttl of [0, 61, 1.5, NaN, Infinity]) assert.throws(() => store.approve(request(plan, ttl), ownerId, now), { code: 'BRANCH_INVALID_APPROVAL' });
  assert.throws(() => store.approve({ ...request(plan), planHash: 'f'.repeat(64) }, ownerId, now), { code: 'BRANCH_PLAN_HASH_MISMATCH' });
  assert.throws(() => store.approve({ ...request(plan), policy: 'approval-only-v1' } as BranchApprovalRequest, ownerId, now), { code: 'BRANCH_INVALID_APPROVAL' });
  const approval = store.approve(request(plan), ownerId, now);
  assert.deepEqual(approval.planSnapshot, plan);
  approval.planSnapshot.branchName = 'main';
  assert.deepEqual(store.inspect(plan.taskId, ownerId, now).approvals[0]?.planSnapshot, plan);
  assert.throws(() => store.approve(request(plan), ownerId, now), { code: 'BRANCH_APPROVAL_EXISTS' });
  const uid = process.getuid;
  try {
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    assert.throws(() => store.approve(request(plan), ownerId, now), { code: 'BRANCH_OWNER_MISMATCH' });
  } finally { Object.defineProperty(process, 'getuid', { value: uid, configurable: true }); }
});

test('같은 계획의 멱등 생성도 저장된 최신 상태보다 과거 시각으로 되돌릴 수 없다', async (context) => {
  const { store } = await openStore(context);
  const plan = createBranchPlan('fix', 'success', ownerId, now);
  store.create(plan, now);
  store.approve(request(plan), ownerId, later(2));
  const snapshot = store.inspect(plan.taskId, ownerId, later(2));
  assert.throws(() => store.create(plan, later(1)), { code: 'BRANCH_INVALID_TIME' });
  assert.deepEqual(store.inspect(plan.taskId, ownerId, later(2)), snapshot);
  assert.deepEqual(store.create(plan, later(2)), snapshot.task);
});

test('만료 승인은 거부와 함께 영속 취소하며 새 승인 이력을 한 건씩 조회한다', async (context) => {
  const { store } = await openStore(context);
  const plan = createBranchPlan('chore', 'success', ownerId, now);
  store.create(plan, now);
  const first = store.approve(request(plan, 1), ownerId, now);
  assert.throws(() => store.claim(plan.taskId, plan.planHash, ownerId, later(1)), { code: 'BRANCH_APPROVAL_REQUIRED' });
  const expired = store.inspect(plan.taskId, ownerId, later(1));
  assert.equal(expired.task.status, 'AWAITING_APPROVAL');
  assert.equal(expired.approvals[0]?.revokedAt, later(1).toISOString());
  const second = store.approve(request(plan, 60), ownerId, later(1));
  assert.notEqual(first.approvalId, second.approvalId);
  assert.deepEqual(store.inspect(plan.taskId, ownerId, later(1)).approvalPage, { offset: 0, total: 2, nextOffset: 1 });
  assert.equal(store.inspect(plan.taskId, ownerId, later(1), 1).approvals[0]?.approvalId, first.approvalId);
  for (const offset of [-1, 0.5, Infinity, 1_000_000_001]) assert.throws(() => store.inspect(plan.taskId, ownerId, later(1), offset));
  store.inspect(plan.taskId, ownerId, later(1439));
  assert.equal(store.approve(request(plan, 60), ownerId, later(1439)).expiresAt, plan.expiresAt);
  assert.throws(() => store.claim(plan.taskId, plan.planHash, ownerId, later(1440)), { code: 'BRANCH_PLAN_EXPIRED' });
  assert.equal(store.inspect(plan.taskId, ownerId, later(1440)).task.status, 'BLOCKED');
});

test('승인 소비·시도·상태가 원자적이며 성공·충돌·불확실 결과 모두 같은 작업을 재실행하지 않는다', async (context) => {
  const harness = await openStore(context);
  for (const [fixture, taskStatus, attemptStatus] of [
    ['success', 'SIMULATED', 'SIMULATED'], ['collision', 'FAILED', 'NOT_CREATED'], ['unknown', 'UNKNOWN', 'UNKNOWN'],
  ] as const) {
    const service = new SyntheticBranchService(harness.store, new MockBranchWorkspace(), () => now);
    const { task } = service.create('refactor', fixture, ownerId, now);
    service.approve(request(task.plan), ownerId, now);
    const result = await service.simulate(task.taskId, task.plan.planHash, ownerId, now);
    assert.equal(result.status, attemptStatus);
    const snapshot = harness.reopen().inspect(task.taskId, ownerId, now);
    assert.equal(snapshot.task.status, taskStatus);
    assert.equal(snapshot.approvals[0]?.usedAt, now.toISOString());
    assert.throws(() => harness.store.approve(request(task.plan), ownerId, now));
    assert.throws(() => harness.store.claim(task.taskId, task.plan.planHash, ownerId, now));
    assert.deepEqual(harness.store.recover(task.taskId, ownerId, now), snapshot);
  }
});

test('잘못된 결과와 receipt를 성공으로 보관하지 않고 어댑터 예외는 원시 오류 없는 UNKNOWN이 된다', async (context) => {
  const { store } = await openStore(context);
  const plan = createBranchPlan('fix', 'success', ownerId, now);
  store.create(plan, now);
  store.approve(request(plan), ownerId, now);
  const claim = store.claim(plan.taskId, plan.planHash, ownerId, now);
  assert.throws(() => store.finish(claim.attempt.attemptId, { status: 'SIMULATED', reason: null, receiptId: 'wrong' }, now), { code: 'BRANCH_INVALID_RESULT' });
  assert.equal(store.inspect(plan.taskId, ownerId, now).task.status, 'SIMULATING');
  assert.equal(store.recover(plan.taskId, ownerId, now).task.status, 'UNKNOWN');
  const throwing: MockBranchWorkspacePort = { mode: 'offline', simulate: async () => { throw new Error('SYNTHETIC_SECRET_MUST_NOT_ESCAPE'); } };
  const service = new SyntheticBranchService(store, throwing, () => now);
  const task = service.create('fix', 'success', ownerId, now).task;
  service.approve(request(task.plan), ownerId, now);
  assert.equal((await service.simulate(task.taskId, task.plan.planHash, ownerId, now)).reason, 'BRANCH_SIMULATION_UNCERTAIN');
  assert.equal(JSON.stringify(service.inspect(task.taskId, ownerId, now)).includes('SYNTHETIC_SECRET_MUST_NOT_ESCAPE'), false);
  assert.throws(() => new SyntheticBranchService(store, { ...throwing, mode: 'live' } as unknown as MockBranchWorkspacePort), { code: 'BRANCH_LIVE_EXECUTION_DISABLED' });
});

test('제어 이벤트 중복·내용 충돌·역순 revision을 처리하고 수정 승인을 영구 무효화한다', async (context) => {
  const { store } = await openStore(context);
  for (const kind of ['cancel', 'edited', 'deleted', 'base-changed', 'diff-changed', 'branch-conflict'] as const) {
    const plan = createBranchPlan('fix', 'success', ownerId, now);
    store.create(plan, now);
    store.approve(request(plan), ownerId, now);
    const stale = store.control(event(plan, 'edited', 1), ownerId, now);
    assert.equal(stale.status, 'APPROVED');
    const changed = store.control(event(plan, kind), ownerId, now);
    assert.equal(changed.status, kind === 'cancel' ? 'CANCELLED' : 'BLOCKED');
    assert.deepEqual(store.control(event(plan, kind), ownerId, now), changed);
    assert.throws(() => store.control({ ...event(plan, kind), revision: 3 }, ownerId, now), { code: 'BRANCH_CONTROL_CONFLICT' });
    assert.ok(store.inspect(plan.taskId, ownerId, now).approvals[0]?.revokedAt);
    assert.throws(() => store.approve(request(plan), ownerId, now), { code: 'BRANCH_INVALIDATED' });
    assert.throws(() => store.claim(plan.taskId, plan.planHash, ownerId, now), { code: 'BRANCH_INVALIDATED' });
  }
});

test('SIMULATING은 재시작·만료로 재개되지 않고 명시 복구 또는 제어 후 UNKNOWN을 유지한다', async (context) => {
  const harness = await openStore(context);
  for (const controlled of [false, true]) {
    const plan = createBranchPlan('fix', 'success', ownerId, now);
    harness.store.create(plan, now);
    harness.store.approve(request(plan), ownerId, now);
    const claim = harness.store.claim(plan.taskId, plan.planHash, ownerId, now);
    const reopened = harness.reopen();
    assert.equal(reopened.inspect(plan.taskId, ownerId, later(1441)).task.status, 'SIMULATING');
    if (controlled) reopened.control(event(plan, 'cancel'), ownerId, later(1441));
    const recovered = reopened.recover(plan.taskId, ownerId, later(1441));
    assert.equal(recovered.task.status, 'UNKNOWN');
    assert.equal(recovered.attempt?.status, 'UNKNOWN');
    assert.equal(recovered.approvals[0]?.usedAt, now.toISOString());
    assert.deepEqual(reopened.recover(plan.taskId, ownerId, later(1441)), recovered);
    assert.throws(() => reopened.finish(claim.attempt.attemptId, { status: 'SIMULATED', reason: null, receiptId: `mock-branch:${claim.attempt.attemptId}` }, later(1441)), { code: 'BRANCH_INVALIDATED' });
    assert.throws(() => reopened.claim(plan.taskId, plan.planHash, ownerId, later(1441)));
  }
});

test('진행 중 취소가 늦은 모의 성공을 거부하고 완료된 시도는 취소로 덮어쓰지 않는다', async (context) => {
  const { store } = await openStore(context);
  let resolveResult!: (result: BranchResult) => void;
  const workspace: MockBranchWorkspacePort = { mode: 'offline', simulate: (claim) => new Promise((resolveResult_) => {
    resolveResult = () => resolveResult_({ status: 'SIMULATED', reason: null, receiptId: `mock-branch:${claim.attempt.attemptId}` });
  }) };
  const service = new SyntheticBranchService(store, workspace, () => now);
  const task = service.create('fix', 'success', ownerId, now).task;
  service.approve(request(task.plan), ownerId, now);
  const running = service.simulate(task.taskId, task.plan.planHash, ownerId, now);
  service.control(event(task.plan, 'cancel'), ownerId, now);
  resolveResult({ status: 'UNKNOWN', reason: null, receiptId: null });
  await assert.rejects(running, { code: 'BRANCH_INVALIDATED' });
  assert.equal(service.inspect(task.taskId, ownerId, now).task.status, 'UNKNOWN');
  const regular = new SyntheticBranchService(store, new MockBranchWorkspace(), () => now);
  const completed = regular.create('feature', 'success', ownerId, now).task;
  regular.approve(request(completed.plan), ownerId, now);
  await regular.simulate(completed.taskId, completed.plan.planHash, ownerId, now);
  const before = regular.inspect(completed.taskId, ownerId, now);
  regular.control(event(completed.plan, 'cancel'), ownerId, now);
  assert.deepEqual(regular.inspect(completed.taskId, ownerId, now), before);
});

test('시도 INSERT 실패는 승인 소비와 상태를 rollback하고 모의 포트를 호출하지 않는다', async (context) => {
  const { store, path } = await openStore(context);
  let calls = 0;
  const service = new SyntheticBranchService(store, { mode: 'offline', simulate: async () => {
    calls += 1; return { status: 'UNKNOWN', reason: 'BRANCH_MOCK_UNKNOWN', receiptId: null };
  } }, () => now);
  const task = service.create('fix', 'success', ownerId, now).task;
  service.approve(request(task.plan), ownerId, now);
  withDatabase(path, (db) => db.exec("CREATE TRIGGER deny_branch_attempt BEFORE INSERT ON branch_attempts BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_STORAGE_FAILURE'); END"));
  await assert.rejects(service.simulate(task.taskId, task.plan.planHash, ownerId, now));
  assert.equal(calls, 0);
  const snapshot = store.inspect(task.taskId, ownerId, now);
  assert.equal(snapshot.task.status, 'APPROVED');
  assert.equal(snapshot.approvals[0]?.usedAt, null);
  assert.equal(snapshot.attempt, null);
});

test('두 독립 DB 연결의 동시 claim은 한 승인과 시도만 생성한다', async (context) => {
  const { store, path } = await openStore(context);
  const plan = createBranchPlan('fix', 'success', ownerId, now);
  store.create(plan, now);
  store.approve(request(plan), ownerId, now);
  const barrier = new SharedArrayBuffer(4);
  let ready = 0;
  const workers = [0, 1].map(() => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ SqliteBranchStore }) => {
      const store = new SqliteBranchStore(workerData.path);
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try {
        const result = store.claim(workerData.taskId, workerData.hash, workerData.owner, new Date(workerData.now));
        parentPort.postMessage({ claimed: result.attempt.attemptId });
      } catch (error) { parentPort.postMessage({ failed: error.code }); }
      finally { store.close(); }
    }).catch((error) => { throw error; });
  `, { eval: true, workerData: { module: pathToFileURL(resolve('dist/src/adapters/sqlite-branch-store.js')).href,
    path, barrier, taskId: plan.taskId, hash: plan.planHash, owner: ownerId, now: now.toISOString() } }));
  context.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  const results = await Promise.all(workers.map((worker) => new Promise<{ claimed?: string; failed?: string }>((resolveResult, reject) => {
    worker.on('error', reject);
    worker.on('message', (message: { ready?: boolean; claimed?: string; failed?: string }) => {
      if (!message.ready) { resolveResult(message); return; }
      ready += 1;
      if (ready === 2) { Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, 2); }
    });
  })));
  assert.equal(results.filter((result) => result.claimed).length, 1);
  assert.equal(results.filter((result) => result.failed === 'BRANCH_ALREADY_ATTEMPTED').length, 1);
  assert.equal(store.inspect(plan.taskId, ownerId, now).task.status, 'SIMULATING');
});

test('DB의 계획·승인·시도 metadata 변조는 조회부터 거부한다', async (context) => {
  const { store, path } = await openStore(context);
  const plan = createBranchPlan('fix', 'success', ownerId, now);
  store.create(plan, now);
  store.approve(request(plan), ownerId, now);
  const claim = store.claim(plan.taskId, plan.planHash, ownerId, now);
  store.finish(claim.attempt.attemptId, { status: 'SIMULATED', reason: null, receiptId: `mock-branch:${claim.attempt.attemptId}` }, now);
  withDatabase(path, (db) => {
    for (const [table, key, id, mutate] of [
      ['branch_tasks', 'task_id', plan.taskId, (value: Record<string, unknown>) => { (value.plan as BranchPlan).branchName = 'main'; }],
      ['branch_tasks', 'task_id', plan.taskId, (value: Record<string, unknown>) => { value.failureCode = 'BRANCH_UNEXPECTED_RESULT'; }],
      ['branch_approvals', 'approval_id', claim.attempt.approvalId, (value: Record<string, unknown>) => { value.usedAt = null; }],
      ['branch_attempts', 'attempt_id', claim.attempt.attemptId, (value: Record<string, unknown>) => { value.receiptId = 'unexpected'; }],
    ] as const) {
      const row = db.prepare(`SELECT payload FROM ${table} WHERE ${key} = ?`).get(id)!;
      const value = JSON.parse(String(row.payload)) as Record<string, unknown>;
      mutate(value);
      db.prepare(`UPDATE ${table} SET payload = ? WHERE ${key} = ?`).run(JSON.stringify(value), id);
      assert.throws(() => store.inspect(plan.taskId, ownerId, now));
      db.prepare(`UPDATE ${table} SET payload = ? WHERE ${key} = ?`).run(row.payload!, id);
    }
    const row = db.prepare('SELECT payload FROM branch_tasks WHERE task_id = ?').get(plan.taskId)!;
    const value = JSON.parse(String(row.payload)) as BranchTask;
    value.plan.fixture = 'unknown';
    value.plan.planHash = hashBranchPlan(value.plan);
    db.prepare('UPDATE branch_tasks SET payload = ? WHERE task_id = ?').run(JSON.stringify(value), plan.taskId);
    assert.throws(() => store.inspect(plan.taskId, ownerId, now), { code: 'BRANCH_INVALID_STORED_TASK' });
  });
});

test('합성 기준 변경은 승인 불가이며 private 디렉터리·DB·sidecar 링크 경계를 강제한다', async (context) => {
  const harness = await openStore(context);
  const plan = createBranchPlan('fix', 'source-changed', ownerId, now);
  assert.equal(harness.store.create(plan, now).status, 'BLOCKED');
  assert.throws(() => harness.store.approve(request(plan), ownerId, now), { code: 'BRANCH_INVALIDATED' });
  const sentinel = join(harness.directory, 'sentinel');
  await writeFile(sentinel, 'SYNTHETIC_PROTECTED', { mode: 0o600 });
  const before = await readFile(sentinel);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    await symlink(sentinel, `${harness.path}${suffix}`);
    assert.throws(() => harness.store.inspect(plan.taskId, ownerId, now), { code: 'UNSAFE_RUNTIME_FILE' });
    await rm(`${harness.path}${suffix}`);
  }
  await link(harness.path, join(harness.directory, 'linked.sqlite'));
  assert.throws(() => harness.store.inspect(plan.taskId, ownerId, now), { code: 'UNSAFE_RUNTIME_FILE' });
  await rm(join(harness.directory, 'linked.sqlite'));
  await chmod(harness.path, 0o644);
  assert.throws(() => harness.store.inspect(plan.taskId, ownerId, now), { code: 'UNSAFE_RUNTIME_FILE' });
  await chmod(harness.path, 0o600);
  await chmod(harness.directory, 0o755);
  assert.throws(() => harness.store.inspect(plan.taskId, ownerId, now), { code: 'UNSAFE_RUNTIME_PATH' });
  await chmod(harness.directory, 0o700);
  const alias = `${harness.directory}-alias`;
  await symlink(harness.directory, alias);
  try { assert.throws(() => new SqliteBranchStore(join(alias, 'branches.sqlite')), { code: 'UNSAFE_RUNTIME_PATH' }); }
  finally { await rm(alias); }
  assert.deepEqual(await readFile(sentinel), before);
});
