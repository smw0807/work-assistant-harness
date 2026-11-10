import assert from 'node:assert/strict';
import * as gitFileSystem from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import git from 'isomorphic-git';
import { SyntheticExecutionWorkspace } from '../src/adapters/execution-workspace.js';
import { hashRepository } from '../src/adapters/demo-repository.js';
import type { ExecutionFixture, ExecutionPlan, ExecutionTask } from '../src/domain/execution.js';
import { createExecutionPolicy, getExecutionCommand, hashExecutionPlan, sha256 } from '../src/policy/execution-policy.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';

const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-execution.sock', serverVersion: '29.4.3',
  imageId: `sha256:${'a'.repeat(64)}`, nodeVersion: '24.22.2',
};
const writableTree = async (path: string): Promise<void> => {
  const metadata = await fileSystem.lstat(path);
  if (metadata.isSymbolicLink()) return;
  await fileSystem.chmod(path, metadata.isDirectory() ? 0o700 : 0o600);
  if (metadata.isDirectory()) for (const name of await fileSystem.readdir(path)) await writableTree(join(path, name));
};
const prepare = async (context: TestContext, fixture: ExecutionFixture = 'success') => {
  const directory = await fileSystem.realpath(await fileSystem.mkdtemp(join(tmpdir(), 'execution-workspace-')));
  context.after(async () => {
    await writableTree(directory);
    await fileSystem.rm(directory, { recursive: true, force: true });
  });
  const adapter = new SyntheticExecutionWorkspace();
  const source = await adapter.prepare(directory, fixture);
  const content: Omit<ExecutionPlan, 'planHash'> = {
    planId: 'plan-1', version: 1, taskId: 'task-1', requestRevision: 'synthetic-1', repoId: 'synthetic-execution',
    baseCommit: source.baseCommit, sourceHash: source.sourceHash, allowedFiles: ['src/message.mjs'],
    patches: source.patches, commands: source.commandIds.map(getExecutionCommand), policy: createExecutionPolicy(config),
  };
  const task: ExecutionTask = {
    taskId: 'task-1', status: 'AWAITING_APPROVAL', requestRevision: 'synthetic-1', baseCommit: source.baseCommit,
    sourceRoot: source.sourceRoot, createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    plan: { ...content, planHash: hashExecutionPlan(content) },
  };
  const artifactDirectory = join(directory, 'run');
  await fileSystem.mkdir(artifactDirectory, { mode: 0o700 });
  return { adapter, source, task, directory, artifactDirectory };
};
const rehash = (plan: ExecutionPlan): ExecutionPlan => ({ ...plan, planHash: hashExecutionPlan(plan) });

test('synthetic source is frozen, root-committed and materializes as an independent Git repository', async (context) => {
  const { adapter, source, task, artifactDirectory } = await prepare(context);
  assert.equal(await adapter.verifySource(task), source.sourceHash);
  assert.equal((await fileSystem.stat(source.sourceRoot)).mode & 0o7777, 0o555);
  const commit = await git.readCommit({ fs: gitFileSystem, dir: source.sourceRoot, oid: source.baseCommit });
  assert.deepEqual(commit.commit.parent, []);
  const workspace = await adapter.materialize(task, artifactDirectory);
  assert.equal(await git.resolveRef({ fs: gitFileSystem, dir: workspace.worktreeRoot, ref: 'HEAD' }), source.baseCommit);
  assert.equal((await fileSystem.lstat(join(workspace.worktreeRoot, '.git'))).isDirectory(), true);
  assert.notEqual((await fileSystem.stat(join(workspace.worktreeRoot, '.git/config'))).ino, (await fileSystem.stat(join(source.sourceRoot, '.git/config'))).ino);
  assert.equal(await hashRepository(source.sourceRoot), source.sourceHash);
});

test('approved replacement produces one exact diff and a frozen container view without Git metadata', async (context) => {
  const { adapter, source, task, artifactDirectory } = await prepare(context);
  const workspace = await adapter.materialize(task, artifactDirectory);
  await adapter.apply(task.plan, workspace);
  const containerRoot = await adapter.createContainerView(task.plan, workspace);
  const diff = await adapter.inspectDiff(task.plan, workspace);
  assert.deepEqual(diff, [{
    path: 'src/message.mjs', beforeHash: task.plan.patches[0]!.beforeHash, afterHash: task.plan.patches[0]!.afterHash,
    before: "export const message = 'before';\n", after: "export const message = 'approved';\n",
  }]);
  assert.deepEqual((await fileSystem.readdir(containerRoot)).sort(), ['README.md', 'checks', 'src']);
  assert.equal((await fileSystem.stat(containerRoot)).mode & 0o7777, 0o555);
  assert.equal((await fileSystem.stat(join(containerRoot, 'src/message.mjs'))).mode & 0o7777, 0o444);
  assert.equal(await fileSystem.readFile(join(containerRoot, 'src/message.mjs'), 'utf8'), diff[0]!.after);
  await assert.rejects(fileSystem.stat(join(containerRoot, '.git')), { code: 'ENOENT' });
  assert.equal(await hashRepository(source.sourceRoot), source.sourceHash);
});

