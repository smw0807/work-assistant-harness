import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DatabaseSync, type DatabaseSyncOptions, type SQLOutputValue } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { CompanyReadonlyPruneResult, CompanyReadonlyStatus } from '../domain/company-readonly.js';
import type { CompanyReadonlyPayloadV2, CompanyReadonlyPlanV2, CompanyReadonlySnapshotV2,
  CompanyReadonlyStoreV2 } from '../domain/company-readonly-v2.js';
import { assertCompanyReadonlyPlanV2, copyCompanyReadonlyV2Data, validateCompanyReadonlyPayloadV2 } from '../policy/company-readonly-v2.js';
import { canonicalReadonlyJson } from '../policy/readonly-investigation-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

const applicationId = 0x43525032;
const schemaVersion = 1;
const planBytes = 32_768;
const payloadBytes = 2_097_152;
const metadataTable = `CREATE TABLE company_readonly_v2_store (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  location_hash TEXT NOT NULL,
  owner_id TEXT NOT NULL
) STRICT`;
const preparationsTable = `CREATE TABLE company_readonly_v2_preparations (
  preparation_id TEXT PRIMARY KEY,
  preparation_key TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  audit_expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('AWAITING_APPROVAL','CANCELLED','EXPIRED')),
  updated_at TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL CHECK(length(CAST(plan_json AS BLOB)) <= ${planBytes}),
  record_hash TEXT NOT NULL
) STRICT`;
const payloadsTable = `CREATE TABLE company_readonly_v2_payloads (
  preparation_id TEXT PRIMARY KEY REFERENCES company_readonly_v2_preparations(preparation_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB)) <= ${payloadBytes})
) STRICT`;
const databaseOptions: DatabaseSyncOptions = { enableForeignKeyConstraints: true, allowExtension: false,
  enableDoubleQuotedStringLiterals: false, defensive: true, timeout: 5000,
  limits: { length: payloadBytes + 65_536, sqlLength: 65_536, attach: 0 } };
const knownCodes = new Set(['UNSAFE_RUNTIME_PATH', 'UNSAFE_RUNTIME_FILE', 'COMPANY_READONLY_V2_INVALID_STORE',
  'COMPANY_READONLY_V2_INVALID_RECORD', 'COMPANY_READONLY_V2_INVALID_TIME', 'COMPANY_READONLY_V2_OWNER_MISMATCH',
  'COMPANY_READONLY_V2_INVALID_ID', 'COMPANY_READONLY_V2_NOT_FOUND', 'COMPANY_READONLY_V2_ID_REUSED', 'COMPANY_READONLY_V2_EXPIRED',
  'COMPANY_READONLY_V2_TIME_REVERSED', 'COMPANY_READONLY_V2_STORE_BUSY', 'COMPANY_READONLY_V2_STORE_CLOSED',
  'COMPANY_READONLY_V2_TRANSACTION_IN_PROGRESS', 'COMPANY_READONLY_V2_INVALID_PLAN', 'COMPANY_READONLY_V2_INVALID_PAYLOAD',
  'COMPANY_READONLY_V2_UNSAFE_LOCATION']);
