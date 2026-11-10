import assert from 'node:assert/strict';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SyntheticExecutionWorkspace } from '../src/adapters/execution-workspace.js';
import { SqliteExecutionStore } from '../src/adapters/sqlite-execution-store.js';
import { hashRepository } from '../src/adapters/demo-repository.js';
import type { ExecutionPlan, ExecutionTask } from '../src/domain/execution.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import { createExecutionPolicy, getExecutionCommand, hashExecutionPlan, sha256 } from '../src/policy/execution-policy.js';

const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-execution.sock', serverVersion: '29.4.3',
  imageId: `sha256:${'a'.repeat(64)}`, nodeVersion: '24.22.2',
};
const makeWritable = async (path: string): Promise<void> => {
  const metadata = await fileSystem.lstat(path);
  if (metadata.isSymbolicLink()) return;
  await fileSystem.chmod(path, metadata.isDirectory() ? 0o700 : 0o600);
  if (metadata.isDirectory()) for (const name of await fileSystem.readdir(path)) await makeWritable(join(path, name));
};
const prepare = async (context: TestContext) => {
  const directory = await fileSystem.realpath(await fileSystem.mkdtemp(join(tmpdir(), 'execution-observation-')));
  context.after(async () => {
    await makeWritable(directory);
    await fileSystem.rm(directory, { recursive: true, force: true });
  });
  const adapter = new SyntheticExecutionWorkspace();
  const source = await adapter.prepare(directory, 'success');
  const plan: Omit<ExecutionPlan, 'planHash'> = {
    planId: 'observation-plan', version: 1, taskId: 'observation-task', requestRevision: 'synthetic-1', repoId: 'synthetic-execution',
    baseCommit: source.baseCommit, sourceHash: source.sourceHash, allowedFiles: ['src/message.mjs'], patches: source.patches,
    commands: source.commandIds.map(getExecutionCommand), policy: createExecutionPolicy(config),
  };
  const task: ExecutionTask = {
    taskId: plan.taskId, status: 'RUNNING', requestRevision: plan.requestRevision, baseCommit: source.baseCommit,
    sourceRoot: source.sourceRoot, createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    plan: { ...plan, planHash: hashExecutionPlan(plan) },
  };
  const artifactDirectory = join(directory, 'run');
  await fileSystem.mkdir(artifactDirectory, { mode: 0o700 });
  return { adapter, task, source, directory, artifactDirectory };
};

test('persisted workspace evidence observes an unapplied or approved patch after adapter restart', async (context) => {
  const { adapter, task, source, artifactDirectory } = await prepare(context);
  const workspace = await adapter.materialize(task, artifactDirectory);
  const beforeEvidence = await adapter.evidence(task.plan, workspace);
  assert.equal(beforeEvidence.worktreeRoot, workspace.worktreeRoot);
  const restarted = new SyntheticExecutionWorkspace();
  const before = await restarted.observe(task, artifactDirectory, JSON.parse(JSON.stringify(beforeEvidence)));
  assert.equal(before.status, 'passed');
  assert.equal(before.reason, 'EXECUTION_PATCH_NOT_APPLIED');
  assert.equal(before.gitUnchanged, true);
  assert.deepEqual(before.changes, []);
  await adapter.apply(task.plan, workspace);
  await adapter.createContainerView(task.plan, workspace);
  const evidence = await adapter.evidence(task.plan, workspace);
  assert.match(evidence.viewHash!, /^[a-f0-9]{64}$/);
  const observation = await restarted.observe(task, artifactDirectory, evidence);
  assert.equal(observation.status, 'passed');
  assert.equal(observation.gitUnchanged, true);
  assert.equal(observation.viewUnchanged, true);
  assert.deepEqual(observation.changes, [{
    path: 'src/message.mjs', kind: 'modified', beforeHash: task.plan.patches[0]!.beforeHash,
    afterHash: task.plan.patches[0]!.afterHash, beforeMode: 0o600, afterMode: 0o600, inScope: true,
  }]);
  assert.equal(await hashRepository(source.sourceRoot), source.sourceHash);
});

test('observation distinguishes no workspace from an unjournaled partially initialized workspace', async (context) => {
  const { adapter, task, artifactDirectory } = await prepare(context);
  const absent = await adapter.observe(task, artifactDirectory, null);
  assert.equal(absent.status, 'not_run');
  assert.equal(absent.workspaceExists, false);
  await fileSystem.mkdir(join(artifactDirectory, 'worktree'), { mode: 0o700 });
  const partial = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, null);
  assert.equal(partial.status, 'failed');
  assert.equal(partial.reason, 'EXECUTION_WORKSPACE_EVIDENCE_MISSING');
  assert.equal(partial.workspaceExists, true);
  assert.equal(partial.changes.filter((change) => change.kind === 'deleted' && change.path !== '.git').length, 5);
});

