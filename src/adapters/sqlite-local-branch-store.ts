import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type {
  LocalBranchApproval, LocalBranchApprovalRequest, LocalBranchAttempt, LocalBranchObservation,
  LocalBranchPlan, LocalBranchSnapshot, LocalBranchTask,
} from '../domain/local-branch.js';
import { HarnessError } from '../domain/errors.js';
import type { LocalBranchStore } from '../ports/local-branch.js';
import {
  assertLocalBranchApprovalRequest, assertLocalBranchObservation, assertLocalBranchOwner,
  assertLocalBranchPlan, assertLocalBranchTime,
} from '../policy/local-branch-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'BLOCKED'];
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const exactKeys = (value: unknown, keys: string[]): boolean => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)));
const isId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const isCode = (value: unknown): value is string => typeof value === 'string' && /^LOCAL_BRANCH_[A-Z_]{1,80}$/.test(value);
const decode = <T>(value: unknown, code: string): T => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65_536) throw new HarnessError(code);
  try { return JSON.parse(value) as T; } catch { throw new HarnessError(code); }
};
const assertContext = (ownerId: string, now: Date): void => {
  assertLocalBranchTime(now);
  assertLocalBranchOwner(ownerId);
  if (!process.getuid || ownerId !== `os-user:${process.getuid()}`) throw new HarnessError('LOCAL_BRANCH_OWNER_MISMATCH');
};

/** Git 변경 전 intent를 commit하고, 짧은 ref 쓰기는 취소 writer와 직렬화한다. */
export class SqliteLocalBranchStore implements LocalBranchStore {
  private readonly database: DatabaseSync;
  private transactionOpen = false;

