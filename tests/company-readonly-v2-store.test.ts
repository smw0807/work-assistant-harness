import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteCompanyReadonlyStore } from '../src/adapters/sqlite-company-readonly-store.js';
import { SqliteCompanyReadonlyV2Store } from '../src/adapters/sqlite-company-readonly-v2-store.js';
import { HarnessError } from '../src/domain/errors.js';
import { createCompanyReadonlyPreparationV2 } from '../src/policy/company-readonly-v2.js';
import { createCompanyReadonlyV2Fixture } from './company-readonly-v2-fixture.js';

const privateDirectory = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v2-store-'))); fs.chmodSync(directory, 0o700);
  return { directory, file: join(directory, 'company-readonly-v2.sqlite'), close: () => fs.rmSync(directory, { recursive: true, force: true }) };
};
const setup = async (context: TestContext) => {
  const fixture = await createCompanyReadonlyV2Fixture(context), inputs = await fixture.prepareInput();
  const prepared = createCompanyReadonlyPreparationV2(inputs.registration, inputs.policy, inputs.observation,
    inputs.collected, inputs.budget, inputs.context, inputs.id);
  const files = privateDirectory(); let store = new SqliteCompanyReadonlyV2Store(files.file);
  const prepare = (id = inputs.id, question = inputs.registration.question, now = inputs.context) =>
    createCompanyReadonlyPreparationV2({ ...inputs.registration, question }, inputs.policy, inputs.observation,
      inputs.collected, inputs.budget, now, id);
  return { ...fixture, ...files, ...prepared, inputs, prepare, get store() { return store; },
    reopen: () => { store.close(); store = new SqliteCompanyReadonlyV2Store(files.file); },
    close: () => { store.close(); files.close(); } };
};
const counts = (file: string) => {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return { plans: database.prepare('SELECT count(*) AS n FROM company_readonly_v2_preparations').get()!.n,
    payloads: database.prepare('SELECT count(*) AS n FROM company_readonly_v2_payloads').get()!.n,
    bindings: database.prepare('SELECT count(*) AS n FROM company_readonly_v2_store').get()!.n }; }
  finally { database.close(); }
};
const preserved = (file: string) => {
  const metadata = fs.lstatSync(file, { bigint: true });
  return { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid, gid: metadata.gid, mode: metadata.mode, links: metadata.nlink,
    size: metadata.size, modified: metadata.mtimeNs, changed: metadata.ctimeNs,
    hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
};

test('v2 storage uses private separate identity and tables, persists immutable preparation state and exposes no execution API', async context => {
  const h = await setup(context);
  try {
    const result = h.store.create(h.plan, h.payload, h.context);
    assert.equal(result.plan.id, h.id); assert.equal(result.status, 'AWAITING_APPROVAL');
    assert.deepEqual([result.approvalCreated, result.transmissionAllowed, result.executionAllowed, result.companyPolicyVerified], [false, false, false, false]);
    assert.equal(fs.lstatSync(h.file).mode & 0o7777, 0o600); assert.equal(fs.lstatSync(h.file).nlink, 1);
    const database = new DatabaseSync(h.file, { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA application_id').get()!.application_id, 0x43525032);
      assert.equal(database.prepare('PRAGMA user_version').get()!.user_version, 1);
      assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name),
        ['company_readonly_v2_payloads', 'company_readonly_v2_preparations', 'company_readonly_v2_store']);
    } finally { database.close(); }
    h.reopen(); assert.deepEqual(h.store.inspect(h.id, h.context), result);
    result.plan.planHash = '0'.repeat(64); result.payload!.registration.question = 'changed returned value';
    assert.deepEqual(h.store.inspect(h.id, h.context).plan, h.plan);
    assert.deepEqual(h.store.inspect(h.id, h.context).payload, h.payload);
    for (const action of ['approve', 'claim', 'dispatch', 'run', 'transmit']) assert.equal(action in h.store, false);
  } finally { h.close(); }
});

test('only exact same-ID retries reuse a preparation; a new ID stays distinct and conflicting reuse is refused', async context => {
  const h = await setup(context);
  try {
    const original = h.store.create(h.plan, h.payload, h.context), secondStore = new SqliteCompanyReadonlyV2Store(h.file);
    try { assert.deepEqual(secondStore.create(h.plan, h.payload, h.context), original); }
    finally { secondStore.close(); }
    const next = h.prepare('22222222-2222-4222-8222-222222222222');
    assert.notEqual(next.plan.preparationKey, h.plan.preparationKey);
    assert.equal(h.store.create(next.plan, next.payload, h.context).plan.id, next.plan.id);
    const conflict = h.prepare(h.id, 'Explain a different synthetic question.');
    assert.throws(() => h.store.create(conflict.plan, conflict.payload, h.context), { code: 'COMPANY_READONLY_V2_ID_REUSED' });
    const later = { ...h.context, now: new Date(h.context.now.getTime() + 1000) }, changedTime = h.prepare(h.id, undefined, later);
    assert.throws(() => h.store.create(changedTime.plan, changedTime.payload, later), { code: 'COMPANY_READONLY_V2_ID_REUSED' });
    assert.deepEqual(counts(h.file), { plans: 2, payloads: 2, bindings: 1 });
    assert.deepEqual(h.store.inspect(h.id, h.context), original);
  } finally { h.close(); }
});

