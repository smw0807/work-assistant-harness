import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SqliteCompanyInvestigationStore } from '../src/adapters/sqlite-company-investigation-store.js';
import { SqliteCompanyReadonlyV3Store } from '../src/adapters/sqlite-company-readonly-v3-store.js';
import { prepareCompanyV3Directory } from '../src/cli/company-readonly-v3-files.js';
import { createCompanyReadonlyPreparationV3 } from '../src/policy/company-readonly-v3.js';
import { createCompanyReadonlyV3Fixture } from './company-readonly-v3-fixture.js';

const run = (args: string[], preload?: string, extraEnv: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), resolve('dist/src/cli/main.js'), ...args],
    { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', ...extraEnv } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
});
const setup = async (context: TestContext) => {
  const fixture = await createCompanyReadonlyV3Fixture(context);
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-investigation-cli-'))); fs.chmodSync(root, 0o700);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preparation = join(root, 'preparation'), runtime = join(root, 'investigation');
  await prepareCompanyV3Directory(preparation, true);
  const input = fixture.prepareInput(), now = { ...fixture.context, now: new Date() };
  const value = createCompanyReadonlyPreparationV3(input.registration, input.policy, input.observation, input.collected, input.budget, now, input.id);
  const store = new SqliteCompanyReadonlyV3Store(join(preparation, 'store/company-readonly-v3.sqlite'));
  try { store.create(value.plan, value.payload, now); } finally { store.close(); }
  const planArgs = ['company-investigation-plan', '--mode', 'mock', '--preparation-task', input.id,
    '--preparation-data-dir', preparation, '--data-dir', runtime];
  return { ...fixture, directory: root, preparation, runtime, planArgs, preparationPlan: value.plan };
};
const success = (result: Awaited<ReturnType<typeof run>>, status: string) => {
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const body = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(body.status, status); assert.equal(body.runStatus, 'succeeded'); assert.equal(body.exitConfirmed, true);
  assert.equal(body.mode, 'mock'); assert.equal(body.automaticRetry, false);
  for (const key of ['transmissionAllowed', 'executionAllowed']) assert.equal(body[key], false);
  for (const key of ['nativeExecution', 'realModel', 'credentialAccess', 'externalTransmission']) assert.equal(body[key], 'not_run');
  return body;
};
const metadataOnly = (text: string, fixture: Awaited<ReturnType<typeof setup>>) => {
  for (const value of [fixture.root, fixture.registration.question, fixture.policy.policyReference!, ...fixture.selectedPaths]) assert.equal(text.includes(value), false);
};

test('company mock CLI completes plan, separate approval, one invocation and persisted cited report without source writes', { timeout: 60_000 }, async context => {
  const fixture = await setup(context), before = fixture.snapshot();
  const first = await run(fixture.planArgs), planned = success(first, 'AWAITING_APPROVAL'); metadataOnly(first.stdout, fixture);
  const id = String(planned.taskId), planHash = String(planned.planHash);
  const query = ['--task', id, '--data-dir', fixture.runtime];
  const action = ['--mode', 'mock', ...query, '--plan-hash', planHash, '--preparation-data-dir', fixture.preparation];
  assert.equal(planned.expiresAt, fixture.preparationPlan.expiresAt);
  assert.equal(planned.auditExpiresAt, fixture.preparationPlan.auditExpiresAt);
  assert.notEqual((await run(['company-investigation-run', ...action])).code, 0);
  assert.equal(success(await run(['company-investigation-inspect', ...query]), 'AWAITING_APPROVAL').attempts, 0);
  success(await run(['company-investigation-approve', ...action, '--expires-in-minutes', '10']), 'APPROVED');
  const result = await run(['company-investigation-run', ...action]), reported = success(result, 'REPORTED'); metadataOnly(result.stdout, fixture);
  assert.equal(reported.mockCalls, 1); assert.equal(reported.attempts, 1); assert.equal(reported.reportAvailable, true);
  const stored = new SqliteCompanyInvestigationStore(join(fixture.runtime, 'store/company-investigation.sqlite'));
  try {
    const snapshot = stored.inspect(id, { ...fixture.context, now: new Date() });
    assert.ok(snapshot.report?.result.facts.length); assert.equal(snapshot.report!.semanticAccuracyVerified, false);
    assert.ok(snapshot.approval?.usedAt); assert.ok(snapshot.attempt?.endedAt);
  } finally { stored.close(); }
  assert.notEqual((await run(['company-investigation-run', ...action])).code, 0);
  assert.equal(success(await run(fixture.planArgs), 'REPORTED').taskId, id);
  assert.equal(success(await run(['company-investigation-inspect', ...query]), 'REPORTED').mockCalls, 1);
  assert.equal(success(await run(['company-investigation-cancel', ...query]), 'CANCELLED').reportAvailable, false);
  success(await run(['company-investigation-prune', '--data-dir', fixture.runtime]), 'PRUNED');
  assert.deepEqual(fixture.snapshot(), before);
  for (const directory of [fixture.runtime, join(fixture.runtime, 'store')]) assert.equal(fs.lstatSync(directory).mode & 0o7777, 0o700);
  assert.equal(fs.lstatSync(join(fixture.runtime, 'store/company-investigation.sqlite')).mode & 0o7777, 0o600);
});