  constructor(private readonly filePath: string) {
    this.protectFiles();
    const exists = runtimePathMetadata(filePath) !== null;
    this.database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    if (!exists) chmodSync(filePath, 0o600);
    this.protectFiles();
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS local_branch_tasks (
        task_id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS local_branch_approvals (
        approval_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES local_branch_tasks(task_id),
        used_at TEXT, revoked_at TEXT, payload TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS local_branch_active ON local_branch_approvals(task_id)
        WHERE used_at IS NULL AND revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS local_branch_attempts (
        attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES local_branch_tasks(task_id),
        approval_id TEXT NOT NULL UNIQUE REFERENCES local_branch_approvals(approval_id), status TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
    `);
  }

  create(plan: LocalBranchPlan, now: Date): LocalBranchTask {
    assertLocalBranchPlan(plan);
    assertContext(plan.ownerId, now);
    this.assertRoot(plan);
    if (now.toISOString() < plan.createdAt) throw new HarnessError('LOCAL_BRANCH_INVALID_TIME');
    return this.transaction(() => {
      const previous = this.findTask(plan.taskId);
      if (previous) {
        if (previous.plan.planHash !== plan.planHash) throw new HarnessError('LOCAL_BRANCH_TASK_CONFLICT');
        return this.maintain(this.owned(plan.taskId, plan.ownerId, now), now);
      }
      const task: LocalBranchTask = { taskId: plan.taskId, plan: structuredClone(plan), status: 'AWAITING_APPROVAL',
        generation: 0, cancelledAt: null, failureCode: null, updatedAt: now.toISOString() };
      this.database.prepare('INSERT INTO local_branch_tasks VALUES (?, ?, ?, ?)')
        .run(task.taskId, plan.planHash, task.status, JSON.stringify(task));
      return this.maintain(task, now);
    });
  }

  inspect(taskId: string, ownerId: string, now: Date, offset = 0): LocalBranchSnapshot {
    assertContext(ownerId, now);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000_000) throw new HarnessError('LOCAL_BRANCH_INVALID_OFFSET');
    return this.transaction(() => this.snapshot(this.maintain(this.owned(taskId, ownerId, now), now), offset));
  }

  approve(request: LocalBranchApprovalRequest, observation: LocalBranchObservation, ownerId: string, now: Date): LocalBranchApproval {
    assertContext(ownerId, now);
    assertLocalBranchApprovalRequest(request);
    return this.outcome(() => {
      const task = this.maintain(this.owned(request.taskId, ownerId, now), now);
      const denial = this.preflight(task, request.planHash, observation);
      if (denial) return denial;
      if (task.status !== 'AWAITING_APPROVAL' || this.active(task.taskId)) return new HarnessError('LOCAL_BRANCH_APPROVAL_EXISTS');
      const approval: LocalBranchApproval = {
        approvalId: randomUUID(), taskId: task.taskId, ownerId, planHash: task.plan.planHash, planSnapshot: structuredClone(task.plan),
        createdAt: now.toISOString(), expiresAt: new Date(Math.min(now.getTime() + request.expiresInMinutes * 60_000, Date.parse(task.plan.expiresAt))).toISOString(),
        usedAt: null, revokedAt: null, reason: null,
      };
      this.assertApproval(approval);
      this.database.prepare('INSERT INTO local_branch_approvals VALUES (?, ?, NULL, NULL, ?)')
        .run(approval.approvalId, task.taskId, JSON.stringify(approval));
      this.writeTask({ ...task, status: 'APPROVED', failureCode: null, updatedAt: now.toISOString() });
      return approval;
    });
  }

  claim(taskId: string, planHash: string, observation: LocalBranchObservation, ownerId: string, now: Date): LocalBranchAttempt {
    assertContext(ownerId, now);
    return this.outcome(() => {
      const task = this.maintain(this.owned(taskId, ownerId, now), now);
      const denial = this.preflight(task, planHash, observation);
      if (denial) return denial;
      const approval = this.active(taskId);
      if (task.status !== 'APPROVED' || !approval) return new HarnessError('LOCAL_BRANCH_APPROVAL_REQUIRED');
      this.writeApproval({ ...approval, usedAt: now.toISOString() });
      const attempt: LocalBranchAttempt = {
        attemptId: randomUUID(), taskId, approvalId: approval.approvalId, planHash, generation: task.generation,
        phase: 'claimed', status: 'RUNNING', startedAt: now.toISOString(), writeStartedAt: null, refCreatedAt: null,
        finishedAt: null, reason: null, before: structuredClone(observation), after: null,
      };
      this.database.prepare('INSERT INTO local_branch_attempts VALUES (?, ?, ?, ?, ?)')
        .run(attempt.attemptId, taskId, approval.approvalId, attempt.status, JSON.stringify(attempt));
      this.writeTask({ ...task, status: 'RUNNING', updatedAt: now.toISOString() });
      return attempt;
    });
  }

  beginWrite(taskId: string, ownerId: string, now: Date): void {
    assertContext(ownerId, now);
    this.transaction(() => {
      const { task, attempt } = this.running(taskId, ownerId, now);
      this.assertWriteAllowed(task, attempt, now);
      if (attempt.phase !== 'claimed') throw new HarnessError('LOCAL_BRANCH_INVALID_PHASE');
      this.writeAttempt({ ...attempt, phase: 'writing', writeStartedAt: now.toISOString() });
      this.writeTask({ ...task, updatedAt: now.toISOString() });
    });
  }

  writeGuard(taskId: string, ownerId: string, now: Date, operation: () => void): void {
    assertContext(ownerId, now);
    this.transaction(() => {
      const { task, attempt } = this.running(taskId, ownerId, now);
      this.assertWriteAllowed(task, attempt, now);
      if (attempt.phase !== 'writing') throw new HarnessError('LOCAL_BRANCH_INVALID_PHASE');
      // 고정 41바이트 ref 쓰기만 허용하는 trusted adapter의 동기 호출이다.
      operation();
      this.writeAttempt({ ...attempt, phase: 'created', refCreatedAt: now.toISOString() });
      this.writeTask({ ...task, updatedAt: now.toISOString() });
    });
  }

  finish(taskId: string, observation: LocalBranchObservation, failureCode: string | null, recovered: boolean, ownerId: string, now: Date): LocalBranchSnapshot {
    assertContext(ownerId, now);
    if (failureCode !== null && !isCode(failureCode)) throw new HarnessError('LOCAL_BRANCH_INVALID_RESULT');
    return this.transaction(() => {
      const { task, attempt } = this.running(taskId, ownerId, now);
      assertLocalBranchObservation(observation, task.plan);
      const status = observation.state === 'unsafe' ? 'BLOCKED'
        : task.cancelledAt !== null ? 'CANCELLED'
          : recovered ? 'INTERRUPTED'
            : failureCode !== null ? (observation.state === 'created' ? 'BLOCKED' : 'FAILED')
              : observation.state === 'created' && attempt.phase === 'created' ? 'SUCCEEDED' : 'BLOCKED';
      const reason = status === 'SUCCEEDED' ? null : observation.reason ?? (task.cancelledAt !== null ? 'LOCAL_BRANCH_CANCELLED'
        : recovered ? 'LOCAL_BRANCH_INTERRUPTED' : failureCode ?? 'LOCAL_BRANCH_RESULT_MISMATCH');
      this.writeAttempt({ ...attempt, phase: 'finished', status, finishedAt: now.toISOString(), reason, after: structuredClone(observation) });
      const finished: LocalBranchTask = { ...task, status, failureCode: reason, updatedAt: now.toISOString() };
      this.writeTask(finished);
      return this.snapshot(finished, 0);
    });
  }

  block(taskId: string, reason: string, ownerId: string, now: Date): void {
    assertContext(ownerId, now);
    if (!isCode(reason)) throw new HarnessError('LOCAL_BRANCH_INVALID_RESULT');
    this.transaction(() => {
      const task = this.owned(taskId, ownerId, now);
      if (!['AWAITING_APPROVAL', 'APPROVED'].includes(task.status)) throw new HarnessError('LOCAL_BRANCH_NOT_READY');
      this.revoke(taskId, reason, now);
      this.writeTask({ ...task, status: 'BLOCKED', failureCode: reason, updatedAt: now.toISOString() });
    });
  }

  cancel(taskId: string, ownerId: string, now: Date): LocalBranchSnapshot {
    assertContext(ownerId, now);
    return this.transaction(() => {
      const task = this.owned(taskId, ownerId, now);
      if (terminal.includes(task.status) || task.cancelledAt !== null) return this.snapshot(task, 0);
      this.revoke(taskId, 'LOCAL_BRANCH_CANCELLED', now);
      const cancelled: LocalBranchTask = { ...task, generation: task.generation + 1, cancelledAt: now.toISOString(),
        status: task.status === 'RUNNING' ? 'RUNNING' : 'CANCELLED', failureCode: 'LOCAL_BRANCH_CANCELLED', updatedAt: now.toISOString() };
      this.writeTask(cancelled);
      return this.snapshot(cancelled, 0);
    });
  }

  close(): void { this.database.close(); }

  private preflight(task: LocalBranchTask, planHash: string, observation: LocalBranchObservation): HarnessError | null {
    if (typeof planHash !== 'string' || !digest.test(planHash) || planHash !== task.plan.planHash) return new HarnessError('LOCAL_BRANCH_PLAN_HASH_MISMATCH');
    if (!['AWAITING_APPROVAL', 'APPROVED'].includes(task.status) || this.attempt(task.taskId)) return new HarnessError('LOCAL_BRANCH_NOT_READY');
    assertLocalBranchObservation(observation, task.plan);
    return observation.state === 'absent' ? null : new HarnessError('LOCAL_BRANCH_NOT_ABSENT');
  }

  private assertWriteAllowed(task: LocalBranchTask, attempt: LocalBranchAttempt, now: Date): void {
    if (task.cancelledAt !== null || task.generation !== attempt.generation) throw new HarnessError('LOCAL_BRANCH_CANCELLED');
    const approval = this.approvalById(attempt.approvalId);
    if (now.toISOString() >= approval.expiresAt || now.toISOString() >= task.plan.expiresAt) throw new HarnessError('LOCAL_BRANCH_APPROVAL_EXPIRED');
  }

  private maintain(task: LocalBranchTask, now: Date): LocalBranchTask {
    if (terminal.includes(task.status) || task.status === 'RUNNING') return task;
    if (now.toISOString() >= task.plan.expiresAt) {
      this.revoke(task.taskId, 'LOCAL_BRANCH_PLAN_EXPIRED', now);
      task = { ...task, status: 'BLOCKED', failureCode: 'LOCAL_BRANCH_PLAN_EXPIRED', updatedAt: now.toISOString() };
      this.writeTask(task);
    } else {
      const approval = this.active(task.taskId);
      if (approval && now.toISOString() >= approval.expiresAt) {
        this.revoke(task.taskId, 'LOCAL_BRANCH_APPROVAL_EXPIRED', now);
        task = { ...task, status: 'AWAITING_APPROVAL', failureCode: 'LOCAL_BRANCH_APPROVAL_EXPIRED', updatedAt: now.toISOString() };
        this.writeTask(task);
      }
    }
    return task;
  }

  private revoke(taskId: string, reason: string, now: Date): void {
    const approval = this.active(taskId);
    if (approval) this.writeApproval({ ...approval, revokedAt: now.toISOString(), reason });
  }

  private snapshot(task: LocalBranchTask, offset: number): LocalBranchSnapshot {
    this.assertRelations(task);
    const total = Number(this.database.prepare('SELECT COUNT(*) AS total FROM local_branch_approvals WHERE task_id = ?').get(task.taskId)?.total ?? 0);
    const approvals = this.database.prepare('SELECT * FROM local_branch_approvals WHERE task_id = ? ORDER BY rowid DESC LIMIT 1 OFFSET ?')
      .all(task.taskId, offset).map((row) => this.parseApproval(row));
    return { task, approvals, approvalPage: { offset, total, nextOffset: approvals.length > 0 && offset + 1 < total ? offset + 1 : null }, attempt: this.attempt(task.taskId) };
  }

  private findTask(taskId: string): LocalBranchTask | null {
    if (!isId(taskId)) throw new HarnessError('LOCAL_BRANCH_INVALID_TASK_ID');
    const row = this.database.prepare('SELECT * FROM local_branch_tasks WHERE task_id = ?').get(taskId);
    if (!row) return null;
    const task = decode<LocalBranchTask>(row.payload, 'LOCAL_BRANCH_INVALID_STORED_TASK');
    this.assertTask(task);
    if (row.task_id !== task.taskId || row.plan_hash !== task.plan.planHash || row.status !== task.status) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_TASK');
    return task;
  }

  private requireTask(taskId: string): LocalBranchTask {
    const task = this.findTask(taskId);
    if (!task) throw new HarnessError('LOCAL_BRANCH_TASK_NOT_FOUND');
    return task;
  }

  private owned(taskId: string, ownerId: string, now: Date): LocalBranchTask {
    const task = this.requireTask(taskId);
    if (task.plan.ownerId !== ownerId) throw new HarnessError('LOCAL_BRANCH_OWNER_MISMATCH');
    if (now.toISOString() < task.updatedAt) throw new HarnessError('LOCAL_BRANCH_INVALID_TIME');
    this.assertRelations(task);
    return task;
  }

  private running(taskId: string, ownerId: string, now: Date): { task: LocalBranchTask; attempt: LocalBranchAttempt } {
    const task = this.owned(taskId, ownerId, now);
    const attempt = this.attempt(taskId);
    if (task.status !== 'RUNNING' || !attempt || attempt.status !== 'RUNNING') throw new HarnessError('LOCAL_BRANCH_NOT_RUNNING');
    return { task, attempt };
  }

  private active(taskId: string): LocalBranchApproval | null {
    const row = this.database.prepare('SELECT * FROM local_branch_approvals WHERE task_id = ? AND used_at IS NULL AND revoked_at IS NULL').get(taskId);
    return row ? this.parseApproval(row) : null;
  }

  private approvalById(approvalId: string): LocalBranchApproval {
    const row = this.database.prepare('SELECT * FROM local_branch_approvals WHERE approval_id = ?').get(approvalId);
    if (!row) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_APPROVAL');
    return this.parseApproval(row);
  }

  private parseApproval(row: Record<string, SQLOutputValue>): LocalBranchApproval {
    const approval = decode<LocalBranchApproval>(row.payload, 'LOCAL_BRANCH_INVALID_STORED_APPROVAL');
    this.assertApproval(approval);
    const task = this.requireTask(approval.taskId);
    if (row.approval_id !== approval.approvalId || row.task_id !== approval.taskId || row.used_at !== approval.usedAt
      || row.revoked_at !== approval.revokedAt || task.plan.planHash !== approval.planHash || task.plan.ownerId !== approval.ownerId) {
      throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_APPROVAL');
    }
    return approval;
  }

  private attempt(taskId: string): LocalBranchAttempt | null {
    const row = this.database.prepare('SELECT * FROM local_branch_attempts WHERE task_id = ?').get(taskId);
    if (!row) return null;
    const attempt = decode<LocalBranchAttempt>(row.payload, 'LOCAL_BRANCH_INVALID_STORED_ATTEMPT');
    const task = this.requireTask(taskId);
    this.assertAttempt(attempt, task.plan);
    const approval = this.approvalById(attempt.approvalId);
    if (row.attempt_id !== attempt.attemptId || row.task_id !== attempt.taskId || row.approval_id !== attempt.approvalId || row.status !== attempt.status
      || attempt.taskId !== taskId || attempt.planHash !== task.plan.planHash || approval.taskId !== taskId || approval.planHash !== attempt.planHash
      || approval.usedAt !== attempt.startedAt || attempt.generation > task.generation) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_ATTEMPT');
    return attempt;
  }

  private assertRelations(task: LocalBranchTask): void {
    const active = this.active(task.taskId);
    const attempt = this.attempt(task.taskId);
    if ((task.status === 'APPROVED') !== (active !== null)) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_TASK');
    if (task.status === 'RUNNING' || task.status === 'SUCCEEDED' || task.status === 'FAILED' || task.status === 'INTERRUPTED') {
      if (!attempt || attempt.status !== task.status) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_TASK');
    } else if (attempt && (attempt.status !== task.status || !terminal.includes(task.status))) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_TASK');
    if (attempt) {
      if ((attempt.finishedAt ?? attempt.refCreatedAt ?? attempt.writeStartedAt ?? attempt.startedAt) > task.updatedAt
        || (attempt.status !== 'RUNNING' && task.failureCode !== attempt.reason)) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_TASK');
    }
    const used = Number(this.database.prepare('SELECT COUNT(*) AS total FROM local_branch_approvals WHERE task_id = ? AND used_at IS NOT NULL').get(task.taskId)?.total ?? 0);
    if (used !== (attempt ? 1 : 0)) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_TASK');
  }

  private assertTask(task: LocalBranchTask): void {
    if (!exactKeys(task, ['taskId', 'plan', 'status', 'generation', 'cancelledAt', 'failureCode', 'updatedAt']) || !isId(task.taskId)
      || !['AWAITING_APPROVAL', 'APPROVED', 'RUNNING', ...terminal].includes(task.status)
      || ![0, 1].includes(task.generation) || !isTime(task.updatedAt)
      || (task.cancelledAt !== null && !isTime(task.cancelledAt)) || (task.failureCode !== null && !isCode(task.failureCode))) {
      throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_TASK');
    }
    assertLocalBranchPlan(task.plan);
    this.assertRoot(task.plan);
    if (task.taskId !== task.plan.taskId || task.updatedAt < task.plan.createdAt
      || (task.cancelledAt === null ? task.generation !== 0 : task.generation !== 1 || task.cancelledAt < task.plan.createdAt || task.cancelledAt > task.updatedAt)
      || (task.cancelledAt !== null && !['RUNNING', 'CANCELLED', 'BLOCKED'].includes(task.status))) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_TASK');
  }

  private assertApproval(approval: LocalBranchApproval): void {
    if (!exactKeys(approval, ['approvalId', 'taskId', 'ownerId', 'planHash', 'planSnapshot', 'createdAt', 'expiresAt', 'usedAt', 'revokedAt', 'reason'])
      || !isId(approval.approvalId) || !isId(approval.taskId) || !isTime(approval.createdAt) || !isTime(approval.expiresAt)
      || (approval.usedAt !== null && !isTime(approval.usedAt)) || (approval.revokedAt !== null && !isTime(approval.revokedAt))
      || (approval.reason !== null && !isCode(approval.reason))) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_APPROVAL');
    assertLocalBranchPlan(approval.planSnapshot);
    if (approval.taskId !== approval.planSnapshot.taskId || approval.planHash !== approval.planSnapshot.planHash || approval.ownerId !== approval.planSnapshot.ownerId
      || approval.createdAt < approval.planSnapshot.createdAt || approval.expiresAt <= approval.createdAt || approval.expiresAt > approval.planSnapshot.expiresAt
      || Date.parse(approval.expiresAt) - Date.parse(approval.createdAt) > 3_600_000
      || (approval.usedAt !== null && (approval.revokedAt !== null || approval.usedAt < approval.createdAt || approval.usedAt >= approval.expiresAt))
      || (approval.revokedAt !== null && approval.revokedAt < approval.createdAt)
      || (approval.reason === null) !== (approval.revokedAt === null)) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_APPROVAL');
  }

  private assertAttempt(attempt: LocalBranchAttempt, plan: LocalBranchPlan): void {
    if (!exactKeys(attempt, ['attemptId', 'taskId', 'approvalId', 'planHash', 'generation', 'phase', 'status', 'startedAt', 'writeStartedAt', 'refCreatedAt', 'finishedAt', 'reason', 'before', 'after'])
      || !isId(attempt.attemptId) || !isId(attempt.taskId) || !isId(attempt.approvalId) || attempt.generation !== 0 || !isTime(attempt.startedAt)
      || !['claimed', 'writing', 'created', 'finished'].includes(attempt.phase) || !['RUNNING', ...terminal].includes(attempt.status)
      || (attempt.writeStartedAt !== null && (!isTime(attempt.writeStartedAt) || attempt.writeStartedAt < attempt.startedAt))
      || (attempt.refCreatedAt !== null && (!isTime(attempt.refCreatedAt) || attempt.writeStartedAt === null || attempt.refCreatedAt < attempt.writeStartedAt))
      || (attempt.reason !== null && !isCode(attempt.reason))) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_ATTEMPT');
    assertLocalBranchObservation(attempt.before, plan);
    if (attempt.before.state !== 'absent') throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_ATTEMPT');
    if (attempt.status === 'RUNNING') {
      if (attempt.phase === 'finished' || attempt.finishedAt !== null || attempt.reason !== null || attempt.after !== null
        || (attempt.phase === 'claimed' ? attempt.writeStartedAt !== null || attempt.refCreatedAt !== null
          : attempt.phase === 'writing' ? attempt.writeStartedAt === null || attempt.refCreatedAt !== null : attempt.refCreatedAt === null)) {
        throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_ATTEMPT');
      }
    } else {
      if (attempt.phase !== 'finished' || !isTime(attempt.finishedAt) || attempt.finishedAt < (attempt.refCreatedAt ?? attempt.writeStartedAt ?? attempt.startedAt)
        || attempt.after === null) throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_ATTEMPT');
      assertLocalBranchObservation(attempt.after, plan);
      if (attempt.status === 'SUCCEEDED' ? attempt.after.state !== 'created' || attempt.refCreatedAt === null || attempt.reason !== null : attempt.reason === null) {
        throw new HarnessError('LOCAL_BRANCH_INVALID_STORED_ATTEMPT');
      }
    }
  }

  private assertRoot(plan: LocalBranchPlan): void {
    if (plan.repository.root !== join(dirname(this.filePath), 'git-branches', plan.taskId)) throw new HarnessError('LOCAL_BRANCH_ROOT_MISMATCH');
  }

  private writeTask(task: LocalBranchTask): void {
    this.assertTask(task);
    this.database.prepare('UPDATE local_branch_tasks SET status = ?, payload = ? WHERE task_id = ?').run(task.status, JSON.stringify(task), task.taskId);
  }

  private writeApproval(approval: LocalBranchApproval): void {
    this.assertApproval(approval);
    this.database.prepare('UPDATE local_branch_approvals SET used_at = ?, revoked_at = ?, payload = ? WHERE approval_id = ?')
      .run(approval.usedAt, approval.revokedAt, JSON.stringify(approval), approval.approvalId);
  }

  private writeAttempt(attempt: LocalBranchAttempt): void {
    this.assertAttempt(attempt, this.requireTask(attempt.taskId).plan);
    this.database.prepare('UPDATE local_branch_attempts SET status = ?, payload = ? WHERE attempt_id = ?').run(attempt.status, JSON.stringify(attempt), attempt.attemptId);
  }

  private protectFiles(): void {
    if (!isAbsolute(this.filePath)) throw new HarnessError('UNSAFE_RUNTIME_PATH');
    const directory = dirname(this.filePath);
    const metadata = lstatSync(directory);
    if (!process.getuid || !metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
      || (metadata.mode & 0o077) !== 0 || realpathSync(directory) !== directory) throw new HarnessError('UNSAFE_RUNTIME_PATH');
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const path = `${this.filePath}${suffix}`;
      assertRuntimeFile(path);
      const file = runtimePathMetadata(path);
      if (file && (file.uid !== process.getuid() || (file.mode & 0o077) !== 0)) throw new HarnessError('UNSAFE_RUNTIME_FILE');
    }
  }

  private outcome<T>(operation: () => T | HarnessError): T {
    const result = this.transaction(operation);
    if (result instanceof HarnessError) throw result;
    return result;
  }

  private transaction<T>(operation: () => T): T {
    if (this.transactionOpen) throw new HarnessError('LOCAL_BRANCH_TRANSACTION_IN_PROGRESS');
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
