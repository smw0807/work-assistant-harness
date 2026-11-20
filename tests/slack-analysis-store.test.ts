import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, constants as sqliteConstants } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteSlackAnalysisStore, type SlackAnalysisBeginInput, type SlackAnalysisFinishInput } from '../src/adapters/sqlite-slack-analysis.js';
import type { ReadonlyReport } from '../src/domain/readonly-investigation.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const base = new Date('2026-11-20T00:00:00.000Z');
const at = (seconds: number): Date => new Date(base.getTime() + seconds * 1000);
const input = (index = 0, now = base): SlackAnalysisBeginInput => ({ workspaceId: 'W_SYNTHETIC', channelId: 'C_ALLOWED',
  messageTs: `1700000000.${String(index + 1).padStart(6, '0')}`, revision: '1700000000.000001',
  sourceHash: 'a'.repeat(64), policyHash: 'b'.repeat(64), scopeHash: 'c'.repeat(64), expiresAt: new Date(now.getTime() + 3_600_000).toISOString() });
const report = (): ReadonlyReport => ({ classification: 'question', summary: 'Synthetic validated summary',
  facts: [{ text: 'A synthetic thread supplied evidence.', references: [{ evidenceId: 'slack-1700000000.000001', startLine: 1, endLine: 1 }] }],
  hypotheses: [], answerDraft: 'Synthetic local analysis only.', questions: [], suggestions: [], limitations: ['No repository or product execution.'] });
const setup = () => {
  const directory = fs.mkdtempSync('/private/tmp/harness-slack-analysis-store-'); fs.chmodSync(directory, 0o700);
  const file = join(directory, 'slack-analysis.sqlite'); let store = new SqliteSlackAnalysisStore(file);
  return { directory, file, get store() { return store; },
    reopen: () => { store.close(); store = new SqliteSlackAnalysisStore(file); },
    close: () => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
};
const started = (store: SqliteSlackAnalysisStore, value = input(), now = base) => {
  const result = store.begin(value, now); assert.equal(result.kind, 'started'); assert.ok(result.record); return result.record;
};
const storedDatabase = (store: SqliteSlackAnalysisStore) => (store as unknown as { database: DatabaseSync }).database;
const denyReportReads = (context: TestContext) => {
  const prepare = DatabaseSync.prototype.prepare, guarded = new WeakSet<DatabaseSync>(); let reads = 0;
  const mock = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (!guarded.has(this)) {
      this.setAuthorizer((action, table, column) => {
        if (action === sqliteConstants.SQLITE_READ && table === 'slack_analysis_runs' && column === 'report_json') { reads++; return sqliteConstants.SQLITE_DENY; }
        return sqliteConstants.SQLITE_OK;
      }); guarded.add(this);
    }
    return prepare.call(this, sql);
  });
  return { get reads() { return reads; }, restore: () => mock.mock.restore() };
};

test('the analysis ledger has its own private schema and stores no original Slack input or old task state', () => {
  const h = setup();
  try {
    const unrelated = join(h.directory, 'tasks.sqlite'); fs.writeFileSync(unrelated, 'SYNTHETIC_UNRELATED', { mode: 0o600 });
    const record = started(h.store);
    assert.equal(record.status, 'RUNNING'); assert.equal(record.report, null); assert.equal(record.finishedAt, null);
    assert.match(record.runId, /^[a-f0-9-]{36}$/u); assert.equal(fs.statSync(h.file).mode & 0o7777, 0o600);
    const db = storedDatabase(h.store);
    assert.equal(db.prepare('PRAGMA synchronous').get()!.synchronous, 2);
    assert.equal(db.prepare('PRAGMA secure_delete').get()!.secure_delete, 1);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(value => value.name),
      ['slack_analysis_runs', 'slack_analysis_store']);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'SYNTHETIC_UNRELATED');
    assert.throws(() => h.store.begin({ ...input(1), rawText: 'ORIGINAL_SLACK_BODY_CANARY' } as SlackAnalysisBeginInput, base), { code: 'SLACK_ANALYSIS_INVALID_INPUT' });
    assert.equal(fs.readFileSync(h.file).includes(Buffer.from('ORIGINAL_SLACK_BODY_CANARY')), false);
    h.reopen(); assert.deepEqual(h.store.find(record.runId, base), record);
  } finally { h.close(); }
});

