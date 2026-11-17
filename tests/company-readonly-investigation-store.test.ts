import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { SqliteCompanyInvestigationStore } from '../src/adapters/sqlite-company-investigation-store.js';
import { SqliteCompanyReadonlyV3Store } from '../src/adapters/sqlite-company-readonly-v3-store.js';
import type { CompanyInvestigationReport } from '../src/domain/company-investigation.js';
import type { CompanyReadonlySnapshotV3 } from '../src/domain/company-readonly-v3.js';
import { HarnessError } from '../src/domain/errors.js';
import { createCompanyInvestigation } from '../src/policy/company-investigation.js';
import { createCompanyReadonlyPreparationV3 } from '../src/policy/company-readonly-v3.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { createCompanyReadonlyV3Fixture } from './company-readonly-v3-fixture.js';

const privateFiles = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-investigation-store-'))); fs.chmodSync(directory, 0o700);
  return { directory, file: join(directory, 'company-investigation.sqlite'), remove: () => fs.rmSync(directory, { recursive: true, force: true }) };
};
const setup = async (context: TestContext) => {
  const fixture = await createCompanyReadonlyV3Fixture(context), input = fixture.prepareInput();
  const prepared = createCompanyReadonlyPreparationV3(input.registration, input.policy, input.observation, input.collected, input.budget, input.context, input.id);
  const snapshot: CompanyReadonlySnapshotV3 = { ...prepared, status: 'AWAITING_APPROVAL', updatedAt: input.context.now.toISOString(),
    approvalCreated: false, transmissionAllowed: false, executionAllowed: false, companyPolicyVerified: false };
  const investigation = createCompanyInvestigation(snapshot, input.context, randomUUID(), '1'.repeat(64));
  const files = privateFiles(); let store = new SqliteCompanyInvestigationStore(files.file);
  const request = { investigationId: investigation.plan.id, planHash: investigation.plan.planHash };
  const at = (milliseconds: number) => ({ ...input.context, now: new Date(input.context.now.getTime() + milliseconds) });
  const report = (milliseconds = 0): CompanyInvestigationReport => {
    const evidence = investigation.payload.preparation.collected.evidence[0]!;
    const result = { classification: 'question' as const, summary: 'Synthetic local report.',
      facts: [{ text: 'A selected synthetic excerpt is available.', references: [{ evidenceId: evidence.evidenceId, startLine: evidence.startLine, endLine: evidence.endLine }] }],
      hypotheses: [], answerDraft: 'Only the selected synthetic excerpt was used.', questions: [], suggestions: [], limitations: ['Fixed response only.'] };
    return { version: 'company-investigation-report-v1', investigationId: investigation.plan.id, planHash: investigation.plan.planHash,
      preparationId: prepared.plan.id, createdAt: at(milliseconds).now.toISOString(), mode: 'mock', result,
      responseHash: hashReadonlyValue(canonicalReadonlyJson(result)), sourceUnchanged: true, semanticAccuracyVerified: false,
      realModel: 'not_run', nativeExecution: 'not_run', credentialAccess: 'not_run', externalTransmission: 'not_run', executionAllowed: false };
  };
  return { ...fixture, ...files, ...investigation, snapshot, request, at, report, id: investigation.plan.id,
    approve: (milliseconds = 0, minutes = 10) => store.approve({ ...request, expiresInMinutes: minutes }, at(milliseconds)),
    get store() { return store; }, reopen: () => { store.close(); store = new SqliteCompanyInvestigationStore(files.file); },
    close: () => { store.close(); files.remove(); } };
};
const preserved = (file: string) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return { mode: stat.mode, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs,
    hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
};

