import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test, type TestContext } from 'node:test';
import { acquireSyntheticCompanyChangeControl } from '../src/adapters/synthetic-company-change-control.js';
import { SqliteSyntheticCompanyChangeStore } from '../src/adapters/sqlite-synthetic-company-change-store.js';
import { hashCompanyChangeValue } from '../src/policy/company-change.js';
import { superviseSyntheticChangeWorker } from '../src/cli/synthetic-company-change.js';
import { parseSyntheticChangeSummary, parseSyntheticChangeWorkerOptions, syntheticChangeBoundary,
  type SyntheticChangeWorkerOptions } from '../src/cli/synthetic-company-change-protocol.js';

interface Result { code: number | null; stdout: string; stderr: string }
const run = (args: string[], preload?: string): Promise<Result> => new Promise((done, reject) => {
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), resolve('dist/src/cli/main.js'), ...args], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1', SYNTHETIC_CHANGE_PARENT_ONLY: 'synthetic-parent-canary' },
  });
  let stdout = '', stderr = '';
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.once('error', reject); child.once('close', code => { clearTimeout(timeout); done({ code, stdout, stderr }); });
});
const setup = (context: TestContext) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'synthetic-change-cli-'))); fs.chmodSync(root, 0o700);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, 'runtime');
  return { root, runtime, draft: join(runtime, 'example-draft.json'), database: join(runtime, 'store', 'synthetic-company-change.sqlite') };
};
const argsFor = (command: string, runtime: string, taskId?: unknown) => [`synthetic-change-${command}`, '--data-dir', runtime,
  ...(taskId === undefined ? [] : ['--task', String(taskId)])];
const body = (result: Result): Record<string, unknown> => JSON.parse(result.stdout) as Record<string, unknown>;
const success = (result: Result, status: string): Record<string, unknown> => {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const value = body(result); assert.equal(value.status, status); assert.equal(value.runStatus, 'succeeded'); assert.equal(value.exitConfirmed, true);
  for (const [key, expected] of Object.entries(syntheticChangeBoundary)) assert.equal(value[key], expected);
  return value;
};
const initialize = async (fixture: ReturnType<typeof setup>) => success(await run(argsFor('init', fixture.runtime)), 'INITIALIZED');
const prepare = async (fixture: ReturnType<typeof setup>) => success(await run([...argsFor('plan', fixture.runtime), '--draft', fixture.draft]), 'AWAITING_APPROVAL');
const requestArgs = (command: string, fixture: ReturnType<typeof setup>, plan: Record<string, unknown>) => [
  ...argsFor(command, fixture.runtime, plan.taskId), '--plan-hash', String(plan.planHash), '--draft', fixture.draft,
  ...(command === 'approve' ? ['--expires-in-minutes', '10'] : []),
];
const repository = (runtime: string) => join(runtime, fs.readdirSync(runtime).find(name => /^company-change-synthetic-/u.test(name))!, 'repository');

