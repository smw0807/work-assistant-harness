import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SqliteCompanyReadonlyStore } from '../src/adapters/sqlite-company-readonly-store.js';
import { HarnessError } from '../src/domain/errors.js';
import { createCompanyReadonlyPreparation } from '../src/policy/company-readonly.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { companyReadonlyFixture } from './company-readonly-fixture.js';

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const privateDirectory = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'company-store-'))); chmodSync(directory, 0o700);
  return { directory, file: join(directory, 'company-readonly.sqlite'), close: () => rmSync(directory, { recursive: true, force: true }) };
};
const setup = () => {
  const files = privateDirectory(); let store = new SqliteCompanyReadonlyStore(files.file);
  return { ...files, ...companyReadonlyFixture(), get store() { return store; },
    reopen: () => { store.close(); store = new SqliteCompanyReadonlyStore(files.file); },
    close: () => { store.close(); files.close(); } };
};
const counts = (file: string) => {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return { plans: database.prepare('SELECT count(*) AS n FROM company_readonly_preparations').get()!.n,
    payloads: database.prepare('SELECT count(*) AS n FROM company_readonly_payloads').get()!.n,
    bindings: database.prepare('SELECT count(*) AS n FROM company_readonly_store').get()!.n }; }
  finally { database.close(); }
};
const preserved = (file: string) => {
  const stat = lstatSync(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode, links: stat.nlink,
    size: stat.size, modified: stat.mtimeNs, changed: stat.ctimeNs, hash: hash(readFileSync(file)) };
};

test('company store persists only preparation state, private payload and location binding across restart', () => {
  const h = setup();
  try {
    const created = h.store.create(h.plan, h.payload, h.context);
    assert.equal(created.status, 'AWAITING_APPROVAL');
    assert.deepEqual([created.approvalCreated, created.transmissionAllowed, created.executionAllowed, created.companyPolicyVerified], [false, false, false, false]);
    assert.deepEqual(created.plan, h.plan); assert.deepEqual(created.payload, h.payload);
    assert.equal(JSON.stringify(created.plan).includes(h.registration.sourceRoot), false);
    assert.equal(JSON.stringify(created.plan).includes(h.registration.question), false);
    assert.equal(lstatSync(h.file).mode & 0o7777, 0o600); assert.equal(lstatSync(h.file).nlink, 1);
    const database = new DatabaseSync(h.file, { readOnly: true });
    try {
      assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name),
        ['company_readonly_payloads', 'company_readonly_preparations', 'company_readonly_store']);
      assert.notEqual(database.prepare('PRAGMA application_id').get()!.application_id, 0);
      assert.equal(database.prepare('PRAGMA user_version').get()!.user_version, 1);
    } finally { database.close(); }
    h.reopen(); assert.deepEqual(h.store.inspect(h.plan.id, h.context), created);
    created.plan.planHash = '0'.repeat(64); created.payload!.registration.question = 'mutated return value';
    assert.deepEqual(h.store.inspect(h.plan.id, h.context).plan, h.plan);
    assert.deepEqual(counts(h.file), { plans: 1, payloads: 1, bindings: 1 });
    for (const action of ['approve', 'claim', 'dispatch', 'run', 'transmit']) assert.equal(action in h.store, false);
  } finally { h.close(); }
});

test('duplicate preparation keeps its original plan and payload while a reused id for another question is rejected', () => {
  const h = setup();
  try {
    const original = h.store.create(h.plan, h.payload, h.context);
    const later = { ...h.context, now: new Date(h.context.now.getTime() + 1000) };
    const duplicate = companyReadonlyFixture({ id: '22222222-2222-4222-8222-222222222222', context: later });
    assert.equal(duplicate.plan.preparationKey, h.plan.preparationKey); assert.notEqual(duplicate.plan.planHash, h.plan.planHash);
    const another = new SqliteCompanyReadonlyStore(h.file);
    try { assert.deepEqual(another.create(duplicate.plan, duplicate.payload, later), original); }
    finally { another.close(); }
    const collision = companyReadonlyFixture({ question: 'Explain only the visible return value.' });
    assert.throws(() => h.store.create(collision.plan, collision.payload, h.context), { code: 'COMPANY_READONLY_ID_REUSED' });
    assert.deepEqual(counts(h.file), { plans: 1, payloads: 1, bindings: 1 });
    assert.deepEqual(h.store.inspect(h.plan.id, h.context), original);
  } finally { h.close(); }
});

