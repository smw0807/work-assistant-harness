import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { hashRepository } from '../src/adapters/demo-repository.js';
import { SyntheticExecutionWorkspace } from '../src/adapters/execution-workspace.js';
import { SqliteExecutionStore } from '../src/adapters/sqlite-execution-store.js';
import { SyntheticExecutionService, type ExecutionServiceObserver } from '../src/application/execute-synthetic.js';
import type {
  ExecutionCleanupResult, ExecutionCommandResult, ExecutionContainerIntent, ExecutionControlKind,
  ExecutionPhase, ExecutionRun, IsolatedExecutionPort,
} from '../src/domain/execution.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import { sha256 } from '../src/policy/execution-policy.js';

const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-cancellation.sock', serverVersion: '29.4.3',
  imageId: `sha256:${'a'.repeat(64)}`, nodeVersion: '24.22.2',
};
const context = () => ({ ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
const cleanupResult = (clean = true): ExecutionCleanupResult => ({
  found: true, stopped: clean, removed: clean, exitCode: 137, oomKilled: false,
  failureCode: clean ? null : 'EXECUTION_CLEANUP_UNCONFIRMED',
});
const makeWritable = async (path: string): Promise<void> => {
  const metadata = await fileSystem.lstat(path);
  if (metadata.isSymbolicLink()) return;
  await fileSystem.chmod(path, metadata.isDirectory() ? 0o700 : 0o600);
  if (metadata.isDirectory()) for (const name of await fileSystem.readdir(path)) await makeWritable(join(path, name));
};

const setup = async (testContext: TestContext) => {
  const directory = await fileSystem.realpath(await fileSystem.mkdtemp(join(tmpdir(), 'execution-cancellation-')));
  await fileSystem.chmod(directory, 0o700);
  const storePath = join(directory, 'execution.sqlite');
  let store = new SqliteExecutionStore(storePath);
  const workspace = new SyntheticExecutionWorkspace();
  const calls = { preflight: 0, execute: 0, created: 0, started: 0, cleaned: 0, recovered: 0, aborted: false };
  const behavior = {
    clean: true, preflightFailure: false, awaitAbort: false,
    onStarted: async (): Promise<void> => {},
  };
  const backend: IsolatedExecutionPort = {
    preflight: async () => {
      calls.preflight += 1;
      if (behavior.preflightFailure) throw new Error('synthetic unavailable backend');
    },
    execute: async (command, _root, signal, hooks) => {
      calls.execute += 1;
      assert.ok(hooks, 'service must supply lifecycle hooks');
      const token = randomUUID();
      const intent: ExecutionContainerIntent = { runId: hooks.runId, name: `harness-execution-${token}`, token, id: null, commandId: command.commandId };
      let aborted = false;
      try {
        await hooks.beforeCreate(intent);
        calls.created += 1;
        await hooks.created({ ...intent, id: 'e'.repeat(64) });
        await hooks.beforeStart();
        calls.started += 1;
        await behavior.onStarted();
        if (behavior.awaitAbort) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('poll did not abort running command')), 2_000);
            const stop = () => { clearTimeout(timeout); calls.aborted = true; resolve(); };
            if (signal?.aborted) stop();
            else signal?.addEventListener('abort', stop, { once: true });
          });
          aborted = true;
        }
      } catch (error) {
        aborted = true;
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EXECUTION_CANCELLED') throw error;
      }
      calls.cleaned += 1;
      const result: ExecutionCommandResult = {
        commandId: command.commandId, containerName: intent.name, termination: aborted ? 'aborted' : 'completed',
        exitCode: aborted ? 137 : 0, stopped: behavior.clean, removed: behavior.clean, oomKilled: false,
        outputBytes: 0, outputHash: sha256(''), failureCode: behavior.clean ? null : 'EXECUTION_CLEANUP_UNCONFIRMED',
      };
      await hooks.finished(result);
      return result;
    },
    recover: async () => { calls.recovered += 1; return cleanupResult(behavior.clean); },
  };
  const newService = (observer: ExecutionServiceObserver = {}, freshWorkspace = workspace) =>
    new SyntheticExecutionService(store, freshWorkspace, backend, config, { platform: 'darwin', architecture: 'arm64' }, observer);
  const sourceDirectory = join(directory, 'task');
  await fileSystem.mkdir(sourceDirectory, { mode: 0o700 });
  const task = await newService().plan(randomUUID(), sourceDirectory, 'success');
  const request = { taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit };
  await newService().approve({ ...request, expiresInMinutes: 30 }, context());
  const artifactDirectory = join(directory, 'run');
  await fileSystem.mkdir(artifactDirectory, { mode: 0o700 });
  const control = (kind: ExecutionControlKind = 'cancel', separateStore = store) => separateStore.control({
    taskId: task.taskId, eventId: randomUUID(), kind, revision: kind === 'cancel' ? 1 : 2,
  }, context());
  const reopen = () => { store.close(); store = new SqliteExecutionStore(storePath); return store; };
  testContext.after(async () => {
    store.close();
    await makeWritable(directory);
    await fileSystem.rm(directory, { recursive: true, force: true });
  });
  return { directory, storePath, get store() { return store; }, workspace, task, request, artifactDirectory, calls, behavior, newService, control, reopen };
};