test('cancel deletes the v2 payload immediately while exact retries preserve the cancelled ID and its hash evidence', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context);
    const later = { ...h.context, now: new Date(h.context.now.getTime() + 1000) }, result = h.store.cancel(h.id, later);
    assert.equal(result.status, 'CANCELLED'); assert.equal(result.payload, null);
    assert.deepEqual(counts(h.file), { plans: 1, payloads: 0, bindings: 1 });
    h.reopen(); assert.deepEqual(h.store.create(h.plan, h.payload, later), result);
    const conflict = h.prepare(h.id, 'A conflicting retry after cancellation.');
    assert.throws(() => h.store.create(conflict.plan, conflict.payload, later), { code: 'COMPANY_READONLY_V2_ID_REUSED' });
    assert.deepEqual(h.store.cancel(h.id, later), result);
  } finally { h.close(); }
});

test('expiry and audit pruning retain their exact boundaries and cannot revive an old preparation', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context);
    const before = { ...h.context, now: new Date(Date.parse(h.plan.expiresAt) - 1) };
    assert.equal(h.store.inspect(h.id, before).status, 'AWAITING_APPROVAL');
    const expiry = { ...h.context, now: new Date(h.plan.expiresAt) };
    const expired = h.store.create(h.plan, h.payload, expiry);
    assert.equal(expired.status, 'EXPIRED'); assert.equal(expired.payload, null); assert.equal(expired.updatedAt, h.plan.expiresAt);
    h.reopen(); assert.deepEqual(h.store.create(h.plan, h.payload, expiry), expired);
    assert.deepEqual(counts(h.file), { plans: 1, payloads: 0, bindings: 1 });
    const audit = { ...h.context, now: new Date(h.plan.auditExpiresAt) };
    assert.throws(() => h.store.create(h.plan, h.payload, audit), { code: 'COMPANY_READONLY_V2_NOT_FOUND' });
    assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
    assert.throws(() => h.store.create(h.plan, h.payload, audit), { code: 'COMPANY_READONLY_V2_EXPIRED' });
    const renewed = h.prepare('33333333-3333-4333-8333-333333333333', undefined, audit);
    h.store.create(renewed.plan, renewed.payload, audit);
    assert.deepEqual(h.store.prune({ ...h.context, now: new Date(renewed.plan.auditExpiresAt) }), { payloadsRemoved: 1, recordsRemoved: 1 });
    assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
  } finally { h.close(); }
});

test('owner, time, invalid plan/payload and closed-store failures are fixed and leave no partial preparation', async context => {
  const h = await setup(context);
  try {
    const wrongOwner = { ...h.context, ownerId: 'os-user:999999999' };
    for (const action of [() => h.store.create(h.plan, h.payload, wrongOwner), () => h.store.inspect(h.id, wrongOwner),
      () => h.store.cancel(h.id, wrongOwner), () => h.store.prune(wrongOwner)]) {
      assert.throws(action, { code: 'COMPANY_READONLY_V2_OWNER_MISMATCH' });
    }
    assert.throws(() => h.store.create(h.plan, h.payload, { ...h.context, now: new Date('invalid') }), { code: 'COMPANY_READONLY_V2_INVALID_TIME' });
    assert.throws(() => h.store.create(h.plan, h.payload, { ...h.context, now: new Date(h.context.now.getTime() - 1) }), { code: 'COMPANY_READONLY_V2_INVALID_TIME' });
    assert.throws(() => h.store.create({ ...h.plan, planHash: '0'.repeat(64) }, h.payload, h.context), { code: 'COMPANY_READONLY_V2_INVALID_PLAN' });
    assert.throws(() => h.store.create(h.plan, { ...h.payload, reviewInput: '{}' }, h.context), { code: 'COMPANY_READONLY_V2_INVALID_PAYLOAD' });
    assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
    h.store.create(h.plan, h.payload, h.context);
    const later = { ...h.context, now: new Date(h.context.now.getTime() + 1000) }; h.store.cancel(h.id, later);
    assert.throws(() => h.store.prune(h.context), { code: 'COMPANY_READONLY_V2_TIME_REVERSED' });
    h.store.close(); assert.throws(() => h.store.inspect(h.id, later), { code: 'COMPANY_READONLY_V2_STORE_CLOSED' });
  } finally { h.close(); }
});