test('concurrent independent processes atomically keep one immutable preparation for a shared key', { timeout: 20000 }, async () => {
  const h = setup();
  const storeModule = pathToFileURL(resolve('dist/src/adapters/sqlite-company-readonly-store.js')).href;
  const fixtureModule = pathToFileURL(resolve('dist/tests/company-readonly-fixture.js')).href;
  const childCode = `
import {SqliteCompanyReadonlyStore} from ${JSON.stringify(storeModule)};
import {companyReadonlyFixture} from ${JSON.stringify(fixtureModule)};
let store;
try {
 const fixture=companyReadonlyFixture({id:process.env.COMPANY_TEST_ID});
 store=new SqliteCompanyReadonlyStore(process.env.COMPANY_TEST_DB);
 const result=store.create(fixture.plan,fixture.payload,fixture.context);
 process.stdout.write(JSON.stringify({id:result.plan.id,status:result.status}));
} catch(error) { process.stdout.write(JSON.stringify({error:error.code??'SYNTHETIC_CHILD_FAILURE'}));process.exitCode=1; }
finally {store?.close();}
`;
  const run = (id: string) => new Promise<{ id: string; status: string }>((accept, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', COMPANY_TEST_DB: h.file, COMPANY_TEST_ID: id }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume(); child.once('error', () => reject(new Error('SYNTHETIC_CHILD_SPAWN_FAILED')));
    child.once('close', code => {
      try { assert.equal(code, 0, output); assert.ok(output.length < 4096); accept(JSON.parse(output) as { id: string; status: string }); }
      catch (error) { reject(error); }
    });
  });
  try {
    const results = await Promise.all([run('22222222-2222-4222-8222-222222222222'), run('33333333-3333-4333-8333-333333333333')]);
    assert.equal(results[0]!.id, results[1]!.id); assert.equal(results[0]!.status, 'AWAITING_APPROVAL');
    assert.deepEqual(counts(h.file), { plans: 1, payloads: 1, bindings: 1 });
    assert.equal(h.store.inspect(results[0]!.id, h.context).plan.preparationKey, h.plan.preparationKey);
  } finally { h.close(); }
});

test('cancel immediately removes payload and duplicate preparation cannot revive the cancelled state', () => {
  const h = setup();
  try {
    h.store.create(h.plan, h.payload, h.context);
    const context = { ...h.context, now: new Date(h.context.now.getTime() + 60000) };
    const cancelled = h.store.cancel(h.plan.id, context);
    assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.payload, null);
    assert.deepEqual(counts(h.file), { plans: 1, payloads: 0, bindings: 1 });
    h.reopen(); assert.deepEqual(h.store.inspect(h.plan.id, context), cancelled);
    const duplicate = companyReadonlyFixture({ id: '22222222-2222-4222-8222-222222222222', context });
    assert.deepEqual(h.store.create(duplicate.plan, duplicate.payload, context), cancelled);
    assert.deepEqual(h.store.cancel(h.plan.id, context), cancelled);
  } finally { h.close(); }
});

