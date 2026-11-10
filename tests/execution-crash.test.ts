import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashRepository } from '../src/adapters/demo-repository.js';
import { SyntheticExecutionWorkspace } from '../src/adapters/execution-workspace.js';
import { SqliteExecutionStore } from '../src/adapters/sqlite-execution-store.js';
import { SyntheticExecutionService } from '../src/application/execute-synthetic.js';
import type { ExecutionContainerIntent, IsolatedExecutionPort } from '../src/domain/execution.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import { sha256 } from '../src/policy/execution-policy.js';

const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-crash-docker.sock', serverVersion: '29.4.3',
  imageId: `sha256:${'a'.repeat(64)}`, nodeVersion: '24.22.2',
};
const host = { platform: 'darwin', architecture: 'arm64' };
const context = () => ({ ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
const crashPhases = ['before_claim', 'claimed', 'workspace_ready', 'patch_partial', 'patch_applied',
  'container_created', 'container_starting', 'command_finished', 'finished'] as const;

/** 테스트가 만든 고정 controller 코드만 호스트에서 실행한다. 합성 저장소 코드는 import하지 않는다. */
const crashController = `
import { randomUUID } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SyntheticExecutionWorkspace } from ${JSON.stringify(new URL('../src/adapters/execution-workspace.js', import.meta.url).href)};
import { SqliteExecutionStore } from ${JSON.stringify(new URL('../src/adapters/sqlite-execution-store.js', import.meta.url).href)};
import { SyntheticExecutionService } from ${JSON.stringify(new URL('../src/application/execute-synthetic.js', import.meta.url).href)};
const input = JSON.parse(process.argv[1]);
process.umask(0o077);
const store = new SqliteExecutionStore(input.database);
const workspace = new SyntheticExecutionWorkspace();
const killAt = async (phase) => {
  if (phase !== input.phase) return;
  await writeFile(input.crashMarker, JSON.stringify({ phase, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});
};
if (input.phase === 'patch_partial') {
  workspace.apply = async (plan, executionWorkspace) => {
    const patch = plan.patches[0];
    const handle = await open(join(executionWorkspace.worktreeRoot, patch.path), 'r+');
    try {
      await handle.truncate(0);
      await handle.write(patch.content.slice(0, Math.floor(patch.content.length / 2)), 0, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await killAt('patch_partial');
  };
}
const backend = {
  preflight: async () => { await killAt('before_claim'); },
  execute: async (command, directory, signal, hooks) => {
    if (!hooks) throw new Error('lifecycle hooks required');
    const token = randomUUID();
    const intent = { runId: hooks.runId, name: 'harness-execution-' + token, token, id: null, commandId: command.commandId };
    await hooks.beforeCreate(intent);
    const created = { ...intent, id: 'd'.repeat(64) };
    const state = { intent: created, started: false, removed: false };
    await writeFile(input.backendState, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await hooks.created(created);
    await hooks.beforeStart();
    state.started = true;
    await writeFile(input.backendState, JSON.stringify(state));
    const result = {
      commandId: command.commandId, containerName: intent.name, termination: 'completed', exitCode: 0,
      stopped: true, removed: true, oomKilled: false, outputBytes: 0, outputHash: input.emptyHash, failureCode: null,
    };
    state.removed = true;
    await writeFile(input.backendState, JSON.stringify(state));
    await hooks.finished(result);
    return result;
  },
};
const service = new SyntheticExecutionService(store, workspace, backend, input.config, input.host, { checkpoint: killAt });
await service.run(input.request, { ownerId: input.ownerId, now: new Date() }, input.artifactDirectory);
store.close();
process.exitCode = 99;
`;

const removeOwnedDirectory = async (directory: string): Promise<void> => {
  const thaw = async (entry: string): Promise<void> => {
    const information = await lstat(entry);
    if (!information.isDirectory() || information.isSymbolicLink()) return;
    await chmod(entry, 0o700);
    for (const name of await readdir(entry)) await thaw(join(entry, name));
  };
  await thaw(directory);
  await rm(directory, { recursive: true, force: true });
};

for (const phase of crashPhases) {
  test(`실제 SIGKILL ${phase} 뒤 재시작은 재실행 없이 승인·원본·잔여 상태를 보존한다`, async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-execution-crash-')));
    await chmod(directory, 0o700);
    const sourceDirectory = join(directory, 'task');
    const artifactDirectory = join(directory, 'run');
    await mkdir(sourceDirectory, { mode: 0o700 });
    await mkdir(artifactDirectory, { mode: 0o700 });
    const database = join(directory, 'execution.sqlite');
    const crashMarker = join(directory, 'crashed.json');
    const backendState = join(directory, 'backend-state.json');
    t.after(() => removeOwnedDirectory(directory));
    const preparingStore = new SqliteExecutionStore(database);
    const forbiddenBackend: IsolatedExecutionPort = {
      preflight: async () => { throw new Error('planning must not contact a backend'); },
      execute: async () => { throw new Error('planning must not execute'); },
    };
    const planning = new SyntheticExecutionService(preparingStore, new SyntheticExecutionWorkspace(), forbiddenBackend, config, host);
    const task = await planning.plan(randomUUID(), sourceDirectory, 'success');
    const request = { taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit };
    const approval = await planning.approve({ ...request, expiresInMinutes: 30 }, context());
    const sourceBefore = await hashRepository(task.sourceRoot);
    preparingStore.close();
    const killed = spawnSync(process.execPath, ['--input-type=module', '--eval', crashController, JSON.stringify({
      phase, database, config, host, request, artifactDirectory, crashMarker, backendState,
      ownerId: context().ownerId, emptyHash: sha256(''),
    })], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64_000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' } });
    assert.equal(killed.error, undefined, killed.stderr);
    assert.equal(killed.status, null, killed.stderr);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const marker = JSON.parse(await readFile(crashMarker, 'utf8')) as { phase: string; pid: number };
    assert.equal(marker.phase, phase);
    assert.equal(marker.pid, killed.pid);

    // 새 프로세스가 남긴 SQLite를 새 store/workspace/service로 읽는다. 메모리 snapshot은 재사용하지 않는다.
    const store = new SqliteExecutionStore(database);
    t.after(() => store.close());
    const previous = store.listRuns(task.taskId)[0] ?? null;
    const previousApproval = store.listApprovals(task.taskId)[0]!;
    const previousLifecycle = previous ? store.lifecycle(previous.runId) : null;
    let executionCalls = 0;
    let recoveryCalls = 0;
    let preflightCalls = 0;
    const backend: IsolatedExecutionPort = {
      preflight: async () => { preflightCalls += 1; },
      execute: async () => { executionCalls += 1; throw new Error('recovery must not execute'); },
      recover: async (intent: ExecutionContainerIntent) => {
        recoveryCalls += 1;
        assert.deepEqual(intent, previousLifecycle?.container);
        const state = JSON.parse(await readFile(backendState, 'utf8')) as { intent: ExecutionContainerIntent; started: boolean; removed: boolean };
        assert.deepEqual(state.intent, intent);
        const found = !state.removed;
        state.removed = true;
        await writeFile(backendState, JSON.stringify(state));
        return { found, stopped: true, removed: true, exitCode: state.started && found ? 137 : null, oomKilled: false, failureCode: null };
      },
    };
    const service = new SyntheticExecutionService(store, new SyntheticExecutionWorkspace(), backend, config, host);
    const recovered = await service.recover(task.taskId, context());
    assert.equal(executionCalls, 0);
    assert.equal(await hashRepository(task.sourceRoot), sourceBefore);
    assert.equal(sourceBefore, task.plan.sourceHash);
    assert.equal(store.listApprovals(task.taskId)[0]?.approvalId, approval.approvalId);
    assert.deepEqual(store.listApprovals(task.taskId)[0]?.planSnapshot, task.plan);

    if (phase === 'before_claim') {
      assert.equal(recovered, null);
      assert.deepEqual(store.listRuns(task.taskId), []);
      assert.equal(store.find(task.taskId)?.status, 'APPROVED');
      assert.equal(previousApproval.usedAt, null);
      assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, null);
      assert.equal(preflightCalls, 0);
      await assert.rejects(lstat(join(artifactDirectory, 'worktree')), { code: 'ENOENT' });
      return;
    }
    assert.ok(previous);
    assert.ok(recovered);
    assert.equal(store.listRuns(task.taskId).length, 1);
    assert.equal(recovered.runId, previous.runId);
    assert.ok(previousApproval.usedAt);
    assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, previousApproval.usedAt);
    assert.equal(recovered.sourceBeforeHash, sourceBefore);
    assert.equal(recovered.sourceAfterHash, sourceBefore);
    assert.equal(store.lifecycle(recovered.runId).phase, 'finished');
    assert.equal(recovered.checks.find((check) => check.name === 'original_unchanged')?.status, 'passed');
    assert.equal(recoveryCalls, previousLifecycle?.container !== null && phase !== 'finished' ? 1 : 0);
    assert.equal(preflightCalls, recoveryCalls);
    assert.deepEqual(store.findRun(recovered.runId), recovered);

    if (phase === 'finished') {
      assert.equal(previous.status, 'SUCCEEDED');
      assert.equal(recovered.status, 'SUCCEEDED');
      assert.deepEqual(recovered, previous);
    } else if (phase === 'patch_partial') {
      assert.equal(recovered.status, 'BLOCKED');
      assert.equal(recovered.observation?.status, 'failed');
      const patch = task.plan.patches[0]!;
      const partial = patch.content.slice(0, Math.floor(patch.content.length / 2));
      assert.equal(await readFile(join(artifactDirectory, 'worktree', patch.path), 'utf8'), partial);
      assert.ok(recovered.observation?.changes.some((change) => change.path === patch.path && change.kind === 'modified'
        && change.beforeHash === patch.beforeHash && change.afterHash === sha256(partial) && !change.inScope));
    } else {
      assert.equal(recovered.status, 'INTERRUPTED');
      assert.equal(recovered.observation?.status, phase === 'claimed' ? 'not_run' : 'passed');
    }
    if (phase !== 'claimed') {
      assert.equal(recovered.observation?.workspaceExists, true);
      assert.equal(recovered.observation?.gitUnchanged, true);
      assert.equal(recovered.observation?.viewUnchanged, previousLifecycle?.workspace?.viewHash ? true : null);
    }
    const approvedPatchExists = ['patch_applied', 'container_created', 'container_starting', 'command_finished', 'finished'].includes(phase);
    if (approvedPatchExists) {
      assert.ok(recovered.diff.some((difference) => difference.path === task.plan.patches[0]!.path
        && difference.beforeHash === task.plan.patches[0]!.beforeHash && difference.afterHash === task.plan.patches[0]!.afterHash));
      assert.ok(recovered.observation?.changes.some((change) => change.path === 'src/message.mjs' && change.inScope));
      assert.equal(await readFile(join(artifactDirectory, 'worktree', 'src/message.mjs'), 'utf8'), task.plan.patches[0]!.content);
    }
    const expectedCommandStatus = ['command_finished', 'finished'].includes(phase) ? 'passed'
      : phase === 'container_starting' ? 'failed' : 'not_run';
    assert.equal(recovered.checks.find((check) => check.name === 'synthetic-check-v1')?.status, expectedCommandStatus);
    await assert.rejects(service.run(request, context(), artifactDirectory));
    assert.equal(executionCalls, 0);
    assert.equal(store.listRuns(task.taskId).length, 1);
    assert.equal(await hashRepository(task.sourceRoot), sourceBefore);
    assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, previousApproval.usedAt);
    const repeated = await service.recover(task.taskId, context());
    assert.equal(repeated?.runId, recovered.runId);
    assert.equal(executionCalls, 0);
    assert.equal(store.listRuns(task.taskId).length, 1);
  });
}
