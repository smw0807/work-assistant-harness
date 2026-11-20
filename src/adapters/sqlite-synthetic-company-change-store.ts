import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync, type DatabaseSyncOptions, type SQLOutputValue } from 'node:sqlite';
import type { SyntheticCompanyChangeApproval, SyntheticCompanyChangeApprovalRequest, SyntheticCompanyChangeFailureCode,
  SyntheticCompanyChangeJournalEntry, SyntheticCompanyChangePlan, SyntheticCompanyChangeRequest,
  SyntheticCompanyChangeSnapshot, SyntheticCompanyChangeStatus } from '../domain/synthetic-company-change.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { SyntheticCompanyChangeStore } from '../ports/synthetic-company-change.js';
import { assertSyntheticCompanyChangeApproval, assertSyntheticCompanyChangeApprovalRequest,
  assertSyntheticCompanyChangeContext, assertSyntheticCompanyChangePlan, assertSyntheticCompanyChangeRequest,
  copySyntheticCompanyChangeData, getSyntheticCompanyChangeLimits, hashSyntheticCompanyChangeValue } from '../policy/synthetic-company-change.js';
import { canonicalReadonlyJson, isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

const applicationId = 0x53434331;
const limits = getSyntheticCompanyChangeLimits();
const planBytes = limits.maxPlanJsonBytes, approvalBytes = 4096, journalBytes = 2048, maximumJournalEntries = limits.maxJournalEntries;
const statuses: SyntheticCompanyChangeStatus[] = ['AWAITING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLIED', 'FAILED', 'CANCELLED', 'EXPIRED'];
const failures: SyntheticCompanyChangeFailureCode[] = ['SYNTHETIC_COMPANY_CHANGE_APPLY_FAILED', 'SYNTHETIC_COMPANY_CHANGE_INTERRUPTED'];
const metadataTable = `CREATE TABLE synthetic_company_change_store (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), location_hash TEXT NOT NULL, owner_id TEXT NOT NULL,
  last_seen_at TEXT, store_hash TEXT NOT NULL
) STRICT`;
const recordsTable = `CREATE TABLE synthetic_company_change_records (
  task_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('AWAITING_APPROVAL','APPROVED','APPLYING','APPLIED','FAILED','CANCELLED','EXPIRED')),
  updated_at TEXT NOT NULL, plan_json TEXT NOT NULL CHECK(length(CAST(plan_json AS BLOB)) <= ${planBytes}),
  approval_json TEXT NOT NULL CHECK(length(CAST(approval_json AS BLOB)) <= ${approvalBytes}),
  approval_minutes INTEGER, failure_code TEXT, record_hash TEXT NOT NULL
) STRICT`;
const journalTable = `CREATE TABLE synthetic_company_change_journal (
  task_id TEXT NOT NULL REFERENCES synthetic_company_change_records(task_id),
  position INTEGER NOT NULL CHECK(position >= 0 AND position < ${maximumJournalEntries}),
  entry_json TEXT NOT NULL CHECK(length(CAST(entry_json AS BLOB)) <= ${journalBytes}), entry_hash TEXT NOT NULL,
  PRIMARY KEY(task_id, position)
) STRICT`;
const databaseOptions: DatabaseSyncOptions = { enableForeignKeyConstraints: true, allowExtension: false,
  enableDoubleQuotedStringLiterals: false, defensive: true, timeout: limits.busyTimeoutMs,
  limits: { length: planBytes + approvalBytes + 65_536, sqlLength: 65_536, attach: 0 } };
const fail = (suffix = 'INVALID_RECORD'): never => { throw new HarnessError(`SYNTHETIC_COMPANY_CHANGE_${suffix}`); };
const safeError = (error: unknown, suffix = 'INVALID_RECORD'): HarnessError => {
  if (error instanceof HarnessError && (/^SYNTHETIC_COMPANY_CHANGE_[A-Z_]{1,60}$/u.test(error.code)
    || ['UNSAFE_RUNTIME_PATH', 'UNSAFE_RUNTIME_FILE'].includes(error.code))) return error;
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'errcode')?.value : undefined;
  return new HarnessError(`SYNTHETIC_COMPANY_CHANGE_${typeof code === 'number' && [5, 6].includes(code & 0xff) ? 'STORE_BUSY' : suffix}`);
};
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const decode = <T>(raw: unknown, maximum: number): T => {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maximum) return fail();
  try { const value: unknown = JSON.parse(raw); if (canonicalReadonlyJson(value) !== raw) return fail(); return value as T; }
  catch { return fail(); }
};
const sameIdentity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
const normalizedSql = (value: string): string => value.replace(/\s+/gu, ' ').trim();
interface RecordState extends SyntheticCompanyChangeSnapshot { approvalMinutes: number | null }
const recordHash = (record: RecordState): string => hashSyntheticCompanyChangeValue(canonicalReadonlyJson(record));
const started = (status: SyntheticCompanyChangeStatus): boolean => ['APPLYING', 'APPLIED', 'FAILED'].includes(status);