test('a message revision cannot be replayed by changing source, policy, receiver scope, expiry or timestamp spelling', () => {
  const h = setup();
  try {
    const value = input(), first = started(h.store, value);
    for (const changed of [value, { ...value, sourceHash: 'd'.repeat(64) }, { ...value, policyHash: 'e'.repeat(64) },
      { ...value, scopeHash: 'f'.repeat(64) }, { ...value, expiresAt: at(7200).toISOString() },
      { ...value, messageTs: '01700000000.0000010000', revision: '01700000000.0000010000' }]) {
      const duplicate = h.store.begin(changed, base); assert.equal(duplicate.kind, 'duplicate'); assert.deepEqual(duplicate.record, first);
    }
    const nextRevision = started(h.store, { ...value, revision: '1700000001.000001' });
    assert.notEqual(nextRevision.runId, first.runId); assert.equal(h.store.list(base).length, 2);
  } finally { h.close(); }
});

test('the UTC daily budget counts every accepted call and cannot be reset by failures, invalidation, scopes or restart', () => {
  const h = setup();
  try {
    for (let index = 0; index < 20; index++) {
      const record = started(h.store, input(index));
      if (index % 2 === 0) h.store.finish(record.runId, { status: 'FAILED', failureCode: 'SLACK_ANALYSIS_MODEL_FAILED' }, base);
      else h.store.invalidate(record.runId, base);
    }
    h.reopen(); assert.deepEqual(h.store.begin(input(20), base), { kind: 'daily_limit', record: null });
    assert.equal(h.store.begin({ ...input(), scopeHash: 'f'.repeat(64) }, base).kind, 'duplicate');
    const midnight = at(86_400); assert.equal(h.store.begin(input(20, midnight), midnight).kind, 'started');
    assert.equal(h.store.list(midnight).length, 21);
  } finally { h.close(); }
});

test('simultaneous SQLite handles serialize claims and a failed commit consumes neither identity nor daily budget', context => {
  const h = setup(), other = new SqliteSlackAnalysisStore(h.file);
  try {
    const database = storedDatabase(h.store); database.exec('BEGIN IMMEDIATE');
    try { assert.throws(() => other.begin(input(), base), { code: 'SLACK_ANALYSIS_BUSY' }); } finally { database.exec('ROLLBACK'); }
    const exec = database.exec;
    const fault = context.mock.method(database, 'exec', function (this: DatabaseSync, sql: string) {
      if (sql === 'COMMIT') throw new Error('Synthetic commit fault'); return exec.call(this, sql);
    });
    assert.throws(() => h.store.begin(input(), base), { code: 'SLACK_ANALYSIS_INVALID_STORAGE' }); fault.mock.restore();
    const record = started(other); assert.equal(h.store.begin(input(), base).kind, 'duplicate');
    assert.equal(h.store.find(record.runId, base)?.status, 'RUNNING');
  } finally { other.close(); h.close(); }
});

