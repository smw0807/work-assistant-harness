import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as gitFileSystem from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import git from 'isomorphic-git';
import { SyntheticExecutionWorkspace } from '../src/adapters/execution-workspace.js';
import { hashRepository } from '../src/adapters/demo-repository.js';
import type { BranchWorkType } from '../src/domain/branch.js';
import { BRANCH_EXECUTION_POLICY_VERSION, type ExecutionPlan, type ExecutionTask } from '../src/domain/execution.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import { createExecutionPolicy, getExecutionCommand, hashExecutionPlan } from '../src/policy/execution-policy.js';

const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-branch-execution.sock', serverVersion: '29.4.3',
  imageId: `sha256:${'a'.repeat(64)}`, nodeVersion: '24.22.2',
};
const makeWritable = async (path: string): Promise<void> => {
  const metadata = await fileSystem.lstat(path);
  if (metadata.isSymbolicLink()) return;
  await fileSystem.chmod(path, metadata.isDirectory() ? 0o700 : 0o600);
  if (metadata.isDirectory()) for (const name of await fileSystem.readdir(path)) await makeWritable(join(path, name));
};
const prepare = async (context: TestContext, workType: BranchWorkType = 'feature') => {
  const directory = await fileSystem.realpath(await fileSystem.mkdtemp(join(tmpdir(), 'branch-execution-workspace-')));
  context.after(async () => {
    await makeWritable(directory);
    await fileSystem.rm(directory, { recursive: true, force: true });
  });
  const taskId = randomUUID();
  const taskRoot = join(directory, 'branch-executions', taskId);
  await fileSystem.mkdir(join(directory, 'branch-executions'), { mode: 0o700 });
  await fileSystem.mkdir(taskRoot, { mode: 0o700 });
  const adapter = new SyntheticExecutionWorkspace();
  const source = await adapter.prepare(taskRoot, 'success');
  const name = `${workType}/task-${taskId}`;
  const createdAt = '2026-11-12T00:00:00.000Z';
  const content: Omit<ExecutionPlan, 'planHash'> = {
    planId: randomUUID(), version: 1, taskId, requestRevision: 'synthetic-1', repoId: 'synthetic-branch-execution',
    baseCommit: source.baseCommit, sourceHash: source.sourceHash, allowedFiles: ['src/message.mjs'],
    patches: source.patches, commands: source.commandIds.map(getExecutionCommand),
    policy: createExecutionPolicy(config, BRANCH_EXECUTION_POLICY_VERSION),
    branch: {
      workType, name, baseBranch: 'main', headRef: `refs/heads/${name}`, ownerId: `os-user:${process.getuid!()}`,
      sourceRoot: source.sourceRoot, createdAt, expiresAt: '2026-11-13T00:00:00.000Z',
    },
  };
  const task: ExecutionTask = {
    taskId, status: 'AWAITING_APPROVAL', requestRevision: content.requestRevision, baseCommit: source.baseCommit,
    sourceRoot: source.sourceRoot, createdAt, updatedAt: createdAt,
    plan: { ...content, planHash: hashExecutionPlan(content) },
  };
  const artifactDirectory = join(taskRoot, 'run');
  await fileSystem.mkdir(artifactDirectory, { mode: 0o700 });
  return { adapter, task, source, directory, taskRoot, artifactDirectory };
};
const rehash = (plan: ExecutionPlan): ExecutionPlan => ({ ...plan, planHash: hashExecutionPlan(plan) });