test('partial writes are retained as failed actual hashes without repair or leaked contents', async (context) => {
  for (const partial of ['', "export const message = '"]) {
    const { adapter, task, source, artifactDirectory } = await prepare(context);
    const workspace = await adapter.materialize(task, artifactDirectory);
    const evidence = await adapter.evidence(task.plan, workspace);
    await fileSystem.writeFile(join(workspace.worktreeRoot, 'src/message.mjs'), partial);
    const workspaceHash = await hashRepository(workspace.worktreeRoot);
    const observation = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, evidence);
    assert.equal(observation.status, 'failed');
    assert.equal(observation.reason, 'EXECUTION_OBSERVED_DIFF_OUT_OF_SCOPE');
    assert.equal(observation.changes.find((change) => change.path === 'src/message.mjs')!.afterHash, sha256(partial));
    assert.equal(await hashRepository(workspace.worktreeRoot), workspaceHash);
    assert.equal(await hashRepository(source.sourceRoot), source.sourceHash);
  }
});

test('observation preserves additions, deletions, protected edits and permission changes', async (context) => {
  for (const kind of ['add', 'delete', 'edit', 'mode', 'directory-mode'] as const) {
    const { adapter, task, source, artifactDirectory } = await prepare(context);
    const workspace = await adapter.materialize(task, artifactDirectory);
    const evidence = await adapter.evidence(task.plan, workspace);
    const secretName = '.env-DO-NOT-EXPOSE';
    if (kind === 'add') await fileSystem.writeFile(join(workspace.worktreeRoot, secretName), 'SYNTHETIC_SECRET_BODY', { mode: 0o600 });
    else if (kind === 'delete') await fileSystem.unlink(join(workspace.worktreeRoot, 'checks/check.mjs'));
    else if (kind === 'mode') await fileSystem.chmod(join(workspace.worktreeRoot, 'src/message.mjs'), 0o755);
    else if (kind === 'directory-mode') await fileSystem.chmod(join(workspace.worktreeRoot, 'checks'), 0o755);
    else {
      await fileSystem.chmod(join(workspace.worktreeRoot, 'README.md'), 0o600);
      await fileSystem.appendFile(join(workspace.worktreeRoot, 'README.md'), 'SYNTHETIC_UNAPPROVED_BODY');
      await fileSystem.chmod(join(workspace.worktreeRoot, 'README.md'), 0o444);
    }
    const before = await hashRepository(workspace.worktreeRoot);
    const observation = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, evidence);
    assert.equal(observation.status, 'failed', kind);
    assert.ok(observation.changes.some((change) => !change.inScope));
    if (kind === 'add') {
      assert.equal(observation.changes[0]!.path, `unapproved:${sha256(secretName)}`);
      assert.equal(observation.changes[0]!.afterHash, null);
    }
    assert.doesNotMatch(JSON.stringify(observation), /DO-NOT-EXPOSE|SYNTHETIC_SECRET_BODY|SYNTHETIC_UNAPPROVED_BODY/);
    assert.equal(await hashRepository(workspace.worktreeRoot), before);
    assert.equal(await hashRepository(source.sourceRoot), source.sourceHash);
  }
});

test('linked files and special entries are metadata only and never followed', async (context) => {
  for (const kind of ['symlink', 'hardlink', 'directory'] as const) {
    const { adapter, task, directory, source, artifactDirectory } = await prepare(context);
    const workspace = await adapter.materialize(task, artifactDirectory);
    const evidence = await adapter.evidence(task.plan, workspace);
    const outside = join(directory, 'outside-secret');
    await fileSystem.writeFile(outside, 'SYNTHETIC_OUTSIDE_SECRET', { mode: 0o600 });
    const target = join(workspace.worktreeRoot, 'src/message.mjs');
    await fileSystem.unlink(target);
    if (kind === 'symlink') await fileSystem.symlink(outside, target);
    else if (kind === 'hardlink') await fileSystem.link(outside, target);
    else await fileSystem.mkdir(target, { mode: 0o700 });
    const observation = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, evidence);
    assert.equal(observation.status, 'failed');
    const change = observation.changes.find((entry) => entry.path === 'src/message.mjs')!;
    assert.equal(change.afterHash, null);
    assert.equal(change.kind, kind === 'symlink' ? 'symlink' : 'special');
    assert.doesNotMatch(JSON.stringify(observation), /SYNTHETIC_OUTSIDE_SECRET|outside-secret/);
    assert.equal(await fileSystem.readFile(outside, 'utf8'), 'SYNTHETIC_OUTSIDE_SECRET');
    assert.equal(await hashRepository(source.sourceRoot), source.sourceHash);
  }
});

