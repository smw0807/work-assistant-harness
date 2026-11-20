import { randomUUID } from 'node:crypto';
import fs, { constants, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync, type DatabaseSyncOptions, type SQLInputValue } from 'node:sqlite';
import { types } from 'node:util';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyReport } from '../domain/readonly-investigation.js';
import { canonicalReadonlyJson, hashReadonlyValue, isReadonlyId, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';
import { isRepositoryPath } from '../policy/read-policy.js';
import { containsSensitiveText } from '../policy/redaction.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

export const SLACK_ANALYSIS_FAILURE_CODES = ['SLACK_ANALYSIS_FAILED', 'SLACK_ANALYSIS_BLOCKED', 'SLACK_ANALYSIS_INVALIDATED',
  'SLACK_ANALYSIS_INTERRUPTED', 'SLACK_ANALYSIS_EXPIRED', 'SLACK_ANALYSIS_INCOMPLETE_THREAD', 'SLACK_ANALYSIS_SOURCE_CHANGED',
  'SLACK_ANALYSIS_CONNECTION_GAP', 'SLACK_ANALYSIS_INVALID_INPUT', 'SLACK_ANALYSIS_MODEL_FAILED', 'SLACK_ANALYSIS_INVALID_RESPONSE',
  'SLACK_ANALYSIS_CANCELLED', 'SLACK_ANALYSIS_SCOPE_CHANGED'] as const;
export type SlackAnalysisFailureCode = typeof SLACK_ANALYSIS_FAILURE_CODES[number];
export type SlackAnalysisStatus = 'RUNNING' | 'REPORTED' | 'FAILED' | 'INVALIDATED' | 'INTERRUPTED' | 'BLOCKED';
export interface SlackAnalysisBeginInput {
  workspaceId: string; channelId: string; messageTs: string; revision: string;
  sourceHash: string; policyHash: string; scopeHash: string; expiresAt: string;
}
export interface SlackAnalysisRecord extends SlackAnalysisBeginInput {
  requestKey: string; runId: string; status: SlackAnalysisStatus; startedAt: string; finishedAt: string | null;
  failureCode: SlackAnalysisFailureCode | null; responseHash: string | null; reportHash: string | null; report: ReadonlyReport | null;
}
export type SlackAnalysisBeginResult = { kind: 'started' | 'duplicate'; record: SlackAnalysisRecord }
  | { kind: 'daily_limit'; record: null };
export type SlackAnalysisFinishInput = { status: 'REPORTED'; report: ReadonlyReport; responseHash: string }
  | { status: 'FAILED' | 'BLOCKED'; failureCode: SlackAnalysisFailureCode };
type Metadata = Omit<SlackAnalysisRecord, 'report'>;
type Row = Record<string, unknown>;

const reportBytes = 16_384, lifetimeMs = 86_400_000, dailyLimit = 20;
const applicationId = 0x53414e31;
const metaSchema = `CREATE TABLE slack_analysis_store (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner_id TEXT NOT NULL, location_hash TEXT NOT NULL,
  last_seen_at TEXT, metadata_hash TEXT NOT NULL
) STRICT`;
const recordsSchema = `CREATE TABLE slack_analysis_runs (
  request_key TEXT PRIMARY KEY, dedup_key TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_ts TEXT NOT NULL, revision TEXT NOT NULL,
  started_day TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL, metadata_json TEXT NOT NULL,
  metadata_hash TEXT NOT NULL, report_present INTEGER NOT NULL CHECK(report_present IN (0, 1)), report_json TEXT,
  UNIQUE(workspace_id, channel_id, message_ts, revision)
) STRICT`;
const columns = 'request_key, dedup_key, run_id, workspace_id, channel_id, message_ts, revision, started_day, expires_at, status, metadata_json, metadata_hash, report_present';
const options: DatabaseSyncOptions = { allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false,
  enableForeignKeyConstraints: true, timeout: 100, limits: { length: 65_536, sqlLength: 16_384, attach: 0 } };
const fail: (suffix: string) => never = suffix => { throw new HarnessError(`SLACK_ANALYSIS_${suffix}`); };
const hash = (value: unknown): string => hashReadonlyValue(canonicalReadonlyJson(value));
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const isId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value) && !containsSensitiveText(value);
const isTs = (value: unknown): value is string => typeof value === 'string' && /^\d{1,20}\.\d{1,10}$/u.test(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nowIso = (now: Date): string => {
  if (!now || types.isProxy(now) || Object.getPrototypeOf(now) !== Date.prototype) fail('INVALID_TIME');
  let value: string;
  try { value = Date.prototype.toISOString.call(now); } catch { return fail('INVALID_TIME'); }
  if (!isTime(value)) fail('INVALID_TIME'); return value;
};
const sameIdentity = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
const normalizeTs = (value: string): string => { const [seconds, fraction] = value.split('.'); return `${BigInt(seconds!)}.${fraction!.padEnd(10, '0')}`; };
const dedup = (input: SlackAnalysisBeginInput): string => hash([input.workspaceId, input.channelId, normalizeTs(input.messageTs), normalizeTs(input.revision)]);
const requestKey = (input: SlackAnalysisBeginInput): string => hash([input.workspaceId, input.channelId, input.messageTs, input.revision, input.sourceHash]);

/** Check data descriptors before serialization so supplied getters or proxies cannot run inside a transaction. */
const safeJson = (input: unknown): string => {
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 16) fail('INVALID_INPUT');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { if (value.length > reportBytes || Buffer.from(value).toString('utf8') !== value) fail('INVALID_INPUT'); return; }
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || types.isProxy(value)) fail('INVALID_INPUT');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) fail('INVALID_INPUT');
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== (value as unknown[]).length + 1 || keys.length > 4096) fail('INVALID_INPUT');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT');
      visit(descriptor.value, depth + 1);
    }
  };
  visit(input, 0);
  return canonicalReadonlyJson(input);
};
const assertInput: (input: unknown) => asserts input is SlackAnalysisBeginInput = input => {
  safeJson(input);
  if (!readonlyExactKeys(input, ['workspaceId', 'channelId', 'messageTs', 'revision', 'sourceHash', 'policyHash', 'scopeHash', 'expiresAt'])) fail('INVALID_INPUT');
  const value = input as unknown as SlackAnalysisBeginInput;
  if (!isId(value.workspaceId) || !isId(value.channelId) || !isTs(value.messageTs) || !isTs(value.revision)
    || !isHash(value.sourceHash) || !isHash(value.policyHash) || !isHash(value.scopeHash) || !isTime(value.expiresAt)) fail('INVALID_INPUT');
};
const checkedReport = (input: unknown): { text: string; report: ReadonlyReport } => {
  const text = safeJson(input);
  if (Buffer.byteLength(text) > reportBytes || containsSensitiveText(text)) fail('INVALID_REPORT');
  const value = JSON.parse(text) as ReadonlyReport;
  const string = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 4096
    && ![...item].some(character => { const code = character.charCodeAt(0); return code < 32 && ![9, 10, 13].includes(code) || code === 127; });
  const references = (items: unknown, required: boolean): boolean => Array.isArray(items) && items.length <= 16 && (!required || items.length > 0)
    && items.every(item => readonlyExactKeys(item, ['evidenceId', 'startLine', 'endLine'])
      && typeof item.evidenceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(item.evidenceId)
      && Number.isSafeInteger(item.startLine) && Number.isSafeInteger(item.endLine) && item.startLine >= 1 && item.endLine >= item.startLine);
  const statements = (items: unknown, required: boolean): boolean => Array.isArray(items) && items.length <= 32
    && items.every(item => readonlyExactKeys(item, ['text', 'references']) && string(item.text) && references(item.references, required));
  if (!readonlyExactKeys(value, ['classification', 'summary', 'facts', 'hypotheses', 'answerDraft', 'questions', 'suggestions', 'limitations'])
    || !['question', 'change-request', 'insufficient-evidence'].includes(value.classification) || !string(value.summary) || !string(value.answerDraft)
    || !statements(value.facts, true) || !statements(value.hypotheses, false)
    || !Array.isArray(value.questions) || value.questions.length > 32 || !value.questions.every(string)
    || !Array.isArray(value.limitations) || value.limitations.length < 1 || value.limitations.length > 32 || !value.limitations.every(string)
    || !Array.isArray(value.suggestions) || value.suggestions.length > 16 || !value.suggestions.every(item => readonlyExactKeys(item, ['path', 'description', 'references'])
      && typeof item.path === 'string' && isRepositoryPath(item.path) && string(item.description) && references(item.references, true))
    || value.facts.length === 0 && value.classification !== 'insufficient-evidence') fail('INVALID_REPORT');
  return { text, report: value };
};
const metadataKeys = ['workspaceId', 'channelId', 'messageTs', 'revision', 'sourceHash', 'policyHash', 'scopeHash', 'expiresAt',
  'requestKey', 'runId', 'status', 'startedAt', 'finishedAt', 'failureCode', 'responseHash', 'reportHash'];