test('four approved branch types select an independent Git HEAD before the fixed patch and preserve all Git evidence', async (context) => {
  for (const workType of ['feature', 'fix', 'chore', 'refactor'] as const) {
    const { adapter, task, source, artifactDirectory } = await prepare(context, workType);
    assert.equal(await fileSystem.readFile(join(source.sourceRoot, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
    await assert.rejects(fileSystem.lstat(join(source.sourceRoot, '.git', task.plan.branch!.headRef)), { code: 'ENOENT' });
    const workspace = await adapter.materialize(task, artifactDirectory);
    assert.equal(await git.currentBranch({ fs: gitFileSystem, dir: workspace.worktreeRoot }), task.plan.branch!.name);
    for (const ref of ['HEAD', 'main', task.plan.branch!.headRef]) {
      assert.equal(await git.resolveRef({ fs: gitFileSystem, dir: workspace.worktreeRoot, ref }), source.baseCommit);
    }
    const objectPath = `.git/objects/${source.baseCommit.slice(0, 2)}/${source.baseCommit.slice(2)}`;
    const sourceObject = await fileSystem.stat(join(source.sourceRoot, objectPath));
    const workspaceObject = await fileSystem.stat(join(workspace.worktreeRoot, objectPath));
    assert.notEqual(sourceObject.ino, workspaceObject.ino);
    assert.equal(sourceObject.nlink, 1);
    assert.equal(workspaceObject.nlink, 1);
    const initialEvidence = await adapter.evidence(task.plan, workspace);
    assert.equal(initialEvidence.gitHash, await hashRepository(join(workspace.worktreeRoot, '.git')));
    const before = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, initialEvidence);
    assert.equal(before.status, 'passed');
    assert.equal(before.reason, 'EXECUTION_PATCH_NOT_APPLIED');
    await adapter.apply(task.plan, workspace);
    const view = await adapter.createContainerView(task.plan, workspace);
    const evidence = await adapter.evidence(task.plan, workspace);
    assert.equal(evidence.gitHash, initialEvidence.gitHash);
    assert.equal((await adapter.inspectDiff(task.plan, workspace)).length, 1);
    await assert.rejects(fileSystem.lstat(join(view, '.git')), { code: 'ENOENT' });
    assert.equal((await fileSystem.stat(join(view, 'src/message.mjs'))).mode & 0o7777, 0o444);
    const observed = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, structuredClone(evidence));
    assert.equal(observed.status, 'passed');
    assert.equal(observed.gitUnchanged, true);
    assert.equal(observed.viewUnchanged, true);
    assert.deepEqual(observed.changes.map(({ path, inScope }) => ({ path, inScope })), [{ path: 'src/message.mjs', inScope: true }]);
    assert.equal(await adapter.verifySource(task), source.sourceHash);
    assert.equal(await hashRepository(source.sourceRoot), source.sourceHash);
  }
});

test('source identity rejects another owner, source binding and unsafe private parents before materialization', async (context) => {
  for (const change of ['owner', 'source', 'parent-mode', 'parent-link'] as const) {
    const { adapter, task, directory, taskRoot, artifactDirectory } = await prepare(context);
    if (change === 'owner') task.plan = rehash({ ...task.plan, branch: { ...task.plan.branch!, ownerId: `os-user:${process.getuid!() + 1}` } });
    else if (change === 'source') task.sourceRoot = join(directory, 'other-source');
    else if (change === 'parent-mode') await fileSystem.chmod(taskRoot, 0o755);
    else {
      const realRoot = `${taskRoot}-retained`;
      await fileSystem.rename(taskRoot, realRoot);
      await fileSystem.symlink(realRoot, taskRoot);
    }
    await assert.rejects(adapter.materialize(task, artifactDirectory));
    await assert.rejects(fileSystem.lstat(join(artifactDirectory, 'worktree')), { code: 'ENOENT' });
  }
});

test('source main, HEAD, objects and unexpected Git files cannot become a new accepted baseline', async (context) => {
  for (const change of ['main', 'head', 'object', 'secret'] as const) {
    const { adapter, task, source, artifactDirectory } = await prepare(context);
    const gitRoot = join(source.sourceRoot, '.git');
    const path = change === 'main' ? join(gitRoot, 'refs/heads/main') : change === 'head' ? join(gitRoot, 'HEAD')
      : change === 'object' ? join(gitRoot, 'objects', `${source.baseCommit.slice(0, 2)}/${source.baseCommit.slice(2)}`)
        : join(gitRoot, 'unexpected-sensitive-name');
    if (change === 'secret') await fileSystem.chmod(gitRoot, 0o700);
    else await fileSystem.chmod(path, 0o600);
    await fileSystem.writeFile(path, change === 'main' ? `${'a'.repeat(40)}\n` : change === 'head' ? `${source.baseCommit}\n` : 'SYNTHETIC_PRIVATE_BODY', { mode: 0o444 });
    await fileSystem.chmod(path, 0o444);
    if (change === 'secret') await fileSystem.chmod(gitRoot, 0o555);
    await assert.rejects(adapter.materialize(task, artifactDirectory), (error: unknown) => {
      assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE_BODY|unexpected-sensitive-name/);
      return true;
    });
    await assert.rejects(fileSystem.lstat(join(artifactDirectory, 'worktree')), { code: 'ENOENT' });
  }
});

