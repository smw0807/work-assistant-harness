import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { hashRepository } from '../src/adapters/demo-repository.js';
import { SyntheticExecutionWorkspace } from '../src/adapters/execution-workspace.js';
import { SqliteExecutionStore } from '../src/adapters/sqlite-execution-store.js';
import { SyntheticExecutionService } from '../src/application/execute-synthetic.js';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import {
  BRANCH_EXECUTION_POLICY_VERSION, type ExecutionApproval, type ExecutionRun, type ExecutionSnapshot,
  type ExecutionTask, type IsolatedExecutionPort,
} from '../src/domain/execution.js';
import type { BranchWorkType } from '../src/domain/branch.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import { sha256 } from '../src/policy/execution-policy.js';

const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-branch-execution.sock', serverVersion: '29.4.3', nodeVersion: '24.22.2',
  imageId: `sha256:${'a'.repeat(64)}`,
};
const context = () => ({ ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
const removeFixture = async (directory: string): Promise<void> => {
  const metadata = await lstat(directory);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(directory, 0o700);
    for (const name of await readdir(directory)) await removeFixture(join(directory, name));
  }
  await rm(directory, { recursive: true, force: true });
};
const fileHash = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex');
const requestArguments = (task: ExecutionTask): string[] => [
  '--task', task.taskId, '--plan-hash', task.plan.planHash, '--base-commit', task.baseCommit,
];

const prepare = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-branch-execution-cli-')));
  await chmod(root, 0o700); t.after(() => removeFixture(root));
  const data = join(root, 'data');
  const configPath = join(root, 'sandbox.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const execute = (args: string[]) => spawnSync(process.execPath, [resolve('dist/src/cli/main.js'), ...args, '--data-dir', data], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 512_000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  const run = <T>(args: string[]): T => {
    const result = execute(args); assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, ''); return JSON.parse(result.stdout) as T;
  };
  const reject = (args: string[], code: string): void => {
    const result = execute(args); assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, ''); assert.equal(result.stderr.split('\n')[0], code);
  };
  const plan = (type: BranchWorkType = 'fix'): ExecutionTask => run<{ task: ExecutionTask }>([
    'branch-execution-plan', '--type', type, '--config', configPath,
  ]).task;
  const approve = (task: ExecutionTask): ExecutionApproval => run<{ approval: ExecutionApproval }>([
    'branch-execution-approve', ...requestArguments(task), '--expires-in-minutes', '30', '--config', configPath,
  ]).approval;
  const inspect = (task: ExecutionTask): ExecutionSnapshot & { reportPaths: string[] } => run([
    'branch-execution-inspect', '--task', task.taskId,
  ]);
  return { root, data, configPath, execute, run, reject, plan, approve, inspect };
};

