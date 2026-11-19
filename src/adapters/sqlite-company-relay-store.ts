import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DatabaseSync, type DatabaseSyncOptions, type SQLOutputValue } from 'node:sqlite';
import type { CompanyRelayApproval, CompanyRelayApprovalRequest, CompanyRelayAttempt,
  CompanyRelayPayload, CompanyRelayPlan, CompanyRelayPruneResult, CompanyRelayReport,
  CompanyRelayRequest, CompanyRelaySnapshot, CompanyRelayStatus, CompanyRelayStore } from '../domain/company-relay.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { assertCompanyRelayPlan, assertCompanyRelayReport, validateCompanyRelayPayload, copyCompanyRelayData } from '../policy/company-relay.js';
import { canonicalReadonlyJson, isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

const applicationId = 0x43524c31;
const planBytes = 32_768, payloadBytes = 2_097_152, reportBytes = 32_768;
const statuses: CompanyRelayStatus[] = ['AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'REPORTED', 'FAILED', 'CANCELLED', 'EXPIRED', 'BLOCKED'];
const failures = new Set(['CALL_FAILED', 'INVALID_RESPONSE', 'INVALID_REPORT', 'OUTPUT_LIMIT', 'TIMEOUT', 'EXPIRED', 'CANCELLED', 'SOURCE_CHANGED',
  'RECOVERY_UNCERTAIN', 'ACCOUNT_MISMATCH', 'INVALID_TRANSPORT', 'CONFIG_CHANGED']
  .map(value => `COMPANY_RELAY_${value}`));
const metadataTable = `CREATE TABLE company_relay_store (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), location_hash TEXT NOT NULL, owner_id TEXT NOT NULL
) STRICT`;
const recordsTable = `CREATE TABLE company_relay_records (
  investigation_id TEXT PRIMARY KEY, preparation_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('AWAITING_APPROVAL','APPROVED','RUNNING','REPORTED','FAILED','CANCELLED','EXPIRED','BLOCKED')),
  updated_at TEXT NOT NULL, plan_json TEXT NOT NULL CHECK(length(CAST(plan_json AS BLOB)) <= ${planBytes}),
  approval_json TEXT NOT NULL CHECK(length(CAST(approval_json AS BLOB)) <= 4096),
  attempt_json TEXT NOT NULL CHECK(length(CAST(attempt_json AS BLOB)) <= 4096),
  payload_hash TEXT NOT NULL, report_hash TEXT, record_hash TEXT NOT NULL
) STRICT`;
const payloadsTable = `CREATE TABLE company_relay_payloads (
  investigation_id TEXT PRIMARY KEY REFERENCES company_relay_records(investigation_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(length(CAST(payload_json AS BLOB)) <= ${payloadBytes}),
  report_json TEXT CHECK(report_json IS NULL OR length(CAST(report_json AS BLOB)) <= ${reportBytes})
) STRICT`;
const databaseOptions: DatabaseSyncOptions = { enableForeignKeyConstraints: true, allowExtension: false,
  enableDoubleQuotedStringLiterals: false, defensive: true, timeout: 5000,
  limits: { length: payloadBytes + reportBytes + planBytes, sqlLength: 65_536, attach: 0 } };
const fail = (suffix = 'INVALID_RECORD'): never => { throw new HarnessError(`COMPANY_RELAY_${suffix}`); };
const safeError = (error: unknown, suffix = 'INVALID_RECORD'): HarnessError => {
  if (error instanceof HarnessError && (/^COMPANY_RELAY_[A-Z_]{1,60}$/.test(error.code)
    || ['UNSAFE_RUNTIME_PATH', 'UNSAFE_RUNTIME_FILE'].includes(error.code))) return error;
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'errcode')?.value : undefined;
  return new HarnessError(`COMPANY_RELAY_${typeof code === 'number' && [5, 6].includes(code & 0xff) ? 'STORE_BUSY' : suffix}`);
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const decode = <T>(raw: unknown, maximum: number): T => {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maximum) return fail();
  try { const value: unknown = JSON.parse(raw); if (canonicalReadonlyJson(value) !== raw) return fail(); return value as T; }
  catch { return fail(); }
};
const contextTime = (context: ReadonlyContext): string => {
  if (!context || !(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) return fail('INVALID_TIME');
  if (!process.getuid || context.ownerId !== `os-user:${process.getuid()}`) return fail('OWNER_MISMATCH');
  return context.now.toISOString();
};
const contains = (parent: string, child: string): boolean => {
  const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const sameIdentity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
const normalizedSql = (value: string): string => value.replace(/\s+/gu, ' ').trim();
interface RecordState {
  plan: CompanyRelayPlan; status: CompanyRelayStatus; updatedAt: string;
  approval: CompanyRelayApproval | null; attempt: CompanyRelayAttempt | null;
  payloadHash: string; reportHash: string | null;
}
const recordHash = (record: RecordState): string => hash(canonicalReadonlyJson(record));
const hasBody = (status: CompanyRelayStatus): boolean => ['AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'REPORTED'].includes(status);

/** A separate company transmission ledger consumes approval before dispatch and never restores a spent attempt. */
export class SqliteCompanyRelayStore implements CompanyRelayStore {
  private readonly database: DatabaseSync;
  private readonly parents: { path: string; metadata: Stats }[] = [];
  private fileIdentity: Stats | null = null;
  private closed = false;
  private transactionOpen = false;

  constructor(private readonly filePath: string) {
    let database: DatabaseSync | undefined;
    try {
      if (typeof filePath !== 'string' || !isAbsolute(filePath) || resolve(filePath) !== filePath
        || basename(filePath) !== 'company-relay.sqlite') throw new HarnessError('UNSAFE_RUNTIME_PATH');
      for (let path = dirname(filePath); ; path = dirname(path)) {
        const metadata = lstatSync(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new HarnessError('UNSAFE_RUNTIME_PATH');
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
      if (existing) { this.assertSchema(database); this.validateRecords(database); }
      else {
        database.exec('BEGIN IMMEDIATE');
        try {
          database.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1; ${metadataTable}; ${recordsTable}; ${payloadsTable};`);
          database.prepare('INSERT INTO company_relay_store VALUES (1, ?, ?)').run(hash(filePath), `os-user:${process.getuid!()}`);
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

  create(value: CompanyRelayPlan, input: CompanyRelayPayload, context: ReadonlyContext): CompanyRelaySnapshot {
    try {
      const now = contextTime(context), plan = copyCompanyRelayData(value), payload = copyCompanyRelayData(input);
      assertCompanyRelayPlan(plan); validateCompanyRelayPayload(plan, payload);
      if (plan.ownerId !== context.ownerId) fail('OWNER_MISMATCH');
      if (now < plan.createdAt) fail('INVALID_TIME');
      if (now >= plan.expiresAt) fail('EXPIRED');
      const sourceRoot = payload.preparation.registration.sourceRoot, directory = dirname(this.filePath);
      if (contains(sourceRoot, directory) || contains(directory, sourceRoot)) fail('UNSAFE_LOCATION');
      const body = canonicalReadonlyJson(payload), planJson = canonicalReadonlyJson(plan), payloadHash = hash(body);
      if (Buffer.byteLength(body) > payloadBytes || Buffer.byteLength(planJson) > planBytes) fail();
      this.maintain(context, now);
      return this.transaction(() => {
        const sameId = this.readRecord(plan.id);
        if (sameId && (canonicalReadonlyJson(sameId.plan) !== planJson || sameId.payloadHash !== payloadHash)) fail('ID_REUSED');
        const previous = this.database.prepare('SELECT investigation_id FROM company_relay_records WHERE preparation_key = ?').get(plan.preparationKey);
        if (previous) {
          if (!isReadonlyId(previous.investigation_id)) return fail();
          const record = this.owned(previous.investigation_id, context, now);
          if (record.payloadHash !== payloadHash) return fail('ID_REUSED');
          return this.snapshot(record);
        }
        const record: RecordState = { plan, status: 'AWAITING_APPROVAL', updatedAt: now, approval: null, attempt: null, payloadHash, reportHash: null };
        this.database.prepare('INSERT INTO company_relay_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(plan.id, plan.preparationKey, record.status, now, planJson, 'null', 'null', payloadHash, null, recordHash(record));
        this.database.prepare('INSERT INTO company_relay_payloads VALUES (?, ?, ?, NULL)').run(plan.id, plan.expiresAt, body);
        return this.snapshot(record);
      });
    } catch (error) { throw safeError(error); }
  }

  inspect(id: string, context: ReadonlyContext): CompanyRelaySnapshot {
    return this.operation(id, context, record => this.snapshot(record));
  }

  approve(request: CompanyRelayApprovalRequest, context: ReadonlyContext): CompanyRelaySnapshot {
    if (!readonlyExactKeys(request, ['investigationId', 'planHash', 'expiresInMinutes']) || !isReadonlyId(request.investigationId)
      || !digest(request.planHash) || !Number.isSafeInteger(request.expiresInMinutes) || request.expiresInMinutes < 1 || request.expiresInMinutes > 60) return fail('INVALID_APPROVAL');
    return this.operation(request.investigationId, context, (record, now) => {
      this.assertPlanHash(record, request.planHash);
      if (record.status !== 'AWAITING_APPROVAL' || record.approval || record.attempt) return fail('APPROVAL_UNAVAILABLE');
      this.readBody(record);
      record.approval = { id: randomUUID(), investigationId: record.plan.id, ownerId: context.ownerId, planHash: record.plan.planHash,
        createdAt: now, expiresAt: new Date(Math.min(Date.parse(record.plan.expiresAt), Date.parse(now) + request.expiresInMinutes * 60_000)).toISOString(),
        usedAt: null, revokedAt: null, mode: 'live', transmissionAllowed: true, executionAllowed: false };
      record.status = 'APPROVED'; record.updatedAt = now; this.writeRecord(record); return this.snapshot(record);
    });
  }

  claim(request: CompanyRelayRequest, context: ReadonlyContext): CompanyRelaySnapshot {
    this.assertRequest(request);
    return this.operation(request.investigationId, context, (record, now) => {
      this.assertPlanHash(record, request.planHash);
      if (record.status !== 'APPROVED' || !record.approval || record.approval.usedAt !== null || record.approval.revokedAt !== null
        || now >= record.approval.expiresAt || record.attempt) return fail('APPROVAL_REQUIRED');
      this.readBody(record);
      record.approval.usedAt = now; record.attempt = { id: randomUUID(), startedAt: now, dispatchedAt: null, endedAt: null, failureCode: null };
      record.status = 'RUNNING'; record.updatedAt = now; this.writeRecord(record); return this.snapshot(record);
    });
  }

  dispatch(id: string, attemptId: string, context: ReadonlyContext): CompanyRelayPayload {
    return this.operation(id, context, (record, now) => {
      this.runnable(record, attemptId, now);
      if (record.attempt!.dispatchedAt !== null) return fail('ALREADY_DISPATCHED');
      const body = this.readBody(record); if (!body) return fail();
      record.attempt!.dispatchedAt = now; record.updatedAt = now; this.writeRecord(record);
      return copyCompanyRelayData(body.payload);
    });
  }

  assertRunnable(id: string, attemptId: string, context: ReadonlyContext): void {
    this.operation(id, context, (record, now) => this.runnable(record, attemptId, now));
  }

  finish(id: string, attemptId: string, value: CompanyRelayReport | null, failureCode: string | null, context: ReadonlyContext): CompanyRelaySnapshot {
    if (!isReadonlyId(attemptId) || (value === null ? !failureCode || !failures.has(failureCode) : failureCode !== null)) return fail('INVALID_RESULT');
    return this.operation(id, context, (record, now) => {
      if (!record.attempt || record.attempt.id !== attemptId) return fail('INVALID_ATTEMPT');
      // Cancellation, expiry and recovery win over a late result. The attempt stays consumed.
      if (record.status !== 'RUNNING') {
        if (failureCode === 'COMPANY_RELAY_RECOVERY_UNCERTAIN' && record.attempt.endedAt === null
          && ['CANCELLED', 'EXPIRED'].includes(record.status)) this.blockUncertain(record, now);
        return this.snapshot(record);
      }
      this.runnable(record, attemptId, now);
      const body = this.readBody(record); if (!body) return fail();
      if (value) {
        const report = copyCompanyRelayData(value); assertCompanyRelayReport(record.plan, body.payload, report);
        if (record.attempt.dispatchedAt === null || report.createdAt < record.attempt.dispatchedAt || report.createdAt > now) return fail('INVALID_RESULT');
        const raw = canonicalReadonlyJson(report); if (Buffer.byteLength(raw) > reportBytes) return fail('OUTPUT_LIMIT');
        record.reportHash = hash(raw); record.status = 'REPORTED';
        this.database.prepare('UPDATE company_relay_payloads SET report_json = ? WHERE investigation_id = ?').run(raw, id);
      } else {
        record.status = failureCode === 'COMPANY_RELAY_RECOVERY_UNCERTAIN' ? 'BLOCKED' : 'FAILED';
        this.removeBody(id);
      }
      record.attempt.endedAt = failureCode === 'COMPANY_RELAY_RECOVERY_UNCERTAIN' ? null : now;
      record.attempt.failureCode = failureCode; record.updatedAt = now; this.writeRecord(record); return this.snapshot(record);
    });
  }

  cancel(id: string, context: ReadonlyContext): CompanyRelaySnapshot {
    return this.operation(id, context, (record, now) => {
      if (!['CANCELLED', 'EXPIRED', 'BLOCKED'].includes(record.status)) {
        record.status = 'CANCELLED'; record.updatedAt = now;
        if (record.approval) record.approval.revokedAt = now;
        this.removeBody(id); this.writeRecord(record);
      }
      return this.snapshot(record);
    });
  }

  recover(id: string, context: ReadonlyContext): CompanyRelaySnapshot {
    return this.operation(id, context, (record, now) => {
      if (record.status === 'RUNNING' || ['CANCELLED', 'EXPIRED'].includes(record.status) && record.attempt && record.attempt.endedAt === null) this.blockUncertain(record, now);
      return this.snapshot(record);
    });
  }

  prune(context: ReadonlyContext): CompanyRelayPruneResult {
    try { return this.maintain(context, contextTime(context)); } catch (error) { throw safeError(error); }
  }

  close(): void {
    if (this.closed) return;
    try { this.database.close(); this.closed = true; } catch (error) { throw safeError(error, 'INVALID_STORE'); }
  }

  private assertRequest(request: CompanyRelayRequest): void {
    if (!readonlyExactKeys(request, ['investigationId', 'planHash']) || !isReadonlyId(request.investigationId) || !digest(request.planHash)) fail('INVALID_REQUEST');
  }

  private assertPlanHash(record: RecordState, expected: string): void { if (record.plan.planHash !== expected) fail('PLAN_MISMATCH'); }

  private blockUncertain(record: RecordState, now: string): void {
    if (!record.attempt) return fail('INVALID_ATTEMPT');
    record.status = 'BLOCKED'; record.updatedAt = now; record.attempt.failureCode = 'COMPANY_RELAY_RECOVERY_UNCERTAIN';
    if (record.approval) record.approval.revokedAt ??= now;
    this.removeBody(record.plan.id); this.writeRecord(record);
  }

  private runnable(record: RecordState, attemptId: string, now: string): void {
    if (!isReadonlyId(attemptId) || record.status !== 'RUNNING' || !record.attempt || record.attempt.id !== attemptId
      || record.attempt.endedAt !== null || !record.approval || record.approval.usedAt === null || record.approval.revokedAt !== null
      || now >= record.approval.expiresAt || now >= record.plan.expiresAt) fail('NOT_RUNNABLE');
  }

  private operation<T>(id: string, context: ReadonlyContext, action: (record: RecordState, now: string) => T): T {
    try {
      if (!isReadonlyId(id)) return fail('INVALID_ID');
      const now = contextTime(context); this.maintain(context, now);
      return this.transaction(() => action(this.owned(id, context, now), now));
    } catch (error) { throw safeError(error); }
  }

  private owned(id: string, context: ReadonlyContext, now: string): RecordState {
    const record = this.readRecord(id); if (!record) return fail('NOT_FOUND');
    if (record.plan.ownerId !== context.ownerId) return fail('OWNER_MISMATCH');
    if (now < record.updatedAt) return fail('TIME_REVERSED');
    return record;
  }

  private readRecord(id: string, database = this.database): RecordState | null {
    const row = database.prepare(`SELECT investigation_id, preparation_key, status, updated_at, plan_json, approval_json, attempt_json,
      payload_hash, report_hash, record_hash FROM company_relay_records WHERE investigation_id = ?`).get(id);
    if (!row) return null;
    const plan = decode<CompanyRelayPlan>(row.plan_json, planBytes);
    try { assertCompanyRelayPlan(plan); } catch { return fail(); }
    if (row.investigation_id !== plan.id || plan.id !== id || row.preparation_key !== plan.preparationKey
      || plan.ownerId !== `os-user:${process.getuid!()}` || !statuses.includes(row.status as CompanyRelayStatus)
      || !timestamp(row.updated_at) || row.updated_at < plan.createdAt || !digest(row.payload_hash)
      || row.report_hash !== null && !digest(row.report_hash) || !digest(row.record_hash)) return fail();
    const record: RecordState = { plan, status: row.status as CompanyRelayStatus, updatedAt: row.updated_at,
      approval: decode(row.approval_json, 4096), attempt: decode(row.attempt_json, 4096), payloadHash: row.payload_hash, reportHash: row.report_hash as string | null };
    this.assertState(record);
    if (recordHash(record) !== row.record_hash) return fail();
    return record;
  }

  private assertState(record: RecordState): void {
    const { plan, approval, attempt, status, updatedAt } = record;
    if (approval !== null) {
      if (!readonlyExactKeys(approval, ['id', 'investigationId', 'ownerId', 'planHash', 'createdAt', 'expiresAt', 'usedAt', 'revokedAt', 'mode', 'transmissionAllowed', 'executionAllowed'])
        || !isReadonlyId(approval.id) || approval.investigationId !== plan.id || approval.ownerId !== plan.ownerId || approval.planHash !== plan.planHash
        || !timestamp(approval.createdAt) || !timestamp(approval.expiresAt) || approval.createdAt < plan.createdAt || approval.createdAt > updatedAt
        || approval.expiresAt <= approval.createdAt || approval.expiresAt > plan.expiresAt || Date.parse(approval.expiresAt) - Date.parse(approval.createdAt) > 3_600_000
        || approval.mode !== 'live' || approval.transmissionAllowed !== true || approval.executionAllowed !== false
        || [approval.usedAt, approval.revokedAt].some(value => value !== null && (!timestamp(value) || value < approval.createdAt || value > updatedAt))
        || approval.usedAt !== null && (approval.usedAt >= approval.expiresAt || approval.revokedAt !== null && approval.revokedAt < approval.usedAt)) return fail();
    }
    if (attempt !== null) {
      if (!readonlyExactKeys(attempt, ['id', 'startedAt', 'dispatchedAt', 'endedAt', 'failureCode']) || !isReadonlyId(attempt.id)
        || !approval || approval.usedAt !== attempt.startedAt || !timestamp(attempt.startedAt) || attempt.startedAt > updatedAt
        || [attempt.dispatchedAt, attempt.endedAt].some(value => value !== null && (!timestamp(value) || value < attempt.startedAt || value > updatedAt))
        || attempt.dispatchedAt !== null && attempt.dispatchedAt >= approval.expiresAt
        || attempt.dispatchedAt !== null && attempt.endedAt !== null && attempt.endedAt < attempt.dispatchedAt
        || attempt.failureCode !== null && !failures.has(attempt.failureCode)) return fail();
    } else if (approval?.usedAt !== null && approval?.usedAt !== undefined) return fail();
    if (status === 'AWAITING_APPROVAL' && (approval || attempt || record.reportHash)
      || status === 'APPROVED' && (!approval || approval.usedAt || approval.revokedAt || attempt || record.reportHash)
      || status === 'RUNNING' && (!approval || approval.revokedAt || !attempt || attempt.endedAt || attempt.failureCode || record.reportHash)
      || status === 'REPORTED' && (!approval || approval.revokedAt || !attempt?.dispatchedAt || !attempt.endedAt || attempt.failureCode || !record.reportHash)
      || status === 'FAILED' && (!attempt?.endedAt || !attempt.failureCode || record.reportHash)
      || status === 'BLOCKED' && (!attempt || attempt.failureCode !== 'COMPANY_RELAY_RECOVERY_UNCERTAIN' || record.reportHash)
      || status === 'CANCELLED' && approval && !approval.revokedAt) return fail();
    const approvalExpiry = approval && !record.reportHash && approval.expiresAt < plan.expiresAt ? approval.expiresAt : plan.expiresAt;
    if (status === 'EXPIRED' && (updatedAt !== approvalExpiry || approval && approval.revokedAt !== approvalExpiry)
      || hasBody(status) && updatedAt >= plan.expiresAt
      || ['APPROVED', 'RUNNING', 'REPORTED'].includes(status) && approval && updatedAt >= approval.expiresAt
      || ['REPORTED', 'FAILED'].includes(status) && attempt?.endedAt !== updatedAt) return fail();
  }

  private readBody(record: RecordState, database = this.database): { payload: CompanyRelayPayload; report: CompanyRelayReport | null } | null {
    const row = database.prepare('SELECT expires_at, payload_json, report_json FROM company_relay_payloads WHERE investigation_id = ?').get(record.plan.id);
    if (!hasBody(record.status)) { if (row) return fail(); return null; }
    if (!row || row.expires_at !== record.plan.expiresAt || typeof row.payload_json !== 'string' || hash(row.payload_json) !== record.payloadHash) return fail();
    const payload = decode<CompanyRelayPayload>(row.payload_json, payloadBytes);
    try { validateCompanyRelayPayload(record.plan, payload); } catch { return fail(); }
    if (record.status !== 'REPORTED') { if (row.report_json !== null) return fail(); return { payload, report: null }; }
    if (typeof row.report_json !== 'string' || hash(row.report_json) !== record.reportHash) return fail();
    const report = decode<CompanyRelayReport>(row.report_json, reportBytes);
    try { assertCompanyRelayReport(record.plan, payload, report); } catch { return fail(); }
    if (!record.attempt?.dispatchedAt || report.createdAt < record.attempt.dispatchedAt || report.createdAt > record.updatedAt) return fail();
    return { payload, report };
  }

  private snapshot(record: RecordState): CompanyRelaySnapshot {
    const body = this.readBody(record);
    return copyCompanyRelayData({ plan: record.plan, status: record.status, updatedAt: record.updatedAt,
      payload: body?.payload ?? null, approval: record.approval, attempt: record.attempt, report: body?.report ?? null });
  }

  private writeRecord(record: RecordState): void {
    this.assertState(record);
    if (this.database.prepare(`UPDATE company_relay_records SET status = ?, updated_at = ?, approval_json = ?, attempt_json = ?,
      report_hash = ?, record_hash = ? WHERE investigation_id = ?`).run(record.status, record.updatedAt, canonicalReadonlyJson(record.approval),
      canonicalReadonlyJson(record.attempt), record.reportHash, recordHash(record), record.plan.id).changes !== 1) fail();
  }

  private removeBody(id: string): void { this.database.prepare('DELETE FROM company_relay_payloads WHERE investigation_id = ?').run(id); }

  private maintain(context: ReadonlyContext, now: string): CompanyRelayPruneResult {
    return this.transaction(() => {
      const result = { payloads: 0, reports: 0, records: 0 };
      this.forEachRecord(this.database, id => {
        const record = this.owned(id, context, now), body = this.readBody(record);
        const approvalExpiry = ['APPROVED', 'RUNNING'].includes(record.status) ? record.approval!.expiresAt : record.plan.expiresAt;
        const expiry = approvalExpiry < record.plan.expiresAt ? approvalExpiry : record.plan.expiresAt;
        if (now >= record.plan.auditExpiresAt) {
          result.payloads += body ? 1 : 0; result.reports += body?.report ? 1 : 0; this.removeBody(id);
          this.database.prepare('DELETE FROM company_relay_records WHERE investigation_id = ?').run(id); result.records++;
        } else if (now >= expiry && hasBody(record.status)) {
          result.payloads += body ? 1 : 0; result.reports += body?.report ? 1 : 0; this.removeBody(id);
          record.status = 'EXPIRED'; record.updatedAt = expiry;
          if (record.approval) record.approval.revokedAt ??= expiry;
          this.writeRecord(record);
        }
      });
      return result;
    });
  }

  private forEachRecord(database: DatabaseSync, visit: (id: string) => void): void {
    let lastId: string | null = null;
    for (;;) {
      const rows: Record<string, SQLOutputValue>[] = database.prepare(`SELECT investigation_id FROM company_relay_records
        WHERE (? IS NULL OR investigation_id > ?) ORDER BY investigation_id LIMIT 100`).all(lastId, lastId);
      if (!rows.length) return;
      for (const row of rows) {
        const id = row.investigation_id;
        if (!isReadonlyId(id)) return fail();
        lastId = id; visit(id);
      }
    }
  }

  private validateRecords(database: DatabaseSync): void {
    this.forEachRecord(database, id => { const record = this.readRecord(id, database); if (!record) return fail(); this.readBody(record, database); });
  }

  private assertSchema(database: DatabaseSync): void {
    if (database.prepare('PRAGMA application_id').get()?.application_id !== applicationId || database.prepare('PRAGMA user_version').get()?.user_version !== 1
      || database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') return fail('INVALID_STORE');
    const tables: Record<string, string> = { company_relay_store: metadataTable, company_relay_records: recordsTable, company_relay_payloads: payloadsTable };
    const indexes = new Map([['sqlite_autoindex_company_relay_records_1', 'company_relay_records'],
      ['sqlite_autoindex_company_relay_records_2', 'company_relay_records'], ['sqlite_autoindex_company_relay_payloads_1', 'company_relay_payloads']]);
    const rows = database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
    if (rows.length !== 6) return fail('INVALID_STORE');
    for (const row of rows) {
      if (row.type === 'table' && typeof row.name === 'string' && Object.hasOwn(tables, row.name) && row.tbl_name === row.name
        && typeof row.sql === 'string' && normalizedSql(row.sql) === normalizedSql(tables[row.name]!)) continue;
      if (row.type === 'index' && typeof row.name === 'string' && indexes.get(row.name) === row.tbl_name && row.sql === null) continue;
      return fail('INVALID_STORE');
    }
    const binding = database.prepare('SELECT singleton, location_hash, owner_id FROM company_relay_store LIMIT 2').all();
    if (binding.length !== 1 || binding[0]!.singleton !== 1 || binding[0]!.location_hash !== hash(this.filePath)
      || binding[0]!.owner_id !== `os-user:${process.getuid!()}` || database.prepare('PRAGMA foreign_key_check').get()) fail('INVALID_STORE');
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
      const path = this.filePath + suffix; assertRuntimeFile(path); const file = runtimePathMetadata(path);
      if (file && (file.uid !== uid || (file.mode & 0o7777) !== 0o600)) throw new HarnessError('UNSAFE_RUNTIME_FILE');
      if (suffix === '' && (required && !file || file && this.fileIdentity && !sameIdentity(this.fileIdentity, file))) throw new HarnessError('UNSAFE_RUNTIME_FILE');
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.closed) return fail('STORE_CLOSED');
    if (this.transactionOpen) return fail('TRANSACTION_IN_PROGRESS');
    this.protectFiles(); this.database.exec('BEGIN IMMEDIATE'); this.transactionOpen = true;
    try {
      this.assertSchema(this.database); this.validateRecords(this.database);
      const result = operation(); this.protectFiles(); this.database.exec('COMMIT'); this.transactionOpen = false;
      this.protectFiles(); return result;
    } catch (error) {
      if (this.transactionOpen) { try { this.database.exec('ROLLBACK'); } catch { /* Do not expose raw SQLite errors. */ } }
      throw safeError(error);
    } finally { this.transactionOpen = false; }
  }
}
