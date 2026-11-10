import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import {
  EXECUTION_POLICY_VERSION,
  type ExecutionApproval, type ExecutionApprovalContext, type ExecutionApprovalRequest,
  type ExecutionRun, type ExecutionRunRequest, type ExecutionTask,
} from '../domain/execution.js';
import type { ExecutionStore } from '../ports/execution.js';
import { assertExecutionPlan, sha256 } from '../policy/execution-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

const taskKeys = ['taskId', 'status', 'requestRevision', 'baseCommit', 'sourceRoot', 'createdAt', 'updatedAt', 'plan'];
const approvalKeys = [
  'approvalId', 'taskId', 'ownerId', 'planHash', 'baseCommit', 'requestRevision', 'executionPolicy',
  'planSnapshot', 'createdAt', 'expiresAt', 'usedAt', 'revokedAt',
];
const runKeys = [
  'runId', 'taskId', 'approvalId', 'status', 'startedAt', 'finishedAt', 'artifactDirectory', 'worktreeRoot',
  'failureCode', 'checks', 'commands', 'diff', 'sourceBeforeHash', 'sourceAfterHash',
];
const taskStatuses = ['AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED'];
const terminalStatuses = ['SUCCEEDED', 'FAILED', 'BLOCKED'];
const digest = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 16_384 && !value.includes('\0');
const isTimestamp = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hasKeys = (value: unknown, keys: string[]): boolean => Boolean(value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)));
const isDigestOrNull = (value: unknown): boolean => value === null || (typeof value === 'string' && digest.test(value));
const isPath = (value: unknown): value is string => isText(value) && isAbsolute(value);
const decode = <T>(payload: unknown, code: string): T => {
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > 1_048_576) throw new HarnessError(code);
  try { return JSON.parse(payload) as T; } catch { throw new HarnessError(code); }
};

const assertContext = (context: ExecutionApprovalContext): void => {
  if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) throw new HarnessError('INVALID_APPROVAL_TIME');
  if (typeof process.getuid !== 'function') throw new HarnessError('APPROVAL_OWNER_UNSUPPORTED');
  if (context.ownerId !== `os-user:${process.getuid()}`) throw new HarnessError('APPROVAL_OWNER_MISMATCH');
};

/** 승인 소비와 Run 생성은 외부 실행보다 먼저 하나의 SQLite 트랜잭션으로 확정한다. */
export class SqliteExecutionStore implements ExecutionStore {
  private readonly database: DatabaseSync;

