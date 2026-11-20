import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants as sqliteConstants, DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteCompanyReadonlyStore } from '../src/adapters/sqlite-company-readonly-store.js';
import { SqliteCompanyReadonlyV2Store } from '../src/adapters/sqlite-company-readonly-v2-store.js';
import { SqliteCompanyReadonlyV3Store } from '../src/adapters/sqlite-company-readonly-v3-store.js';
import { HarnessError } from '../src/domain/errors.js';
import { createCompanyReadonlyPreparationV2 } from '../src/policy/company-readonly-v2.js';
import { createCompanyReadonlyPreparationV3 } from '../src/policy/company-readonly-v3.js';
import { getCompanyGitRangeUnitGuardPolicyHash } from '../src/policy/company-git-range-unit-budget.js';
import { createCompanyReadonlyV2Fixture } from './company-readonly-v2-fixture.js';
import { createCompanyReadonlyV3Fixture } from './company-readonly-v3-fixture.js';

const privateDirectory = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v3-store-'))); fs.chmodSync(directory, 0o700);
  return { directory, file: join(directory, 'company-readonly-v3.sqlite'), close: () => fs.rmSync(directory, { recursive: true, force: true }) };
};
const setup = async (context: TestContext) => {
  const fixture = await createCompanyReadonlyV3Fixture(context), inputs = await fixture.prepareInput();
  const prepared = createCompanyReadonlyPreparationV3(inputs.registration, inputs.policy, inputs.observation,
    inputs.collected, inputs.budget, inputs.context, inputs.id);
  const files = privateDirectory(); let store = new SqliteCompanyReadonlyV3Store(files.file);
  const prepare = (id = inputs.id, question = inputs.registration.question, now = inputs.context) =>
    createCompanyReadonlyPreparationV3({ ...inputs.registration, question }, inputs.policy, inputs.observation,
      inputs.collected, inputs.budget, now, id);
  return { ...fixture, ...files, ...prepared, inputs, prepare, get store() { return store; },
    reopen: () => { store.close(); store = new SqliteCompanyReadonlyV3Store(files.file); },
    close: () => { store.close(); files.close(); } };
};
const counts = (file: string) => {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return { plans: database.prepare('SELECT count(*) AS n FROM company_readonly_v3_preparations').get()!.n,
    payloads: database.prepare('SELECT count(*) AS n FROM company_readonly_v3_payloads').get()!.n,
    bindings: database.prepare('SELECT count(*) AS n FROM company_readonly_v3_store').get()!.n }; }
  finally { database.close(); }
};
const preserved = (file: string) => {
  const metadata = fs.lstatSync(file, { bigint: true });
  return { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid, gid: metadata.gid, mode: metadata.mode, links: metadata.nlink,
    size: metadata.size, modified: metadata.mtimeNs, changed: metadata.ctimeNs,
    hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
};

test('v3 storage uses private separate identity and tables, persists immutable preparation state and exposes no execution API', async context => {
  const h = await setup(context);
  try {
    const result = h.store.create(h.plan, h.payload, h.context);
    assert.equal(result.plan.id, h.id); assert.equal(result.status, 'AWAITING_APPROVAL');
    assert.equal(result.plan.guardPolicyHash, getCompanyGitRangeUnitGuardPolicyHash());
    assert.deepEqual([result.approvalCreated, result.transmissionAllowed, result.executionAllowed, result.companyPolicyVerified], [false, false, false, false]);
    assert.equal(fs.lstatSync(h.file).mode & 0o7777, 0o600); assert.equal(fs.lstatSync(h.file).nlink, 1);
    const database = new DatabaseSync(h.file, { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA application_id').get()!.application_id, 0x43525033);
      assert.equal(database.prepare('PRAGMA user_version').get()!.user_version, 1);
      assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name),
        ['company_readonly_v3_payloads', 'company_readonly_v3_preparations', 'company_readonly_v3_store']);
    } finally { database.close(); }
    h.reopen(); assert.deepEqual(h.store.inspect(h.id, h.context), result);
    result.plan.planHash = '0'.repeat(64); result.payload!.registration.question = 'changed returned value';
    assert.deepEqual(h.store.inspect(h.id, h.context).plan, h.plan);
    assert.deepEqual(h.store.inspect(h.id, h.context).payload, h.payload);
    for (const action of ['approve', 'claim', 'dispatch', 'run', 'transmit']) assert.equal(action in h.store, false);
  } finally { h.close(); }
});