const fail = (code = 'COMPANY_READONLY_V2_INVALID_RECORD'): never => { throw new HarnessError(code); };
const safeError = (error: unknown, fallback: string): HarnessError => {
  if (error instanceof HarnessError && knownCodes.has(error.code)) return error;
  if (error && typeof error === 'object') {
    const code = Object.getOwnPropertyDescriptor(error, 'errcode')?.value;
    if (typeof code === 'number' && [5, 6].includes(code & 0xff)) return new HarnessError('COMPANY_READONLY_V2_STORE_BUSY');
  }
  return new HarnessError(fallback);
};
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const decode = <T>(text: unknown, maximum: number): T => {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximum) return fail();
  try {
    const value: unknown = JSON.parse(text);
    if (JSON.stringify(value) !== text) return fail();
    return value as T;
  } catch { return fail(); }
};
const assertContext = (context: ReadonlyContext): string => {
  if (!context || !(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) return fail('COMPANY_READONLY_V2_INVALID_TIME');
  if (!process.getuid || context.ownerId !== `os-user:${process.getuid()}`) return fail('COMPANY_READONLY_V2_OWNER_MISMATCH');
  return context.now.toISOString();
};
const sameIdentity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
const contains = (root: string, path: string): boolean => {
  const difference = relative(root, path);
  return difference === '' || difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
};
const normalizedSql = (value: string): string => value.replace(/\s+/gu, ' ').trim();
interface PlanRecord { plan: CompanyReadonlyPlanV2; status: CompanyReadonlyStatus; updatedAt: string; payloadHash: string }
const recordHash = ({ plan, status, updatedAt, payloadHash }: PlanRecord): string => hash(JSON.stringify([plan.id, plan.preparationKey,
  plan.ownerId, plan.createdAt, plan.expiresAt, plan.auditExpiresAt, status, updatedAt, plan.planHash, payloadHash, canonicalReadonlyJson(plan)]));

/** Preparation-only storage has no approval, attempt, credential or dispatch tables or methods. */
export class SqliteCompanyReadonlyV2Store implements CompanyReadonlyStoreV2 {
  private readonly database: DatabaseSync;
  private readonly parents: { path: string; metadata: Stats }[] = [];
  private fileIdentity: Stats | null = null;
  private closed = false;
  private transactionOpen = false;

  constructor(private readonly filePath: string) {
    let database: DatabaseSync | undefined;
    try {
      if (typeof filePath !== 'string' || !isAbsolute(filePath) || resolve(filePath) !== filePath
        || basename(filePath) !== 'company-readonly-v2.sqlite') fail('UNSAFE_RUNTIME_PATH');
      for (let path = dirname(filePath); ; path = dirname(path)) {
        const metadata = lstatSync(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('UNSAFE_RUNTIME_PATH');
        this.parents.push({ path, metadata }); if (path === dirname(path)) break;
      }
      this.protectFiles(false);
      const existing = runtimePathMetadata(filePath);
      if (existing) {
        this.fileIdentity = existing;
        // Reject a foreign schema before a writable connection or migration can touch its contents.
        const readonly = new DatabaseSync(filePath, { ...databaseOptions, readOnly: true });
        try { this.assertSchema(readonly); this.validateStoredRecords(readonly); } finally { readonly.close(); }
        this.protectFiles();
      } else {
        if (['-journal', '-wal', '-shm'].some(suffix => runtimePathMetadata(`${filePath}${suffix}`))) fail('UNSAFE_RUNTIME_FILE');
        closeSync(openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
        this.fileIdentity = lstatSync(filePath);
      }
      database = new DatabaseSync(filePath, databaseOptions);
      this.protectFiles();
      if (existing) { this.assertSchema(database); this.validateStoredRecords(database); }
      else {
        database.exec('BEGIN IMMEDIATE');
        try {
          database.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = ${schemaVersion}; ${metadataTable}; ${preparationsTable}; ${payloadsTable};`);
          database.prepare('INSERT INTO company_readonly_v2_store VALUES (1, ?, ?)').run(hash(this.filePath), `os-user:${process.getuid!()}`);
          this.protectFiles(); database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
        this.assertSchema(database);
      }
      database.exec('PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF;');
      this.protectFiles(); this.database = database;
    } catch (error) {
      try { database?.close(); } catch { /* The original fixed failure remains authoritative. */ }
      throw safeError(error, 'COMPANY_READONLY_V2_INVALID_STORE');
    }
  }

  create(value: CompanyReadonlyPlanV2, input: CompanyReadonlyPayloadV2, context: ReadonlyContext): CompanyReadonlySnapshotV2 {
    try {
      const now = assertContext(context);
      const plan = copyCompanyReadonlyV2Data(value), payload = copyCompanyReadonlyV2Data(input);
      assertCompanyReadonlyPlanV2(plan); validateCompanyReadonlyPayloadV2(plan, payload);
      if (plan.ownerId !== context.ownerId) fail('COMPANY_READONLY_V2_OWNER_MISMATCH');
      if (contains(payload.registration.sourceRoot, dirname(this.filePath)) || contains(dirname(this.filePath), payload.registration.sourceRoot)) {
        fail('COMPANY_READONLY_V2_UNSAFE_LOCATION');
      }
      if (now < plan.createdAt) fail('COMPANY_READONLY_V2_INVALID_TIME');
      const body = canonicalReadonlyJson(payload), planJson = canonicalReadonlyJson(plan), payloadHash = hash(body);
      if (Buffer.byteLength(body) > payloadBytes || Buffer.byteLength(planJson) > planBytes) fail();
      const result = this.transaction(() => {
        const previous = this.readRecord(plan.id);
        if (previous) {
          this.owned(plan.id, context, now);
          if (canonicalReadonlyJson(previous.plan) !== planJson || previous.payloadHash !== payloadHash) fail('COMPANY_READONLY_V2_ID_REUSED');
        } else if (now >= plan.expiresAt) fail('COMPANY_READONLY_V2_EXPIRED');
        this.pruneRecords(context, now);
        // Exact retries preserve this ID and its terminal state. Audit expiry never recreates it.
        if (previous) return this.readRecord(plan.id) ? this.snapshot(this.owned(plan.id, context, now)) : null;
        if (this.database.prepare('SELECT preparation_id FROM company_readonly_v2_preparations WHERE preparation_key = ?').get(plan.preparationKey)) {
          fail('COMPANY_READONLY_V2_ID_REUSED');
        }
        const record: PlanRecord = { plan, status: 'AWAITING_APPROVAL', updatedAt: now, payloadHash };
        this.database.prepare('INSERT INTO company_readonly_v2_preparations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(plan.id, plan.preparationKey, plan.ownerId, plan.createdAt, plan.expiresAt, plan.auditExpiresAt,
            record.status, now, plan.planHash, payloadHash, planJson, recordHash(record));
        this.database.prepare('INSERT INTO company_readonly_v2_payloads VALUES (?, ?, ?, ?)').run(plan.id, plan.expiresAt, payloadHash, body);
        return this.snapshot(record);
      });
      return result ?? fail('COMPANY_READONLY_V2_NOT_FOUND');
    } catch (error) { throw safeError(error, 'COMPANY_READONLY_V2_INVALID_RECORD'); }
  }

  inspect(id: string, context: ReadonlyContext): CompanyReadonlySnapshotV2 {
    try {
      const now = assertContext(context); if (!identifier(id)) fail('COMPANY_READONLY_V2_INVALID_ID');
      const result = this.transaction(() => {
        this.pruneRecords(context, now);
        return this.readRecord(id) ? this.snapshot(this.owned(id, context, now)) : null;
      });
      return result ?? fail('COMPANY_READONLY_V2_NOT_FOUND');
    } catch (error) { throw safeError(error, 'COMPANY_READONLY_V2_INVALID_RECORD'); }
  }

  cancel(id: string, context: ReadonlyContext): CompanyReadonlySnapshotV2 {
    try {
      const now = assertContext(context); if (!identifier(id)) fail('COMPANY_READONLY_V2_INVALID_ID');
      const result = this.transaction(() => {
        this.pruneRecords(context, now);
        if (!this.readRecord(id)) return null;
        const record = this.owned(id, context, now);
        if (record.status === 'AWAITING_APPROVAL') {
          this.readPayload(record);
          this.database.prepare('DELETE FROM company_readonly_v2_payloads WHERE preparation_id = ?').run(id);
          record.status = 'CANCELLED'; record.updatedAt = now; this.writeRecord(record);
        }
        return this.snapshot(record);
      });
      return result ?? fail('COMPANY_READONLY_V2_NOT_FOUND');
    } catch (error) { throw safeError(error, 'COMPANY_READONLY_V2_INVALID_RECORD'); }
  }

  prune(context: ReadonlyContext): CompanyReadonlyPruneResult {
    try { const now = assertContext(context); return this.transaction(() => this.pruneRecords(context, now)); }
    catch (error) { throw safeError(error, 'COMPANY_READONLY_V2_INVALID_RECORD'); }
  }

  close(): void {
    if (this.closed) return;
    try { this.database.close(); this.closed = true; }
    catch (error) { throw safeError(error, 'COMPANY_READONLY_V2_INVALID_STORE'); }
  }

  private assertSchema(database: DatabaseSync): void {
    if (database.prepare('PRAGMA application_id').get()?.application_id !== applicationId
      || database.prepare('PRAGMA user_version').get()?.user_version !== schemaVersion
      || database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') fail('COMPANY_READONLY_V2_INVALID_STORE');
    const tables: Record<string, string> = { company_readonly_v2_store: metadataTable,
      company_readonly_v2_preparations: preparationsTable, company_readonly_v2_payloads: payloadsTable };
    const indexes = new Map([['sqlite_autoindex_company_readonly_v2_preparations_1', 'company_readonly_v2_preparations'],
      ['sqlite_autoindex_company_readonly_v2_preparations_2', 'company_readonly_v2_preparations'],
      ['sqlite_autoindex_company_readonly_v2_payloads_1', 'company_readonly_v2_payloads']]);
    const rows = database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
    if (rows.length !== 6) fail('COMPANY_READONLY_V2_INVALID_STORE');
    for (const row of rows) {
      if (row.type === 'table' && typeof row.name === 'string' && Object.hasOwn(tables, row.name)
        && row.tbl_name === row.name && typeof row.sql === 'string' && normalizedSql(row.sql) === normalizedSql(tables[row.name]!)) continue;
      if (row.type === 'index' && typeof row.name === 'string' && indexes.get(row.name) === row.tbl_name && row.sql === null) continue;
      fail('COMPANY_READONLY_V2_INVALID_STORE');
    }
    const binding = database.prepare('SELECT singleton, location_hash, owner_id FROM company_readonly_v2_store LIMIT 2').all();
    if (binding.length !== 1 || binding[0]!.singleton !== 1 || binding[0]!.location_hash !== hash(this.filePath)
      || binding[0]!.owner_id !== `os-user:${process.getuid!()}`) fail('COMPANY_READONLY_V2_INVALID_STORE');
    if (database.prepare('PRAGMA foreign_key_check').get()) fail('COMPANY_READONLY_V2_INVALID_STORE');
  }

  private readRecord(id: string, database = this.database): PlanRecord | null {
    const row = database.prepare(`SELECT preparation_id, preparation_key, owner_id, created_at, expires_at, audit_expires_at,
      status, updated_at, plan_hash, payload_hash, record_hash, length(CAST(plan_json AS BLOB)) AS bytes FROM company_readonly_v2_preparations WHERE preparation_id = ?`).get(id);
    if (!row) return null;
    if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) < 2 || Number(row.bytes) > planBytes) return fail();
    const body = database.prepare('SELECT plan_json FROM company_readonly_v2_preparations WHERE preparation_id = ?').get(id)?.plan_json;
    const plan = decode<CompanyReadonlyPlanV2>(body, planBytes);
    try { assertCompanyReadonlyPlanV2(plan); } catch { return fail(); }
    if (row.preparation_id !== id || plan.id !== id || row.preparation_key !== plan.preparationKey || row.owner_id !== plan.ownerId
      || row.created_at !== plan.createdAt || row.expires_at !== plan.expiresAt || row.audit_expires_at !== plan.auditExpiresAt
      || row.plan_hash !== plan.planHash || plan.ownerId !== `os-user:${process.getuid!()}` || !digest(row.payload_hash)
      || !['AWAITING_APPROVAL', 'CANCELLED', 'EXPIRED'].includes(String(row.status))
      || !timestamp(row.updated_at) || row.updated_at < plan.createdAt || !digest(row.record_hash)) return fail();
    const record: PlanRecord = { plan, status: row.status as CompanyReadonlyStatus, updatedAt: row.updated_at, payloadHash: row.payload_hash };
    if (record.status === 'EXPIRED' ? record.updatedAt !== plan.expiresAt : record.updatedAt >= plan.expiresAt) return fail();
    if (recordHash(record) !== row.record_hash) return fail();
    return record;
  }

  private owned(id: string, context: ReadonlyContext, now: string): PlanRecord {
    const record = this.readRecord(id); if (!record) return fail('COMPANY_READONLY_V2_NOT_FOUND');
    if (record.plan.ownerId !== context.ownerId) return fail('COMPANY_READONLY_V2_OWNER_MISMATCH');
    if (now < record.updatedAt) return fail('COMPANY_READONLY_V2_TIME_REVERSED');
    return record;
  }

  private readPayload(record: PlanRecord, database = this.database): CompanyReadonlyPayloadV2 | null {
    const row = database.prepare(`SELECT expires_at, payload_hash, length(CAST(payload_json AS BLOB)) AS bytes
      FROM company_readonly_v2_payloads WHERE preparation_id = ?`).get(record.plan.id);
    if (record.status !== 'AWAITING_APPROVAL') { if (row) return fail(); return null; }
    if (!row || row.expires_at !== record.plan.expiresAt || row.payload_hash !== record.payloadHash
      || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 2 || Number(row.bytes) > payloadBytes) return fail();
    const body = database.prepare('SELECT payload_json FROM company_readonly_v2_payloads WHERE preparation_id = ?').get(record.plan.id)?.payload_json;
    if (typeof body !== 'string' || hash(body) !== row.payload_hash) return fail();
    const payload = decode<CompanyReadonlyPayloadV2>(body, payloadBytes);
    try { validateCompanyReadonlyPayloadV2(record.plan, payload); } catch { return fail(); }
    return payload;
  }

  private validateStoredRecords(database: DatabaseSync): void {
    let lastId: string | null = null;
    for (;;) {
      const rows: Record<string, SQLOutputValue>[] = database.prepare(`SELECT preparation_id FROM company_readonly_v2_preparations
        WHERE (? IS NULL OR preparation_id > ?) ORDER BY preparation_id LIMIT 100`).all(lastId, lastId);
      if (!rows.length) return;
      for (const row of rows) {
        const id: SQLOutputValue | undefined = row.preparation_id;
        if (!identifier(id)) return fail();
        const record = this.readRecord(id, database);
        if (!record) return fail();
        this.readPayload(record, database); lastId = id;
      }
    }
  }

  private snapshot(record: PlanRecord): CompanyReadonlySnapshotV2 {
    return { plan: copyCompanyReadonlyV2Data(record.plan), status: record.status, updatedAt: record.updatedAt,
      payload: this.readPayload(record), approvalCreated: false, transmissionAllowed: false, executionAllowed: false, companyPolicyVerified: false };
  }

  private writeRecord(record: PlanRecord): void {
    if (this.database.prepare('UPDATE company_readonly_v2_preparations SET status = ?, updated_at = ?, record_hash = ? WHERE preparation_id = ?')
      .run(record.status, record.updatedAt, recordHash(record), record.plan.id).changes !== 1) fail();
  }

  private pruneRecords(context: ReadonlyContext, now: string): CompanyReadonlyPruneResult {
    let payloadsRemoved = 0, recordsRemoved = 0;
    let lastId: string | null = null;
    for (;;) {
      const rows: Record<string, SQLOutputValue>[] = this.database.prepare(`SELECT preparation_id FROM company_readonly_v2_preparations
        WHERE (? IS NULL OR preparation_id > ?) ORDER BY preparation_id LIMIT 100`).all(lastId, lastId);
      if (rows.length === 0) break;
      for (const row of rows) {
        const id = row.preparation_id;
        if (!identifier(id)) return fail(); lastId = id;
        const record = this.owned(lastId, context, now);
        if (now >= record.plan.auditExpiresAt) {
          payloadsRemoved += Number(this.database.prepare('DELETE FROM company_readonly_v2_payloads WHERE preparation_id = ?').run(lastId).changes);
          recordsRemoved += Number(this.database.prepare('DELETE FROM company_readonly_v2_preparations WHERE preparation_id = ?').run(lastId).changes);
        } else if (now >= record.plan.expiresAt && record.status === 'AWAITING_APPROVAL') {
          payloadsRemoved += Number(this.database.prepare('DELETE FROM company_readonly_v2_payloads WHERE preparation_id = ?').run(lastId).changes);
          record.status = 'EXPIRED'; record.updatedAt = record.plan.expiresAt; this.writeRecord(record);
        } else this.readPayload(record);
      }
    }
    return { payloadsRemoved, recordsRemoved };
  }

  private protectFiles(required = true): void {
    const directory = dirname(this.filePath), metadata = lstatSync(directory), uid = process.getuid?.();
    if (uid === undefined || !metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid
      || (metadata.mode & 0o7777) !== 0o700 || realpathSync(directory) !== directory) return fail('UNSAFE_RUNTIME_PATH');
    for (const parent of this.parents) {
      const current = lstatSync(parent.path);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(parent.metadata, current)) fail('UNSAFE_RUNTIME_PATH');
    }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const path = `${this.filePath}${suffix}`; assertRuntimeFile(path);
      const file = runtimePathMetadata(path);
      if (file && (file.uid !== uid || (file.mode & 0o7777) !== 0o600)) fail('UNSAFE_RUNTIME_FILE');
      if (suffix === '' && (required && !file || file && this.fileIdentity && !sameIdentity(this.fileIdentity, file))) fail('UNSAFE_RUNTIME_FILE');
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.closed) return fail('COMPANY_READONLY_V2_STORE_CLOSED');
    if (this.transactionOpen) return fail('COMPANY_READONLY_V2_TRANSACTION_IN_PROGRESS');
    this.protectFiles(); this.database.exec('BEGIN IMMEDIATE'); this.transactionOpen = true;
    try {
      this.assertSchema(this.database); this.validateStoredRecords(this.database);
      const result = operation(); this.protectFiles(); this.database.exec('COMMIT'); this.transactionOpen = false;
      this.protectFiles(); return result;
    } catch (error) {
      if (this.transactionOpen) { try { this.database.exec('ROLLBACK'); } catch { /* Never expose a secondary SQLite error. */ } }
      throw safeError(error, 'COMPANY_READONLY_V2_INVALID_RECORD');
    } finally { this.transactionOpen = false; }
  }
}
