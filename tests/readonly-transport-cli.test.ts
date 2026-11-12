import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SqliteReadonlyTransportStore } from '../src/adapters/sqlite-readonly-transport-store.js';
import { assertReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { readonlyTransportCleanupConfirmed } from '../src/adapters/readonly-transport-lifecycle.js';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import type { ReadonlyTransportSnapshot } from '../src/ports/readonly-transport.js';

const removeFixture = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await removeFixture(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
};
const prepare = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-readonly-cli-')));
  await chmod(root, 0o700); t.after(() => removeFixture(root));
  const data = join(root, 'data');
  const execute = (args: string[], directory = data) => spawnSync(process.execPath,
    [resolve('dist/src/cli/main.js'), ...args, '--data-dir', directory], {
      env: { LANG: 'C.UTF-8', TZ: 'UTC', HOME: root, SYNTHETIC_HOST_SECRET: 'SYNTHETIC_NOT_FOR_WORKER' },
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
  const run = <T>(args: string[]): T => {
    const result = execute(args);
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_NOT_FOR_WORKER/);
    return JSON.parse(result.stdout) as T;
  };
  const rejected = (args: string[], code?: string) => {
    const result = execute(args);
    assert.equal(result.status, 1, result.stdout); assert.equal(result.stdout, '');
    if (code) assert.equal(result.stderr.split('\n')[0], code);
    return result;
  };
  const plan = (extra: string[] = []) => run<ReadonlyTransportSnapshot>(['readonly-transport-plan', '--fixture', 'flow', ...extra]);
  const request = (snapshot: ReadonlyTransportSnapshot) => ['--task', snapshot.task.investigationId, '--plan-hash', snapshot.task.plan.planHash];
  const approve = (snapshot: ReadonlyTransportSnapshot) => run<ReadonlyTransportSnapshot>(['readonly-transport-approve', ...request(snapshot), '--expires-in-minutes', '30']);
  const inspect = (snapshot: ReadonlyTransportSnapshot) => run<ReadonlyTransportSnapshot>(['readonly-transport-inspect', '--task', snapshot.task.investigationId]);
  return { root, data, execute, run, rejected, plan, request, approve, inspect };
};

test('offline CLI shows exact selected transmission, requires approval, reports offline citations and preserves source', async (t) => {
  const cli = await prepare(t);
  const planned = cli.plan(['--selection', 'all', '--transfer', 'controller']);
  assert.equal(planned.task.status, 'AWAITING_APPROVAL'); assert.equal(planned.attempt, null);
  assert.equal(planned.payload!.context.evidence.length, 4);
  const input = JSON.parse(planned.payload!.inputText);
  assert.equal(input.evidence.length, 1); assert.equal(input.evidence[0].path, 'src/controller.ts');
  assert.equal(planned.task.plan.mode, 'offline'); assert.equal(planned.task.plan.destination, 'local:readonly-transport');
  assert.equal(planned.task.plan.transport, 'fake');
  assert.equal(planned.task.plan.requestBodyHash, createHash('sha256').update(planned.payload!.requestBody).digest('hex'));
  assert.equal(JSON.parse(planned.payload!.requestBody).input, planned.payload!.inputText);
  assert.deepEqual(planned.task.plan.writeAllowedFiles, []); assert.deepEqual(planned.task.plan.testCommandIds, []);
  assert.equal(planned.task.plan.executionAllowed, false);
  cli.rejected(['readonly-transport-run', ...cli.request(planned)]);
  assert.equal(cli.inspect(planned).attempt, null);
  assert.equal(cli.approve(planned).task.status, 'APPROVED');
  const reported = cli.run<ReadonlyTransportSnapshot>(['readonly-transport-run', ...cli.request(planned)]);
  assert.equal(reported.task.status, 'REPORTED'); assert.equal(reported.report!.mode, 'offline');
  assert.equal(reported.report!.result.facts.length, 1);
  assert.equal(reported.report!.result.facts[0]!.references[0]!.evidenceId, input.evidence[0].evidenceId);
  assert.equal(reported.report!.executionAllowed, false); assert.equal(reported.report!.semanticAccuracyVerified, false);
  await assertReadonlyRepository(planned.payload!.repository);
  cli.rejected(['readonly-transport-run', ...cli.request(planned)]);
  assert.equal(cli.inspect(planned).attempt!.attemptId, reported.attempt!.attemptId);
});

test('stream profile is bound to the plan and report explicitly excludes real model, credentials and compatibility checks', async (t) => {
  const cli = await prepare(t);
  const planned = cli.plan(['--profile', 'stream', '--transfer', 'service']);
  assert.equal(planned.task.plan.profileId, 'synthetic-stream-v1');
  assert.equal(JSON.parse(planned.payload!.requestBody).stream, true);
  cli.approve(planned);
  const reported = cli.run<ReadonlyTransportSnapshot>(['readonly-transport-run', ...cli.request(planned)]);
  assert.equal(reported.task.status, 'REPORTED');
  assert.equal(reported.report!.transport, 'fake'); assert.equal(reported.report!.responseOrigin, 'synthetic');
  assert.equal(reported.report!.requestBodyHash, planned.task.plan.requestBodyHash);
  assert.equal(reported.report!.checks.realModel, 'not_run');
  assert.equal(reported.report!.checks.credentialAccess, 'not_run');
  assert.equal(reported.report!.checks.providerCompatibility, 'not_run');
  assert.equal(reported.report!.checks.externalTransmission, 'not_run');
  assert.equal(reported.attempt!.requestBodyHash, planned.task.plan.requestBodyHash);
  await assertReadonlyRepository(planned.payload!.repository);
});

test('change requests remain read-only; cancellation and invalidation cannot export or expand authority', async (t) => {
  const cli = await prepare(t);
  const change = cli.plan(['--request', 'change-request', '--transfer', 'service']); cli.approve(change);
  const reported = cli.run<ReadonlyTransportSnapshot>(['readonly-transport-run', ...cli.request(change)]);
  assert.equal(reported.report!.result.classification, 'change-request');
  assert.equal(reported.report!.result.suggestions[0]!.path, 'src/service.ts');
  assert.deepEqual(reported.task.plan.writeAllowedFiles, []);
  cli.rejected(['readonly-transport-export', '--task', change.task.investigationId], 'UNKNOWN_COMMAND');
  for (const action of ['cancel', 'invalidate']) {
    const planned = cli.plan(); cli.approve(planned);
    const stopped = cli.run<ReadonlyTransportSnapshot>([`readonly-transport-${action}`, '--task', planned.task.investigationId]);
    assert.ok(['CANCELLED', 'BLOCKED'].includes(stopped.task.status));
    assert.ok(stopped.approvals[0]!.revokedAt);
    cli.rejected(['readonly-transport-run', ...cli.request(planned)]);
    assert.equal(cli.inspect(planned).attempt, null);
  }
});

test('CLI rejects arbitrary repositories, model/live settings and invalid approval options before creating state', async (t) => {
  const cli = await prepare(t);
  for (const args of [
    ['readonly-transport-plan'], ['readonly-transport-plan', '--fixture', '../outside'],
    ['readonly-transport-plan', '--fixture', 'flow', '--mode', 'live'],
    ['readonly-transport-plan', '--fixture', 'flow', '--profile', 'remote'],
    ['readonly-transport-plan', '--fixture', 'flow', '--transport', 'real'],
    ['readonly-transport-plan', '--fixture', 'flow', '--auth', 'existing-login'],
    ['readonly-transport-plan', '--fixture', 'flow', '--model', 'external'],
    ['readonly-transport-plan', '--fixture', 'flow', '--repo', '/etc'],
    ['readonly-transport-plan', '--fixture', 'flow', '--body', 'arbitrary'],
    ['readonly-transport-plan', '--fixture', 'flow', '--transfer', '../private'],
    ['readonly-transport-plan', '--fixture', 'flow', '--request', 'arbitrary'],
    ['readonly-transport-plan', '--fixture', 'flow', '--selection', 'all', '--selection', 'service'],
    ['readonly-transport-approve', '--task', '00000000-0000-0000-0000-000000000000', '--plan-hash', 'a'.repeat(64)],
    ['readonly-transport-approve', '--task', '00000000-0000-0000-0000-000000000000', '--plan-hash', 'a'.repeat(64), '--expires-in-minutes', '61'],
    ['readonly-transport-run', '--task', '00000000-0000-0000-0000-000000000000'],
    ['readonly-transport-inspect', '--task', '../escape'],
    ['readonly-transport-prune', '--live', 'true'],
  ]) cli.rejected(args, 'INVALID_ARGUMENTS');
  assert.deepEqual(await readdir(cli.root), []);
});

test('private runtime paths and lease boundaries preserve inspection and cancellation during another run', async (t) => {
  const cli = await prepare(t); const planned = cli.plan();
  const release = acquireRuntimeLease(cli.data);
  try {
    cli.rejected(['readonly-transport-plan', '--fixture', 'flow'], 'HARNESS_ALREADY_RUNNING');
    cli.rejected(['readonly-transport-prune'], 'HARNESS_ALREADY_RUNNING');
    assert.equal(cli.inspect(planned).task.status, 'AWAITING_APPROVAL');
    assert.equal(cli.run<ReadonlyTransportSnapshot>(['readonly-transport-cancel', '--task', planned.task.investigationId]).task.status, 'CANCELLED');
  } finally { release(); }
  const alias = join(cli.root, 'alias'); await symlink(cli.data, alias);
  const linked = cli.execute(['readonly-transport-prune'], alias);
  assert.equal(linked.status, 1); assert.equal(linked.stderr.split('\n')[0], 'UNSAFE_DATA_DIRECTORY');
  const overlapping = cli.execute(['readonly-transport-prune'], resolve('.'));
  assert.equal(overlapping.status, 1); assert.equal(overlapping.stderr.split('\n')[0], 'DATA_DIRECTORY_OVERLAPS_SOURCE');
});

test('new-process inspect never resumes RUNNING and recovery blocks absent process evidence', async (t) => {
  const cli = await prepare(t); const planned = cli.plan(); cli.approve(planned);
  const store = new SqliteReadonlyTransportStore(join(cli.data, 'readonly-transports.sqlite'));
  const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  try { store.claim({ investigationId: planned.task.investigationId, planHash: planned.task.plan.planHash }, context); }
  finally { store.close(); }
  assert.equal(cli.inspect(planned).task.status, 'RUNNING');
  const recovered = cli.run<ReadonlyTransportSnapshot>(['readonly-transport-recover', '--task', planned.task.investigationId]);
  assert.equal(recovered.task.status, 'BLOCKED');
  assert.equal(recovered.report, null); assert.ok(recovered.approvals[0]!.usedAt);
  cli.rejected(['readonly-transport-run', ...cli.request(planned)]);
});

test('actual controller SIGKILL leaves RUNNING and verified worker disappearance recovers INTERRUPTED without replay', async (t) => {
  const cli = await prepare(t); const planned = cli.plan(); cli.approve(planned);
  const id = planned.task.investigationId;
  const module = (path: string) => JSON.stringify(pathToFileURL(resolve(`dist/src/${path}.js`)).href);
  const code = `
    import { spawn } from 'node:child_process'; import { createHash } from 'node:crypto';
    import { SqliteReadonlyTransportStore } from ${module('adapters/sqlite-readonly-transport-store')};
    import { ReadonlyTransportService } from ${module('application/investigate-transport')};
    import { readonlyTransportWorkerLaunch } from ${module('adapters/readonly-transport-worker-contract')};
    import { createReadonlyTransportLifecycle } from ${module('adapters/readonly-transport-lifecycle')};
    const store = new SqliteReadonlyTransportStore(${JSON.stringify(join(cli.data, 'readonly-transports.sqlite'))});
    const model = { mode:'offline', transport:'fake', transmit: (input) => new Promise(() => {
      const record = createReadonlyTransportLifecycle(${JSON.stringify({ dataDirectory: cli.data, investigationId: id })}, createHash('sha256').update(input).digest('hex'));
      const launch=readonlyTransportWorkerLaunch();
      const child=spawn(process.execPath,[...launch.flags,launch.entry],{cwd:'/',env:launch.environment,stdio:['pipe','pipe','pipe','ipc']});
      record.spawned(child.pid);
      child.on('message', value => { if(value.type==='ready') console.log(child.pid); });
    }) };
    const service = new ReadonlyTransportService(store,model,${JSON.stringify(cli.data)});
    await service.run(${JSON.stringify({ investigationId: id, planHash: planned.task.plan.planHash })}, {ownerId:'os-user:'+process.getuid(),now:new Date()});
  `;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { parent.kill('SIGKILL'); });
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker ready timeout')), 5000);
    parent.stdout!.once('data', () => { clearTimeout(timeout); resolveReady(); });
    parent.once('exit', () => { clearTimeout(timeout); reject(new Error('unexpected early controller exit')); });
  });
  assert.equal(cli.inspect(planned).task.status, 'RUNNING');
  parent.kill('SIGKILL'); await new Promise<void>((resolveClose) => parent.once('close', () => resolveClose()));
  for (let attempt = 0; attempt < 100 && !readonlyTransportCleanupConfirmed(cli.data, id, planned.task.plan.requestBodyHash); attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.equal(readonlyTransportCleanupConfirmed(cli.data, id, planned.task.plan.requestBodyHash), true);
  const recovered = cli.run<ReadonlyTransportSnapshot>(['readonly-transport-recover', '--task', id]);
  assert.equal(recovered.task.status, 'INTERRUPTED'); assert.equal(recovered.report, null);
  assert.ok(recovered.approvals[0]!.usedAt);
  cli.rejected(['readonly-transport-run', ...cli.request(planned)]);
  await assertReadonlyRepository(planned.payload!.repository);
  assert.equal(JSON.parse(await readFile(join(cli.data, 'readonly-transport-runs', id, 'lifecycle.json'), 'utf8')).state, 'spawned');
});
