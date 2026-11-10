import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { SqliteExecutionStore } from '../src/adapters/sqlite-execution-store.js';
import {
  EXECUTION_LIMITS, EXECUTION_POLICY_VERSION, type ExecutionApprovalContext, type ExecutionContainerIntent,
  type ExecutionControlRequest, type ExecutionPlan, type ExecutionRun, type ExecutionTask,
} from '../src/domain/execution.js';
import { getExecutionCommand, hashExecutionPlan, sha256 } from '../src/policy/execution-policy.js';

const now = new Date('2026-11-10T00:00:00.000Z');
const context: ExecutionApprovalContext = { ownerId: `os-user:${process.getuid?.()}`, now };
const taskFixture = (): ExecutionTask => {
  const taskId = randomUUID();
  const content: Omit<ExecutionPlan, 'planHash'> = {
    planId: randomUUID(), version: 1, taskId, requestRevision: 'synthetic-1', repoId: 'synthetic-execution',
    baseCommit: 'a'.repeat(40), sourceHash: 'b'.repeat(64), allowedFiles: ['src/message.mjs'],
    patches: [{ operation: 'replace', path: 'src/message.mjs', beforeHash: sha256('old\n'), afterHash: sha256('new\n'), content: 'new\n' }],
    commands: [getExecutionCommand('synthetic-check-v1')], policy: {
      version: EXECUTION_POLICY_VERSION, backend: 'docker', serverVersion: '29.4.3', imageId: `sha256:${'c'.repeat(64)}`,
      nodeVersion: '24.22.2', configHash: 'd'.repeat(64), limits: EXECUTION_LIMITS, network: 'none',
    },
  };
  return {
    taskId, status: 'AWAITING_APPROVAL', requestRevision: content.requestRevision, baseCommit: content.baseCommit,
    sourceRoot: '/private/tmp/synthetic-execution-source', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    plan: { ...content, planHash: hashExecutionPlan(content) },
  };
};
const approvalRequest = (task: ExecutionTask) => ({ taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit, expiresInMinutes: 30 });
const runRequest = (task: ExecutionTask) => ({ taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit });
const cancelRequest = (task: ExecutionTask, overrides: Partial<ExecutionControlRequest> = {}): ExecutionControlRequest => ({
  taskId: task.taskId, eventId: randomUUID(), kind: 'cancel', revision: 1, ...overrides,
});
const terminal = (run: ExecutionRun, overrides: Partial<ExecutionRun> = {}): ExecutionRun => ({
  ...run, status: 'SUCCEEDED', finishedAt: new Date(now.getTime() + 1_000).toISOString(), ...overrides,
});
const sql = <T>(path: string, operation: (database: DatabaseSync) => T): T => {
  const database = new DatabaseSync(path);
  try { return operation(database); } finally { database.close(); }
};
const openStore = async (testContext: TestContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-lifecycle-store-')));
  await chmod(directory, 0o700);
  const path = join(directory, 'execution.sqlite');
  let store = new SqliteExecutionStore(path);
  testContext.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const task = taskFixture();
  store.create(task);
  return {
    directory, path, task, get store() { return store; },
    reopen: () => { store.close(); store = new SqliteExecutionStore(path); return store; },
    begin: () => { store.approve(approvalRequest(task), context); return store.beginRun(runRequest(task), context, directory); },
  };
};
const intentFor = (run: ExecutionRun): ExecutionContainerIntent => {
  const token = randomUUID();
  return { runId: run.runId, name: `harness-execution-${token}`, token, id: null, commandId: 'synthetic-check-v1' };
};

test('실행 요청과 승인 소비 원장 및 claimed lifecycle을 한 번에 보존한다', async (testContext) => {
  const harness = await openStore(testContext);
  assert.deepEqual(harness.store.requestState(harness.task.taskId), {
    taskId: harness.task.taskId, requestId: `synthetic:${harness.task.taskId}`, ownerId: context.ownerId,
    revision: 1, generation: 0, invalidatedAt: null, reason: null,
  });
  const run = harness.begin();
  const lifecycle = harness.store.lifecycle(run.runId);
  assert.deepEqual(lifecycle, {
    runId: run.runId, taskId: run.taskId, generation: 0, sequence: 0, phase: 'claimed', updatedAt: now.toISOString(),
    workspace: null, container: null, cleanup: null, observation: null, legacy: false,
  });
  assert.deepEqual(harness.reopen().lifecycle(run.runId), lifecycle);
  assert.equal(harness.store.listApprovals(run.taskId)[0]?.usedAt, now.toISOString());
});

