import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { hashRepository } from '../src/adapters/demo-repository.js';
import { DockerIsolatedExecution } from '../src/adapters/docker-execution.js';
import type { DockerSandboxFileSystem } from '../src/adapters/docker-sandbox.js';
import { SyntheticExecutionWorkspace } from '../src/adapters/execution-workspace.js';
import { SqliteExecutionStore } from '../src/adapters/sqlite-execution-store.js';
import { SyntheticExecutionService, type ExecutionServiceObserver } from '../src/application/execute-synthetic.js';
import type { BranchWorkType } from '../src/domain/branch.js';
import {
  BRANCH_EXECUTION_POLICY_VERSION, CODEX_EXECUTION_POLICY_VERSION, EXECUTION_POLICY_VERSION,
  type ExecutionCommandResult, type ExecutionPlan, type ExecutionPolicyVersion, type ExecutionProposalMetadata,
  type ExecutionTask, type IsolatedExecutionPort,
} from '../src/domain/execution.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import { assertExecutionPlan, createExecutionPolicy, hashExecutionPlan, sha256 } from '../src/policy/execution-policy.js';

const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-codex-execution.sock', serverVersion: '29.4.3',
  imageId: `sha256:${'c'.repeat(64)}`, nodeVersion: '24.22.2',
};
const proposedContent = "const parts = ['ap', 'proved'];\nexport const message = parts.join('');\n";
const beforeContent = "export const message = 'before';\n";
const context = () => ({ ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
const proposalMetadata = (): ExecutionProposalMetadata => ({
  proposalId: randomUUID(), inputHash: 'a'.repeat(64), responseHash: 'b'.repeat(64), configHash: 'c'.repeat(64),
  validatorVersion: 'codex-proposal-v1',
});
const requestFor = (task: ExecutionTask) => ({ taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit });
const rehash = (plan: ExecutionPlan): void => { plan.planHash = hashExecutionPlan(plan); };
const removeFixture = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await removeFixture(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
};

const setup = async (t: TestContext, version: ExecutionPolicyVersion = CODEX_EXECUTION_POLICY_VERSION) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-codex-execution-')));
  await chmod(directory, 0o700);
  const taskId = randomUUID();
  const profile = version === CODEX_EXECUTION_POLICY_VERSION ? 'codex-executions'
    : version === BRANCH_EXECUTION_POLICY_VERSION ? 'branch-executions' : 'executions';
  const taskDirectory = join(directory, profile, taskId);
  await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
  const database = join(directory, 'execution.sqlite');
  const store = new SqliteExecutionStore(database, version);
  t.after(async () => { store.close(); await removeFixture(directory); });
  const workspace = new SyntheticExecutionWorkspace();
  const calls = { preflight: 0, execute: 0 };
  const backend: IsolatedExecutionPort = {
    preflight: async (_config, policy) => { assert.equal(policy.version, version); calls.preflight += 1; },
    execute: async (command, root, _signal, hooks) => {
      calls.execute += 1;
      assert.equal(command.commandId, 'synthetic-check-v1');
      await assert.rejects(lstat(join(root, '.git')), { code: 'ENOENT' });
      assert.equal((await lstat(join(root, 'src/message.mjs'))).mode & 0o777, 0o444);
      assert.ok(hooks);
      const token = randomUUID();
      const intent = { runId: hooks.runId, name: `harness-execution-${token}`, token, id: null, commandId: command.commandId };
      await hooks.beforeCreate(intent);
      await hooks.created({ ...intent, id: 'd'.repeat(64) });
      await hooks.beforeStart();
      const result: ExecutionCommandResult = {
        commandId: command.commandId, containerName: intent.name, termination: 'completed', exitCode: 0,
        stopped: true, removed: true, oomKilled: false, outputBytes: 0, outputHash: sha256(''), failureCode: null,
      };
      await hooks.finished(result);
      return result;
    },
  };
  const service = (observer: ExecutionServiceObserver = {}) => new SyntheticExecutionService(
    store, workspace, backend, config, { platform: 'darwin', architecture: 'arm64' }, observer, version,
  );
  const plan = (workType: BranchWorkType = 'feature') => version === CODEX_EXECUTION_POLICY_VERSION
    ? service().planProposal(taskId, taskDirectory, workType, proposedContent, proposalMetadata())
    : service().plan(taskId, taskDirectory, 'success', version === BRANCH_EXECUTION_POLICY_VERSION ? workType : undefined);
  const artifact = join(taskDirectory, 'run');
  return { directory, database, taskId, taskDirectory, artifact, store, workspace, calls, service, plan };
};

test('네 유형의 Codex 제안은 별도 승인 뒤 비고정 내용만 적용하고 source·main·Git 없는 검사 view를 보존한다', async (t) => {
  for (const workType of ['feature', 'fix', 'chore', 'refactor'] as const) {
    const fixture = await setup(t);
    const task = await fixture.plan(workType);
    assert.equal(task.status, 'AWAITING_APPROVAL');
    assert.equal(task.plan.repoId, 'synthetic-codex-execution');
    assert.equal(task.plan.policy.version, CODEX_EXECUTION_POLICY_VERSION);
    assert.equal(task.plan.patches[0]!.content, proposedContent);
    assert.equal(await readFile(join(task.sourceRoot, 'src/message.mjs'), 'utf8'), beforeContent);
    await assert.rejects(lstat(join(task.sourceRoot, '.git', task.plan.branch!.headRef)), { code: 'ENOENT' });
    assert.deepEqual(fixture.calls, { preflight: 0, execute: 0 });
    await mkdir(fixture.artifact, { mode: 0o700 });
    await assert.rejects(fixture.service().run(requestFor(task), context(), fixture.artifact), { code: 'APPROVAL_REQUIRED' });
    assert.deepEqual(fixture.calls, { preflight: 0, execute: 0 });
    const approval = await fixture.service().approve({ ...requestFor(task), expiresInMinutes: 30 }, context());
    assert.deepEqual(approval.planSnapshot.proposal, task.plan.proposal);
    const run = await fixture.service().run(requestFor(task), context(), fixture.artifact);
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(run.diff[0]?.after, proposedContent);
    assert.equal(run.observation?.gitUnchanged, true);
    assert.equal(run.sourceAfterHash, task.plan.sourceHash);
    assert.equal(await hashRepository(task.sourceRoot), task.plan.sourceHash);
    assert.equal(await readFile(join(run.worktreeRoot!, '.git/HEAD'), 'utf8'), `ref: ${task.plan.branch!.headRef}\n`);
    for (const ref of ['refs/heads/main', task.plan.branch!.headRef]) {
      assert.equal(await readFile(join(run.worktreeRoot!, '.git', ref), 'utf8'), `${task.baseCommit}\n`);
    }
    assert.equal(await readFile(join(fixture.artifact, 'container-view/src/message.mjs'), 'utf8'), proposedContent);
    assert.equal(fixture.calls.execute, 1);
    await assert.rejects(fixture.service().run(requestFor(task), context(), fixture.artifact), { code: 'APPROVAL_REQUIRED' });
  }
});

test('새 정책의 고정 plan과 기존 정책의 proposal 입력을 준비 전 거부한다', async (t) => {
  for (const version of [CODEX_EXECUTION_POLICY_VERSION, BRANCH_EXECUTION_POLICY_VERSION, EXECUTION_POLICY_VERSION] as const) {
    const fixture = await setup(t, version);
    if (version === CODEX_EXECUTION_POLICY_VERSION) {
      await assert.rejects(fixture.service().plan(fixture.taskId, fixture.taskDirectory, 'success', 'feature'),
        { code: 'EXECUTION_PROPOSAL_REQUIRED' });
    } else {
      await assert.rejects(fixture.service().planProposal(fixture.taskId, fixture.taskDirectory, 'feature', proposedContent, proposalMetadata()),
        { code: 'EXECUTION_POLICY_MISMATCH' });
    }
    assert.deepEqual(await readdir(fixture.taskDirectory), []);
    assert.equal(fixture.store.find(fixture.taskId), null);
  }
});

test('제안 본문의 악성 지시는 호스트에서 평가하지 않고 검증된 작업 파일에만 데이터로 쓴다', async (t) => {
  const fixture = await setup(t);
  const canary = join(fixture.directory, 'host-canary');
  await writeFile(canary, 'preserved', { mode: 0o600 });
  const content = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(canary)}, 'changed');\nexport const message = 'approved';\n`;
  const task = await fixture.service().planProposal(fixture.taskId, fixture.taskDirectory, 'chore', content, proposalMetadata());
  assert.equal(await readFile(canary, 'utf8'), 'preserved');
  await fixture.service().approve({ ...requestFor(task), expiresInMinutes: 30 }, context());
  await mkdir(fixture.artifact, { mode: 0o700 });
  const run = await fixture.service().run(requestFor(task), context(), fixture.artifact);
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.diff[0]?.after, content);
  assert.equal(await readFile(canary, 'utf8'), 'preserved');
  assert.equal(fixture.calls.execute, 1);
});

test('잘못된 proposal metadata·내용·작업 경로는 source 생성과 DB 기록 전에 거부한다', async (t) => {
  const fixture = await setup(t);
  for (const metadata of [null, [], {}, { ...proposalMetadata(), proposalId: '../other' },
    { ...proposalMetadata(), inputHash: 'bad' }, { ...proposalMetadata(), responseHash: null },
    { ...proposalMetadata(), configHash: 123 }, { ...proposalMetadata(), validatorVersion: 'other' },
    { ...proposalMetadata(), approved: true }, { ...proposalMetadata(), remote: 'ssh://company.invalid/repo' }]) {
    await assert.rejects(fixture.service().planProposal(fixture.taskId, fixture.taskDirectory, 'fix', proposedContent,
      metadata as unknown as ExecutionProposalMetadata), { code: 'INVALID_EXECUTION_PROPOSAL' });
  }
  for (const content of ['', beforeContent, `${proposedContent}\0`, '한'.repeat(2_731),
    "export const token = 'synthetic-private-token';\n"]) {
    await assert.rejects(fixture.service().planProposal(fixture.taskId, fixture.taskDirectory, 'fix', content, proposalMetadata()),
      { code: 'INVALID_EXECUTION_PATCH' });
  }
  await assert.rejects(fixture.service().planProposal(fixture.taskId, fixture.directory, 'fix', proposedContent, proposalMetadata()),
    { code: 'UNSAFE_EXECUTION_DIRECTORY' });
  await assert.rejects(fixture.service().planProposal('invalid', fixture.taskDirectory, 'fix', proposedContent, proposalMetadata()),
    { code: 'UNSAFE_EXECUTION_DIRECTORY' });
  assert.deepEqual(await readdir(fixture.taskDirectory), []);
  assert.equal(fixture.store.find(fixture.taskId), null);
});

test('proposal metadata는 키 순서와 무관한 해시에 결합되고 정책·경로·명령 혼용은 재해시해도 거부된다', async (t) => {
  const fixture = await setup(t);
  const task = await fixture.plan();
  const reordered = structuredClone(task.plan);
  reordered.proposal = Object.fromEntries(Object.entries(task.plan.proposal!).reverse()) as unknown as ExecutionProposalMetadata;
  assert.equal(hashExecutionPlan(reordered), task.plan.planHash);
  assertExecutionPlan(reordered);
  for (const key of ['proposalId', 'inputHash', 'responseHash', 'configHash'] as const) {
    const changed = structuredClone(task.plan);
    changed.proposal![key] = key === 'proposalId' ? randomUUID() : 'e'.repeat(64);
    assert.notEqual(hashExecutionPlan(changed), task.plan.planHash);
    assert.throws(() => assertExecutionPlan(changed), { code: 'PLAN_HASH_MISMATCH' });
  }
  for (const mutate of [
    (plan: ExecutionPlan) => { delete plan.proposal; },
    (plan: ExecutionPlan) => { delete plan.branch; },
    (plan: ExecutionPlan) => { Object.assign(plan.proposal!, { executionApproved: true }); },
    (plan: ExecutionPlan) => { plan.repoId = 'synthetic-branch-execution'; },
    (plan: ExecutionPlan) => { plan.policy.version = BRANCH_EXECUTION_POLICY_VERSION; },
    (plan: ExecutionPlan) => { plan.branch!.sourceRoot = plan.branch!.sourceRoot.replace('/codex-executions/', '/branch-executions/'); },
    (plan: ExecutionPlan) => { plan.patches[0]!.beforeHash = 'e'.repeat(64); },
    (plan: ExecutionPlan) => { plan.commands[0]!.argv.push('--eval', 'arbitrary'); },
    (plan: ExecutionPlan) => { plan.allowedFiles.push('.git/HEAD'); },
  ]) {
    const changed = structuredClone(task.plan); mutate(changed); rehash(changed);
    assert.throws(() => assertExecutionPlan(changed));
  }
});

test('기존 고정 patch profile은 제안 metadata와 비고정 내용을 허용하지 않는다', async (t) => {
  for (const version of [EXECUTION_POLICY_VERSION, BRANCH_EXECUTION_POLICY_VERSION] as const) {
    const fixture = await setup(t, version);
    const task = await fixture.plan();
    const withProposal = structuredClone(task.plan);
    withProposal.proposal = proposalMetadata(); rehash(withProposal);
    assert.throws(() => assertExecutionPlan(withProposal), { code: 'INVALID_EXECUTION_PLAN' });
    task.plan.patches[0]!.content = proposedContent;
    task.plan.patches[0]!.afterHash = sha256(proposedContent); rehash(task.plan);
    await mkdir(fixture.artifact, { mode: 0o700 });
    const workspace = await fixture.workspace.materialize(task, fixture.artifact);
    await assert.rejects(fixture.workspace.apply(task.plan, workspace), { code: 'INVALID_EXECUTION_PATCH' });
    assert.equal(await readFile(join(workspace.worktreeRoot, 'src/message.mjs'), 'utf8'), beforeContent);
  }
});

test('세 정책의 store는 계획·승인을 서로 읽거나 소비하지 않고 Codex TTL도 1~60분으로 제한한다', async (t) => {
  for (const version of [EXECUTION_POLICY_VERSION, BRANCH_EXECUTION_POLICY_VERSION, CODEX_EXECUTION_POLICY_VERSION] as const) {
    const fixture = await setup(t, version);
    const task = await fixture.plan();
    const request = requestFor(task);
    if (version === CODEX_EXECUTION_POLICY_VERSION) {
      for (const expiresInMinutes of [0, 1.5, 61, NaN]) {
        assert.throws(() => fixture.store.approve({ ...request, expiresInMinutes }, context()), { code: 'INVALID_EXECUTION_APPROVAL_REQUEST' });
      }
    }
    const approval = fixture.store.approve({ ...request, expiresInMinutes: 30 }, context());
    assert.equal(approval.executionPolicy, version);
    for (const other of [EXECUTION_POLICY_VERSION, BRANCH_EXECUTION_POLICY_VERSION, CODEX_EXECUTION_POLICY_VERSION]) {
      if (other === version) continue;
      const reader = new SqliteExecutionStore(fixture.database, other);
      try {
        assert.throws(() => reader.find(task.taskId), { code: 'EXECUTION_POLICY_MISMATCH' });
        assert.throws(() => reader.listApprovals(task.taskId), { code: 'INVALID_STORED_EXECUTION_APPROVAL' });
        assert.throws(() => reader.beginRun(request, context(), fixture.artifact), { code: 'EXECUTION_POLICY_MISMATCH' });
      } finally { reader.close(); }
    }
    assert.equal(fixture.store.listApprovals(task.taskId)[0]?.usedAt, null);
  }
});

test('승인 뒤 제안 hash 또는 내용이 바뀌면 새 계획 hash여도 snapshot 대조로 소비를 거부한다', async (t) => {
  for (const change of ['proposal', 'content'] as const) {
    const fixture = await setup(t);
    const task = await fixture.plan();
    fixture.store.approve({ ...requestFor(task), expiresInMinutes: 30 }, context());
    const changed = fixture.store.find(task.taskId)!;
    if (change === 'proposal') changed.plan.proposal!.responseHash = 'f'.repeat(64);
    else {
      changed.plan.patches[0]!.content += '// changed after approval\n';
      changed.plan.patches[0]!.afterHash = sha256(changed.plan.patches[0]!.content);
    }
    rehash(changed.plan);
    const database = new DatabaseSync(fixture.database);
    try { database.prepare('UPDATE execution_tasks SET payload = ? WHERE task_id = ?').run(JSON.stringify(changed), task.taskId); }
    finally { database.close(); }
    assert.throws(() => fixture.store.beginRun(requestFor(changed), context(), fixture.artifact), { code: 'APPROVAL_PLAN_MISMATCH' });
    assert.equal(fixture.store.listApprovals(task.taskId)[0]?.usedAt, null);
    assert.deepEqual(fixture.store.listRuns(task.taskId), []);
  }
});

test('Codex 제안의 patch 뒤 취소는 이후 검사를 막고 승인 소비·잔여 diff·선택 branch를 보존한다', async (t) => {
  const fixture = await setup(t);
  const task = await fixture.plan('fix');
  await fixture.service().approve({ ...requestFor(task), expiresInMinutes: 30 }, context());
  await mkdir(fixture.artifact, { mode: 0o700 });
  const run = await fixture.service({ checkpoint: async (phase) => {
    if (phase === 'patch_applied') fixture.store.control({ taskId: task.taskId, eventId: randomUUID(), kind: 'cancel', revision: 1 }, context());
  } }).run(requestFor(task), context(), fixture.artifact);
  assert.equal(run.status, 'CANCELLED');
  assert.equal(fixture.calls.execute, 0);
  assert.equal(run.diff[0]?.after, proposedContent);
  assert.equal(run.observation?.gitUnchanged, true);
  assert.ok(fixture.store.listApprovals(task.taskId)[0]?.usedAt);
  assert.equal(await hashRepository(task.sourceRoot), task.plan.sourceHash);
});

test('새 workspace 인스턴스의 중단 복구는 proposal diff와 Git 증거를 보존하며 자동 실행하지 않는다', async (t) => {
  const fixture = await setup(t);
  const task = await fixture.plan('refactor');
  fixture.store.approve({ ...requestFor(task), expiresInMinutes: 30 }, context());
  await mkdir(fixture.artifact, { mode: 0o700 });
  const run = fixture.store.beginRun(requestFor(task), context(), fixture.artifact);
  const workspace = await fixture.workspace.materialize(task, fixture.artifact);
  fixture.store.checkpoint(run.runId, 'workspace_ready', { worktreeRoot: workspace.worktreeRoot, workspace: await fixture.workspace.evidence(task.plan, workspace) });
  await fixture.workspace.apply(task.plan, workspace);
  fixture.store.checkpoint(run.runId, 'patch_applied', { diff: await fixture.workspace.inspectDiff(task.plan, workspace) });
  let backendCalls = 0;
  const recovery = new SyntheticExecutionService(fixture.store, new SyntheticExecutionWorkspace(), {
    preflight: async () => { backendCalls += 1; }, execute: async () => { throw new Error('unexpected execution'); },
  }, config, { platform: 'darwin', architecture: 'arm64' }, {}, CODEX_EXECUTION_POLICY_VERSION);
  const recovered = await recovery.recover(task.taskId, context());
  assert.equal(recovered?.status, 'INTERRUPTED');
  assert.equal(recovered?.diff[0]?.after, proposedContent);
  assert.equal(recovered?.observation?.gitUnchanged, true);
  assert.equal(backendCalls, 0);
  assert.deepEqual(await recovery.recover(task.taskId, context()), recovered);
  assert.throws(() => fixture.store.beginRun(requestFor(task), context(), fixture.artifact), { code: 'APPROVAL_ALREADY_USED' });
});

test('제안 실행에서도 HEAD 변조는 patch 전에 차단되고 복구가 ref를 수리하지 않는다', async (t) => {
  const fixture = await setup(t);
  const task = await fixture.plan();
  await mkdir(fixture.artifact, { mode: 0o700 });
  const workspace = await fixture.workspace.materialize(task, fixture.artifact);
  const evidence = await fixture.workspace.evidence(task.plan, workspace);
  await writeFile(join(workspace.worktreeRoot, '.git/HEAD'), 'ref: refs/heads/main\n');
  await assert.rejects(fixture.workspace.apply(task.plan, workspace), { code: 'EXECUTION_GIT_METADATA_CHANGED' });
  const observed = await new SyntheticExecutionWorkspace().observe(task, fixture.artifact, evidence);
  assert.equal(observed.status, 'failed');
  assert.equal(observed.gitUnchanged, false);
  assert.equal(await readFile(join(workspace.worktreeRoot, 'src/message.mjs'), 'utf8'), beforeContent);
  assert.equal(await readFile(join(workspace.worktreeRoot, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
});

test('Docker preflight도 세 정책을 양방향 분리하고 Codex 정책에 같은 격리 identity를 요구한다', async () => {
  let calls = 0;
  const fileSystem: DockerSandboxFileSystem = {
    canonical: async (path) => path, entries: async () => [],
    metadata: async (path) => ({ isSocket: () => path === config.socketPath, isDirectory: () => path !== config.socketPath,
      uid: process.getuid!(), mode: 0o700 }),
  };
  const runner = async (arguments_: string[]) => {
    calls += 1;
    const value = arguments_[4] === 'info' ? {
      ServerVersion: config.serverVersion, OSType: 'linux', Architecture: 'aarch64', CgroupVersion: '2',
      MemoryLimit: true, SwapLimit: true, PidsLimit: true, SecurityOptions: ['name=seccomp,profile=builtin'],
    } : [{ Id: config.imageId, Os: 'linux', Architecture: 'arm64', Config: {
      Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', `NODE_VERSION=${config.nodeVersion}`, 'YARN_VERSION=1.22.22'],
      Volumes: null, OnBuild: null,
    } }];
    return { termination: 'completed' as const, exitCode: 0, stdout: JSON.stringify(value) };
  };
  for (const version of [EXECUTION_POLICY_VERSION, BRANCH_EXECUTION_POLICY_VERSION, CODEX_EXECUTION_POLICY_VERSION] as const) {
    const docker = new DockerIsolatedExecution(config, '/private/tmp/codex-control', runner, fileSystem, version);
    for (const other of [EXECUTION_POLICY_VERSION, BRANCH_EXECUTION_POLICY_VERSION, CODEX_EXECUTION_POLICY_VERSION]) {
      if (other !== version) await assert.rejects(docker.preflight(config, createExecutionPolicy(config, other)), { code: 'EXECUTION_POLICY_MISMATCH' });
    }
  }
  assert.equal(calls, 0);
  const codex = new DockerIsolatedExecution(config, '/private/tmp/codex-control', runner, fileSystem, CODEX_EXECUTION_POLICY_VERSION);
  await codex.preflight(config, createExecutionPolicy(config, CODEX_EXECUTION_POLICY_VERSION));
  assert.equal(calls, 2);
});