const validateMetadata = (row: Row): Metadata => {
  if (typeof row.metadata_json !== 'string' || Buffer.byteLength(row.metadata_json) > 8192 || !isHash(row.metadata_hash)) fail('INVALID_STORAGE');
  let value: Metadata;
  try { value = JSON.parse(row.metadata_json) as Metadata; } catch { return fail('INVALID_STORAGE'); }
  if (!readonlyExactKeys(value, metadataKeys) || row.metadata_json !== safeJson(value)
    || ![0, 1].includes(row.report_present as number) || hash([value, row.report_present]) !== row.metadata_hash) fail('INVALID_STORAGE');
  assertInput(Object.fromEntries(['workspaceId', 'channelId', 'messageTs', 'revision', 'sourceHash', 'policyHash', 'scopeHash', 'expiresAt']
    .map(key => [key, value[key as keyof Metadata]])));
  if (!isReadonlyId(value.runId) || value.requestKey !== requestKey(value) || !isTime(value.startedAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.startedAt) || Date.parse(value.expiresAt) - Date.parse(value.startedAt) > lifetimeMs
    || !['RUNNING', 'REPORTED', 'FAILED', 'INVALIDATED', 'INTERRUPTED', 'BLOCKED'].includes(value.status)
    || value.finishedAt !== null && (!isTime(value.finishedAt) || value.finishedAt < value.startedAt)
    || value.failureCode !== null && !SLACK_ANALYSIS_FAILURE_CODES.includes(value.failureCode)
    || value.responseHash !== null && !isHash(value.responseHash) || value.reportHash !== null && !isHash(value.reportHash)
    || (value.responseHash === null) !== (value.reportHash === null) || row.report_present === 1 && value.status !== 'REPORTED'
    || value.status === 'RUNNING' && (value.finishedAt !== null || value.failureCode !== null || value.responseHash !== null || value.reportHash !== null)
    || value.status !== 'RUNNING' && value.finishedAt === null
    || value.status === 'REPORTED' && (value.failureCode !== null || value.responseHash === null || value.reportHash === null)
    || !['RUNNING', 'REPORTED'].includes(value.status) && value.failureCode === null
    || row.request_key !== value.requestKey || row.dedup_key !== dedup(value) || row.run_id !== value.runId
    || row.workspace_id !== value.workspaceId || row.channel_id !== value.channelId || row.message_ts !== value.messageTs || row.revision !== value.revision
    || row.started_day !== value.startedAt.slice(0, 10) || row.expires_at !== value.expiresAt || row.status !== value.status) fail('INVALID_STORAGE');
  return value;
};
const safeError = (error: unknown): HarnessError => {
  if (error instanceof HarnessError && /^SLACK_ANALYSIS_[A-Z_]+$/u.test(error.code)) return error;
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'errcode')?.value : undefined;
  return new HarnessError(`SLACK_ANALYSIS_${typeof code === 'number' && [5, 6].includes(code & 0xff) ? 'BUSY' : 'INVALID_STORAGE'}`);
};

