import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { SqliteExecutionStore } from '../src/adapters/sqlite-execution-store.js';
import {
  EXECUTION_LIMITS, EXECUTION_POLICY_VERSION,
  type ExecutionApproval, type ExecutionApprovalContext, type ExecutionApprovalRequest,
  type ExecutionPlan, type ExecutionRun, type ExecutionRunRequest, type ExecutionTask,
} from '../src/domain/execution.js';
import { getExecutionCommand, hashExecutionPlan, sha256 } from '../src/policy/execution-policy.js';

const now = new Date('2026-11-10T00:00:00.000Z');
const ownerId = `os-user:${process.getuid?.()}`;
const contextAt = (at: Date = now): ExecutionApprovalContext => ({ ownerId, now: at });

const plannedTask = (): ExecutionTask => {
  const taskId = randomUUID();
  const content: Omit<ExecutionPlan, 'planHash'> = {
    planId: randomUUID(), version: 1, taskId, requestRevision: 'synthetic-1', repoId: 'synthetic-execution',
    baseCommit: 'a'.repeat(40), sourceHash: 'b'.repeat(64), allowedFiles: ['src/message.mjs'],
    patches: [{
      operation: 'replace', path: 'src/message.mjs', beforeHash: sha256('old\n'), afterHash: sha256('new\n'), content: 'new\n',
    }],
    commands: [getExecutionCommand('synthetic-check-v1')],
    policy: {
      version: EXECUTION_POLICY_VERSION, backend: 'docker', serverVersion: '29.4.3',
      imageId: `sha256:${'c'.repeat(64)}`, nodeVersion: '24.22.2', configHash: 'd'.repeat(64),
      limits: EXECUTION_LIMITS, network: 'none',
    },
  };
  return {
    taskId, status: 'AWAITING_APPROVAL', requestRevision: content.requestRevision, baseCommit: content.baseCommit,
    sourceRoot: '/private/tmp/synthetic-execution-source', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    plan: { ...content, planHash: hashExecutionPlan(content) },
  };
};

const approvalRequest = (task: ExecutionTask, overrides: Partial<ExecutionApprovalRequest> = {}): ExecutionApprovalRequest => ({
  taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit, expiresInMinutes: 30, ...overrides,
});
const runRequest = (task: ExecutionTask, overrides: Partial<ExecutionRunRequest> = {}): ExecutionRunRequest => ({
  taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit, ...overrides,
});
const finishedRun = (run: ExecutionRun, overrides: Partial<ExecutionRun> = {}): ExecutionRun => ({
  ...run, status: 'FAILED', finishedAt: new Date(now.getTime() + 1_000).toISOString(), failureCode: 'SYNTHETIC_TEST_FAILURE',
  checks: [{ name: 'registered_command', status: 'failed', reason: '합성 실패 결과' }], ...overrides,
});

const openStore = async (testContext: TestContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-execution-store-')));
  await chmod(directory, 0o700);
  const path = join(directory, 'execution.sqlite');
  let store = new SqliteExecutionStore(path);
  testContext.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, path, get store() { return store; },
    reopen: () => { store.close(); store = new SqliteExecutionStore(path); return store; },
  };
};

const withDatabase = <T>(path: string, operation: (database: DatabaseSync) => T): T => {
  const database = new DatabaseSync(path);
  try { return operation(database); } finally { database.close(); }
};

const rewriteApproval = (path: string, approval: ExecutionApproval): void => withDatabase(path, (database) => {
  database.prepare(`UPDATE execution_approvals SET owner_id = ?, used_at = ?, revoked_at = ?, payload = ? WHERE approval_id = ?`)
    .run(approval.ownerId, approval.usedAt, approval.revokedAt, JSON.stringify(approval), approval.approvalId);
});

