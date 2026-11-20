import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants as sqliteConstants, DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteCompanyChangeStore } from '../src/adapters/sqlite-company-change-store.js';
import { SqliteCompanyReadonlyV3Store } from '../src/adapters/sqlite-company-readonly-v3-store.js';
import { HarnessError } from '../src/domain/errors.js';
import { createCompanyChangePlan, getCompanyChangeLimits, hashCompanyChangeValue } from '../src/policy/company-change.js';
import { createCompanyChangeDraft, createCompanyChangeFixture } from './company-change-fixture.js';

const privateDirectory = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-change-store-'))); fs.chmodSync(directory, 0o700);
  return { directory, file: join(directory, 'company-change.sqlite'), close: () => fs.rmSync(directory, { recursive: true, force: true }) };
};
const setup = () => {
  const files = privateDirectory(), fixture = createCompanyChangeFixture(); let store = new SqliteCompanyChangeStore(files.file);
  const at = (time: string | number) => ({ ...fixture.context, now: new Date(time) });
  return { ...files, ...fixture, at, get store() { return store; },
    request: (expiresInMinutes = 10) => ({ taskId: fixture.id, planHash: fixture.plan.planHash, expiresInMinutes }),
    reopen: () => { store.close(); store = new SqliteCompanyChangeStore(files.file); },
    close: () => { store.close(); files.close(); } };
};
const counts = (file: string) => {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return { records: database.prepare('SELECT count(*) AS n FROM company_change_records').get()!.n,
    drafts: database.prepare('SELECT count(*) AS n FROM company_change_drafts').get()!.n,
    markers: database.prepare('SELECT count(*) AS n FROM company_change_markers').get()!.n }; }
  finally { database.close(); }
};
const preserved = (file: string) => {
  const metadata = fs.lstatSync(file, { bigint: true });
  return { dev: metadata.dev, ino: metadata.ino, mode: metadata.mode, uid: metadata.uid, links: metadata.nlink,
    bytes: metadata.size, hash: hashCompanyChangeValue(fs.readFileSync(file)) };
};
const denyDraftReads = (context: TestContext) => {
  const originalPrepare = DatabaseSync.prototype.prepare, guarded = new WeakSet<DatabaseSync>(); let reads = 0;
  const mock = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (!guarded.has(this)) {
      this.setAuthorizer((action, table, column) => {
        if (action === sqliteConstants.SQLITE_READ && table === 'company_change_drafts' && column === 'draft_json') {
          reads += 1; return sqliteConstants.SQLITE_DENY;
        }
        return sqliteConstants.SQLITE_OK;
      });
      guarded.add(this);
    }
    return originalPrepare.call(this, sql);
  });
  return { get reads() { return reads; }, restore: () => mock.mock.restore() };
};

test('company change uses private distinct tables, body-free plans and permanently unconsumable review approvals', () => {
  const h = setup();
  try {
    const snapshot = h.store.create(h.plan, h.draft, h.context);
    assert.equal(snapshot.status, 'AWAITING_APPROVAL'); assert.equal(snapshot.approval, null);
    assert.equal(snapshot.plan.sourceVerification, 'not_run'); assert.equal(snapshot.plan.executionAllowed, false);
    assert.equal(snapshot.plan.transmissionAllowed, false); assert.equal(snapshot.plan.approvalScope, 'review-only');
    assert.equal(JSON.stringify(snapshot.plan).includes(h.draft.objective), false);
    assert.equal(JSON.stringify(snapshot.plan).includes(h.draft.changes[0]!.content), false);
    assert.equal(fs.lstatSync(h.file).mode & 0o7777, 0o600); assert.equal(fs.lstatSync(h.directory).mode & 0o7777, 0o700);
    const database = new DatabaseSync(h.file, { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA application_id').get()!.application_id, 0x43434831);
      assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name),
        ['company_change_drafts', 'company_change_markers', 'company_change_records', 'company_change_store']);
    } finally { database.close(); }
    h.reopen(); assert.deepEqual(h.store.review(h.id, h.context), snapshot);
    snapshot.plan.planHash = '0'.repeat(64); snapshot.draft!.changes[0]!.content = 'modified returned value';
    assert.deepEqual(h.store.inspect(h.id, h.context).draft, h.draft);
    for (const method of ['apply', 'run', 'claim', 'dispatch', 'consume', 'recover', 'execute', 'transmit']) assert.equal(method in h.store, false);
    assert.deepEqual(counts(h.file), { records: 1, drafts: 1, markers: 1 });
  } finally { h.close(); }
});