test('existing same-OID branch collision is preserved without HEAD selection, patching or evidence', async (context) => {
  const { adapter, task, source, artifactDirectory } = await prepare(context);
  const commit = git.commit;
  context.mock.method(git, 'commit', async (options: Parameters<typeof git.commit>[0]) => {
    const result = await commit(options);
    const gitRoot = join(options.dir!, '.git');
    await fileSystem.mkdir(join(gitRoot, 'refs/heads', task.plan.branch!.workType), { mode: 0o700 });
    await fileSystem.writeFile(join(gitRoot, task.plan.branch!.headRef), `${result}\n`, { flag: 'wx', mode: 0o600 });
    return result;
  });
  await assert.rejects(adapter.materialize(task, artifactDirectory));
  const worktreeRoot = join(artifactDirectory, 'worktree');
  assert.equal(await fileSystem.readFile(join(worktreeRoot, '.git', task.plan.branch!.headRef), 'utf8'), `${source.baseCommit}\n`);
  assert.equal(await fileSystem.readFile(join(worktreeRoot, '.git/HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  assert.equal(await fileSystem.readFile(join(worktreeRoot, 'src/message.mjs'), 'utf8'), "export const message = 'before';\n");
  const before = await hashRepository(worktreeRoot);
  const observed = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, null);
  assert.equal(observed.status, 'failed');
  assert.equal(observed.reason, 'EXECUTION_WORKSPACE_EVIDENCE_MISSING');
  assert.equal(await hashRepository(worktreeRoot), before);
});

test('HEAD, main, selected branch, objects and unapproved metadata mutations block patching and restart observation', async (context) => {
  for (const change of ['head', 'main', 'branch', 'object', 'secret', 'mode', 'symlink', 'hardlink'] as const) {
    const { adapter, task, directory, artifactDirectory } = await prepare(context);
    const workspace = await adapter.materialize(task, artifactDirectory);
    const evidence = await adapter.evidence(task.plan, workspace);
    const gitRoot = join(workspace.worktreeRoot, '.git');
    const refPath = join(gitRoot, task.plan.branch!.headRef);
    if (change === 'head') await fileSystem.writeFile(join(gitRoot, 'HEAD'), 'ref: refs/heads/main\n');
    else if (change === 'main') await fileSystem.writeFile(join(gitRoot, 'refs/heads/main'), `${'a'.repeat(40)}\n`);
    else if (change === 'branch') await fileSystem.writeFile(refPath, `${'a'.repeat(40)}\n`);
    else if (change === 'object') await fileSystem.appendFile(join(gitRoot, 'objects', `${task.baseCommit.slice(0, 2)}/${task.baseCommit.slice(2)}`), 'unapproved');
    else if (change === 'secret') await fileSystem.writeFile(join(gitRoot, 'hooks/private-sensitive-name'), 'SYNTHETIC_PRIVATE_BODY', { mode: 0o600 });
    else if (change === 'mode') await fileSystem.chmod(refPath, 0o644);
    else {
      const outside = join(directory, 'outside-ref');
      await fileSystem.writeFile(outside, `${task.baseCommit}\n`, { mode: 0o600 });
      await fileSystem.unlink(refPath);
      if (change === 'symlink') await fileSystem.symlink(outside, refPath);
      else await fileSystem.link(outside, refPath);
    }
    const before = await hashRepository(workspace.worktreeRoot);
    await assert.rejects(adapter.apply(task.plan, workspace));
    const observed = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, evidence);
    assert.equal(observed.status, 'failed');
    assert.equal(observed.gitUnchanged, false);
    assert.doesNotMatch(JSON.stringify(observed), /SYNTHETIC_PRIVATE_BODY|private-sensitive-name|outside-ref/);
    assert.equal(await hashRepository(workspace.worktreeRoot), before);
  }
});

test('even matching forged Git evidence cannot authorize a different symbolic HEAD or selected branch OID', async (context) => {
  for (const change of ['head', 'branch'] as const) {
    const { adapter, task, artifactDirectory } = await prepare(context);
    const workspace = await adapter.materialize(task, artifactDirectory);
    const evidence = await adapter.evidence(task.plan, workspace);
    const gitRoot = join(workspace.worktreeRoot, '.git');
    await fileSystem.writeFile(join(gitRoot, change === 'head' ? 'HEAD' : task.plan.branch!.headRef),
      change === 'head' ? 'ref: refs/heads/main\n' : `${'a'.repeat(40)}\n`);
    evidence.gitHash = await hashRepository(gitRoot);
    const observed = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, evidence);
    assert.equal(observed.status, 'failed');
    assert.equal(observed.gitUnchanged, false);
  }
});

test('missing initial evidence and interrupted branch creation remain blocked and are never repaired', async (context) => {
  for (const partial of ['selected', 'empty-type', 'partial-ref', 'partial-head'] as const) {
    const { adapter, task, artifactDirectory } = await prepare(context);
    const workspace = await adapter.materialize(task, artifactDirectory);
    const gitRoot = join(workspace.worktreeRoot, '.git');
    if (partial === 'empty-type') {
      await fileSystem.unlink(join(gitRoot, task.plan.branch!.headRef));
      await fileSystem.writeFile(join(gitRoot, 'HEAD'), 'ref: refs/heads/main\n');
    } else if (partial === 'partial-ref') await fileSystem.writeFile(join(gitRoot, task.plan.branch!.headRef), 'partial');
    else if (partial === 'partial-head') await fileSystem.writeFile(join(gitRoot, 'HEAD'), 'ref: refs/heads/');
    const before = await hashRepository(workspace.worktreeRoot);
    const observation = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, null);
    assert.equal(observation.status, 'failed');
    assert.equal(observation.reason, 'EXECUTION_WORKSPACE_EVIDENCE_MISSING');
    assert.equal(await hashRepository(workspace.worktreeRoot), before);
    await assert.rejects(adapter.materialize(task, artifactDirectory), { code: 'EXECUTION_WORKSPACE_PREPARATION_FAILED' });
    assert.equal(await hashRepository(workspace.worktreeRoot), before);
  }
});