test('separate CLI processes initialize, plan, approve and apply three synthetic changes without executing content', async context => {
  const fixture = setup(context); const initialized = await initialize(fixture);
  assert.equal(initialized.changeCount, 3); assert.equal(fs.statSync(fixture.draft).mode & 0o7777, 0o600);
  const repo = repository(fixture.runtime), canary = join(fixture.root, 'never-executed.txt');
  fs.writeFileSync(canary, 'unchanged', { mode: 0o600 });
  const draft = JSON.parse(fs.readFileSync(fixture.draft, 'utf8'));
  draft.changes[2].content = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(canary)}, 'executed');\n`;
  fs.writeFileSync(fixture.draft, JSON.stringify(draft));
  const preservedPaths = ['.git/index', '.git/refs/heads/main', 'README.md'];
  const before = preservedPaths.map(path => hashCompanyChangeValue(fs.readFileSync(join(repo, path))));
  const original = hashCompanyChangeValue(fs.readFileSync(join(repo, 'src/message.ts'))), plan = await prepare(fixture);
  assert.equal(hashCompanyChangeValue(fs.readFileSync(join(repo, 'src/message.ts'))), original);
  const inspected = success(await run(argsFor('inspect', fixture.runtime, plan.taskId)), 'AWAITING_APPROVAL');
  assert.equal(inspected.reportAvailable, true);
  const approved = success(await run(requestArgs('approve', fixture, plan)), 'APPROVED');
  assert.equal(success(await run(requestArgs('approve', fixture, plan)), 'APPROVED').approvalExpiresAt, approved.approvalExpiresAt);
  const applied = success(await run(requestArgs('apply', fixture, plan)), 'APPLIED'); assert.equal(applied.journalCount, 8);
  assert.equal(fs.readFileSync(join(repo, '.git/HEAD'), 'utf8'), 'ref: refs/heads/fix/synthetic-example\n');
  assert.equal(fs.readFileSync(join(repo, 'src/addition.ts'), 'utf8'), draft.changes[2].content);
  assert.deepEqual(preservedPaths.map(path => hashCompanyChangeValue(fs.readFileSync(join(repo, path)))), before);
  assert.equal(fs.readFileSync(canary, 'utf8'), 'unchanged');
  assert.equal((await run(requestArgs('apply', fixture, plan))).code, 1);
  success(await run(argsFor('inspect', fixture.runtime, plan.taskId)), 'APPLIED');
  const report = join(fixture.runtime, 'reports', `${plan.taskId}.json`), saved = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(saved.snapshot.status, 'APPLIED'); assert.equal(fs.statSync(report).mode & 0o7777, 0o600);
  for (const forbidden of [draft.objective, draft.changes[2].content, fixture.root]) {
    assert.equal(JSON.stringify(applied).includes(forbidden), false);
    assert.equal(fs.readFileSync(report, 'utf8').includes(forbidden), false);
  }
});

test('new CLI controller uses explicit trusted flags and removes inherited environment without changing old worker policy', async context => {
  const fixture = setup(context), audit = join(fixture.root, 'spawn.json'), preload = join(fixture.root, 'audit.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
const original=cp.spawn;cp.spawn=function(executable,args,options){fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify({args,env:options.env}),{mode:0o600});return original.call(this,executable,args,options)};syncBuiltinESMExports();`, { mode: 0o600 });
  success(await run(argsFor('init', fixture.runtime), preload), 'INITIALIZED');
  const observed = JSON.parse(fs.readFileSync(audit, 'utf8')) as { args: string[]; env: Record<string, string> };
  assert.deepEqual(observed.args.slice(0, 3), ['--no-addons', '--disable-proto=throw', '--max-old-space-size=128']);
  assert.equal(observed.args.includes('--permission'), false);
  assert.deepEqual(observed.env, { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' });
  assert.equal(observed.args.some(arg => arg.includes(preload)), false);
});

test('unknown commands, mode flags, duplicate flags and invalid TTLs are rejected before runtime creation', async context => {
  const fixture = setup(context);
  for (const args of [argsFor('run', fixture.runtime), [...argsFor('init', fixture.runtime), '--mode', 'live'],
    [...argsFor('init', fixture.runtime), '--data-dir', fixture.runtime],
    [...argsFor('approve', fixture.runtime, randomUUID()), '--plan-hash', 'a'.repeat(64), '--draft', fixture.draft, '--expires-in-minutes', '0']]) {
    const result = await run(args); assert.equal(result.code, 1); assert.equal(fs.existsSync(fixture.runtime), false);
    assert.match(result.stderr, /UNKNOWN_COMMAND|INVALID_ARGUMENTS/u);
  }
  const outside = await run(argsFor('init', '/synthetic-outside-temporary-root/never-created'));
  assert.equal(outside.code, 1); assert.match(outside.stderr, /SYNTHETIC_COMPANY_CHANGE_UNSAFE_RUNTIME/u);
});

test('foreign runtime contents, aliases and existing directories are refused without replacement', async context => {
  const fixture = setup(context); fs.mkdirSync(fixture.runtime, { mode: 0o700 });
  const marker = join(fixture.runtime, 'keep.txt'); fs.writeFileSync(marker, 'keep', { mode: 0o600 });
  assert.equal((await run(argsFor('init', fixture.runtime))).code, 1);
  assert.equal((await run([...argsFor('plan', fixture.runtime), '--draft', marker])).code, 1);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  const alias = join(fixture.root, 'alias'); fs.symlinkSync(fixture.runtime, alias);
  assert.equal((await run(argsFor('init', alias))).code, 1); assert.deepEqual(fs.readdirSync(fixture.runtime), ['keep.txt']);
});