test('company change retries preserve one task, reject conflicting declarations and never revive cancellation', () => {
  const h = setup();
  try {
    const original = h.store.create(h.plan, h.draft, h.context), second = new SqliteCompanyChangeStore(h.file);
    try { assert.deepEqual(second.create(h.plan, h.draft, h.context), original); } finally { second.close(); }
    const changed = createCompanyChangePlan({ ...h.draft, objective: 'A different supplied request.' }, h.context, h.id);
    assert.throws(() => h.store.create(changed.plan, changed.draft, h.context), { code: 'COMPANY_CHANGE_ID_REUSED' });
    const cancelled = h.store.cancel(h.id, h.context); assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.draft, null);
    h.reopen(); assert.deepEqual(h.store.create(h.plan, h.draft, h.context), cancelled);
    assert.deepEqual(h.store.cancel(h.id, h.context), cancelled);
    assert.throws(() => h.store.approve(h.request(), h.context), { code: 'COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
    assert.deepEqual(counts(h.file), { records: 1, drafts: 0, markers: 1 });
  } finally { h.close(); }
});

test('approval binds exact plan and owner; exact active retries retain the original approval and expiry', () => {
  const h = setup();
  try {
    h.store.create(h.plan, h.draft, h.context);
    assert.throws(() => h.store.approve({ ...h.request(), planHash: '0'.repeat(64) }, h.context), { code: 'COMPANY_CHANGE_PLAN_MISMATCH' });
    const approved = h.store.approve(h.request(), h.context);
    assert.equal(approved.status, 'APPROVED'); assert.equal(approved.approval!.usedAt, null);
    assert.equal(approved.approval!.executionAllowed, false); assert.equal(approved.approval!.scope, 'review-only');
    assert.equal(JSON.stringify(approved.approval).includes(h.draft.changes[0]!.content), false);
    const later = h.at(h.context.now.getTime() + 60_000);
    assert.deepEqual(h.store.approve(h.request(), later), approved);
    const before = preserved(h.file);
    assert.throws(() => h.store.approve(h.request(11), later), { code: 'COMPANY_CHANGE_ALREADY_APPROVED' });
    assert.deepEqual(preserved(h.file), before); h.reopen();
    assert.deepEqual(h.store.inspect(h.id, later), approved);
    const cancelled = h.store.cancel(h.id, later);
    assert.equal(cancelled.approval!.revokedAt, later.now.toISOString()); assert.equal(cancelled.approval!.usedAt, null);
    assert.equal(cancelled.draft, null); assert.equal(cancelled.status, 'CANCELLED');
  } finally { h.close(); }
});

test('approval expiry returns to waiting without refreshing draft TTL or replacing approval history', () => {
  const h = setup();
  try {
    h.store.create(h.plan, h.draft, h.context);
    const approved = h.store.approve(h.request(1), h.context), expiry = h.at(approved.approval!.expiresAt);
    assert.equal(h.store.inspect(h.id, h.at(expiry.now.getTime() - 1)).status, 'APPROVED');
    const waiting = h.store.inspect(h.id, expiry);
    assert.equal(waiting.status, 'AWAITING_APPROVAL'); assert.deepEqual(waiting.draft, h.draft);
    assert.equal(waiting.approval!.id, approved.approval!.id); assert.equal(waiting.approval!.revokedAt, approved.approval!.expiresAt);
    assert.equal(waiting.plan.expiresAt, h.plan.expiresAt); assert.equal(waiting.plan.auditExpiresAt, h.plan.auditExpiresAt);
    const before = preserved(h.file);
    assert.throws(() => h.store.approve(h.request(), expiry), { code: 'COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
    assert.deepEqual(preserved(h.file), before); h.reopen(); assert.deepEqual(h.store.inspect(h.id, expiry), waiting);
    const fresh = createCompanyChangePlan(h.draft, expiry, '22222222-2222-4222-8222-222222222222');
    assert.equal(h.store.create(fresh.plan, fresh.draft, expiry).status, 'AWAITING_APPROVAL');
    assert.equal(h.store.approve({ taskId: fresh.plan.id, planHash: fresh.plan.planHash, expiresInMinutes: 1 }, expiry).status, 'APPROVED');
  } finally { h.close(); }
});

test('approval rejects TTL outside its range or beyond plan expiry instead of silently shortening it', () => {
  const h = setup();
  try {
    h.store.create(h.plan, h.draft, h.context);
    for (const minutes of [0, -1, 61, 1.5, Number.NaN]) {
      assert.throws(() => h.store.approve(h.request(minutes), h.context), { code: 'COMPANY_CHANGE_INVALID_APPROVAL' });
    }
    const near = h.at(Date.parse(h.plan.expiresAt) - 59_999), before = preserved(h.file);
    assert.throws(() => h.store.approve(h.request(1), near), { code: 'COMPANY_CHANGE_APPROVAL_EXCEEDS_PLAN_TTL' });
    assert.deepEqual(preserved(h.file), before);
    const exact = h.at(Date.parse(h.plan.expiresAt) - 60_000);
    assert.equal(h.store.approve(h.request(1), exact).approval!.expiresAt, h.plan.expiresAt);
    const expired = h.store.inspect(h.id, h.at(h.plan.expiresAt));
    assert.equal(expired.status, 'EXPIRED'); assert.equal(expired.draft, null); assert.equal(expired.approval!.revokedAt, h.plan.expiresAt);
  } finally { h.close(); }
});

test('owner, invalid time, reversed time, invalid inputs and closed stores leave persisted data unchanged', () => {
  const h = setup();
  try {
    h.store.create(h.plan, h.draft, h.context); const before = preserved(h.file), owner = { ...h.context, ownerId: 'os-user:999999999' };
    for (const action of [() => h.store.create(h.plan, h.draft, owner), () => h.store.inspect(h.id, owner),
      () => h.store.review(h.id, owner), () => h.store.approve(h.request(), owner), () => h.store.cancel(h.id, owner), () => h.store.prune(owner)]) {
      assert.throws(action, { code: 'COMPANY_CHANGE_OWNER_MISMATCH' }); assert.deepEqual(preserved(h.file), before);
    }
    assert.throws(() => h.store.prune(h.at('invalid')), { code: 'COMPANY_CHANGE_INVALID_TIME' });
    assert.throws(() => h.store.create({ ...h.plan, executionAllowed: true } as unknown as typeof h.plan, h.draft, h.context), { code: 'COMPANY_CHANGE_INVALID_PLAN' });
    assert.throws(() => h.store.create(h.plan, { ...h.draft, changes: [] }, h.context), { code: 'COMPANY_CHANGE_INVALID_DRAFT' });
    const later = h.at(h.context.now.getTime() + 1000); h.store.inspect(h.id, later); h.reopen();
    const observed = preserved(h.file);
    assert.throws(() => h.store.prune(h.context), { code: 'COMPANY_CHANGE_TIME_REVERSED' });
    assert.deepEqual(preserved(h.file), observed); h.store.close();
    assert.throws(() => h.store.inspect(h.id, later), { code: 'COMPANY_CHANGE_STORE_CLOSED' });
  } finally { h.close(); }
});

test('opening and pruning never read expired or live draft columns, even when both bodies are malformed', context => {
  const h = setup(); let opened: SqliteCompanyChangeStore | undefined;
  try {
    h.store.create(h.plan, h.draft, h.context);
    const later = h.at(h.context.now.getTime() + 60_000), fresh = createCompanyChangePlan(h.draft, later, '22222222-2222-4222-8222-222222222222');
    h.store.create(fresh.plan, fresh.draft, later); h.store.close();
    const damaged = new DatabaseSync(h.file);
    try { damaged.prepare('UPDATE company_change_drafts SET draft_json = ?').run('SYNTHETIC_MALFORMED_DRAFT {'); }
    finally { damaged.close(); }
    const guard = denyDraftReads(context);
    try {
      opened = new SqliteCompanyChangeStore(h.file);
      assert.deepEqual(opened.prune(h.at(Date.parse(h.plan.expiresAt) - 1)), { draftsRemoved: 0, recordsRemoved: 0 });
      assert.deepEqual(opened.prune(h.at(h.plan.expiresAt)), { draftsRemoved: 1, recordsRemoved: 0 });
      assert.deepEqual(counts(h.file), { records: 2, drafts: 1, markers: 2 });
      const expired = opened.inspect(h.id, h.at(h.plan.expiresAt)); assert.equal(expired.draft, null); assert.equal(expired.status, 'EXPIRED');
      assert.deepEqual(opened.prune(h.at(h.plan.expiresAt)), { draftsRemoved: 0, recordsRemoved: 0 });
      assert.deepEqual(opened.prune(h.at(Date.parse(h.plan.auditExpiresAt) - 1)), { draftsRemoved: 1, recordsRemoved: 0 });
      assert.deepEqual(opened.prune(h.at(h.plan.auditExpiresAt)), { draftsRemoved: 0, recordsRemoved: 1 });
      assert.deepEqual(opened.prune(h.at(fresh.plan.auditExpiresAt)), { draftsRemoved: 0, recordsRemoved: 1 });
      assert.equal(guard.reads, 0); assert.deepEqual(counts(h.file), { records: 0, drafts: 0, markers: 2 });
    } finally { guard.restore(); }
  } finally { opened?.close(); h.close(); }
});

test('unexpired malformed drafts cannot be reviewed or approved; cancellation deletes without inspecting their bodies', context => {
  const h = setup();
  try {
    h.store.create(h.plan, h.draft, h.context); h.store.close();
    const damaged = new DatabaseSync(h.file);
    try { damaged.prepare('UPDATE company_change_drafts SET draft_json = ?').run('SYNTHETIC_INVALID_DRAFT {'); } finally { damaged.close(); }
    h.reopen(); const before = preserved(h.file);
    for (const action of [() => h.store.inspect(h.id, h.context), () => h.store.review(h.id, h.context), () => h.store.approve(h.request(), h.context)]) {
      assert.throws(action, { code: 'COMPANY_CHANGE_INVALID_RECORD' }); assert.deepEqual(preserved(h.file), before);
    }
    h.store.close(); const guard = denyDraftReads(context);
    try {
      h.reopen(); assert.equal(h.store.cancel(h.id, h.context).status, 'CANCELLED'); assert.equal(guard.reads, 0);
    } finally { guard.restore(); }
  } finally { h.close(); }
});

test('audit pruning keeps opaque replay markers and rejects same task with either old or newly dated plans', () => {
  const h = setup();
  try {
    h.store.create(h.plan, h.draft, h.context); const audit = h.at(h.plan.auditExpiresAt);
    assert.deepEqual(h.store.prune(audit), { draftsRemoved: 1, recordsRemoved: 1 }); h.reopen();
    assert.deepEqual(counts(h.file), { records: 0, drafts: 0, markers: 1 });
    const before = preserved(h.file), freshSameId = createCompanyChangePlan(h.draft, audit, h.id);
    assert.throws(() => h.store.create(h.plan, h.draft, audit), { code: 'COMPANY_CHANGE_ID_REUSED' });
    assert.throws(() => h.store.create(freshSameId.plan, freshSameId.draft, audit), { code: 'COMPANY_CHANGE_ID_REUSED' });
    assert.throws(() => h.store.create(h.plan, h.draft, h.context), { code: 'COMPANY_CHANGE_TIME_REVERSED' });
    assert.deepEqual(preserved(h.file), before);
    const database = new DatabaseSync(h.file, { readOnly: true });
    try {
      assert.deepEqual(database.prepare('SELECT task_hash, plan_hash FROM company_change_markers').all().map(row => ({ ...row })),
        [{ task_hash: hashCompanyChangeValue(h.id), plan_hash: h.plan.planHash }]);
    } finally { database.close(); }
  } finally { h.close(); }
});

test('a prune failure after one deletion rolls back every deletion, audit update and clock watermark', context => {
  const h = setup();
  try {
    h.store.create(h.plan, h.draft, h.context);
    const next = createCompanyChangePlan(h.draft, h.context, '22222222-2222-4222-8222-222222222222'); h.store.create(next.plan, next.draft, h.context);
    const before = preserved(h.file), originalPrepare = DatabaseSync.prototype.prepare; let deletions = 0;
    const mock = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('DELETE FROM company_change_drafts') && ++deletions === 2) throw new Error('SYNTHETIC_DELETE_FAILURE');
      return originalPrepare.call(this, sql);
    });
    try { assert.throws(() => h.store.prune(h.at(h.plan.auditExpiresAt)), { code: 'COMPANY_CHANGE_INVALID_RECORD' }); assert.equal(deletions, 2); }
    finally { mock.mock.restore(); }
    assert.deepEqual(preserved(h.file), before); assert.deepEqual(counts(h.file), { records: 2, drafts: 2, markers: 2 });
    h.reopen(); assert.equal(h.store.inspect(h.id, h.context).status, 'AWAITING_APPROVAL');
  } finally { h.close(); }
});