test('실행 작업은 검증된 승인 대기 계획만 저장하고 파일을 0600으로 유지한다', async (testContext) => {
  const { store, path } = await openStore(testContext);
  const task = plannedTask();
  for (const status of ['APPROVED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED'] as const) {
    assert.throws(() => store.create({ ...task, status }), { code: 'APPROVAL_STATE_MANAGED' });
  }
  assert.throws(() => store.create({ ...task, requestRevision: 'changed' }), { code: 'EXECUTION_CONTEXT_MISMATCH' });
  assert.throws(() => store.create({ ...task, baseCommit: 'e'.repeat(40) }), { code: 'EXECUTION_CONTEXT_MISMATCH' });
  assert.throws(() => store.create({ ...task, taskId: randomUUID() }), { code: 'EXECUTION_CONTEXT_MISMATCH' });
  assert.throws(() => store.create({ ...task, plan: { ...task.plan, planHash: 'f'.repeat(64) } }), { code: 'PLAN_HASH_MISMATCH' });
  store.create(task);
  assert.deepEqual(store.find(task.taskId), task);
  assert.throws(() => store.create(task), { code: 'EXECUTION_TASK_ALREADY_EXISTS' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(store.find('legacy-task-id'), null);
});

test('새 실행 승인은 OS 소유자와 불변 계획 snapshot을 보존하고 재시작해도 남는다', async (testContext) => {
  const harness = await openStore(testContext);
  const task = plannedTask();
  harness.store.create(task);
  const approval = harness.store.approve(approvalRequest(task), contextAt());
  assert.equal(approval.executionPolicy, EXECUTION_POLICY_VERSION);
  assert.equal(approval.ownerId, ownerId);
  assert.equal(approval.usedAt, null);
  assert.equal(approval.expiresAt, '2026-11-10T00:30:00.000Z');
  assert.equal(harness.store.find(task.taskId)?.status, 'APPROVED');
  assert.deepEqual(approval.planSnapshot, task.plan);
  approval.planSnapshot.patches[0]!.content = 'returned object mutation';
  assert.deepEqual(harness.store.listApprovals(task.taskId)[0]?.planSnapshot, task.plan);
  const reopened = harness.reopen();
  assert.equal(reopened.find(task.taskId)?.status, 'APPROVED');
  assert.equal(reopened.listApprovals(task.taskId)[0]?.usedAt, null);
  assert.equal(reopened.listRuns(task.taskId).length, 0);
});

test('TTL·소유자·시간·계획·커밋 오류는 승인과 상태 변경을 남기지 않는다', async (testContext) => {
  const { store } = await openStore(testContext);
  const task = plannedTask();
  store.create(task);
  for (const expiresInMinutes of [0, -1, 1.5, 1_441, NaN, Infinity, undefined]) {
    assert.throws(() => store.approve({ ...approvalRequest(task), expiresInMinutes } as ExecutionApprovalRequest, contextAt()),
      { code: 'INVALID_EXECUTION_APPROVAL_REQUEST' });
  }
  assert.throws(() => store.approve(approvalRequest(task), { ownerId: 'os-user:9999999', now }), { code: 'APPROVAL_OWNER_MISMATCH' });
  assert.throws(() => store.approve(approvalRequest(task), { ownerId, now: new Date(NaN) }), { code: 'INVALID_APPROVAL_TIME' });
  assert.throws(() => store.approve(approvalRequest(task, { planHash: 'e'.repeat(64) }), contextAt()), { code: 'PLAN_HASH_MISMATCH' });
  assert.throws(() => store.approve(approvalRequest(task, { baseCommit: 'e'.repeat(40) }), contextAt()), { code: 'EXECUTION_CONTEXT_MISMATCH' });
  assert.throws(() => store.approve(approvalRequest(task, { taskId: 'legacy-task-id' }), contextAt()), { code: 'EXECUTION_TASK_NOT_FOUND' });
  assert.equal(store.find(task.taskId)?.status, 'AWAITING_APPROVAL');
  assert.deepEqual(store.listApprovals(task.taskId), []);
  const approval = store.approve(approvalRequest(task, { expiresInMinutes: 1_440 }), contextAt());
  assert.equal(approval.expiresAt, '2026-11-11T00:00:00.000Z');
  assert.throws(() => store.approve(approvalRequest(task), contextAt()), { code: 'APPROVAL_ALREADY_EXISTS' });
});

test('승인 없는 실행과 요청 해시·커밋·소유자 불일치는 Run을 만들지 않는다', async (testContext) => {
  const { store, directory } = await openStore(testContext);
  const task = plannedTask();
  store.create(task);
  assert.throws(() => store.beginRun(runRequest(task), contextAt(), directory), { code: 'APPROVAL_REQUIRED' });
  store.approve(approvalRequest(task), contextAt());
  assert.throws(() => store.beginRun(runRequest(task, { planHash: 'e'.repeat(64) }), contextAt(), directory), { code: 'PLAN_HASH_MISMATCH' });
  assert.throws(() => store.beginRun(runRequest(task, { baseCommit: 'e'.repeat(40) }), contextAt(), directory), { code: 'EXECUTION_CONTEXT_MISMATCH' });
  assert.throws(() => store.beginRun(runRequest(task), { ownerId: 'uid:501', now }, directory), { code: 'APPROVAL_OWNER_MISMATCH' });
  assert.throws(() => store.beginRun(runRequest(task), contextAt(), 'relative'), { code: 'INVALID_EXECUTION_ARTIFACT_PATH' });
  assert.deepEqual(store.listRuns(task.taskId), []);
  assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, null);
  assert.equal(store.find(task.taskId)?.status, 'APPROVED');
});

test('승인은 정확히 한 번 소비되며 실패 Run과 snapshot을 보존하고 자동 재실행하지 않는다', async (testContext) => {
  const harness = await openStore(testContext);
  const task = plannedTask();
  harness.store.create(task);
  const approval = harness.store.approve(approvalRequest(task), contextAt());
  const run = harness.store.beginRun(runRequest(task), contextAt(), harness.directory);
  assert.equal(run.status, 'RUNNING');
  assert.equal(run.approvalId, approval.approvalId);
  assert.equal(harness.store.find(task.taskId)?.status, 'RUNNING');
  assert.deepEqual(harness.store.listApprovals(task.taskId)[0], { ...approval, usedAt: now.toISOString() });
  const terminal = finishedRun(run);
  harness.store.finishRun(terminal);
  terminal.checks[0]!.reason = 'returned object mutation';
  assert.equal(harness.store.findRun(run.runId)?.checks[0]?.reason, '합성 실패 결과');
  assert.equal(harness.store.find(task.taskId)?.status, 'FAILED');
  const reopened = harness.reopen();
  assert.equal(reopened.findRun(run.runId)?.status, 'FAILED');
  assert.equal(reopened.listApprovals(task.taskId)[0]?.usedAt, now.toISOString());
  assert.throws(() => reopened.beginRun(runRequest(task), contextAt(), harness.directory), { code: 'APPROVAL_ALREADY_USED' });
  assert.throws(() => reopened.approve(approvalRequest(task), contextAt()), { code: 'APPROVAL_ALREADY_USED' });
  assert.throws(() => reopened.finishRun(finishedRun(run)), { code: 'EXECUTION_RUN_ALREADY_FINISHED' });
  assert.equal(reopened.listRuns(task.taskId).length, 1);
});

test('만료 시각부터 revoke와 승인 대기 복귀를 commit하고 새 실행 승인을 허용한다', async (testContext) => {
  const { store, directory } = await openStore(testContext);
  const task = plannedTask();
  store.create(task);
  const expired = store.approve(approvalRequest(task, { expiresInMinutes: 1 }), contextAt());
  const expiry = new Date(now.getTime() + 60_000);
  assert.throws(() => store.beginRun(runRequest(task), contextAt(expiry), directory), { code: 'APPROVAL_EXPIRED' });
  assert.equal(store.find(task.taskId)?.status, 'AWAITING_APPROVAL');
  assert.deepEqual(store.listApprovals(task.taskId)[0], { ...expired, revokedAt: expiry.toISOString() });
  assert.deepEqual(store.listRuns(task.taskId), []);
  const renewed = store.approve(approvalRequest(task, { expiresInMinutes: 1 }), contextAt(expiry));
  assert.notEqual(renewed.approvalId, expired.approvalId);
  const run = store.beginRun(runRequest(task), contextAt(new Date(expiry.getTime() + 59_999)), directory);
  assert.equal(run.approvalId, renewed.approvalId);
});

test('만료 재승인 이력은 최신 한 건씩 SQL 페이지로 반환한다', async (testContext) => {
  const { store } = await openStore(testContext);
  const task = plannedTask();
  store.create(task);
  const approvals = [0, 1, 2].map((index) => store.approve(approvalRequest(task, { expiresInMinutes: 1 }),
    contextAt(new Date(now.getTime() + index * 60_000))));
  for (const offset of [0, 1, 2]) {
    const page = store.listApprovalHistory(task.taskId, offset);
    assert.equal(page.approvals.length, 1);
    assert.equal(page.approvals[0]?.approvalId, approvals[2 - offset]?.approvalId);
    assert.deepEqual(page.approvalPage, { offset, total: 3, nextOffset: offset === 2 ? null : offset + 1 });
  }
  assert.deepEqual(store.listApprovalHistory(task.taskId, 3), { approvals: [], approvalPage: { offset: 3, total: 3, nextOffset: null } });
  for (const offset of [-1, 1.5, NaN, Infinity, 1_000_000_001]) {
    assert.throws(() => store.listApprovalHistory(task.taskId, offset), { code: 'INVALID_APPROVAL_OFFSET' });
  }
});

test('승인 snapshot·정책·revision·행 메타데이터 변조는 실행 전에 차단한다', async (testContext) => {
  const { store, path, directory } = await openStore(testContext);
  for (const scenario of ['legacy-policy', 'snapshot-content', 'snapshot-revision', 'owner', 'column']) {
    const task = plannedTask();
    store.create(task);
    const approval = store.approve(approvalRequest(task), contextAt());
    const changed = structuredClone(approval);
    if (scenario === 'legacy-policy') changed.executionPolicy = 'approval-only-v1' as never;
    if (scenario === 'snapshot-content') changed.planSnapshot.patches[0]!.content = 'tampered';
    if (scenario === 'snapshot-revision') changed.requestRevision = 'changed';
    if (scenario === 'owner') changed.ownerId = 'os-user:9999999';
    rewriteApproval(path, changed);
    if (scenario === 'column') withDatabase(path, (database) => database.prepare('UPDATE execution_approvals SET owner_id = ? WHERE approval_id = ?')
      .run('os-user:9999999', approval.approvalId));
    assert.throws(() => store.beginRun(runRequest(task), contextAt(), directory));
    assert.equal(store.find(task.taskId)?.status, 'APPROVED');
    assert.deepEqual(store.listRuns(task.taskId), []);
    rewriteApproval(path, approval);
    assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, null);
  }
});