test('actual v2 and v3 plans and payloads cannot cross store contracts or change either database', async context => {
  const h = await setup(context), legacy = await createCompanyReadonlyV2Fixture(context), input = legacy.prepareInput();
  const oldPrepared = createCompanyReadonlyPreparationV2(input.registration, input.policy, input.observation,
    input.collected, input.budget, input.context, input.id);
  const legacyPath = join(h.directory, 'company-readonly-v2.sqlite'), oldStore = new SqliteCompanyReadonlyV2Store(legacyPath);
  try {
    const before = preserved(h.file), oldBefore = preserved(legacyPath);
    assert.throws(() => h.store.create(oldPrepared.plan as unknown as typeof h.plan, oldPrepared.payload as unknown as typeof h.payload, h.context),
      { code: 'COMPANY_READONLY_V3_INVALID_PLAN' });
    assert.throws(() => h.store.create(h.plan, oldPrepared.payload as unknown as typeof h.payload, h.context),
      { code: 'COMPANY_READONLY_V3_INVALID_PAYLOAD' });
    assert.throws(() => h.store.create({ ...h.plan, guardPolicyHash: '0'.repeat(64) }, h.payload, h.context),
      { code: 'COMPANY_READONLY_V3_INVALID_PLAN' });
    assert.throws(() => h.store.create(h.plan, { ...h.payload, registration: { ...h.payload.registration, guardPolicyHash: '0'.repeat(64) } }, h.context),
      { code: 'COMPANY_READONLY_V3_INVALID_PAYLOAD' });
    assert.throws(() => oldStore.create(h.plan as unknown as Parameters<SqliteCompanyReadonlyV2Store['create']>[0],
      h.payload as unknown as Parameters<SqliteCompanyReadonlyV2Store['create']>[1], h.context), { code: 'COMPANY_READONLY_V2_INVALID_PLAN' });
    assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
    assert.deepEqual(preserved(h.file), before); assert.deepEqual(preserved(legacyPath), oldBefore);
    assert.equal(h.store.create(h.plan, h.payload, h.context).plan.guardPolicyHash, getCompanyGitRangeUnitGuardPolicyHash());
  } finally { oldStore.close(); h.close(); }
});

test('only exact same-ID retries reuse a preparation; a new ID stays distinct and conflicting reuse is refused', async context => {
  const h = await setup(context);
  try {
    const original = h.store.create(h.plan, h.payload, h.context), secondStore = new SqliteCompanyReadonlyV3Store(h.file);
    try { assert.deepEqual(secondStore.create(h.plan, h.payload, h.context), original); }
    finally { secondStore.close(); }
    const next = h.prepare('22222222-2222-4222-8222-222222222222');
    assert.notEqual(next.plan.preparationKey, h.plan.preparationKey);
    assert.equal(h.store.create(next.plan, next.payload, h.context).plan.id, next.plan.id);
    const conflict = h.prepare(h.id, 'Explain a different synthetic question.');
    assert.throws(() => h.store.create(conflict.plan, conflict.payload, h.context), { code: 'COMPANY_READONLY_V3_ID_REUSED' });
    const later = { ...h.context, now: new Date(h.context.now.getTime() + 1000) }, changedTime = h.prepare(h.id, undefined, later);
    assert.throws(() => h.store.create(changedTime.plan, changedTime.payload, later), { code: 'COMPANY_READONLY_V3_ID_REUSED' });
    assert.deepEqual(counts(h.file), { plans: 2, payloads: 2, bindings: 1 });
    assert.deepEqual(h.store.inspect(h.id, h.context), original);
  } finally { h.close(); }
});