test('creation and approval failures roll back their markers, records and authority', context => {
  const h = setup(), originalPrepare = DatabaseSync.prototype.prepare;
  try {
    const before = preserved(h.file);
    const insert = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('INSERT INTO company_change_drafts')) throw new Error('SYNTHETIC_INSERT_FAILURE');
      return originalPrepare.call(this, sql);
    });
    try { assert.throws(() => h.store.create(h.plan, h.draft, h.context), { code: 'COMPANY_CHANGE_INVALID_RECORD' }); }
    finally { insert.mock.restore(); }
    assert.deepEqual(preserved(h.file), before); assert.deepEqual(counts(h.file), { records: 0, drafts: 0, markers: 0 });
    h.store.create(h.plan, h.draft, h.context); const awaiting = preserved(h.file);
    const update = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('UPDATE company_change_records')) throw new Error('SYNTHETIC_APPROVAL_FAILURE');
      return originalPrepare.call(this, sql);
    });
    try { assert.throws(() => h.store.approve(h.request(), h.context), { code: 'COMPANY_CHANGE_INVALID_RECORD' }); }
    finally { update.mock.restore(); }
    assert.deepEqual(preserved(h.file), awaiting); assert.equal(h.store.inspect(h.id, h.context).approval, null);
  } finally { h.close(); }
});