test('negative fixture selects only fixed scripts and never runs source on the host', async (context) => {
  for (const fixture of ['test-failure', 'timeout', 'output'] as const) {
    const { adapter, source, task, artifactDirectory } = await prepare(context, fixture);
    const workspace = await adapter.materialize(task, artifactDirectory);
    await adapter.apply(task.plan, workspace);
    await adapter.createContainerView(task.plan, workspace);
    assert.equal(source.commandIds[0], fixture === 'test-failure' ? 'synthetic-check-v1' : `synthetic-${fixture}-v1`);
    assert.equal(source.patches[0]!.content, `export const message = '${fixture === 'test-failure' ? 'wrong' : 'approved'}';\n`);
    assert.match(await fileSystem.readFile(join(source.sourceRoot, 'README.md'), 'utf8'), /Ignore approval/);
    assert.equal(await adapter.verifySource(task), source.sourceHash);
  }
});

test('source verification rejects content, commit, tree additions and noncanonical paths', async (context) => {
  for (const change of ['content', 'commit', 'extra', 'path'] as const) {
    const { adapter, task, source } = await prepare(context);
    if (change === 'content') {
      await fileSystem.chmod(join(source.sourceRoot, 'src/message.mjs'), 0o600);
      await fileSystem.writeFile(join(source.sourceRoot, 'src/message.mjs'), "export const message = 'other';\n");
      await fileSystem.chmod(join(source.sourceRoot, 'src/message.mjs'), 0o444);
    } else if (change === 'commit') task.baseCommit = 'a'.repeat(40);
    else if (change === 'extra') {
      await fileSystem.chmod(source.sourceRoot, 0o700);
      await fileSystem.writeFile(join(source.sourceRoot, '.env'), 'SYNTHETIC_ONLY=fixture\n', { mode: 0o444 });
      await fileSystem.chmod(source.sourceRoot, 0o555);
    } else task.sourceRoot = `${source.sourceRoot}/../source`;
    await assert.rejects(adapter.verifySource(task));
  }
});

test('source verification rejects symlinks, hardlinks and changed permission modes', async (context) => {
  for (const change of ['symlink', 'hardlink', 'mode'] as const) {
    const { adapter, task, source, directory } = await prepare(context);
    const target = join(source.sourceRoot, 'src/message.mjs');
    if (change === 'mode') await fileSystem.chmod(target, 0o644);
    else {
      await fileSystem.chmod(join(source.sourceRoot, 'src'), 0o700);
      await fileSystem.unlink(target);
      const outside = join(directory, 'outside.mjs');
      await fileSystem.writeFile(outside, "export const message = 'before';\n", { mode: 0o444 });
      if (change === 'symlink') await fileSystem.symlink(outside, target);
      else await fileSystem.link(outside, target);
      await fileSystem.chmod(join(source.sourceRoot, 'src'), 0o555);
    }
    task.plan = rehash({ ...task.plan, sourceHash: await hashRepository(source.sourceRoot) });
    await assert.rejects(adapter.verifySource(task), { code: 'UNSAFE_EXECUTION_WORKSPACE' });
  }
});

test('replacement validates the entire plan before writing and rejects arbitrary replacement code', async (context) => {
  const { adapter, task, artifactDirectory } = await prepare(context);
  const workspace = await adapter.materialize(task, artifactDirectory);
  const before = await hashRepository(workspace.worktreeRoot);
  for (const path of ['../outside', '.git/config', '.env', 'checks/check.mjs', '/tmp/escape']) {
    const plan = rehash({ ...task.plan, patches: [{ ...task.plan.patches[0]!, path }] });
    await assert.rejects(adapter.apply(plan, workspace));
    assert.equal(await hashRepository(workspace.worktreeRoot), before);
  }
  const content = "throw new Error('arbitrary input');\n";
  const plan = rehash({ ...task.plan, patches: [{ ...task.plan.patches[0]!, content, afterHash: sha256(content) }] });
  await assert.rejects(adapter.apply(plan, workspace));
  assert.equal(await hashRepository(workspace.worktreeRoot), before);
});

