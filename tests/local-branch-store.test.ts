import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { SyntheticLocalBranchWorkspace } from '../src/adapters/local-branch-workspace.js';
import { SqliteLocalBranchStore } from '../src/adapters/sqlite-local-branch-store.js';
import type { BranchWorkType } from '../src/domain/branch.js';
import type { LocalBranchApprovalRequest, LocalBranchPlan, LocalBranchTask } from '../src/domain/local-branch.js';
import { createBranchPlan } from '../src/policy/branch-policy.js';
import { createLocalBranchPlan, hashLocalBranchPlan } from '../src/policy/local-branch-policy.js';

const now = new Date('2026-11-12T00:00:00.000Z');
const ownerId = `os-user:${process.getuid?.()}`;
const later = (minutes: number): Date => new Date(now.getTime() + minutes * 60_000);
const request = (plan: LocalBranchPlan, expiresInMinutes = 30): LocalBranchApprovalRequest => ({
  taskId: plan.taskId, planHash: plan.planHash, expiresInMinutes,
});
const makeWritable = (path: string): void => {
  const metadata = fs.lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  fs.chmodSync(path, 0o700);
  for (const name of fs.readdirSync(path)) makeWritable(join(path, name));
};
const setup = (context: TestContext) => {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'harness-local-branch-store-')));
  fs.chmodSync(directory, 0o700);
  const path = join(directory, 'local-branches.sqlite');
  let store = new SqliteLocalBranchStore(path);
  const workspace = new SyntheticLocalBranchWorkspace(directory);
  context.after(() => { store.close(); makeWritable(directory); fs.rmSync(directory, { recursive: true, force: true }); });
  const plan = async (workType: BranchWorkType = 'fix'): Promise<LocalBranchPlan> => {
    const taskId = randomUUID();
    const repository = await workspace.prepare(taskId, workType);
    const result = createLocalBranchPlan(taskId, workType, ownerId, repository, now);
    store.create(result, now);
    return result;
  };
  return { directory, path, workspace, plan, get store() { return store; },
    reopen: () => { store.close(); store = new SqliteLocalBranchStore(path); return store; } };
};
const withDatabase = <T>(path: string, operation: (database: DatabaseSync) => T): T => {
  const database = new DatabaseSync(path);
  try { return operation(database); } finally { database.close(); }
};

test('실제 합성 계획은 private DB에 멱등 보관되고 승인 전 ref와 기존 source를 바꾸지 않는다', async (context) => {
  const harness = setup(context);
  const plan = await harness.plan('feature');
  const observation = harness.workspace.observe(plan);
  assert.equal(observation.state, 'absent');
  const created = harness.store.inspect(plan.taskId, ownerId, now);
  assert.equal(created.task.status, 'AWAITING_APPROVAL');
  assert.deepEqual(harness.store.create(plan, now), created.task);
  assert.equal(fs.statSync(harness.path).mode & 0o777, 0o600);
  assert.throws(() => harness.store.claim(plan.taskId, plan.planHash, observation, ownerId, now),
    { code: 'LOCAL_BRANCH_APPROVAL_REQUIRED' });
  assert.deepEqual(harness.workspace.observe(plan), observation);
  assert.equal(harness.store.inspect(plan.taskId, ownerId, now).attempt, null);
  const changed = { ...plan, repository: { ...plan.repository, ownerToken: 'e'.repeat(64) } };
  changed.planHash = hashLocalBranchPlan(changed);
  assert.throws(() => harness.store.create(changed, now), { code: 'LOCAL_BRANCH_TASK_CONFLICT' });
  const outside = { ...plan, repository: { ...plan.repository, root: `/private/tmp/other/git-branches/${plan.taskId}` } };
  outside.planHash = hashLocalBranchPlan(outside);
  assert.throws(() => harness.store.create(outside, now), { code: 'LOCAL_BRANCH_ROOT_MISMATCH' });
  const mock = createBranchPlan('fix', 'success', ownerId, now);
  assert.throws(() => harness.store.create(mock as unknown as LocalBranchPlan, now), { code: 'LOCAL_BRANCH_INVALID_PLAN' });
});

