import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { SqliteExecutionStore } from '../src/adapters/sqlite-execution-store.js';
import { SyntheticExecutionWorkspace } from '../src/adapters/execution-workspace.js';
import { SyntheticExecutionService } from '../src/application/execute-synthetic.js';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import { hashRepository } from '../src/adapters/demo-repository.js';
import type { ExecutionTask, IsolatedExecutionPort } from '../src/domain/execution.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';

const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-control.sock', serverVersion: '29.4.3', nodeVersion: '24.22.2', imageId: `sha256:${'a'.repeat(64)}`,
};
const context = () => ({ ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
const clean = async (root: string): Promise<void> => {
  const thaw = async (path: string): Promise<void> => {
    if ((await lstat(path)).isDirectory()) {
      await chmod(path, 0o700);
      for (const name of await readdir(path)) await thaw(join(path, name));
    }
  };
  await thaw(root); await rm(root, { recursive: true, force: true });
};
const prepare = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-control-cli-'))); await chmod(root, 0o700);
  t.after(() => clean(root));
  const configPath = join(root, 'config.json'); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const data = join(root, 'data');
  const cli = (args: string[]) => spawnSync(process.execPath, ['dist/src/cli/main.js', ...args, '--data-dir', data], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 262_144, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  const planned = cli(['execution-plan', '--config', configPath]); assert.equal(planned.status, 0, planned.stderr);
  const task = JSON.parse(planned.stdout).task as ExecutionTask;
  const request = { taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit };
  return { root, data, configPath, cli, task, request };
};

test('실행 lease를 보유한 동안 조회와 취소·편집·삭제 제어는 가능하고 새 실행·복구는 거부한다', async (t) => {
  for (const kind of ['cancel', 'edited', 'deleted'] as const) {
    const fixture = await prepare(t);
    const { data, cli, task, request, configPath } = fixture;
    const store = new SqliteExecutionStore(join(data, 'execution.sqlite'));
    store.approve({ ...request, expiresInMinutes: 30 }, context());
    const before = await hashRepository(task.sourceRoot);
    let commands = 0;
    const backend: IsolatedExecutionPort = {
      preflight: async () => {},
      execute: async () => { commands += 1; throw new Error('unexpected execution'); },
    };
    const release = acquireRuntimeLease(data);
    try {
      const service = new SyntheticExecutionService(store, new SyntheticExecutionWorkspace(), backend, config,
        { platform: 'darwin', architecture: 'arm64' }, { checkpoint: async (phase) => {
          if (phase !== 'workspace_ready') return;
          const inspected = cli(['execution-inspect', '--task', task.taskId]); assert.equal(inspected.status, 0, inspected.stderr);
          const snapshot = JSON.parse(inspected.stdout);
          assert.equal(snapshot.task.status, 'RUNNING'); assert.equal(snapshot.runs[0].status, 'RUNNING');
          assert.equal(snapshot.lifecycles[0].phase, phase);
          const recover = cli(['execution-recover', '--task', task.taskId, '--config', configPath]);
          assert.equal(recover.status, 1); assert.match(recover.stderr, /^HARNESS_ALREADY_RUNNING/m);
          const control = cli(kind === 'cancel' ? ['execution-cancel', '--task', task.taskId]
            : ['execution-invalidate', '--task', task.taskId, '--event', kind, '--revision', '2', '--event-id', `event-${kind}`]);
          assert.equal(control.status, 0, control.stderr);
          assert.equal(JSON.parse(control.stdout).task.status, 'RUNNING');
          assert.ok(JSON.parse(control.stdout).requestState.invalidatedAt);
        } });
      const artifact = join(data, 'executions', task.taskId, `run-${randomUUID()}`); await mkdir(artifact, { mode: 0o700 });
      const run = await service.run(request, context(), artifact);
      assert.equal(run.status, 'CANCELLED'); assert.equal(commands, 0); assert.equal(run.commands.length, 0);
      assert.equal(await hashRepository(task.sourceRoot), before);
      const inspected = cli(['execution-inspect', '--task', task.taskId]); assert.equal(inspected.status, 0, inspected.stderr);
      const snapshot = JSON.parse(inspected.stdout);
      assert.equal(snapshot.task.status, 'CANCELLED'); assert.equal(snapshot.runs[0].status, 'CANCELLED');
      assert.equal(snapshot.lifecycles[0].phase, 'finished'); assert.ok(snapshot.reportPaths.length);
      assert.ok(snapshot.approvals[0].usedAt);
    } finally { release(); store.close(); }
  }
});

test('합성 무효화는 중복·역순 이벤트를 멱등 처리하고 승인 snapshot을 취소한 뒤 다시 실행하지 않는다', async (t) => {
  const { data, cli, task, request, configPath } = await prepare(t);
  const approved = cli(['execution-approve', '--task', task.taskId, '--plan-hash', request.planHash,
    '--base-commit', request.baseCommit, '--expires-in-minutes', '30', '--config', configPath]);
  assert.equal(approved.status, 0, approved.stderr);
  const invalidate = ['execution-invalidate', '--task', task.taskId, '--event', 'edited', '--revision', '3', '--event-id', 'fixture-edit'];
  const first = cli(invalidate); assert.equal(first.status, 0, first.stderr);
  const repeated = cli(invalidate); assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(first.stdout).requestState, JSON.parse(repeated.stdout).requestState);
  const stale = cli(['execution-invalidate', '--task', task.taskId, '--event', 'deleted', '--revision', '2', '--event-id', 'late-delete']);
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).requestState.revision, 3);
  const changedEvent = cli(['execution-invalidate', '--task', task.taskId, '--event', 'deleted', '--revision', '4', '--event-id', 'fixture-edit']);
  assert.equal(changedEvent.status, 1);
  const run = cli(['execution-run', '--task', task.taskId, '--plan-hash', request.planHash, '--base-commit', request.baseCommit, '--config', configPath]);
  assert.equal(run.status, 1); assert.match(run.stderr, /^EXECUTION_CANCELLED/m);
  const store = new SqliteExecutionStore(join(data, 'execution.sqlite'));
  try {
    assert.ok(store.listApprovals(task.taskId)[0]?.revokedAt);
    assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, null);
    assert.deepEqual(store.listRuns(task.taskId), []);
  } finally { store.close(); }
});

test('취소·무효화 명령은 임의 코드·경로·이벤트 본문·잘못된 revision을 입력받지 않는다', async (t) => {
  const { cli, task } = await prepare(t);
  for (const args of [
    ['execution-cancel', '--task', task.taskId, '--command', 'sh'],
    ['execution-invalidate', '--task', task.taskId, '--event', 'edited', '--revision', '1', '--event-id', 'bad'],
    ['execution-invalidate', '--task', task.taskId, '--event', 'edited', '--revision', '2', '--event-id', 'bad', '--body', 'arbitrary'],
    ['execution-invalidate', '--task', '../escape', '--event', 'deleted', '--revision', '2', '--event-id', 'bad'],
  ]) {
    const result = cli(args); assert.equal(result.status, 1); assert.match(result.stderr, /^INVALID_ARGUMENTS/m);
  }
});