test('cancel deletes the v3 payload immediately while exact retries preserve the cancelled ID and its hash evidence', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context);
    const later = { ...h.context, now: new Date(h.context.now.getTime() + 1000) }, result = h.store.cancel(h.id, later);
    assert.equal(result.status, 'CANCELLED'); assert.equal(result.payload, null);
    assert.deepEqual(counts(h.file), { plans: 1, payloads: 0, bindings: 1 });
    h.reopen(); assert.deepEqual(h.store.create(h.plan, h.payload, later), result);
    const conflict = h.prepare(h.id, 'A conflicting retry after cancellation.');
    assert.throws(() => h.store.create(conflict.plan, conflict.payload, later), { code: 'COMPANY_READONLY_V3_ID_REUSED' });
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
    assert.throws(() => h.store.create(h.plan, h.payload, audit), { code: 'COMPANY_READONLY_V3_NOT_FOUND' });
    assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
    assert.throws(() => h.store.create(h.plan, h.payload, audit), { code: 'COMPANY_READONLY_V3_EXPIRED' });
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
      assert.throws(action, { code: 'COMPANY_READONLY_V3_OWNER_MISMATCH' });
    }
    assert.throws(() => h.store.create(h.plan, h.payload, { ...h.context, now: new Date('invalid') }), { code: 'COMPANY_READONLY_V3_INVALID_TIME' });
    assert.throws(() => h.store.create(h.plan, h.payload, { ...h.context, now: new Date(h.context.now.getTime() - 1) }), { code: 'COMPANY_READONLY_V3_INVALID_TIME' });
    assert.throws(() => h.store.create({ ...h.plan, planHash: '0'.repeat(64) }, h.payload, h.context), { code: 'COMPANY_READONLY_V3_INVALID_PLAN' });
    assert.throws(() => h.store.create(h.plan, { ...h.payload, reviewInput: '{}' }, h.context), { code: 'COMPANY_READONLY_V3_INVALID_PAYLOAD' });
    assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
    h.store.create(h.plan, h.payload, h.context);
    const later = { ...h.context, now: new Date(h.context.now.getTime() + 1000) }; h.store.cancel(h.id, later);
    assert.throws(() => h.store.prune(h.context), { code: 'COMPANY_READONLY_V3_TIME_REVERSED' });
    h.store.close(); assert.throws(() => h.store.inspect(h.id, later), { code: 'COMPANY_READONLY_V3_STORE_CLOSED' });
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

test('v3 creation refuses a store location inside its registered source before persisting preparation data', async context => {
  const h = await setup(context), file = join(h.root, 'company-readonly-v3.sqlite');
  const overlapping = new SqliteCompanyReadonlyV3Store(file);
  try {
    assert.throws(() => overlapping.create(h.plan, h.payload, h.context), { code: 'COMPANY_READONLY_V3_UNSAFE_LOCATION' });
    assert.deepEqual(counts(file), { plans: 0, payloads: 0, bindings: 1 });
  } finally { overlapping.close(); h.close(); }
});