test('브랜치 실행 CLI는 네 유형의 새 계획과 승인을 재시작 조회하고 승인 전 원본을 보존한다', async (t) => {
  const cli = await prepare(t);
  for (const type of ['feature', 'fix', 'chore', 'refactor'] as const) {
    const result = cli.run<{ task: ExecutionTask; nextApproval: string }>([
      'branch-execution-plan', '--type', type, '--config', cli.configPath,
    ]);
    const task = result.task;
    assert.equal(task.status, 'AWAITING_APPROVAL');
    assert.equal(task.plan.policy.version, BRANCH_EXECUTION_POLICY_VERSION);
    assert.equal(task.plan.repoId, 'synthetic-branch-execution');
    assert.equal(task.plan.branch?.workType, type);
    assert.equal(task.plan.branch?.name, `${type}/task-${task.taskId}`);
    assert.equal(task.plan.branch?.headRef, `refs/heads/${type}/task-${task.taskId}`);
    assert.equal(task.plan.branch?.ownerId, context().ownerId);
    assert.equal(task.plan.branch?.sourceRoot, join(cli.data, 'branch-executions', task.taskId, 'source'));
    assert.equal(Date.parse(task.plan.branch!.expiresAt) - Date.parse(task.plan.branch!.createdAt), 86_400_000);
    assert.match(result.nextApproval, /branch-execution-approve/);
    const before = await hashRepository(task.sourceRoot);
    assert.equal(await readFile(join(task.sourceRoot, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
    await assert.rejects(lstat(join(task.sourceRoot, '.git', task.plan.branch!.headRef)), { code: 'ENOENT' });
    cli.reject(['branch-execution-run', ...requestArguments(task), '--config', cli.configPath], 'APPROVAL_REQUIRED');
    const approval = cli.approve(task);
    assert.equal(approval.executionPolicy, BRANCH_EXECUTION_POLICY_VERSION);
    assert.deepEqual(approval.planSnapshot, task.plan);
    assert.equal(approval.usedAt, null);
    const snapshot = cli.inspect(task);
    assert.equal(snapshot.task.status, 'APPROVED'); assert.deepEqual(snapshot.runs, []);
    assert.equal(snapshot.approvals[0]?.approvalId, approval.approvalId);
    assert.equal(await hashRepository(task.sourceRoot), before);
    for (const directory of await readdir(join(cli.data, 'branch-executions', task.taskId))) {
      if (!directory.startsWith('run-')) continue;
      const artifact = join(cli.data, 'branch-executions', task.taskId, directory);
      for (const name of await readdir(artifact)) {
        assert.match(name, /^docker-control-/); assert.deepEqual(await readdir(join(artifact, name)), []);
      }
    }
  }
  assert.equal((await lstat(join(cli.data, 'branch-execution.sqlite'))).mode & 0o077, 0);
  await assert.rejects(lstat(join(cli.data, 'execution.sqlite')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(cli.data, 'executions')), { code: 'ENOENT' });
});

test('브랜치 실행은 필수 유형·짧은 승인 TTL·등록 fixture만 받고 임의 실행·Git·전송 입력을 거부한다', async (t) => {
  const cli = await prepare(t);
  const task = cli.plan();
  for (const args of [
    ['branch-execution-plan'], ['branch-execution-plan', '--type', 'docs'],
    ['branch-execution-plan', '--type', 'fix', '--type', 'feature'],
    ['branch-execution-plan', '--type', 'fix', '--fixture', 'arbitrary'],
    ['branch-execution-inspect', '--task', '../escape'],
    ['branch-execution-inspect', '--task', task.taskId, '--approval-offset', '1000000001'],
    ['branch-execution-invalidate', '--task', task.taskId, '--event', 'base-changed', '--revision', '2', '--event-id', 'synthetic'],
    ['branch-execution-invalidate', '--task', task.taskId, '--event', 'edited', '--revision', '1', '--event-id', 'synthetic'],
    ...['--path', '--remote', '--body', '--command', '--token', '--live', '--pr', '--mr', '--commit', '--push'].map((flag) => [
      'branch-execution-plan', '--type', 'fix', flag, 'SYNTHETIC_FORBIDDEN',
    ]),
    ...[undefined, '0', '61', '1440', '01', '1.5'].map((ttl) => [
      'branch-execution-approve', ...requestArguments(task), ...(ttl === undefined ? [] : ['--expires-in-minutes', ttl]),
    ]),
  ]) cli.reject(args, 'INVALID_ARGUMENTS');
  for (const command of ['commit', 'push', 'pr', 'mr']) cli.reject([`branch-execution-${command}`], 'UNKNOWN_COMMAND');
  assert.deepEqual(cli.inspect(task).approvals, []);
  for (const fixture of ['success', 'test-failure', 'timeout', 'output']) {
    const planned = cli.run<{ task: ExecutionTask }>([
      'branch-execution-plan', '--type', 'chore', '--fixture', fixture, '--config', cli.configPath,
    ]).task;
    const approval = cli.run<{ approval: ExecutionApproval }>([
      'branch-execution-approve', ...requestArguments(planned), '--expires-in-minutes', '60', '--config', cli.configPath,
    ]).approval;
    assert.equal(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt), 3_600_000);
  }
});

test('기존 실행·모의 브랜치·로컬 브랜치 승인과 DB는 새 브랜치 실행에 재사용되지 않는다', async (t) => {
  const cli = await prepare(t);
  const old = cli.run<{ task: ExecutionTask }>(['execution-plan', '--config', cli.configPath]).task;
  cli.run(['execution-approve', ...requestArguments(old), '--expires-in-minutes', '1440', '--config', cli.configPath]);
  const mock = cli.run<{ task: { taskId: string; plan: { planHash: string } } }>(['branch-plan', '--type', 'fix']).task;
  cli.run(['branch-approve', '--task', mock.taskId, '--plan-hash', mock.plan.planHash, '--expires-in-minutes', '30']);
  const local = cli.run<{ task: { taskId: string; plan: { planHash: string } } }>(['git-branch-plan', '--type', 'fix']).task;
  cli.run(['git-branch-approve', '--task', local.taskId, '--plan-hash', local.plan.planHash, '--expires-in-minutes', '30']);
  const files = ['execution.sqlite', 'branches.sqlite', 'git-branches.sqlite'];
  const before = await Promise.all(files.map((name) => fileHash(join(cli.data, name))));
  for (const task of [old, mock, local]) {
    cli.reject(['branch-execution-approve', '--task', task.taskId, '--plan-hash', task.plan.planHash,
      '--base-commit', old.baseCommit, '--expires-in-minutes', '30', '--config', cli.configPath], 'EXECUTION_TASK_NOT_FOUND');
    cli.reject(['branch-execution-run', '--task', task.taskId, '--plan-hash', task.plan.planHash,
      '--base-commit', old.baseCommit, '--config', cli.configPath], 'EXECUTION_TASK_NOT_FOUND');
  }
  const task = cli.plan(); cli.approve(task);
  cli.reject(['execution-inspect', '--task', task.taskId], 'EXECUTION_TASK_NOT_FOUND');
  assert.deepEqual(await Promise.all(files.map((name) => fileHash(join(cli.data, name)))), before);
});

test('새 CLI의 조회·취소·이벤트 무효화는 실행 lease를 우회하되 새 실행과 복구는 직렬화한다', async (t) => {
  const cli = await prepare(t);
  const cancelled = cli.plan(); cli.approve(cancelled);
  const invalidated = cli.plan('feature'); cli.approve(invalidated);
  const release = acquireRuntimeLease(cli.data);
  try {
    assert.equal(cli.inspect(cancelled).task.status, 'APPROVED');
    for (const args of [
      ['branch-execution-plan', '--type', 'fix'],
      ['branch-execution-approve', ...requestArguments(cancelled), '--expires-in-minutes', '30', '--config', cli.configPath],
      ['branch-execution-run', ...requestArguments(cancelled), '--config', cli.configPath],
      ['branch-execution-recover', '--task', cancelled.taskId, '--config', cli.configPath],
    ]) cli.reject(args, 'HARNESS_ALREADY_RUNNING');
    cli.run(['branch-execution-cancel', '--task', cancelled.taskId, '--event-id', 'synthetic-cancel']);
    const args = ['branch-execution-invalidate', '--task', invalidated.taskId, '--event', 'edited', '--revision', '3', '--event-id', 'synthetic-edit'];
    const first = cli.run(args); assert.deepEqual(cli.run(args), first);
    cli.run(['branch-execution-invalidate', '--task', invalidated.taskId, '--event', 'deleted', '--revision', '2', '--event-id', 'stale-delete']);
    assert.equal(cli.inspect(invalidated).requestState.revision, 3);
    for (const task of [cancelled, invalidated]) {
      const snapshot = cli.inspect(task);
      assert.equal(snapshot.task.status, 'CANCELLED');
      assert.ok(snapshot.approvals[0]?.revokedAt); assert.equal(snapshot.approvals[0]?.usedAt, null);
      assert.deepEqual(snapshot.runs, []);
    }
  } finally { release(); }
  cli.reject(['branch-execution-run', ...requestArguments(cancelled), '--config', cli.configPath], 'EXECUTION_CANCELLED');
  const recovered = cli.run<{ run: null }>(['branch-execution-recover', '--task', cancelled.taskId, '--config', cli.configPath]);
  assert.equal(recovered.run, null);
});

test('새 프로필은 승인 뒤 config 변경을 Docker 호출 전에 거부하고 승인과 원본을 보존한다', async (t) => {
  const cli = await prepare(t); const task = cli.plan(); cli.approve(task);
  const before = await hashRepository(task.sourceRoot);
  const changed = join(cli.root, 'changed.json');
  await writeFile(changed, JSON.stringify({ ...config, socketPath: '/private/tmp/changed-synthetic.sock' }), { mode: 0o600 });
  cli.reject(['branch-execution-run', ...requestArguments(task), '--config', changed], 'EXECUTION_POLICY_CHANGED');
  const snapshot = cli.inspect(task);
  assert.equal(snapshot.task.status, 'APPROVED'); assert.equal(snapshot.approvals[0]?.usedAt, null);
  assert.deepEqual(snapshot.runs, []); assert.equal(await hashRepository(task.sourceRoot), before);
});

test('새 DB와 작업 루트는 symlink·hardlink·공개 디렉터리를 거부하고 외부 파일을 보존한다', async (t) => {
  for (const hazard of ['db-symlink', 'db-hardlink', 'sidecar', 'root-symlink', 'root-public', 'data-public']) {
    const cli = await prepare(t); await mkdir(cli.data, { mode: 0o700 });
    const outside = join(cli.root, 'outside'); await writeFile(outside, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
    if (hazard === 'db-symlink') await symlink(outside, join(cli.data, 'branch-execution.sqlite'));
    if (hazard === 'db-hardlink') await link(outside, join(cli.data, 'branch-execution.sqlite'));
    if (hazard === 'sidecar') await symlink(outside, join(cli.data, 'branch-execution.sqlite-wal'));
    if (hazard === 'root-symlink') {
      const external = join(cli.root, 'external'); await mkdir(external, { mode: 0o700 });
      await symlink(external, join(cli.data, 'branch-executions'));
    }
    if (hazard === 'root-public') { await mkdir(join(cli.data, 'branch-executions'), { mode: 0o700 }); await chmod(join(cli.data, 'branch-executions'), 0o755); }
    if (hazard === 'data-public') await chmod(cli.data, 0o755);
    cli.reject(['branch-execution-plan', '--type', 'fix', '--config', cli.configPath], hazard.startsWith('db-') || hazard === 'sidecar'
      ? 'UNSAFE_RUNTIME_FILE' : hazard === 'data-public' ? 'DATA_DIRECTORY_NOT_PRIVATE' : 'UNSAFE_EXECUTION_DIRECTORY');
    assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC_UNCHANGED');
  }
});

test('새 프로필 결과는 실제 브랜치와 patch 관찰을 재시작 조회하고 보고서 링크와 재실행을 거부한다', async (t) => {
  const cli = await prepare(t); const task = cli.plan('refactor'); cli.approve(task);
  const store = new SqliteExecutionStore(join(cli.data, 'branch-execution.sqlite'), BRANCH_EXECUTION_POLICY_VERSION);
  t.after(() => store.close());
  const backend: IsolatedExecutionPort = {
    preflight: async () => {},
    execute: async (command) => ({ commandId: command.commandId, containerName: 'synthetic-backend-only', termination: 'completed',
      exitCode: 0, stopped: true, removed: true, oomKilled: false, outputBytes: 0, outputHash: sha256(''), failureCode: null }),
  };
  const artifact = join(cli.data, 'branch-executions', task.taskId, `run-${randomUUID()}`); await mkdir(artifact, { mode: 0o700 });
  const sourceBefore = await hashRepository(task.sourceRoot);
  const service = new SyntheticExecutionService(store, new SyntheticExecutionWorkspace(), backend, config,
    { platform: 'darwin', architecture: 'arm64' }, undefined, BRANCH_EXECUTION_POLICY_VERSION);
  const run = await service.run({ taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit }, context(), artifact);
  assert.equal(run.status, 'SUCCEEDED'); assert.equal(run.diff.length, 1); assert.equal(run.diff[0]?.path, 'src/message.mjs');
  assert.equal(await hashRepository(task.sourceRoot), sourceBefore);
  assert.equal(await readFile(join(run.worktreeRoot!, '.git/HEAD'), 'utf8'), `ref: ${task.plan.branch!.headRef}\n`);
  assert.equal((await readFile(join(run.worktreeRoot!, '.git', task.plan.branch!.headRef), 'utf8')).trim(), task.baseCommit);
  assert.equal((await readFile(join(run.worktreeRoot!, '.git/refs/heads/main'), 'utf8')).trim(), task.baseCommit);
  const snapshot = cli.inspect(task);
  assert.equal(snapshot.task.status, 'SUCCEEDED'); assert.deepEqual(snapshot.runs, [run]);
  assert.ok(snapshot.approvals[0]?.usedAt); assert.equal(snapshot.reportPaths.length, 1);
  const report = snapshot.reportPaths[0]!;
  assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), run);
  await unlink(report);
  const outside = join(cli.root, 'outside-report'); await writeFile(outside, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  await symlink(outside, report);
  cli.reject(['branch-execution-inspect', '--task', task.taskId], 'UNSAFE_EXECUTION_REPORT');
  assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC_UNCHANGED');
  await unlink(report);
  const recovered = cli.run<{ run: ExecutionRun }>(['branch-execution-recover', '--task', task.taskId, '--config', cli.configPath]);
  assert.deepEqual(recovered.run, run);
  cli.reject(['branch-execution-run', ...requestArguments(task), '--config', cli.configPath], 'APPROVAL_REQUIRED');
  assert.equal(cli.inspect(task).runs.length, 1);
});

test('활성 브랜치 실행에 별도 CLI 취소를 전달하면 이후 검사 실행을 막고 남은 branch와 diff를 보존한다', async (t) => {
  const cli = await prepare(t); const task = cli.plan(); cli.approve(task);
  const store = new SqliteExecutionStore(join(cli.data, 'branch-execution.sqlite'), BRANCH_EXECUTION_POLICY_VERSION);
  t.after(() => store.close());
  const sourceBefore = await hashRepository(task.sourceRoot);
  let commands = 0;
  const backend: IsolatedExecutionPort = {
    preflight: async () => {}, execute: async () => { commands += 1; throw new Error('unexpected synthetic execution'); },
  };
  const release = acquireRuntimeLease(cli.data);
  try {
    const service = new SyntheticExecutionService(store, new SyntheticExecutionWorkspace(), backend, config,
      { platform: 'darwin', architecture: 'arm64' }, { checkpoint: async (phase) => {
        if (phase !== 'patch_applied') return;
        const snapshot = cli.inspect(task); assert.equal(snapshot.task.status, 'RUNNING');
        assert.equal(snapshot.lifecycles[0]?.phase, phase);
        cli.run(['branch-execution-cancel', '--task', task.taskId, '--event-id', 'cancel-after-patch']);
      } }, BRANCH_EXECUTION_POLICY_VERSION);
    const artifact = join(cli.data, 'branch-executions', task.taskId, `run-${randomUUID()}`); await mkdir(artifact, { mode: 0o700 });
    const run = await service.run({ taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit }, context(), artifact);
    assert.equal(run.status, 'CANCELLED'); assert.equal(commands, 0); assert.deepEqual(run.commands, []);
    assert.equal(run.diff.length, 1); assert.equal(await hashRepository(task.sourceRoot), sourceBefore);
    assert.equal(await readFile(join(run.worktreeRoot!, '.git/HEAD'), 'utf8'), `ref: ${task.plan.branch!.headRef}\n`);
    const snapshot = cli.inspect(task); assert.equal(snapshot.task.status, 'CANCELLED');
    assert.ok(snapshot.approvals[0]?.usedAt); assert.equal(snapshot.lifecycles[0]?.phase, 'finished');
  } finally { release(); }
});