const assertPreserved = async (harness: Awaited<ReturnType<typeof setup>>, run: ExecutionRun): Promise<void> => {
  assert.ok(harness.store.listApprovals(harness.task.taskId)[0]!.usedAt);
  assert.equal(harness.store.listApprovals(harness.task.taskId)[0]!.revokedAt, null);
  assert.equal(await hashRepository(harness.task.sourceRoot), harness.task.plan.sourceHash);
  assert.equal(run.sourceBeforeHash, harness.task.plan.sourceHash);
  assert.equal(run.sourceAfterHash, harness.task.plan.sourceHash);
  assert.equal(harness.store.findRun(run.runId)!.status, run.status);
  assert.equal(harness.store.find(harness.task.taskId)!.status, run.status);
  assert.deepEqual(harness.store.listApprovals(harness.task.taskId)[0]!.planSnapshot, harness.task.plan);
  await assert.rejects(harness.newService().run(harness.request, context(), harness.artifactDirectory));
};

for (const phase of ['claimed', 'workspace_ready', 'patch_applied', 'view_ready', 'container_creating', 'container_created', 'container_starting'] as const) {
  test(`취소·편집·삭제가 ${phase} 뒤의 patch·생성·시작을 차단하고 결과를 보존한다`, async (testContext) => {
    for (const kind of ['cancel', 'edited', 'deleted'] as const) {
      const harness = await setup(testContext);
      let controlled = false;
      const run = await harness.newService({ checkpoint: async (current) => {
        if (current === phase) { harness.control(kind); controlled = true; }
      } }).run(harness.request, context(), harness.artifactDirectory);
      assert.equal(controlled, true);
      assert.equal(run.status, 'CANCELLED', `${phase}/${kind}`);
      assert.equal(harness.store.requestState(run.taskId).reason, kind === 'cancel' ? 'OWNER_CANCELLED' : kind === 'edited' ? 'REQUEST_EDITED' : 'REQUEST_DELETED');
      assert.equal(harness.calls.started, 0);
      assert.equal(harness.calls.created, ['container_created', 'container_starting'].includes(phase) ? 1 : 0);
      const patched = !['claimed', 'workspace_ready'].includes(phase);
      assert.equal(run.diff.length, patched ? 1 : 0);
      if (phase === 'claimed') {
        assert.equal(run.observation!.status, 'not_run');
        await assert.rejects(fileSystem.lstat(join(harness.artifactDirectory, 'worktree')), { code: 'ENOENT' });
      } else {
        assert.equal(run.observation!.status, 'passed');
        assert.equal(await fileSystem.readFile(join(harness.artifactDirectory, 'worktree/src/message.mjs'), 'utf8'), patched
          ? harness.task.plan.patches[0]!.content : "export const message = 'before';\n");
        assert.equal(run.observation!.changes.length, patched ? 1 : 0);
      }
      if (!phase.startsWith('container_')) {
        assert.equal(harness.calls.execute, 0);
        assert.equal(run.checks.find((check) => check.name === 'synthetic-check-v1')!.status, 'not_run');
      } else {
        assert.equal(harness.calls.execute, 1);
        assert.equal(harness.calls.cleaned, 1);
      }
      await assertPreserved(harness, run);
    }
  });
}

test('별도 store의 실행 중 취소를 polling으로 감지하고 fake 프로세스 트리를 정리한다', async (testContext) => {
  for (const clean of [true, false]) {
    const harness = await setup(testContext);
    const controller = new SqliteExecutionStore(harness.storePath);
    let cancelledAt = 0;
    try {
      harness.behavior.awaitAbort = true;
      harness.behavior.clean = clean;
      harness.behavior.onStarted = async () => { cancelledAt = Date.now(); harness.control('cancel', controller); };
      const run = await harness.newService().run(harness.request, context(), harness.artifactDirectory);
      assert.equal(harness.calls.aborted, true);
      assert.ok(Date.now() - cancelledAt < 1_500, '50ms poll should abort without waiting for command timeout');
      assert.equal(harness.calls.started, 1);
      assert.equal(harness.calls.cleaned, 1);
      assert.equal(run.status, clean ? 'CANCELLED' : 'BLOCKED');
      assert.equal(run.commands[0]!.termination, 'aborted');
      assert.equal(run.commands[0]!.stopped, clean);
      assert.equal(run.commands[0]!.removed, clean);
      assert.equal(run.diff.length, 1);
      assert.equal(run.observation!.status, 'passed');
      if (!clean) assert.equal(run.failureCode, 'EXECUTION_CLEANUP_UNCONFIRMED');
      await assertPreserved(harness, run);
    } finally { controller.close(); }
  }
});