test('company investigation persists a distinct mock-only approval, consumed attempt and validated report across reopen', async context => {
  const h = await setup(context);
  try {
    const created = h.store.create(h.plan, h.payload, h.context);
    assert.equal(created.status, 'AWAITING_APPROVAL'); assert.equal(created.approval, null); assert.equal(created.attempt, null);
    assert.equal(fs.statSync(h.file).mode & 0o7777, 0o600);
    assert.equal(created.plan.expiresAt, h.snapshot.plan.expiresAt); assert.equal(created.plan.auditExpiresAt, h.snapshot.plan.auditExpiresAt);
    h.reopen(); assert.deepEqual(h.store.inspect(h.id, h.context), created);
    const approval = h.approve(1);
    assert.equal(approval.status, 'APPROVED'); assert.equal(approval.approval!.mode, 'mock');
    assert.equal(approval.approval!.transmissionAllowed, false); assert.equal(approval.approval!.executionAllowed, false);
    const running = h.store.claim(h.request, h.at(2)); assert.equal(running.status, 'RUNNING');
    assert.equal(running.approval!.usedAt, running.attempt!.startedAt);
    const body = h.store.dispatch(h.id, running.attempt!.id, h.at(3)); assert.deepEqual(body, h.payload);
    const done = h.store.finish(h.id, running.attempt!.id, h.report(4), null, h.at(4));
    assert.equal(done.status, 'REPORTED'); assert.deepEqual(done.report, h.report(4));
    done.report!.result.summary = 'Changed returned copy';
    h.reopen(); assert.deepEqual(h.store.inspect(h.id, h.at(5)).report, h.report(4));
    assert.throws(() => h.store.claim(h.request, h.at(6)), { code: 'COMPANY_INVESTIGATION_APPROVAL_REQUIRED' });
    assert.throws(() => h.approve(6), { code: 'COMPANY_INVESTIGATION_APPROVAL_UNAVAILABLE' });
    assert.equal(h.store.inspect(h.id, h.at(6)).attempt!.id, running.attempt!.id);
  } finally { h.close(); }
});

test('approval and dispatch guards refuse missing, wrong, repeated and foreign requests without granting a call', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context);
    assert.throws(() => h.store.claim(h.request, h.context), { code: 'COMPANY_INVESTIGATION_APPROVAL_REQUIRED' });
    for (const expiresInMinutes of [0, 61, 1.5, NaN]) {
      assert.throws(() => h.store.approve({ ...h.request, expiresInMinutes }, h.context), { code: 'COMPANY_INVESTIGATION_INVALID_APPROVAL' });
    }
    assert.throws(() => h.store.approve({ ...h.request, planHash: '0'.repeat(64), expiresInMinutes: 10 }, h.context), { code: 'COMPANY_INVESTIGATION_PLAN_MISMATCH' });
    assert.throws(() => h.store.inspect(h.id, { ...h.context, ownerId: 'os-user:9999999' }), { code: 'COMPANY_INVESTIGATION_OWNER_MISMATCH' });
    assert.equal(h.store.inspect(h.id, h.context).approval, null);
    h.approve();
    assert.throws(() => h.store.claim({ ...h.request, planHash: '0'.repeat(64) }, h.context), { code: 'COMPANY_INVESTIGATION_PLAN_MISMATCH' });
    const running = h.store.claim(h.request, h.context);
    const other = new SqliteCompanyInvestigationStore(h.file);
    try { assert.throws(() => other.claim(h.request, h.context), { code: 'COMPANY_INVESTIGATION_APPROVAL_REQUIRED' }); } finally { other.close(); }
    assert.throws(() => h.store.dispatch(h.id, randomUUID(), h.context), { code: 'COMPANY_INVESTIGATION_NOT_RUNNABLE' });
    h.store.dispatch(h.id, running.attempt!.id, h.context);
    assert.throws(() => h.store.dispatch(h.id, running.attempt!.id, h.context), { code: 'COMPANY_INVESTIGATION_ALREADY_DISPATCHED' });
  } finally { h.close(); }
});