test('parallel connections serialize changes and refuse a held writer lock without consuming approval', () => {
  const h = setup(), lock = new DatabaseSync(h.file);
  try {
    h.store.create(h.plan, h.draft, h.context); lock.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => h.store.approve(h.request(), h.context), { code: 'COMPANY_CHANGE_STORE_BUSY' }); }
    finally { lock.exec('ROLLBACK'); }
    const second = new SqliteCompanyChangeStore(h.file);
    try {
      const first = h.store.approve(h.request(), h.context); assert.deepEqual(second.approve(h.request(), h.context), first);
      second.cancel(h.id, h.context); assert.equal(h.store.inspect(h.id, h.context).status, 'CANCELLED');
    } finally { second.close(); }
  } finally { lock.close(); h.close(); }
});

test('nested operations cannot enter the transaction while its approval is being recorded', context => {
  const h = setup();
  try {
    h.store.create(h.plan, h.draft, h.context); const before = preserved(h.file), originalPrepare = DatabaseSync.prototype.prepare;
    const mock = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('UPDATE company_change_records')) h.store.cancel(h.id, h.context);
      return originalPrepare.call(this, sql);
    });
    try { assert.throws(() => h.store.approve(h.request(), h.context), { code: 'COMPANY_CHANGE_TRANSACTION_IN_PROGRESS' }); }
    finally { mock.mock.restore(); }
    assert.deepEqual(preserved(h.file), before); assert.equal(h.store.inspect(h.id, h.context).status, 'AWAITING_APPROVAL');
  } finally { h.close(); }
});

