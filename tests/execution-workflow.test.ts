import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { SyntheticExecutionWorkspace } from '../src/adapters/execution-workspace.js';
import { SqliteExecutionStore } from '../src/adapters/sqlite-execution-store.js';
import { hashRepository } from '../src/adapters/demo-repository.js';
import { SyntheticExecutionService } from '../src/application/execute-synthetic.js';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import type { ExecutionCommandResult, ExecutionPlan, IsolatedExecutionPort } from '../src/domain/execution.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import {
  assertExecutionConfig, assertExecutionPlan, createExecutionPolicy, getExecutionCommand, hashExecutionConfig,
  hashExecutionPlan, sha256,
} from '../src/policy/execution-policy.js';

const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-docker.sock', serverVersion: '29.4.3',
  imageId: `sha256:${'a'.repeat(64)}`, nodeVersion: '24.22.2',
};
const context = () => ({ ownerId: `os-user:${process.getuid?.()}`, now: new Date() });

const removeSyntheticDirectory = async (path: string): Promise<void> => {
  const fs = await import('node:fs/promises');
  const thaw = async (entry: string): Promise<void> => {
    const metadata = await fs.lstat(entry);
    if (metadata.isDirectory()) {
      await chmod(entry, 0o700);
      for (const name of await fs.readdir(entry)) await thaw(join(entry, name));
    }
  };
  await thaw(path); await rm(path, { recursive: true, force: true });
};

const setup = async (t: TestContext, changes: Partial<ExecutionCommandResult> = {}, preflightFailure = false) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-execution-workflow-')));
  await chmod(directory, 0o700);
  const sourceDirectory = join(directory, 'task');
  await mkdir(sourceDirectory, { mode: 0o700 });
  const store = new SqliteExecutionStore(join(directory, 'execution.sqlite'));
  const calls: string[] = [];
  const backend: IsolatedExecutionPort = {
    preflight: async () => { calls.push('preflight'); if (preflightFailure) throw new Error('private daemon failure'); },
    execute: async (command) => {
      calls.push(command.commandId);
      return {
        commandId: command.commandId, containerName: 'synthetic-container', termination: 'completed', exitCode: 0,
        stopped: true, removed: true, oomKilled: false, outputBytes: 0, outputHash: sha256(''), failureCode: null, ...changes,
      };
    },
  };
  const workspace = new SyntheticExecutionWorkspace();
  const service = new SyntheticExecutionService(store, workspace, backend, config, { platform: 'darwin', architecture: 'arm64' });
  const task = await service.plan(randomUUID(), sourceDirectory, 'success');
  const request = { taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit };
  const artifactDirectory = join(directory, 'run');
  await mkdir(artifactDirectory, { mode: 0o700 });
  t.after(async () => {
    store.close();
    await removeSyntheticDirectory(directory);
  });
  return { directory, store, service, workspace, task, request, artifactDirectory, calls };
};