test('v1, v2, foreign and malformed databases are never migrated or changed by the v3 constructor', () => {
  for (const kind of ['v1', 'v2', 'foreign', 'malformed', 'empty'] as const) {
    const h = privateDirectory();
    try {
      if (kind === 'v1' || kind === 'v2') {
        const legacyPath = join(h.directory, kind === 'v1' ? 'company-readonly.sqlite' : 'company-readonly-v2.sqlite');
        const legacy = kind === 'v1' ? new SqliteCompanyReadonlyStore(legacyPath) : new SqliteCompanyReadonlyV2Store(legacyPath);
        legacy.close(); const before = preserved(legacyPath);
        assert.throws(() => new SqliteCompanyReadonlyV3Store(legacyPath), { code: 'UNSAFE_RUNTIME_PATH' });
        assert.deepEqual(preserved(legacyPath), before); fs.copyFileSync(legacyPath, h.file);
      } else if (kind === 'foreign') {
        const database = new DatabaseSync(h.file); database.exec('CREATE TABLE foreign_records (id TEXT)'); database.close(); fs.chmodSync(h.file, 0o600);
      } else fs.writeFileSync(h.file, kind === 'empty' ? '' : 'SYNTHETIC_PRIVATE_DATABASE', { mode: 0o600 });
      const before = preserved(h.file);
      assert.throws(() => new SqliteCompanyReadonlyV3Store(h.file), error => {
        assert.ok(error instanceof HarnessError); assert.equal(error.code, 'COMPANY_READONLY_V3_INVALID_STORE'); assert.equal(error.message, error.code); return true;
      });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('v3 location binding survives payload removal and refuses moved or copied databases before writes', async context => {
  for (const operation of ['move', 'copy'] as const) {
    const h = await setup(context);
    try {
      h.store.create(h.plan, h.payload, h.context); h.store.cancel(h.id, h.context); h.store.close();
      const destination = join(h.root, 'company-readonly-v3.sqlite');
      if (operation === 'move') fs.renameSync(h.file, destination); else fs.copyFileSync(h.file, destination);
      const before = preserved(destination);
      assert.throws(() => new SqliteCompanyReadonlyV3Store(destination), { code: 'COMPANY_READONLY_V3_INVALID_STORE' });
      assert.deepEqual(preserved(destination), before);
    } finally { h.close(); }
  }
});

test('v3 private permissions and leaf/parent links are refused without chmod or repair', () => {
  const h = privateDirectory(); let store: SqliteCompanyReadonlyV3Store | undefined;
  try {
    store = new SqliteCompanyReadonlyV3Store(h.file); store.close();
    fs.chmodSync(h.file, 0o644); assert.throws(() => new SqliteCompanyReadonlyV3Store(h.file), { code: 'UNSAFE_RUNTIME_FILE' });
    assert.equal(fs.lstatSync(h.file).mode & 0o7777, 0o644); fs.chmodSync(h.file, 0o600);
    fs.chmodSync(h.directory, 0o755); assert.throws(() => new SqliteCompanyReadonlyV3Store(h.file), { code: 'UNSAFE_RUNTIME_PATH' });
    assert.equal(fs.lstatSync(h.directory).mode & 0o7777, 0o755); fs.chmodSync(h.directory, 0o700);
    const child = join(h.directory, 'links'); fs.mkdirSync(child, { mode: 0o700 }); const linked = join(child, 'company-readonly-v3.sqlite');
    fs.symlinkSync(h.file, linked); assert.throws(() => new SqliteCompanyReadonlyV3Store(linked), { code: 'UNSAFE_RUNTIME_FILE' }); fs.unlinkSync(linked);
    fs.linkSync(h.file, linked); assert.throws(() => new SqliteCompanyReadonlyV3Store(h.file), { code: 'UNSAFE_RUNTIME_FILE' }); fs.unlinkSync(linked);
    const parent = join(h.directory, 'parent-link'); fs.symlinkSync(child, parent);
    assert.throws(() => new SqliteCompanyReadonlyV3Store(join(parent, 'company-readonly-v3.sqlite')), { code: 'UNSAFE_RUNTIME_PATH' });
  } finally { store?.close(); h.close(); }
});

test('an open v3 store refuses later public data or directory permissions without changing or repairing data', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context);
    fs.chmodSync(h.file, 0o644); const before = preserved(h.file);
    assert.throws(() => h.store.cancel(h.id, h.context), { code: 'UNSAFE_RUNTIME_FILE' });
    assert.deepEqual(preserved(h.file), before); assert.equal(fs.lstatSync(h.file).mode & 0o7777, 0o644);
    fs.chmodSync(h.file, 0o600); fs.chmodSync(h.directory, 0o755);
    const privateFile = preserved(h.file);
    assert.throws(() => h.store.inspect(h.id, h.context), { code: 'UNSAFE_RUNTIME_PATH' });
    assert.deepEqual(preserved(h.file), privateFile); assert.equal(fs.lstatSync(h.directory).mode & 0o7777, 0o755);
    fs.chmodSync(h.directory, 0o700); assert.equal(h.store.inspect(h.id, h.context).status, 'AWAITING_APPROVAL');
  } finally { fs.chmodSync(h.directory, 0o700); fs.chmodSync(h.file, 0o600); h.close(); }
});

test('v3 sidecars and an already-open database retain single-link and stable-inode checks', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context); h.store.close();
    const canary = join(h.directory, 'synthetic-canary'); fs.writeFileSync(canary, 'synthetic-only', { mode: 0o600 });
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const sidecar = h.file + suffix; fs.symlinkSync(canary, sidecar);
      const before = preserved(h.file);
      assert.throws(() => new SqliteCompanyReadonlyV3Store(h.file), { code: 'UNSAFE_RUNTIME_FILE' });
      assert.deepEqual(preserved(h.file), before); fs.unlinkSync(sidecar);
    }
    h.reopen(); const displaced = `${h.file}.original`; fs.renameSync(h.file, displaced); fs.copyFileSync(displaced, h.file);
    const oldBefore = preserved(displaced), newBefore = preserved(h.file);
    assert.throws(() => h.store.cancel(h.id, h.context), { code: 'UNSAFE_RUNTIME_FILE' });
    assert.deepEqual(preserved(displaced), oldBefore); assert.deepEqual(preserved(h.file), newBefore);
  } finally { h.close(); }
});