test('소유자 취소는 미소비 승인을 revoke하고 이후 승인·소비와 파일 동작을 막는다', async (testContext) => {
  const { store, task, directory } = await openStore(testContext);
  store.approve(approvalRequest(task), context);
  const request = cancelRequest(task);
  const cancelled = store.control(request, context);
  assert.equal(cancelled.generation, 1);
  assert.equal(cancelled.reason, 'OWNER_CANCELLED');
  assert.equal(store.find(task.taskId)?.status, 'CANCELLED');
  assert.equal(store.listApprovals(task.taskId)[0]?.revokedAt, now.toISOString());
  assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, null);
  assert.deepEqual(store.control(request, context), cancelled);
  assert.throws(() => store.approve(approvalRequest(task), context), { code: 'EXECUTION_CANCELLED' });
  assert.throws(() => store.beginRun(runRequest(task), context, directory), { code: 'EXECUTION_CANCELLED' });
  assert.deepEqual(store.listRuns(task.taskId), []);
});

test('제어 이벤트 중복·역순·다른 payload와 다른 소유자를 구분한다', async (testContext) => {
  const { store, task, path } = await openStore(testContext);
  const edited = cancelRequest(task, { kind: 'edited', revision: 3 });
  assert.equal(store.control(edited, context).revision, 3);
  assert.equal(store.control(cancelRequest(task, { kind: 'deleted', revision: 2 }), context).generation, 1);
  assert.equal(store.control(cancelRequest(task, { revision: 1 }), context).generation, 1);
  assert.equal(store.control(edited, context).generation, 1);
  assert.throws(() => store.control({ ...edited, kind: 'deleted' }, context), { code: 'EXECUTION_CONTROL_EVENT_MISMATCH' });
  assert.throws(() => store.control(cancelRequest(task, { revision: 4 }), context), { code: 'EXECUTION_REQUEST_REVISION_MISMATCH' });
  assert.throws(() => store.control(cancelRequest(task), { ...context, ownerId: 'os-user:999999999' }), { code: 'APPROVAL_OWNER_MISMATCH' });
  assert.equal(store.control(cancelRequest(task, { kind: 'deleted', revision: 4 }), context).generation, 2);
  assert.equal(store.requestState(task.taskId).reason, 'REQUEST_DELETED');
  sql(path, (database) => {
    assert.equal(Number(database.prepare('SELECT count(*) AS total FROM execution_control_events').get()?.total), 4);
    assert.throws(() => database.exec('DELETE FROM execution_control_events'));
    assert.throws(() => database.exec("UPDATE execution_control_events SET result = '{}'"));
  });
});

test('실행 중 취소는 RUNNING을 유지한 채 새 동작을 막고 성공 종료 경합은 CANCELLED로 저장한다', async (testContext) => {
  const harness = await openStore(testContext);
  const run = harness.begin();
  harness.store.control(cancelRequest(harness.task), context);
  assert.equal(harness.store.findRun(run.runId)?.status, 'RUNNING');
  assert.throws(() => harness.store.assertRunnable(run.runId), { code: 'EXECUTION_CANCELLED' });
  assert.throws(() => harness.store.checkpoint(run.runId, 'patch_applying'), { code: 'EXECUTION_CANCELLED' });
  let called = false;
  await assert.rejects(harness.store.guard(run.runId, 'workspace_preparing', async () => { called = true; }), { code: 'EXECUTION_CANCELLED' });
  assert.equal(called, false);
  harness.store.finishRun(terminal(run));
  assert.equal(harness.store.findRun(run.runId)?.status, 'CANCELLED');
  assert.equal(harness.store.listApprovals(run.taskId)[0]?.usedAt, now.toISOString());
  assert.throws(() => harness.store.beginRun(runRequest(harness.task), context, harness.directory), { code: 'EXECUTION_CANCELLED' });
});

test('terminal 성공과 뒤늦은 취소의 경합은 완료 결과를 다시 열지 않는다', async (testContext) => {
  const harness = await openStore(testContext);
  const run = harness.begin();
  harness.store.finishRun(terminal(run));
  harness.store.control(cancelRequest(harness.task), context);
  assert.equal(harness.store.findRun(run.runId)?.status, 'SUCCEEDED');
  assert.equal(harness.store.find(run.taskId)?.status, 'SUCCEEDED');
  assert.throws(() => harness.store.finishRun(terminal(run)), { code: 'EXECUTION_RUN_ALREADY_FINISHED' });
});