const stageCrash = async (harness: Awaited<ReturnType<typeof setup>>, phase: ExecutionPhase, partial = false) => {
  const run = harness.store.beginRun(harness.request, context(), harness.artifactDirectory);
  harness.store.checkpoint(run.runId, 'claimed', { sourceBeforeHash: harness.task.plan.sourceHash });
  if (phase === 'claimed') return run;
  const workspace = await harness.workspace.materialize(harness.task, harness.artifactDirectory);
  harness.store.checkpoint(run.runId, 'workspace_ready', {
    worktreeRoot: workspace.worktreeRoot, workspace: await harness.workspace.evidence(harness.task.plan, workspace),
  });
  if (phase === 'workspace_ready') return run;
  if (partial) {
    harness.store.checkpoint(run.runId, 'patch_applying');
    await fileSystem.writeFile(join(workspace.worktreeRoot, 'src/message.mjs'), "export const message = '");
    return run;
  }
  await harness.workspace.apply(harness.task.plan, workspace);
  const diff = await harness.workspace.inspectDiff(harness.task.plan, workspace);
  harness.store.checkpoint(run.runId, 'patch_applied', { diff });
  if (phase === 'patch_applied') return run;
  await harness.workspace.createContainerView(harness.task.plan, workspace);
  harness.store.checkpoint(run.runId, 'view_ready', { workspace: await harness.workspace.evidence(harness.task.plan, workspace) });
  if (phase === 'view_ready') return run;
  const token = randomUUID();
  const intent: ExecutionContainerIntent = {
    runId: run.runId, name: `harness-execution-${token}`, token, id: phase === 'container_creating' ? null : 'e'.repeat(64), commandId: 'synthetic-check-v1',
  };
  harness.store.checkpoint(run.runId, phase, { container: intent });
  return run;
};

test('새 store·서비스·workspace는 crash 위치별 diff와 소비 승인을 보존하고 자동 재실행하지 않는다', async (testContext) => {
  for (const phase of ['claimed', 'workspace_ready', 'patch_applied', 'view_ready', 'container_creating', 'container_created', 'container_starting'] as const) {
    const harness = await setup(testContext);
    const pending = await stageCrash(harness, phase);
    const originalDiff = harness.store.findRun(pending.runId)!.diff;
    harness.reopen();
    const run = await harness.newService({}, new SyntheticExecutionWorkspace()).recover(harness.task.taskId, context());
    assert.ok(run);
    assert.equal(run.status, 'INTERRUPTED', phase);
    assert.deepEqual(run.diff, originalDiff);
    assert.equal(harness.calls.execute, 0);
    assert.equal(harness.calls.started, 0);
    const hasContainer = phase.startsWith('container_');
    assert.equal(harness.calls.recovered, hasContainer ? 1 : 0);
    assert.equal(harness.calls.preflight, hasContainer ? 1 : 0);
    assert.equal(run.observation!.status, phase === 'claimed' ? 'not_run' : 'passed');
    assert.equal(run.observation!.changes.length, ['claimed', 'workspace_ready'].includes(phase) ? 0 : 1);
    assert.equal(run.checks.find((check) => check.name === 'synthetic-check-v1')!.status, phase === 'container_starting' ? 'failed' : 'not_run');
    await assertPreserved(harness, run);
    assert.deepEqual(await harness.newService({}, new SyntheticExecutionWorkspace()).recover(harness.task.taskId, context()), run);
    assert.equal(harness.calls.execute, 0);
  }
});

test('부분 patch와 journal 없는 부분 workspace는 복구 성공으로 추정하지 않는다', async (testContext) => {
  for (const partial of [true, false]) {
    const harness = await setup(testContext);
    let pending: ExecutionRun;
    if (partial) pending = await stageCrash(harness, 'patch_applying', true);
    else {
      pending = await stageCrash(harness, 'claimed');
      await fileSystem.mkdir(join(harness.artifactDirectory, 'worktree'), { mode: 0o700 });
    }
    harness.reopen();
    const run = await harness.newService({}, new SyntheticExecutionWorkspace()).recover(harness.task.taskId, context());
    assert.ok(run);
    assert.equal(run.runId, pending.runId);
    assert.equal(run.status, 'BLOCKED');
    assert.equal(run.observation!.status, 'failed');
    if (partial) assert.equal(run.observation!.changes.find((change) => change.path === 'src/message.mjs')!.afterHash, sha256("export const message = '"));
    else assert.equal(run.observation!.reason, 'EXECUTION_WORKSPACE_EVIDENCE_MISSING');
    assert.equal(harness.calls.execute, 0);
    await assertPreserved(harness, run);
  }
});