test('same preparation idempotence preserves cancelled and consumed states even when a new investigation ID is supplied', async context => {
  const h = await setup(context);
  try {
    const created = h.store.create(h.plan, h.payload, h.context);
    assert.deepEqual(h.store.create(h.plan, h.payload, h.context), created);
    h.approve(); const running = h.store.claim(h.request, h.context);
    h.store.dispatch(h.id, running.attempt!.id, h.context);
    h.store.cancel(h.id, h.at(1));
    const retry = createCompanyInvestigation(h.snapshot, h.at(2), randomUUID(), '1'.repeat(64));
    assert.equal(retry.plan.preparationKey, h.plan.preparationKey);
    const reused = h.store.create(retry.plan, retry.payload, h.at(2));
    assert.equal(reused.plan.id, h.id); assert.equal(reused.status, 'CANCELLED'); assert.equal(reused.payload, null);
    assert.equal(reused.approval!.usedAt, running.approval!.usedAt);
    const sameIdChanged = createCompanyInvestigation(h.snapshot, h.at(2), h.id, '1'.repeat(64));
    assert.throws(() => h.store.create(sameIdChanged.plan, sameIdChanged.payload, h.at(2)), { code: 'COMPANY_INVESTIGATION_ID_REUSED' });
  } finally { h.close(); }
});

test('cancellation wins over a late report and recovery never restores the consumed approval', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context); h.approve();
    const claimed = h.store.claim(h.request, h.context); h.store.dispatch(h.id, claimed.attempt!.id, h.context);
    const cancelled = h.store.cancel(h.id, h.at(1));
    assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.payload, null); assert.equal(cancelled.report, null);
    assert.equal(cancelled.attempt!.endedAt, null);
    assert.equal(h.store.finish(h.id, claimed.attempt!.id, h.report(2), null, h.at(2)).status, 'CANCELLED');
    h.reopen(); const recovered = h.store.recover(h.id, h.at(3));
    assert.equal(recovered.status, 'BLOCKED'); assert.equal(recovered.attempt!.failureCode, 'COMPANY_INVESTIGATION_RECOVERY_UNCERTAIN');
    assert.ok(recovered.approval!.usedAt); assert.equal(recovered.payload, null);
    assert.throws(() => h.store.claim(h.request, h.at(4)), { code: 'COMPANY_INVESTIGATION_APPROVAL_REQUIRED' });
    assert.deepEqual(h.store.recover(h.id, h.at(4)), recovered);
  } finally { h.close(); }
});

test('restart recovery blocks both an undispatched and a dispatched attempt without inventing process termination', async context => {
  for (const dispatched of [false, true]) {
    const h = await setup(context);
    try {
      h.store.create(h.plan, h.payload, h.context); h.approve(); const running = h.store.claim(h.request, h.context);
      if (dispatched) h.store.dispatch(h.id, running.attempt!.id, h.context);
      h.reopen(); const recovered = h.store.recover(h.id, h.at(1));
      assert.equal(recovered.status, 'BLOCKED'); assert.equal(recovered.report, null); assert.equal(recovered.attempt!.endedAt, null);
      assert.equal(recovered.attempt!.dispatchedAt !== null, dispatched);
      assert.throws(() => h.store.dispatch(h.id, running.attempt!.id, h.at(2)), { code: 'COMPANY_INVESTIGATION_NOT_RUNNABLE' });
    } finally { h.close(); }
  }
});