test('v3 tampering is rejected on readonly reopen before any writable connection modifies the file', async context => {
  for (const kind of ['plan', 'guard-policy', 'owner-binding', 'payload', 'payload-hash', 'duplicate-json', 'oversized', 'empty-id', 'extra-table'] as const) {
    const h = await setup(context);
    try {
      h.store.create(h.plan, h.payload, h.context); h.store.close(); const database = new DatabaseSync(h.file);
      try {
        if (kind === 'plan') database.prepare('UPDATE company_readonly_v3_preparations SET record_hash = ?').run('0'.repeat(64));
        if (kind === 'guard-policy') {
          const row = database.prepare('SELECT plan_json FROM company_readonly_v3_preparations').get()!;
          const plan = JSON.parse(String(row.plan_json)) as Record<string, unknown>;
          database.prepare('UPDATE company_readonly_v3_preparations SET plan_json = ?').run(JSON.stringify({ ...plan, guardPolicyHash: '0'.repeat(64) }));
        }
        if (kind === 'owner-binding') database.prepare('UPDATE company_readonly_v3_store SET owner_id = ?').run('os-user:999999999');
        if (kind === 'payload') database.prepare('UPDATE company_readonly_v3_payloads SET payload_json = ?').run('{}');
        if (kind === 'payload-hash') database.prepare('UPDATE company_readonly_v3_preparations SET payload_hash = ?').run('0'.repeat(64));
        if (kind === 'duplicate-json') {
          const row = database.prepare('SELECT plan_json FROM company_readonly_v3_preparations').get()!;
          database.prepare('UPDATE company_readonly_v3_preparations SET plan_json = ?').run(String(row.plan_json).replace('"version":', '"version":"duplicate","version":'));
        }
        if (kind === 'oversized') {
          database.exec('PRAGMA ignore_check_constraints = ON');
          database.prepare('UPDATE company_readonly_v3_payloads SET payload_json = ?').run(JSON.stringify('x'.repeat(2_097_153)));
        }
        if (kind === 'empty-id') {
          database.exec("PRAGMA foreign_keys = OFF; UPDATE company_readonly_v3_preparations SET preparation_id = ''; UPDATE company_readonly_v3_payloads SET preparation_id = '';");
        }
        if (kind === 'extra-table') database.exec('CREATE TABLE approvals (id TEXT)');
      } finally { database.close(); }
      const before = preserved(h.file);
      assert.throws(() => new SqliteCompanyReadonlyV3Store(h.file), { code: ['extra-table', 'owner-binding'].includes(kind)
        ? 'COMPANY_READONLY_V3_INVALID_STORE' : 'COMPANY_READONLY_V3_INVALID_RECORD' });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('a failure after inserting the plan rolls the entire v3 transaction back and exposes only a fixed code', async context => {
  const h = await setup(context), originalPrepare = DatabaseSync.prototype.prepare;
  const mocked = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('INSERT INTO company_readonly_v3_payloads')) throw new Error(`SYNTHETIC_PRIVATE_SQL_FAILURE ${h.directory}`);
    return originalPrepare.call(this, sql);
  });
  try {
    assert.throws(() => h.store.create(h.plan, h.payload, h.context), error => {
      assert.ok(error instanceof HarnessError); assert.equal(error.code, 'COMPANY_READONLY_V3_INVALID_RECORD'); assert.equal(error.message, error.code); return true;
    });
    mocked.mock.restore(); assert.deepEqual(counts(h.file), { plans: 0, payloads: 0, bindings: 1 });
    assert.equal(h.store.create(h.plan, h.payload, h.context).plan.id, h.id);
  } finally { mocked.mock.restore(); h.close(); }
});

test('prune-only opening and transactions never read the payload column, including malformed unexpired bodies', async context => {
  const h = await setup(context);
  let pruner: SqliteCompanyReadonlyV3Store | undefined;
  try {
    h.store.create(h.plan, h.payload, h.context);
    const later = { ...h.context, now: new Date(h.context.now.getTime() + 30 * 60_000) };
    const fresh = h.prepare('ffffffff-ffff-4fff-8fff-ffffffffffff', undefined, later);
    h.store.create(fresh.plan, fresh.payload, later); h.store.close();
    const damaged = new DatabaseSync(h.file), expiredBody = 'SYNTHETIC_EXPIRED_BODY {', freshBody = 'SYNTHETIC_UNEXPIRED_BODY {';
    try {
      damaged.prepare('UPDATE company_readonly_v3_payloads SET payload_json = ? WHERE preparation_id = ?').run(expiredBody, h.id);
      damaged.prepare('UPDATE company_readonly_v3_payloads SET payload_json = ? WHERE preparation_id = ?').run(freshBody, fresh.plan.id);
    } finally { damaged.close(); }
    assert.throws(() => new SqliteCompanyReadonlyV3Store(h.file), { code: 'COMPANY_READONLY_V3_INVALID_RECORD' });

    const originalPrepare = DatabaseSync.prototype.prepare, guarded = new WeakSet<DatabaseSync>();
    let payloadReads = 0;
    const mock = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (!guarded.has(this)) {
        this.setAuthorizer((action, table, column) => {
          if (action === sqliteConstants.SQLITE_READ && table === 'company_readonly_v3_payloads' && column === 'payload_json') {
            payloadReads += 1; return sqliteConstants.SQLITE_DENY;
          }
          return sqliteConstants.SQLITE_OK;
        });
        guarded.add(this);
      }
      return originalPrepare.call(this, sql);
    });
    try {
      pruner = SqliteCompanyReadonlyV3Store.openForPrune(h.file);
      const before = preserved(h.file);
      assert.deepEqual(pruner.prune({ ...h.context, now: new Date(Date.parse(h.plan.expiresAt) - 1) }), { payloadsRemoved: 0, recordsRemoved: 0 });
      assert.deepEqual(preserved(h.file), before);
      assert.deepEqual(pruner.prune({ ...h.context, now: new Date(h.plan.expiresAt) }), { payloadsRemoved: 1, recordsRemoved: 0 });
      assert.deepEqual(counts(h.file), { plans: 2, payloads: 1, bindings: 1 });
      assert.deepEqual(pruner.prune({ ...h.context, now: new Date(h.plan.expiresAt) }), { payloadsRemoved: 0, recordsRemoved: 0 });
      assert.equal(payloadReads, 0);
    } finally { mock.mock.restore(); }
    const remaining = new DatabaseSync(h.file, { readOnly: true });
    try {
      assert.equal(remaining.prepare('SELECT payload_json FROM company_readonly_v3_payloads WHERE preparation_id = ?').get(fresh.plan.id)!.payload_json, freshBody);
      const record = remaining.prepare('SELECT status, updated_at, audit_expires_at FROM company_readonly_v3_preparations WHERE preparation_id = ?').get(h.id)!;
      assert.equal(record.status, 'EXPIRED'); assert.equal(record.updated_at, h.plan.expiresAt); assert.equal(record.audit_expires_at, h.plan.auditExpiresAt);
    } finally { remaining.close(); }
    assert.deepEqual(pruner.prune({ ...h.context, now: new Date(Date.parse(h.plan.auditExpiresAt) - 1) }), { payloadsRemoved: 1, recordsRemoved: 0 });
    assert.deepEqual(pruner.prune({ ...h.context, now: new Date(h.plan.auditExpiresAt) }), { payloadsRemoved: 0, recordsRemoved: 1 });
    assert.deepEqual(counts(h.file), { plans: 1, payloads: 0, bindings: 1 });
    assert.deepEqual(pruner.prune({ ...h.context, now: new Date(fresh.plan.auditExpiresAt) }), { payloadsRemoved: 0, recordsRemoved: 1 });
  } finally { pruner?.close(); h.close(); }
});

