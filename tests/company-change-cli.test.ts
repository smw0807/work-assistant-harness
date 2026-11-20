import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteCompanyChangeStore } from '../src/adapters/sqlite-company-change-store.js';
import { createCompanyChangePlan, hashCompanyChangeValue } from '../src/policy/company-change.js';
import { canonicalReadonlyJson } from '../src/policy/readonly-investigation-policy.js';
import { COMPANY_CHANGE_MAX_REVIEW_FILES, companyChangeReviewExists, prepareCompanyChangeRuntime, pruneCompanyChangeReviews,
  validateCompanyChangeRuntime, writeCompanyChangeReview } from '../src/cli/company-change-files.js';
import type { CompanyChangeSnapshot } from '../src/domain/company-change.js';
import { createCompanyChangeDraft } from './company-change-fixture.js';

interface Result { code: number | null; stdout: string; stderr: string }
const run = (args: string[], preload?: string): Promise<Result> => new Promise((done, reject) => {
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), resolve('dist/src/cli/main.js'), ...args], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1', COMPANY_CHANGE_TEST_CANARY: 'synthetic-parent-only' },
  });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.once('error', reject); child.once('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
});
const setup = (context: TestContext) => {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-change-cli-'))); fs.chmodSync(directory, 0o700);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const draft = createCompanyChangeDraft(), draftFile = join(directory, 'draft.json'), runtime = join(directory, 'runtime');
  fs.writeFileSync(draftFile, JSON.stringify(draft), { mode: 0o600 });
  return { directory, draft, draftFile, runtime, database: join(runtime, 'store', 'company-change.sqlite'),
    planArgs: ['company-change-plan', '--draft', draftFile, '--data-dir', runtime] };
};
const body = (result: Result): Record<string, unknown> => JSON.parse(result.stdout) as Record<string, unknown>;
const successful = (result: Result, status: string): Record<string, unknown> => {
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const value = body(result); assert.equal(value.status, status); assert.equal(value.runStatus, 'succeeded'); assert.equal(value.exitConfirmed, true);
  assert.equal(value.sourceVerification, 'not_run'); assert.equal(value.approvalScope, 'review-only');
  for (const field of ['executionAllowed', 'transmissionAllowed']) assert.equal(value[field], false);
  for (const field of ['nativeExecution', 'realModel', 'credentialAccess', 'productChecks']) assert.equal(value[field], 'not_run');
  return value;
};
const argsFor = (command: string, taskId: unknown, runtime: string) => [`company-change-${command}`, '--task', String(taskId), '--data-dir', runtime];
const privateSnapshot = async (runtime: string, now = new Date()): Promise<CompanyChangeSnapshot> => {
  await prepareCompanyChangeRuntime(runtime, true);
  const context = { ownerId: `os-user:${process.getuid!()}`, now }, prepared = createCompanyChangePlan(createCompanyChangeDraft(), context);
  const store = new SqliteCompanyChangeStore(join(runtime, 'store', 'company-change.sqlite'));
  try { return store.create(prepared.plan, prepared.draft, context); } finally { store.close(); }
};