test('local 승인은 정확한 hash·필수 TTL·OS 소유자·absent 관찰을 검증하고 snapshot을 보존한다', async (context) => {
  const { store, workspace, plan: createPlan } = setup(context);
  const plan = await createPlan();
  const observation = workspace.observe(plan);
  for (const ttl of [0, 61, 1.5, NaN, Infinity]) {
    assert.throws(() => store.approve(request(plan, ttl), observation, ownerId, now), { code: 'LOCAL_BRANCH_INVALID_APPROVAL' });
  }
  assert.throws(() => store.approve({ ...request(plan), planHash: 'f'.repeat(64) }, observation, ownerId, now),
    { code: 'LOCAL_BRANCH_PLAN_HASH_MISMATCH' });
  assert.throws(() => store.approve({ ...request(plan), policy: 'synthetic-branch-v1' } as LocalBranchApprovalRequest, observation, ownerId, now),
    { code: 'LOCAL_BRANCH_INVALID_APPROVAL' });
  assert.throws(() => store.approve(request(plan), observation, 'os-user:99999999', now), { code: 'LOCAL_BRANCH_OWNER_MISMATCH' });
  assert.throws(() => store.approve(request(plan), { ...observation, sourceHash: 'f'.repeat(64) }, ownerId, now),
    { code: 'LOCAL_BRANCH_INVALID_OBSERVATION' });
  const approval = store.approve(request(plan), observation, ownerId, now);
  assert.deepEqual(approval.planSnapshot, plan);
  approval.planSnapshot.branchName = 'main';
  assert.deepEqual(store.inspect(plan.taskId, ownerId, now).approvals[0]?.planSnapshot, plan);
  assert.throws(() => store.approve(request(plan), observation, ownerId, now), { code: 'LOCAL_BRANCH_APPROVAL_EXISTS' });
  const uid = process.getuid;
  try {
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    assert.throws(() => store.claim(plan.taskId, plan.planHash, observation, ownerId, now), { code: 'LOCAL_BRANCH_OWNER_MISMATCH' });
  } finally { Object.defineProperty(process, 'getuid', { value: uid, configurable: true }); }
  assert.equal(workspace.observe(plan).state, 'absent');
});

test('승인 만료는 영속 취소되고 재승인 이력을 보존하며 계획 만료 뒤에는 claim하지 않는다', async (context) => {
  const { store, workspace, plan: createPlan } = setup(context);
  const plan = await createPlan('chore');
  const observation = workspace.observe(plan);
  const first = store.approve(request(plan, 1), observation, ownerId, now);
  assert.throws(() => store.claim(plan.taskId, plan.planHash, observation, ownerId, later(1)), { code: 'LOCAL_BRANCH_APPROVAL_REQUIRED' });
  const expired = store.inspect(plan.taskId, ownerId, later(1));
  assert.equal(expired.task.status, 'AWAITING_APPROVAL');
  assert.equal(expired.approvals[0]?.revokedAt, later(1).toISOString());
  const second = store.approve(request(plan, 60), observation, ownerId, later(1));
  assert.notEqual(first.approvalId, second.approvalId);
  assert.deepEqual(store.inspect(plan.taskId, ownerId, later(1)).approvalPage, { offset: 0, total: 2, nextOffset: 1 });
  assert.equal(store.inspect(plan.taskId, ownerId, later(1), 1).approvals[0]?.approvalId, first.approvalId);
  for (const offset of [-1, 0.5, Infinity, 1_000_000_001]) assert.throws(() => store.inspect(plan.taskId, ownerId, later(1), offset));
  store.inspect(plan.taskId, ownerId, later(1439));
  assert.equal(store.approve(request(plan, 60), observation, ownerId, later(1439)).expiresAt, plan.expiresAt);
  assert.throws(() => store.claim(plan.taskId, plan.planHash, observation, ownerId, later(1440)), { code: 'LOCAL_BRANCH_NOT_READY' });
  assert.equal(store.inspect(plan.taskId, ownerId, later(1440)).task.failureCode, 'LOCAL_BRANCH_PLAN_EXPIRED');
  assert.equal(workspace.observe(plan).state, 'absent');
});

