import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import type {
  BranchApproval, BranchApprovalRequest, BranchAttempt, BranchClaim, BranchControl,
  BranchPlan, BranchResult, BranchSnapshot, BranchTask,
} from '../domain/branch.js';
import type { BranchStore } from '../ports/branch.js';
import { assertBranchOwner, assertBranchPlan, assertBranchReady, assertBranchTime, validateBranchApproval } from '../policy/branch-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

const taskKeys = ['taskId', 'plan', 'status', 'generation', 'revision', 'invalidatedAt', 'failureCode', 'updatedAt'];
const approvalKeys = ['approvalId', 'taskId', 'ownerId', 'planHash', 'planSnapshot', 'createdAt', 'expiresAt', 'usedAt', 'revokedAt', 'reason'];
const attemptKeys = ['attemptId', 'taskId', 'approvalId', 'planHash', 'generation', 'status', 'startedAt', 'finishedAt', 'reason', 'receiptId'];
const controls = ['cancel', 'edited', 'deleted', 'base-changed', 'diff-changed', 'branch-conflict'];
const terminal = ['SIMULATED', 'FAILED', 'UNKNOWN', 'BLOCKED', 'CANCELLED'];
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const hasKeys = (value: unknown, keys: string[]): boolean => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)));
const isId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const isDigest = (value: unknown): value is string => typeof value === 'string' && digest.test(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1_000_000_000;
const isCode = (value: unknown): value is string => typeof value === 'string' && /^BRANCH_[A-Z_]{1,80}$/.test(value);
const decode = <T>(value: unknown, code: string): T => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65_536) throw new HarnessError(code);
  try { return JSON.parse(value) as T; } catch { throw new HarnessError(code); }
};
const assertContext = (ownerId: string, now: Date): void => {
  assertBranchTime(now);
  assertBranchOwner(ownerId);
  if (typeof process.getuid !== 'function' || ownerId !== `os-user:${process.getuid()}`) throw new HarnessError('BRANCH_OWNER_MISMATCH');
};
const controlReason = (event: BranchControl): string => `BRANCH_${event.kind.replaceAll('-', '_').toUpperCase()}`;

/** 합성 승인과 1회 모의 시도를 별도 DB에 보관한다. 실제 Git 작업 권한은 만들지 않는다. */
export class SqliteBranchStore implements BranchStore {
  private readonly database: DatabaseSync;
  private transactionOpen = false;