/** Independent local ledger. The parent holds its runtime lease; this adapter never connects to Slack or a model. */
export class SqliteSlackAnalysisStore {
  private readonly database: DatabaseSync;
  private readonly parents: { path: string; metadata: Stats }[] = [];
  private fileIdentity!: Stats;
  private readonly sidecars = new Map<string, Stats>();
  private readonly owner = `os-user:${process.getuid?.()}`;
  private readonly location: string;
  private closed = false;

  constructor(private readonly path: string) {
    this.location = hashReadonlyValue(path);
    let database: DatabaseSync | undefined;
    try {
      if (!isAbsolute(path) || resolve(path) !== path || basename(path) !== 'slack-analysis.sqlite' || process.getuid?.() === undefined) fail('UNSAFE_PATH');
      for (let current = dirname(path); ; current = dirname(current)) {
        const metadata = fs.lstatSync(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || fs.realpathSync(current) !== current
          || current === dirname(path) && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== 0o700)) fail('UNSAFE_PATH');
        this.parents.push({ path: current, metadata }); if (current === dirname(current)) break;
      }
      this.protect(false); const existing = runtimePathMetadata(path);
      if (existing) {
        this.fileIdentity = existing; const readonly = new DatabaseSync(path, { ...options, readOnly: true });
        try { this.validate(readonly); } finally { readonly.close(); }
      } else {
        if (['-journal', '-wal', '-shm'].some(suffix => runtimePathMetadata(path + suffix))) fail('UNSAFE_PATH');
        fs.closeSync(fs.openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
        this.fileIdentity = fs.lstatSync(path);
      }
      this.protect(true); database = new DatabaseSync(path, options);
      database.exec('PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF');
      if (!existing) {
        database.exec('BEGIN IMMEDIATE');
        try {
          database.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1; ${metaSchema}; ${recordsSchema};`);
          database.prepare('INSERT INTO slack_analysis_store VALUES (1, ?, ?, NULL, ?)').run(this.owner, this.location, hash([this.owner, this.location, null]));
          this.protect(true); database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
      }
      this.validate(database); this.database = database;
    } catch (error) { try { database?.close(); } catch { /* Keep the fixed original error. */ } throw safeError(error); }
  }

  begin(input: SlackAnalysisBeginInput, now: Date): SlackAnalysisBeginResult {
    try {
      assertInput(input); input = JSON.parse(safeJson(input)) as SlackAnalysisBeginInput;
      const at = nowIso(now);
      if (input.expiresAt <= at || Date.parse(input.expiresAt) - Date.parse(at) > lifetimeMs) fail('INVALID_TIME');
      return this.transaction(at, () => {
        const previous = this.database.prepare(`SELECT ${columns} FROM slack_analysis_runs WHERE dedup_key = ?`).get(dedup(input));
        if (previous) return { kind: 'duplicate', record: this.snapshot(validateMetadata(previous), at) };
        const count = this.database.prepare('SELECT COUNT(*) AS total FROM slack_analysis_runs WHERE started_day = ?').get(at.slice(0, 10));
        if (Number(count?.total) >= dailyLimit) return { kind: 'daily_limit', record: null };
        const record: Metadata = { ...input, requestKey: requestKey(input), runId: randomUUID(), status: 'RUNNING', startedAt: at,
          finishedAt: null, failureCode: null, responseHash: null, reportHash: null };
        this.database.prepare(`INSERT INTO slack_analysis_runs (${columns}, report_json) VALUES (${Array(13).fill('?').join(', ')}, NULL)`)
          .run(...this.values(record));
        return { kind: 'started', record: { ...record, report: null } };
      });
    } catch (error) { throw safeError(error); }
  }

  finish(runId: string, input: SlackAnalysisFinishInput, now: Date): SlackAnalysisRecord {
    try {
      if (!isReadonlyId(runId)) fail('INVALID_INPUT'); safeJson(input);
      const at = nowIso(now);
      let report: ReturnType<typeof checkedReport> | null = null;
      if (input.status === 'REPORTED') {
        if (!readonlyExactKeys(input, ['status', 'report', 'responseHash']) || !isHash(input.responseHash)) fail('INVALID_INPUT');
        report = checkedReport(input.report);
      } else if (!readonlyExactKeys(input, ['status', 'failureCode']) || !['FAILED', 'BLOCKED'].includes(input.status)
        || !SLACK_ANALYSIS_FAILURE_CODES.includes(input.failureCode)) fail('INVALID_INPUT');
      return this.transaction(at, () => {
        const record = this.required(runId);
        if (record.status !== 'RUNNING') fail('ALREADY_FINISHED');
        record.finishedAt = at;
        if (input.status === 'REPORTED' && at >= record.expiresAt) {
          record.status = 'BLOCKED'; record.failureCode = 'SLACK_ANALYSIS_EXPIRED'; this.write(record, null);
        } else if (input.status === 'REPORTED') {
          record.status = 'REPORTED'; record.responseHash = input.responseHash; record.reportHash = hashReadonlyValue(report!.text);
          this.write(record, report!.text);
        } else {
          record.status = input.status; record.failureCode = input.failureCode; this.write(record, null);
        }
        return this.snapshot(record, at);
      });
    } catch (error) { throw safeError(error); }
  }

  invalidate(runId: string, now: Date): SlackAnalysisRecord {
    if (!isReadonlyId(runId)) fail('INVALID_INPUT'); const at = nowIso(now);
    return this.transaction(at, () => {
      const record = this.required(runId);
      record.status = 'INVALIDATED'; record.finishedAt ??= at; record.failureCode = 'SLACK_ANALYSIS_INVALIDATED';
      this.write(record, null); return { ...record, report: null };
    });
  }

  recover(now: Date): number {
    const at = nowIso(now);
    return this.transaction(at, () => {
      const rows = this.database.prepare(`SELECT ${columns} FROM slack_analysis_runs WHERE status = 'RUNNING'`).all();
      for (const row of rows) {
        const record = validateMetadata(row); record.status = 'INTERRUPTED'; record.finishedAt = at;
        record.failureCode = 'SLACK_ANALYSIS_INTERRUPTED'; this.write(record, null);
      }
      return rows.length;
    });
  }

  prune(now: Date): number {
    const at = nowIso(now);
    return this.transaction(at, () => this.expireReports(at), false);
  }

  list(now: Date): SlackAnalysisRecord[] {
    const at = nowIso(now);
    return this.transaction(at, () => this.database.prepare(`SELECT ${columns} FROM slack_analysis_runs ORDER BY started_day DESC, rowid DESC LIMIT 100`)
      .all().map(row => this.snapshot(validateMetadata(row), at)));
  }

  find(runId: string, now: Date): SlackAnalysisRecord | null {
    if (!isReadonlyId(runId)) fail('INVALID_INPUT'); const at = nowIso(now);
    return this.transaction(at, () => {
      const row = this.database.prepare(`SELECT ${columns} FROM slack_analysis_runs WHERE run_id = ?`).get(runId);
      return row ? this.snapshot(validateMetadata(row), at) : null;
    });
  }

  close(): void { if (!this.closed) { this.database.close(); this.closed = true; } }

  private values(record: Metadata): SQLInputValue[] {
    return [record.requestKey, dedup(record), record.runId, record.workspaceId, record.channelId, record.messageTs, record.revision,
      record.startedAt.slice(0, 10), record.expiresAt, record.status, canonicalReadonlyJson(record), hash([record, 0]), 0];
  }
  private write(record: Metadata, report: string | null): void {
    const present = report === null ? 0 : 1;
    this.database.prepare('UPDATE slack_analysis_runs SET status = ?, metadata_json = ?, metadata_hash = ?, report_present = ?, report_json = ? WHERE run_id = ?')
      .run(record.status, canonicalReadonlyJson(record), hash([record, present]), present, report, record.runId);
  }
  private required(runId: string): Metadata {
    const row = this.database.prepare(`SELECT ${columns} FROM slack_analysis_runs WHERE run_id = ?`).get(runId);
    if (!row) fail('NOT_FOUND'); return validateMetadata(row);
  }
  private snapshot(record: Metadata, at: string): SlackAnalysisRecord {
    if (record.status !== 'REPORTED' || record.expiresAt <= at) return { ...record, report: null };
    const row = this.database.prepare('SELECT report_json FROM slack_analysis_runs WHERE run_id = ?').get(record.runId);
    if (typeof row?.report_json !== 'string' || Buffer.byteLength(row.report_json) > reportBytes
      || hashReadonlyValue(row.report_json) !== record.reportHash) fail('INVALID_STORAGE');
    const parsed = checkedReport(JSON.parse(row.report_json));
    if (parsed.text !== row.report_json) fail('INVALID_STORAGE'); return { ...record, report: parsed.report };
  }
  private transaction<T>(at: string, action: () => T, expire = true): T {
    if (this.closed) fail('STORE_CLOSED');
    let active = false;
    try {
      this.protect(true); this.database.exec('BEGIN IMMEDIATE'); active = true;
      const last = this.validate(this.database);
      if (last !== null && at < last) fail('TIME_REVERSED');
      if (expire) this.expireReports(at);
      const result = action();
      this.database.prepare('UPDATE slack_analysis_store SET last_seen_at = ?, metadata_hash = ? WHERE singleton = 1')
        .run(at, hash([this.owner, this.location, at]));
      this.protect(true); this.database.exec('COMMIT'); active = false; this.protect(true); return result;
    } catch (error) { if (active) { try { this.database.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } } throw safeError(error); }
  }
  private expireReports(at: string): number {
    const rows = this.database.prepare(`SELECT ${columns} FROM slack_analysis_runs WHERE expires_at <= ? AND report_present = 1`).all(at);
    for (const row of rows) this.write(validateMetadata(row), null);
    return rows.length;
  }
  private validate(database: DatabaseSync): string | null {
    if (database.prepare('PRAGMA application_id').get()?.application_id !== applicationId
      || database.prepare('PRAGMA user_version').get()?.user_version !== 1
      || database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') fail('INVALID_STORAGE');
    const objects = database.prepare("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    const expected = new Map([['slack_analysis_store', metaSchema], ['slack_analysis_runs', recordsSchema]]);
    if (objects.length !== expected.size || objects.some(row => typeof row.name !== 'string' || row.type !== 'table' || typeof row.sql !== 'string'
      || row.sql.replace(/\s+/gu, ' ').trim() !== expected.get(row.name)?.replace(/\s+/gu, ' ').trim())) fail('INVALID_STORAGE');
    const rows = database.prepare('SELECT singleton, owner_id, location_hash, last_seen_at, metadata_hash FROM slack_analysis_store LIMIT 2').all();
    const value = rows[0];
    if (rows.length !== 1 || value!.singleton !== 1 || value!.owner_id !== this.owner || value!.location_hash !== this.location
      || value!.last_seen_at !== null && !isTime(value!.last_seen_at)
      || value!.metadata_hash !== hash([this.owner, this.location, value!.last_seen_at])) fail('INVALID_STORAGE');
    // Constructor, recovery, and prune validate metadata only; expired report bytes are never parsed or hashed.
    for (const row of database.prepare(`SELECT ${columns} FROM slack_analysis_runs`).all()) {
      const record = validateMetadata(row);
      if (value!.last_seen_at === null || record.startedAt > String(value!.last_seen_at)
        || record.finishedAt !== null && record.finishedAt > String(value!.last_seen_at)) fail('INVALID_STORAGE');
    }
    return value!.last_seen_at as string | null;
  }
  private protect(required: boolean): void {
    for (const parent of this.parents) if (!sameIdentity(parent.metadata, fs.lstatSync(parent.path)) || fs.realpathSync(parent.path) !== parent.path) fail('UNSAFE_PATH');
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const file = this.path + suffix; assertRuntimeFile(file); const current = runtimePathMetadata(file);
      if (current && (current.uid !== process.getuid?.() || (current.mode & 0o7777) !== 0o600 || current.size > 128 * 1024 * 1024)) fail('UNSAFE_PATH');
      if (!suffix) {
        if (required && !current || current && this.fileIdentity && !sameIdentity(this.fileIdentity, current)) fail('UNSAFE_PATH');
      } else {
        const previous = this.sidecars.get(suffix);
        if (current && previous && !sameIdentity(previous, current)) fail('UNSAFE_PATH');
        if (current) this.sidecars.set(suffix, current); else this.sidecars.delete(suffix);
      }
    }
  }
}