test('승인 소비 후 claimed·writing·created intent와 실제 ref를 한 번만 기록한다', async (context) => {
  const harness = setup(context);
  const plan = await harness.plan('refactor');
  const observation = harness.workspace.observe(plan);
  harness.store.approve(request(plan), observation, ownerId, now);
  const claim = harness.store.claim(plan.taskId, plan.planHash, observation, ownerId, later(1));
  assert.equal(claim.phase, 'claimed');
  assert.equal(harness.store.inspect(plan.taskId, ownerId, later(1)).approvals[0]?.usedAt, later(1).toISOString());
  let writes = 0;
  assert.throws(() => harness.store.writeGuard(plan.taskId, ownerId, later(1), () => { writes += 1; }),
    { code: 'LOCAL_BRANCH_INVALID_PHASE' });
  assert.equal(writes, 0);
  harness.store.beginWrite(plan.taskId, ownerId, later(2));
  assert.equal(harness.store.inspect(plan.taskId, ownerId, later(2)).attempt?.writeStartedAt, later(2).toISOString());
  harness.store.writeGuard(plan.taskId, ownerId, later(3), () => { writes += 1; harness.workspace.createRef(plan); });
  assert.equal(writes, 1);
  const created = harness.store.inspect(plan.taskId, ownerId, later(3)).attempt;
  assert.equal(created?.phase, 'created');
  assert.equal(created?.refCreatedAt, later(3).toISOString());
  const finished = harness.store.finish(plan.taskId, harness.workspace.observe(plan), null, false, ownerId, later(4));
  assert.equal(finished.task.status, 'SUCCEEDED');
  assert.equal(finished.attempt?.after?.state, 'created');
  assert.equal(finished.attempt?.before.state, 'absent');
  assert.deepEqual(harness.reopen().inspect(plan.taskId, ownerId, later(4)), finished);
  assert.deepEqual(harness.store.cancel(plan.taskId, ownerId, later(5)), finished);
  assert.throws(() => harness.store.claim(plan.taskId, plan.planHash, observation, ownerId, later(5)), { code: 'LOCAL_BRANCH_NOT_READY' });
  assert.throws(() => harness.store.finish(plan.taskId, harness.workspace.observe(plan), null, true, ownerId, later(5)),
    { code: 'LOCAL_BRANCH_NOT_RUNNING' });
});

test('취소는 대기 승인을 revoke하며 진행 중 취소 이후 ref 쓰기를 거부하고 반복 취소는 멱등이다', async (context) => {
  const { store, workspace, plan: createPlan } = setup(context);
  for (const phase of ['awaiting', 'approved', 'claimed', 'writing'] as const) {
    const plan = await createPlan();
    const observation = workspace.observe(plan);
    if (phase !== 'awaiting') store.approve(request(plan), observation, ownerId, now);
    if (phase === 'claimed' || phase === 'writing') store.claim(plan.taskId, plan.planHash, observation, ownerId, now);
    if (phase === 'writing') store.beginWrite(plan.taskId, ownerId, now);
    const cancelled = store.cancel(plan.taskId, ownerId, later(1));
    assert.deepEqual(store.cancel(plan.taskId, ownerId, later(2)), cancelled);
    assert.equal(cancelled.task.generation, 1);
    assert.equal(cancelled.task.cancelledAt, later(1).toISOString());
    if (phase === 'awaiting' || phase === 'approved') {
      assert.equal(cancelled.task.status, 'CANCELLED');
      if (phase === 'approved') assert.equal(cancelled.approvals[0]?.revokedAt, later(1).toISOString());
      assert.throws(() => store.claim(plan.taskId, plan.planHash, observation, ownerId, later(2)), { code: 'LOCAL_BRANCH_NOT_READY' });
    } else {
      assert.equal(cancelled.task.status, 'RUNNING');
      assert.ok(cancelled.approvals[0]?.usedAt);
      assert.equal(cancelled.approvals[0]?.revokedAt, null);
      let called = false;
      assert.throws(() => store.beginWrite(plan.taskId, ownerId, later(2)), { code: 'LOCAL_BRANCH_CANCELLED' });
      assert.throws(() => store.writeGuard(plan.taskId, ownerId, later(2), () => { called = true; }), { code: 'LOCAL_BRANCH_CANCELLED' });
      assert.equal(called, false);
      assert.equal(store.finish(plan.taskId, workspace.observe(plan), null, true, ownerId, later(2)).task.status, 'CANCELLED');
    }
    assert.equal(workspace.observe(plan).state, 'absent');
  }
});