test('expiry and audit retention use exact boundaries, persist deletion and do not reread source paths', () => {
  const h = setup();
  try {
    h.store.create(h.plan, h.payload, h.context);
    const before = { ...h.context, now: new Date(Date.parse(h.plan.expiresAt) - 1) };
    assert.equal(h.store.inspect(h.plan.id, before).status, 'AWAITING_APPROVAL');
    const expiry = { ...h.context, now: new Date(h.plan.expiresAt) };
    const expired = h.store.inspect(h.plan.id, expiry);
    assert.equal(expired.status, 'EXPIRED'); assert.equal(expired.updatedAt, h.plan.expiresAt); assert.equal(expired.payload, null);
    assert.deepEqual(counts(h.file), { plans: 1, payloads: 0, bindings: 1 });
    h.reopen(); assert.deepEqual(h.store.inspect(h.plan.id, expiry), expired);
    const duplicate = companyReadonlyFixture({ id: '22222222-2222-4222-8222-222222222222', context: expiry });
    assert.deepEqual(h.store.create(duplicate.plan, duplicate.payload, expiry), expired);
    const audit = { ...h.context, now: new Date(h.plan.auditExpiresAt) };
    assert.throws(() => h.store.inspect(h.plan.id, audit), { code: 'COMPANY_READONLY_NOT_FOUND' });
    assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
    const renewed = companyReadonlyFixture({ id: '44444444-4444-4444-8444-444444444444', context: audit });
    assert.equal(h.store.create(renewed.plan, renewed.payload, audit).status, 'AWAITING_APPROVAL');
    assert.deepEqual(h.store.prune({ ...h.context, now: new Date(renewed.plan.auditExpiresAt) }), { payloadsRemoved: 1, recordsRemoved: 1 });
    assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
  } finally { h.close(); }
});

test('invalid owner, time, plan and payload are rejected without creating or altering state', () => {
  const h = setup();
  try {
    const wrongOwner = { ...h.context, ownerId: 'os-user:999999999' };
    for (const action of [() => h.store.create(h.plan, h.payload, wrongOwner), () => h.store.inspect(h.plan.id, wrongOwner),
      () => h.store.cancel(h.plan.id, wrongOwner), () => h.store.prune(wrongOwner)]) {
      assert.throws(action, { code: 'COMPANY_READONLY_OWNER_MISMATCH' });
    }
    assert.throws(() => h.store.create(h.plan, h.payload, { ...h.context, now: new Date('invalid') }), { code: 'COMPANY_READONLY_INVALID_TIME' });
    assert.throws(() => h.store.create(h.plan, h.payload, { ...h.context, now: new Date(h.context.now.getTime() - 1) }), { code: 'COMPANY_READONLY_INVALID_TIME' });
    assert.throws(() => h.store.create(h.plan, h.payload, { ...h.context, now: new Date(h.plan.expiresAt) }), { code: 'COMPANY_READONLY_EXPIRED' });
    assert.throws(() => h.store.create({ ...h.plan, planHash: '0'.repeat(64) }, h.payload, h.context), { code: 'COMPANY_READONLY_INVALID_PLAN' });
    assert.throws(() => h.store.create(h.plan, { ...h.payload, reviewInput: '{}' }, h.context), { code: 'COMPANY_READONLY_INVALID_PAYLOAD' });
    assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
    h.store.create(h.plan, h.payload, h.context);
    const later = { ...h.context, now: new Date(h.context.now.getTime() + 1000) };
    h.store.cancel(h.plan.id, later);
    assert.throws(() => h.store.prune(h.context), { code: 'COMPANY_READONLY_TIME_REVERSED' });
    assert.equal(h.store.inspect(h.plan.id, later).status, 'CANCELLED');
    h.store.close(); assert.throws(() => h.store.inspect(h.plan.id, later), { code: 'COMPANY_READONLY_STORE_CLOSED' });
  } finally { h.close(); }
});

test('create rejects any source and runtime overlap before persisting preparation data', () => {
  const h = setup();
  try {
    for (const sourceRoot of [h.directory, dirname(h.directory), join(h.directory, 'source')]) {
      const registration = { ...h.registration, sourceRoot };
      const repository = { ...h.repository, sourceRoot };
      repository.identityHash = hashReadonlyValue(canonicalReadonlyJson(
        Object.fromEntries(Object.entries(repository).filter(([key]) => key !== 'identityHash'))));
      const prepared = createCompanyReadonlyPreparation(registration, h.policy, repository, h.collected, h.context);
      assert.throws(() => h.store.create(prepared.plan, prepared.payload, h.context), { code: 'COMPANY_READONLY_UNSAFE_LOCATION' });
    }
    assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
  } finally { h.close(); }
});