test('저장 task의 계획·revision·commit 변경도 snapshot과 대조하고 원자 소비하지 않는다', async (testContext) => {
  const { store, path, directory } = await openStore(testContext);
  for (const scenario of ['plan', 'revision', 'commit', 'status-column']) {
    const task = plannedTask();
    store.create(task);
    store.approve(approvalRequest(task), contextAt());
    const changed = store.find(task.taskId)!;
    if (scenario === 'plan') {
      changed.plan.policy.configHash = 'e'.repeat(64);
      changed.plan.planHash = hashExecutionPlan(changed.plan);
    }
    if (scenario === 'revision') changed.requestRevision = 'changed';
    if (scenario === 'commit') changed.baseCommit = 'e'.repeat(40);
    withDatabase(path, (database) => database.prepare('UPDATE execution_tasks SET status = ?, payload = ? WHERE task_id = ?')
      .run(scenario === 'status-column' ? 'RUNNING' : changed.status, JSON.stringify(changed), task.taskId));
    assert.throws(() => store.beginRun(runRequest(changed), contextAt(), directory));
    assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, null);
    assert.deepEqual(store.listRuns(task.taskId), []);
  }
});

test('승인 INSERT 이후 task 갱신 실패는 모두 rollback한다', async (testContext) => {
  const { store, path } = await openStore(testContext);
  const task = plannedTask();
  store.create(task);
  withDatabase(path, (database) => {
    database.exec(`CREATE TRIGGER reject_approval BEFORE UPDATE ON execution_tasks WHEN NEW.status = 'APPROVED'
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    assert.throws(() => store.approve(approvalRequest(task), contextAt()));
    assert.equal(store.find(task.taskId)?.status, 'AWAITING_APPROVAL');
    assert.deepEqual(store.listApprovals(task.taskId), []);
  });
});

test('Run INSERT와 RUNNING 갱신 오류는 승인 소비까지 rollback한다', async (testContext) => {
  const { store, path, directory } = await openStore(testContext);
  for (const trigger of [
    `CREATE TRIGGER reject_begin BEFORE INSERT ON execution_runs BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`,
    `CREATE TRIGGER reject_begin BEFORE UPDATE ON execution_tasks WHEN NEW.status = 'RUNNING' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`,
  ]) {
    const task = plannedTask();
    store.create(task);
    const approval = store.approve(approvalRequest(task), contextAt());
    withDatabase(path, (database) => {
      database.exec(trigger);
      assert.throws(() => store.beginRun(runRequest(task), contextAt(), directory));
      assert.deepEqual(store.listApprovals(task.taskId), [approval]);
      assert.equal(store.find(task.taskId)?.status, 'APPROVED');
      assert.deepEqual(store.listRuns(task.taskId), []);
      database.exec('DROP TRIGGER reject_begin');
    });
    assert.equal(store.beginRun(runRequest(task), contextAt(), directory).status, 'RUNNING');
  }
});

test('Run 종료는 원래 identity를 보존하고 task 갱신 실패 때 결과도 rollback한다', async (testContext) => {
  const { store, path, directory } = await openStore(testContext);
  const task = plannedTask();
  store.create(task);
  store.approve(approvalRequest(task), contextAt());
  const run = store.beginRun(runRequest(task), contextAt(), directory);
  for (const overrides of [{ taskId: 'other' }, { approvalId: 'other' }, { startedAt: '2026-11-09T00:00:00.000Z' }, { artifactDirectory: '/private/tmp/other' }]) {
    assert.throws(() => store.finishRun(finishedRun(run, overrides)), { code: 'EXECUTION_RUN_IDENTITY_MISMATCH' });
  }
  assert.throws(() => store.finishRun(run), { code: 'INVALID_EXECUTION_RUN_TRANSITION' });
  assert.throws(() => store.finishRun({ ...finishedRun(run), shell: 'untrusted' } as ExecutionRun), { code: 'INVALID_EXECUTION_RUN' });
  assert.throws(() => store.finishRun(finishedRun(run, { finishedAt: '2026-11-09T00:00:00.000Z' })), { code: 'INVALID_EXECUTION_RUN' });
  withDatabase(path, (database) => {
    database.exec(`CREATE TRIGGER reject_finish BEFORE UPDATE ON execution_tasks WHEN NEW.status = 'FAILED'
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    assert.throws(() => store.finishRun(finishedRun(run)));
    assert.deepEqual(store.findRun(run.runId), run);
    assert.equal(store.find(task.taskId)?.status, 'RUNNING');
    assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, now.toISOString());
    database.exec('DROP TRIGGER reject_finish');
  });
  store.finishRun(finishedRun(run));
  assert.equal(store.findRun(run.runId)?.status, 'FAILED');
  assert.equal(store.find(task.taskId)?.status, 'FAILED');
});