test('container 생성 의도와 전체 ID는 취소 뒤에도 기록되며 identity 변경은 rollback한다', async (testContext) => {
  const harness = await openStore(testContext);
  const run = harness.begin();
  const intent = intentFor(run);
  const created = { ...intent, id: 'e'.repeat(64) };
  harness.store.checkpoint(run.runId, 'container_creating', { container: intent });
  harness.store.control(cancelRequest(harness.task), context);
  harness.store.checkpoint(run.runId, 'container_created', { container: created });
  const current = harness.store.lifecycle(run.runId);
  assert.equal(current.container?.id, created.id);
  assert.throws(() => harness.store.checkpoint(run.runId, 'container_created', { container: { ...created, id: 'f'.repeat(64) } }),
    { code: 'EXECUTION_CONTAINER_IDENTITY_MISMATCH' });
  assert.throws(() => harness.store.checkpoint(run.runId, 'container_created', { container: intent }), { code: 'EXECUTION_CONTAINER_IDENTITY_MISMATCH' });
  assert.deepEqual(harness.store.lifecycle(run.runId), current);
  harness.store.finishRun(terminal(run));
  assert.equal(harness.store.findRun(run.runId)?.status, 'BLOCKED');
  assert.equal(harness.store.findRun(run.runId)?.failureCode, 'EXECUTION_CLEANUP_UNCONFIRMED');
  const original = harness.store.findRun(run.runId);
  harness.store.checkpoint(run.runId, 'recovering');
  harness.store.checkpoint(run.runId, 'finished', {
    cleanup: { found: true, stopped: true, removed: true, exitCode: 137, oomKilled: false, failureCode: null },
    observation: { status: 'not_run', reason: '합성 보존 작업물 재조사', changes: [], gitUnchanged: null, viewUnchanged: null, workspaceExists: false },
  });
  assert.deepEqual(harness.store.findRun(run.runId), original);
  assert.equal(harness.store.lifecycle(run.runId).cleanup?.removed, true);
  assert.equal(harness.store.lifecycle(run.runId).observation?.status, 'not_run');
});

test('workspace evidence와 중간 diff·검사·명령 결과를 영속 저장하고 수정 불변성을 검증한다', async (testContext) => {
  const harness = await openStore(testContext);
  const run = harness.begin();
  const workspace = {
    worktreeRoot: join(harness.directory, 'worktree'), containerRoot: join(harness.directory, 'container-view'),
    planHash: harness.task.plan.planHash, gitHash: '1'.repeat(64), viewHash: null,
  };
  harness.store.checkpoint(run.runId, 'workspace_ready', { workspace, sourceBeforeHash: '2'.repeat(64) });
  harness.store.checkpoint(run.runId, 'view_ready', { workspace: { ...workspace, viewHash: '3'.repeat(64) } });
  assert.throws(() => harness.store.checkpoint(run.runId, 'view_ready', { workspace: { ...workspace, gitHash: '4'.repeat(64) } }),
    { code: 'EXECUTION_WORKSPACE_IDENTITY_MISMATCH' });
  const command = {
    commandId: 'synthetic-check-v1' as const, containerName: null, termination: 'completed' as const, exitCode: 0,
    stopped: true, removed: true, oomKilled: false, outputBytes: 0, outputHash: sha256(''), failureCode: null,
  };
  const diff = [{ path: 'src/message.mjs', beforeHash: sha256('old\n'), afterHash: sha256('new\n'), before: 'old\n', after: 'new\n' }];
  const checks = [{ name: 'registered_command', status: 'passed' as const, reason: '합성 검사 성공' }];
  harness.store.checkpoint(run.runId, 'command_finished', { command, diff, checks });
  harness.store.checkpoint(run.runId, 'command_finished', { command });
  const persisted = harness.reopen().findRun(run.runId)!;
  assert.equal(persisted.commands.length, 1);
  assert.equal(persisted.worktreeRoot, workspace.worktreeRoot);
  assert.equal(persisted.sourceBeforeHash, '2'.repeat(64));
  assert.deepEqual(persisted.diff, diff);
  assert.deepEqual(persisted.checks, checks);
  assert.throws(() => harness.store.checkpoint(run.runId, 'command_finished', { command: { ...command, exitCode: 1 } }), { code: 'EXECUTION_COMMAND_RESULT_MISMATCH' });
});