test('Git and view mutations are detected with no raw metadata or file bodies in reports', async (context) => {
  for (const kind of ['git-edit', 'git-secret', 'git-symlink', 'view-edit', 'view-secret', 'view-missing'] as const) {
    const { adapter, task, directory, source, artifactDirectory } = await prepare(context);
    const workspace = await adapter.materialize(task, artifactDirectory);
    await adapter.apply(task.plan, workspace);
    await adapter.createContainerView(task.plan, workspace);
    const evidence = await adapter.evidence(task.plan, workspace);
    if (kind === 'git-edit') await fileSystem.appendFile(join(workspace.worktreeRoot, '.git/config'), 'SYNTHETIC_METADATA_SECRET');
    else if (kind === 'git-secret') await fileSystem.writeFile(join(workspace.worktreeRoot, '.git/.env-private'), 'SYNTHETIC_METADATA_SECRET', { mode: 0o600 });
    else if (kind === 'git-symlink') {
      const outside = join(directory, 'outside-secret');
      await fileSystem.writeFile(outside, 'SYNTHETIC_METADATA_SECRET', { mode: 0o600 });
      await fileSystem.unlink(join(workspace.worktreeRoot, '.git/config'));
      await fileSystem.symlink(outside, join(workspace.worktreeRoot, '.git/config'));
    } else {
      await makeWritable(workspace.containerRoot);
      if (kind === 'view-edit') await fileSystem.writeFile(join(workspace.containerRoot, 'src/message.mjs'), 'SYNTHETIC_VIEW_SECRET');
      else if (kind === 'view-secret') await fileSystem.writeFile(join(workspace.containerRoot, '.env-private'), 'SYNTHETIC_VIEW_SECRET');
      else await fileSystem.rm(workspace.containerRoot, { recursive: true });
      if (kind !== 'view-missing') {
        const freeze = async (path: string): Promise<void> => {
          const metadata = await fileSystem.lstat(path);
          if (metadata.isDirectory()) for (const name of await fileSystem.readdir(path)) await freeze(join(path, name));
          await fileSystem.chmod(path, metadata.isDirectory() ? 0o555 : 0o444);
        };
        await freeze(workspace.containerRoot);
      }
    }
    const observation = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, evidence);
    assert.equal(observation.status, 'failed', kind);
    assert.equal(kind.startsWith('git') ? observation.gitUnchanged : observation.viewUnchanged, false);
    assert.doesNotMatch(JSON.stringify(observation), /SYNTHETIC_METADATA_SECRET|SYNTHETIC_VIEW_SECRET|\.env-private|outside-secret/);
    assert.equal(await hashRepository(source.sourceRoot), source.sourceHash);
  }
});

test('forged evidence, noncanonical artifacts and artifact symlinks are refused', async (context) => {
  const { adapter, task, directory, artifactDirectory } = await prepare(context);
  const workspace = await adapter.materialize(task, artifactDirectory);
  const evidence = await adapter.evidence(task.plan, workspace);
  for (const forged of [{ ...evidence, worktreeRoot: task.sourceRoot }, { ...evidence, planHash: 'a'.repeat(64) }, { ...evidence, gitHash: 'invalid' }]) {
    assert.equal((await adapter.observe(task, artifactDirectory, forged)).status, 'failed');
  }
  assert.equal((await adapter.observe(task, `${artifactDirectory}/../run`, evidence)).status, 'failed');
  const linked = join(directory, 'linked-run');
  await fileSystem.symlink(artifactDirectory, linked);
  assert.equal((await adapter.observe(task, linked, evidence)).status, 'failed');
  await fileSystem.chmod(artifactDirectory, 0o755);
  assert.equal((await adapter.observe(task, artifactDirectory, evidence)).status, 'failed');
});

test('observation bounds oversized files and directory enumeration without altering artifacts', async (context) => {
  for (const kind of ['bytes', 'entries'] as const) {
    const { adapter, task, artifactDirectory } = await prepare(context);
    const workspace = await adapter.materialize(task, artifactDirectory);
    const evidence = await adapter.evidence(task.plan, workspace);
    if (kind === 'bytes') await fileSystem.writeFile(join(workspace.worktreeRoot, 'src/message.mjs'), 'x'.repeat(65537));
    else for (let index = 0; index < 129; index += 1) await fileSystem.writeFile(join(workspace.worktreeRoot, `.synthetic-${index}`), 'private', { mode: 0o600 });
    const before = await hashRepository(workspace.worktreeRoot);
    const observation = await adapter.observe(task, artifactDirectory, evidence);
    assert.equal(observation.status, 'failed');
    assert.equal(observation.reason, 'EXECUTION_OBSERVATION_LIMIT');
    if (kind === 'bytes') assert.ok(observation.changes.some((change) => change.path === 'src/message.mjs' && change.afterHash === null));
    assert.equal(await hashRepository(workspace.worktreeRoot), before);
  }
});