test('inspect, cancel and retention maintenance use stored proof without reopening the synthetic source', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context); fs.rmSync(h.root, { recursive: true }); h.reopen();
    assert.equal(h.store.inspect(h.id, h.context).status, 'AWAITING_APPROVAL');
    assert.equal(h.store.cancel(h.id, h.context).status, 'CANCELLED');
    assert.deepEqual(h.store.prune({ ...h.context, now: new Date(h.plan.auditExpiresAt) }), { payloadsRemoved: 0, recordsRemoved: 1 });
  } finally { h.close(); }
});

test('v2 creation refuses a store location inside its registered source before persisting preparation data', async context => {
  const h = await setup(context), file = join(h.root, 'company-readonly-v2.sqlite');
  const overlapping = new SqliteCompanyReadonlyV2Store(file);
  try {
    assert.throws(() => overlapping.create(h.plan, h.payload, h.context), { code: 'COMPANY_READONLY_V2_UNSAFE_LOCATION' });
    assert.deepEqual(counts(file), { plans: 0, payloads: 0, bindings: 1 });
  } finally { overlapping.close(); h.close(); }
});

test('v1, foreign and malformed databases are never migrated or changed by the v2 constructor', () => {
  for (const kind of ['v1', 'foreign', 'malformed', 'empty'] as const) {
    const h = privateDirectory();
    try {
      if (kind === 'v1') {
        const v1Path = join(h.directory, 'company-readonly.sqlite'), v1 = new SqliteCompanyReadonlyStore(v1Path); v1.close();
        const before = preserved(v1Path);
        assert.throws(() => new SqliteCompanyReadonlyV2Store(v1Path), { code: 'UNSAFE_RUNTIME_PATH' });
        assert.deepEqual(preserved(v1Path), before); fs.copyFileSync(v1Path, h.file);
      } else if (kind === 'foreign') {
        const database = new DatabaseSync(h.file); database.exec('CREATE TABLE foreign_records (id TEXT)'); database.close(); fs.chmodSync(h.file, 0o600);
      } else fs.writeFileSync(h.file, kind === 'empty' ? '' : 'SYNTHETIC_PRIVATE_DATABASE', { mode: 0o600 });
      const before = preserved(h.file);
      assert.throws(() => new SqliteCompanyReadonlyV2Store(h.file), error => {
        assert.ok(error instanceof HarnessError); assert.equal(error.code, 'COMPANY_READONLY_V2_INVALID_STORE'); assert.equal(error.message, error.code); return true;
      });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('v2 location binding survives payload removal and refuses moved or copied databases before writes', async context => {
  for (const operation of ['move', 'copy'] as const) {
    const h = await setup(context);
    try {
      h.store.create(h.plan, h.payload, h.context); h.store.cancel(h.id, h.context); h.store.close();
      const destination = join(h.root, 'company-readonly-v2.sqlite');
      if (operation === 'move') fs.renameSync(h.file, destination); else fs.copyFileSync(h.file, destination);
      const before = preserved(destination);
      assert.throws(() => new SqliteCompanyReadonlyV2Store(destination), { code: 'COMPANY_READONLY_V2_INVALID_STORE' });
      assert.deepEqual(preserved(destination), before);
    } finally { h.close(); }
  }
});

test('v2 private permissions and leaf/parent links are refused without chmod or repair', () => {
  const h = privateDirectory(); let store: SqliteCompanyReadonlyV2Store | undefined;
  try {
    store = new SqliteCompanyReadonlyV2Store(h.file); store.close();
    fs.chmodSync(h.file, 0o644); assert.throws(() => new SqliteCompanyReadonlyV2Store(h.file), { code: 'UNSAFE_RUNTIME_FILE' });
    assert.equal(fs.lstatSync(h.file).mode & 0o7777, 0o644); fs.chmodSync(h.file, 0o600);
    fs.chmodSync(h.directory, 0o755); assert.throws(() => new SqliteCompanyReadonlyV2Store(h.file), { code: 'UNSAFE_RUNTIME_PATH' });
    assert.equal(fs.lstatSync(h.directory).mode & 0o7777, 0o755); fs.chmodSync(h.directory, 0o700);
    const child = join(h.directory, 'links'); fs.mkdirSync(child, { mode: 0o700 }); const linked = join(child, 'company-readonly-v2.sqlite');
    fs.symlinkSync(h.file, linked); assert.throws(() => new SqliteCompanyReadonlyV2Store(linked), { code: 'UNSAFE_RUNTIME_FILE' }); fs.unlinkSync(linked);
    fs.linkSync(h.file, linked); assert.throws(() => new SqliteCompanyReadonlyV2Store(h.file), { code: 'UNSAFE_RUNTIME_FILE' }); fs.unlinkSync(linked);
    const parent = join(h.directory, 'parent-link'); fs.symlinkSync(child, parent);
    assert.throws(() => new SqliteCompanyReadonlyV2Store(join(parent, 'company-readonly-v2.sqlite')), { code: 'UNSAFE_RUNTIME_PATH' });
  } finally { store?.close(); h.close(); }
});

test('v2 sidecars and an already-open database retain single-link and stable-inode checks', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context); h.store.close();
    const canary = join(h.directory, 'synthetic-canary'); fs.writeFileSync(canary, 'synthetic-only', { mode: 0o600 });
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const sidecar = h.file + suffix; fs.symlinkSync(canary, sidecar);
      const before = preserved(h.file);
      assert.throws(() => new SqliteCompanyReadonlyV2Store(h.file), { code: 'UNSAFE_RUNTIME_FILE' });
      assert.deepEqual(preserved(h.file), before); fs.unlinkSync(sidecar);
    }
    h.reopen(); const displaced = `${h.file}.original`; fs.renameSync(h.file, displaced); fs.copyFileSync(displaced, h.file);
    const oldBefore = preserved(displaced), newBefore = preserved(h.file);
    assert.throws(() => h.store.cancel(h.id, h.context), { code: 'UNSAFE_RUNTIME_FILE' });
    assert.deepEqual(preserved(displaced), oldBefore); assert.deepEqual(preserved(h.file), newBefore);
  } finally { h.close(); }
});

