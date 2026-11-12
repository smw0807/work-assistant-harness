import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { hashRepository } from '../src/adapters/demo-repository.js';
import { SyntheticExecutionWorkspace } from '../src/adapters/execution-workspace.js';
import { SqliteExecutionStore } from '../src/adapters/sqlite-execution-store.js';
import { SyntheticExecutionService, type ExecutionServiceObserver } from '../src/application/execute-synthetic.js';
import { HarnessError } from '../src/domain/errors.js';
import {
  BRANCH_EXECUTION_POLICY_VERSION, type ExecutionCommandResult, type ExecutionContainerIntent,
  type ExecutionTask, type IsolatedExecutionPort,
} from '../src/domain/execution.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import { sha256 } from '../src/policy/execution-policy.js';

const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-branch-workflow.sock', serverVersion: '29.4.3',
  imageId: `sha256:${'a'.repeat(64)}`, nodeVersion: '24.22.2',
};
const host = { platform: 'darwin', architecture: 'arm64' };
const context = () => ({ ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
const removeFixture = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await removeFixture(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
};
const assertBranch = async (task: ExecutionTask, worktree: string): Promise<void> => {
  assert.equal(await readFile(join(worktree, '.git/HEAD'), 'utf8'), `ref: ${task.plan.branch!.headRef}\n`);
  for (const ref of ['refs/heads/main', task.plan.branch!.headRef]) {
    assert.equal(await readFile(join(worktree, '.git', ref), 'utf8'), `${task.baseCommit}\n`);
  }
};

const prepare = async (t: TestContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-branch-workflow-')));
  await chmod(directory, 0o700);
  const taskId = randomUUID();
  const taskDirectory = join(directory, 'branch-executions', taskId);
  await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
  const database = join(directory, 'branch-execution.sqlite');
  let store: SqliteExecutionStore | null = new SqliteExecutionStore(database, BRANCH_EXECUTION_POLICY_VERSION);
  t.after(async () => { store?.close(); await removeFixture(directory); });
  const workspace = new SyntheticExecutionWorkspace();
  const calls = { preflight: 0, execute: 0, created: 0, started: 0 };
  const behavior = { failPreflight: false };
  const backend: IsolatedExecutionPort = {
    preflight: async () => {
      calls.preflight += 1;
      if (behavior.failPreflight) throw new HarnessError('EXECUTION_SYNTHETIC_PREFLIGHT_FAILURE');
    },
    execute: async (command, _root, _signal, hooks) => {
      calls.execute += 1; assert.ok(hooks);
      const token = randomUUID();
      const intent: ExecutionContainerIntent = { runId: hooks.runId, name: `harness-execution-${token}`, token, id: null, commandId: command.commandId };
      let cancelled = false;
      try {
        await hooks.beforeCreate(intent); calls.created += 1;
        await hooks.created({ ...intent, id: 'e'.repeat(64) });
        await hooks.beforeStart(); calls.started += 1;
      } catch (error) {
        if (!(error instanceof HarnessError) || error.code !== 'EXECUTION_CANCELLED') throw error;
        cancelled = true;
      }
      const result: ExecutionCommandResult = {
        commandId: command.commandId, containerName: intent.name, termination: cancelled ? 'aborted' : 'completed',
        exitCode: cancelled ? 137 : 0, stopped: true, removed: true, oomKilled: false,
        outputBytes: 0, outputHash: sha256(''), failureCode: null,
      };
      await hooks.finished(result); return result;
    },
  };
  const service = (observer: ExecutionServiceObserver = {}) => new SyntheticExecutionService(
    store!, workspace, backend, config, host, observer, BRANCH_EXECUTION_POLICY_VERSION,
  );
  const task = await service().plan(taskId, taskDirectory, 'success', 'feature');
  const request = { taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit };
  await service().approve({ ...request, expiresInMinutes: 30 }, context());
  const artifact = join(taskDirectory, `run-${randomUUID()}`); await mkdir(artifact, { mode: 0o700 });
  const close = (): void => { store?.close(); store = null; };
  const reopen = (): SqliteExecutionStore => { close(); store = new SqliteExecutionStore(database, BRANCH_EXECUTION_POLICY_VERSION); return store; };
  return { directory, database, task, request, artifact, workspace, calls, behavior, service, close, reopen, get store() { return store!; } };
};

test('새 실행의 단계별 취소·편집·삭제는 이후 branch·patch·검사 전이를 막고 이미 발생한 변경을 보존한다', async (t) => {
  for (const kind of ['cancel', 'edited', 'deleted'] as const) {
    for (const phase of ['claimed', 'workspace_ready', 'patch_applied', 'view_ready', 'container_created', 'container_starting', 'command_finished'] as const) {
      const fixture = await prepare(t);
      const control = new SqliteExecutionStore(fixture.database, BRANCH_EXECUTION_POLICY_VERSION);
      let controlled = false;
      try {
        const run = await fixture.service({ checkpoint: async (current) => {
          if (current !== phase || controlled) return;
          control.control({ taskId: fixture.task.taskId, eventId: randomUUID(), kind, revision: kind === 'cancel' ? 1 : 2 }, context());
          controlled = true;
        } }).run(fixture.request, context(), fixture.artifact);
        assert.equal(controlled, true); assert.equal(run.status, 'CANCELLED', `${kind}/${phase}`);
        assert.equal(fixture.calls.started, phase === 'command_finished' ? 1 : 0);
        assert.ok(fixture.store.listApprovals(fixture.task.taskId)[0]?.usedAt);
        assert.equal(await hashRepository(fixture.task.sourceRoot), fixture.task.plan.sourceHash);
        assert.equal(fixture.store.listRuns(fixture.task.taskId).length, 1);
        if (phase === 'claimed') {
          assert.equal(run.observation?.status, 'not_run');
          await assert.rejects(lstat(join(fixture.artifact, 'worktree')), { code: 'ENOENT' });
        } else {
          await assertBranch(fixture.task, join(fixture.artifact, 'worktree'));
          assert.equal(run.observation?.status, 'passed');
          assert.equal(run.diff.length, phase === 'workspace_ready' ? 0 : 1);
          assert.equal(await readFile(join(fixture.artifact, 'worktree/src/message.mjs'), 'utf8'), phase === 'workspace_ready'
            ? "export const message = 'before';\n" : fixture.task.plan.patches[0]!.content);
        }
        if (!phase.startsWith('container_') && phase !== 'command_finished') {
          assert.equal(fixture.calls.execute, 0);
          assert.equal(run.checks.find((check) => check.name === 'synthetic-check-v1')?.status, 'not_run');
        }
        await assert.rejects(fixture.service().run(fixture.request, context(), fixture.artifact));
      } finally { control.close(); }
    }
  }
});

test('새 정책의 backend 사전 검증 실패는 승인·기준·Run·작업 브랜치를 변경하지 않는다', async (t) => {
  const fixture = await prepare(t); fixture.behavior.failPreflight = true;
  const approval = fixture.store.listApprovals(fixture.task.taskId)[0];
  await assert.rejects(fixture.service().run(fixture.request, context(), fixture.artifact), { code: 'EXECUTION_SYNTHETIC_PREFLIGHT_FAILURE' });
  assert.equal(fixture.calls.preflight, 1); assert.equal(fixture.calls.execute, 0);
  assert.deepEqual(fixture.store.listRuns(fixture.task.taskId), []);
  assert.deepEqual(fixture.store.listApprovals(fixture.task.taskId), [approval]);
  assert.equal(fixture.store.find(fixture.task.taskId)?.status, 'APPROVED');
  assert.equal(await hashRepository(fixture.task.sourceRoot), fixture.task.plan.sourceHash);
  assert.deepEqual(await readdir(fixture.artifact), []);
});

test('실행 도중 HEAD·작업 ref·patch·검사 view 변조는 다음 검사 실행을 막고 BLOCKED 관찰로 남는다', async (t) => {
  for (const mutation of ['head', 'branch', 'patch', 'view'] as const) {
    const fixture = await prepare(t);
    const phase = mutation === 'head' || mutation === 'branch' ? 'workspace_ready' : mutation === 'patch' ? 'patch_applied' : 'view_ready';
    const run = await fixture.service({ checkpoint: async (current, running) => {
      if (current !== phase) return;
      const path = mutation === 'head' ? join(running.worktreeRoot!, '.git/HEAD')
        : mutation === 'branch' ? join(running.worktreeRoot!, '.git', fixture.task.plan.branch!.headRef)
          : mutation === 'patch' ? join(running.worktreeRoot!, 'src/message.mjs') : join(fixture.artifact, 'container-view/checks/check.mjs');
      await chmod(path, 0o600);
      await writeFile(path, mutation === 'head' ? 'ref: refs/heads/main\n'
        : mutation === 'branch' ? `${'f'.repeat(40)}\n` : 'SYNTHETIC_UNAPPROVED_BODY');
      if (mutation === 'view') await chmod(path, 0o444);
    } }).run(fixture.request, context(), fixture.artifact);
    assert.equal(run.status, 'BLOCKED', mutation); assert.equal(run.observation?.status, 'failed');
    assert.equal(fixture.calls.execute, 0, mutation); assert.equal(fixture.calls.started, 0, mutation);
    assert.ok(fixture.store.listApprovals(fixture.task.taskId)[0]?.usedAt);
    assert.equal(await hashRepository(fixture.task.sourceRoot), fixture.task.plan.sourceHash);
    assert.doesNotMatch(JSON.stringify(run), /SYNTHETIC_UNAPPROVED_BODY/);
    await assert.rejects(fixture.service().run(fixture.request, context(), fixture.artifact));
  }
});

const crashPhases = ['claimed', 'branch_created', 'workspace_ready', 'patch_partial', 'patch_applied', 'container_starting', 'command_finished'] as const;

// 합성 저장소의 코드를 실행하지 않고 테스트 controller 자체를 별도 프로세스에서 강제 종료한다.
const crashController = `
import { randomUUID } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SyntheticExecutionWorkspace } from ${JSON.stringify(new URL('../src/adapters/execution-workspace.js', import.meta.url).href)};
import { SqliteExecutionStore } from ${JSON.stringify(new URL('../src/adapters/sqlite-execution-store.js', import.meta.url).href)};
import { SyntheticExecutionService } from ${JSON.stringify(new URL('../src/application/execute-synthetic.js', import.meta.url).href)};
const input = JSON.parse(process.argv[1]); process.umask(0o077);
const store = new SqliteExecutionStore(input.database, input.policy);
const workspace = new SyntheticExecutionWorkspace();
const killAt = async (phase) => {
  if (phase !== input.phase) return;
  await writeFile(input.marker, JSON.stringify({ phase, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  process.kill(process.pid, 'SIGKILL'); await new Promise(() => {});
};
if (input.phase === 'branch_created') {
  const materialize = workspace.materialize.bind(workspace);
  workspace.materialize = async (...args) => { const result = await materialize(...args); await killAt('branch_created'); return result; };
}
if (input.phase === 'patch_partial') {
  workspace.apply = async (plan, target) => {
    const handle = await open(join(target.worktreeRoot, plan.patches[0].path), 'r+');
    try { await handle.truncate(0); await handle.write(plan.patches[0].content.slice(0, 8), 0, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await killAt('patch_partial');
  };
}
const backend = {
  preflight: async () => {},
  execute: async (command, directory, signal, hooks) => {
    const token = randomUUID();
    const intent = { runId: hooks.runId, name: 'harness-execution-' + token, token, id: null, commandId: command.commandId };
    await hooks.beforeCreate(intent);
    const created = { ...intent, id: 'd'.repeat(64) };
    const state = { intent: created, started: false, removed: false };
    await writeFile(input.backendState, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await hooks.created(created); await hooks.beforeStart();
    state.started = true;
    const result = { commandId: command.commandId, containerName: intent.name, termination: 'completed', exitCode: 0,
      stopped: true, removed: true, oomKilled: false, outputBytes: 0, outputHash: input.emptyHash, failureCode: null };
    state.removed = true; await writeFile(input.backendState, JSON.stringify(state));
    await hooks.finished(result); return result;
  },
};
const service = new SyntheticExecutionService(store, workspace, backend, input.config, input.host, { checkpoint: killAt }, input.policy);
await service.run(input.request, { ownerId: input.ownerId, now: new Date() }, input.artifact);
store.close(); process.exitCode = 99;
`;

for (const phase of crashPhases) {
  test(`브랜치 실행 실제 SIGKILL ${phase} 뒤 새 인스턴스는 승인 소비와 실제 잔여 상태를 복구하고 재실행하지 않는다`, async (t) => {
    const fixture = await prepare(t);
    const approval = fixture.store.listApprovals(fixture.task.taskId)[0]!;
    const marker = join(fixture.directory, 'crashed.json');
    const backendState = join(fixture.directory, 'backend-state.json');
    fixture.close();
    const killed = spawnSync(process.execPath, ['--input-type=module', '--eval', crashController, JSON.stringify({
      phase, policy: BRANCH_EXECUTION_POLICY_VERSION, database: fixture.database, request: fixture.request,
      artifact: fixture.artifact, marker, backendState, config, host, ownerId: context().ownerId, emptyHash: sha256(''),
    })], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64_000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' } });
    assert.equal(killed.error, undefined, killed.stderr); assert.equal(killed.status, null, killed.stderr);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { phase, pid: killed.pid });
    const store = fixture.reopen();
    const previous = store.listRuns(fixture.task.taskId)[0]!;
    const lifecycle = store.lifecycle(previous.runId);
    const usedAt = store.listApprovals(fixture.task.taskId)[0]!.usedAt;
    assert.ok(usedAt); assert.equal(previous.status, 'RUNNING');
    const worktree = join(fixture.artifact, 'worktree');
    const before = phase === 'claimed' ? null : await hashRepository(worktree);
    let executions = 0; let recoveries = 0;
    const backend: IsolatedExecutionPort = {
      preflight: async () => {},
      execute: async () => { executions += 1; throw new Error('recovery cannot execute'); },
      recover: async (intent) => {
        recoveries += 1; assert.deepEqual(intent, lifecycle.container);
        const state = JSON.parse(await readFile(backendState, 'utf8')) as { intent: ExecutionContainerIntent; started: boolean; removed: boolean };
        assert.deepEqual(state.intent, intent);
        const found = !state.removed; state.removed = true; await writeFile(backendState, JSON.stringify(state));
        return { found, stopped: true, removed: true, exitCode: found && state.started ? 137 : null, oomKilled: false, failureCode: null };
      },
    };
    const service = new SyntheticExecutionService(store, new SyntheticExecutionWorkspace(), backend, config, host, undefined, BRANCH_EXECUTION_POLICY_VERSION);
    const run = await service.recover(fixture.task.taskId, context()); assert.ok(run);
    assert.equal(run.status, phase === 'branch_created' || phase === 'patch_partial' ? 'BLOCKED' : 'INTERRUPTED');
    assert.equal(run.runId, previous.runId); assert.equal(executions, 0);
    assert.equal(recoveries, lifecycle.container ? 1 : 0);
    assert.equal(store.listRuns(fixture.task.taskId).length, 1);
    assert.equal(store.listApprovals(fixture.task.taskId)[0]?.approvalId, approval.approvalId);
    assert.equal(store.listApprovals(fixture.task.taskId)[0]?.usedAt, usedAt);
    assert.equal(await hashRepository(fixture.task.sourceRoot), fixture.task.plan.sourceHash);
    assert.equal(run.sourceAfterHash, fixture.task.plan.sourceHash);
    if (phase === 'claimed') {
      assert.equal(run.observation?.status, 'not_run'); await assert.rejects(lstat(worktree), { code: 'ENOENT' });
    } else {
      await assertBranch(fixture.task, worktree);
      assert.equal(await hashRepository(worktree), before);
      assert.equal(run.observation?.workspaceExists, true);
      if (phase === 'branch_created') assert.equal(run.observation?.reason, 'EXECUTION_WORKSPACE_EVIDENCE_MISSING');
      else {
        assert.equal(run.observation?.gitUnchanged, true);
        assert.equal(run.observation?.status, phase === 'patch_partial' ? 'failed' : 'passed');
      }
    }
    if (phase === 'patch_partial') {
      assert.equal(await readFile(join(worktree, 'src/message.mjs'), 'utf8'), fixture.task.plan.patches[0]!.content.slice(0, 8));
      const change = run.observation?.changes.find((entry) => entry.path === 'src/message.mjs');
      assert.equal(change?.afterHash, sha256(fixture.task.plan.patches[0]!.content.slice(0, 8))); assert.equal(change?.inScope, false);
      assert.deepEqual(run.diff, []);
    }
    const patched = ['patch_applied', 'container_starting', 'command_finished'].includes(phase);
    if (patched) {
      assert.equal(run.diff.length, 1);
      assert.equal(await readFile(join(worktree, 'src/message.mjs'), 'utf8'), fixture.task.plan.patches[0]!.content);
    }
    assert.equal(run.checks.find((check) => check.name === 'synthetic-check-v1')?.status,
      phase === 'command_finished' ? 'passed' : phase === 'container_starting' ? 'failed' : 'not_run');
    await assert.rejects(service.run(fixture.request, context(), fixture.artifact));
    const repeated = await service.recover(fixture.task.taskId, context());
    assert.equal(repeated?.runId, run.runId); assert.equal(executions, 0);
    assert.equal(store.listApprovals(fixture.task.taskId)[0]?.usedAt, usedAt);
    if (before !== null) assert.equal(await hashRepository(worktree), before);
  });
}