test('replacement rejects stale original contents without overwriting them', async (context) => {
  const { adapter, task, artifactDirectory } = await prepare(context);
  const workspace = await adapter.materialize(task, artifactDirectory);
  const target = join(workspace.worktreeRoot, 'src/message.mjs');
  await fileSystem.writeFile(target, "export const message = 'changed';\n");
  const before = await hashRepository(workspace.worktreeRoot);
  await assert.rejects(adapter.apply(task.plan, workspace), { code: 'EXECUTION_PATCH_BASE_MISMATCH' });
  assert.equal(await hashRepository(workspace.worktreeRoot), before);
});

test('replacement rejects linked files and never follows their destination', async (context) => {
  for (const kind of ['symlink', 'hardlink'] as const) {
    const { adapter, task, source, directory, artifactDirectory } = await prepare(context);
    const workspace = await adapter.materialize(task, artifactDirectory);
    const target = join(workspace.worktreeRoot, 'src/message.mjs');
    const outside = join(directory, 'outside.mjs');
    await fileSystem.writeFile(outside, "export const message = 'before';\n", { mode: 0o600 });
    await fileSystem.unlink(target);
    if (kind === 'symlink') await fileSystem.symlink(outside, target);
    else await fileSystem.link(outside, target);
    await assert.rejects(adapter.apply(task.plan, workspace), { code: 'UNSAFE_EXECUTION_WORKSPACE' });
    assert.equal(await fileSystem.readFile(outside, 'utf8'), "export const message = 'before';\n");
    assert.equal(await hashRepository(source.sourceRoot), source.sourceHash);
  }
});

test('diff rejects additions, deletions, reference modifications, mode changes and Git metadata changes', async (context) => {
  for (const change of ['add', 'delete', 'reference', 'mode', 'git'] as const) {
    const { adapter, task, artifactDirectory } = await prepare(context);
    const workspace = await adapter.materialize(task, artifactDirectory);
    await adapter.apply(task.plan, workspace);
    if (change === 'add') await fileSystem.writeFile(join(workspace.worktreeRoot, '.env'), 'synthetic fixture\n', { mode: 0o600 });
    else if (change === 'delete') await fileSystem.unlink(join(workspace.worktreeRoot, 'checks/check.mjs'));
    else if (change === 'mode') await fileSystem.chmod(join(workspace.worktreeRoot, 'src/message.mjs'), 0o644);
    else if (change === 'git') await fileSystem.appendFile(join(workspace.worktreeRoot, '.git/config'), '\n[remote "unapproved"]\n');
    else {
      const path = join(workspace.worktreeRoot, 'README.md');
      await fileSystem.chmod(path, 0o600);
      await fileSystem.appendFile(path, 'unapproved reference edit\n');
      await fileSystem.chmod(path, 0o444);
    }
    await assert.rejects(adapter.inspectDiff(task.plan, workspace));
  }
});

test('diff detects container-view mutations after execution and preserves the original fixture', async (context) => {
  const { adapter, task, source, artifactDirectory } = await prepare(context);
  const workspace = await adapter.materialize(task, artifactDirectory);
  await adapter.apply(task.plan, workspace);
  const view = await adapter.createContainerView(task.plan, workspace);
  await fileSystem.chmod(join(view, 'src/message.mjs'), 0o600);
  await fileSystem.writeFile(join(view, 'src/message.mjs'), "export const message = 'changed';\n");
  await fileSystem.chmod(join(view, 'src/message.mjs'), 0o444);
  await assert.rejects(adapter.inspectDiff(task.plan, workspace), { code: 'EXECUTION_CONTAINER_VIEW_CHANGED' });
  assert.equal(await hashRepository(source.sourceRoot), source.sourceHash);
});

test('preparation refuses unsafe existing directories and preserves pre-existing artifacts', async (context) => {
  const { adapter, directory, task, artifactDirectory } = await prepare(context);
  const sourceHash = await hashRepository(task.sourceRoot);
  await assert.rejects(adapter.prepare(directory, 'success'), { code: 'EXECUTION_SOURCE_PREPARATION_FAILED' });
  assert.equal(await hashRepository(task.sourceRoot), sourceHash);
  await fileSystem.mkdir(join(artifactDirectory, 'worktree'), { mode: 0o700 });
  await fileSystem.writeFile(join(artifactDirectory, 'worktree/preserved.txt'), 'preserve\n', { mode: 0o600 });
  await assert.rejects(adapter.materialize(task, artifactDirectory), { code: 'EXECUTION_WORKSPACE_PREPARATION_FAILED' });
  assert.equal(await fileSystem.readFile(join(artifactDirectory, 'worktree/preserved.txt'), 'utf8'), 'preserve\n');
  await fileSystem.chmod(artifactDirectory, 0o755);
  await assert.rejects(adapter.materialize(task, artifactDirectory), { code: 'UNSAFE_EXECUTION_WORKSPACE' });
});