test('claim 이후에도 TTL을 재검증하여 만료 시 ref 작업을 시작하지 않는다', async (context) => {
  const { store, workspace, plan: createPlan } = setup(context);
  for (const begun of [false, true]) {
    const plan = await createPlan();
    const observation = workspace.observe(plan);
    store.approve(request(plan, 1), observation, ownerId, now);
    store.claim(plan.taskId, plan.planHash, observation, ownerId, now);
    if (begun) store.beginWrite(plan.taskId, ownerId, now);
    let called = false;
    assert.throws(() => store.beginWrite(plan.taskId, ownerId, later(1)), { code: 'LOCAL_BRANCH_APPROVAL_EXPIRED' });
    assert.throws(() => store.writeGuard(plan.taskId, ownerId, later(1), () => { called = true; }), { code: 'LOCAL_BRANCH_APPROVAL_EXPIRED' });
    assert.equal(called, false);
    const finished = store.finish(plan.taskId, observation, 'LOCAL_BRANCH_APPROVAL_EXPIRED', false, ownerId, later(1));
    assert.equal(finished.task.status, 'FAILED');
    assert.equal(finished.approvals[0]?.usedAt, now.toISOString());
    assert.equal(workspace.observe(plan).state, 'absent');
  }
});

test('시도 INSERT 실패는 승인 소비와 RUNNING 전환을 함께 rollback한다', async (context) => {
  const { store, path, workspace, plan: createPlan } = setup(context);
  const plan = await createPlan();
  const observation = workspace.observe(plan);
  store.approve(request(plan), observation, ownerId, now);
  withDatabase(path, (database) => database.exec("CREATE TRIGGER deny_local_claim BEFORE INSERT ON local_branch_attempts BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_STORAGE_FAILURE'); END"));
  assert.throws(() => store.claim(plan.taskId, plan.planHash, observation, ownerId, now));
  const snapshot = store.inspect(plan.taskId, ownerId, now);
  assert.equal(snapshot.task.status, 'APPROVED');
  assert.equal(snapshot.approvals[0]?.usedAt, null);
  assert.equal(snapshot.attempt, null);
  assert.equal(workspace.observe(plan).state, 'absent');
});

test('ref 쓰기 뒤 DB 실패는 writing intent와 생성된 ref를 보존하고 재시작 복구로 INTERRUPTED를 기록한다', async (context) => {
  const harness = setup(context);
  const plan = await harness.plan();
  const observation = harness.workspace.observe(plan);
  harness.store.approve(request(plan), observation, ownerId, now);
  harness.store.claim(plan.taskId, plan.planHash, observation, ownerId, now);
  harness.store.beginWrite(plan.taskId, ownerId, later(1));
  withDatabase(harness.path, (database) => database.exec(`CREATE TRIGGER deny_local_created BEFORE UPDATE ON local_branch_attempts
    WHEN json_extract(NEW.payload, '$.phase') = 'created'
    BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_STORAGE_FAILURE'); END`));
  assert.throws(() => harness.store.writeGuard(plan.taskId, ownerId, later(2), () => harness.workspace.createRef(plan)));
  assert.equal(harness.workspace.observe(plan).state, 'created');
  const pending = harness.reopen().inspect(plan.taskId, ownerId, later(2));
  assert.equal(pending.task.status, 'RUNNING');
  assert.equal(pending.attempt?.phase, 'writing');
  assert.equal(pending.attempt?.refCreatedAt, null);
  const recovered = harness.store.finish(plan.taskId, harness.workspace.observe(plan), null, true, ownerId, later(3));
  assert.equal(recovered.task.status, 'INTERRUPTED');
  assert.equal(recovered.attempt?.after?.state, 'created');
  assert.equal(recovered.approvals[0]?.usedAt, now.toISOString());
  assert.throws(() => harness.store.claim(plan.taskId, plan.planHash, observation, ownerId, later(3)));
  assert.deepEqual(harness.store.cancel(plan.taskId, ownerId, later(3)), recovered);
});