test('과거 3-C RUNNING은 legacy_untracked로만 복구하고 소비 승인을 되살리지 않는다', async (testContext) => {
  const harness = await openStore(testContext);
  const run = harness.begin();
  sql(harness.path, (database) => {
    database.exec('DROP TRIGGER execution_lifecycle_history_immutable_delete');
    database.prepare('DELETE FROM execution_lifecycle_history WHERE run_id = ?').run(run.runId);
    database.prepare('DELETE FROM execution_lifecycles WHERE run_id = ?').run(run.runId);
    database.prepare('DELETE FROM execution_requests WHERE task_id = ?').run(run.taskId);
  });
  const reopened = harness.reopen();
  const snapshot = reopened.inspect(run.taskId, 0);
  assert.equal(snapshot.lifecycles[0]?.legacy, true);
  assert.equal(snapshot.requestState.ownerId, context.ownerId);
  assert.equal(reopened.requestState(run.taskId).ownerId, context.ownerId);
  assert.equal(reopened.lifecycle(run.runId).phase, 'legacy_untracked');
  assert.equal(reopened.lifecycle(run.runId).legacy, true);
  assert.equal(reopened.lifecycle(run.runId).container, null);
  assert.throws(() => reopened.assertRunnable(run.runId), { code: 'EXECUTION_CANCELLED' });
  assert.equal(reopened.listApprovals(run.taskId)[0]?.usedAt, now.toISOString());
  assert.throws(() => reopened.beginRun(runRequest(harness.task), context, harness.directory), { code: 'APPROVAL_ALREADY_USED' });
});

