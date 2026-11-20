import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync, type DatabaseSyncOptions, type SQLOutputValue } from 'node:sqlite';
import type { CompanyChangeApproval, CompanyChangeApprovalRequest, CompanyChangeDraft, CompanyChangePlan,
  CompanyChangePruneResult, CompanyChangeSnapshot, CompanyChangeStatus } from '../domain/company-change.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { CompanyChangeStore } from '../ports/company-change.js';
import { assertCompanyChangeApproval, assertCompanyChangeApprovalRequest, assertCompanyChangeContext,
  assertCompanyChangeDraftForPlan, assertCompanyChangePlan, copyCompanyChangeData,
  getCompanyChangeLimits, hashCompanyChangeValue } from '../policy/company-change.js';
import { canonicalReadonlyJson, isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

const applicationId = 0x43434831;
const limits = getCompanyChangeLimits();
const metadataTable = `CREATE TABLE company_change_store (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), location_hash TEXT NOT NULL, owner_id TEXT NOT NULL,
  last_seen_at TEXT, store_hash TEXT NOT NULL
) STRICT`;
const recordsTable = `CREATE TABLE company_change_records (
  task_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('AWAITING_APPROVAL','APPROVED','CANCELLED','EXPIRED')),
  updated_at TEXT NOT NULL, plan_json TEXT NOT NULL CHECK(length(CAST(plan_json AS BLOB)) <= ${limits.maxPlanJsonBytes}),
  approval_json TEXT NOT NULL CHECK(length(CAST(approval_json AS BLOB)) <= 4096),
  approval_minutes INTEGER, record_hash TEXT NOT NULL
) STRICT`;
const draftsTable = `CREATE TABLE company_change_drafts (
  task_id TEXT PRIMARY KEY REFERENCES company_change_records(task_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, draft_hash TEXT NOT NULL,
  draft_json TEXT NOT NULL CHECK(length(CAST(draft_json AS BLOB)) <= ${limits.maxDraftJsonBytes})
) STRICT`;
// Opaque replay markers contain no paths, draft text or approval snapshot and survive audit pruning.
const markersTable = `CREATE TABLE company_change_markers (
  task_hash TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, marker_hash TEXT NOT NULL
) STRICT`;
const databaseOptions: DatabaseSyncOptions = { enableForeignKeyConstraints: true, allowExtension: false,
  enableDoubleQuotedStringLiterals: false, defensive: true, timeout: 100,
  limits: { length: limits.maxDraftJsonBytes + limits.maxPlanJsonBytes + 65_536, sqlLength: 65_536, attach: 0 } };
const fail = (suffix = 'INVALID_RECORD'): never => { throw new HarnessError(`COMPANY_CHANGE_${suffix}`); };
const safeError = (error: unknown, suffix = 'INVALID_RECORD'): HarnessError => {
  if (error instanceof HarnessError && (/^COMPANY_CHANGE_[A-Z_]{1,60}$/u.test(error.code)
    || ['UNSAFE_RUNTIME_PATH', 'UNSAFE_RUNTIME_FILE'].includes(error.code))) return error;
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'errcode')?.value : undefined;
  return new HarnessError(`COMPANY_CHANGE_${typeof code === 'number' && [5, 6].includes(code & 0xff) ? 'STORE_BUSY' : suffix}`);
};
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const decode = <T>(raw: unknown, maximum: number): T => {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maximum) return fail();
  try { const value: unknown = JSON.parse(raw); if (canonicalReadonlyJson(value) !== raw) return fail(); return value as T; }
  catch { return fail(); }
};
const sameIdentity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
const normalizedSql = (value: string): string => value.replace(/\s+/gu, ' ').trim();
interface RecordState {
  plan: CompanyChangePlan; status: CompanyChangeStatus; updatedAt: string;
  approval: CompanyChangeApproval | null; approvalMinutes: number | null;
}
const recordHash = (record: RecordState): string => hashCompanyChangeValue(canonicalReadonlyJson(record));
const markerHash = (taskHash: string, planHash: string): string => hashCompanyChangeValue(canonicalReadonlyJson([taskHash, planHash]));
const liveDraft = (status: CompanyChangeStatus): boolean => status === 'AWAITING_APPROVAL' || status === 'APPROVED';