test('company change CLI prepares, privately reviews and approves declared bytes without executing them', async context => {
  const fixture = setup(context), canary = join(fixture.directory, 'source-canary.txt');
  fs.writeFileSync(canary, 'unchanged synthetic source', { mode: 0o600 });
  fixture.draft.changes[0]!.content = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(canary)}, 'executed');\n`;
  fs.writeFileSync(fixture.draftFile, JSON.stringify(fixture.draft));
  const original = fs.readFileSync(fixture.draftFile), planned = successful(await run(fixture.planArgs), 'AWAITING_APPROVAL');
  assert.equal(planned.changeCount, 2); assert.equal(planned.reviewFileAvailable, false);
  const review = successful(await run(argsFor('review', planned.taskId, fixture.runtime)), 'AWAITING_APPROVAL');
  assert.equal(review.reviewFileAvailable, true);
  const reviewFile = join(fixture.runtime, 'reviews', `${planned.taskId}.json`), saved = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  assert.deepEqual(saved.draft, fixture.draft); assert.equal(saved.plan.planHash, planned.planHash);
  assert.equal(saved.changes[0].afterHash, hashCompanyChangeValue(fixture.draft.changes[0]!.content));
  assert.equal(fs.statSync(reviewFile).mode & 0o7777, 0o600);
  assert.equal(fs.statSync(join(fixture.runtime, 'store')).mode & 0o7777, 0o700);
  const approve = [...argsFor('approve', planned.taskId, fixture.runtime), '--plan-hash', String(planned.planHash), '--expires-in-minutes', '10'];
  const approved = successful(await run(approve), 'APPROVED'), duplicate = successful(await run(approve), 'APPROVED');
  assert.equal(approved.approvalId, duplicate.approvalId); assert.equal(approved.approvalExpiresAt, duplicate.approvalExpiresAt);
  for (const value of [fixture.draft.objective, fixture.draft.repoId, fixture.draft.changes[0]!.path, fixture.draft.changes[0]!.content, fixture.directory]) {
    assert.equal(JSON.stringify(approved).includes(value), false);
  }
  assert.equal(fs.readFileSync(canary, 'utf8'), 'unchanged synthetic source'); assert.deepEqual(fs.readFileSync(fixture.draftFile), original);
  const cancelled = successful(await run(argsFor('cancel', planned.taskId, fixture.runtime)), 'CANCELLED');
  assert.equal(cancelled.draftAvailable, false); assert.equal(cancelled.reviewFileAvailable, false);
  assert.deepEqual(fs.readdirSync(join(fixture.runtime, 'reviews')), []);
  assert.equal(successful(await run(argsFor('inspect', planned.taskId, fixture.runtime)), 'CANCELLED').planHash, planned.planHash);
});

test('CLI starts a narrowly permissioned worker and drops inherited environment and source access', async context => {
  const fixture = setup(context), audit = join(fixture.directory, 'spawn-audit.json'), preload = join(fixture.directory, 'audit.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original=cp.spawn; cp.spawn=function(executable,args,options){fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify({args,envKeys:Object.keys(options.env).sort()}),{mode:0o600});return original.call(this,executable,args,options);}; syncBuiltinESMExports();`, { mode: 0o600 });
  successful(await run(fixture.planArgs, preload), 'AWAITING_APPROVAL');
  const observed = JSON.parse(fs.readFileSync(audit, 'utf8')) as { args: string[]; envKeys: string[] };
  assert.deepEqual(observed.envKeys, ['LANG', 'NODE_NO_WARNINGS', 'TZ']);
  assert.ok(observed.args.includes('--permission')); assert.ok(observed.args.includes('--max-old-space-size=128'));
  const reads = observed.args.filter(value => value.startsWith('--allow-fs-read='));
  assert.equal(reads.length, 5); assert.equal(reads.some(value => value.includes('*')), false);
  assert.ok(reads.includes(`--allow-fs-read=${fixture.draftFile}`)); assert.ok(reads.includes(`--allow-fs-read=${fixture.runtime}`));
  assert.equal(reads.includes(`--allow-fs-read=${fixture.directory}`), false);
  assert.deepEqual(observed.args.filter(value => value.startsWith('--allow-fs-write=')), [
    `--allow-fs-write=${join(fixture.runtime, 'store')}`, `--allow-fs-write=${join(fixture.runtime, 'reviews')}`,
  ]);
  const canary = join(fixture.directory, 'outside-canary.txt'), probe = join(fixture.runtime, 'store', 'permission-probe.mjs');
  fs.writeFileSync(canary, 'unchanged', { mode: 0o600 });
  fs.writeFileSync(probe, `import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const attempt=(operation)=>{try {const result=operation();return result?.error?.code??'allowed';}catch(error){return error.code;}};
process.stdout.write(JSON.stringify({read:attempt(()=>fs.readFileSync(${JSON.stringify(canary)})),write:attempt(()=>fs.writeFileSync(${JSON.stringify(canary)},'changed')),
child:attempt(()=>spawnSync(process.execPath,['-e','process.exit(0)']))}));`, { mode: 0o600 });
  try {
    const blocked = await new Promise<string>((done, reject) => {
      const child = spawn(process.execPath, [...observed.args.slice(0, -2), probe], {
        env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '', errors = '';
      child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { errors += String(chunk); });
      child.once('error', reject); child.once('close', code => code === 0 ? done(output) : reject(new Error(errors)));
    });
    assert.deepEqual(JSON.parse(blocked), { read: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', child: 'ERR_ACCESS_DENIED' });
    assert.equal(fs.readFileSync(canary, 'utf8'), 'unchanged');
  } finally { fs.unlinkSync(probe); }
});

test('apply, live options, duplicate options and invalid approval TTL are rejected before runtime creation', async context => {
  const fixture = setup(context);
  for (const command of [
    ['company-change-apply', '--data-dir', fixture.runtime], [...fixture.planArgs, '--mode', 'live'],
    [...fixture.planArgs, '--draft', fixture.draftFile],
    ['company-change-approve', '--task', randomUUID(), '--plan-hash', 'a'.repeat(64), '--expires-in-minutes', '0', '--data-dir', fixture.runtime],
  ]) {
    const result = await run(command); assert.equal(result.code, 1); assert.equal(fs.existsSync(fixture.runtime), false);
    assert.match(result.stderr, /UNKNOWN_COMMAND|INVALID_ARGUMENTS/u);
  }
});

test('draft reader refuses duplicate JSON keys, unknown source paths and private-file permission or link violations', async context => {
  const fixture = setup(context);
  fs.writeFileSync(fixture.draftFile, JSON.stringify(fixture.draft).replace('"repoId":', '"repoId":"discarded","repoId":'));
  assert.equal((await run(fixture.planArgs)).code, 1);
  assert.equal(fs.existsSync(fixture.database), false);
  fs.writeFileSync(fixture.draftFile, JSON.stringify({ ...fixture.draft, sourceRoot: join(fixture.directory, 'never-opened') }));
  assert.equal(body(await run(fixture.planArgs)).failureCode, 'COMPANY_CHANGE_INVALID_DRAFT');
  fs.writeFileSync(fixture.draftFile, JSON.stringify(fixture.draft)); fs.chmodSync(fixture.draftFile, 0o644);
  assert.equal((await run(fixture.planArgs)).code, 1);
  fs.chmodSync(fixture.draftFile, 0o600);
  const link = join(fixture.directory, 'linked.json'); fs.symlinkSync(fixture.draftFile, link);
  assert.equal((await run(['company-change-plan', '--draft', link, '--data-dir', fixture.runtime])).code, 1);
  fs.unlinkSync(link); fs.linkSync(fixture.draftFile, link);
  assert.equal((await run(fixture.planArgs)).code, 1);
});

test('runtime preparation refuses existing foreign entries and symlink directories without deleting them', async context => {
  const fixture = setup(context);
  fs.mkdirSync(fixture.runtime, { mode: 0o700 });
  const marker = join(fixture.runtime, 'keep.txt'); fs.writeFileSync(marker, 'keep', { mode: 0o600 });
  assert.equal((await run(fixture.planArgs)).code, 1); assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  const alias = join(fixture.directory, 'alias'); fs.symlinkSync(fixture.runtime, alias);
  assert.equal((await run(['company-change-plan', '--draft', fixture.draftFile, '--data-dir', alias])).code, 1);
  assert.deepEqual(fs.readdirSync(fixture.runtime), ['keep.txt']);
});

test('expired malformed stored drafts and review copies prune without opening review body content', async context => {
  const fixture = setup(context), prior = new Date(Date.now() - 2 * 86_400_000), snapshot = await privateSnapshot(fixture.runtime, prior);
  await writeCompanyChangeReview(fixture.runtime, snapshot, () => prior);
  const database = new DatabaseSync(fixture.database);
  try { database.prepare('UPDATE company_change_drafts SET draft_json = ?').run('SYNTHETIC_EXPIRED_BROKEN_BODY'); }
  finally { database.close(); }
  const result = successful(await run(['company-change-prune', '--data-dir', fixture.runtime]), 'PRUNED');
  assert.equal(result.prunedDrafts, 1); assert.equal(result.prunedRecords, 0); assert.equal(result.prunedReviews, 1);
  assert.deepEqual(fs.readdirSync(join(fixture.runtime, 'reviews')), []);
});

test('review expiration during publication removes only its own generated copy', async context => {
  const fixture = setup(context), snapshot = await privateSnapshot(fixture.runtime), before = new Date(snapshot.plan.createdAt), after = new Date(snapshot.plan.expiresAt);
  let observations = 0;
  await assert.rejects(writeCompanyChangeReview(fixture.runtime, snapshot, () => ++observations >= 4 ? after : before), { code: 'COMPANY_CHANGE_REVIEW_EXPIRED' });
  assert.deepEqual(fs.readdirSync(join(fixture.runtime, 'reviews')), []);
  assert.ok(fs.existsSync(fixture.draftFile));
});

test('partial review body remains managed by its immutable prior manifest and expires using metadata only', async context => {
  const fixture = setup(context), snapshot = await privateSnapshot(fixture.runtime), now = new Date(snapshot.plan.createdAt);
  await writeCompanyChangeReview(fixture.runtime, snapshot, () => now);
  const reviewFile = join(fixture.runtime, 'reviews', `${snapshot.plan.id}.json`);
  fs.truncateSync(reviewFile, 7);
  await assert.rejects(companyChangeReviewExists(fixture.runtime, snapshot.plan.id, snapshot.plan), { code: 'COMPANY_CHANGE_UNSAFE_RUNTIME' });
  const original = fsPromises.open; let bodyOpens = 0;
  fsPromises.open = ((path, ...rest) => {
    if (String(path) === reviewFile) { bodyOpens++; throw new Error('Expired review body read'); }
    return original(path, ...rest);
  }) as typeof fsPromises.open;
  syncBuiltinESMExports();
  try {
    assert.equal(await pruneCompanyChangeReviews(fixture.runtime, new Date(snapshot.plan.expiresAt)), 1);
    assert.equal(bodyOpens, 0); assert.deepEqual(fs.readdirSync(join(fixture.runtime, 'reviews')), []);
  } finally { fsPromises.open = original; syncBuiltinESMExports(); }
});

test('review manifest TTL tampering is refused and review files are preserved for inspection', async context => {
  const fixture = setup(context), snapshot = await privateSnapshot(fixture.runtime);
  await writeCompanyChangeReview(fixture.runtime, snapshot);
  const manifest = join(fixture.runtime, 'reviews', `${snapshot.plan.id}.meta.json`), value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  value.expiresAt = new Date(Date.parse(snapshot.plan.expiresAt) + 1000).toISOString();
  fs.writeFileSync(manifest, JSON.stringify(value));
  await assert.rejects(pruneCompanyChangeReviews(fixture.runtime, new Date(snapshot.plan.expiresAt)), { code: 'COMPANY_CHANGE_UNSAFE_RUNTIME' });
  assert.equal(fs.readdirSync(join(fixture.runtime, 'reviews')).length, 2);
});

test('review capacity is checked before publication and a full runtime remains valid', async context => {
  const fixture = setup(context), snapshot = await privateSnapshot(fixture.runtime), reviews = join(fixture.runtime, 'reviews');
  for (let index = 0; index < COMPANY_CHANGE_MAX_REVIEW_FILES / 2 - 1; index++) {
    const id = randomUUID(), file = join(reviews, `${id}.json`), contents = '{}\n';
    fs.writeFileSync(file, contents, { mode: 0o600 }); const stat = fs.statSync(file);
    const content = { version: 'company-change-review-file-v1', taskId: id, planHash: 'a'.repeat(64), ownerId: snapshot.plan.ownerId,
      expiresAt: snapshot.plan.expiresAt, bodyHash: hashCompanyChangeValue(contents), bodyBytes: Buffer.byteLength(contents),
      file: { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode, nlink: stat.nlink } };
    fs.writeFileSync(join(reviews, `${id}.meta.json`), canonicalReadonlyJson({ ...content, manifestHash: hashCompanyChangeValue(canonicalReadonlyJson(content)) }), { mode: 0o600 });
  }
  await writeCompanyChangeReview(fixture.runtime, snapshot);
  assert.equal(fs.readdirSync(reviews).length, COMPANY_CHANGE_MAX_REVIEW_FILES);
  const prepared = createCompanyChangePlan(createCompanyChangeDraft(), { ownerId: snapshot.plan.ownerId, now: new Date() });
  const next: CompanyChangeSnapshot = { ...prepared, status: 'AWAITING_APPROVAL', updatedAt: prepared.plan.createdAt, approval: null };
  await assert.rejects(writeCompanyChangeReview(fixture.runtime, next), { code: 'COMPANY_CHANGE_REVIEW_CAPACITY' });
  assert.equal(fs.readdirSync(reviews).length, COMPANY_CHANGE_MAX_REVIEW_FILES);
  await (await validateCompanyChangeRuntime(fixture.runtime))();
  assert.equal(await pruneCompanyChangeReviews(fixture.runtime, new Date(snapshot.plan.expiresAt)), COMPANY_CHANGE_MAX_REVIEW_FILES / 2);
});

test('orphan body copies are not overwritten or claimed as successful reviews', async context => {
  const fixture = setup(context), snapshot = await privateSnapshot(fixture.runtime);
  const path = join(fixture.runtime, 'reviews', `${snapshot.plan.id}.json`);
  fs.writeFileSync(path, '', { mode: 0o600 });
  await assert.rejects(writeCompanyChangeReview(fixture.runtime, snapshot), { code: 'COMPANY_CHANGE_UNSAFE_RUNTIME' });
  await assert.rejects(pruneCompanyChangeReviews(fixture.runtime, new Date(snapshot.plan.expiresAt)), { code: 'COMPANY_CHANGE_REVIEW_ORPHAN' });
  assert.equal(fs.readFileSync(path, 'utf8'), '');
  fs.writeFileSync(path, 'unclaimed synthetic content');
  await assert.rejects(pruneCompanyChangeReviews(fixture.runtime, new Date(snapshot.plan.expiresAt)), { code: 'COMPANY_CHANGE_REVIEW_ORPHAN' });
  assert.equal(fs.readFileSync(path, 'utf8'), 'unclaimed synthetic content');
});

test('another process holding the runtime lease blocks review and cancellation without changing stored data', async context => {
  const fixture = setup(context), planned = successful(await run(fixture.planArgs), 'AWAITING_APPROVAL');
  successful(await run(argsFor('review', planned.taskId, fixture.runtime)), 'AWAITING_APPROVAL');
  const reviewPath = join(fixture.runtime, 'reviews', `${planned.taskId}.json`), manifestPath = join(fixture.runtime, 'reviews', `${planned.taskId}.meta.json`);
  const before = [fixture.database, reviewPath, manifestPath].map(path => hashCompanyChangeValue(fs.readFileSync(path)));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[1]); database.exec('BEGIN EXCLUSIVE'); process.stdout.write('ready\\n');
process.stdin.once('data', () => { database.close(); process.exit(0); }); process.stdin.resume();`, join(fixture.runtime, 'store', 'company-change-lease.sqlite')],
  { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  context.after(() => { child.kill('SIGKILL'); });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Lease helper did not start')), 5000);
    child.stdout.once('data', chunk => { clearTimeout(timer); assert.equal(String(chunk), 'ready\n'); done(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  for (const command of ['review', 'cancel']) {
    const result = await run(argsFor(command, planned.taskId, fixture.runtime));
    assert.equal(result.code, 1); assert.equal(body(result).failureCode, 'COMPANY_CHANGE_BUSY');
    assert.deepEqual([fixture.database, reviewPath, manifestPath].map(path => hashCompanyChangeValue(fs.readFileSync(path))), before);
  }
  await new Promise<void>((done, reject) => {
    child.once('close', code => code === 0 ? done() : reject(new Error('Lease helper failed'))); child.stdin.end('release');
  });
  successful(await run(argsFor('cancel', planned.taskId, fixture.runtime)), 'CANCELLED');
  assert.deepEqual(fs.readdirSync(join(fixture.runtime, 'reviews')), []);
});
