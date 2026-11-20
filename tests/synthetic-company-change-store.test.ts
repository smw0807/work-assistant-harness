import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteSyntheticCompanyChangeStore } from '../src/adapters/sqlite-synthetic-company-change-store.js';
import { SqliteCompanyChangeStore } from '../src/adapters/sqlite-company-change-store.js';
import type { SyntheticCompanyChangeJournalEntry, SyntheticCompanyChangeSource } from '../src/domain/synthetic-company-change.js';
import { HarnessError } from '../src/domain/errors.js';
import { createSyntheticCompanyChangePlan, hashSyntheticCompanyChangeValue } from '../src/policy/synthetic-company-change.js';
import { canonicalReadonlyJson } from '../src/policy/readonly-investigation-policy.js';
import { createCompanyChangeDraft, createCompanyChangeFixture } from './company-change-fixture.js';

const directory = () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'synthetic-company-change-store-'))); fs.chmodSync(root, 0o700);
  return { directory: root, file: join(root, 'synthetic-company-change.sqlite'), close: () => fs.rmSync(root, { recursive: true, force: true }) };
};
const fixture = (count = 2) => {
  const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date('2026-11-20T00:00:00.000Z') };
  const id = '11111111-1111-4111-8111-111111111111', draft = { ...createCompanyChangeDraft(), repoId: 'synthetic-company-change' };
  if (count !== 2) draft.changes = Array.from({ length: count }, (_, index) => ({ operation: 'create' as const,
    path: `src/new-${index}.ts`, beforeHash: null, content: `export const value${index} = ${index};\n` }));
  const source: SyntheticCompanyChangeSource = { repositoryId: 'synthetic-company-change', rootHash: '3'.repeat(64),
    baseCommit: draft.baseCommit, baseBranch: draft.baseBranch, indexHash: draft.baseIndexHash, sourceHash: '4'.repeat(64) };
  return { ...createSyntheticCompanyChangePlan(draft, source, context, id), source, context, id };
};
const setup = (count = 2) => {
  const files = directory(), value = fixture(count); let store = new SqliteSyntheticCompanyChangeStore(files.file);
  return { ...files, ...value, get store() { return store; },
    request: () => ({ taskId: value.id, planHash: value.plan.planHash }),
    approval: (expiresInMinutes = 10) => ({ taskId: value.id, planHash: value.plan.planHash, expiresInMinutes }),
    at: (time: string | number) => ({ ...value.context, now: new Date(time) }),
    reopen: () => { store.close(); store = new SqliteSyntheticCompanyChangeStore(files.file); },
    close: () => { store.close(); files.close(); } };
};
const preserved = (file: string) => {
  const metadata = fs.lstatSync(file, { bigint: true });
  return { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid, mode: metadata.mode, links: metadata.nlink,
    bytes: metadata.size, hash: hashSyntheticCompanyChangeValue(fs.readFileSync(file)) };
};
const prepare = (h: ReturnType<typeof setup>) => { h.store.create(h.plan, h.context); h.store.approve(h.approval(), h.context); };
const completeJournal = (h: ReturnType<typeof setup>) => {
  h.store.record(h.id, { kind: 'branch', path: null, state: 'INTENT' }, h.context);
  h.store.record(h.id, { kind: 'branch', path: null, state: 'DONE' }, h.context);
  for (const change of h.plan.changes) {
    h.store.record(h.id, { kind: 'file', path: change.path, state: 'INTENT' }, h.context);
    h.store.record(h.id, { kind: 'file', path: change.path, state: 'DONE' }, h.context);
  }
};