test('v2 tampering is rejected on readonly reopen before any writable connection modifies the file', async context => {
  for (const kind of ['plan', 'payload', 'payload-hash', 'duplicate-json', 'oversized', 'empty-id', 'extra-table'] as const) {
    const h = await setup(context);
    try {
      h.store.create(h.plan, h.payload, h.context); h.store.close(); const database = new DatabaseSync(h.file);
      try {
        if (kind === 'plan') database.prepare('UPDATE company_readonly_v2_preparations SET record_hash = ?').run('0'.repeat(64));
        if (kind === 'payload') database.prepare('UPDATE company_readonly_v2_payloads SET payload_json = ?').run('{}');
        if (kind === 'payload-hash') database.prepare('UPDATE company_readonly_v2_preparations SET payload_hash = ?').run('0'.repeat(64));
        if (kind === 'duplicate-json') {
          const row = database.prepare('SELECT plan_json FROM company_readonly_v2_preparations').get()!;
          database.prepare('UPDATE company_readonly_v2_preparations SET plan_json = ?').run(String(row.plan_json).replace('"version":', '"version":"duplicate","version":'));
        }
        if (kind === 'oversized') {
          database.exec('PRAGMA ignore_check_constraints = ON');
          database.prepare('UPDATE company_readonly_v2_payloads SET payload_json = ?').run(JSON.stringify('x'.repeat(2_097_153)));
        }
        if (kind === 'empty-id') {
          database.exec("PRAGMA foreign_keys = OFF; UPDATE company_readonly_v2_preparations SET preparation_id = ''; UPDATE company_readonly_v2_payloads SET preparation_id = '';");
        }
        if (kind === 'extra-table') database.exec('CREATE TABLE approvals (id TEXT)');
      } finally { database.close(); }
      const before = preserved(h.file);
      assert.throws(() => new SqliteCompanyReadonlyV2Store(h.file), { code: kind === 'extra-table' ? 'COMPANY_READONLY_V2_INVALID_STORE' : 'COMPANY_READONLY_V2_INVALID_RECORD' });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('a failure after inserting the plan rolls the entire v2 transaction back and exposes only a fixed code', async context => {
  const h = await setup(context), originalPrepare = DatabaseSync.prototype.prepare;
  const mocked = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('INSERT INTO company_readonly_v2_payloads')) throw new Error(`SYNTHETIC_PRIVATE_SQL_FAILURE ${h.directory}`);
    return originalPrepare.call(this, sql);
  });
  try {
    assert.throws(() => h.store.create(h.plan, h.payload, h.context), error => {
      assert.ok(error instanceof HarnessError); assert.equal(error.code, 'COMPANY_READONLY_V2_INVALID_RECORD'); assert.equal(error.message, error.code); return true;
    });
    mocked.mock.restore(); assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
    assert.equal(h.store.create(h.plan, h.payload, h.context).plan.id, h.id);
  } finally { mocked.mock.restore(); h.close(); }
});