test('a prune-only store cannot create, inspect or cancel, and refuses invalid owners or time without changes', async context => {
  const h = await setup(context);
  let pruner: SqliteCompanyReadonlyV3Store | undefined;
  try {
    h.store.create(h.plan, h.payload, h.context); h.store.close();
    pruner = SqliteCompanyReadonlyV3Store.openForPrune(h.file);
    const before = preserved(h.file);
    const unreadable = new Proxy(h.payload, { get: () => { throw new Error('PAYLOAD_ARGUMENT_MUST_NOT_BE_READ'); } });
    assert.throws(() => pruner!.create(h.plan, unreadable, h.context), { code: 'COMPANY_READONLY_V3_INVALID_STORE' });
    assert.throws(() => pruner!.inspect(h.id, h.context), { code: 'COMPANY_READONLY_V3_INVALID_STORE' });
    assert.throws(() => pruner!.cancel(h.id, h.context), { code: 'COMPANY_READONLY_V3_INVALID_STORE' });
    assert.throws(() => pruner!.prune({ ...h.context, ownerId: 'os-user:999999999' }), { code: 'COMPANY_READONLY_V3_OWNER_MISMATCH' });
    assert.throws(() => pruner!.prune({ ...h.context, now: new Date(h.context.now.getTime() - 1) }), { code: 'COMPANY_READONLY_V3_TIME_REVERSED' });
    assert.deepEqual(preserved(h.file), before);
    pruner.close(); assert.throws(() => pruner!.prune(h.context), { code: 'COMPANY_READONLY_V3_STORE_CLOSED' });
  } finally { pruner?.close(); h.close(); }
});

