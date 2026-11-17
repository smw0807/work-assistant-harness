import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test, type TestContext } from 'node:test';
import { getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';
import { createCompanyReadonlyV3Fixture } from './company-readonly-v3-fixture.js';

interface CommandResult { code: number | null; stdout: string; stderr: string }
interface Audit {
  sourceAccesses: number; registrationAccesses: number; spawns: number; droppedBytes: number;
  envKeys: string[]; workerArguments: string[]; signals: string[]; closeSignal: string | null; closeCode: number | null;
  signalTimes: { signal: string; elapsedMs: number }[];
}
const run = (args: string[], preload?: string, environment: NodeJS.ProcessEnv = {}) => new Promise<CommandResult>((done, reject) => {
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), resolve('dist/src/cli/main.js'), ...args], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', ...environment },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
});
const setup = async (context: TestContext, large = false) => {
  const fixture = await createCompanyReadonlyV3Fixture(context, large);
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v3-cli-'))); fs.chmodSync(directory, 0o700);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policyFile = join(directory, 'company-readonly-policy.json'), registrationFile = join(directory, 'company-readonly-registration-v3.json');
  const runtime = join(directory, 'runtime'), database = join(runtime, 'store', 'company-readonly-v3.sqlite');
  fs.writeFileSync(policyFile, JSON.stringify(fixture.policy), { mode: 0o600 });
  fs.writeFileSync(registrationFile, JSON.stringify(fixture.registration), { mode: 0o600 });
  const planArgs = ['company-readonly-v3-plan', '--policy', policyFile, '--registration', registrationFile, '--data-dir', runtime];
  return { ...fixture, directory, policyFile, registrationFile, runtime, database, planArgs };
};
type Fixture = Awaited<ReturnType<typeof setup>>;
const resultBody = (result: CommandResult): Record<string, unknown> => JSON.parse(result.stdout) as Record<string, unknown>;
const successful = (result: CommandResult, status: string): Record<string, unknown> => {
  assert.equal(result.code, 0, result.stderr);
  const body = resultBody(result);
  assert.equal(body.version, 'company-readonly-v3-result-v1'); assert.equal(body.status, status);
  assert.equal(body.runStatus, 'succeeded'); assert.equal(body.exitConfirmed, true);
  for (const field of ['approvalCreated', 'transmissionAllowed', 'executionAllowed', 'companyPolicyVerified']) assert.equal(body[field], false);
  for (const field of ['providerCompatibility', 'nativeExecution', 'realModel']) assert.equal(body[field], 'not_run');
  assert.equal(body.gitProfileHash, getCompanyGitRangeUnitProfileHash()); assert.equal(body.guardPolicyHash, getCompanyGitRangeUnitGuardPolicyHash());
  assert.equal(body.oldSpaceMiB, 128); assert.ok(Number(body.peakRssBytes) > 0);
  return body;
};
const metadataOnly = (text: string, fixture: Fixture): void => {
  for (const value of [fixture.root, fixture.registration.question, fixture.policy.policyReference,
    ...fixture.selectedPaths, ...Object.values(fixture.selectedFiles)]) if (typeof value === 'string') assert.equal(text.includes(value), false);
};
const readReceipt = (fixture: Fixture, id: string, prefix: 'run' | 'result'): Record<string, unknown> => {
  const path = join(fixture.runtime, 'runs', `${prefix}-${id}.json`);
  assert.equal(fs.lstatSync(path).mode & 0o7777, 0o600); assert.equal(fs.lstatSync(path).nlink, 1);
  const text = fs.readFileSync(path, 'utf8'); metadataOnly(text, fixture);
  return JSON.parse(text) as Record<string, unknown>;
};