test('synthetic apply ledger persists metadata only in a separate private FULL-synchronous database', () => {
  const h = setup();
  try {
    const snapshot = h.store.create(h.plan, h.context); assert.equal(snapshot.status, 'AWAITING_APPROVAL');
    assert.equal(snapshot.plan.scope, 'synthetic-only'); assert.equal(snapshot.plan.checks, 'not_run');
    assert.equal(snapshot.plan.transmissionAllowed, false); assert.equal(snapshot.approval, null); assert.deepEqual(snapshot.journal, []);
    assert.equal(fs.lstatSync(h.file).mode & 0o7777, 0o600); assert.equal(fs.lstatSync(h.directory).mode & 0o7777, 0o700);
    const database = new DatabaseSync(h.file, { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA application_id').get()!.application_id, 0x53434331);
      assert.equal(database.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
      assert.equal(database.prepare('PRAGMA synchronous').get()!.synchronous, 2);
      assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name),
        ['synthetic_company_change_journal', 'synthetic_company_change_records', 'synthetic_company_change_store']);
      const raw = JSON.stringify(database.prepare('SELECT * FROM synthetic_company_change_records').all());
      assert.equal(raw.includes(h.draft.objective), false);
      for (const change of h.draft.changes) assert.equal(raw.includes(change.content), false);
    } finally { database.close(); }
    h.reopen(); assert.deepEqual(h.store.inspect(h.id, h.context), snapshot);
    snapshot.plan.changes[0]!.path = 'changed.ts'; assert.deepEqual(h.store.inspect(h.id, h.context).plan, h.plan);
    for (const method of ['prune', 'recover', 'run', 'apply', 'transmit']) assert.equal(method in h.store, false);
  } finally { h.close(); }
});