  constructor(private readonly filePath: string) {
    this.protectFiles();
    const existing = runtimePathMetadata(filePath) !== null;
    this.database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    if (!existing) chmodSync(filePath, 0o600);
    this.protectFiles();
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS branch_tasks (
        task_id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, status TEXT NOT NULL,
        updated_at TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS branch_approvals (
        approval_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES branch_tasks(task_id),
        owner_id TEXT NOT NULL, used_at TEXT, revoked_at TEXT, expires_at TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS branch_approval_active ON branch_approvals(task_id)
        WHERE used_at IS NULL AND revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS branch_attempts (
        attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES branch_tasks(task_id),
        approval_id TEXT NOT NULL UNIQUE REFERENCES branch_approvals(approval_id), status TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS branch_controls (
        event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES branch_tasks(task_id), payload TEXT NOT NULL
      ) STRICT;
    `);
    this.protectFiles();
  }

  create(plan: BranchPlan, now: Date): BranchTask {
    assertBranchPlan(plan);
    assertContext(plan.ownerId, now);
    if (now.toISOString() < plan.createdAt) throw new HarnessError('BRANCH_INVALID_TIME');
    return this.transaction(() => {
      const previous = this.findTask(plan.taskId);
      if (previous) {
        if (previous.plan.planHash !== plan.planHash) throw new HarnessError('BRANCH_TASK_CONFLICT');
        if (now.toISOString() < previous.updatedAt) throw new HarnessError('BRANCH_INVALID_TIME');
        this.assertRelations(previous);
        return this.maintain(previous, now);
      }
      const task: BranchTask = {
        taskId: plan.taskId, plan: structuredClone(plan), status: plan.fixture === 'source-changed' ? 'BLOCKED' : 'AWAITING_APPROVAL',
        generation: 0, revision: plan.source.revision, invalidatedAt: null,
        failureCode: plan.fixture === 'source-changed' ? 'BRANCH_SOURCE_CHANGED' : null, updatedAt: now.toISOString(),
      };
      this.assertTask(task);
      this.database.prepare('INSERT INTO branch_tasks VALUES (?, ?, ?, ?, ?)')
        .run(task.taskId, plan.planHash, task.status, task.updatedAt, JSON.stringify(task));
      return this.maintain(task, now);
    });
  }

  inspect(taskId: string, ownerId: string, now: Date, approvalOffset = 0): BranchSnapshot {
    assertContext(ownerId, now);
    if (!Number.isSafeInteger(approvalOffset) || approvalOffset < 0 || approvalOffset > 1_000_000_000) {
      throw new HarnessError('BRANCH_INVALID_APPROVAL_OFFSET');
    }
    return this.transaction(() => this.snapshot(this.maintain(this.ownedTask(taskId, ownerId, now), now), approvalOffset));
  }

  approve(request: BranchApprovalRequest, ownerId: string, now: Date): BranchApproval {
    assertContext(ownerId, now);
    if (!hasKeys(request, ['taskId', 'planHash', 'expiresInMinutes']) || !isId(request.taskId) || !isDigest(request.planHash)
      || !Number.isSafeInteger(request.expiresInMinutes) || request.expiresInMinutes < 1 || request.expiresInMinutes > 60) {
      throw new HarnessError('BRANCH_INVALID_APPROVAL');
    }
    const result = this.transaction((): BranchApproval | HarnessError => {
      const task = this.maintain(this.ownedTask(request.taskId, ownerId, now), now);
      try { validateBranchApproval(task, request, ownerId, now); } catch (error) {
        if (error instanceof HarnessError) return error;
        throw error;
      }
      if (this.findAttempt(task.taskId)) return new HarnessError('BRANCH_ALREADY_ATTEMPTED');
      if (this.activeApproval(task.taskId)) return new HarnessError('BRANCH_APPROVAL_EXISTS');
      if (task.status !== 'AWAITING_APPROVAL') return new HarnessError('BRANCH_NOT_AWAITING_APPROVAL');
      const approval: BranchApproval = {
        approvalId: randomUUID(), taskId: task.taskId, ownerId, planHash: task.plan.planHash,
        planSnapshot: structuredClone(task.plan), createdAt: now.toISOString(),
        expiresAt: new Date(Math.min(now.getTime() + request.expiresInMinutes * 60_000, Date.parse(task.plan.expiresAt))).toISOString(),
        usedAt: null, revokedAt: null, reason: null,
      };
      this.assertApproval(approval);
      this.database.prepare('INSERT INTO branch_approvals VALUES (?, ?, ?, NULL, NULL, ?, ?)')
        .run(approval.approvalId, task.taskId, ownerId, approval.expiresAt, JSON.stringify(approval));
      this.writeTask({ ...task, status: 'APPROVED', failureCode: null, updatedAt: now.toISOString() });
      return approval;
    });
    if (result instanceof HarnessError) throw result;
    return result;
  }

  claim(taskId: string, planHash: string, ownerId: string, now: Date): BranchClaim {
    assertContext(ownerId, now);
    if (!isDigest(planHash)) throw new HarnessError('BRANCH_PLAN_HASH_MISMATCH');
    const result = this.transaction((): BranchClaim | HarnessError => {
      const task = this.maintain(this.ownedTask(taskId, ownerId, now), now);
      try { assertBranchReady(task, ownerId, now); } catch (error) {
        if (error instanceof HarnessError) return error;
        throw error;
      }
      if (planHash !== task.plan.planHash) return new HarnessError('BRANCH_PLAN_HASH_MISMATCH');
      if (this.findAttempt(taskId)) return new HarnessError('BRANCH_ALREADY_ATTEMPTED');
      const approval = this.activeApproval(taskId);
      if (!approval || task.status !== 'APPROVED') return new HarnessError('BRANCH_APPROVAL_REQUIRED');
      if (approval.ownerId !== ownerId || approval.planHash !== planHash) return new HarnessError('BRANCH_APPROVAL_MISMATCH');
      this.writeApproval({ ...approval, usedAt: now.toISOString() });
      const attempt: BranchAttempt = {
        attemptId: randomUUID(), taskId, approvalId: approval.approvalId, planHash, generation: task.generation,
        status: 'SIMULATING', startedAt: now.toISOString(), finishedAt: null, reason: null, receiptId: null,
      };
      this.database.prepare('INSERT INTO branch_attempts VALUES (?, ?, ?, ?, ?)')
        .run(attempt.attemptId, taskId, approval.approvalId, attempt.status, JSON.stringify(attempt));
      const claimed: BranchTask = { ...task, status: 'SIMULATING', updatedAt: now.toISOString() };
      this.writeTask(claimed);
      return { task: claimed, attempt };
    });
    if (result instanceof HarnessError) throw result;
    return result;
  }

  finish(attemptId: string, result: BranchResult, now: Date): BranchAttempt {
    assertContext(`os-user:${process.getuid?.()}`, now);
    if (!hasKeys(result, ['status', 'reason', 'receiptId'])) throw new HarnessError('BRANCH_INVALID_RESULT');
    return this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM branch_attempts WHERE attempt_id = ?').get(attemptId);
      if (!row) throw new HarnessError('BRANCH_ATTEMPT_NOT_FOUND');
      const attempt = this.parseAttempt(row);
      const task = this.ownedTask(attempt.taskId, `os-user:${process.getuid!()}`, now);
      if (attempt.status !== 'SIMULATING' || task.status !== 'SIMULATING' || attempt.generation !== task.generation
        || task.invalidatedAt !== null) throw new HarnessError('BRANCH_INVALIDATED');
      const validResult = result.status === 'SIMULATED'
        ? task.plan.fixture === 'success' && result.reason === null && result.receiptId === `mock-branch:${attemptId}`
        : result.status === 'NOT_CREATED' ? task.plan.fixture === 'collision' && result.reason === 'BRANCH_NAME_COLLISION' && result.receiptId === null
          : result.status === 'UNKNOWN' && result.receiptId === null
            && (result.reason === 'BRANCH_SIMULATION_UNCERTAIN' || (task.plan.fixture === 'unknown' && result.reason === 'BRANCH_MOCK_UNKNOWN'));
      if (!validResult) throw new HarnessError('BRANCH_INVALID_RESULT');
      const finished: BranchAttempt = { ...attempt, ...result, finishedAt: now.toISOString() };
      this.writeAttempt(finished);
      this.writeTask({ ...task, status: result.status === 'NOT_CREATED' ? 'FAILED' : result.status,
        failureCode: result.reason, updatedAt: now.toISOString() });
      return finished;
    });
  }

  control(event: BranchControl, ownerId: string, now: Date): BranchTask {
    assertContext(ownerId, now);
    if (!hasKeys(event, ['taskId', 'eventId', 'kind', 'revision']) || !isId(event.taskId)
      || typeof event.eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(event.eventId)
      || !controls.includes(event.kind) || !isRevision(event.revision)) throw new HarnessError('BRANCH_INVALID_CONTROL');
    return this.transaction(() => {
      const task = this.ownedTask(event.taskId, ownerId, now);
      const payload = JSON.stringify({ taskId: event.taskId, eventId: event.eventId, kind: event.kind, revision: event.revision });
      const previous = this.database.prepare('SELECT task_id, payload FROM branch_controls WHERE event_id = ?').get(event.eventId);
      if (previous) {
        if (previous.task_id !== event.taskId || previous.payload !== payload) throw new HarnessError('BRANCH_CONTROL_CONFLICT');
        return task;
      }
      this.database.prepare('INSERT INTO branch_controls VALUES (?, ?, ?)').run(event.eventId, event.taskId, payload);
      if (event.kind !== 'cancel' && event.revision <= task.revision) return task;
      if (terminal.includes(task.status)) return task;
      return this.invalidate(task, controlReason(event), now, event.kind === 'cancel', Math.max(task.revision, event.revision));
    });
  }

  recover(taskId: string, ownerId: string, now: Date): BranchSnapshot {
    assertContext(ownerId, now);
    return this.transaction(() => {
      let task = this.ownedTask(taskId, ownerId, now);
      if (task.status === 'SIMULATING') task = this.invalidate(task, 'BRANCH_RECOVERED_UNCERTAIN', now, false, task.revision);
      return this.snapshot(this.maintain(task, now), 0);
    });
  }

  close(): void { this.database.close(); }

  private maintain(task: BranchTask, now: Date): BranchTask {
    if (terminal.includes(task.status) || task.status === 'SIMULATING') return task;
    if (now.getTime() >= Date.parse(task.plan.expiresAt)) return this.invalidate(task, 'BRANCH_PLAN_EXPIRED', now, false, task.revision);
    const approval = this.activeApproval(task.taskId);
    if (approval && now.getTime() >= Date.parse(approval.expiresAt)) {
      this.writeApproval({ ...approval, revokedAt: now.toISOString(), reason: 'BRANCH_APPROVAL_EXPIRED' });
      task = { ...task, status: 'AWAITING_APPROVAL', failureCode: 'BRANCH_APPROVAL_EXPIRED', updatedAt: now.toISOString() };
      this.writeTask(task);
    }
    return task;
  }

  private invalidate(task: BranchTask, reason: string, now: Date, cancelled: boolean, revision: number): BranchTask {
    const approval = this.activeApproval(task.taskId);
    if (approval) this.writeApproval({ ...approval, revokedAt: now.toISOString(), reason });
    const attempt = this.findAttempt(task.taskId);
    if (attempt?.status === 'SIMULATING') {
      this.writeAttempt({ ...attempt, status: 'UNKNOWN', reason, finishedAt: now.toISOString(), receiptId: null });
    }
    const updated: BranchTask = { ...task, generation: task.generation + 1, revision, invalidatedAt: now.toISOString(),
      status: attempt ? 'UNKNOWN' : cancelled ? 'CANCELLED' : 'BLOCKED', failureCode: reason, updatedAt: now.toISOString() };
    this.writeTask(updated);
    return updated;
  }

  private snapshot(task: BranchTask, offset: number): BranchSnapshot {
    this.assertRelations(task);
    const total = Number(this.database.prepare('SELECT COUNT(*) AS total FROM branch_approvals WHERE task_id = ?').get(task.taskId)?.total ?? 0);
    const approvals = this.database.prepare('SELECT * FROM branch_approvals WHERE task_id = ? ORDER BY rowid DESC LIMIT 1 OFFSET ?')
      .all(task.taskId, offset).map((row) => this.parseApproval(row));
    return { task, approvals, approvalPage: { offset, total, nextOffset: approvals.length > 0 && offset + 1 < total ? offset + 1 : null },
      attempt: this.findAttempt(task.taskId) };
  }

  private findTask(taskId: string): BranchTask | null {
    if (!isId(taskId)) throw new HarnessError('BRANCH_INVALID_TASK_ID');
    const row = this.database.prepare('SELECT * FROM branch_tasks WHERE task_id = ?').get(taskId);
    if (!row) return null;
    const task = decode<BranchTask>(row.payload, 'BRANCH_INVALID_STORED_TASK');
    this.assertTask(task);
    if (row.task_id !== task.taskId || row.plan_hash !== task.plan.planHash || row.status !== task.status || row.updated_at !== task.updatedAt) {
      throw new HarnessError('BRANCH_INVALID_STORED_TASK');
    }
    return task;
  }

  private requireTask(taskId: string): BranchTask {
    const task = this.findTask(taskId);
    if (!task) throw new HarnessError('BRANCH_TASK_NOT_FOUND');
    return task;
  }

  private ownedTask(taskId: string, ownerId: string, now: Date): BranchTask {
    const task = this.requireTask(taskId);
    if (task.plan.ownerId !== ownerId) throw new HarnessError('BRANCH_OWNER_MISMATCH');
    if (now.toISOString() < task.updatedAt) throw new HarnessError('BRANCH_INVALID_TIME');
    this.assertRelations(task);
    return task;
  }

  private activeApproval(taskId: string): BranchApproval | null {
    const row = this.database.prepare('SELECT * FROM branch_approvals WHERE task_id = ? AND used_at IS NULL AND revoked_at IS NULL').get(taskId);
    return row ? this.parseApproval(row) : null;
  }

  private findAttempt(taskId: string): BranchAttempt | null {
    const row = this.database.prepare('SELECT * FROM branch_attempts WHERE task_id = ?').get(taskId);
    return row ? this.parseAttempt(row) : null;
  }

  private parseApproval(row: Record<string, SQLOutputValue>): BranchApproval {
    const approval = decode<BranchApproval>(row.payload, 'BRANCH_INVALID_STORED_APPROVAL');
    this.assertApproval(approval);
    const task = this.requireTask(approval.taskId);
    if (row.approval_id !== approval.approvalId || row.task_id !== approval.taskId || row.owner_id !== approval.ownerId
      || row.used_at !== approval.usedAt || row.revoked_at !== approval.revokedAt || row.expires_at !== approval.expiresAt
      || task.plan.planHash !== approval.planHash || task.plan.ownerId !== approval.ownerId) {
      throw new HarnessError('BRANCH_INVALID_STORED_APPROVAL');
    }
    return approval;
  }

  private parseAttempt(row: Record<string, SQLOutputValue>): BranchAttempt {
    const attempt = decode<BranchAttempt>(row.payload, 'BRANCH_INVALID_STORED_ATTEMPT');
    this.assertAttempt(attempt);
    if (row.attempt_id !== attempt.attemptId || row.task_id !== attempt.taskId || row.approval_id !== attempt.approvalId || row.status !== attempt.status) {
      throw new HarnessError('BRANCH_INVALID_STORED_ATTEMPT');
    }
    const approvalRow = this.database.prepare('SELECT * FROM branch_approvals WHERE approval_id = ?').get(attempt.approvalId);
    if (!approvalRow) throw new HarnessError('BRANCH_INVALID_STORED_ATTEMPT');
    const approval = this.parseApproval(approvalRow);
    const task = this.requireTask(attempt.taskId);
    if (approval.taskId !== attempt.taskId || approval.planHash !== attempt.planHash || approval.usedAt !== attempt.startedAt
      || task.plan.planHash !== attempt.planHash || attempt.generation > task.generation) throw new HarnessError('BRANCH_INVALID_STORED_ATTEMPT');
    if ((attempt.status === 'SIMULATED' && task.plan.fixture !== 'success')
      || (attempt.status === 'NOT_CREATED' && task.plan.fixture !== 'collision')) throw new HarnessError('BRANCH_INVALID_STORED_ATTEMPT');
    return attempt;
  }

  private assertRelations(task: BranchTask): void {
    const active = this.activeApproval(task.taskId);
    const attempt = this.findAttempt(task.taskId);
    if (active && task.status !== 'APPROVED') throw new HarnessError('BRANCH_INVALID_STORED_TASK');
    if (task.status === 'APPROVED' && (!active || attempt)) throw new HarnessError('BRANCH_INVALID_STORED_TASK');
    const expected = task.status === 'SIMULATING' ? 'SIMULATING' : task.status === 'SIMULATED' ? 'SIMULATED'
      : task.status === 'FAILED' ? 'NOT_CREATED' : task.status === 'UNKNOWN' ? 'UNKNOWN' : null;
    if (expected ? !attempt || attempt.status !== expected : attempt !== null) throw new HarnessError('BRANCH_INVALID_STORED_TASK');
    if (attempt && (attempt.finishedAt ?? attempt.startedAt) > task.updatedAt) throw new HarnessError('BRANCH_INVALID_STORED_TASK');
    if (attempt && attempt.finishedAt !== null && task.failureCode !== attempt.reason) {
      throw new HarnessError('BRANCH_INVALID_STORED_TASK');
    }
  }

  private assertTask(task: BranchTask): void {
    if (!hasKeys(task, taskKeys) || !isId(task.taskId)
      || !['AWAITING_APPROVAL', 'APPROVED', 'SIMULATING', ...terminal].includes(task.status)
      || !Number.isSafeInteger(task.generation) || task.generation < 0 || task.generation > 1_000_000_000 || !isRevision(task.revision)
      || (task.invalidatedAt !== null && !isTime(task.invalidatedAt)) || (task.failureCode !== null && !isCode(task.failureCode))
      || !isTime(task.updatedAt)) throw new HarnessError('BRANCH_INVALID_STORED_TASK');
    assertBranchPlan(task.plan);
    if (task.taskId !== task.plan.taskId || task.updatedAt < task.plan.createdAt || task.revision < task.plan.source.revision
      || (task.invalidatedAt === null ? task.generation !== 0 || task.revision !== task.plan.source.revision
        : task.generation < 1 || task.invalidatedAt > task.updatedAt)
      || (task.invalidatedAt !== null && !['BLOCKED', 'CANCELLED', 'UNKNOWN'].includes(task.status))) {
      throw new HarnessError('BRANCH_INVALID_STORED_TASK');
    }
  }

  private assertApproval(approval: BranchApproval): void {
    if (!hasKeys(approval, approvalKeys) || !isId(approval.approvalId) || !isId(approval.taskId) || !isDigest(approval.planHash)
      || !isTime(approval.createdAt) || !isTime(approval.expiresAt) || (approval.usedAt !== null && !isTime(approval.usedAt))
      || (approval.revokedAt !== null && !isTime(approval.revokedAt)) || (approval.reason !== null && !isCode(approval.reason))) {
      throw new HarnessError('BRANCH_INVALID_STORED_APPROVAL');
    }
    assertBranchOwner(approval.ownerId);
    assertBranchPlan(approval.planSnapshot);
    if (approval.taskId !== approval.planSnapshot.taskId || approval.ownerId !== approval.planSnapshot.ownerId
      || approval.planHash !== approval.planSnapshot.planHash || approval.createdAt < approval.planSnapshot.createdAt
      || approval.expiresAt <= approval.createdAt || Date.parse(approval.expiresAt) - Date.parse(approval.createdAt) > 3_600_000
      || approval.expiresAt > approval.planSnapshot.expiresAt
      || (approval.usedAt !== null && (approval.revokedAt !== null || approval.usedAt < approval.createdAt || approval.usedAt >= approval.expiresAt))
      || (approval.revokedAt !== null && approval.revokedAt < approval.createdAt)
      || (approval.reason === null) !== (approval.revokedAt === null)) throw new HarnessError('BRANCH_INVALID_STORED_APPROVAL');
  }

  private assertAttempt(attempt: BranchAttempt): void {
    if (!hasKeys(attempt, attemptKeys) || !isId(attempt.attemptId) || !isId(attempt.taskId) || !isId(attempt.approvalId)
      || !isDigest(attempt.planHash) || attempt.generation !== 0 || !isTime(attempt.startedAt)
      || !['SIMULATING', 'SIMULATED', 'NOT_CREATED', 'UNKNOWN'].includes(attempt.status)
      || (attempt.status === 'SIMULATING' ? attempt.finishedAt !== null || attempt.reason !== null || attempt.receiptId !== null
        : !isTime(attempt.finishedAt) || attempt.finishedAt < attempt.startedAt)) throw new HarnessError('BRANCH_INVALID_STORED_ATTEMPT');
    const reasons = ['BRANCH_MOCK_UNKNOWN', 'BRANCH_SIMULATION_UNCERTAIN', 'BRANCH_RECOVERED_UNCERTAIN',
      'BRANCH_CANCEL', 'BRANCH_EDITED', 'BRANCH_DELETED', 'BRANCH_BASE_CHANGED', 'BRANCH_DIFF_CHANGED', 'BRANCH_BRANCH_CONFLICT'];
    if ((attempt.status === 'SIMULATED' && (attempt.reason !== null || attempt.receiptId !== `mock-branch:${attempt.attemptId}`))
      || (attempt.status === 'NOT_CREATED' && (attempt.reason !== 'BRANCH_NAME_COLLISION' || attempt.receiptId !== null))
      || (attempt.status === 'UNKNOWN' && (!reasons.includes(attempt.reason ?? '') || attempt.receiptId !== null))) {
      throw new HarnessError('BRANCH_INVALID_STORED_ATTEMPT');
    }
  }

  private writeTask(task: BranchTask): void {
    this.assertTask(task);
    this.database.prepare('UPDATE branch_tasks SET status = ?, updated_at = ?, payload = ? WHERE task_id = ?')
      .run(task.status, task.updatedAt, JSON.stringify(task), task.taskId);
  }

  private writeApproval(approval: BranchApproval): void {
    this.assertApproval(approval);
    this.database.prepare('UPDATE branch_approvals SET used_at = ?, revoked_at = ?, payload = ? WHERE approval_id = ?')
      .run(approval.usedAt, approval.revokedAt, JSON.stringify(approval), approval.approvalId);
  }

  private writeAttempt(attempt: BranchAttempt): void {
    this.assertAttempt(attempt);
    this.database.prepare('UPDATE branch_attempts SET status = ?, payload = ? WHERE attempt_id = ?')
      .run(attempt.status, JSON.stringify(attempt), attempt.attemptId);
  }

  private protectFiles(): void {
    if (!isAbsolute(this.filePath)) throw new HarnessError('UNSAFE_RUNTIME_PATH');
    const directory = dirname(this.filePath);
    const directoryMetadata = lstatSync(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || realpathSync(directory) !== directory
      || typeof process.getuid !== 'function' || directoryMetadata.uid !== process.getuid() || (directoryMetadata.mode & 0o077) !== 0) {
      throw new HarnessError('UNSAFE_RUNTIME_PATH');
    }
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const path = `${this.filePath}${suffix}`;
      assertRuntimeFile(path);
      const metadata = runtimePathMetadata(path);
      if (metadata && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)) throw new HarnessError('UNSAFE_RUNTIME_FILE');
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.transactionOpen) throw new HarnessError('BRANCH_TRANSACTION_IN_PROGRESS');
    this.protectFiles();
    this.database.exec('BEGIN IMMEDIATE');
    this.transactionOpen = true;
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionOpen = false;
      this.protectFiles();
    }
  }
}