/** Review-only approval cannot be consumed and never authorizes source access or execution. */
export class SqliteCompanyChangeStore implements CompanyChangeStore {
  private readonly database: DatabaseSync;
  private readonly parents: { path: string; metadata: Stats }[] = [];
  private readonly sidecarIdentities = new Map<string, Stats>();
  private fileIdentity: Stats | null = null;
  private closed = false;
  private transactionOpen = false;

  constructor(private readonly filePath: string) {
    let database: DatabaseSync | undefined;
    try {
      if (typeof filePath !== 'string' || !isAbsolute(filePath) || resolve(filePath) !== filePath
        || basename(filePath) !== 'company-change.sqlite') throw new HarnessError('UNSAFE_RUNTIME_PATH');
      // The restricted worker can read this private directory only. Its CLI parent checks ancestor identities.
      const directory = dirname(filePath), directoryMetadata = lstatSync(directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new HarnessError('UNSAFE_RUNTIME_PATH');
      this.parents.push({ path: directory, metadata: directoryMetadata });
      this.protectFiles(false);
      const existing = runtimePathMetadata(filePath);
      if (existing) {
        this.fileIdentity = existing;
        // Reject foreign schemas with a read-only connection before opening a writer.
        const readonly = new DatabaseSync(filePath, { ...databaseOptions, readOnly: true });
        try { this.assertSchema(readonly); this.validateRecords(readonly); } finally { readonly.close(); }
        this.protectFiles();
      } else {
        if (['-journal', '-wal', '-shm'].some(suffix => runtimePathMetadata(filePath + suffix))) throw new HarnessError('UNSAFE_RUNTIME_FILE');
        closeSync(openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
        this.fileIdentity = lstatSync(filePath);
      }
      database = new DatabaseSync(filePath, databaseOptions); this.protectFiles();
      if (existing) { this.assertSchema(database); this.validateRecords(database); }
      else {
        database.exec('BEGIN IMMEDIATE');
        try {
          database.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1; ${metadataTable}; ${recordsTable}; ${draftsTable}; ${markersTable};`);
          const location = hashCompanyChangeValue(filePath), owner = `os-user:${process.getuid!()}`;
          database.prepare('INSERT INTO company_change_store VALUES (1, ?, ?, NULL, ?)')
            .run(location, owner, hashCompanyChangeValue(canonicalReadonlyJson([location, owner, null])));
          this.protectFiles(); database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
        this.assertSchema(database);
      }
      database.exec('PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF;');
      this.protectFiles(); this.database = database;
    } catch (error) {
      try { database?.close(); } catch { /* Preserve the first fixed failure. */ }
      throw safeError(error, 'INVALID_STORE');
    }
  }

  create(value: CompanyChangePlan, input: CompanyChangeDraft, context: ReadonlyContext): CompanyChangeSnapshot {
    try {
      const now = assertCompanyChangeContext(context);
      assertCompanyChangePlan(value); assertCompanyChangeDraftForPlan(value, input);
      const plan = copyCompanyChangeData(value), draft = copyCompanyChangeData(input);
      if (plan.ownerId !== context.ownerId) fail('OWNER_MISMATCH');
      if (now < plan.createdAt) fail('INVALID_TIME');
      const body = canonicalReadonlyJson(draft), planJson = canonicalReadonlyJson(plan);
      if (Buffer.byteLength(body) > limits.maxDraftJsonBytes || Buffer.byteLength(planJson) > limits.maxPlanJsonBytes) fail();
      const result = this.transaction(now, () => {
        const existing = this.readRecord(plan.id);
        if (existing && canonicalReadonlyJson(existing.plan) !== planJson) fail('ID_REUSED');
        if (!existing) {
          if (this.database.prepare('SELECT task_hash FROM company_change_markers WHERE task_hash = ?').get(hashCompanyChangeValue(plan.id))) fail('ID_REUSED');
          if (now >= plan.expiresAt) fail('EXPIRED');
        }
        this.pruneRecords(now);
        if (existing) { const retained = this.readRecord(plan.id); return retained ? this.snapshot(retained) : null; }
        const record: RecordState = { plan, status: 'AWAITING_APPROVAL', updatedAt: now, approval: null, approvalMinutes: null };
        const taskHash = hashCompanyChangeValue(plan.id);
        this.database.prepare('INSERT INTO company_change_markers VALUES (?, ?, ?)').run(taskHash, plan.planHash, markerHash(taskHash, plan.planHash));
        this.database.prepare('INSERT INTO company_change_records VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(plan.id, record.status, now, planJson, 'null', null, recordHash(record));
        this.database.prepare('INSERT INTO company_change_drafts VALUES (?, ?, ?, ?)').run(plan.id, plan.expiresAt, plan.draftHash, body);
        return this.snapshot(record);
      });
      return result ?? fail('NOT_FOUND');
    } catch (error) { throw safeError(error); }
  }

  inspect(id: string, context: ReadonlyContext): CompanyChangeSnapshot {
    return this.operation(id, context, record => this.snapshot(record));
  }

  review(id: string, context: ReadonlyContext): CompanyChangeSnapshot {
    return this.inspect(id, context);
  }

  approve(request: CompanyChangeApprovalRequest, context: ReadonlyContext): CompanyChangeSnapshot {
    try {
      assertCompanyChangeApprovalRequest(request);
      return this.operation(request.taskId, context, (record, now) => {
        if (request.planHash !== record.plan.planHash) fail('PLAN_MISMATCH');
        if (record.status === 'APPROVED') {
          if (record.approvalMinutes !== request.expiresInMinutes) fail('ALREADY_APPROVED');
          return this.snapshot(record);
        }
        // Keep the original approval as evidence. A fresh review requires a new task, not a refreshed TTL.
        if (record.status !== 'AWAITING_APPROVAL' || record.approval) fail('APPROVAL_UNAVAILABLE');
        const approvalExpiresAt = new Date(Date.parse(now) + request.expiresInMinutes * 60_000).toISOString();
        if (approvalExpiresAt > record.plan.expiresAt) fail('APPROVAL_EXCEEDS_PLAN_TTL');
        this.readDraft(record);
        record.approval = { id: randomUUID(), taskId: record.plan.id, ownerId: context.ownerId, planHash: record.plan.planHash,
          createdAt: now, expiresAt: approvalExpiresAt,
          revokedAt: null, usedAt: null, scope: 'review-only', executionAllowed: false };
        assertCompanyChangeApproval(record.plan, record.approval);
        record.approvalMinutes = request.expiresInMinutes;
        record.status = 'APPROVED'; record.updatedAt = now; this.writeRecord(record); return this.snapshot(record);
      });
    } catch (error) { throw safeError(error); }
  }

  cancel(id: string, context: ReadonlyContext): CompanyChangeSnapshot {
    return this.operation(id, context, (record, now) => {
      if (liveDraft(record.status)) {
        record.status = 'CANCELLED'; record.updatedAt = now;
        if (record.approval) record.approval.revokedAt ??= now;
        this.removeDraft(id); this.writeRecord(record);
      }
      return this.snapshot(record);
    });
  }

  prune(context: ReadonlyContext): CompanyChangePruneResult {
    try { const now = assertCompanyChangeContext(context); return this.transaction(now, () => this.pruneRecords(now)); }
    catch (error) { throw safeError(error); }
  }

  close(): void {
    if (this.closed) return;
    try { this.database.close(); this.closed = true; }
    catch (error) { throw safeError(error, 'INVALID_STORE'); }
  }

  private operation(id: string, context: ReadonlyContext, action: (record: RecordState, now: string) => CompanyChangeSnapshot): CompanyChangeSnapshot {
    try {
      if (!isReadonlyId(id)) return fail('INVALID_ID');
      const now = assertCompanyChangeContext(context);
      const result = this.transaction(now, () => {
        const previous = this.readRecord(id); if (!previous) return fail('NOT_FOUND');
        this.pruneRecords(now);
        const record = this.readRecord(id); return record ? action(record, now) : null;
      });
      return result ?? fail('NOT_FOUND');
    } catch (error) { throw safeError(error); }
  }

  private assertSchema(database: DatabaseSync): void {
    if (database.prepare('PRAGMA application_id').get()?.application_id !== applicationId
      || database.prepare('PRAGMA user_version').get()?.user_version !== 1
      || database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') fail('INVALID_STORE');
    const tables: Record<string, string> = { company_change_store: metadataTable, company_change_records: recordsTable,
      company_change_drafts: draftsTable, company_change_markers: markersTable };
    const indexes = new Map([['sqlite_autoindex_company_change_records_1', 'company_change_records'],
      ['sqlite_autoindex_company_change_drafts_1', 'company_change_drafts'], ['sqlite_autoindex_company_change_markers_1', 'company_change_markers']]);
    const rows = database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
    if (rows.length !== 7) fail('INVALID_STORE');
    for (const row of rows) {
      if (row.type === 'table' && typeof row.name === 'string' && Object.hasOwn(tables, row.name) && row.tbl_name === row.name
        && typeof row.sql === 'string' && normalizedSql(row.sql) === normalizedSql(tables[row.name]!)) continue;
      if (row.type === 'index' && typeof row.name === 'string' && indexes.get(row.name) === row.tbl_name && row.sql === null) continue;
      fail('INVALID_STORE');
    }
    const rowsBinding = database.prepare('SELECT singleton, location_hash, owner_id, last_seen_at, store_hash FROM company_change_store LIMIT 2').all();
    const binding = rowsBinding[0], location = hashCompanyChangeValue(this.filePath), owner = `os-user:${process.getuid!()}`;
    if (rowsBinding.length !== 1 || !binding || binding.singleton !== 1 || binding.location_hash !== location || binding.owner_id !== owner
      || binding.last_seen_at !== null && !timestamp(binding.last_seen_at)
      || binding.store_hash !== hashCompanyChangeValue(canonicalReadonlyJson([location, owner, binding.last_seen_at]))) fail('INVALID_STORE');
    if (database.prepare('PRAGMA foreign_key_check').get()) fail('INVALID_STORE');
  }

  private readRecord(id: string, database = this.database): RecordState | null {
    const row = database.prepare(`SELECT task_id, status, updated_at, approval_minutes, record_hash,
      length(CAST(plan_json AS BLOB)) AS plan_bytes, length(CAST(approval_json AS BLOB)) AS approval_bytes
      FROM company_change_records WHERE task_id = ?`).get(id);
    if (!row) return null;
    if (!Number.isSafeInteger(row.plan_bytes) || Number(row.plan_bytes) < 2 || Number(row.plan_bytes) > limits.maxPlanJsonBytes
      || !Number.isSafeInteger(row.approval_bytes) || Number(row.approval_bytes) < 2 || Number(row.approval_bytes) > 4096) return fail();
    const body = database.prepare('SELECT plan_json, approval_json FROM company_change_records WHERE task_id = ?').get(id)!;
    const plan = decode<CompanyChangePlan>(body.plan_json, limits.maxPlanJsonBytes), approval = decode<CompanyChangeApproval | null>(body.approval_json, 4096);
    try { assertCompanyChangePlan(plan); if (approval) assertCompanyChangeApproval(plan, approval); } catch { return fail(); }
    if (row.task_id !== id || plan.id !== id || plan.ownerId !== `os-user:${process.getuid!()}`
      || !['AWAITING_APPROVAL', 'APPROVED', 'CANCELLED', 'EXPIRED'].includes(String(row.status))
      || !timestamp(row.updated_at) || row.updated_at < plan.createdAt || !digest(row.record_hash)) return fail();
    const record: RecordState = { plan, status: row.status as CompanyChangeStatus, updatedAt: row.updated_at,
      approval, approvalMinutes: row.approval_minutes as number | null };
    if (record.status === 'EXPIRED' ? record.updatedAt !== plan.expiresAt : record.updatedAt >= plan.expiresAt) return fail();
    if (approval) {
      if (!Number.isSafeInteger(record.approvalMinutes) || record.approvalMinutes! < limits.minApprovalMinutes || record.approvalMinutes! > limits.maxApprovalMinutes
        || approval.expiresAt !== new Date(Date.parse(approval.createdAt) + record.approvalMinutes! * 60_000).toISOString()
        || record.updatedAt < approval.createdAt) return fail();
      if (record.status === 'APPROVED' ? approval.revokedAt !== null || record.updatedAt !== approval.createdAt
        : approval.revokedAt === null || record.updatedAt < approval.revokedAt) return fail();
      if (record.status === 'AWAITING_APPROVAL' && (approval.revokedAt !== approval.expiresAt || record.updatedAt !== approval.expiresAt)) return fail();
    } else if (record.approvalMinutes !== null || record.status === 'APPROVED') return fail();
    if (recordHash(record) !== row.record_hash) return fail();
    const marker = database.prepare('SELECT plan_hash FROM company_change_markers WHERE task_hash = ?').get(hashCompanyChangeValue(id));
    if (marker?.plan_hash !== plan.planHash) return fail();
    return record;
  }

  private readDraft(record: RecordState): CompanyChangeDraft | null {
    if (!liveDraft(record.status)) return null;
    const size = this.database.prepare('SELECT length(CAST(draft_json AS BLOB)) AS bytes FROM company_change_drafts WHERE task_id = ?').get(record.plan.id)?.bytes;
    if (!Number.isSafeInteger(size) || Number(size) < 2 || Number(size) > limits.maxDraftJsonBytes) return fail();
    const raw = this.database.prepare('SELECT draft_json FROM company_change_drafts WHERE task_id = ?').get(record.plan.id)?.draft_json;
    if (typeof raw !== 'string' || hashCompanyChangeValue(raw) !== record.plan.draftHash) return fail();
    const draft = decode<CompanyChangeDraft>(raw, limits.maxDraftJsonBytes);
    try { assertCompanyChangeDraftForPlan(record.plan, draft); } catch { return fail(); }
    return draft;
  }

  private validateRecords(database: DatabaseSync): void {
    let lastId: string | null = null;
    const watermark = database.prepare('SELECT last_seen_at FROM company_change_store WHERE singleton = 1').get()!.last_seen_at;
    for (;;) {
      const rows: Record<string, SQLOutputValue>[] = database.prepare(`SELECT task_id FROM company_change_records
        WHERE (? IS NULL OR task_id > ?) ORDER BY task_id LIMIT 100`).all(lastId, lastId);
      if (!rows.length) break;
      for (const row of rows) {
        if (!isReadonlyId(row.task_id)) return fail();
        const record = this.readRecord(row.task_id, database); if (!record) return fail();
        if (!timestamp(watermark) || record.updatedAt > watermark) return fail();
        // Never select, measure, hash or decode draft_json during open, pruning or transaction preflight.
        const draft = database.prepare('SELECT expires_at, draft_hash FROM company_change_drafts WHERE task_id = ?').get(row.task_id);
        if (liveDraft(record.status) ? !draft || draft.expires_at !== record.plan.expiresAt || draft.draft_hash !== record.plan.draftHash : Boolean(draft)) return fail();
        lastId = row.task_id;
      }
    }
    let lastHash: string | null = null;
    for (;;) {
      const markers: Record<string, SQLOutputValue>[] = database.prepare(`SELECT task_hash, plan_hash, marker_hash FROM company_change_markers
        WHERE (? IS NULL OR task_hash > ?) ORDER BY task_hash LIMIT 100`).all(lastHash, lastHash);
      if (!markers.length) break;
      for (const marker of markers) {
        if (!digest(marker.task_hash) || !digest(marker.plan_hash) || marker.marker_hash !== markerHash(marker.task_hash, marker.plan_hash)) return fail();
        lastHash = marker.task_hash;
      }
    }
  }

  private snapshot(record: RecordState): CompanyChangeSnapshot {
    return { plan: copyCompanyChangeData(record.plan), status: record.status, updatedAt: record.updatedAt,
      draft: this.readDraft(record), approval: copyCompanyChangeData(record.approval) };
  }

  private writeRecord(record: RecordState): void {
    if (this.database.prepare(`UPDATE company_change_records SET status = ?, updated_at = ?, approval_json = ?, approval_minutes = ?, record_hash = ?
      WHERE task_id = ?`).run(record.status, record.updatedAt, canonicalReadonlyJson(record.approval), record.approvalMinutes,
      recordHash(record), record.plan.id).changes !== 1) fail();
  }

  private removeDraft(id: string): number {
    return Number(this.database.prepare('DELETE FROM company_change_drafts WHERE task_id = ?').run(id).changes);
  }

  private pruneRecords(now: string): CompanyChangePruneResult {
    let draftsRemoved = 0, recordsRemoved = 0, lastId: string | null = null;
    for (;;) {
      const rows: Record<string, SQLOutputValue>[] = this.database.prepare(`SELECT task_id FROM company_change_records
        WHERE (? IS NULL OR task_id > ?) ORDER BY task_id LIMIT 100`).all(lastId, lastId);
      if (!rows.length) return { draftsRemoved, recordsRemoved };
      for (const row of rows) {
        if (!isReadonlyId(row.task_id)) return fail(); lastId = row.task_id;
        const record = this.readRecord(lastId); if (!record) return fail();
        if (now < record.updatedAt) fail('TIME_REVERSED');
        if (now >= record.plan.auditExpiresAt) {
          draftsRemoved += this.removeDraft(lastId);
          recordsRemoved += Number(this.database.prepare('DELETE FROM company_change_records WHERE task_id = ?').run(lastId).changes);
        } else if (now >= record.plan.expiresAt && liveDraft(record.status)) {
          draftsRemoved += this.removeDraft(lastId); record.status = 'EXPIRED'; record.updatedAt = record.plan.expiresAt;
          if (record.approval) record.approval.revokedAt ??= record.approval.expiresAt;
          this.writeRecord(record);
        } else if (record.status === 'APPROVED' && record.approval && now >= record.approval.expiresAt) {
          record.approval.revokedAt = record.approval.expiresAt; record.updatedAt = record.approval.expiresAt;
          record.status = 'AWAITING_APPROVAL'; this.writeRecord(record);
        }
      }
    }
  }

  private protectFiles(required = true): void {
    const directory = dirname(this.filePath), metadata = lstatSync(directory), uid = process.getuid?.();
    if (uid === undefined || !metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid
      || (metadata.mode & 0o7777) !== 0o700 || realpathSync(directory) !== directory) throw new HarnessError('UNSAFE_RUNTIME_PATH');
    for (const parent of this.parents) {
      const current = lstatSync(parent.path);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(parent.metadata, current)) throw new HarnessError('UNSAFE_RUNTIME_PATH');
    }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const path = this.filePath + suffix; assertRuntimeFile(path);
      const file = runtimePathMetadata(path);
      if (file && (file.uid !== uid || (file.mode & 0o7777) !== 0o600)) throw new HarnessError('UNSAFE_RUNTIME_FILE');
      if (suffix === '' && (required && !file || file && this.fileIdentity && !sameIdentity(this.fileIdentity, file))) throw new HarnessError('UNSAFE_RUNTIME_FILE');
      if (suffix) {
        const known = this.sidecarIdentities.get(suffix);
        if (file && known && !sameIdentity(file, known)) throw new HarnessError('UNSAFE_RUNTIME_FILE');
        if (file) this.sidecarIdentities.set(suffix, file); else this.sidecarIdentities.delete(suffix);
      }
    }
  }

  private transaction<T>(now: string, operation: () => T): T {
    if (this.closed) return fail('STORE_CLOSED');
    if (this.transactionOpen) return fail('TRANSACTION_IN_PROGRESS');
    this.protectFiles(); this.database.exec('BEGIN IMMEDIATE'); this.transactionOpen = true;
    try {
      this.assertSchema(this.database); this.validateRecords(this.database);
      const watermark = this.database.prepare('SELECT last_seen_at FROM company_change_store WHERE singleton = 1').get()!.last_seen_at;
      if (watermark !== null && (!timestamp(watermark) || now < watermark)) fail('TIME_REVERSED');
      const result = operation();
      const location = hashCompanyChangeValue(this.filePath), owner = `os-user:${process.getuid!()}`;
      this.database.prepare('UPDATE company_change_store SET last_seen_at = ?, store_hash = ? WHERE singleton = 1')
        .run(now, hashCompanyChangeValue(canonicalReadonlyJson([location, owner, now])));
      this.protectFiles(); this.database.exec('COMMIT'); this.transactionOpen = false; this.protectFiles(); return result;
    } catch (error) {
      if (this.transactionOpen) { try { this.database.exec('ROLLBACK'); } catch { /* Do not expose a secondary SQLite failure. */ } }
      throw safeError(error);
    } finally { this.transactionOpen = false; }
  }
}