test('approval TTL is capped by the original payload deadline and expiry removes local bodies before rejecting work', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context);
    const approved = h.approve(3_500_000, 60);
    assert.equal(approved.approval!.expiresAt, h.plan.expiresAt);
    assert.equal(h.store.inspect(h.id, h.at(3_599_999)).status, 'APPROVED');
    const expired = h.store.inspect(h.id, h.at(3_600_000));
    assert.equal(expired.status, 'EXPIRED'); assert.equal(expired.payload, null); assert.equal(expired.updatedAt, h.plan.expiresAt);
    assert.throws(() => h.store.claim(h.request, h.at(3_600_000)), { code: 'COMPANY_INVESTIGATION_APPROVAL_REQUIRED' });
    assert.throws(() => h.store.create(h.plan, h.payload, h.at(3_600_000)), { code: 'COMPANY_INVESTIGATION_EXPIRED' });
    const pruned = h.store.prune(h.at(86_400_000)); assert.deepEqual(pruned, { payloads: 0, reports: 0, records: 1 });
    assert.throws(() => h.store.inspect(h.id, h.at(86_400_000)), { code: 'COMPANY_INVESTIGATION_NOT_FOUND' });
    assert.throws(() => h.store.create(h.plan, h.payload, h.at(86_400_000)), { code: 'COMPANY_INVESTIGATION_EXPIRED' });
  } finally { h.close(); }
});

test('an earlier approval expiry stops a running attempt while successful report retention still follows the original payload TTL', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context); h.approve(0, 1); const running = h.store.claim(h.request, h.context);
    h.store.dispatch(h.id, running.attempt!.id, h.context);
    assert.equal(h.store.inspect(h.id, h.at(60_000)).status, 'EXPIRED');
    assert.equal(h.store.finish(h.id, running.attempt!.id, h.report(60_000), null, h.at(60_000)).report, null);
  } finally { h.close(); }
  const completed = await setup(context);
  try {
    completed.store.create(completed.plan, completed.payload, completed.context); completed.approve(0, 1);
    const running = completed.store.claim(completed.request, completed.context);
    completed.store.dispatch(completed.id, running.attempt!.id, completed.context);
    completed.store.finish(completed.id, running.attempt!.id, completed.report(1), null, completed.at(1));
    assert.equal(completed.store.inspect(completed.id, completed.at(60_000)).status, 'REPORTED');
    assert.deepEqual(completed.store.prune(completed.at(3_600_000)), { payloads: 1, reports: 1, records: 0 });
    assert.equal(completed.store.inspect(completed.id, completed.at(3_600_000)).report, null);
  } finally { completed.close(); }
});

test('uncertain cleanup after expiry remains blocked with no body and no reusable approval', async context => {
  for (const action of ['recover', 'finish'] as const) {
    const h = await setup(context);
    try {
      h.store.create(h.plan, h.payload, h.context); h.approve(0, 1);
      const running = h.store.claim(h.request, h.context); h.store.dispatch(h.id, running.attempt!.id, h.context);
      assert.equal(h.store.inspect(h.id, h.at(60_000)).status, 'EXPIRED');
      const blocked = action === 'recover' ? h.store.recover(h.id, h.at(60_001))
        : h.store.finish(h.id, running.attempt!.id, null, 'COMPANY_INVESTIGATION_RECOVERY_UNCERTAIN', h.at(60_001));
      assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.payload, null); assert.equal(blocked.report, null);
      assert.equal(blocked.attempt!.endedAt, null); assert.ok(blocked.approval!.usedAt);
      h.reopen(); assert.equal(h.store.inspect(h.id, h.at(60_002)).status, 'BLOCKED');
      assert.throws(() => h.store.claim(h.request, h.at(60_002)), { code: 'COMPANY_INVESTIGATION_APPROVAL_REQUIRED' });
    } finally { h.close(); }
  }
});