test('validated report snapshots are bounded, immutable and expire at the source deadline without TTL extension', () => {
  const h = setup();
  try {
    const value = input(), record = started(h.store, value), content = report();
    const finished = h.store.finish(record.runId, { status: 'REPORTED', report: content, responseHash: 'd'.repeat(64) }, at(10));
    assert.equal(finished.status, 'REPORTED'); assert.deepEqual(finished.report, content);
    assert.equal(finished.reportHash, hashReadonlyValue(canonicalReadonlyJson(content))); assert.equal(finished.expiresAt, value.expiresAt);
    content.summary = 'caller changed'; finished.report!.summary = 'returned changed';
    assert.equal(h.store.find(record.runId, at(11))!.report!.summary, 'Synthetic validated summary');
    h.reopen(); assert.equal(h.store.find(record.runId, at(3599))!.report!.summary, 'Synthetic validated summary');
    assert.equal(h.store.find(record.runId, at(3600))!.report, null);
    assert.equal(storedDatabase(h.store).prepare('SELECT report_json FROM slack_analysis_runs').get()!.report_json, null);
    const duplicate = h.store.begin({ ...value, expiresAt: at(7200).toISOString() }, at(3600));
    assert.equal(duplicate.kind, 'duplicate'); assert.equal(duplicate.record!.expiresAt, value.expiresAt);
    assert.throws(() => h.store.finish(record.runId, { status: 'REPORTED', report: report(), responseHash: 'e'.repeat(64) }, at(3601)), { code: 'SLACK_ANALYSIS_ALREADY_FINISHED' });
  } finally { h.close(); }
});

test('a late successful response is blocked and never stores a report past the source expiry', () => {
  const h = setup();
  try {
    const record = started(h.store, { ...input(), expiresAt: at(1).toISOString() });
    const result = h.store.finish(record.runId, { status: 'REPORTED', report: report(), responseHash: 'd'.repeat(64) }, at(1));
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.failureCode, 'SLACK_ANALYSIS_EXPIRED'); assert.equal(result.report, null);
    assert.equal(result.reportHash, null); assert.equal(result.responseHash, null);
  } finally { h.close(); }
});

test('invalidation removes reports without reading them and keeps a permanent nonreplayable marker', context => {
  const h = setup();
  try {
    const record = started(h.store);
    h.store.finish(record.runId, { status: 'REPORTED', report: report(), responseHash: 'd'.repeat(64) }, at(1));
    const guard = denyReportReads(context);
    try {
      const result = h.store.invalidate(record.runId, at(2)); assert.equal(result.status, 'INVALIDATED'); assert.equal(result.report, null);
      assert.equal(h.store.find(record.runId, at(2))!.report, null); assert.equal(h.store.begin(input(), at(2)).kind, 'duplicate');
      assert.throws(() => h.store.finish(record.runId, { status: 'FAILED', failureCode: 'SLACK_ANALYSIS_MODEL_FAILED' }, at(2)), { code: 'SLACK_ANALYSIS_ALREADY_FINISHED' });
      assert.equal(guard.reads, 0);
    } finally { guard.restore(); }
  } finally { h.close(); }
});

test('constructor and expired malformed-report prune never authorize a report read, parse or hash and preserve dedup', context => {
  const h = setup();
  try {
    const record = started(h.store);
    h.store.finish(record.runId, { status: 'REPORTED', report: report(), responseHash: 'd'.repeat(64) }, at(1));
    storedDatabase(h.store).prepare('UPDATE slack_analysis_runs SET report_json = ?').run('MALFORMED_EXPIRED_BODY_DO_NOT_READ');
    h.store.close(); const guard = denyReportReads(context);
    try {
      h.reopen(); assert.equal(h.store.prune(at(3600)), 1); assert.equal(h.store.prune(at(3600)), 0);
      assert.equal(h.store.find(record.runId, at(3600))!.report, null);
      assert.equal(h.store.begin(input(0, at(3600)), at(3600)).kind, 'duplicate'); assert.equal(guard.reads, 0);
    } finally { guard.restore(); }
  } finally { h.close(); }
});