/** A metadata-only ledger consumes synthetic approval once and durably records each write boundary. */
export class SqliteSyntheticCompanyChangeStore implements SyntheticCompanyChangeStore {
  private readonly database: DatabaseSync;
  private readonly parents: { path: string; metadata: Stats }[] = [];
  private readonly sidecars = new Map<string, Stats>();
  private readonly activeClaims = new Set<string>();
  private fileIdentity: Stats | null = null;
  private closed = false;
  private transactionOpen = false;

  constructor(private readonly filePath: string) {
    let database: DatabaseSync | undefined;
    try {
      if (typeof filePath !== 'string' || !isAbsolute(filePath) || resolve(filePath) !== filePath
        || basename(filePath) !== 'synthetic-company-change.sqlite') throw new HarnessError('UNSAFE_RUNTIME_PATH');
      for (let path = dirname(filePath); ; path = dirname(path)) {
        const metadata = lstatSync(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(path) !== path) throw new HarnessError('UNSAFE_RUNTIME_PATH');
        this.parents.push({ path, metadata }); if (path === dirname(path)) break;
      }
      this.protectFiles(false);
      const existing = runtimePathMetadata(filePath);
      if (existing) {
        this.fileIdentity = existing;
        const readonly = new DatabaseSync(filePath, { ...databaseOptions, readOnly: true });
        try { this.assertSchema(readonly); this.validateRecords(readonly); } finally { readonly.close(); }
        this.protectFiles();
      } else {
        if (['-journal', '-wal', '-shm'].some(suffix => runtimePathMetadata(filePath + suffix))) throw new HarnessError('UNSAFE_RUNTIME_FILE');
        closeSync(openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
        this.fileIdentity = lstatSync(filePath);
      }
      database = new DatabaseSync(filePath, databaseOptions); this.protectFiles();
      // FULL is connection-specific and must precede both schema creation and every durable lifecycle transaction.
      database.exec('PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;');
      if (existing) { this.assertSchema(database); this.validateRecords(database); }
      else {
        database.exec('BEGIN IMMEDIATE');
        try {
          database.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1; ${metadataTable}; ${recordsTable}; ${journalTable};`);
          const location = hashSyntheticCompanyChangeValue(filePath), owner = `os-user:${process.getuid!()}`;
          database.prepare('INSERT INTO synthetic_company_change_store VALUES (1, ?, ?, NULL, ?)')
            .run(location, owner, hashSyntheticCompanyChangeValue(canonicalReadonlyJson([location, owner, null])));
          this.protectFiles(); database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
        this.assertSchema(database);
      }
      this.protectFiles(); this.database = database;
    } catch (error) {
      try { database?.close(); } catch { /* Preserve the first fixed failure. */ }
      throw safeError(error, 'INVALID_STORE');
    }
  }

  create(value: SyntheticCompanyChangePlan, context: ReadonlyContext): SyntheticCompanyChangeSnapshot {
    try {
      const now = assertSyntheticCompanyChangeContext(context); assertSyntheticCompanyChangePlan(value);
      const plan = copySyntheticCompanyChangeData(value);
      if (plan.ownerId !== context.ownerId) fail('OWNER_MISMATCH');
      if (now < plan.createdAt) fail('INVALID_TIME');
      return this.transaction(now, () => {
        const previous = this.readRecord(plan.id);
        if (previous) {
          if (canonicalReadonlyJson(previous.plan) !== canonicalReadonlyJson(plan)) fail('ID_REUSED');
          this.expire(previous, now); return this.snapshot(previous);
        }
        if (now >= plan.expiresAt) fail('EXPIRED');
        const record: RecordState = { plan, status: 'AWAITING_APPROVAL', approval: null, approvalMinutes: null,
          updatedAt: now, journal: [], failureCode: null };
        this.database.prepare('INSERT INTO synthetic_company_change_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(plan.id, record.status, now, canonicalReadonlyJson(plan), 'null', null, null, recordHash(record));
        return this.snapshot(record);
      });
    } catch (error) { throw safeError(error); }
  }

  inspect(id: string, context: ReadonlyContext): SyntheticCompanyChangeSnapshot {
    return this.operation(id, context, record => this.snapshot(record));
  }

  approve(request: SyntheticCompanyChangeApprovalRequest, context: ReadonlyContext): SyntheticCompanyChangeSnapshot {
    try {
      assertSyntheticCompanyChangeApprovalRequest(request);
      return this.operation(request.taskId, context, (record, now) => {
        this.assertPlanHash(record, request.planHash);
        if (record.status === 'APPROVED') {
          if (record.approvalMinutes !== request.expiresInMinutes) fail('ALREADY_APPROVED');
          return this.snapshot(record);
        }
        if (record.status !== 'AWAITING_APPROVAL' || record.approval) fail('APPROVAL_UNAVAILABLE');
        const expiresAt = new Date(Date.parse(now) + request.expiresInMinutes * 60_000).toISOString();
        if (expiresAt > record.plan.expiresAt) fail('APPROVAL_EXCEEDS_PLAN_TTL');
        record.approval = { id: randomUUID(), taskId: record.plan.id, ownerId: context.ownerId, planHash: record.plan.planHash,
          createdAt: now, expiresAt, usedAt: null, scope: 'synthetic-apply' };
        assertSyntheticCompanyChangeApproval(record.plan, record.approval);
        record.approvalMinutes = request.expiresInMinutes; record.status = 'APPROVED'; record.updatedAt = now;
        this.writeRecord(record); return this.snapshot(record);
      });
    } catch (error) { throw safeError(error); }
  }

  claim(request: SyntheticCompanyChangeRequest, context: ReadonlyContext): SyntheticCompanyChangeSnapshot {
    try {
      assertSyntheticCompanyChangeRequest(request);
      const result = this.operation(request.taskId, context, (record, now) => {
        this.assertPlanHash(record, request.planHash);
        if (record.status !== 'APPROVED' || !record.approval || record.approval.usedAt !== null) fail('APPROVAL_UNAVAILABLE');
        record.approval!.usedAt = now; record.status = 'APPLYING'; record.updatedAt = now; this.writeRecord(record);
        return this.snapshot(record);
      });
      // Only a confirmed commit grants this controller instance the right to append journal evidence.
      this.activeClaims.add(request.taskId); return result;
    } catch (error) { throw safeError(error); }
  }

  record(taskId: string, input: Omit<SyntheticCompanyChangeJournalEntry, 'sequence' | 'at'>,
    context: ReadonlyContext): SyntheticCompanyChangeSnapshot {
    return this.operation(taskId, context, (record, now) => {
      this.assertActiveClaim(record);
      if (!readonlyExactKeys(input, ['kind', 'path', 'state'])) fail('INVALID_JOURNAL');
      const entry: SyntheticCompanyChangeJournalEntry = { sequence: record.journal.length, kind: input.kind,
        path: input.path, state: input.state, at: now };
      this.assertJournalEntry(record, entry, record.journal.length);
      const json = canonicalReadonlyJson(entry); if (Buffer.byteLength(json) > journalBytes) fail('INVALID_JOURNAL');
      this.database.prepare('INSERT INTO synthetic_company_change_journal VALUES (?, ?, ?, ?)')
        .run(taskId, entry.sequence, json, hashSyntheticCompanyChangeValue(json));
      record.journal.push(entry); record.updatedAt = now; this.writeRecord(record); return this.snapshot(record);
    });
  }

  finish(taskId: string, status: 'APPLIED' | 'FAILED', failureCode: SyntheticCompanyChangeFailureCode | null,
    context: ReadonlyContext): SyntheticCompanyChangeSnapshot {
    if (!['APPLIED', 'FAILED'].includes(status) || (status === 'APPLIED' ? failureCode !== null : !failureCode || !failures.includes(failureCode))) return fail('INVALID_RESULT');
    const result = this.operation(taskId, context, (record, now) => {
      this.assertActiveClaim(record);
      if (status === 'APPLIED' && record.journal.length !== 2 * (record.plan.changes.length + 1)) fail('JOURNAL_INCOMPLETE');
      record.status = status; record.failureCode = failureCode; record.updatedAt = now; this.writeRecord(record);
      return this.snapshot(record);
    });
    this.activeClaims.delete(taskId); return result;
  }

  cancel(id: string, context: ReadonlyContext): SyntheticCompanyChangeSnapshot {
    return this.operation(id, context, (record, now) => {
      if (started(record.status)) fail('ALREADY_CLAIMED');
      if (record.status !== 'CANCELLED' && record.status !== 'EXPIRED') {
        record.status = 'CANCELLED'; record.updatedAt = now; this.writeRecord(record);
      }
      return this.snapshot(record);
    });
  }

  close(): void {
    this.activeClaims.clear();
    if (this.closed) return;
    try { this.database.close(); this.closed = true; } catch (error) { throw safeError(error, 'INVALID_STORE'); }
  }

  private assertPlanHash(record: RecordState, expected: string): void {
    if (record.plan.planHash !== expected) fail('PLAN_MISMATCH');
  }

  private assertActiveClaim(record: RecordState): void {
    if (record.status !== 'APPLYING' || !this.activeClaims.has(record.plan.id)) fail('CLAIM_NOT_OWNED');
  }

  private operation(id: string, context: ReadonlyContext, action: (record: RecordState, now: string) => SyntheticCompanyChangeSnapshot): SyntheticCompanyChangeSnapshot {
    try {
      if (!isReadonlyId(id)) return fail('INVALID_ID');
      const now = assertSyntheticCompanyChangeContext(context);
      return this.transaction(now, () => {
        const record = this.readRecord(id); if (!record) return fail('NOT_FOUND');
        this.expire(record, now); return action(record, now);
      });
    } catch (error) { throw safeError(error); }
  }

  private expire(record: RecordState, now: string): void {
    if (!['AWAITING_APPROVAL', 'APPROVED'].includes(record.status)) return;
    const expiresAt = record.approval?.expiresAt ?? record.plan.expiresAt;
    if (now >= expiresAt) { record.status = 'EXPIRED'; record.updatedAt = expiresAt; this.writeRecord(record); }
  }

  private snapshot(record: RecordState): SyntheticCompanyChangeSnapshot {
    return copySyntheticCompanyChangeData({ plan: record.plan, status: record.status, approval: record.approval,
      updatedAt: record.updatedAt, journal: record.journal, failureCode: record.failureCode });
  }

  private assertSchema(database: DatabaseSync): void {
    if (database.prepare('PRAGMA application_id').get()?.application_id !== applicationId
      || database.prepare('PRAGMA user_version').get()?.user_version !== 1
      || database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete'
      || database.prepare('PRAGMA synchronous').get()?.synchronous !== 2) fail('INVALID_STORE');
    const tables: Record<string, string> = { synthetic_company_change_store: metadataTable,
      synthetic_company_change_records: recordsTable, synthetic_company_change_journal: journalTable };
    const indexes = new Map([['sqlite_autoindex_synthetic_company_change_records_1', 'synthetic_company_change_records'],
      ['sqlite_autoindex_synthetic_company_change_journal_1', 'synthetic_company_change_journal']]);
    const rows = database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
    if (rows.length !== 5) fail('INVALID_STORE');
    for (const row of rows) {
      if (row.type === 'table' && typeof row.name === 'string' && Object.hasOwn(tables, row.name) && row.tbl_name === row.name
        && typeof row.sql === 'string' && normalizedSql(row.sql) === normalizedSql(tables[row.name]!)) continue;
      if (row.type === 'index' && typeof row.name === 'string' && indexes.get(row.name) === row.tbl_name && row.sql === null) continue;
      fail('INVALID_STORE');
    }
    const rowsBinding = database.prepare('SELECT singleton, location_hash, owner_id, last_seen_at, store_hash FROM synthetic_company_change_store LIMIT 2').all();
    const binding = rowsBinding[0], location = hashSyntheticCompanyChangeValue(this.filePath), owner = `os-user:${process.getuid!()}`;
    if (rowsBinding.length !== 1 || !binding || binding.singleton !== 1 || binding.location_hash !== location || binding.owner_id !== owner
      || binding.last_seen_at !== null && !timestamp(binding.last_seen_at)
      || binding.store_hash !== hashSyntheticCompanyChangeValue(canonicalReadonlyJson([location, owner, binding.last_seen_at]))) fail('INVALID_STORE');
    if (database.prepare('PRAGMA foreign_key_check').get()) fail('INVALID_STORE');
  }

  private readRecord(id: string, database = this.database): RecordState | null {
    const row = database.prepare(`SELECT task_id, status, updated_at, approval_minutes, failure_code, record_hash,
      length(CAST(plan_json AS BLOB)) AS plan_bytes, length(CAST(approval_json AS BLOB)) AS approval_bytes
      FROM synthetic_company_change_records WHERE task_id = ?`).get(id);
    if (!row) return null;
    if (!Number.isSafeInteger(row.plan_bytes) || Number(row.plan_bytes) < 2 || Number(row.plan_bytes) > planBytes
      || !Number.isSafeInteger(row.approval_bytes) || Number(row.approval_bytes) < 2 || Number(row.approval_bytes) > approvalBytes) return fail();
    const body = database.prepare('SELECT plan_json, approval_json FROM synthetic_company_change_records WHERE task_id = ?').get(id)!;
    const plan = decode<SyntheticCompanyChangePlan>(body.plan_json, planBytes), approval = decode<SyntheticCompanyChangeApproval | null>(body.approval_json, approvalBytes);
    try { assertSyntheticCompanyChangePlan(plan); if (approval) assertSyntheticCompanyChangeApproval(plan, approval); } catch { return fail(); }
    if (row.task_id !== id || plan.id !== id || plan.ownerId !== `os-user:${process.getuid!()}`
      || !statuses.includes(row.status as SyntheticCompanyChangeStatus) || !timestamp(row.updated_at) || row.updated_at < plan.createdAt) return fail();
    const record: RecordState = { plan, approval, status: row.status as SyntheticCompanyChangeStatus, updatedAt: row.updated_at,
      approvalMinutes: row.approval_minutes as number | null, journal: [], failureCode: row.failure_code as SyntheticCompanyChangeFailureCode | null };
    const journal = database.prepare(`SELECT position, length(CAST(entry_json AS BLOB)) AS bytes FROM synthetic_company_change_journal
      WHERE task_id = ? ORDER BY position LIMIT ${maximumJournalEntries + 1}`).all(id);
    for (const [index, item] of journal.entries()) {
      if (item.position !== index || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 2 || Number(item.bytes) > journalBytes) return fail();
      const stored = database.prepare('SELECT entry_json, entry_hash FROM synthetic_company_change_journal WHERE task_id = ? AND position = ?').get(id, index)!;
      const entry = decode<SyntheticCompanyChangeJournalEntry>(stored.entry_json, journalBytes);
      this.assertJournalEntry(record, entry, index);
      if (hashSyntheticCompanyChangeValue(stored.entry_json as string) !== stored.entry_hash || entry.at > record.updatedAt) return fail();
      record.journal.push(entry);
    }
    this.assertRecordState(record);
    if (recordHash(record) !== row.record_hash) return fail();
    return record;
  }

  private assertJournalEntry(record: RecordState, entry: SyntheticCompanyChangeJournalEntry, index: number): void {
    const branch = index < 2, descriptor = record.plan.changes[Math.floor((index - 2) / 2)];
    if (!readonlyExactKeys(entry, ['sequence', 'kind', 'path', 'state', 'at']) || index >= maximumJournalEntries
      || index >= 2 * (record.plan.changes.length + 1) || entry.sequence !== index
      || entry.kind !== (branch ? 'branch' : 'file') || entry.path !== (branch ? null : descriptor?.path)
      || entry.state !== (index % 2 === 0 ? 'INTENT' : 'DONE') || !timestamp(entry.at)
      || !record.approval?.usedAt || entry.at < record.approval.usedAt
      || index > 0 && entry.at < record.journal[index - 1]!.at) fail('INVALID_JOURNAL');
  }

  private assertRecordState(record: RecordState): void {
    const { approval, status, updatedAt, plan } = record;
    if (approval) {
      if (!Number.isSafeInteger(record.approvalMinutes) || record.approvalMinutes! < limits.minApprovalMinutes || record.approvalMinutes! > limits.maxApprovalMinutes
        || approval.expiresAt !== new Date(Date.parse(approval.createdAt) + record.approvalMinutes! * 60_000).toISOString()
        || updatedAt < approval.createdAt) return fail();
    } else if (record.approvalMinutes !== null || status === 'APPROVED' || started(status)) return fail();
    if (started(status)) {
      if (!approval?.usedAt || updatedAt < approval.usedAt) return fail();
    } else if (approval?.usedAt || record.journal.length !== 0) return fail();
    if (status === 'AWAITING_APPROVAL' && approval !== null || status === 'APPROVED' && updatedAt !== approval!.createdAt
      || status === 'EXPIRED' && updatedAt !== (approval?.expiresAt ?? plan.expiresAt)
      || ['AWAITING_APPROVAL', 'APPROVED', 'CANCELLED'].includes(status) && updatedAt >= (approval?.expiresAt ?? plan.expiresAt)
      || (status === 'FAILED' ? !record.failureCode || !failures.includes(record.failureCode) : record.failureCode !== null)
      || status === 'APPLIED' && record.journal.length !== 2 * (plan.changes.length + 1)) return fail();
  }

  private validateRecords(database: DatabaseSync): void {
    let lastId: string | null = null;
    const watermark = database.prepare('SELECT last_seen_at FROM synthetic_company_change_store WHERE singleton = 1').get()!.last_seen_at;
    for (;;) {
      const rows: Record<string, SQLOutputValue>[] = database.prepare(`SELECT task_id FROM synthetic_company_change_records
        WHERE (? IS NULL OR task_id > ?) ORDER BY task_id LIMIT 100`).all(lastId, lastId);
      if (!rows.length) return;
      for (const row of rows) {
        if (!isReadonlyId(row.task_id)) return fail();
        const record = this.readRecord(row.task_id, database); if (!record) return fail();
        if (!timestamp(watermark) || record.updatedAt > watermark) return fail();
        lastId = row.task_id;
      }
    }
  }

  private writeRecord(record: RecordState): void {
    if (this.database.prepare(`UPDATE synthetic_company_change_records SET status = ?, updated_at = ?, approval_json = ?, approval_minutes = ?,
      failure_code = ?, record_hash = ? WHERE task_id = ?`).run(record.status, record.updatedAt, canonicalReadonlyJson(record.approval),
      record.approvalMinutes, record.failureCode, recordHash(record), record.plan.id).changes !== 1) fail();
  }

  private protectFiles(required = true): void {
    const directory = dirname(this.filePath), metadata = lstatSync(directory), uid = process.getuid?.();
    if (uid === undefined || !metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid
      || (metadata.mode & 0o7777) !== 0o700 || realpathSync(directory) !== directory) throw new HarnessError('UNSAFE_RUNTIME_PATH');
    for (const parent of this.parents) {
      const current = lstatSync(parent.path);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(parent.metadata, current)
        || realpathSync(parent.path) !== parent.path) throw new HarnessError('UNSAFE_RUNTIME_PATH');
    }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const path = this.filePath + suffix; assertRuntimeFile(path); const file = runtimePathMetadata(path);
      if (file && (file.uid !== uid || (file.mode & 0o7777) !== 0o600)) throw new HarnessError('UNSAFE_RUNTIME_FILE');
      if (!suffix && (required && !file || file && this.fileIdentity && !sameIdentity(this.fileIdentity, file))) throw new HarnessError('UNSAFE_RUNTIME_FILE');
      if (suffix) {
        const known = this.sidecars.get(suffix);
        if (file && known && !sameIdentity(file, known)) throw new HarnessError('UNSAFE_RUNTIME_FILE');
        if (file) this.sidecars.set(suffix, file); else this.sidecars.delete(suffix);
      }
    }
  }

  private transaction<T>(now: string, operation: () => T): T {
    if (this.closed) return fail('STORE_CLOSED');
    if (this.transactionOpen) return fail('TRANSACTION_IN_PROGRESS');
    this.protectFiles(); this.database.exec('BEGIN IMMEDIATE'); this.transactionOpen = true;
    try {
      this.assertSchema(this.database); this.validateRecords(this.database);
      const watermark = this.database.prepare('SELECT last_seen_at FROM synthetic_company_change_store WHERE singleton = 1').get()!.last_seen_at;
      if (watermark !== null && (!timestamp(watermark) || now < watermark)) fail('TIME_REVERSED');
      const result = operation(), location = hashSyntheticCompanyChangeValue(this.filePath), owner = `os-user:${process.getuid!()}`;
      this.database.prepare('UPDATE synthetic_company_change_store SET last_seen_at = ?, store_hash = ? WHERE singleton = 1')
        .run(now, hashSyntheticCompanyChangeValue(canonicalReadonlyJson([location, owner, now])));
      this.protectFiles(); this.database.exec('COMMIT'); this.transactionOpen = false; this.protectFiles(); return result;
    } catch (error) {
      if (this.transactionOpen) { try { this.database.exec('ROLLBACK'); } catch { /* Keep the original fixed error. */ } }
      throw safeError(error);
    } finally { this.transactionOpen = false; }
  }
}