test('prune-only validation still refuses altered record, owner, schema and payload metadata before writes', async context => {
  for (const kind of ['record', 'owner', 'schema', 'expiry', 'payload-hash', 'missing-payload', 'terminal-payload'] as const) {
    const h = await setup(context);
    try {
      h.store.create(h.plan, h.payload, h.context);
      if (kind === 'terminal-payload') h.store.cancel(h.id, h.context);
      h.store.close(); const database = new DatabaseSync(h.file);
      try {
        if (kind === 'record') database.prepare('UPDATE company_readonly_v3_preparations SET record_hash = ?').run('0'.repeat(64));
        if (kind === 'owner') database.prepare('UPDATE company_readonly_v3_store SET owner_id = ?').run('os-user:999999999');
        if (kind === 'schema') database.exec('CREATE TABLE unexpected (id TEXT)');
        if (kind === 'expiry') database.prepare('UPDATE company_readonly_v3_payloads SET expires_at = ?').run(h.plan.auditExpiresAt);
        if (kind === 'payload-hash') database.prepare('UPDATE company_readonly_v3_payloads SET payload_hash = ?').run('0'.repeat(64));
        if (kind === 'missing-payload') database.exec('DELETE FROM company_readonly_v3_payloads');
        if (kind === 'terminal-payload') {
          const row = database.prepare('SELECT payload_hash FROM company_readonly_v3_preparations WHERE preparation_id = ?').get(h.id)!;
          database.prepare('INSERT INTO company_readonly_v3_payloads VALUES (?, ?, ?, ?)').run(h.id, h.plan.expiresAt, row.payload_hash!, '{}');
        }
      } finally { database.close(); }
      const before = preserved(h.file);
      assert.throws(() => SqliteCompanyReadonlyV3Store.openForPrune(h.file), { code: ['owner', 'schema'].includes(kind)
        ? 'COMPANY_READONLY_V3_INVALID_STORE' : 'COMPANY_READONLY_V3_INVALID_RECORD' });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('prune-only opening refuses missing or unsafe locations and never creates a replacement database', () => {
  const h = privateDirectory();
  try {
    assert.throws(() => SqliteCompanyReadonlyV3Store.openForPrune(h.file), { code: 'COMPANY_READONLY_V3_INVALID_STORE' });
    assert.equal(fs.existsSync(h.file), false);
    new SqliteCompanyReadonlyV3Store(h.file).close(); fs.chmodSync(h.file, 0o644);
    const before = preserved(h.file);
    assert.throws(() => SqliteCompanyReadonlyV3Store.openForPrune(h.file), { code: 'UNSAFE_RUNTIME_FILE' });
    assert.deepEqual(preserved(h.file), before); fs.chmodSync(h.file, 0o600);
    const link = join(h.directory, 'link'); fs.mkdirSync(link, { mode: 0o700 });
    fs.symlinkSync(h.file, join(link, 'company-readonly-v3.sqlite'));
    assert.throws(() => SqliteCompanyReadonlyV3Store.openForPrune(join(link, 'company-readonly-v3.sqlite')), { code: 'UNSAFE_RUNTIME_FILE' });
  } finally { h.close(); }
});

test('ordinary open stores retain full payload validation for every transaction even after expiry', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context);
    const database = new DatabaseSync(h.file);
    try { database.prepare('UPDATE company_readonly_v3_payloads SET payload_json = ?').run('SYNTHETIC_DAMAGED_BODY {'); }
    finally { database.close(); }
    const before = preserved(h.file), expired = { ...h.context, now: new Date(h.plan.expiresAt) };
    for (const action of [() => h.store.create(h.plan, h.payload, expired), () => h.store.inspect(h.id, expired),
      () => h.store.cancel(h.id, expired), () => h.store.prune(expired)]) {
      assert.throws(action, { code: 'COMPANY_READONLY_V3_INVALID_RECORD' });
      assert.deepEqual(preserved(h.file), before);
    }
  } finally { h.close(); }
});

test('a prune-only failure after one deletion rolls back all payload and audit changes', async context => {
  const h = await setup(context);
  let pruner: SqliteCompanyReadonlyV3Store | undefined;
  try {
    h.store.create(h.plan, h.payload, h.context);
    const next = h.prepare('ffffffff-ffff-4fff-8fff-ffffffffffff'); h.store.create(next.plan, next.payload, h.context); h.store.close();
    pruner = SqliteCompanyReadonlyV3Store.openForPrune(h.file);
    const originalPrepare = DatabaseSync.prototype.prepare; let deletions = 0;
    const mock = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('DELETE FROM company_readonly_v3_payloads') && ++deletions === 2) throw new Error('SYNTHETIC_DELETE_FAILURE');
      return originalPrepare.call(this, sql);
    });
    try {
      assert.throws(() => pruner!.prune({ ...h.context, now: new Date(h.plan.auditExpiresAt) }), { code: 'COMPANY_READONLY_V3_INVALID_RECORD' });
      assert.equal(deletions, 2);
    } finally { mock.mock.restore(); }
    assert.deepEqual(counts(h.file), { plans: 2, payloads: 2, bindings: 1 });
    h.reopen(); assert.equal(h.store.inspect(h.id, h.context).status, 'AWAITING_APPROVAL');
  } finally { pruner?.close(); h.close(); }
});