test('live malformed reports fail closed while prune preserves their unexpired bytes', () => {
  const h = setup();
  try {
    const record = started(h.store); h.store.finish(record.runId, { status: 'REPORTED', report: report(), responseHash: 'd'.repeat(64) }, at(1));
    storedDatabase(h.store).prepare('UPDATE slack_analysis_runs SET report_json = ?').run('MALFORMED_LIVE');
    h.reopen(); assert.throws(() => h.store.find(record.runId, at(2)), { code: 'SLACK_ANALYSIS_INVALID_STORAGE' });
    assert.equal(h.store.prune(at(2)), 0);
    assert.equal(storedDatabase(h.store).prepare('SELECT report_json FROM slack_analysis_runs').get()!.report_json, 'MALFORMED_LIVE');
  } finally { h.close(); }
});

test('restart recovery changes only RUNNING records and never allows automatic retries', () => {
  const h = setup();
  try {
    const pending = started(h.store), failed = started(h.store, input(1)), completed = started(h.store, input(2));
    h.store.finish(failed.runId, { status: 'FAILED', failureCode: 'SLACK_ANALYSIS_INVALID_RESPONSE' }, at(1));
    h.store.finish(completed.runId, { status: 'REPORTED', report: report(), responseHash: 'd'.repeat(64) }, at(1));
    h.reopen(); assert.equal(h.store.recover(at(2)), 1); assert.equal(h.store.recover(at(2)), 0);
    assert.equal(h.store.find(pending.runId, at(2))!.status, 'INTERRUPTED');
    assert.equal(h.store.find(failed.runId, at(2))!.status, 'FAILED'); assert.equal(h.store.find(completed.runId, at(2))!.status, 'REPORTED');
    assert.equal(h.store.begin(input(), at(2)).kind, 'duplicate');
  } finally { h.close(); }
});

test('list returns only the newest 100 metadata records while older dedup and UTC budget markers survive', () => {
  const h = setup();
  try {
    let first = '', last = '';
    for (let day = 0; day < 6; day++) for (let index = 0; index < 20; index++) {
      const now = at(day * 86_400), record = started(h.store, input(day * 20 + index, now), now);
      first ||= record.runId; last = record.runId;
    }
    const current = at(5 * 86_400), records = h.store.list(current);
    assert.equal(records.length, 100); assert.equal(records[0]!.runId, last); assert.ok(records.every(record => record.runId !== first));
    assert.equal(h.store.find(first, current)!.runId, first); assert.equal(h.store.begin(input(0, current), current).kind, 'duplicate');
  } finally { h.close(); }
});

test('invalid reports, unknown failure codes, accessors and proxies cannot invoke caller code or mutate a running record', () => {
  const h = setup();
  try {
    const record = started(h.store); let invoked = 0;
    const getter = { ...report() }; Object.defineProperty(getter, 'summary', { enumerable: true, get: () => { invoked++; return 'bad'; } });
    const proxy = new Proxy(report(), { get: () => { invoked++; return ''; }, ownKeys: () => { invoked++; return []; } });
    for (const body of [getter, proxy, { ...report(), rawText: 'extra' }, { ...report(), summary: 'x'.repeat(5000) },
      { ...report(), facts: [{ text: 'Missing reference', references: [] }] }, { ...report(), questions: Array(32).fill('x'.repeat(1000)) }]) {
      assert.throws(() => h.store.finish(record.runId, { status: 'REPORTED', report: body, responseHash: 'd'.repeat(64) }, at(1)));
    }
    assert.equal(invoked, 0);
    assert.throws(() => h.store.finish(record.runId, { status: 'FAILED', failureCode: 'RAW_MODEL_ERROR' } as unknown as SlackAnalysisFinishInput, at(1)));
    assert.equal(h.store.find(record.runId, base)!.status, 'RUNNING');
  } finally { h.close(); }
});