test('부분 ref·불안전한 관찰과 예상 밖 완료 결과는 성공으로 기록하지 않는다', async (context) => {
  const { store, workspace, plan: createPlan } = setup(context);
  const plan = await createPlan();
  const observation = workspace.observe(plan);
  store.approve(request(plan), observation, ownerId, now);
  store.claim(plan.taskId, plan.planHash, observation, ownerId, now);
  store.beginWrite(plan.taskId, ownerId, now);
  assert.throws(() => store.writeGuard(plan.taskId, ownerId, now, () => {
    const ref = join(plan.repository.root, 'workspace/.git/refs/heads', plan.workType);
    fs.mkdirSync(ref, { mode: 0o700 });
    fs.writeFileSync(join(ref, `task-${plan.taskId}`), 'partial', { flag: 'wx', mode: 0o600 });
    throw new Error('SYNTHETIC_PRIVATE_ERROR');
  }));
  const unsafe = workspace.observe(plan);
  assert.equal(unsafe.state, 'unsafe');
  assert.throws(() => store.finish(plan.taskId, unsafe, 'SYNTHETIC_PRIVATE_ERROR', true, ownerId, later(1)),
    { code: 'LOCAL_BRANCH_INVALID_RESULT' });
  const blocked = store.finish(plan.taskId, unsafe, null, true, ownerId, later(1));
  assert.equal(blocked.task.status, 'BLOCKED');
  assert.equal(JSON.stringify(blocked).includes('SYNTHETIC_PRIVATE_ERROR'), false);
  const uncreated = await createPlan('chore');
  const absent = workspace.observe(uncreated);
  store.approve(request(uncreated), absent, ownerId, now);
  store.claim(uncreated.taskId, uncreated.planHash, absent, ownerId, now);
  assert.equal(store.finish(uncreated.taskId, absent, null, false, ownerId, later(1)).task.status, 'BLOCKED');
});