test('실행 계획은 patch·명령·격리 정책을 해시에 묶고 읽기 근거와 허용 범위를 분리한다', async (t) => {
  const { task, calls } = await setup(t);
  assertExecutionPlan(task.plan);
  assert.deepEqual(task.plan.allowedFiles, ['src/message.mjs']);
  assert.deepEqual(task.plan.commands, [getExecutionCommand('synthetic-check-v1')]);
  assert.equal(task.status, 'AWAITING_APPROVAL');
  assert.deepEqual(calls, []);
  const reordered = Object.fromEntries(Object.entries(config).reverse()) as unknown as SandboxConfig;
  assert.equal(hashExecutionConfig(config), hashExecutionConfig(reordered));
  assert.deepEqual(createExecutionPolicy(config), task.plan.policy);
  for (const mutate of [
    (plan: ExecutionPlan) => { plan.patches[0]!.content += '// changed'; },
    (plan: ExecutionPlan) => { plan.allowedFiles.push('README.md'); },
    (plan: ExecutionPlan) => { plan.commands[0]!.argv.push('--eval', 'arbitrary'); },
    (plan: ExecutionPlan) => { plan.commands[0]!.cwd = '/tmp' as '/workspace'; },
    (plan: ExecutionPlan) => { plan.policy.limits = { ...plan.policy.limits, scratchBytes: 1 } as typeof plan.policy.limits; },
    (plan: ExecutionPlan) => { plan.patches[0]!.path = '../escape'; },
  ]) {
    const changed = structuredClone(task.plan); mutate(changed);
    assert.throws(() => assertExecutionPlan(changed));
  }
  assert.throws(() => assertExecutionConfig(task.plan, { ...config, enabled: false }), { code: 'EXECUTION_POLICY_CHANGED' });
  assert.throws(() => assertExecutionConfig(task.plan, { ...config, imageId: `sha256:${'b'.repeat(64)}` }), { code: 'EXECUTION_POLICY_CHANGED' });
  const changed = structuredClone(task.plan);
  changed.policy.nodeVersion = '24.22.3'; changed.planHash = hashExecutionPlan(changed);
  assert.throws(() => assertExecutionConfig(changed, config), { code: 'EXECUTION_POLICY_CHANGED' });
});

test('승인 전에는 Docker 호출과 원본·별도 작업트리 변경 및 Run 생성이 없다', async (t) => {
  const { service, task, request, store, artifactDirectory, calls } = await setup(t);
  const before = await hashRepository(task.sourceRoot);
  await assert.rejects(service.run(request, context(), artifactDirectory), { code: 'APPROVAL_REQUIRED' });
  assert.equal(await hashRepository(task.sourceRoot), before);
  assert.deepEqual(store.listRuns(task.taskId), []);
  assert.deepEqual(calls, []);
});

test('새 승인으로 합성 patch와 등록 검사만 한 번 실행하고 원본·독립 Git과 결과를 보존한다', async (t) => {
  const { service, task, request, store, artifactDirectory, calls } = await setup(t);
  const approval = await service.approve({ ...request, expiresInMinutes: 30 }, context());
  const before = await hashRepository(task.sourceRoot);
  const run = await service.run(request, context(), artifactDirectory);
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.approvalId, approval.approvalId);
  assert.ok(store.listApprovals(task.taskId)[0]?.usedAt);
  assert.equal(store.find(task.taskId)?.status, 'SUCCEEDED');
  assert.equal(run.diff.length, 1);
  assert.equal(run.diff[0]?.path, 'src/message.mjs');
  assert.equal(run.sourceBeforeHash, before);
  assert.equal(run.sourceAfterHash, before);
  assert.equal(await hashRepository(task.sourceRoot), before);
  assert.deepEqual(calls, ['preflight', 'synthetic-check-v1']);
  assert.ok(run.checks.every((check) => check.status === 'passed'));
  await assert.rejects(service.run(request, context(), artifactDirectory), { code: 'APPROVAL_REQUIRED' });
  assert.equal(store.listRuns(task.taskId).length, 1);
});

test('검사 실패·미종료·출력 및 시간 초과는 실패 Run이며 승인과 잔여 diff를 보존한다', async (t) => {
  for (const changes of [
    { exitCode: 1 }, { termination: 'timeout' as const, exitCode: 137 },
    { termination: 'output_limit' as const, exitCode: 137 }, { stopped: false }, { removed: false },
    { failureCode: 'SYNTHETIC_FAILURE' }, { oomKilled: true }, { commandId: 'synthetic-timeout-v1' as const },
  ]) {
    const { service, request, store, task, artifactDirectory } = await setup(t, changes);
    await service.approve({ ...request, expiresInMinutes: 30 }, context());
    const run = await service.run(request, context(), artifactDirectory);
    assert.equal(run.status, changes.stopped === false || changes.removed === false ? 'BLOCKED' : 'FAILED');
    assert.ok(run.diff.length);
    assert.equal(run.checks.find((check) => check.name === 'synthetic-check-v1')?.status, 'failed');
    assert.ok(store.listApprovals(task.taskId)[0]?.usedAt);
    assert.equal(store.findRun(run.runId)?.status, run.status);
    await assert.rejects(service.run(request, context(), artifactDirectory));
  }
});

