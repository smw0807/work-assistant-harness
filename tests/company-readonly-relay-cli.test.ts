import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SqliteCompanyRelayStore } from '../src/adapters/sqlite-company-relay-store.js';
import { SqliteCompanyReadonlyV3Store } from '../src/adapters/sqlite-company-readonly-v3-store.js';
import { prepareCompanyV3Directory } from '../src/cli/company-readonly-v3-files.js';
import { pruneCompanyRelayReviews, writeCompanyRelayReview } from '../src/cli/company-relay-review.js';
import { companyRelaySummary, parseCompanyRelaySummary, parseCompanyRelayWorkerOptions } from '../src/cli/company-relay-protocol.js';
import type { CompanyRelayAuthorization, CompanyRelayReport } from '../src/domain/company-relay.js';
import { READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS } from '../src/domain/readonly-relay.js';
import { createCompanyReadonlyPreparationV3 } from '../src/policy/company-readonly-v3.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
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
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-relay-cli-'))); fs.chmodSync(root, 0o700);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const preparation = join(root, 'preparation'), runtime = join(root, 'relay'), authorizationFile = join(root, 'company-relay-authorization.json');
  await prepareCompanyV3Directory(preparation, true);
  const input = fixture.prepareInput(), now = { ...fixture.context, now: new Date() };
  const value = createCompanyReadonlyPreparationV3(input.registration, input.policy, input.observation, input.collected, input.budget, now, input.id);
  const store = new SqliteCompanyReadonlyV3Store(join(preparation, 'store/company-readonly-v3.sqlite'));
  try { store.create(value.plan, value.payload, now); } finally { store.close(); }
  const authorization: CompanyRelayAuthorization = { version: 'company-relay-authorization-v1', enabled: true, companyTransmissionApproved: true,
    providerTermsConfirmed: true, accountIdHash: hashReadonlyValue('synthetic-account-123'),
    config: { enabled: true, policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/codex', codexSha256: 'a'.repeat(64),
      model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 } };
  fs.writeFileSync(authorizationFile, JSON.stringify(authorization), { mode: 0o600 });
  const planArgs = ['company-relay-plan', '--mode', 'live', '--preparation-task', input.id,
    '--authorization', authorizationFile, '--preparation-data-dir', preparation, '--data-dir', runtime];
  return { ...fixture, directory: root, preparation, runtime, planArgs, authorization, authorizationFile, preparationPlan: value.plan,
    current: () => ({ ...fixture.context, now: new Date() }) };
};
const success = (result: Awaited<ReturnType<typeof run>>, status: string) => {
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const body = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(body.status, status); assert.equal(body.runStatus, 'succeeded'); assert.equal(body.exitConfirmed, true);
  assert.equal(body.mode, 'live'); assert.equal(body.executionAllowed, false); assert.equal(body.automaticRetry, false);
  return body;
};
const metadataOnly = (text: string, fixture: Awaited<ReturnType<typeof setup>>) => {
  for (const value of [fixture.root, fixture.registration.question, fixture.policy.policyReference!, ...fixture.selectedPaths]) assert.equal(text.includes(value), false);
};

test('company relay CLI plans, reviews exact bytes and separately approves without constructing native transport', { timeout: 60_000 }, async context => {
  const h = await setup(context), before = h.snapshot(), plannedOutput = await run(h.planArgs);
  const planned = success(plannedOutput, 'AWAITING_APPROVAL'); metadataOnly(plannedOutput.stdout, h);
  const id = String(planned.taskId), query = ['--task', id, '--data-dir', h.runtime];
  assert.equal(planned.expiresAt, h.preparationPlan.expiresAt); assert.equal(planned.verification, 'not_run');
  assert.equal(success(await run(h.planArgs), 'AWAITING_APPROVAL').taskId, id);
  const reviewed = await run(['company-relay-review', ...query]);
  assert.equal(success(reviewed, 'AWAITING_APPROVAL').reviewAvailable, true); metadataOnly(reviewed.stdout, h);
  const reviewFile = join(h.runtime, 'reviews', `${id}.json`), view = JSON.parse(fs.readFileSync(reviewFile, 'utf8')) as Record<string, unknown>;
  const db = new SqliteCompanyRelayStore(join(h.runtime, 'store/company-relay.sqlite'));
  try {
    const snapshot = db.inspect(id, h.current());
    assert.deepEqual(view.requestEnvelope, snapshot.payload!.requestEnvelope);
    assert.equal(view.expiresAt, snapshot.plan.expiresAt); assert.equal(JSON.stringify(view).includes(h.root), false);
    assert.equal(fs.statSync(reviewFile).mode & 0o7777, 0o600);
  } finally { db.close(); }
  const action = ['--mode', 'live', ...query, '--plan-hash', String(planned.planHash), '--authorization', h.authorizationFile, '--preparation-data-dir', h.preparation];
  const approved = success(await run(['company-relay-approve', ...action, '--expires-in-minutes', '10']), 'APPROVED');
  assert.equal(approved.attempts, 0); assert.equal(approved.dispatchReservations, 0); assert.equal(approved.verification, 'not_run');
  assert.deepEqual(fs.readdirSync(join(h.runtime, 'readonly-relay-runs')), []);
  success(await run(['company-relay-cancel', ...query]), 'CANCELLED');
  assert.equal(fs.existsSync(reviewFile), false); assert.notEqual((await run(['company-relay-review', ...query])).code, 0);
  assert.deepEqual(h.snapshot(), before);
});