  constructor(private readonly filePath: string) {
    this.protectFiles();
    this.database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    this.protectFiles();
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS execution_tasks (
        task_id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS execution_approvals (
        approval_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES execution_tasks(task_id),
        owner_id TEXT NOT NULL, used_at TEXT, revoked_at TEXT, payload TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS execution_approvals_one_active
        ON execution_approvals(task_id) WHERE used_at IS NULL AND revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS execution_runs (
        run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES execution_tasks(task_id),
        approval_id TEXT NOT NULL UNIQUE REFERENCES execution_approvals(approval_id),
        status TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
    `);
    this.protectFiles();
  }

  create(task: ExecutionTask): void {
    if (task.status !== 'AWAITING_APPROVAL') throw new HarnessError('APPROVAL_STATE_MANAGED');
    this.assertTask(task);
    this.transaction(() => {
      if (this.find(task.taskId)) throw new HarnessError('EXECUTION_TASK_ALREADY_EXISTS');
      this.database.prepare('INSERT INTO execution_tasks(task_id, status, payload) VALUES (?, ?, ?)')
        .run(task.taskId, task.status, JSON.stringify(task));
    });
  }

  find(taskId: string): ExecutionTask | null {
    this.protectFiles();
    const row = this.database.prepare('SELECT task_id, status, payload FROM execution_tasks WHERE task_id = ?').get(taskId);
    if (!row) return null;
    const task = decode<ExecutionTask>(row.payload, 'INVALID_STORED_EXECUTION_TASK');
    this.assertTask(task);
    if (row.task_id !== task.taskId || row.status !== task.status) throw new HarnessError('INVALID_STORED_EXECUTION_TASK');
    return task;
  }

  approve(request: ExecutionApprovalRequest, context: ExecutionApprovalContext): ExecutionApproval {
    assertContext(context);
    this.assertRequest(request);
    if (!Number.isSafeInteger(request.expiresInMinutes) || request.expiresInMinutes < 1 || request.expiresInMinutes > 1_440) {
      throw new HarnessError('INVALID_EXECUTION_APPROVAL_REQUEST');
    }
    return this.transaction(() => {
      let task = this.requireTask(request.taskId);
      const records = this.listApprovals(task.taskId);
      this.assertOwners(records, context.ownerId);
      task = this.expireApproval(task, records, context.now);
      if (records.some((approval) => approval.usedAt !== null) || this.listRuns(task.taskId).length > 0) {
        throw new HarnessError('APPROVAL_ALREADY_USED');
      }
      if (this.activeApproval(task.taskId)) throw new HarnessError('APPROVAL_ALREADY_EXISTS');
      if (task.status !== 'AWAITING_APPROVAL') throw new HarnessError('TASK_NOT_AWAITING_APPROVAL');
      this.assertRequestMatches(task, request);
      const approval: ExecutionApproval = {
        approvalId: randomUUID(), taskId: task.taskId, ownerId: context.ownerId,
        planHash: task.plan.planHash, baseCommit: task.baseCommit, requestRevision: task.requestRevision,
        executionPolicy: EXECUTION_POLICY_VERSION, planSnapshot: structuredClone(task.plan),
        createdAt: context.now.toISOString(),
        expiresAt: new Date(context.now.getTime() + request.expiresInMinutes * 60_000).toISOString(),
        usedAt: null, revokedAt: null,
      };
      this.assertApproval(approval);
      this.database.prepare(`INSERT INTO execution_approvals
        (approval_id, task_id, owner_id, used_at, revoked_at, payload) VALUES (?, ?, ?, NULL, NULL, ?)`)
        .run(approval.approvalId, approval.taskId, approval.ownerId, JSON.stringify(approval));
      this.writeTask({ ...task, status: 'APPROVED', updatedAt: context.now.toISOString() });
      return approval;
    });
  }

  listApprovals(taskId: string): ExecutionApproval[] {
    this.protectFiles();
    return this.database.prepare('SELECT * FROM execution_approvals WHERE task_id = ? ORDER BY rowid').all(taskId)
      .map((row) => this.parseApprovalRow(row));
  }

  listApprovalHistory(taskId: string, offset: number): {
    approvals: ExecutionApproval[]; approvalPage: { offset: number; total: number; nextOffset: number | null };
  } {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000_000) throw new HarnessError('INVALID_APPROVAL_OFFSET');
    this.protectFiles();
    const count = this.database.prepare('SELECT COUNT(*) AS total FROM execution_approvals WHERE task_id = ?').get(taskId);
    const total = Number(count?.total ?? 0);
    const approvals = this.database.prepare('SELECT * FROM execution_approvals WHERE task_id = ? ORDER BY rowid DESC LIMIT 1 OFFSET ?')
      .all(taskId, offset).map((row) => this.parseApprovalRow(row));
    const nextOffset = approvals.length > 0 && offset + approvals.length < total ? offset + approvals.length : null;
    return { approvals, approvalPage: { offset, total, nextOffset } };
  }

  beginRun(request: ExecutionRunRequest, context: ExecutionApprovalContext, artifactDirectory: string): ExecutionRun {
    assertContext(context);
    this.assertRequest(request);
    if (!isPath(artifactDirectory)) throw new HarnessError('INVALID_EXECUTION_ARTIFACT_PATH');
    const outcome = this.transaction((): ExecutionRun | HarnessError => {
      const task = this.requireTask(request.taskId);
      const records = this.listApprovals(task.taskId);
      this.assertOwners(records, context.ownerId);
      this.assertRequestMatches(task, request);
      if (records.some((approval) => approval.usedAt !== null) || this.listRuns(task.taskId).length > 0) {
        throw new HarnessError('APPROVAL_ALREADY_USED');
      }
      const approval = this.activeApproval(task.taskId);
      if (!approval) throw new HarnessError('APPROVAL_REQUIRED');
      if (context.now.getTime() >= Date.parse(approval.expiresAt)) {
        this.expireApproval(task, records, context.now);
        // 만료 무효화는 보존해야 하므로 예외 대신 값을 반환하고 commit 뒤 거부한다.
        return new HarnessError('APPROVAL_EXPIRED');
      }
      if (task.status !== 'APPROVED') throw new HarnessError('TASK_NOT_APPROVED');
      if (context.now.getTime() < Date.parse(approval.createdAt)) throw new HarnessError('INVALID_APPROVAL_TIME');
      if (approval.planHash !== task.plan.planHash || approval.baseCommit !== task.baseCommit
        || approval.requestRevision !== task.requestRevision || approval.taskId !== task.taskId
        || JSON.stringify(approval.planSnapshot) !== JSON.stringify(task.plan)) throw new HarnessError('APPROVAL_PLAN_MISMATCH');
      const startedAt = context.now.toISOString();
      const run: ExecutionRun = {
        runId: randomUUID(), taskId: task.taskId, approvalId: approval.approvalId, status: 'RUNNING',
        startedAt, finishedAt: null, artifactDirectory, worktreeRoot: null, failureCode: null,
        checks: [], commands: [], diff: [], sourceBeforeHash: null, sourceAfterHash: null,
      };
      const consumed = { ...approval, usedAt: startedAt };
      const updated = this.database.prepare(`UPDATE execution_approvals SET used_at = ?, payload = ?
        WHERE approval_id = ? AND used_at IS NULL AND revoked_at IS NULL`)
        .run(startedAt, JSON.stringify(consumed), approval.approvalId);
      if (updated.changes !== 1) throw new HarnessError('APPROVAL_ALREADY_USED');
      this.database.prepare('INSERT INTO execution_runs(run_id, task_id, approval_id, status, payload) VALUES (?, ?, ?, ?, ?)')
        .run(run.runId, run.taskId, run.approvalId, run.status, JSON.stringify(run));
      this.writeTask({ ...task, status: 'RUNNING', updatedAt: startedAt });
      return run;
    });
    if (outcome instanceof HarnessError) throw outcome;
    return outcome;
  }

  finishRun(run: ExecutionRun): void {
    this.assertRun(run);
    if (!terminalStatuses.includes(run.status)) throw new HarnessError('INVALID_EXECUTION_RUN_TRANSITION');
    this.transaction(() => {
      const current = this.findRun(run.runId);
      if (!current) throw new HarnessError('EXECUTION_RUN_NOT_FOUND');
      if (current.status !== 'RUNNING') throw new HarnessError('EXECUTION_RUN_ALREADY_FINISHED');
      if (['taskId', 'approvalId', 'startedAt', 'artifactDirectory'].some((key) =>
        current[key as keyof ExecutionRun] !== run[key as keyof ExecutionRun])) throw new HarnessError('EXECUTION_RUN_IDENTITY_MISMATCH');
      const task = this.requireTask(run.taskId);
      if (task.status !== 'RUNNING') throw new HarnessError('INVALID_EXECUTION_RUN_TRANSITION');
      this.database.prepare('UPDATE execution_runs SET status = ?, payload = ? WHERE run_id = ? AND status = ?')
        .run(run.status, JSON.stringify(run), run.runId, 'RUNNING');
      this.writeTask({ ...task, status: run.status, updatedAt: run.finishedAt as string });
    });
  }

  findRun(runId: string): ExecutionRun | null {
    this.protectFiles();
    const row = this.database.prepare('SELECT * FROM execution_runs WHERE run_id = ?').get(runId);
    return row ? this.parseRunRow(row) : null;
  }

  listRuns(taskId: string): ExecutionRun[] {
    this.protectFiles();
    return this.database.prepare('SELECT * FROM execution_runs WHERE task_id = ? ORDER BY rowid').all(taskId)
      .map((row) => this.parseRunRow(row));
  }

  close(): void { this.database.close(); }

  private assertTask(task: ExecutionTask): void {
    if (!hasKeys(task, taskKeys) || !isText(task.taskId) || !taskStatuses.includes(task.status)
      || !isText(task.requestRevision) || !commit.test(task.baseCommit) || !isPath(task.sourceRoot)
      || !isTimestamp(task.createdAt) || !isTimestamp(task.updatedAt) || task.updatedAt < task.createdAt) {
      throw new HarnessError('INVALID_EXECUTION_TASK');
    }
    assertExecutionPlan(task.plan);
    if (task.plan.taskId !== task.taskId || task.plan.requestRevision !== task.requestRevision
      || task.plan.baseCommit !== task.baseCommit) throw new HarnessError('EXECUTION_CONTEXT_MISMATCH');
  }

  private assertRequest(request: ExecutionRunRequest): void {
    if (!request || !isText(request.taskId) || typeof request.planHash !== 'string' || !digest.test(request.planHash)
      || typeof request.baseCommit !== 'string' || !commit.test(request.baseCommit)) {
      throw new HarnessError('INVALID_EXECUTION_APPROVAL_REQUEST');
    }
  }

  private assertRequestMatches(task: ExecutionTask, request: ExecutionRunRequest): void {
    if (request.planHash !== task.plan.planHash) throw new HarnessError('PLAN_HASH_MISMATCH');
    if (request.baseCommit !== task.baseCommit) throw new HarnessError('EXECUTION_CONTEXT_MISMATCH');
  }

  private assertApproval(approval: ExecutionApproval): void {
    if (!hasKeys(approval, approvalKeys) || !isText(approval.approvalId) || !isText(approval.taskId)
      || typeof approval.ownerId !== 'string' || !/^os-user:\d+$/.test(approval.ownerId)
      || !digest.test(approval.planHash) || !commit.test(approval.baseCommit) || !isText(approval.requestRevision)
      || approval.executionPolicy !== EXECUTION_POLICY_VERSION || !isTimestamp(approval.createdAt)
      || !isTimestamp(approval.expiresAt)
      || (approval.usedAt !== null && !isTimestamp(approval.usedAt))
      || (approval.revokedAt !== null && !isTimestamp(approval.revokedAt))) throw new HarnessError('INVALID_STORED_EXECUTION_APPROVAL');
    const ttl = (Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)) / 60_000;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 1_440
      || (approval.usedAt !== null && (approval.usedAt < approval.createdAt || approval.usedAt >= approval.expiresAt))
      || (approval.revokedAt !== null && approval.revokedAt < approval.createdAt)
      || (approval.usedAt !== null && approval.revokedAt !== null)) throw new HarnessError('INVALID_STORED_EXECUTION_APPROVAL');
    assertExecutionPlan(approval.planSnapshot);
    if (approval.planSnapshot.planHash !== approval.planHash || approval.planSnapshot.taskId !== approval.taskId
      || approval.planSnapshot.baseCommit !== approval.baseCommit || approval.planSnapshot.requestRevision !== approval.requestRevision) {
      throw new HarnessError('INVALID_STORED_EXECUTION_APPROVAL');
    }
  }

  private assertRun(run: ExecutionRun): void {
    if (!hasKeys(run, runKeys) || !isText(run.runId) || !isText(run.taskId) || !isText(run.approvalId)
      || !['RUNNING', ...terminalStatuses].includes(run.status) || !isTimestamp(run.startedAt)
      || !isPath(run.artifactDirectory) || (run.worktreeRoot !== null && !isPath(run.worktreeRoot))
      || (run.failureCode !== null && !isText(run.failureCode))
      || !isDigestOrNull(run.sourceBeforeHash) || !isDigestOrNull(run.sourceAfterHash)
      || !Array.isArray(run.checks) || run.checks.length > 64 || !Array.isArray(run.commands) || run.commands.length > 16
      || !Array.isArray(run.diff) || run.diff.length > 16
      || run.checks.some((check) => !hasKeys(check, ['name', 'status', 'reason']) || !isText(check.name)
        || !['passed', 'failed', 'not_run'].includes(check.status) || typeof check.reason !== 'string' || check.reason.length > 16_384)
      || (run.status === 'RUNNING' ? run.finishedAt !== null : !isTimestamp(run.finishedAt))
      || (run.finishedAt !== null && run.finishedAt < run.startedAt)) throw new HarnessError('INVALID_EXECUTION_RUN');
    for (const result of run.commands) {
      if (!hasKeys(result, [
        'commandId', 'containerName', 'termination', 'exitCode', 'stopped', 'removed', 'oomKilled',
        'outputBytes', 'outputHash', 'failureCode',
      ]) || !['synthetic-check-v1', 'synthetic-timeout-v1', 'synthetic-output-v1'].includes(result.commandId)
        || (result.containerName !== null && !isText(result.containerName))
        || !['completed', 'timeout', 'output_limit', 'aborted', 'failed'].includes(result.termination)
        || (result.exitCode !== null && (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0))
        || typeof result.stopped !== 'boolean' || typeof result.removed !== 'boolean' || typeof result.oomKilled !== 'boolean'
        || !Number.isSafeInteger(result.outputBytes) || result.outputBytes < 0 || !digest.test(result.outputHash)
        || (result.failureCode !== null && !isText(result.failureCode))) throw new HarnessError('INVALID_EXECUTION_RUN');
    }
    for (const diff of run.diff) {
      if (!hasKeys(diff, ['path', 'beforeHash', 'afterHash', 'before', 'after']) || !isText(diff.path)
        || !digest.test(diff.beforeHash) || !digest.test(diff.afterHash)
        || typeof diff.before !== 'string' || typeof diff.after !== 'string'
        || Buffer.byteLength(diff.before) > 65_536 || Buffer.byteLength(diff.after) > 65_536
        || sha256(diff.before) !== diff.beforeHash || sha256(diff.after) !== diff.afterHash) throw new HarnessError('INVALID_EXECUTION_RUN');
    }
    // 다시 읽을 수 없는 과대 감사 기록을 만들지 않도록 쓰기 전에도 한도를 확인한다.
    decode<ExecutionRun>(JSON.stringify(run), 'INVALID_EXECUTION_RUN');
  }

  private parseApprovalRow(row: Record<string, SQLOutputValue>): ExecutionApproval {
    const approval = decode<ExecutionApproval>(row.payload, 'INVALID_STORED_EXECUTION_APPROVAL');
    this.assertApproval(approval);
    if (row.approval_id !== approval.approvalId || row.task_id !== approval.taskId || row.owner_id !== approval.ownerId
      || row.used_at !== approval.usedAt || row.revoked_at !== approval.revokedAt) throw new HarnessError('INVALID_STORED_EXECUTION_APPROVAL');
    return approval;
  }

  private parseRunRow(row: Record<string, SQLOutputValue>): ExecutionRun {
    const run = decode<ExecutionRun>(row.payload, 'INVALID_STORED_EXECUTION_RUN');
    this.assertRun(run);
    if (row.run_id !== run.runId || row.task_id !== run.taskId || row.approval_id !== run.approvalId
      || row.status !== run.status) throw new HarnessError('INVALID_STORED_EXECUTION_RUN');
    return run;
  }

  private requireTask(taskId: string): ExecutionTask {
    const task = this.find(taskId);
    if (!task) throw new HarnessError('EXECUTION_TASK_NOT_FOUND');
    return task;
  }

  private assertOwners(records: ExecutionApproval[], ownerId: string): void {
    if (records.some((approval) => approval.ownerId !== ownerId)) throw new HarnessError('APPROVAL_OWNER_MISMATCH');
  }

  private activeApproval(taskId: string): ExecutionApproval | null {
    const row = this.database.prepare('SELECT * FROM execution_approvals WHERE task_id = ? AND used_at IS NULL AND revoked_at IS NULL').get(taskId);
    return row ? this.parseApprovalRow(row) : null;
  }

  private expireApproval(task: ExecutionTask, records: ExecutionApproval[], now: Date): ExecutionTask {
    let expired = false;
    for (const approval of records) {
      if (approval.usedAt !== null || approval.revokedAt !== null || now.getTime() < Date.parse(approval.expiresAt)) continue;
      const revoked = { ...approval, revokedAt: now.toISOString() };
      this.database.prepare('UPDATE execution_approvals SET revoked_at = ?, payload = ? WHERE approval_id = ? AND used_at IS NULL AND revoked_at IS NULL')
        .run(revoked.revokedAt, JSON.stringify(revoked), approval.approvalId);
      expired = true;
    }
    if (!expired || task.status !== 'APPROVED') return task;
    const awaiting: ExecutionTask = { ...task, status: 'AWAITING_APPROVAL', updatedAt: now.toISOString() };
    this.writeTask(awaiting);
    return awaiting;
  }

  private writeTask(task: ExecutionTask): void {
    this.assertTask(task);
    this.database.prepare('UPDATE execution_tasks SET status = ?, payload = ? WHERE task_id = ?')
      .run(task.status, JSON.stringify(task), task.taskId);
  }

  private protectFiles(): void {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const path = `${this.filePath}${suffix}`;
      assertRuntimeFile(path);
      if (runtimePathMetadata(path)) chmodSync(path, 0o600);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.protectFiles();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    } finally { this.protectFiles(); }
  }
}