test('준비 실패·정책 변경·원본 변경·취소는 승인 소비와 patch 이전에 거부한다', async (t) => {
  const { service, request, store, task, artifactDirectory, calls } = await setup(t, {}, true);
  await service.approve({ ...request, expiresInMinutes: 30 }, context());
  await assert.rejects(service.run(request, context(), artifactDirectory));
  assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, null);
  assert.deepEqual(store.listRuns(task.taskId), []);
  assert.deepEqual(calls, ['preflight']);
  await assert.rejects(service.run({ ...request, planHash: 'b'.repeat(64) }, context(), artifactDirectory), { code: 'EXECUTION_CONTEXT_MISMATCH' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.run(request, context(), artifactDirectory, controller.signal), { code: 'EXECUTION_ABORTED' });
  const file = join(task.sourceRoot, 'src/message.mjs');
  await chmod(file, 0o644); await writeFile(file, 'tampered');
  await assert.rejects(service.run(request, context(), artifactDirectory));
  assert.equal(store.listApprovals(task.taskId)[0]?.usedAt, null);
});

test('승인 소비 뒤 작업트리 준비가 실패하면 검사는 not_run이며 소비 승인과 실패 Run이 남는다', async (t) => {
  const { service, workspace, request, store, task, artifactDirectory, calls } = await setup(t);
  await service.approve({ ...request, expiresInMinutes: 30 }, context());
  workspace.materialize = async () => { throw new Error('synthetic I/O failure'); };
  const run = await service.run(request, context(), artifactDirectory);
  assert.equal(run.status, 'FAILED');
  assert.deepEqual(run.commands, []);
  assert.equal(run.checks.find((check) => check.name === 'synthetic-check-v1')?.status, 'not_run');
  assert.ok(store.listApprovals(task.taskId)[0]?.usedAt);
  assert.equal(store.findRun(run.runId)?.status, 'FAILED');
  assert.deepEqual(calls, ['preflight']);
});

const cli = (arguments_: string[], directory: string) => spawnSync(process.execPath, [
  'dist/src/cli/main.js', ...arguments_, '--data-dir', directory,
], { encoding: 'utf8', timeout: 20_000, maxBuffer: 256_000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });

test('오프라인 CLI는 계획·새 승인·재시작 조회를 제공하고 승인 전 실행과 정책 바꿔치기를 거부한다', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-execution-cli-')));
  await chmod(directory, 0o700);
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const dataDirectory = join(directory, 'data');
  t.after(() => removeSyntheticDirectory(directory));
  const planned = cli(['execution-plan', '--config', configPath], dataDirectory);
  assert.equal(planned.status, 0, planned.stderr);
  const { task } = JSON.parse(planned.stdout);
  const request = ['--task', task.taskId, '--plan-hash', task.plan.planHash, '--base-commit', task.baseCommit];
  const before = await hashRepository(task.sourceRoot);
  const unapproved = cli(['execution-run', ...request, '--config', configPath], dataDirectory);
  assert.equal(unapproved.status, 1); assert.match(unapproved.stderr, /^APPROVAL_REQUIRED/m);
  const approved = cli(['execution-approve', ...request, '--expires-in-minutes', '30', '--config', configPath], dataDirectory);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).approval.usedAt, null);
  const changedPath = join(directory, 'changed.json');
  await writeFile(changedPath, JSON.stringify({ ...config, socketPath: '/private/tmp/changed.sock' }), { mode: 0o600 });
  const changed = cli(['execution-run', ...request, '--config', changedPath], dataDirectory);
  assert.equal(changed.status, 1); assert.match(changed.stderr, /^EXECUTION_POLICY_CHANGED/m);
  const inspected = cli(['execution-inspect', '--task', task.taskId], dataDirectory);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).task.status, 'APPROVED');
  assert.equal(JSON.parse(inspected.stdout).approvals[0].usedAt, null);
  assert.deepEqual(JSON.parse(inspected.stdout).runs, []);
  assert.equal(await hashRepository(task.sourceRoot), before);
  const invalid = cli(['execution-plan', '--command', 'sh'], dataDirectory);
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /^INVALID_ARGUMENTS/m);
  const disabledPlan = cli(['execution-plan'], dataDirectory);
  assert.equal(disabledPlan.status, 0, disabledPlan.stderr);
  const disabledTask = JSON.parse(disabledPlan.stdout).task;
  const disabledRequest = ['--task', disabledTask.taskId, '--plan-hash', disabledTask.plan.planHash, '--base-commit', disabledTask.baseCommit];
  const disabledApproval = cli(['execution-approve', ...disabledRequest, '--expires-in-minutes', '30'], dataDirectory);
  assert.equal(disabledApproval.status, 1); assert.match(disabledApproval.stderr, /^EXECUTION_POLICY_CHANGED/m);
  const disabledRun = cli(['execution-run', ...disabledRequest], dataDirectory);
  assert.equal(disabledRun.status, 1); assert.match(disabledRun.stderr, /^EXECUTION_POLICY_CHANGED/m);
  assert.equal((await readFile(join(directory, 'config.json'), 'utf8')), JSON.stringify(config));
});