test('company relay CLI denies disabled policy, wrong mode and target overlap before runtime creation', async context => {
  const h = await setup(context), before = h.snapshot();
  assert.notEqual((await run(h.planArgs.map(value => value === 'live' ? 'mock' : value))).code, 0);
  for (const key of ['enabled', 'companyTransmissionApproved', 'providerTermsConfirmed'] as const) {
    fs.writeFileSync(h.authorizationFile, JSON.stringify({ ...h.authorization, [key]: false }));
    assert.notEqual((await run(h.planArgs)).code, 0); assert.equal(fs.existsSync(h.runtime), false);
  }
  fs.writeFileSync(h.authorizationFile, JSON.stringify(h.authorization));
  const overlapping = join(h.root, 'not-created');
  assert.notEqual((await run(h.planArgs.map(value => value === h.runtime ? overlapping : value))).code, 0);
  assert.equal(fs.existsSync(overlapping), false); assert.deepEqual(h.snapshot(), before);
});

test('company relay review displays validated fake report and expires with original payload', async context => {
  const h = await setup(context), planned = success(await run(h.planArgs), 'AWAITING_APPROVAL'), id = String(planned.taskId);
  const store = new SqliteCompanyRelayStore(join(h.runtime, 'store/company-relay.sqlite'));
  try {
    const request = { investigationId: id, planHash: String(planned.planHash) }, current = h.current();
    store.approve({ ...request, expiresInMinutes: 10 }, current);
    const claimed = store.claim(request, current), payload = store.dispatch(id, claimed.attempt!.id, current);
    const selected = payload.preparation.collected.evidence[0]!;
    const result = { classification: 'question' as const, summary: 'Synthetic report.', facts: [{ text: 'A synthetic excerpt.', references: [{ evidenceId: selected.evidenceId, startLine: selected.startLine, endLine: selected.endLine }] }],
      hypotheses: [], answerDraft: 'Synthetic only.', questions: [], suggestions: [], limitations: ['No actual model.'] };
    const report: CompanyRelayReport = { version: 'company-relay-report-v1', investigationId: id, planHash: claimed.plan.planHash,
      preparationId: claimed.plan.preparation.id, createdAt: current.now.toISOString(), mode: 'live', transport: 'codex-cli-relay', result,
      resultHash: hashReadonlyValue(canonicalReadonlyJson(result)), responseHash: 'a'.repeat(64), finalTextHash: hashReadonlyValue(canonicalReadonlyJson(result)),
      verification: { transport: 'fake', upstreamCalls: 1, isolation: 'not_run', credentialAccess: 'not_run', responseValidation: 'codex-native-output-v1', relayCompleted: true, credentialReflection: 'passed' },
      unverifiedResponseChecks: READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS, sourceUnchanged: true, semanticAccuracyVerified: false,
      realModel: 'not_run', nativeExecution: 'not_run', credentialAccess: 'not_run', externalTransmission: 'not_run', executionAllowed: false };
    store.finish(id, claimed.attempt!.id, report, null, current);
    await writeCompanyRelayReview(h.runtime, store, id, current, () => current.now);
    const file = join(h.runtime, 'reviews', `${id}.json`);
    assert.deepEqual((JSON.parse(fs.readFileSync(file, 'utf8')) as { report: unknown }).report, report);
    await pruneCompanyRelayReviews(h.runtime, store, { ...current, now: new Date(claimed.plan.expiresAt) });
    assert.equal(fs.existsSync(file), false);
    await assert.rejects(writeCompanyRelayReview(h.runtime, store, id, { ...current, now: new Date(claimed.plan.expiresAt) }));
  } finally { store.close(); }
});

test('company relay review never follows a symlink or removes unrelated files', async context => {
  const h = await setup(context), planned = success(await run(h.planArgs), 'AWAITING_APPROVAL'), id = String(planned.taskId);
  const store = new SqliteCompanyRelayStore(join(h.runtime, 'store/company-relay.sqlite'));
  try {
    const outside = join(h.directory, 'canary.json'), file = join(h.runtime, 'reviews', `${id}.json`);
    fs.writeFileSync(outside, 'synthetic canary', { mode: 0o600 }); fs.symlinkSync(outside, file);
    await assert.rejects(writeCompanyRelayReview(h.runtime, store, id, h.current()));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic canary'); assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
    fs.unlinkSync(file); fs.writeFileSync(join(h.runtime, 'reviews/unrelated.json'), '{}', { mode: 0o600 });
    await assert.rejects(pruneCompanyRelayReviews(h.runtime, store, h.current()));
    assert.equal(fs.existsSync(join(h.runtime, 'reviews/unrelated.json')), true);
  } finally { store.close(); }
});

