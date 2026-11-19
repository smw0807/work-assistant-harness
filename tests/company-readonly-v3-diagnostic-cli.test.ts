import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { readCompanyV3Diagnostic } from '../src/cli/company-readonly-v3-diagnostic-files.js';
import { COMPANY_V3_DIAGNOSTIC_VERSION } from '../src/cli/company-readonly-v3-diagnostic-protocol.js';
import { parseCompanyV3WorkerFailure } from '../src/cli/company-readonly-v3-worker-failure.js';
import { getCompanyGitRangeUnitProfile } from '../src/policy/company-git-range-unit-budget.js';
import { createCompanyReadonlyV3Fixture } from './company-readonly-v3-fixture.js';

interface CommandResult { code: number | null; stdout: string; stderr: string }
interface Audit { spawns: number; registrationAccesses: number; diagnosticWriteFailures: number }
const run = (args: string[], preload?: string) => new Promise<CommandResult>((done, reject) => {
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), resolve('dist/src/cli/main.js'), ...args], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
});
const setup = async (context: TestContext) => {
  const fixture = await createCompanyReadonlyV3Fixture(context);
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v3-diagnostic-cli-'))); fs.chmodSync(directory, 0o700);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policyFile = join(directory, 'company-readonly-policy.json'), registrationFile = join(directory, 'company-readonly-registration-v3.json');
  const runtime = join(directory, 'runtime'), diagnostics = join(directory, 'diagnostics');
  fs.writeFileSync(policyFile, JSON.stringify(fixture.policy), { mode: 0o600 });
  fs.writeFileSync(registrationFile, JSON.stringify(fixture.registration), { mode: 0o600 });
  const args = ['company-readonly-v3-plan', '--policy', policyFile, '--registration', registrationFile, '--data-dir', runtime];
  return { ...fixture, directory, policyFile, registrationFile, runtime, diagnostics, args,
    database: join(runtime, 'store', 'company-readonly-v3.sqlite') };
};
type Fixture = Awaited<ReturnType<typeof setup>>;
const body = (result: CommandResult): Record<string, unknown> => JSON.parse(result.stdout) as Record<string, unknown>;
const success = (result: CommandResult, status: string): Record<string, unknown> => {
  assert.equal(result.code, 0, result.stderr);
  const value = body(result); assert.equal(value.status, status); assert.equal(value.runStatus, 'succeeded');
  assert.equal(value.exitConfirmed, true); return value;
};
const metadataOnly = (text: string, fixture: Fixture): void => {
  for (const value of [fixture.root, fixture.directory, fixture.registration.question, fixture.policy.policyReference,
    fixture.baseCommit, fixture.mainOid, ...fixture.selectedPaths, ...Object.values(fixture.selectedFiles)]) {
    if (typeof value === 'string') assert.equal(text.includes(value), false, 'private source fields must be absent');
  }
  assert.equal(text.includes('"stack"'), false); assert.equal(text.includes('"type":"Buffer"'), false);
};
const receipt = (fixture: Fixture, id: string, kind: 'run' | 'result'): Record<string, unknown> => {
  const path = join(fixture.runtime, 'runs', `${kind}-${id}.json`), text = fs.readFileSync(path, 'utf8');
  assert.equal(fs.statSync(path).mode & 0o777, 0o600); metadataOnly(text, fixture);
  const value = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(value).sort(), (kind === 'run'
    ? ['version', 'taskId', 'ownerId', 'startedAt', 'auditExpiresAt', 'gitProfileHash', 'guardPolicyHash', 'registrationHash', 'policyHash', 'runtimeHash']
    : ['version', 'taskId', 'status', 'planHash', 'endedAt', 'exitConfirmed']).sort());
  return value;
};
const databaseState = (fixture: Fixture) => {
  const database = new DatabaseSync(fixture.database, { readOnly: true });
  try {
    return {
      schema: database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(),
      preparations: database.prepare('SELECT count(*) AS count FROM company_readonly_v3_preparations').get()!.count,
      payloads: database.prepare('SELECT count(*) AS count FROM company_readonly_v3_payloads').get()!.count,
    };
  } finally { database.close(); }
};
const sourceMetadata = (fixture: Fixture): string => {
  const entries: unknown[] = [];
  const visit = (path: string): void => {
    const stat = fs.lstatSync(path, { bigint: true });
    entries.push([path, String(stat.dev), String(stat.ino), String(stat.mode), String(stat.nlink), String(stat.size),
      String(stat.mtimeNs), String(stat.ctimeNs), stat.isFile() && path !== fixture.packPath
        ? createHash('sha256').update(fs.readFileSync(path)).digest('hex') : null]);
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
  };
  visit(fixture.root); return JSON.stringify(entries);
};