test('control·claimed·checkpoint 저장 오류는 관련 상태 전체를 rollback한다', async (testContext) => {
  const harness = await openStore(testContext);
  harness.store.approve(approvalRequest(harness.task), context);
  sql(harness.path, (database) => {
    database.exec(`CREATE TRIGGER reject_control BEFORE INSERT ON execution_control_events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    assert.throws(() => harness.store.control(cancelRequest(harness.task), context));
    assert.equal(harness.store.requestState(harness.task.taskId).generation, 0);
    assert.equal(harness.store.find(harness.task.taskId)?.status, 'APPROVED');
    assert.equal(harness.store.listApprovals(harness.task.taskId)[0]?.revokedAt, null);
    database.exec('DROP TRIGGER reject_control');
    database.exec(`CREATE TRIGGER reject_claim BEFORE INSERT ON execution_lifecycle_history BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    assert.throws(() => harness.store.beginRun(runRequest(harness.task), context, harness.directory));
    assert.equal(harness.store.listApprovals(harness.task.taskId)[0]?.usedAt, null);
    assert.deepEqual(harness.store.listRuns(harness.task.taskId), []);
    database.exec('DROP TRIGGER reject_claim');
  });
  const run = harness.store.beginRun(runRequest(harness.task), context, harness.directory);
  const original = harness.store.lifecycle(run.runId);
  sql(harness.path, (database) => {
    database.exec(`CREATE TRIGGER reject_progress BEFORE INSERT ON execution_lifecycle_history BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    assert.throws(() => harness.store.checkpoint(run.runId, 'workspace_ready', { worktreeRoot: join(harness.directory, 'worktree') }));
    assert.equal(harness.store.findRun(run.runId)?.worktreeRoot, null);
    assert.deepEqual(harness.store.lifecycle(run.runId), original);
  });
});

test('guard 파일 작업 실패는 checkpoint를 rollback하고 파일 보존 후 새 실행을 열지 않는다', async (testContext) => {
  const harness = await openStore(testContext);
  const run = harness.begin();
  const marker = join(harness.directory, 'partial.txt');
  await assert.rejects(harness.store.guard(run.runId, 'patch_applying', async () => {
    await writeFile(marker, 'synthetic partial patch');
    throw new Error('synthetic interrupted file operation');
  }));
  assert.equal(await readFile(marker, 'utf8'), 'synthetic partial patch');
  assert.equal(harness.store.lifecycle(run.runId).phase, 'claimed');
  harness.store.finishRun(terminal(run, { status: 'INTERRUPTED', failureCode: 'EXECUTION_INTERRUPTED' }));
  assert.equal(harness.store.findRun(run.runId)?.status, 'INTERRUPTED');
  assert.equal(harness.store.listApprovals(run.taskId)[0]?.usedAt, now.toISOString());
});

test('별도 controller의 취소는 짧은 guard commit 뒤 확정되고 이후 파일 작업을 차단한다', { timeout: 20_000 }, async (testContext) => {
  const harness = await openStore(testContext);
  const run = harness.begin();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const guarded = harness.store.guard(run.runId, 'patch_applying', async () => {
    await waiting;
    await writeFile(join(harness.directory, 'completed-before-cancel.txt'), 'synthetic patch');
  });
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { SqliteExecutionStore } from ${JSON.stringify(new URL('../src/adapters/sqlite-execution-store.js', import.meta.url).href)};
    parentPort.postMessage('started');
    const store = new SqliteExecutionStore(workerData.path);
    try { parentPort.postMessage(store.control(workerData.request, { ownerId: workerData.ownerId, now: new Date(workerData.now) })); }
    finally { store.close(); }
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    workerData: { path: harness.path, request: cancelRequest(harness.task), ownerId: context.ownerId, now: now.toISOString() },
  });
  testContext.after(async () => { await worker.terminate(); });
  const cancelled = new Promise<unknown>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (message: unknown) => {
      if (message === 'started') setTimeout(release, 50);
      else resolve(message);
    });
  });
  await guarded;
  await cancelled;
  assert.equal(await readFile(join(harness.directory, 'completed-before-cancel.txt'), 'utf8'), 'synthetic patch');
  assert.equal(harness.store.requestState(run.taskId).invalidatedAt, now.toISOString());
  await assert.rejects(harness.store.guard(run.runId, 'view_preparing', async () => {
    throw new Error('must not execute after durable cancel');
  }), { code: 'EXECUTION_CANCELLED' });
});

test('취소와 승인 소비의 동시 트랜잭션은 승인 revoke 또는 단일 소비만 남긴다', { timeout: 20_000 }, async (testContext) => {
  const harness = await openStore(testContext);
  harness.store.approve(approvalRequest(harness.task), context);
  const barrier = new SharedArrayBuffer(4);
  let readyCount = 0;
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { SqliteExecutionStore } from ${JSON.stringify(new URL('../src/adapters/sqlite-execution-store.js', import.meta.url).href)};
    const store = new SqliteExecutionStore(workerData.path);
    parentPort.postMessage({ ready: true });
    Atomics.wait(new Int32Array(workerData.barrier), 0, 0, 10000);
    try {
      const context = { ownerId: workerData.ownerId, now: new Date(workerData.now) };
      const result = workerData.action === 'cancel' ? store.control(workerData.cancel, context)
        : store.beginRun(workerData.request, context, workerData.directory);
      parentPort.postMessage({ status: 'committed', result });
    } catch (error) { parentPort.postMessage({ status: 'rejected', code: error.code }); }
    finally { store.close(); }
  `;
  const workers: Worker[] = [];
  testContext.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  const outcomes = await Promise.all(['cancel', 'begin'].map((action) => new Promise<{ status: string; code?: string }>((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { workerData: {
      path: harness.path, action, ownerId: context.ownerId, now: now.toISOString(), directory: harness.directory,
      request: runRequest(harness.task), cancel: cancelRequest(harness.task), barrier,
    } });
    workers.push(worker);
    worker.on('error', reject);
    worker.on('message', (message: { ready?: boolean; status: string; code?: string }) => {
      if (message.ready) {
        readyCount += 1;
        if (readyCount === 2) { Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, 2); }
      } else resolve(message);
    });
  })));
  assert.equal(outcomes[0]?.status, 'committed');
  assert.equal(harness.store.requestState(harness.task.taskId).generation, 1);
  const approval = harness.store.listApprovals(harness.task.taskId)[0]!;
  const runs = harness.store.listRuns(harness.task.taskId);
  if (runs.length === 0) {
    assert.equal(outcomes[1]?.code, 'EXECUTION_CANCELLED');
    assert.equal(approval.usedAt, null);
    assert.equal(approval.revokedAt, now.toISOString());
    assert.equal(harness.store.find(harness.task.taskId)?.status, 'CANCELLED');
  } else {
    assert.equal(runs.length, 1);
    assert.equal(approval.usedAt, now.toISOString());
    assert.equal(approval.revokedAt, null);
    assert.equal(harness.store.lifecycle(runs[0]!.runId).phase, 'claimed');
    harness.store.finishRun(terminal(runs[0]!));
    assert.equal(harness.store.findRun(runs[0]!.runId)?.status, 'CANCELLED');
  }
});

test('불완전하거나 변조한 관찰·lifecycle payload는 영속 저장이나 실행으로 이어지지 않는다', async (testContext) => {
  const harness = await openStore(testContext);
  const run = harness.begin();
  assert.throws(() => harness.store.checkpoint(run.runId, 'command_finished', {
    observation: { status: 'passed', reason: 'invalid changes', changes: [{ path: 'x' }], gitUnchanged: true, viewUnchanged: true, workspaceExists: true } as never,
  }), { code: 'INVALID_EXECUTION_OBSERVATION' });
  const current = harness.store.lifecycle(run.runId);
  sql(harness.path, (database) => {
    assert.throws(() => database.exec('DELETE FROM execution_lifecycle_history'));
    assert.throws(() => database.exec("UPDATE execution_lifecycle_history SET payload = '{}'"));
    database.prepare('UPDATE execution_lifecycles SET payload = ? WHERE run_id = ?')
      .run(JSON.stringify({ ...current, phase: 'container_starting' }), run.runId);
  });
  assert.throws(() => harness.store.lifecycle(run.runId), { code: 'INVALID_STORED_EXECUTION_LIFECYCLE' });
  assert.throws(() => harness.store.assertRunnable(run.runId), { code: 'INVALID_STORED_EXECUTION_LIFECYCLE' });
  assert.equal(harness.store.listApprovals(run.taskId)[0]?.usedAt, now.toISOString());
});

test('물리 dispatch는 취소 fence와 직렬화하고 RPC 완료까지 SQLite 잠금을 유지하지 않는다', async (testContext) => {
  const harness = await openStore(testContext);
  const run = harness.begin();
  const order: string[] = [];
  let complete!: (value: string) => void;
  const response = new Promise<string>((resolve) => { complete = resolve; });
  const pending = harness.store.dispatch(run.runId, () => { order.push('spawn'); return response; });
  assert.equal(pending, response);
  harness.store.control(cancelRequest(harness.task), context);
  order.push('cancel_committed');
  complete('synthetic RPC response');
  assert.equal(await pending, 'synthetic RPC response');
  assert.deepEqual(order, ['spawn', 'cancel_committed']);
  let called = false;
  assert.throws(() => harness.store.dispatch(run.runId, () => { called = true; return response; }), { code: 'EXECUTION_CANCELLED' });
  assert.equal(called, false);
  assert.equal(harness.store.listApprovals(run.taskId)[0]?.usedAt, now.toISOString());
});

test('inspect는 Task·제어·승인 페이지·Run·lifecycle을 한 TX의 분리된 snapshot으로 읽는다', async (testContext) => {
  const harness = await openStore(testContext);
  const awaiting = harness.store.inspect(harness.task.taskId, 0);
  assert.equal(awaiting.task.status, 'AWAITING_APPROVAL');
  assert.deepEqual(awaiting.runs, []);
  assert.deepEqual(awaiting.lifecycles, []);
  assert.deepEqual(awaiting.approvalPage, { offset: 0, total: 0, nextOffset: null });
  const run = harness.begin();
  const running = harness.store.inspect(run.taskId, 0);
  assert.equal(running.task.status, running.runs[0]?.status);
  assert.equal(running.runs[0]?.runId, running.lifecycles[0]?.runId);
  assert.equal(running.lifecycles[0]?.phase, 'claimed');
  assert.equal(running.approvals[0]?.usedAt, run.startedAt);
  harness.store.control(cancelRequest(harness.task), context);
  harness.store.finishRun(terminal(run));
  assert.equal(running.requestState.invalidatedAt, null);
  assert.equal(running.task.status, 'RUNNING');
  const completed = harness.store.inspect(run.taskId, 1);
  assert.equal(completed.task.status, 'CANCELLED');
  assert.equal(completed.runs[0]?.status, 'CANCELLED');
  assert.equal(completed.lifecycles[0]?.phase, 'finished');
  assert.equal(completed.requestState.generation, 1);
  assert.deepEqual(completed.approvalPage, { offset: 1, total: 1, nextOffset: null });
  completed.requestState.generation = 999;
  assert.equal(harness.store.inspect(run.taskId, 0).requestState.generation, 1);
  assert.throws(() => harness.store.inspect(run.taskId, -1), { code: 'INVALID_APPROVAL_OFFSET' });
});