test('company relay parent strips ambient credentials and runs planning with no network or child permissions', async context => {
  const h = await setup(context), audit = join(h.directory, 'audit.json'), preload = join(h.directory, 'audit.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawn;
cp.spawn=function(executable,args,options){
 const child=original(executable,args,options);
 if(args.some(value=>value.endsWith('/company-relay-worker.js'))){
 fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify({args:args.slice(0,-1),env:options.env}),{mode:0o600});
 const emit=child.stdout.emit;child.stdout.emit=function(event,...rest){return event==='data'?true:Reflect.apply(emit,this,[event,...rest]);}; }
 return child;
};syncBuiltinESMExports();`, { mode: 0o600 });
  const result = await run(h.planArgs, preload, { OPENAI_API_KEY: 'synthetic-canary', HTTPS_PROXY: 'https://synthetic.invalid' });
  assert.equal(result.code, 1);
  const unknown = JSON.parse(result.stdout) as { runStatus: string; taskId: string; automaticRetry: boolean };
  assert.equal(unknown.runStatus, 'unknown'); assert.equal(unknown.automaticRetry, false);
  const observed = JSON.parse(fs.readFileSync(audit, 'utf8')) as { args: string[]; env: Record<string, string> };
  assert.deepEqual(observed.env, { LANG: 'C.UTF-8', TZ: 'UTC' });
  assert.equal(observed.args.includes('--allow-net'), false); assert.equal(observed.args.includes('--allow-child-process'), false);
  assert.equal(observed.args.includes('--permission'), true); assert.equal(observed.args.includes('--max-old-space-size=128'), true);
  assert.equal(success(await run(['company-relay-inspect', '--task', unknown.taskId, '--data-dir', h.runtime]), 'AWAITING_APPROVAL').attempts, 0);
});

test('company relay protocol rejects malformed worker and forged public execution claims', () => {
  const empty = companyRelaySummary('prune', null);
  assert.deepEqual(parseCompanyRelaySummary(JSON.stringify(empty), 'prune', null), empty);
  for (const edit of [{ verification: 'live' }, { executionAllowed: true }, { reportAvailable: true }, { reviewAvailable: true }, { mode: 'mock' }, { body: 'synthetic' }]) {
    assert.throws(() => parseCompanyRelaySummary(JSON.stringify({ ...empty, ...edit }), 'prune', null));
  }
  const worker = { version: 'company-relay-worker-v1', command: 'prune', sourceDirectory: '/private/tmp/source', runtimeDirectory: '/private/tmp/relay',
    preparationDirectory: null, authorizationFile: null, ipcDirectory: null, preparationId: null, taskId: null, planHash: null, expiresInMinutes: null };
  assert.deepEqual(parseCompanyRelayWorkerOptions(JSON.stringify(worker)), worker);
  assert.throws(() => parseCompanyRelayWorkerOptions(JSON.stringify({ ...worker, authorizationFile: '/private/tmp/ignored' })));
});

test('unapproved company run enters only trusted controller and never creates native artifacts or consumes approval', async context => {
  const h = await setup(context), planned = success(await run(h.planArgs), 'AWAITING_APPROVAL');
  const audit = join(h.directory, 'run-audit.json'), preload = join(h.directory, 'run-audit.mjs');
  fs.writeFileSync(preload, `import fs from'node:fs';import cp from'node:child_process';import{syncBuiltinESMExports}from'node:module';
const original=cp.spawn;cp.spawn=function(executable,args,options){if(args.some(value=>value.endsWith('/company-relay-worker.js')))fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify({args,env:options.env}),{mode:0o600});return Reflect.apply(original,this,[executable,args,options]);};syncBuiltinESMExports();`, { mode: 0o600 });
  const result = await run(['company-relay-run', '--mode', 'live', '--task', String(planned.taskId), '--plan-hash', String(planned.planHash),
    '--authorization', h.authorizationFile, '--preparation-data-dir', h.preparation, '--data-dir', h.runtime], preload);
  assert.equal(result.code, 1);
  const observed = JSON.parse(fs.readFileSync(audit, 'utf8')) as { args: string[]; env: Record<string, string> };
  assert.deepEqual(observed.args.slice(0, -1), ['--max-old-space-size=128', resolve('dist/src/cli/company-relay-worker.js')]);
  assert.deepEqual(observed.env, { LANG: 'C.UTF-8', TZ: 'UTC' });
  const ipc = (JSON.parse(observed.args.at(-1)!) as { ipcDirectory: string }).ipcDirectory;
  assert.equal(fs.existsSync(ipc), false); assert.deepEqual(fs.readdirSync(join(h.runtime, 'readonly-relay-runs')), []);
  const inspected = success(await run(['company-relay-inspect', '--task', String(planned.taskId), '--data-dir', h.runtime]), 'AWAITING_APPROVAL');
  assert.equal(inspected.attempts, 0); assert.equal(inspected.approval, 'none'); assert.equal(inspected.verification, 'not_run');
});