test('draft JSON ambiguity, private permissions, symlinks and hardlinks fail without source changes', async context => {
  const fixture = setup(context); await initialize(fixture);
  const repo = repository(fixture.runtime), original = fs.readFileSync(fixture.draft, 'utf8');
  const source = hashCompanyChangeValue(fs.readFileSync(join(repo, 'src/message.ts')));
  fs.writeFileSync(fixture.draft, original.replace('"repoId":', '"repoId":"synthetic-discarded","repoId":'));
  assert.equal((await run([...argsFor('plan', fixture.runtime), '--draft', fixture.draft])).code, 1);
  fs.writeFileSync(fixture.draft, original); fs.chmodSync(fixture.draft, 0o644);
  assert.equal((await run([...argsFor('plan', fixture.runtime), '--draft', fixture.draft])).code, 1); fs.chmodSync(fixture.draft, 0o600);
  const link = join(fixture.root, 'draft-link.json'); fs.symlinkSync(fixture.draft, link);
  assert.equal((await run([...argsFor('plan', fixture.runtime), '--draft', link])).code, 1); fs.unlinkSync(link);
  fs.linkSync(fixture.draft, link); assert.equal((await run([...argsFor('plan', fixture.runtime), '--draft', fixture.draft])).code, 1);
  assert.equal(hashCompanyChangeValue(fs.readFileSync(join(repo, 'src/message.ts'))), source);
});

test('control lease blocks every concurrent command and cancellation remains terminal after release', async context => {
  const fixture = setup(context); await initialize(fixture); const plan = await prepare(fixture);
  const before = hashCompanyChangeValue(fs.readFileSync(fixture.database)), release = acquireSyntheticCompanyChangeControl(fixture.runtime);
  try {
    for (const command of ['inspect', 'cancel']) {
      const result = await run(argsFor(command, fixture.runtime, plan.taskId));
      assert.equal(result.code, 1); assert.equal(body(result).failureCode, 'SYNTHETIC_COMPANY_CHANGE_CONTROL_BUSY');
      assert.equal(body(result).automaticRetry, false); assert.equal(hashCompanyChangeValue(fs.readFileSync(fixture.database)), before);
    }
  } finally { release(); }
  success(await run(argsFor('cancel', fixture.runtime, plan.taskId)), 'CANCELLED');
  assert.equal((await run(requestArgs('approve', fixture, plan))).code, 1);
});

test('metadata recovery needs no proposal body, preserves a stale workspace lock and never resumes files', async context => {
  const fixture = setup(context); await initialize(fixture); const plan = await prepare(fixture);
  success(await run(requestArgs('approve', fixture, plan)), 'APPROVED');
  const store = new SqliteSyntheticCompanyChangeStore(fixture.database), request = { taskId: String(plan.taskId), planHash: String(plan.planHash) };
  try { store.claim(request, { ownerId: `os-user:${process.getuid!()}`, now: new Date() }); } finally { store.close(); }
  const repo = repository(fixture.runtime), lock = join(repo, '..', 'workspace.lock');
  fs.writeFileSync(lock, 'synthetic stale lock', { mode: 0o600 }); fs.unlinkSync(fixture.draft);
  const before = hashCompanyChangeValue(fs.readFileSync(join(repo, 'src/message.ts')));
  const args = [...argsFor('recover', fixture.runtime, plan.taskId), '--plan-hash', String(plan.planHash)];
  const recovered = success(await run(args), 'FAILED');
  assert.equal(recovered.failureCode, 'SYNTHETIC_COMPANY_CHANGE_INTERRUPTED'); assert.equal(recovered.observationAvailable, true);
  success(await run(args), 'FAILED'); assert.equal(fs.readFileSync(lock, 'utf8'), 'synthetic stale lock');
  assert.equal(hashCompanyChangeValue(fs.readFileSync(join(repo, 'src/message.ts'))), before);
  const report = JSON.parse(fs.readFileSync(join(fixture.runtime, 'reports', `${plan.taskId}.json`), 'utf8'));
  assert.equal(report.observation.branch, 'base'); assert.equal(report.snapshot.status, 'FAILED');
});

test('interrupted report temporary files are preserved and do not prevent inspection', async context => {
  const fixture = setup(context); await initialize(fixture); const plan = await prepare(fixture);
  const orphan = join(fixture.runtime, 'reports', `.synthetic-change-${randomUUID()}.tmp`);
  fs.writeFileSync(orphan, 'synthetic partial metadata', { mode: 0o600 });
  success(await run(argsFor('inspect', fixture.runtime, plan.taskId)), 'AWAITING_APPROVAL');
  assert.equal(fs.readFileSync(orphan, 'utf8'), 'synthetic partial metadata');
});