/** This preload affects only the CLI parent, not the restricted source-reading worker. */
const auditPreload = (fixture: Fixture, failDiagnosticWrite = false) => {
  const preload = join(fixture.directory, 'diagnostic-audit.mjs'), output = join(fixture.directory, 'diagnostic-audit.json');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import promises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const registration = ${JSON.stringify(fixture.registrationFile)}, diagnosticPrefix = ${JSON.stringify(join(fixture.diagnostics, 'diagnostic-'))};
const output = ${JSON.stringify(output)}, failDiagnosticWrite = ${JSON.stringify(failDiagnosticWrite)};
const audit = { spawns: 0, registrationAccesses: 0, diagnosticWriteFailures: 0 };
const save = fs.writeFileSync.bind(fs), open = promises.open, spawn = childProcess.spawn;
promises.open = async function(...args) {
  if (args[0] === registration) audit.registrationAccesses += 1;
  if (failDiagnosticWrite && typeof args[0] === 'string' && args[0].startsWith(diagnosticPrefix)
    && typeof args[1] === 'number' && (args[1] & fs.constants.O_CREAT)) {
    audit.diagnosticWriteFailures += 1; throw new Error('SYNTHETIC_DIAGNOSTIC_WRITE_FAILURE');
  }
  return Reflect.apply(open, this, args);
};
childProcess.spawn = function(...args) { audit.spawns += 1; return Reflect.apply(spawn, this, args); };
syncBuiltinESMExports();
process.on('exit', () => save(output, JSON.stringify(audit), { mode: 0o600 }));
`, { mode: 0o600 });
  return { preload, read: (): Audit => JSON.parse(fs.readFileSync(output, 'utf8')) as Audit };
};

test('opt-in v3 diagnostics capture a real oversized synthetic pack rejection without changing public receipts', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), maximum = getCompanyGitRangeUnitProfile().limits.packBytes;
  fs.truncateSync(fixture.packPath!, maximum + 1);
  const before = sourceMetadata(fixture), audit = auditPreload(fixture);
  const failed = await run([...fixture.args, '--diagnostics-dir', fixture.diagnostics], audit.preload), value = body(failed);
  assert.equal(failed.code, 1); assert.equal(value.runStatus, 'unknown'); assert.equal(value.reason, 'worker_failed');
  assert.equal(value.exitConfirmed, true); assert.equal(value.automaticRetry, false); assert.equal(audit.read().spawns, 1);
  metadataOnly(failed.stdout + failed.stderr, fixture);
  for (const key of ['failure', 'diagnostic', 'diagnostics', 'counters']) assert.equal(Object.hasOwn(value, key), false);
  const id = value.taskId as string, path = join(fixture.diagnostics, `diagnostic-v3-${id}.json`);
  const record = await readCompanyV3Diagnostic(fixture.diagnostics, fixture.runtime, id);
  assert.equal(record.reason, 'worker_failed'); assert.equal(record.exitConfirmed, true); assert.ok(record.failure);
  assert.equal(record.version, 'company-readonly-v3-diagnostic-record-v2');
  assert.equal(record.workerFailureCode, 'COMPANY_GIT_RANGE_LIMIT');
  assert.equal(record.failure.stage, 'pack_inventory'); assert.equal(record.failure.phase, 'inspect');
  assert.deepEqual(record.failure.limit, { name: 'packBytes', current: 0, requested: maximum + 1, maximum });
  assert.equal(record.failure.counters.readCalls, 1); assert.equal(record.failure.counters.readBytesReturned, 41);
  assert.equal(fs.statSync(fixture.diagnostics).mode & 0o777, 0o700); assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  const diagnosticBytes = fs.readFileSync(path, 'utf8'); metadataOnly(diagnosticBytes, fixture);
  assert.ok(Buffer.byteLength(diagnosticBytes) <= 8192); assert.equal(fs.statSync(path).nlink, 1);
  assert.equal(record.auditExpiresAt, receipt(fixture, id, 'run').auditExpiresAt);
  assert.equal(receipt(fixture, id, 'result').status, 'unknown');
  const inspected = success(await run(['company-readonly-v3-inspect', '--task', id, '--data-dir', fixture.runtime]), 'NOT_FOUND');
  assert.equal(inspected.preparationRunStatus, 'unknown'); assert.equal(inspected.reviewAvailable, false);
  const stored = databaseState(fixture); assert.equal(stored.preparations, 0); assert.equal(stored.payloads, 0);
  assert.equal(fs.readFileSync(path, 'utf8'), diagnosticBytes); assert.equal(sourceMetadata(fixture), before);
});

test('successful diagnostic opt-in preserves public schemas and unexpired diagnostics on plan and prune', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), before = fixture.snapshot();
  const defaultResult = await run(fixture.args), defaultBody = success(defaultResult, 'AWAITING_APPROVAL');
  assert.equal(fs.existsSync(fixture.diagnostics), false);
  const firstDatabase = databaseState(fixture), firstId = defaultBody.taskId as string;
  const diagnosticResult = await run([...fixture.args, '--diagnostics-dir', fixture.diagnostics]);
  const diagnosticBody = success(diagnosticResult, 'AWAITING_APPROVAL'), id = diagnosticBody.taskId as string;
  assert.deepEqual(Object.keys(diagnosticBody).sort(), Object.keys(defaultBody).sort());
  metadataOnly(diagnosticResult.stdout + diagnosticResult.stderr, fixture);
  for (const kind of ['run', 'result'] as const) {
    assert.deepEqual(Object.keys(receipt(fixture, id, kind)).sort(), Object.keys(receipt(fixture, firstId, kind)).sort());
  }
  assert.deepEqual(databaseState(fixture).schema, firstDatabase.schema);
  assert.deepEqual(fs.readdirSync(fixture.diagnostics), [`diagnostic-v3-${id}.json`]);
  const record = await readCompanyV3Diagnostic(fixture.diagnostics, fixture.runtime, id);
  assert.equal(record.failure, null); assert.equal(record.reason, 'completed'); assert.equal(record.exitConfirmed, true);
  assert.equal(record.version, 'company-readonly-v3-diagnostic-record-v1');
  assert.equal(Object.hasOwn(record, 'workerFailureCode'), false);
  const path = join(fixture.diagnostics, `diagnostic-v3-${id}.json`), diagnosticBytes = fs.readFileSync(path, 'utf8');
  metadataOnly(diagnosticBytes, fixture);
  const prune = success(await run(['company-readonly-v3-prune', '--data-dir', fixture.runtime]), 'PRUNED');
  const withDiagnostics = success(await run(['company-readonly-v3-prune', '--data-dir', fixture.runtime,
    '--diagnostics-dir', fixture.diagnostics]), 'PRUNED');
  assert.deepEqual(Object.keys(withDiagnostics).sort(), Object.keys(prune).sort());
  assert.equal(fs.readFileSync(path, 'utf8'), diagnosticBytes); assert.equal(fixture.snapshot(), before);
});

test('diagnostic flags and policy gates reject before creating diagnostics, runtime or a worker', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), before = fixture.snapshot(), audit = auditPreload(fixture);
  for (const command of ['inspect', 'cancel']) {
    const rejected = await run([`company-readonly-v3-${command}`, '--task', randomUUID(), '--data-dir', fixture.runtime,
      '--diagnostics-dir', fixture.diagnostics], audit.preload);
    assert.equal(rejected.code, 1); assert.equal(rejected.stdout, ''); assert.match(rejected.stderr, /INVALID_ARGUMENTS/u);
    assert.equal(audit.read().spawns, 0); assert.equal(fs.existsSync(fixture.diagnostics), false); assert.equal(fs.existsSync(fixture.runtime), false);
  }
  fs.writeFileSync(fixture.policyFile, JSON.stringify({ ...fixture.policy, storagePermission: 'unconfirmed' }));
  const rejected = await run([...fixture.args, '--diagnostics-dir', fixture.diagnostics], audit.preload);
  assert.equal(rejected.code, 1); assert.equal(rejected.stdout, ''); assert.match(rejected.stderr, /COMPANY_READONLY_POLICY_UNCONFIRMED/u);
  assert.equal(audit.read().spawns, 0); assert.equal(audit.read().registrationAccesses, 0);
  assert.equal(fs.existsSync(fixture.runtime), false); assert.equal(fs.existsSync(fixture.diagnostics), false);
  assert.equal(fixture.snapshot(), before);
});

test('diagnostic locations overlapping source, runtime, harness or input files are refused before creation', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), before = fixture.snapshot(), audit = auditPreload(fixture);
  const harnessChild = resolve(`synthetic-diagnostics-${randomUUID()}`);
  for (const destination of [join(fixture.root, 'diagnostics'), join(fixture.runtime, 'diagnostics'), harnessChild,
    fixture.policyFile, fixture.registrationFile]) {
    const rejected = await run([...fixture.args, '--diagnostics-dir', destination], audit.preload);
    assert.equal(rejected.code, 1); assert.equal(rejected.stdout, ''); assert.equal(audit.read().spawns, 0);
    assert.equal(fs.existsSync(fixture.runtime), false); assert.equal(fs.existsSync(fixture.diagnostics), false);
  }
  assert.equal(fs.existsSync(harnessChild), false); assert.equal(fixture.snapshot(), before);
});

test('diagnostic write failure after commit stays unknown without retry and is recovered by inspecting the same task', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), before = fixture.snapshot(), audit = auditPreload(fixture, true);
  const failed = await run([...fixture.args, '--diagnostics-dir', fixture.diagnostics], audit.preload), value = body(failed);
  assert.equal(failed.code, 1); assert.equal(value.runStatus, 'unknown'); assert.equal(value.reason, 'worker_failed');
  assert.equal(value.exitConfirmed, true); assert.equal(value.automaticRetry, false);
  assert.equal(audit.read().spawns, 1); assert.equal(audit.read().diagnosticWriteFailures, 1);
  metadataOnly(failed.stdout + failed.stderr, fixture);
  const id = value.taskId as string;
  assert.deepEqual(fs.readdirSync(fixture.diagnostics), []); assert.equal(receipt(fixture, id, 'result').status, 'unknown');
  const inspected = success(await run(['company-readonly-v3-inspect', '--task', id, '--data-dir', fixture.runtime]), 'AWAITING_APPROVAL');
  assert.equal(inspected.taskId, id); assert.equal(inspected.preparationRunStatus, 'unknown'); assert.equal(inspected.reviewAvailable, true);
  assert.equal(databaseState(fixture).preparations, 1); assert.equal(databaseState(fixture).payloads, 1);
  assert.deepEqual(fs.readdirSync(join(fixture.runtime, 'runs')).sort(), [`result-${id}.json`, `run-${id}.json`]);
  assert.equal(fixture.snapshot(), before);
});

test('copied or tampered diagnostic records reject a new plan before creating its runtime', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), before = fixture.snapshot();
  const prepared = success(await run([...fixture.args, '--diagnostics-dir', fixture.diagnostics]), 'AWAITING_APPROVAL');
  const id = prepared.taskId as string, path = join(fixture.diagnostics, `diagnostic-v3-${id}.json`);
  const original = fs.readFileSync(path, 'utf8'), copied = join(fixture.directory, 'copied-diagnostics');
  fs.cpSync(fixture.diagnostics, copied, { recursive: true });
  const audit = auditPreload(fixture);
  for (const kind of ['copied', 'tampered'] as const) {
    if (kind === 'tampered') {
      const record = JSON.parse(original) as Record<string, unknown>;
      fs.writeFileSync(path, JSON.stringify({ ...record, reason: 'deadline' }));
    }
    const runtime = join(fixture.directory, `runtime-${kind}`), diagnostics = kind === 'copied' ? copied : fixture.diagnostics;
    const rejected = await run([...fixture.args.slice(0, -1), runtime, '--diagnostics-dir', diagnostics], audit.preload);
    assert.equal(rejected.code, 1); assert.equal(rejected.stdout, ''); assert.equal(audit.read().spawns, 0);
    assert.equal(fs.existsSync(runtime), false);
  }
  assert.equal(fs.readFileSync(join(copied, `diagnostic-v3-${id}.json`), 'utf8'), original);
  assert.equal(fixture.snapshot(), before);
});

test('a synthetic worktree mismatch retains only its fixed code and remains absent on same-ID inspection', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), changedPath = join(fixture.root, fixture.selectedPaths[0]!);
  const changedText = 'export const syntheticChangedValue = 123;\n';
  fs.writeFileSync(changedPath, changedText);
  const before = sourceMetadata(fixture), audit = auditPreload(fixture);
  const failed = await run([...fixture.args, '--diagnostics-dir', fixture.diagnostics], audit.preload), value = body(failed);
  assert.equal(failed.code, 1); assert.equal(value.runStatus, 'unknown'); assert.equal(value.reason, 'worker_failed');
  assert.equal(value.exitConfirmed, true); assert.equal(value.automaticRetry, false); assert.equal(audit.read().spawns, 1);
  assert.equal(Object.hasOwn(value, 'workerFailureCode'), false); metadataOnly(failed.stdout + failed.stderr, fixture);
  const id = value.taskId as string, path = join(fixture.diagnostics, `diagnostic-v3-${id}.json`);
  const record = await readCompanyV3Diagnostic(fixture.diagnostics, fixture.runtime, id);
  assert.equal(record.version, 'company-readonly-v3-diagnostic-record-v2');
  assert.equal(record.workerFailureCode, 'COMPANY_GIT_RANGE_SOURCE_CHANGED'); assert.equal(record.failure, null);
  assert.equal(record.auditExpiresAt, receipt(fixture, id, 'run').auditExpiresAt);
  assert.equal(receipt(fixture, id, 'result').status, 'unknown');
  const diagnosticBytes = fs.readFileSync(path, 'utf8'); metadataOnly(diagnosticBytes, fixture);
  assert.equal((diagnosticBytes + failed.stdout + failed.stderr).includes(changedText.trim()), false);
  const inspected = success(await run(['company-readonly-v3-inspect', '--task', id, '--data-dir', fixture.runtime]), 'NOT_FOUND');
  assert.equal(inspected.preparationRunStatus, 'unknown'); assert.equal(inspected.reviewAvailable, false);
  assert.equal(Object.hasOwn(inspected, 'workerFailureCode'), false);
  const stored = databaseState(fixture); assert.equal(stored.preparations, 0); assert.equal(stored.payloads, 0);
  assert.equal(fs.readFileSync(path, 'utf8'), diagnosticBytes); assert.equal(sourceMetadata(fixture), before);
});

test('an unsafe synthetic worker emits a bound fixed code before receipt access only with diagnostics enabled', { timeout: 30_000 }, async context => {
  const fixture = await setup(context), before = fixture.snapshot(), taskId = randomUUID();
  for (const diagnostics of [false, true]) {
    const options = { version: 'company-readonly-v3-worker-input-v1', command: 'plan',
      gitProfileHash: fixture.registration.gitProfileHash, guardPolicyHash: fixture.registration.guardPolicyHash,
      sourceDirectory: resolve('.'), runtimeDirectory: fixture.runtime, taskId, startedAt: new Date().toISOString(),
      policyFile: fixture.policyFile, registrationFile: fixture.registrationFile,
      policyHash: 'a'.repeat(64), registrationHash: 'b'.repeat(64),
      ...(diagnostics ? { diagnosticsVersion: COMPANY_V3_DIAGNOSTIC_VERSION } : {}) };
    const result = await new Promise<CommandResult>((done, reject) => {
      // Deliberately omit Node permissions; the worker must reject before touching its synthetic receipt or source.
      const child = spawn(process.execPath, [resolve('dist/src/cli/company-readonly-v3-worker.js'), JSON.stringify(options)],
        { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' } });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /COMPANY_READONLY_V3_UNSAFE_WORKER\n$/u);
    assert.equal(parseCompanyV3WorkerFailure(Buffer.from(result.stderr), taskId), diagnostics ? 'COMPANY_READONLY_V3_UNSAFE_WORKER' : null);
    if (!diagnostics) assert.equal(result.stderr, 'COMPANY_READONLY_V3_UNSAFE_WORKER\n');
    metadataOnly(result.stderr, fixture);
    assert.equal(fs.existsSync(fixture.runtime), false); assert.equal(fs.existsSync(fixture.diagnostics), false);
    assert.equal(fixture.snapshot(), before);
  }
});

test('an out-of-file synthetic range records the excerpt branch while preserving the public failure and empty store', { timeout: 30_000 }, async context => {
  const fixture = await setup(context);
  const registration = { ...fixture.registration, readRanges: fixture.registration.readRanges.map(range =>
    range.path === 'src/main.ts' ? { ...range, endLine: 2 } : range) };
  fs.writeFileSync(fixture.registrationFile, JSON.stringify(registration), { mode: 0o600 });
  const before = sourceMetadata(fixture);
  const failed = await run([...fixture.args, '--diagnostics-dir', fixture.diagnostics]), value = body(failed);
  assert.equal(failed.code, 1); assert.equal(value.runStatus, 'unknown'); assert.equal(value.reason, 'worker_failed');
  assert.equal(value.exitConfirmed, true); assert.equal(value.automaticRetry, false);
  assert.equal(Object.hasOwn(value, 'sourceFailureReason'), false); assert.equal(Object.hasOwn(value, 'workerFailureCode'), false);
  metadataOnly(failed.stdout + failed.stderr, fixture);
  const id = value.taskId as string, record = await readCompanyV3Diagnostic(fixture.diagnostics, fixture.runtime, id);
  assert.equal(record.version, 'company-readonly-v3-diagnostic-record-v3');
  assert.equal(record.workerFailureCode, 'COMPANY_GIT_RANGE_INVALID_SOURCE');
  assert.equal(record.sourceFailureReason, 'excerpt'); assert.equal(record.failure, null);
  metadataOnly(JSON.stringify(record), fixture);
  const inspected = success(await run(['company-readonly-v3-inspect', '--task', id, '--data-dir', fixture.runtime]), 'NOT_FOUND');
  assert.equal(inspected.reviewAvailable, false); assert.equal(inspected.preparationRunStatus, 'unknown');
  const stored = databaseState(fixture); assert.equal(stored.preparations, 0); assert.equal(stored.payloads, 0);
  assert.equal(sourceMetadata(fixture), before);
});