test('실시간 수신과 같은 lease가 있으면 실행 CLI는 새 계획이나 실행 자료를 생성하지 않는다', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-execution-lease-')));
  await chmod(directory, 0o700);
  t.after(() => removeSyntheticDirectory(directory));
  const release = acquireRuntimeLease(directory);
  try {
    const result = cli(['execution-plan'], directory);
    assert.equal(result.status, 1); assert.match(result.stderr, /^HARNESS_ALREADY_RUNNING/m);
    const fs = await import('node:fs/promises');
    await assert.rejects(fs.lstat(join(directory, 'executions')), { code: 'ENOENT' });
  } finally { release(); }
});

test('실행 보고서는 DB에서 재생성하고 기존 보고서 링크를 따라가거나 외부 파일을 덮어쓰지 않는다', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-execution-report-')));
  await chmod(directory, 0o700);
  t.after(() => removeSyntheticDirectory(directory));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const data = join(directory, 'data');
  const planned = cli(['execution-plan', '--config', configPath], data);
  assert.equal(planned.status, 0, planned.stderr);
  const { task } = JSON.parse(planned.stdout);
  const artifactDirectory = join(data, 'executions', task.taskId, `run-${randomUUID()}`);
  await mkdir(artifactDirectory, { mode: 0o700 });
  const store = new SqliteExecutionStore(join(data, 'execution.sqlite'));
  const request = { taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit };
  store.approve({ ...request, expiresInMinutes: 30 }, context());
  const run = store.beginRun(request, context(), artifactDirectory);
  run.status = 'FAILED'; run.finishedAt = new Date().toISOString(); run.failureCode = 'SYNTHETIC_REPORT_FAILURE';
  store.finishRun(run); store.close();
  const inspect = () => cli(['execution-inspect', '--task', task.taskId], data);
  const recreated = inspect(); assert.equal(recreated.status, 0, recreated.stderr);
  const reportPath = join(artifactDirectory, 'report.json');
  assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).runId, run.runId);
  const fs = await import('node:fs/promises');
  await fs.unlink(reportPath);
  const outside = join(directory, 'outside.txt'); await writeFile(outside, 'synthetic unchanged', { mode: 0o600 });
  await fs.symlink(outside, reportPath);
  const linked = inspect(); assert.equal(linked.status, 1); assert.match(linked.stderr, /^UNSAFE_EXECUTION_REPORT/m);
  assert.equal(await readFile(outside, 'utf8'), 'synthetic unchanged');
  await fs.unlink(reportPath);
  const recovered = inspect(); assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).runs[0].status, 'FAILED');
});