test('worker protocol and supervisor reject extra authority, excess output, elapsed deadlines and conflicting output', async () => {
  const options: SyntheticChangeWorkerOptions = { version: 'synthetic-change-worker-input-v1', command: 'init',
    harnessDirectory: '/synthetic/harness', runtimeDirectory: '/private/tmp/synthetic-only/runtime', taskId: null,
    draftFile: null, planHash: null, expiresInMinutes: null };
  assert.throws(() => parseSyntheticChangeWorkerOptions(JSON.stringify({ ...options, executionAllowed: true })));
  for (const [program, startedAt, expected] of [
    ["process.stdout.write('x'.repeat(16385)); setTimeout(()=>{},5000)", performance.now(), 'output_limit'],
    ['setTimeout(()=>{},5000)', performance.now() - 30_000, 'deadline'],
    ["process.stdout.write('{}'); process.stderr.write('unexpected');", performance.now(), 'invalid_output'],
  ] as const) {
    const child = spawn(process.execPath, ['-e', program], { env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' } });
    child.stdin.end();
    const result = await superviseSyntheticChangeWorker(child, options, startedAt);
    assert.equal(result.reason, expected); assert.equal(result.exitConfirmed, true); assert.equal(result.summary, null);
  }
});

test('worker summaries cannot falsely claim command success or complete application without every journal pair', () => {
  const options: SyntheticChangeWorkerOptions = { version: 'synthetic-change-worker-input-v1', command: 'apply',
    harnessDirectory: '/synthetic/harness', runtimeDirectory: '/private/tmp/synthetic-only/runtime', taskId: randomUUID(),
    draftFile: '/private/tmp/synthetic-only/runtime/example-draft.json', planHash: 'a'.repeat(64), expiresInMinutes: null };
  const summary = { version: 'synthetic-change-result-v1', command: 'apply', taskId: options.taskId, status: 'APPLIED',
    planHash: options.planHash, draftHash: 'b'.repeat(64), baseCommit: 'c'.repeat(40), indexHash: 'd'.repeat(64),
    changeCount: 3, journalCount: 8, approvalExpiresAt: '2026-01-01T00:01:00.000Z', failureCode: null,
    reportAvailable: false, observationAvailable: false, ...syntheticChangeBoundary };
  parseSyntheticChangeSummary(JSON.stringify(summary), options);
  for (const changed of [{ ...summary, journalCount: 7 }, { ...summary, approvalExpiresAt: null },
    { ...summary, status: 'APPROVED', journalCount: 0 }, { ...summary, status: 'FAILED' },
    { ...summary, status: 'AWAITING_APPROVAL', journalCount: 0 }]) assert.throws(() => parseSyntheticChangeSummary(JSON.stringify(changed), options));
  assert.throws(() => parseSyntheticChangeSummary(JSON.stringify({ ...summary, command: 'plan', status: 'APPROVED', journalCount: 0 }), { ...options, command: 'plan', planHash: null }));
  assert.throws(() => parseSyntheticChangeSummary(JSON.stringify({ ...summary, command: 'recover', status: 'FAILED',
    failureCode: 'SYNTHETIC_COMPANY_CHANGE_APPLY_FAILED', observationAvailable: true, reportAvailable: true }), { ...options, command: 'recover', draftFile: null }));
});

test('a valid worker FAILED apply outcome is reported as failure with exit one, not command success', async context => {
  const fixture = setup(context); await initialize(fixture); const plan = await prepare(fixture);
  const preload = join(fixture.root, 'failed-worker.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';
const original=cp.spawn;cp.spawn=function(executable,args,options){const input=JSON.parse(args.at(-1));const result=${JSON.stringify({
    ...plan, command: 'apply', status: 'FAILED', failureCode: 'SYNTHETIC_COMPANY_CHANGE_APPLY_FAILED',
    approvalExpiresAt: '2026-01-01T00:01:00.000Z', journalCount: 1, runStatus: undefined, exitConfirmed: undefined,
  })};result.taskId=input.taskId;return original.call(this,executable,['-e','process.stdout.write('+JSON.stringify(JSON.stringify(result))+')'],options)};syncBuiltinESMExports();`, { mode: 0o600 });
  const result = await run(requestArgs('apply', fixture, plan), preload);
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`); assert.equal(body(result).runStatus, 'failed');
  assert.equal(body(result).status, 'FAILED'); assert.equal(body(result).exitConfirmed, true); assert.equal(body(result).automaticRetry, false);
});