test('company mock CLI rejects live mode, unknown options and target overlap before creating investigation storage', async context => {
  const fixture = await setup(context), before = fixture.snapshot();
  assert.notEqual((await run(fixture.planArgs.map(value => value === 'mock' ? 'live' : value))).code, 0);
  assert.notEqual((await run([...fixture.planArgs, '--config', '/unavailable-private-config'])).code, 0);
  assert.equal(fs.existsSync(fixture.runtime), false);
  const overlapping = join(fixture.root, 'not-created');
  assert.notEqual((await run(fixture.planArgs.map(value => value === fixture.runtime ? overlapping : value))).code, 0);
  assert.equal(fs.existsSync(overlapping), false); assert.deepEqual(fixture.snapshot(), before);
});

test('company mock CLI drops environment credentials and bounds worker permissions; lost reply remains unknown without replay', async context => {
  const fixture = await setup(context), audit = join(fixture.directory, 'audit.json'), preload = join(fixture.directory, 'audit.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawn,originalPreflight=cp.execFileSync;
const observed={preflight:null,worker:null};
const save=()=>fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify(observed),{mode:0o600});
cp.execFileSync=function(executable,args,options){
 if(args.some(value=>value.endsWith('/company-investigation-preflight.js'))){
  observed.preflight={args:args.slice(0,-1),env:options.env,timeout:options.timeout,maxBuffer:options.maxBuffer,killSignal:options.killSignal};save();
 }
 return Reflect.apply(originalPreflight,this,[executable,args,options]);
};
cp.spawn=function(executable,args,options){
 const child=original(executable,args,options);
 if(!args.some(value=>value.endsWith('/company-investigation-worker.js')))return child;
 observed.worker={args:args.slice(0,-1),env:options.env};save();
 const emit=child.stdout.emit; child.stdout.emit=function(event,...rest){return event==='data'?true:Reflect.apply(emit,this,[event,...rest]);};
 return child;
}; syncBuiltinESMExports();
`, { mode: 0o600 });
  const result = await run(fixture.planArgs, preload, { OPENAI_API_KEY: 'synthetic-canary', HTTPS_PROXY: 'https://synthetic.invalid' });
  assert.equal(result.code, 1);
  const unknown = JSON.parse(result.stdout) as { runStatus: string; taskId: string; exitConfirmed: boolean; automaticRetry: boolean };
  assert.equal(unknown.runStatus, 'unknown'); assert.equal(unknown.exitConfirmed, true); assert.equal(unknown.automaticRetry, false);
  const observed = JSON.parse(fs.readFileSync(audit, 'utf8')) as {
    worker: { args: string[]; env: Record<string, string> };
    preflight: { args: string[]; env: Record<string, string>; timeout: number; maxBuffer: number; killSignal: string };
  };
  assert.deepEqual(observed.worker.env, { LANG: 'C.UTF-8', TZ: 'UTC' });
  assert.deepEqual(observed.worker.args, ['--max-old-space-size=128', '--permission', '--allow-fs-read=*',
    `--allow-fs-write=${join(fixture.runtime, 'store')}`, `--allow-fs-write=${join(fixture.preparation, 'store')}`,
    resolve('dist/src/cli/company-investigation-worker.js')]);
  assert.deepEqual(observed.preflight.env, { LANG: 'C.UTF-8', TZ: 'UTC' });
  assert.deepEqual(observed.preflight.args, ['--max-old-space-size=128', '--permission', '--allow-fs-read=*',
    `--allow-fs-write=${join(fixture.preparation, 'store')}`, resolve('dist/src/cli/company-investigation-preflight.js')]);
  assert.equal(observed.preflight.timeout, 30_000); assert.equal(observed.preflight.maxBuffer, 8192); assert.equal(observed.preflight.killSignal, 'SIGKILL');
  const inspected = success(await run(['company-investigation-inspect', '--task', unknown.taskId, '--data-dir', fixture.runtime]), 'AWAITING_APPROVAL');
  assert.equal(inspected.attempts, 0); assert.equal(inspected.mockCalls, 0);
  metadataOnly(result.stdout + result.stderr, fixture);
});

test('company mock CLI rejects a changed preparation before approval without consuming an attempt', async context => {
  const fixture = await setup(context), planned = success(await run(fixture.planArgs), 'AWAITING_APPROVAL');
  const prepared = new SqliteCompanyReadonlyV3Store(join(fixture.preparation, 'store/company-readonly-v3.sqlite'));
  try { prepared.cancel(fixture.preparationPlan.id, { ...fixture.context, now: new Date() }); } finally { prepared.close(); }
  const query = ['--task', String(planned.taskId), '--data-dir', fixture.runtime];
  assert.notEqual((await run(['company-investigation-approve', '--mode', 'mock', ...query, '--plan-hash', String(planned.planHash),
    '--expires-in-minutes', '10', '--preparation-data-dir', fixture.preparation])).code, 0);
  assert.equal(success(await run(['company-investigation-inspect', ...query]), 'AWAITING_APPROVAL').attempts, 0);
});

test('independent company mock CLI processes cannot consume and dispatch the same approval twice', async context => {
  const fixture = await setup(context), before = fixture.snapshot(), planned = success(await run(fixture.planArgs), 'AWAITING_APPROVAL');
  const query = ['--task', String(planned.taskId), '--data-dir', fixture.runtime];
  const action = ['--mode', 'mock', ...query, '--plan-hash', String(planned.planHash), '--preparation-data-dir', fixture.preparation];
  success(await run(['company-investigation-approve', ...action, '--expires-in-minutes', '10']), 'APPROVED');
  const results = await Promise.all([run(['company-investigation-run', ...action]), run(['company-investigation-run', ...action])]);
  assert.equal(results.filter(result => result.code === 0).length, 1);
  const result = success(await run(['company-investigation-inspect', ...query]), 'REPORTED');
  assert.equal(result.attempts, 1); assert.equal(result.mockCalls, 1); assert.deepEqual(fixture.snapshot(), before);
});