test('두 독립 연결의 동시 claim은 하나의 승인과 시도만 소비한다', { timeout: 15_000 }, async (context) => {
  const { store, path, workspace, plan: createPlan } = setup(context);
  const plan = await createPlan();
  const observation = workspace.observe(plan);
  store.approve(request(plan), observation, ownerId, now);
  const barrier = new SharedArrayBuffer(4);
  let ready = 0;
  const workers = [0, 1].map(() => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ SqliteLocalBranchStore }) => {
      const store = new SqliteLocalBranchStore(workerData.path);
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      try {
        const result = store.claim(workerData.taskId, workerData.hash, workerData.observation, workerData.owner, new Date(workerData.now));
        parentPort.postMessage({ claimed: result.attemptId });
      } catch (error) { parentPort.postMessage({ failed: error.code }); }
      finally { store.close(); }
    }).catch((error) => { throw error; });
  `, { eval: true, workerData: { module: pathToFileURL(resolve('dist/src/adapters/sqlite-local-branch-store.js')).href,
    path, barrier, taskId: plan.taskId, hash: plan.planHash, observation, owner: ownerId, now: now.toISOString() } }));
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
  assert.equal(results.filter((result) => result.failed === 'LOCAL_BRANCH_NOT_READY').length, 1);
  assert.equal(store.inspect(plan.taskId, ownerId, now).task.status, 'RUNNING');
  assert.equal(workspace.observe(plan).state, 'absent');
});

test('계획·승인·lifecycle·관찰 payload 변조는 조회부터 거부하고 원래 감사 기록을 보존한다', async (context) => {
  const { store, path, workspace, plan: createPlan } = setup(context);
  const plan = await createPlan();
  const observation = workspace.observe(plan);
  store.approve(request(plan), observation, ownerId, now);
  const claim = store.claim(plan.taskId, plan.planHash, observation, ownerId, now);
  store.beginWrite(plan.taskId, ownerId, now);
  store.writeGuard(plan.taskId, ownerId, now, () => workspace.createRef(plan));
  const completed = store.finish(plan.taskId, workspace.observe(plan), null, false, ownerId, now);
  withDatabase(path, (database) => {
    const cases: [string, string, string, (value: Record<string, unknown>) => void][] = [
      ['local_branch_tasks', 'task_id', plan.taskId, (value) => { (value.plan as LocalBranchPlan).branchName = 'main'; }],
      ['local_branch_tasks', 'task_id', plan.taskId, (value) => { value.failureCode = 'LOCAL_BRANCH_TAMPERED'; }],
      ['local_branch_approvals', 'approval_id', claim.approvalId, (value) => { value.usedAt = null; }],
      ['local_branch_approvals', 'approval_id', claim.approvalId, (value) => { (value.planSnapshot as LocalBranchPlan).repository.sourceHash = 'f'.repeat(64); }],
      ['local_branch_attempts', 'attempt_id', claim.attemptId, (value) => { value.phase = 'writing'; }],
      ['local_branch_attempts', 'attempt_id', claim.attemptId, (value) => { value.refCreatedAt = null; }],
      ['local_branch_attempts', 'attempt_id', claim.attemptId, (value) => { (value.after as Record<string, unknown>).branchOid = 'f'.repeat(40); }],
    ];
    for (const [table, key, id, mutate] of cases) {
      const row = database.prepare(`SELECT payload FROM ${table} WHERE ${key} = ?`).get(id)!;
      const value = JSON.parse(String(row.payload)) as Record<string, unknown>;
      mutate(value);
      database.prepare(`UPDATE ${table} SET payload = ? WHERE ${key} = ?`).run(JSON.stringify(value), id);
      assert.throws(() => store.inspect(plan.taskId, ownerId, now));
      database.prepare(`UPDATE ${table} SET payload = ? WHERE ${key} = ?`).run(row.payload!, id);
    }
  });
  assert.deepEqual(store.inspect(plan.taskId, ownerId, now), completed);
});

test('미래 상태보다 오래된 명령은 기록을 되돌리지 않고 차단·취소 terminal 상태는 반복 조회해도 보존한다', async (context) => {
  const { store, workspace, plan: createPlan } = setup(context);
  const plan = await createPlan();
  const observation = workspace.observe(plan);
  store.approve(request(plan), observation, ownerId, later(2));
  const approved = store.inspect(plan.taskId, ownerId, later(2));
  assert.throws(() => store.create(plan, later(1)), { code: 'LOCAL_BRANCH_INVALID_TIME' });
  assert.throws(() => store.claim(plan.taskId, plan.planHash, observation, ownerId, later(1)), { code: 'LOCAL_BRANCH_INVALID_TIME' });
  assert.deepEqual(store.inspect(plan.taskId, ownerId, later(2)), approved);
  store.block(plan.taskId, 'LOCAL_BRANCH_UNSAFE_WORKSPACE', ownerId, later(3));
  const blocked = store.inspect(plan.taskId, ownerId, later(3));
  assert.equal(blocked.task.status, 'BLOCKED');
  assert.equal(blocked.approvals[0]?.revokedAt, later(3).toISOString());
  assert.deepEqual(store.cancel(plan.taskId, ownerId, later(4)), blocked);
  assert.deepEqual(store.inspect(plan.taskId, ownerId, later(5)), blocked);
});

test('private DB·저널 링크와 공개 권한을 거부하고 보호 파일을 변경하지 않는다', async (context) => {
  const harness = setup(context);
  const plan = await harness.plan();
  const sentinel = join(harness.directory, 'sentinel');
  fs.writeFileSync(sentinel, 'SYNTHETIC_PROTECTED', { mode: 0o600 });
  const before = fs.readFileSync(sentinel);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    fs.symlinkSync(sentinel, `${harness.path}${suffix}`);
    assert.throws(() => harness.store.inspect(plan.taskId, ownerId, now), { code: 'UNSAFE_RUNTIME_FILE' });
    fs.unlinkSync(`${harness.path}${suffix}`);
  }
  const hardlink = join(harness.directory, 'linked.sqlite');
  fs.linkSync(harness.path, hardlink);
  assert.throws(() => harness.store.inspect(plan.taskId, ownerId, now), { code: 'UNSAFE_RUNTIME_FILE' });
  fs.unlinkSync(hardlink);
  fs.chmodSync(harness.path, 0o644);
  assert.throws(() => harness.store.inspect(plan.taskId, ownerId, now), { code: 'UNSAFE_RUNTIME_FILE' });
  fs.chmodSync(harness.path, 0o600);
  fs.chmodSync(harness.directory, 0o755);
  assert.throws(() => harness.store.inspect(plan.taskId, ownerId, now), { code: 'UNSAFE_RUNTIME_PATH' });
  fs.chmodSync(harness.directory, 0o700);
  assert.deepEqual(fs.readFileSync(sentinel), before);
  const current = harness.store.inspect(plan.taskId, ownerId, now).task as LocalBranchTask;
  assert.equal(current.status, 'AWAITING_APPROVAL');
});