test('foreign, empty and malformed databases are rejected before any write and raw errors remain private', () => {
  for (const scenario of ['foreign', 'empty', 'malformed'] as const) {
    const h = privateDirectory();
    try {
      if (scenario === 'foreign') {
        const database = new DatabaseSync(h.file); database.exec('CREATE TABLE personal_readonly_tasks (payload TEXT)'); database.close(); chmodSync(h.file, 0o600);
      } else writeFileSync(h.file, scenario === 'empty' ? '' : 'SYNTHETIC_PRIVATE_DATABASE_CANARY', { mode: 0o600 });
      const before = preserved(h.file);
      assert.throws(() => new SqliteCompanyReadonlyStore(h.file), error => {
        assert.ok(error instanceof HarnessError); assert.equal(error.code, 'COMPANY_READONLY_INVALID_STORE');
        assert.equal(error.message, 'COMPANY_READONLY_INVALID_STORE'); return true;
      });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('application identity, schema additions and location binding are rechecked before writable reopen', () => {
  for (const mutation of ['application', 'version', 'schema', 'binding'] as const) {
    const h = setup();
    try {
      h.store.create(h.plan, h.payload, h.context); h.store.close();
      const database = new DatabaseSync(h.file);
      if (mutation === 'application') database.exec('PRAGMA application_id = 0');
      if (mutation === 'version') database.exec('PRAGMA user_version = 2');
      if (mutation === 'schema') database.exec('CREATE TABLE approvals (id TEXT)');
      if (mutation === 'binding') database.prepare('UPDATE company_readonly_store SET location_hash = ?').run('0'.repeat(64));
      database.close(); const before = preserved(h.file);
      assert.throws(() => new SqliteCompanyReadonlyStore(h.file), { code: 'COMPANY_READONLY_INVALID_STORE' });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('moved and copied databases stay untouched even after payload expiry because their location is bound', () => {
  for (const operation of ['move', 'copy'] as const) {
    const h = setup();
    try {
      h.store.create(h.plan, h.payload, h.context); h.store.prune({ ...h.context, now: new Date(h.plan.expiresAt) }); h.store.close();
      const destinationDirectory = join(h.directory, 'synthetic-source'); mkdirSync(destinationDirectory, { mode: 0o700 });
      const destination = join(destinationDirectory, 'company-readonly.sqlite');
      if (operation === 'move') renameSync(h.file, destination); else copyFileSync(h.file, destination);
      const before = preserved(destination);
      assert.throws(() => new SqliteCompanyReadonlyStore(destination), { code: 'COMPANY_READONLY_INVALID_STORE' });
      assert.deepEqual(preserved(destination), before);
      if (operation === 'copy') assert.deepEqual(counts(h.file), { plans: 1, payloads: 0, bindings: 1 });
    } finally { h.close(); }
  }
});

test('unsafe permissions, wrong filenames and linked database paths are refused without repairing files', () => {
  const h = setup();
  try {
    h.store.close();
    const wrongName = join(h.directory, 'personal-readonly.sqlite');
    assert.throws(() => new SqliteCompanyReadonlyStore(wrongName), { code: 'UNSAFE_RUNTIME_PATH' }); assert.equal(existsSync(wrongName), false);
    chmodSync(h.file, 0o644); assert.throws(() => new SqliteCompanyReadonlyStore(h.file), { code: 'UNSAFE_RUNTIME_FILE' });
    assert.equal(lstatSync(h.file).mode & 0o7777, 0o644); chmodSync(h.file, 0o600);
    chmodSync(h.directory, 0o755); assert.throws(() => new SqliteCompanyReadonlyStore(h.file), { code: 'UNSAFE_RUNTIME_PATH' });
    assert.equal(lstatSync(h.directory).mode & 0o7777, 0o755); chmodSync(h.directory, 0o700);
    const links = join(h.directory, 'links'); mkdirSync(links, { mode: 0o700 });
    const alias = join(links, 'company-readonly.sqlite'); symlinkSync(h.file, alias);
    assert.throws(() => new SqliteCompanyReadonlyStore(alias), { code: 'UNSAFE_RUNTIME_FILE' }); rmSync(alias);
    linkSync(h.file, alias); assert.throws(() => new SqliteCompanyReadonlyStore(h.file), { code: 'UNSAFE_RUNTIME_FILE' }); rmSync(alias);
    const parentAlias = join(h.directory, 'parent-alias'); symlinkSync(links, parentAlias);
    assert.throws(() => new SqliteCompanyReadonlyStore(join(parentAlias, 'company-readonly.sqlite')), { code: 'UNSAFE_RUNTIME_PATH' });
  } finally { h.close(); }
});

test('journal, WAL and shared-memory sidecars must be private single-link regular files', () => {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    for (const mutation of ['symlink', 'hardlink', 'permissions'] as const) {
      const h = setup();
      try {
        h.store.close(); const canary = join(h.directory, 'synthetic-canary'); writeFileSync(canary, 'synthetic-only', { mode: 0o600 });
        const sidecar = `${h.file}${suffix}`;
        if (mutation === 'symlink') symlinkSync(canary, sidecar);
        else if (mutation === 'hardlink') linkSync(canary, sidecar);
        else writeFileSync(sidecar, '', { mode: 0o644 });
        const before = preserved(h.file);
        assert.throws(() => new SqliteCompanyReadonlyStore(h.file), { code: 'UNSAFE_RUNTIME_FILE' });
        assert.deepEqual(preserved(h.file), before); assert.equal(readFileSync(canary, 'utf8'), 'synthetic-only');
      } finally { h.close(); }
    }
  }
});

test('an opened store detects database replacement before mutating the original or replacement', () => {
  const h = setup();
  try {
    h.store.create(h.plan, h.payload, h.context);
    const displaced = `${h.file}.original`; renameSync(h.file, displaced); copyFileSync(displaced, h.file);
    const oldBefore = preserved(displaced), newBefore = preserved(h.file);
    assert.throws(() => h.store.cancel(h.plan.id, h.context), { code: 'UNSAFE_RUNTIME_FILE' });
    assert.deepEqual(preserved(displaced), oldBefore); assert.deepEqual(preserved(h.file), newBefore);
  } finally { h.close(); }
});

test('stored plan and payload corruption, duplicate JSON keys and enlarged bodies fail strict bounded validation', () => {
  const h = setup();
  try {
    h.store.create(h.plan, h.payload, h.context);
    const database = new DatabaseSync(h.file);
    try {
      const plan = database.prepare('SELECT plan_json, record_hash FROM company_readonly_preparations').get()!;
      const original = database.prepare('SELECT payload_json, payload_hash FROM company_readonly_payloads').get()!;
      database.prepare('UPDATE company_readonly_preparations SET record_hash = ?').run('0'.repeat(64));
      assert.throws(() => h.store.inspect(h.plan.id, h.context), { code: 'COMPANY_READONLY_INVALID_RECORD' });
      database.prepare('UPDATE company_readonly_preparations SET record_hash = ?').run(plan.record_hash!);
      database.prepare('UPDATE company_readonly_preparations SET plan_json = ?').run(String(plan.plan_json).replace('"version":', '"version":"duplicate","version":'));
      assert.throws(() => h.store.inspect(h.plan.id, h.context), { code: 'COMPANY_READONLY_INVALID_RECORD' });
      database.prepare('UPDATE company_readonly_preparations SET plan_json = ?').run(plan.plan_json!);
      const extra = JSON.stringify({ ...h.payload, approvalCreated: true });
      const duplicate = String(original.payload_json).replace('"registration":', '"registration":null,"registration":');
      database.exec('PRAGMA ignore_check_constraints = ON');
      for (const body of [extra, duplicate, JSON.stringify('x'.repeat(2_097_153))]) {
        database.prepare('UPDATE company_readonly_payloads SET payload_json = ?, payload_hash = ?').run(body, hash(body));
        assert.throws(() => h.store.inspect(h.plan.id, h.context), { code: 'COMPANY_READONLY_INVALID_RECORD' });
      }
      database.prepare('UPDATE company_readonly_payloads SET payload_json = ?, payload_hash = ?').run(original.payload_json!, original.payload_hash!);
      assert.deepEqual(h.store.inspect(h.plan.id, h.context).payload, h.payload);
    } finally { database.close(); }
  } finally { h.close(); }
});