/** The preload observes only the CLI parent. Faults replace transport or a synthetic child, never source data. */
const auditPreload = (fixture: Fixture, mode: 'observe' | 'drop-output' | 'timeout' | 'spawn-failure' = 'observe') => {
  const preload = join(fixture.directory, `audit-${mode}.mjs`), output = join(fixture.directory, `audit-${mode}.json`);
  const hangingChild = join(fixture.directory, 'synthetic-hanging-child.mjs');
  if (mode === 'timeout') fs.writeFileSync(hangingChild, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n", { mode: 0o600 });
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import promises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const source = ${JSON.stringify(fixture.root)}, registration = ${JSON.stringify(fixture.registrationFile)};
const output = ${JSON.stringify(output)}, mode = ${JSON.stringify(mode)}, hangingChild = ${JSON.stringify(hangingChild)};
const audit = { sourceAccesses: 0, registrationAccesses: 0, spawns: 0, droppedBytes: 0,
  envKeys: [], workerArguments: [], signals: [], signalTimes: [], closeSignal: null, closeCode: null };
const save = fs.writeFileSync.bind(fs);
const observe = value => {
  const path = typeof value === 'string' ? value : value instanceof URL ? value.pathname : '';
  if (path === source || path.startsWith(source + '/')) audit.sourceAccesses += 1;
  if (path === registration) audit.registrationAccesses += 1;
};
for (const [api, names] of [[fs, ['lstatSync', 'statSync', 'realpathSync', 'openSync', 'readFileSync', 'readdirSync']],
  [promises, ['lstat', 'stat', 'realpath', 'open', 'readFile', 'readdir']]]) {
  for (const name of names) { const original = api[name]; api[name] = function(...args) { observe(args[0]); return Reflect.apply(original, this, args); }; }
}
const originalSpawn = childProcess.spawn;
childProcess.spawn = function(executable, args, options) {
  audit.spawns += 1; audit.envKeys = Object.keys(options.env).sort(); audit.workerArguments = args.slice(0, -1);
  if (mode === 'spawn-failure') throw new Error('synthetic spawn failure');
  const child = mode === 'timeout'
    ? originalSpawn(executable, ['--max-old-space-size=128', '--permission', '--allow-fs-read=*', hangingChild], options)
    : originalSpawn(executable, args, options);
  const kill = child.kill, spawnedAt = performance.now();
  child.kill = function(signal) {
    audit.signals.push(signal); audit.signalTimes.push({ signal, elapsedMs: performance.now() - spawnedAt });
    return Reflect.apply(kill, this, [signal]);
  };
  child.once('close', (code, signal) => { audit.closeCode = code; audit.closeSignal = signal; });
  if (mode === 'drop-output') {
    const emit = child.stdout.emit;
    child.stdout.emit = function(event, ...args) {
      if (event === 'data') { audit.droppedBytes += Buffer.byteLength(args[0]); return true; }
      return Reflect.apply(emit, this, [event, ...args]);
    };
  }
  return child;
};
syncBuiltinESMExports();
process.on('exit', () => save(output, JSON.stringify(audit), { mode: 0o600 }));
`, { mode: 0o600 });
  return { preload, read: (): Audit => JSON.parse(fs.readFileSync(output, 'utf8')) as Audit };
};

test('v3 CLI prepares a large synthetic pack in a restricted worker and preserves source bytes and metadata', { timeout: 60_000 }, async context => {
  const fixture = await setup(context, true), before = fixture.snapshot(), audit = auditPreload(fixture);
  assert.ok(fs.lstatSync(fixture.packPath!).size > 8 * 1024 * 1024); assert.ok(fixture.objects.length > 4096);
  const prepared = await run(fixture.planArgs, audit.preload, {
    OPENAI_API_KEY: 'synthetic-environment-canary', ANTHROPIC_API_KEY: 'synthetic-environment-canary',
    HARNESS_NATIVE_READONLY_TESTS: '1', HARNESS_REAL_MODEL_TESTS: '1', HTTPS_PROXY: 'http://synthetic.invalid',
  });
  const body = successful(prepared, 'AWAITING_APPROVAL'), id = body.taskId as string;
  // RSS is an observed target, not an OS-enforced process memory cap.
  context.diagnostic(JSON.stringify({ synthetic: 'large-pack', peakRssBytes: body.peakRssBytes, oldSpaceMiB: body.oldSpaceMiB,
    rssTargetBytes: 256 * 1024 * 1024, rssTargetMet: Number(body.peakRssBytes) <= 256 * 1024 * 1024, rssEnforcement: 'observed-target-only' }));
  assert.equal(body.reviewAvailable, true); metadataOnly(prepared.stdout + prepared.stderr, fixture);
  assert.deepEqual(fs.readdirSync(fixture.runtime).sort(), ['runs', 'store']);
  for (const directory of [fixture.runtime, join(fixture.runtime, 'store'), join(fixture.runtime, 'runs')]) {
    assert.equal(fs.lstatSync(directory).mode & 0o7777, 0o700);
  }
  assert.equal(fs.lstatSync(fixture.database).mode & 0o7777, 0o600);
  const start = readReceipt(fixture, id, 'run'), end = readReceipt(fixture, id, 'result');
  assert.equal(start.taskId, id); assert.equal(start.ownerId, `os-user:${process.getuid!()}`);
  assert.deepEqual(Object.keys(start).sort(), ['auditExpiresAt', 'gitProfileHash', 'guardPolicyHash', 'ownerId', 'policyHash', 'registrationHash', 'runtimeHash', 'startedAt', 'taskId', 'version']);
  assert.equal(end.status, 'succeeded'); assert.equal(end.planHash, body.planHash); assert.equal(end.exitConfirmed, true);
  const observed = audit.read();
  assert.equal(observed.spawns, 1); assert.equal(observed.sourceAccesses, 0);
  assert.deepEqual(observed.envKeys, ['LANG', 'TZ']);
  assert.deepEqual(observed.workerArguments, ['--max-old-space-size=128', '--permission', '--allow-fs-read=*',
    `--allow-fs-write=${join(fixture.runtime, 'store')}`, resolve('dist/src/cli/company-readonly-v3-worker.js')]);
  assert.equal(observed.closeCode, 0); assert.equal(observed.closeSignal, null);
  const inspected = successful(await run(['company-readonly-v3-inspect', '--task', id, '--data-dir', fixture.runtime]), 'AWAITING_APPROVAL');
  assert.equal(inspected.planHash, body.planHash); assert.equal(inspected.preparationRunStatus, 'succeeded');
  const cancelled = successful(await run(['company-readonly-v3-cancel', '--task', id, '--data-dir', fixture.runtime]), 'CANCELLED');
  assert.equal(cancelled.reviewAvailable, false);
  const afterCancel = successful(await run(['company-readonly-v3-inspect', '--task', id, '--data-dir', fixture.runtime]), 'CANCELLED');
  assert.equal(afterCancel.reviewAvailable, false);
  const pruned = successful(await run(['company-readonly-v3-prune', '--data-dir', fixture.runtime]), 'PRUNED');
  assert.equal(pruned.prunedRecords, 0); assert.equal(pruned.runsRemoved, 0);
  assert.equal(fixture.snapshot(), before);
});

test('v3 policy and version gates run before registration or target access and before worker creation', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), before = fixture.snapshot(), audit = auditPreload(fixture);
  for (const patch of [{ readPermission: 'unconfirmed' }, { storagePermission: 'unconfirmed' },
    { policyReference: null }, { payloadRetentionHours: null }, { auditRetentionDays: null }]) {
    fs.writeFileSync(fixture.policyFile, JSON.stringify({ ...fixture.policy, ...patch }));
    const rejected = await run(fixture.planArgs, audit.preload);
    assert.equal(rejected.code, 1); assert.equal(rejected.stdout, ''); assert.match(rejected.stderr, /COMPANY_READONLY_POLICY_UNCONFIRMED/);
    const observed = audit.read(); assert.equal(observed.registrationAccesses, 0); assert.equal(observed.sourceAccesses, 0); assert.equal(observed.spawns, 0);
    assert.equal(fs.existsSync(fixture.runtime), false);
  }
  fs.writeFileSync(fixture.policyFile, JSON.stringify(fixture.policy));
  for (const patch of [{ version: 'company-readonly-registration-v1' }, { version: 'company-readonly-registration-v2' },
    { gitProfileHash: '0'.repeat(64) }, { guardPolicyHash: '0'.repeat(64) }, { guardPolicyHash: undefined }, { enabled: true }]) {
    fs.writeFileSync(fixture.registrationFile, JSON.stringify({ ...fixture.registration, ...patch }));
    const rejected = await run(fixture.planArgs, audit.preload);
    assert.equal(rejected.code, 1); assert.equal(rejected.stdout, ''); assert.match(rejected.stderr, /COMPANY_READONLY_V3_INVALID_REGISTRATION/);
    assert.equal(audit.read().sourceAccesses, 0); assert.equal(audit.read().spawns, 0); assert.equal(fs.existsSync(fixture.runtime), false);
  }
  assert.equal(fixture.snapshot(), before);
});

test('v3 CLI rejects public inputs, path aliases, target overlap and unimplemented actions without target changes', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), before = fixture.snapshot();
  for (const path of [fixture.policyFile, fixture.registrationFile]) {
    fs.chmodSync(path, 0o644);
    const rejected = await run(fixture.planArgs); assert.equal(rejected.code, 1); assert.equal(rejected.stdout, '');
    assert.equal(fs.existsSync(fixture.runtime), false); fs.chmodSync(path, 0o600);
  }
  const alias = join(fixture.directory, 'source-alias'); fs.symlinkSync(fixture.root, alias);
  for (const runtime of [join(fixture.root, 'runtime'), join(alias, 'runtime')]) {
    const rejected = await run([...fixture.planArgs.slice(0, -1), runtime]); assert.equal(rejected.code, 1);
    assert.equal(fs.existsSync(join(fixture.root, 'runtime')), false);
  }
  fs.mkdirSync(fixture.runtime, { mode: 0o755 }); fs.chmodSync(fixture.runtime, 0o755);
  const publicRuntime = await run(fixture.planArgs); assert.equal(publicRuntime.code, 1);
  assert.equal(fs.lstatSync(fixture.runtime).mode & 0o7777, 0o755); assert.deepEqual(fs.readdirSync(fixture.runtime), []);
  for (const command of ['company-readonly-v3-approve', 'company-readonly-v3-run', 'company-readonly-v3-dispatch']) {
    const rejected = await run([command, '--task', randomUUID(), '--data-dir', fixture.runtime]);
    assert.equal(rejected.code, 1); assert.match(rejected.stderr, /UNKNOWN_COMMAND/);
  }
  const duplicate = await run([...fixture.planArgs, '--data-dir', fixture.runtime]);
  assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /INVALID_ARGUMENTS/);
  assert.equal(fixture.snapshot(), before);
});

test('v3 inspect and cancel of an absent record do not create an empty database', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), id = randomUUID();
  fs.mkdirSync(fixture.runtime, { mode: 0o700 });
  for (const directory of ['runs', 'store']) fs.mkdirSync(join(fixture.runtime, directory), { mode: 0o700 });
  for (const command of ['inspect', 'cancel']) {
    const body = successful(await run([`company-readonly-v3-${command}`, '--task', id, '--data-dir', fixture.runtime]), 'NOT_FOUND');
    assert.equal(body.taskId, id); assert.equal(body.planHash, null); assert.equal(body.reviewAvailable, false);
    assert.equal(fs.existsSync(fixture.database), false); assert.deepEqual(fs.readdirSync(join(fixture.runtime, 'runs')), []);
  }
});

test('a committed v3 preparation with lost worker output stays unknown and is recovered only by inspecting the same ID', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), before = fixture.snapshot(), audit = auditPreload(fixture, 'drop-output');
  const failed = await run(fixture.planArgs, audit.preload), body = resultBody(failed), id = body.taskId as string;
  assert.equal(failed.code, 1); assert.equal(body.runStatus, 'unknown'); assert.equal(body.reason, 'invalid_output');
  assert.equal(body.exitConfirmed, true); assert.equal(body.automaticRetry, false); metadataOnly(failed.stdout + failed.stderr, fixture);
  assert.equal(audit.read().spawns, 1); assert.ok(audit.read().droppedBytes > 0); assert.equal(audit.read().closeCode, 0);
  assert.equal(readReceipt(fixture, id, 'run').taskId, id); assert.equal(readReceipt(fixture, id, 'result').status, 'unknown');
  const inspected = successful(await run(['company-readonly-v3-inspect', '--task', id, '--data-dir', fixture.runtime]), 'AWAITING_APPROVAL');
  assert.equal(inspected.taskId, id); assert.equal(inspected.preparationRunStatus, 'unknown'); assert.equal(inspected.reviewAvailable, true);
  assert.deepEqual(fs.readdirSync(join(fixture.runtime, 'runs')).sort(), [`result-${id}.json`, `run-${id}.json`]);
  assert.equal(readReceipt(fixture, id, 'result').status, 'unknown');
  // A second explicit plan is separately identified; unknown recovery never creates it automatically.
  const explicit = successful(await run(fixture.planArgs), 'AWAITING_APPROVAL'); assert.notEqual(explicit.taskId, id);
  assert.equal(fixture.snapshot(), before);
});

test('a DB-free unknown runtime cannot be moved or copied into the target and then inspected, cancelled or pruned', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), audit = auditPreload(fixture, 'spawn-failure');
  const failed = await run(fixture.planArgs, audit.preload), body = resultBody(failed), id = body.taskId as string;
  assert.equal(failed.code, 1); assert.equal(body.runStatus, 'unknown'); assert.equal(body.reason, 'worker_failed');
  assert.equal(body.exitConfirmed, false); assert.equal(fs.existsSync(fixture.database), false);
  assert.equal(readReceipt(fixture, id, 'result').status, 'unknown');
  for (const operation of ['copy', 'move']) {
    const destination = join(fixture.root, `runtime-${operation}`);
    if (operation === 'copy') fs.cpSync(fixture.runtime, destination, { recursive: true });
    else fs.renameSync(fixture.runtime, destination);
    const before = fixture.snapshot();
    for (const command of ['inspect', 'cancel', 'prune']) {
      const rejected = await run([`company-readonly-v3-${command}`, ...(command === 'prune' ? [] : ['--task', id]), '--data-dir', destination]);
      assert.equal(rejected.code, 1); assert.equal(rejected.stdout, '');
      assert.equal(fs.existsSync(join(destination, 'store', 'company-readonly-v3.sqlite')), false);
      assert.equal(fixture.snapshot(), before);
    }
  }
});

test('the fixed 30 second deadline escalates an unresponsive synthetic worker to SIGKILL and confirms exit before unknown', { timeout: 60_000 }, async context => {
  const fixture = await setup(context), before = fixture.snapshot(), audit = auditPreload(fixture, 'timeout');
  const started = performance.now(), failed = await run(fixture.planArgs, audit.preload), elapsed = performance.now() - started;
  const body = resultBody(failed), id = body.taskId as string, observed = audit.read();
  assert.equal(failed.code, 1); assert.equal(body.runStatus, 'unknown'); assert.equal(body.reason, 'deadline');
  assert.equal(body.exitConfirmed, true); assert.equal(body.automaticRetry, false); assert.ok(elapsed >= 30_000);
  assert.deepEqual(observed.signals, ['SIGTERM', 'SIGKILL']); assert.equal(observed.closeSignal, 'SIGKILL'); assert.equal(observed.spawns, 1);
  context.diagnostic(JSON.stringify({ synthetic: 'unresponsive-worker', elapsedMs: elapsed, signalTimes: observed.signalTimes,
    closeSignal: observed.closeSignal, exitConfirmed: body.exitConfirmed }));
  assert.equal(fs.existsSync(fixture.database), false); assert.equal(readReceipt(fixture, id, 'result').status, 'unknown');
  const inspected = successful(await run(['company-readonly-v3-inspect', '--task', id, '--data-dir', fixture.runtime]), 'NOT_FOUND');
  assert.equal(inspected.taskId, id); assert.equal(inspected.preparationRunStatus, 'unknown');
  assert.equal(fs.existsSync(fixture.database), false); metadataOnly(failed.stdout + failed.stderr, fixture);
  assert.equal(fixture.snapshot(), before);
});