test('metadata corruption, unknown schema and changed store owner are refused before opening a writer', () => {
  for (const kind of ['record', 'owner', 'schema', 'draft-hash', 'draft-expiry', 'missing-draft', 'approval', 'marker', 'clock'] as const) {
    const h = setup();
    try {
      h.store.create(h.plan, h.draft, h.context); if (kind === 'approval') h.store.approve(h.request(), h.context); h.store.close();
      const database = new DatabaseSync(h.file);
      try {
        if (kind === 'record') database.prepare('UPDATE company_change_records SET record_hash = ?').run('0'.repeat(64));
        if (kind === 'owner') database.prepare('UPDATE company_change_store SET owner_id = ?').run('os-user:999999999');
        if (kind === 'schema') database.exec('CREATE TABLE unexpected (id TEXT)');
        if (kind === 'draft-hash') database.prepare('UPDATE company_change_drafts SET draft_hash = ?').run('0'.repeat(64));
        if (kind === 'draft-expiry') database.prepare('UPDATE company_change_drafts SET expires_at = ?').run(h.plan.auditExpiresAt);
        if (kind === 'missing-draft') database.exec('DELETE FROM company_change_drafts');
        if (kind === 'approval') database.exec("UPDATE company_change_records SET approval_json = '{}' ");
        if (kind === 'marker') database.exec('DELETE FROM company_change_markers');
        if (kind === 'clock') database.prepare('UPDATE company_change_store SET last_seen_at = ?').run(h.plan.auditExpiresAt);
      } finally { database.close(); }
      const before = preserved(h.file);
      assert.throws(() => new SqliteCompanyChangeStore(h.file), { code: ['owner', 'schema', 'clock'].includes(kind) ? 'COMPANY_CHANGE_INVALID_STORE' : 'COMPANY_CHANGE_INVALID_RECORD' });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('legacy, arbitrary, empty and malformed databases are never migrated or modified', () => {
  for (const kind of ['v3', 'foreign', 'empty', 'malformed'] as const) {
    const h = privateDirectory();
    try {
      if (kind === 'v3') {
        const old = join(h.directory, 'company-readonly-v3.sqlite'); new SqliteCompanyReadonlyV3Store(old).close(); fs.copyFileSync(old, h.file);
      } else if (kind === 'foreign') {
        const db = new DatabaseSync(h.file); db.exec('CREATE TABLE foreign_records (id TEXT)'); db.close();
      } else fs.writeFileSync(h.file, kind === 'empty' ? '' : 'SYNTHETIC_NOT_SQLITE');
      fs.chmodSync(h.file, 0o600); const before = preserved(h.file);
      assert.throws(() => new SqliteCompanyChangeStore(h.file), { code: 'COMPANY_CHANGE_INVALID_STORE' });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('private parent and regular single-link file requirements reject unsafe paths and sidecars', () => {
  for (const kind of ['parent-mode', 'parent-link', 'file-mode', 'file-link', 'hardlink', 'wal-link', 'wal-mode', 'wrong-name'] as const) {
    const h = privateDirectory(); let path = h.file;
    try {
      if (kind === 'parent-mode') fs.chmodSync(h.directory, 0o755);
      if (kind === 'parent-link') { const link = h.directory + '-link'; fs.symlinkSync(h.directory, link); path = join(link, 'company-change.sqlite'); }
      if (['file-mode', 'file-link', 'hardlink'].includes(kind)) {
        fs.writeFileSync(join(h.directory, 'target'), 'SYNTHETIC_UNTOUCHED', { mode: 0o600 });
        if (kind === 'file-mode') { fs.writeFileSync(h.file, 'SYNTHETIC_UNTOUCHED', { mode: 0o600 }); fs.chmodSync(h.file, 0o644); }
        if (kind === 'file-link') fs.symlinkSync(join(h.directory, 'target'), h.file);
        if (kind === 'hardlink') fs.linkSync(join(h.directory, 'target'), h.file);
      }
      if (kind === 'wal-link') fs.symlinkSync(join(h.directory, 'absent'), h.file + '-wal');
      if (kind === 'wal-mode') fs.writeFileSync(h.file + '-wal', 'SYNTHETIC_SIDECAR', { mode: 0o644 });
      if (kind === 'wrong-name') path = join(h.directory, 'other.sqlite');
      assert.throws(() => new SqliteCompanyChangeStore(path), (error: unknown) => error instanceof HarnessError && ['UNSAFE_RUNTIME_PATH', 'UNSAFE_RUNTIME_FILE'].includes(error.code));
      if (kind === 'parent-link') fs.unlinkSync(h.directory + '-link');
      if (kind === 'parent-mode') fs.chmodSync(h.directory, 0o700);
      if (['file-mode', 'file-link', 'hardlink'].includes(kind)) assert.equal(fs.readFileSync(join(h.directory, 'target'), 'utf8'), 'SYNTHETIC_UNTOUCHED');
    } finally { h.close(); }
  }
});

test('an opened store refuses replaced database identity, changed private parent and late unsafe sidecars', () => {
  for (const kind of ['database', 'parent', 'sidecar'] as const) {
    const h = setup();
    try {
      h.store.create(h.plan, h.draft, h.context);
      if (kind === 'database') { fs.renameSync(h.file, h.file + '.old'); fs.copyFileSync(h.file + '.old', h.file); }
      if (kind === 'parent') fs.chmodSync(h.directory, 0o755);
      if (kind === 'sidecar') fs.symlinkSync(join(h.directory, 'absent'), h.file + '-wal');
      assert.throws(() => h.store.prune(h.context), { code: kind === 'parent' ? 'UNSAFE_RUNTIME_PATH' : 'UNSAFE_RUNTIME_FILE' });
      if (kind === 'parent') fs.chmodSync(h.directory, 0o700);
      if (kind === 'sidecar') fs.unlinkSync(h.file + '-wal');
    } finally { h.close(); }
  }
});

test('copying a valid database to another private location cannot reuse its location-bound ledger', () => {
  const h = setup(), destination = privateDirectory();
  try {
    h.store.create(h.plan, h.draft, h.context); h.store.close(); fs.copyFileSync(h.file, destination.file);
    const before = preserved(destination.file);
    assert.throws(() => new SqliteCompanyChangeStore(destination.file), { code: 'COMPANY_CHANGE_INVALID_STORE' });
    assert.deepEqual(preserved(destination.file), before);
  } finally { h.close(); destination.close(); }
});

test('declared path, operation, secret and size violations fail without any stored plan or replay marker', () => {
  const h = setup(), limits = getCompanyChangeLimits();
  try {
    const before = preserved(h.file);
    for (const change of [
      { ...h.draft.changes[0]!, path: '../escape.ts' }, { ...h.draft.changes[0]!, path: '.git/config' },
      { ...h.draft.changes[0]!, operation: 'delete' }, { ...h.draft.changes[0]!, content: 'x'.repeat(limits.maxContentBytes + 1) },
      { ...h.draft.changes[0]!, content: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----' },
    ]) {
      const draft = { ...createCompanyChangeDraft(), changes: [change] } as typeof h.draft;
      assert.throws(() => h.store.create(h.plan, draft, h.context), { code: 'COMPANY_CHANGE_INVALID_DRAFT' });
      assert.deepEqual(preserved(h.file), before);
    }
    assert.deepEqual(counts(h.file), { records: 0, drafts: 0, markers: 0 });
  } finally { h.close(); }
});