test('legacy 또는 backend·정리가 불확실한 복구는 BLOCKED와 작업물을 보존한다', async (testContext) => {
  for (const kind of ['legacy', 'backend', 'cleanup'] as const) {
    const harness = await setup(testContext);
    const pending = await stageCrash(harness, kind === 'legacy' ? 'claimed' : 'container_starting');
    if (kind === 'legacy') {
      const database = new DatabaseSync(harness.storePath);
      try {
        database.exec('DROP TRIGGER execution_lifecycle_history_immutable_delete');
        database.prepare('DELETE FROM execution_lifecycle_history WHERE run_id = ?').run(pending.runId);
        database.prepare('DELETE FROM execution_lifecycles WHERE run_id = ?').run(pending.runId);
      } finally { database.close(); }
    } else if (kind === 'backend') harness.behavior.preflightFailure = true;
    else harness.behavior.clean = false;
    harness.reopen();
    const run = await harness.newService({}, new SyntheticExecutionWorkspace()).recover(harness.task.taskId, context());
    assert.ok(run);
    assert.equal(run.status, 'BLOCKED');
    assert.equal(harness.calls.execute, 0);
    assert.equal(run.checks.find((check) => check.name === 'recovery_cleanup')!.status, 'failed');
    assert.equal(harness.store.lifecycle(run.runId).cleanup!.removed, false);
    await assertPreserved(harness, run);
  }
});

test('완료 commit 직전 취소는 성공을 차단하고 완료 후 제어는 terminal 결과를 바꾸지 않는다', async (testContext) => {
  for (const phase of ['finalizing', 'finished'] as const) {
    const harness = await setup(testContext);
    let controlled = false;
    const run = await harness.newService({ checkpoint: async (current) => {
      if (current === phase) { harness.control('edited'); controlled = true; }
    } }).run(harness.request, context(), harness.artifactDirectory);
    assert.equal(controlled, true);
    assert.equal(run.status, phase === 'finalizing' ? 'CANCELLED' : 'SUCCEEDED');
    assert.equal(harness.calls.started, 1);
    assert.equal(run.commands[0]!.exitCode, 0);
    assert.equal(run.diff.length, 1);
    assert.equal(run.observation!.status, 'passed');
    await assertPreserved(harness, run);
  }
});

test('복구 관찰이 이전 검증 뒤의 파일 변경을 찾으면 과거 본문을 현재 diff로 표시하지 않는다', async (testContext) => {
  const harness = await setup(testContext);
  const pending = await stageCrash(harness, 'patch_applied');
  assert.equal(harness.store.findRun(pending.runId)!.diff.length, 1);
  const partial = "export const message = 'partial";
  await fileSystem.writeFile(join(harness.artifactDirectory, 'worktree/src/message.mjs'), partial);
  harness.reopen();
  const run = await harness.newService({}, new SyntheticExecutionWorkspace()).recover(harness.task.taskId, context());
  assert.ok(run);
  assert.equal(run.status, 'BLOCKED');
  assert.deepEqual(run.diff, []);
  assert.equal(run.observation!.status, 'failed');
  assert.equal(run.observation!.changes.find((change) => change.path === 'src/message.mjs')!.afterHash, sha256(partial));
  await assertPreserved(harness, run);
});

test('최종 관찰 중 외부 종료 신호는 취소를 저장하고 완료 commit 뒤 신호는 결과를 바꾸지 않는다', async (testContext) => {
  for (const phase of ['finalizing', 'finished'] as const) {
    const harness = await setup(testContext);
    const controller = new AbortController();
    let aborted = false;
    const run = await harness.newService({ checkpoint: async (current) => {
      if (current === phase) { controller.abort(); aborted = true; }
    } }).run(harness.request, context(), harness.artifactDirectory, controller.signal);
    assert.equal(aborted, true);
    assert.equal(run.status, phase === 'finalizing' ? 'CANCELLED' : 'SUCCEEDED');
    assert.equal(harness.store.requestState(run.taskId).reason, phase === 'finalizing' ? 'OWNER_CANCELLED' : null);
    assert.equal(run.commands[0]!.exitCode, 0);
    assert.equal(run.commands[0]!.removed, true);
    assert.equal(run.observation!.status, 'passed');
    await assertPreserved(harness, run);
  }
});