test('별도 두 store의 동시 beginRun 경합은 한 번만 승인 소비와 Run 생성을 허용한다', { timeout: 20_000 }, async (testContext) => {
  const { store, path, directory } = await openStore(testContext);
  const task = plannedTask();
  store.create(task);
  store.approve(approvalRequest(task), contextAt());
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const ready = new Int32Array(barrier);
  let readyWorkers = 0;
  const workers: Worker[] = [];
  testContext.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { SqliteExecutionStore } from ${JSON.stringify(new URL('../src/adapters/sqlite-execution-store.js', import.meta.url).href)};
    const store = new SqliteExecutionStore(workerData.path);
    parentPort.postMessage({ ready: true });
    Atomics.wait(new Int32Array(workerData.barrier), 0, 0, 10000);
    try {
      const run = store.beginRun(workerData.request, { ownerId: workerData.ownerId, now: new Date(workerData.now) }, workerData.directory);
      parentPort.postMessage({ status: 'started', runId: run.runId });
    } catch (error) { parentPort.postMessage({ status: 'rejected', code: error.code }); }
    finally { store.close(); }
  `;
  const outcomes = await Promise.all([0, 1].map(() => new Promise<{ status: string; code?: string }>((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
      workerData: { path, request: runRequest(task), ownerId, now: now.toISOString(), directory, barrier },
    });
    workers.push(worker);
    worker.on('error', reject);
    worker.on('message', (message: { ready?: boolean; status: string; code?: string }) => {
      if (message.ready) {
        readyWorkers += 1;
        if (readyWorkers === 2) { Atomics.store(ready, 0, 1); Atomics.notify(ready, 0, 2); }
      } else resolve(message);
    });
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
  })));
  assert.equal(outcomes.filter((result) => result.status === 'started').length, 1);
  assert.equal(outcomes.find((result) => result.status === 'rejected')?.code, 'APPROVAL_ALREADY_USED');
  assert.equal(store.listRuns(task.taskId).length, 1);
  assert.equal(store.find(task.taskId)?.status, 'RUNNING');
  assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, now.toISOString());
});

test('DB와 SQLite 부속 경로의 symlink·hardlink를 거부하고 기존 자료를 보존한다', async (testContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-execution-path-')));
  testContext.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const protectedPath = join(directory, 'protected.txt');
  await writeFile(protectedPath, 'synthetic protected data', { mode: 0o600 });
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const path = join(directory, `symlink${suffix || '-main'}.sqlite`);
    await symlink(protectedPath, `${path}${suffix}`);
    assert.throws(() => new SqliteExecutionStore(path), { code: 'UNSAFE_RUNTIME_FILE' });
  }
  const hardlinkPath = join(directory, 'hardlink.sqlite');
  await link(protectedPath, hardlinkPath);
  assert.throws(() => new SqliteExecutionStore(hardlinkPath), { code: 'UNSAFE_RUNTIME_FILE' });
  assert.equal(await readFile(protectedPath, 'utf8'), 'synthetic protected data');
});