test('failed and uncertain results retain fixed metadata only and cannot accept an invalid report', async context => {
  for (const uncertain of [false, true]) {
    const h = await setup(context);
    try {
      h.store.create(h.plan, h.payload, h.context); h.approve(); const running = h.store.claim(h.request, h.context);
      h.store.dispatch(h.id, running.attempt!.id, h.context);
      assert.throws(() => h.store.finish(h.id, running.attempt!.id, { ...h.report(), responseHash: '0'.repeat(64) }, null, h.context));
      assert.equal(h.store.inspect(h.id, h.context).status, 'RUNNING');
      const failure = uncertain ? 'COMPANY_INVESTIGATION_RECOVERY_UNCERTAIN' : 'COMPANY_INVESTIGATION_INVALID_RESPONSE';
      const done = h.store.finish(h.id, running.attempt!.id, null, failure, h.at(1));
      assert.equal(done.status, uncertain ? 'BLOCKED' : 'FAILED'); assert.equal(done.payload, null); assert.equal(done.report, null);
      assert.equal(done.attempt!.endedAt, uncertain ? null : h.at(1).now.toISOString());
      h.reopen(); assert.deepEqual(h.store.inspect(h.id, h.at(2)), done);
    } finally { h.close(); }
  }
});

test('stored inspection and pruning do not reopen source files and reject reversed time or closed handles', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context); fs.rmSync(h.root, { recursive: true }); h.reopen();
    assert.equal(h.store.inspect(h.id, h.context).status, 'AWAITING_APPROVAL');
    h.store.cancel(h.id, h.at(1));
    assert.throws(() => h.store.inspect(h.id, h.context), { code: 'COMPANY_INVESTIGATION_TIME_REVERSED' });
    assert.throws(() => h.store.prune(h.context), { code: 'COMPANY_INVESTIGATION_TIME_REVERSED' });
    h.store.close(); assert.throws(() => h.store.inspect(h.id, h.at(2)), { code: 'COMPANY_INVESTIGATION_STORE_CLOSED' });
  } finally { h.close(); }
});

test('foreign, legacy and copied stores are refused before a writable connection modifies their files', async context => {
  const h = await setup(context);
  try {
    h.store.create(h.plan, h.payload, h.context); h.store.close();
    const other = privateFiles();
    try {
      fs.copyFileSync(h.file, other.file); const before = preserved(other.file);
      assert.throws(() => new SqliteCompanyInvestigationStore(other.file), { code: 'COMPANY_INVESTIGATION_INVALID_STORE' });
      assert.deepEqual(preserved(other.file), before);
    } finally { other.remove(); }
  } finally { h.close(); }
  for (const kind of ['legacy', 'foreign', 'empty', 'malformed'] as const) {
    const files = privateFiles();
    try {
      if (kind === 'legacy') {
        const path = join(files.directory, 'company-readonly-v3.sqlite'), legacy = new SqliteCompanyReadonlyV3Store(path); legacy.close(); fs.copyFileSync(path, files.file);
      } else if (kind === 'foreign') {
        const database = new DatabaseSync(files.file); database.exec('CREATE TABLE foreign_data (id TEXT)'); database.close(); fs.chmodSync(files.file, 0o600);
      } else fs.writeFileSync(files.file, kind === 'empty' ? '' : 'synthetic-invalid-sqlite', { mode: 0o600 });
      const before = preserved(files.file);
      assert.throws(() => new SqliteCompanyInvestigationStore(files.file), { code: 'COMPANY_INVESTIGATION_INVALID_STORE' });
      assert.deepEqual(preserved(files.file), before);
    } finally { files.remove(); }
  }
});