test('overlapping content and mode changes remain bounded, preserve tracked evidence and persist as BLOCKED', async (context) => {
  const { adapter, task, source, directory, artifactDirectory } = await prepare(context);
  const workspace = await adapter.materialize(task, artifactDirectory);
  await adapter.apply(task.plan, workspace);
  await adapter.createContainerView(task.plan, workspace);
  const evidence = await adapter.evidence(task.plan, workspace);
  const trackedPaths = ['README.md', 'checks/check.mjs', 'checks/output.mjs', 'checks/timeout.mjs', 'src/message.mjs'];
  const changedBody = 'SYNTHETIC_TRACKED_CONTENT_DO_NOT_REPORT';
  for (const path of trackedPaths) {
    await fileSystem.chmod(join(workspace.worktreeRoot, path), 0o644);
    await fileSystem.writeFile(join(workspace.worktreeRoot, path), changedBody);
  }
  for (let index = 0; index < 120; index += 1) {
    await fileSystem.writeFile(join(workspace.worktreeRoot, `.env-SYNTHETIC_NAME_DO_NOT_REPORT-${index}`), 'SYNTHETIC_ADDED_CONTENT_DO_NOT_REPORT', { mode: 0o600 });
  }
  await fileSystem.appendFile(join(workspace.worktreeRoot, '.git/config'), 'SYNTHETIC_GIT_CONTENT_DO_NOT_REPORT');
  const viewFile = join(workspace.containerRoot, 'src/message.mjs');
  await fileSystem.chmod(viewFile, 0o600);
  await fileSystem.writeFile(viewFile, 'SYNTHETIC_VIEW_CONTENT_DO_NOT_REPORT');
  await fileSystem.chmod(viewFile, 0o444);
  const before = await hashRepository(workspace.worktreeRoot);
  const observation = await new SyntheticExecutionWorkspace().observe(task, artifactDirectory, evidence);
  assert.equal(observation.status, 'failed');
  assert.equal(observation.reason, 'EXECUTION_OBSERVATION_LIMIT');
  assert.equal(observation.changes.length, 128);
  for (const path of trackedPaths) {
    assert.ok(observation.changes.some((change) => change.path === path && change.kind === 'mode'));
    assert.ok(observation.changes.some((change) => change.path === path && change.kind === 'modified' && change.afterHash === sha256(changedBody)));
  }
  assert.ok(observation.changes.some((change) => change.path === '.git'));
  assert.ok(observation.changes.some((change) => change.path === 'container-view'));
  const addedChanges = observation.changes.filter((change) => change.path.startsWith('unapproved:'));
  assert.ok(addedChanges.length > 0);
  assert.ok(addedChanges.every((change) => /^unapproved:[a-f0-9]{64}$/.test(change.path) && change.afterHash === null));
  assert.doesNotMatch(JSON.stringify(observation), /SYNTHETIC_(?:NAME|TRACKED_CONTENT|ADDED_CONTENT|GIT_CONTENT|VIEW_CONTENT)_DO_NOT_REPORT/);
  const store = new SqliteExecutionStore(join(directory, 'observation.sqlite'));
  try {
    const ownerContext = { ownerId: `os-user:${process.getuid?.()}`, now: new Date('2026-11-10T01:00:00.000Z') };
    const request = { taskId: task.taskId, planHash: task.plan.planHash, baseCommit: task.baseCommit };
    store.create({ ...task, status: 'AWAITING_APPROVAL' });
    store.approve({ ...request, expiresInMinutes: 30 }, ownerContext);
    const run = store.beginRun(request, ownerContext, artifactDirectory);
    store.checkpoint(run.runId, 'finalizing', { workspace: evidence, observation });
    assert.deepEqual(store.lifecycle(run.runId).observation, observation);
    store.finishRun({ ...run, status: 'BLOCKED', failureCode: 'EXECUTION_OBSERVATION_FAILED', observation, finishedAt: ownerContext.now.toISOString() });
    assert.equal(store.findRun(run.runId)!.status, 'BLOCKED');
  } finally { store.close(); }
  assert.equal(await hashRepository(workspace.worktreeRoot), before);
  assert.equal(await hashRepository(source.sourceRoot), source.sourceHash);
});