test('source expiry, global monotonic time and metadata hashes fail without altering existing rows', () => {
  const h = setup();
  try {
    for (const expiresAt of [base.toISOString(), at(-1).toISOString(), at(86_401).toISOString(), 'invalid']) {
      assert.throws(() => h.store.begin({ ...input(), expiresAt }, base));
    }
    const record = started(h.store); h.store.find(record.runId, at(10));
    assert.throws(() => h.store.begin(input(1), at(9)), { code: 'SLACK_ANALYSIS_TIME_REVERSED' });
    assert.equal(h.store.list(at(10)).length, 1);
    storedDatabase(h.store).prepare('UPDATE slack_analysis_runs SET metadata_hash = ?').run('0'.repeat(64));
    assert.throws(() => h.store.list(at(10)), { code: 'SLACK_ANALYSIS_INVALID_STORAGE' });
    assert.throws(() => h.reopen(), { code: 'SLACK_ANALYSIS_INVALID_STORAGE' });
  } finally { h.close(); }
});

test('foreign schema, copied location and owner tampering are rejected before writable access', () => {
  for (const kind of ['foreign', 'copy', 'owner'] as const) {
    const h = setup(), target = fs.mkdtempSync('/private/tmp/harness-slack-analysis-foreign-'), file = join(target, 'slack-analysis.sqlite');
    fs.chmodSync(target, 0o700);
    try {
      if (kind === 'foreign') { const db = new DatabaseSync(file); db.exec('CREATE TABLE foreign_table (value TEXT)'); db.close(); fs.chmodSync(file, 0o600); }
      else {
        if (kind === 'owner') storedDatabase(h.store).prepare('UPDATE slack_analysis_store SET owner_id = ?').run('os-user:999999999');
        h.store.close(); fs.copyFileSync(h.file, file);
      }
      const before = fs.readFileSync(file), inode = fs.statSync(file).ino;
      assert.throws(() => new SqliteSlackAnalysisStore(file), { code: 'SLACK_ANALYSIS_INVALID_STORAGE' });
      assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.statSync(file).ino, inode);
    } finally { h.close(); fs.rmSync(target, { recursive: true, force: true }); }
  }
});

test('private path, mode, links, sidecars and open-file identity are never repaired or followed', () => {
  for (const kind of ['parent-mode', 'file-mode', 'symlink', 'hardlink', 'sidecar', 'replacement'] as const) {
    const h = setup();
    try {
      if (kind === 'parent-mode') fs.chmodSync(h.directory, 0o755);
      if (kind === 'file-mode') fs.chmodSync(h.file, 0o644);
      if (kind === 'symlink' || kind === 'hardlink' || kind === 'replacement') {
        fs.renameSync(h.file, h.file + '.original');
        if (kind === 'symlink') fs.symlinkSync(h.file + '.original', h.file);
        else if (kind === 'hardlink') fs.linkSync(h.file + '.original', h.file);
        else fs.copyFileSync(h.file + '.original', h.file);
      }
      if (kind === 'sidecar') fs.symlinkSync(join(h.directory, 'missing'), h.file + '-journal');
      assert.throws(() => h.store.begin(input(), base));
      if (kind !== 'replacement') assert.throws(() => new SqliteSlackAnalysisStore(h.file));
      if (kind === 'parent-mode') assert.equal(fs.statSync(h.directory).mode & 0o777, 0o755);
      if (kind === 'file-mode') assert.equal(fs.statSync(h.file).mode & 0o777, 0o644);
    } finally { fs.chmodSync(h.directory, 0o700); h.close(); }
  }
});

test('closed ledgers reject future operations and a missing run never creates a placeholder record', () => {
  const h = setup();
  try {
    const missing = '11111111-1111-4111-8111-111111111111'; assert.equal(h.store.find(missing, base), null);
    assert.throws(() => h.store.invalidate(missing, base), { code: 'SLACK_ANALYSIS_NOT_FOUND' }); assert.deepEqual(h.store.list(base), []);
    h.store.close(); h.store.close(); assert.throws(() => h.store.begin(input(), base), { code: 'SLACK_ANALYSIS_STORE_CLOSED' });
  } finally { h.close(); }
});