test('private permissions and leaf, parent and sidecar links fail without repair', () => {
  const files = privateFiles(); let store: SqliteCompanyInvestigationStore | null = null;
  try {
    store = new SqliteCompanyInvestigationStore(files.file); store.close();
    fs.chmodSync(files.file, 0o644); assert.throws(() => new SqliteCompanyInvestigationStore(files.file), { code: 'UNSAFE_RUNTIME_FILE' });
    assert.equal(fs.statSync(files.file).mode & 0o7777, 0o644); fs.chmodSync(files.file, 0o600);
    fs.chmodSync(files.directory, 0o755); assert.throws(() => new SqliteCompanyInvestigationStore(files.file), { code: 'UNSAFE_RUNTIME_PATH' }); fs.chmodSync(files.directory, 0o700);
    const linked = join(files.directory, 'linked'); fs.linkSync(files.file, linked);
    assert.throws(() => new SqliteCompanyInvestigationStore(files.file), { code: 'UNSAFE_RUNTIME_FILE' }); fs.unlinkSync(linked);
    fs.mkdirSync(linked, { mode: 0o700 }); const leaf = join(linked, 'company-investigation.sqlite'); fs.symlinkSync(files.file, leaf);
    assert.throws(() => new SqliteCompanyInvestigationStore(leaf), { code: 'UNSAFE_RUNTIME_FILE' });
    const parent = join(files.directory, 'parent'); fs.symlinkSync(linked, parent);
    assert.throws(() => new SqliteCompanyInvestigationStore(join(parent, 'company-investigation.sqlite')), { code: 'UNSAFE_RUNTIME_PATH' });
    for (const suffix of ['-journal', '-wal', '-shm']) {
      fs.symlinkSync(files.file, files.file + suffix);
      assert.throws(() => new SqliteCompanyInvestigationStore(files.file), { code: 'UNSAFE_RUNTIME_FILE' }); fs.unlinkSync(files.file + suffix);
    }
  } finally { store?.close(); files.remove(); }
});

test('row, body, approval, schema and owner tampering are rejected before writes', async context => {
  for (const kind of ['record', 'payload', 'approval', 'duplicate-json', 'extra-table', 'owner'] as const) {
    const h = await setup(context);
    try {
      h.store.create(h.plan, h.payload, h.context); h.approve(); h.store.close(); const database = new DatabaseSync(h.file);
      try {
        if (kind === 'record') database.prepare('UPDATE company_investigation_records SET record_hash = ?').run('0'.repeat(64));
        if (kind === 'payload') database.prepare('UPDATE company_investigation_payloads SET payload_json = ?').run('{}');
        if (kind === 'approval') database.prepare('UPDATE company_investigation_records SET approval_json = ?').run('null');
        if (kind === 'duplicate-json') {
          const raw = String(database.prepare('SELECT plan_json FROM company_investigation_records').get()!.plan_json);
          database.prepare('UPDATE company_investigation_records SET plan_json = ?').run(raw.replace('"version":', '"version":"duplicate","version":'));
        }
        if (kind === 'extra-table') database.exec('CREATE TABLE live_transmission (id TEXT)');
        if (kind === 'owner') database.prepare('UPDATE company_investigation_store SET owner_id = ?').run('os-user:9999999');
      } finally { database.close(); }
      const before = preserved(h.file);
      assert.throws(() => new SqliteCompanyInvestigationStore(h.file), { code: ['extra-table', 'owner'].includes(kind)
        ? 'COMPANY_INVESTIGATION_INVALID_STORE' : 'COMPANY_INVESTIGATION_INVALID_RECORD' });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); }
  }
});

test('store insertion rolls back atomically and raw SQLite errors do not escape', async context => {
  const h = await setup(context), prepare = DatabaseSync.prototype.prepare;
  const mocked = context.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('INSERT INTO company_investigation_payloads')) throw new Error(`SYNTHETIC_PRIVATE_SQL_FAILURE ${h.directory}`);
    return prepare.call(this, sql);
  });
  try {
    assert.throws(() => h.store.create(h.plan, h.payload, h.context), error => {
      assert.ok(error instanceof HarnessError); assert.equal(error.code, 'COMPANY_INVESTIGATION_INVALID_RECORD'); assert.equal(error.message, error.code); return true;
    });
    mocked.mock.restore(); assert.throws(() => h.store.inspect(h.id, h.context), { code: 'COMPANY_INVESTIGATION_NOT_FOUND' });
    assert.equal(h.store.create(h.plan, h.payload, h.context).status, 'AWAITING_APPROVAL');
  } finally { mocked.mock.restore(); h.close(); }
});