test('exact create and active approval retries are idempotent without extending either expiry', () => {
  const h = setup();
  try {
    const original = h.store.create(h.plan, h.context); assert.deepEqual(h.store.create(h.plan, h.context), original);
    const changed = createSyntheticCompanyChangePlan({ ...h.draft, objective: 'Different synthetic objective.' }, h.source, h.context, h.id);
    assert.throws(() => h.store.create(changed.plan, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_ID_REUSED' });
    const approved = h.store.approve(h.approval(), h.context), later = h.at(h.context.now.getTime() + 60_000);
    assert.deepEqual(h.store.approve(h.approval(), later), approved);
    const before = preserved(h.file);
    assert.throws(() => h.store.approve(h.approval(11), later), { code: 'SYNTHETIC_COMPANY_CHANGE_ALREADY_APPROVED' });
    assert.deepEqual(preserved(h.file), before); assert.equal(approved.approval!.scope, 'synthetic-apply');
    assert.equal(approved.approval!.usedAt, null); h.reopen(); assert.deepEqual(h.store.inspect(h.id, later), approved);
  } finally { h.close(); }
});

test('claim commits consumption once before any journal and only the claiming instance may continue', () => {
  const h = setup();
  try {
    prepare(h); const second = new SqliteSyntheticCompanyChangeStore(h.file);
    try {
      const claimed = h.store.claim(h.request(), h.context);
      assert.equal(claimed.status, 'APPLYING'); assert.equal(claimed.approval!.usedAt, h.context.now.toISOString()); assert.deepEqual(claimed.journal, []);
      assert.deepEqual(second.inspect(h.id, h.context), claimed);
      assert.throws(() => h.store.claim(h.request(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
      assert.throws(() => second.claim(h.request(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
      assert.throws(() => second.record(h.id, { kind: 'branch', path: null, state: 'INTENT' }, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_CLAIM_NOT_OWNED' });
      assert.throws(() => second.finish(h.id, 'FAILED', 'SYNTHETIC_COMPANY_CHANGE_INTERRUPTED', h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_CLAIM_NOT_OWNED' });
      assert.throws(() => h.store.cancel(h.id, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_ALREADY_CLAIMED' });
      assert.equal(h.store.record(h.id, { kind: 'branch', path: null, state: 'INTENT' }, h.context).journal.length, 1);
    } finally { second.close(); }
  } finally { h.close(); }
});

test('journal enforces branch first, exact file order and INTENT before DONE, and requires all entries for APPLIED', () => {
  const h = setup();
  try {
    prepare(h); h.store.claim(h.request(), h.context);
    const rejected = (entry: Omit<SyntheticCompanyChangeJournalEntry, 'sequence' | 'at'>) => {
      const before = preserved(h.file); assert.throws(() => h.store.record(h.id, entry, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_JOURNAL' });
      assert.deepEqual(preserved(h.file), before);
    };
    rejected({ kind: 'file', path: h.plan.changes[0]!.path, state: 'INTENT' });
    rejected({ kind: 'branch', path: null, state: 'DONE' });
    rejected({ kind: 'branch', path: 'refs/heads/other', state: 'INTENT' });
    h.store.record(h.id, { kind: 'branch', path: null, state: 'INTENT' }, h.context);
    rejected({ kind: 'branch', path: null, state: 'INTENT' });
    h.store.record(h.id, { kind: 'branch', path: null, state: 'DONE' }, h.context);
    rejected({ kind: 'file', path: h.plan.changes[1]!.path, state: 'INTENT' });
    rejected({ kind: 'file', path: '../escape', state: 'INTENT' });
    assert.throws(() => h.store.finish(h.id, 'APPLIED', null, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_JOURNAL_INCOMPLETE' });
    for (const change of h.plan.changes) {
      h.store.record(h.id, { kind: 'file', path: change.path, state: 'INTENT' }, h.context);
      h.store.record(h.id, { kind: 'file', path: change.path, state: 'DONE' }, h.context);
    }
    rejected({ kind: 'file', path: h.plan.changes[1]!.path, state: 'INTENT' });
    const applied = h.store.finish(h.id, 'APPLIED', null, h.context);
    assert.equal(applied.status, 'APPLIED'); assert.equal(applied.failureCode, null);
    assert.deepEqual(applied.journal.map(entry => entry.sequence), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(applied.journal.map(entry => entry.state), ['INTENT', 'DONE', 'INTENT', 'DONE', 'INTENT', 'DONE']);
    h.reopen(); assert.deepEqual(h.store.inspect(h.id, h.context), applied);
    assert.throws(() => h.store.claim(h.request(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
  } finally { h.close(); }
});

test('eight declared files complete at eighteen entries without accepting any additional file', () => {
  const h = setup(8);
  try {
    prepare(h); h.store.claim(h.request(), h.context); completeJournal(h);
    assert.equal(h.store.inspect(h.id, h.context).journal.length, 18);
    assert.throws(() => h.store.record(h.id, { kind: 'file', path: 'src/ninth.ts', state: 'INTENT' }, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_JOURNAL' });
    assert.equal(h.store.finish(h.id, 'APPLIED', null, h.context).status, 'APPLIED');
  } finally { h.close(); }
});

test('reopening an incomplete APPLYING journal retains evidence and cannot resume or finish the old claim', () => {
  const h = setup();
  try {
    prepare(h); h.store.claim(h.request(), h.context);
    const pending = h.store.record(h.id, { kind: 'branch', path: null, state: 'INTENT' }, h.context);
    h.reopen(); const late = h.at(Date.parse(h.plan.expiresAt) + 90 * 86_400_000);
    assert.deepEqual(h.store.inspect(h.id, late), pending);
    assert.throws(() => h.store.claim(h.request(), late), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
    assert.throws(() => h.store.record(h.id, { kind: 'branch', path: null, state: 'DONE' }, late), { code: 'SYNTHETIC_COMPANY_CHANGE_CLAIM_NOT_OWNED' });
    assert.throws(() => h.store.finish(h.id, 'FAILED', 'SYNTHETIC_COMPANY_CHANGE_INTERRUPTED', late), { code: 'SYNTHETIC_COMPANY_CHANGE_CLAIM_NOT_OWNED' });
    assert.deepEqual(h.store.create(h.plan, late), pending);
    const reused = createSyntheticCompanyChangePlan(h.draft, h.source, late, h.id);
    assert.throws(() => h.store.create(reused.plan, late), { code: 'SYNTHETIC_COMPANY_CHANGE_ID_REUSED' });
  } finally { h.close(); }
});

test('FAILED preserves consumed authority and the exact partial journal without replay or cancellation', () => {
  const h = setup();
  try {
    prepare(h); h.store.claim(h.request(), h.context);
    h.store.record(h.id, { kind: 'branch', path: null, state: 'INTENT' }, h.context);
    const failed = h.store.finish(h.id, 'FAILED', 'SYNTHETIC_COMPANY_CHANGE_APPLY_FAILED', h.context);
    assert.equal(failed.status, 'FAILED'); assert.equal(failed.journal.length, 1); assert.ok(failed.approval!.usedAt);
    h.reopen(); assert.deepEqual(h.store.inspect(h.id, h.context), failed);
    assert.throws(() => h.store.claim(h.request(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
    assert.throws(() => h.store.approve(h.approval(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
    assert.throws(() => h.store.cancel(h.id, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_ALREADY_CLAIMED' });
  } finally { h.close(); }
});

test('plan and approval expiry stop unclaimed work while consumed claims retain authority for bounded completion', () => {
  for (const approved of [false, true]) {
    const h = setup();
    try {
      h.store.create(h.plan, h.context);
      const prior = approved ? h.store.approve(h.approval(1), h.context) : h.store.inspect(h.id, h.context);
      const expiry = prior.approval?.expiresAt ?? h.plan.expiresAt;
      assert.equal(h.store.inspect(h.id, h.at(Date.parse(expiry) - 1)).status, approved ? 'APPROVED' : 'AWAITING_APPROVAL');
      assert.equal(h.store.inspect(h.id, h.at(expiry)).status, 'EXPIRED');
      assert.throws(() => h.store.claim(h.request(), h.at(expiry)), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
      assert.throws(() => h.store.approve(h.approval(), h.at(expiry)), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
      assert.equal(h.store.cancel(h.id, h.at(expiry)).status, 'EXPIRED');
    } finally { h.close(); }
  }
  const h = setup();
  try {
    prepare(h); h.store.claim(h.request(), h.context); completeJournal(h);
    const late = h.at(Date.parse(h.plan.expiresAt) + 1000);
    assert.equal(h.store.finish(h.id, 'APPLIED', null, late).status, 'APPLIED');
    h.reopen(); assert.equal(h.store.inspect(h.id, late).status, 'APPLIED');
  } finally { h.close(); }
});

test('cancel before claim is terminal and approvals cannot exceed the remaining plan lifetime', () => {
  for (const approved of [false, true]) {
    const h = setup();
    try {
      h.store.create(h.plan, h.context); if (approved) h.store.approve(h.approval(), h.context);
      const cancelled = h.store.cancel(h.id, h.context); assert.equal(cancelled.status, 'CANCELLED');
      assert.deepEqual(h.store.cancel(h.id, h.context), cancelled); assert.equal(cancelled.approval?.usedAt ?? null, null);
      h.reopen(); assert.deepEqual(h.store.inspect(h.id, h.context), cancelled);
      assert.throws(() => h.store.claim(h.request(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
    } finally { h.close(); }
  }
  const h = setup();
  try {
    h.store.create(h.plan, h.context); const before = preserved(h.file), near = h.at(Date.parse(h.plan.expiresAt) - 59_999);
    assert.throws(() => h.store.approve(h.approval(1), near), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_EXCEEDS_PLAN_TTL' });
    assert.deepEqual(preserved(h.file), before);
  } finally { h.close(); }
});

test('wrong owner, reversed time, wrong hash and old review contracts do not consume or change the ledger', () => {
  const h = setup();
  try {
    prepare(h); const before = preserved(h.file), wrong = { ...h.context, ownerId: 'os-user:999999999' };
    for (const action of [() => h.store.inspect(h.id, wrong), () => h.store.approve(h.approval(), wrong),
      () => h.store.claim(h.request(), wrong), () => h.store.cancel(h.id, wrong)]) {
      assert.throws(action, { code: 'SYNTHETIC_COMPANY_CHANGE_OWNER_MISMATCH' }); assert.deepEqual(preserved(h.file), before);
    }
    assert.throws(() => h.store.claim({ ...h.request(), planHash: '0'.repeat(64) }, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_PLAN_MISMATCH' });
    assert.throws(() => h.store.approve({ ...h.approval(), planHash: '0'.repeat(64) }, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_PLAN_MISMATCH' });
    const old = createCompanyChangeFixture(h.context.now);
    assert.throws(() => h.store.create(old.plan as unknown as typeof h.plan, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_PLAN' });
    assert.throws(() => h.store.claim({ ...h.request(), scope: 'review-only' } as unknown as ReturnType<typeof h.request>, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_REQUEST' });
    assert.deepEqual(preserved(h.file), before);
    h.store.inspect(h.id, h.at(h.context.now.getTime() + 1000)); h.reopen(); const later = preserved(h.file);
    assert.throws(() => h.store.claim(h.request(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_TIME_REVERSED' });
    assert.deepEqual(preserved(h.file), later);
  } finally { h.close(); }
});

test('failed claim COMMIT leaves approval unused and grants no in-memory claim', context => {
  const h = setup();
  try {
    prepare(h); const before = preserved(h.file), original = DatabaseSync.prototype.exec;
    const mock = context.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      if (sql === 'COMMIT') throw new Error('SYNTHETIC_COMMIT_FAILURE'); return original.call(this, sql);
    });
    try { assert.throws(() => h.store.claim(h.request(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_RECORD' }); }
    finally { mock.mock.restore(); }
    assert.deepEqual(preserved(h.file), before); assert.equal(h.store.inspect(h.id, h.context).approval!.usedAt, null);
    assert.throws(() => h.store.record(h.id, { kind: 'branch', path: null, state: 'INTENT' }, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_CLAIM_NOT_OWNED' });
  } finally { h.close(); }
});

test('journal update faults roll back the new entry and preserve the already durable consumed claim', context => {
  const h = setup();
  try {
    prepare(h); const claimed = h.store.claim(h.request(), h.context), before = preserved(h.file), original = DatabaseSync.prototype.prepare;
    const mock = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('UPDATE synthetic_company_change_records')) throw new Error('SYNTHETIC_RECORD_FAILURE');
      return original.call(this, sql);
    });
    try { assert.throws(() => h.store.record(h.id, { kind: 'branch', path: null, state: 'INTENT' }, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_RECORD' }); }
    finally { mock.mock.restore(); }
    assert.deepEqual(preserved(h.file), before); assert.deepEqual(h.store.inspect(h.id, h.context), claimed);
    h.reopen(); assert.deepEqual(h.store.inspect(h.id, h.context), claimed);
    assert.throws(() => h.store.claim(h.request(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
  } finally { h.close(); }
});

test('failed terminal persistence leaves APPLYING and a complete journal without claiming rollback or allowing replay', context => {
  const h = setup();
  try {
    prepare(h); h.store.claim(h.request(), h.context); completeJournal(h);
    const before = preserved(h.file), original = DatabaseSync.prototype.prepare;
    const mock = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('UPDATE synthetic_company_change_records')) throw new Error('SYNTHETIC_FINISH_FAILURE');
      return original.call(this, sql);
    });
    try {
      assert.throws(() => h.store.finish(h.id, 'APPLIED', null, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_RECORD' });
      assert.throws(() => h.store.finish(h.id, 'FAILED', 'SYNTHETIC_COMPANY_CHANGE_APPLY_FAILED', h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_RECORD' });
    } finally { mock.mock.restore(); }
    assert.deepEqual(preserved(h.file), before); h.reopen(); const observed = h.store.inspect(h.id, h.context);
    assert.equal(observed.status, 'APPLYING'); assert.equal(observed.journal.length, 6); assert.ok(observed.approval!.usedAt);
    assert.throws(() => h.store.claim(h.request(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
    assert.throws(() => h.store.finish(h.id, 'APPLIED', null, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_CLAIM_NOT_OWNED' });
  } finally { h.close(); }
});

test('SQLite writer contention and nested callbacks cannot consume a second approval or append hidden journal entries', context => {
  const h = setup(), lock = new DatabaseSync(h.file);
  try {
    prepare(h); lock.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => h.store.claim(h.request(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_STORE_BUSY' }); }
    finally { lock.exec('ROLLBACK'); }
    assert.equal(h.store.inspect(h.id, h.context).approval!.usedAt, null);
    const before = preserved(h.file), original = DatabaseSync.prototype.prepare;
    const mock = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('UPDATE synthetic_company_change_records')) h.store.cancel(h.id, h.context);
      return original.call(this, sql);
    });
    try { assert.throws(() => h.store.claim(h.request(), h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_TRANSACTION_IN_PROGRESS' }); }
    finally { mock.mock.restore(); }
    assert.deepEqual(preserved(h.file), before); h.store.claim(h.request(), h.context); completeJournal(h);
    assert.equal(h.store.finish(h.id, 'APPLIED', null, h.context).status, 'APPLIED');
  } finally { lock.close(); h.close(); }
});

test('record, approval, journal ordering/hash, owner, clock and schema tampering fail closed before writes', () => {
  for (const kind of ['record', 'approval', 'journal-hash', 'journal-path', 'journal-delete', 'incomplete-applied', 'owner', 'clock', 'schema'] as const) {
    const h = setup();
    try {
      prepare(h); h.store.claim(h.request(), h.context);
      h.store.record(h.id, { kind: 'branch', path: null, state: 'INTENT' }, h.context); h.store.close();
      const db = new DatabaseSync(h.file);
      try {
        if (kind === 'record') db.prepare('UPDATE synthetic_company_change_records SET record_hash = ?').run('0'.repeat(64));
        if (kind === 'approval') db.prepare('UPDATE synthetic_company_change_records SET approval_json = ?').run('null');
        if (kind === 'journal-hash') db.prepare('UPDATE synthetic_company_change_journal SET entry_hash = ?').run('0'.repeat(64));
        if (kind === 'journal-path') {
          const entry = { sequence: 0, kind: 'file', path: 'src/undeclared.ts', state: 'INTENT', at: h.context.now.toISOString() };
          const raw = canonicalReadonlyJson(entry); db.prepare('UPDATE synthetic_company_change_journal SET entry_json = ?, entry_hash = ?').run(raw, hashSyntheticCompanyChangeValue(raw));
        }
        if (kind === 'journal-delete') db.exec('DELETE FROM synthetic_company_change_journal');
        if (kind === 'incomplete-applied') db.prepare('UPDATE synthetic_company_change_records SET status = ?').run('APPLIED');
        if (kind === 'owner') db.prepare('UPDATE synthetic_company_change_store SET owner_id = ?').run('os-user:999999999');
        if (kind === 'clock') db.prepare('UPDATE synthetic_company_change_store SET last_seen_at = ?').run(h.plan.expiresAt);
        if (kind === 'schema') db.exec('CREATE TABLE unexpected (id TEXT)');
      } finally { db.close(); }
      const before = preserved(h.file);
      assert.throws(() => new SqliteSyntheticCompanyChangeStore(h.file), (error: unknown) => error instanceof HarnessError
        && ['SYNTHETIC_COMPANY_CHANGE_INVALID_RECORD', 'SYNTHETIC_COMPANY_CHANGE_INVALID_STORE', 'SYNTHETIC_COMPANY_CHANGE_INVALID_JOURNAL'].includes(error.code));
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('review ledgers, foreign, empty and malformed databases are never migrated or modified', () => {
  for (const kind of ['review', 'foreign', 'empty', 'malformed'] as const) {
    const h = directory();
    try {
      if (kind === 'review') {
        const old = join(h.directory, 'company-change.sqlite'); new SqliteCompanyChangeStore(old).close(); fs.copyFileSync(old, h.file);
      } else if (kind === 'foreign') {
        const db = new DatabaseSync(h.file); db.exec('CREATE TABLE other_records (id TEXT)'); db.close();
      } else fs.writeFileSync(h.file, kind === 'empty' ? '' : 'SYNTHETIC_NOT_SQLITE');
      fs.chmodSync(h.file, 0o600); const before = preserved(h.file);
      assert.throws(() => new SqliteSyntheticCompanyChangeStore(h.file), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_STORE' });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('unsafe modes, symlinks, hardlinks and wrong filenames are refused before opening writable storage', () => {
  for (const kind of ['parent-mode', 'parent-link', 'file-mode', 'file-link', 'hardlink', 'sidecar', 'wrong-name'] as const) {
    const h = directory(); let path = h.file;
    try {
      if (kind === 'parent-mode') fs.chmodSync(h.directory, 0o755);
      if (kind === 'parent-link') { fs.symlinkSync(h.directory, h.directory + '-link'); path = join(h.directory + '-link', 'synthetic-company-change.sqlite'); }
      if (['file-mode', 'file-link', 'hardlink'].includes(kind)) {
        const target = join(h.directory, 'target'); fs.writeFileSync(target, 'SYNTHETIC_UNTOUCHED', { mode: 0o600 });
        if (kind === 'file-mode') { fs.copyFileSync(target, h.file); fs.chmodSync(h.file, 0o644); }
        if (kind === 'file-link') fs.symlinkSync(target, h.file);
        if (kind === 'hardlink') fs.linkSync(target, h.file);
      }
      if (kind === 'sidecar') fs.symlinkSync(join(h.directory, 'missing'), h.file + '-wal');
      if (kind === 'wrong-name') path = join(h.directory, 'other.sqlite');
      assert.throws(() => new SqliteSyntheticCompanyChangeStore(path), (error: unknown) => error instanceof HarnessError
        && ['UNSAFE_RUNTIME_PATH', 'UNSAFE_RUNTIME_FILE'].includes(error.code));
      if (kind === 'parent-link') fs.unlinkSync(h.directory + '-link');
      if (kind === 'parent-mode') fs.chmodSync(h.directory, 0o700);
    } finally { h.close(); }
  }
});

test('an open ledger rejects database replacement, ancestor replacement and new unsafe sidecars', () => {
  for (const kind of ['database', 'ancestor', 'sidecar'] as const) {
    const outer = directory(), child = join(outer.directory, 'nested'); fs.mkdirSync(child, { mode: 0o700 });
    const file = join(child, 'synthetic-company-change.sqlite'), value = fixture(), store = new SqliteSyntheticCompanyChangeStore(file);
    let moved: string | null = null;
    try {
      store.create(value.plan, value.context);
      if (kind === 'database') { fs.renameSync(file, file + '.old'); fs.copyFileSync(file + '.old', file); }
      if (kind === 'ancestor') {
        moved = outer.directory + '-old'; fs.renameSync(outer.directory, moved); fs.mkdirSync(outer.directory, { mode: 0o700 });
        fs.renameSync(join(moved, 'nested'), child);
      }
      if (kind === 'sidecar') fs.symlinkSync(join(child, 'absent'), file + '-wal');
      assert.throws(() => store.inspect(value.id, value.context), { code: kind === 'ancestor' ? 'UNSAFE_RUNTIME_PATH' : 'UNSAFE_RUNTIME_FILE' });
      if (kind === 'sidecar') fs.unlinkSync(file + '-wal');
    } finally { store.close(); outer.close(); if (moved) fs.rmSync(moved, { recursive: true, force: true }); }
  }
});

test('a copied valid database cannot move its location binding, and closed instances lose their claim authority', () => {
  const h = setup(), destination = directory();
  try {
    prepare(h); h.store.claim(h.request(), h.context); h.store.close(); fs.copyFileSync(h.file, destination.file);
    const before = preserved(destination.file);
    assert.throws(() => new SqliteSyntheticCompanyChangeStore(destination.file), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_STORE' });
    assert.deepEqual(preserved(destination.file), before);
    assert.throws(() => h.store.inspect(h.id, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_STORE_CLOSED' });
    assert.throws(() => h.store.record(h.id, { kind: 'branch', path: null, state: 'INTENT' }, h.context), { code: 'SYNTHETIC_COMPANY_CHANGE_STORE_CLOSED' });
    h.reopen(); assert.equal(h.store.inspect(h.id, h.context).status, 'APPLYING');
  } finally { h.close(); destination.close(); }
});
