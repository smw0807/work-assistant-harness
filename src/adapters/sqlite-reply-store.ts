import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import type {
  ReplyApproval, ReplyApprovalRequest, ReplyAttempt, ReplyClaim, ReplyControl,
  ReplyDeliveryResult, ReplyPlan, ReplySnapshot, ReplyTask,
} from '../domain/reply.js';
import type { ReplyStore } from '../ports/reply.js';
import {
  assertReplyBody, assertReplyOwner, assertReplyPlan, assertReplyReady,
  assertReplyTime, validateReplyApproval,
} from '../policy/reply-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

const taskKeys = ['taskId', 'plan', 'status', 'generation', 'requestRevision', 'contextRevision', 'invalidatedAt', 'failureCode', 'updatedAt'];
const approvalKeys = ['approvalId', 'taskId', 'ownerId', 'planHash', 'planSnapshot', 'createdAt', 'expiresAt', 'usedAt', 'revokedAt', 'reason'];
const attemptKeys = ['attemptId', 'taskId', 'approvalId', 'planHash', 'generation', 'status', 'startedAt', 'finishedAt', 'reason', 'receiptId'];
const controlKeys = ['taskId', 'eventId', 'kind', 'revision'];
const statuses = ['AWAITING_APPROVAL', 'APPROVED', 'SENDING', 'SIMULATED', 'FAILED', 'UNKNOWN', 'BLOCKED', 'CANCELLED'];
const terminalStatuses = ['SIMULATED', 'FAILED', 'UNKNOWN', 'BLOCKED', 'CANCELLED'];
const controlKinds = ['cancel', 'edited', 'deleted', 'reply', 'gap', 'incomplete', 'expired'];
const digest = /^[a-f0-9]{64}$/;
const isCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
const isReceipt = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1_000_000_000;
const hasKeys = (value: unknown, keys: string[]): boolean => Boolean(value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)));
const decode = <T>(payload: unknown, code: string): T => {
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > 65_536) throw new HarnessError(code);
  try { return JSON.parse(payload) as T; } catch { throw new HarnessError(code); }
};

const assertContext = (ownerId: string, now: Date): void => {
  assertReplyTime(now);
  assertReplyOwner(ownerId);
  if (typeof process.getuid !== 'function' || ownerId !== `os-user:${process.getuid()}`) {
    throw new HarnessError('REPLY_OWNER_MISMATCH');
  }
};

/** 답장 본문은 만료 가능한 별도 테이블에만 저장하고 승인 소비와 시도 생성을 함께 확정한다. */
export class SqliteReplyStore implements ReplyStore {
  private readonly database: DatabaseSync;
  private transactionOpen = false;

  constructor(private readonly filePath: string) {
    this.assertDirectory();
    this.protectFiles();
    const existingFile = runtimePathMetadata(filePath) !== null;
    this.database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    if (!existingFile) chmodSync(filePath, 0o600);
    this.protectFiles();
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS reply_tasks (
        task_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reply_bodies (
        task_id TEXT PRIMARY KEY REFERENCES reply_tasks(task_id), body TEXT NOT NULL, expires_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reply_approvals (
        approval_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES reply_tasks(task_id), owner_id TEXT NOT NULL,
        used_at TEXT, revoked_at TEXT, expires_at TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS reply_approvals_one_active
        ON reply_approvals(task_id) WHERE used_at IS NULL AND revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS reply_attempts (
        attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES reply_tasks(task_id),
        approval_id TEXT NOT NULL UNIQUE REFERENCES reply_approvals(approval_id), status TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS reply_attempts_one_uncertain
        ON reply_attempts(task_id) WHERE status IN ('SENDING', 'UNKNOWN', 'SIMULATED');
      CREATE TABLE IF NOT EXISTS reply_control_events (
        event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES reply_tasks(task_id), request TEXT NOT NULL, recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reply_tombstones (
        task_id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL
      ) STRICT;
    `);
    this.protectFiles();
  }

  create(plan: ReplyPlan, body: string, now: Date): ReplyTask {
    assertContext(plan.ownerId, now);
    assertReplyPlan(plan);
    assertReplyBody(body, plan);
    if (now.toISOString() < plan.createdAt) throw new HarnessError('REPLY_INVALID_TIME');
    return this.transaction(() => {
      const existing = this.findTask(plan.taskId);
      if (existing) {
        if (existing.plan.planHash !== plan.planHash) throw new HarnessError('REPLY_TASK_CONFLICT');
        return existing;
      }
      if (this.database.prepare('SELECT task_id FROM reply_tombstones WHERE task_id = ?').get(plan.taskId)) {
        throw new HarnessError('REPLY_TASK_PURGED');
      }
      const task: ReplyTask = {
        taskId: plan.taskId, plan: structuredClone(plan), status: plan.source.complete && !plan.source.gap ? 'AWAITING_APPROVAL' : 'BLOCKED', generation: 0,
        requestRevision: plan.source.requestRevision, contextRevision: plan.source.contextRevision,
        invalidatedAt: null, failureCode: plan.source.complete && !plan.source.gap ? null : 'REPLY_CONTEXT_INVALID', updatedAt: now.toISOString(),
      };
      this.assertTask(task);
      this.database.prepare('INSERT INTO reply_tasks(task_id, status, updated_at, payload) VALUES (?, ?, ?, ?)')
        .run(task.taskId, task.status, task.updatedAt, JSON.stringify(task));
      this.database.prepare('INSERT INTO reply_bodies(task_id, body, expires_at) VALUES (?, ?, ?)')
        .run(task.taskId, body, plan.expiresAt);
      this.database.prepare('INSERT INTO reply_tombstones(task_id, plan_hash) VALUES (?, ?)').run(task.taskId, plan.planHash);
      return this.maintainTask(task, now).task;
    });
  }

  inspect(taskId: string, ownerId: string, now: Date, approvalOffset = 0): ReplySnapshot {
    assertContext(ownerId, now);
    this.assertOffset(approvalOffset);
    return this.transaction(() => {
      const task = this.requireOwnedTask(taskId, ownerId, now);
      return this.snapshot(this.maintainTask(task, now).task, approvalOffset);
    });
  }

  approve(request: ReplyApprovalRequest, ownerId: string, now: Date): ReplyApproval {
    assertContext(ownerId, now);
    if (!hasKeys(request, ['taskId', 'planHash', 'expiresInMinutes']) || !isText(request.taskId)
      || typeof request.planHash !== 'string' || !digest.test(request.planHash)
      || !Number.isSafeInteger(request.expiresInMinutes) || request.expiresInMinutes < 1 || request.expiresInMinutes > 60) {
      throw new HarnessError('REPLY_INVALID_APPROVAL');
    }
    const outcome = this.transaction((): ReplyApproval | HarnessError => {
      const current = this.requireOwnedTask(request.taskId, ownerId, now);
      const { task } = this.maintainTask(current, now);
      const body = this.readBody(task);
      try { validateReplyApproval(task, body, request, ownerId, now); } catch (error) {
        if (error instanceof HarnessError) return error;
        throw error;
      }
      if (this.hasUncertainAttempt(task.taskId)) return new HarnessError('REPLY_ALREADY_ATTEMPTED');
      if (this.activeApproval(task.taskId)) return new HarnessError('REPLY_APPROVAL_EXISTS');
      if (!['AWAITING_APPROVAL', 'FAILED'].includes(task.status)) return new HarnessError('REPLY_NOT_AWAITING_APPROVAL');
      const approval: ReplyApproval = {
        approvalId: randomUUID(), taskId: task.taskId, ownerId, planHash: task.plan.planHash,
        planSnapshot: structuredClone(task.plan), createdAt: now.toISOString(),
        expiresAt: new Date(Math.min(now.getTime() + request.expiresInMinutes * 60_000, Date.parse(task.plan.expiresAt))).toISOString(),
        usedAt: null, revokedAt: null, reason: null,
      };
      this.assertApproval(approval);
      this.database.prepare(`INSERT INTO reply_approvals
        (approval_id, task_id, owner_id, used_at, revoked_at, expires_at, payload) VALUES (?, ?, ?, NULL, NULL, ?, ?)`)
        .run(approval.approvalId, task.taskId, ownerId, approval.expiresAt, JSON.stringify(approval));
      this.writeTask({ ...task, status: 'APPROVED', failureCode: null, updatedAt: now.toISOString() });
      return approval;
    });
    if (outcome instanceof HarnessError) throw outcome;
    return outcome;
  }

  claim(taskId: string, planHash: string, ownerId: string, now: Date): ReplyClaim {
    assertContext(ownerId, now);
    const outcome = this.transaction((): ReplyClaim | HarnessError => {
      const current = this.requireOwnedTask(taskId, ownerId, now);
      const { task, expiredApproval } = this.maintainTask(current, now);
      const body = this.readBody(task);
      try { assertReplyReady(task, body, ownerId, now); } catch (error) {
        if (error instanceof HarnessError) return error;
        throw error;
      }
      if (planHash !== task.plan.planHash) return new HarnessError('REPLY_PLAN_HASH_MISMATCH');
      if (this.hasUncertainAttempt(taskId)) return new HarnessError('REPLY_ALREADY_ATTEMPTED');
      const approval = this.activeApproval(taskId);
      if (!approval) return new HarnessError(expiredApproval ? 'REPLY_APPROVAL_EXPIRED' : 'REPLY_APPROVAL_REQUIRED');
      if (task.status !== 'APPROVED') return new HarnessError('REPLY_NOT_APPROVED');
      if (approval.ownerId !== ownerId || approval.planHash !== planHash
        || approval.planSnapshot.planHash !== task.plan.planHash) return new HarnessError('REPLY_APPROVAL_MISMATCH');
      const consumed: ReplyApproval = { ...approval, usedAt: now.toISOString() };
      this.writeApproval(consumed);
      const attempt: ReplyAttempt = {
        attemptId: randomUUID(), taskId, approvalId: approval.approvalId, planHash,
        generation: task.generation, status: 'SENDING', startedAt: now.toISOString(), finishedAt: null, reason: null, receiptId: null,
      };
      this.assertAttempt(attempt);
      this.database.prepare('INSERT INTO reply_attempts(attempt_id, task_id, approval_id, status, payload) VALUES (?, ?, ?, ?, ?)')
        .run(attempt.attemptId, taskId, attempt.approvalId, attempt.status, JSON.stringify(attempt));
      const sending: ReplyTask = { ...task, status: 'SENDING', updatedAt: now.toISOString() };
      this.writeTask(sending);
      return { task: sending, body: body!, attempt };
    });
    if (outcome instanceof HarnessError) throw outcome;
    return outcome;
  }

  finish(attemptId: string, result: ReplyDeliveryResult, now: Date): ReplyAttempt {
    assertReplyTime(now);
    if (!hasKeys(result, ['status', 'reason', 'receiptId']) || !['SIMULATED', 'NOT_SENT', 'UNKNOWN'].includes(result.status)
      || (result.reason !== null && !isCode(result.reason)) || (result.receiptId !== null && !isReceipt(result.receiptId))) {
      throw new HarnessError('REPLY_INVALID_RESULT');
    }
    return this.transaction(() => {
      const attempt = this.requireAttempt(attemptId);
      const task = this.requireOwnedTask(attempt.taskId, `os-user:${process.getuid?.()}`, now);
      const expectedResult = result.status === 'SIMULATED'
        ? result.reason === null && result.receiptId === `mock:${attemptId}`
        : result.status === 'NOT_SENT' ? result.reason === 'MOCK_NOT_SENT' && result.receiptId === null
          : ['MOCK_RESULT_UNKNOWN', 'REPLY_DELIVERY_UNCERTAIN'].includes(result.reason ?? '') && result.receiptId === null;
      if (!expectedResult) throw new HarnessError('REPLY_INVALID_RESULT');
      if (attempt.status !== 'SENDING') throw new HarnessError('REPLY_ATTEMPT_ALREADY_FINISHED');
      if (attempt.generation !== task.generation || task.invalidatedAt !== null || task.status !== 'SENDING') {
        throw new HarnessError('REPLY_INVALIDATED');
      }
      if (now.toISOString() < attempt.startedAt) throw new HarnessError('REPLY_INVALID_TIME');
      const finished: ReplyAttempt = { ...attempt, ...result, finishedAt: now.toISOString() };
      this.writeAttempt(finished);
      this.writeTask({ ...task, status: result.status === 'NOT_SENT' ? 'FAILED' : result.status,
        failureCode: result.reason, updatedAt: now.toISOString() });
      return finished;
    });
  }

  control(event: ReplyControl, ownerId: string, now: Date): ReplyTask {
    assertContext(ownerId, now);
    if (!hasKeys(event, controlKeys) || !isText(event.taskId) || !isReceipt(event.eventId)
      || !controlKinds.includes(event.kind) || !isRevision(event.revision)) throw new HarnessError('REPLY_INVALID_CONTROL');
    return this.transaction(() => {
      const task = this.requireOwnedTask(event.taskId, ownerId, now);
      const eventPayload = JSON.stringify({ taskId: event.taskId, eventId: event.eventId, kind: event.kind, revision: event.revision });
      const previous = this.database.prepare('SELECT task_id, request FROM reply_control_events WHERE event_id = ?').get(event.eventId);
      if (previous) {
        if (previous.task_id !== event.taskId || previous.request !== eventPayload) throw new HarnessError('REPLY_CONTROL_CONFLICT');
        return task;
      }
      this.database.prepare('INSERT INTO reply_control_events(event_id, task_id, request, recorded_at) VALUES (?, ?, ?, ?)')
        .run(event.eventId, event.taskId, eventPayload, now.toISOString());
      const requestControl = ['edited', 'deleted'].includes(event.kind);
      const currentRevision = requestControl ? task.requestRevision : task.contextRevision;
      if (event.kind !== 'cancel' && event.revision <= currentRevision) return task;
      return this.invalidate({ ...task,
        requestRevision: requestControl ? event.revision : task.requestRevision,
        contextRevision: requestControl ? task.contextRevision : Math.max(task.contextRevision, event.revision),
      }, event.kind === 'cancel' ? 'REPLY_CANCELLED' : `REPLY_SOURCE_${event.kind.toUpperCase()}`, now, event.kind === 'cancel');
    });
  }

  recover(taskId: string, ownerId: string, now: Date): ReplySnapshot {
    assertContext(ownerId, now);
    return this.transaction(() => {
      let task = this.requireOwnedTask(taskId, ownerId, now);
      if (task.status === 'SENDING') {
        this.markSendingUnknown(task, 'REPLY_RECOVERED_UNCERTAIN', now);
        task = { ...task, status: 'UNKNOWN', failureCode: 'REPLY_RECOVERED_UNCERTAIN', updatedAt: now.toISOString() };
        this.writeTask(task);
      }
      return this.snapshot(this.maintainTask(task, now).task, 0);
    });
  }

  maintain(now: Date): { expiredBodies: number; expiredAudits: number } {
    assertReplyTime(now);
    return this.transaction(() => {
      let expiredBodies = 0;
      let expiredAudits = 0;
      const rows = this.database.prepare('SELECT task_id FROM reply_tasks ORDER BY task_id').all();
      for (const row of rows) {
        const task = this.requireTask(String(row.task_id));
        if (now.toISOString() < task.updatedAt) continue;
        const maintained = this.maintainTask(task, now);
        expiredBodies += maintained.expiredBody ? 1 : 0;
        const retentionDays = maintained.task.plan.retention.auditRetentionDays;
        if (retentionDays === null || !terminalStatuses.includes(maintained.task.status)
          || now.getTime() < Date.parse(maintained.task.updatedAt) + retentionDays * 86_400_000) continue;
        this.database.prepare('DELETE FROM reply_bodies WHERE task_id = ?').run(task.taskId);
        this.database.prepare('DELETE FROM reply_control_events WHERE task_id = ?').run(task.taskId);
        this.database.prepare('DELETE FROM reply_attempts WHERE task_id = ?').run(task.taskId);
        this.database.prepare('DELETE FROM reply_approvals WHERE task_id = ?').run(task.taskId);
        this.database.prepare('DELETE FROM reply_tasks WHERE task_id = ?').run(task.taskId);
        expiredAudits += 1;
      }
      return { expiredBodies, expiredAudits };
    });
  }

  close(): void { this.database.close(); }

  private snapshot(task: ReplyTask, offset: number): ReplySnapshot {
    const count = this.database.prepare('SELECT COUNT(*) AS total FROM reply_approvals WHERE task_id = ?').get(task.taskId);
    const total = Number(count?.total ?? 0);
    const approvals = this.database.prepare('SELECT * FROM reply_approvals WHERE task_id = ? ORDER BY rowid DESC LIMIT 1 OFFSET ?')
      .all(task.taskId, offset).map((row) => this.parseApproval(row));
    const attempts = this.database.prepare('SELECT * FROM reply_attempts WHERE task_id = ? ORDER BY rowid DESC LIMIT 20')
      .all(task.taskId).map((row) => this.parseAttempt(row));
    const attemptCount = this.database.prepare('SELECT COUNT(*) AS total FROM reply_attempts WHERE task_id = ?').get(task.taskId);
    return { task, body: this.readBody(task), approvals,
      approvalPage: { offset, total, nextOffset: approvals.length > 0 && offset + approvals.length < total ? offset + approvals.length : null },
      attempts, attemptTotal: Number(attemptCount?.total ?? 0) };
  }

  private maintainTask(current: ReplyTask, now: Date): { task: ReplyTask; expiredBody: boolean; expiredApproval: boolean } {
    let task = current;
    let expiredBody = false;
    let expiredApproval = false;
    const bodyRow = this.database.prepare('SELECT body, expires_at FROM reply_bodies WHERE task_id = ?').get(task.taskId);
    if (bodyRow) {
      if (bodyRow.expires_at !== task.plan.expiresAt || typeof bodyRow.body !== 'string') throw new HarnessError('REPLY_INVALID_STORED_BODY');
      if (now.getTime() >= Date.parse(task.plan.expiresAt)) {
        this.database.prepare('DELETE FROM reply_bodies WHERE task_id = ?').run(task.taskId);
        expiredBody = true;
        if (task.invalidatedAt === null && !terminalStatuses.includes(task.status)) {
          task = this.invalidate(task, 'REPLY_PAYLOAD_EXPIRED', now, false);
        }
      }
    } else if (task.invalidatedAt === null && !terminalStatuses.includes(task.status)) {
      task = this.invalidate(task, 'REPLY_PAYLOAD_MISSING', now, false);
    }
    const approval = this.activeApproval(task.taskId);
    if (approval && now.getTime() >= Date.parse(approval.expiresAt)) {
      this.writeApproval({ ...approval, revokedAt: now.toISOString(), reason: 'REPLY_APPROVAL_EXPIRED' });
      expiredApproval = true;
      if (task.status === 'APPROVED') {
        task = { ...task, status: 'AWAITING_APPROVAL', failureCode: 'REPLY_APPROVAL_EXPIRED', updatedAt: now.toISOString() };
        this.writeTask(task);
      }
    }
    return { task, expiredBody, expiredApproval };
  }

  private invalidate(task: ReplyTask, reason: string, now: Date, cancel: boolean): ReplyTask {
    const approval = this.activeApproval(task.taskId);
    if (approval) this.writeApproval({ ...approval, revokedAt: now.toISOString(), reason });
    let status: ReplyTask['status'] = task.status === 'SIMULATED' || task.status === 'UNKNOWN' ? task.status : cancel ? 'CANCELLED' : 'BLOCKED';
    if (task.status === 'SENDING') {
      this.markSendingUnknown(task, reason, now);
      status = 'UNKNOWN';
    }
    const invalidated: ReplyTask = { ...task, status, generation: task.generation + 1,
      invalidatedAt: now.toISOString(), failureCode: reason, updatedAt: now.toISOString() };
    this.writeTask(invalidated);
    return invalidated;
  }

  private markSendingUnknown(task: ReplyTask, reason: string, now: Date): void {
    const rows = this.database.prepare("SELECT * FROM reply_attempts WHERE task_id = ? AND status = 'SENDING'").all(task.taskId);
    for (const row of rows) this.writeAttempt({ ...this.parseAttempt(row), status: 'UNKNOWN', reason, finishedAt: now.toISOString(), receiptId: null });
  }

  private readBody(task: ReplyTask): string | null {
    const row = this.database.prepare('SELECT body, expires_at FROM reply_bodies WHERE task_id = ?').get(task.taskId);
    if (!row) return null;
    if (typeof row.body !== 'string' || row.expires_at !== task.plan.expiresAt) throw new HarnessError('REPLY_INVALID_STORED_BODY');
    assertReplyBody(row.body, task.plan);
    return row.body;
  }

  private findTask(taskId: string): ReplyTask | null {
    const row = this.database.prepare('SELECT * FROM reply_tasks WHERE task_id = ?').get(taskId);
    if (!row) return null;
    const task = decode<ReplyTask>(row.payload, 'REPLY_INVALID_STORED_TASK');
    this.assertTask(task);
    if (row.task_id !== task.taskId || row.status !== task.status || row.updated_at !== task.updatedAt) throw new HarnessError('REPLY_INVALID_STORED_TASK');
    const tombstone = this.database.prepare('SELECT plan_hash FROM reply_tombstones WHERE task_id = ?').get(taskId);
    if (!tombstone || tombstone.plan_hash !== task.plan.planHash) throw new HarnessError('REPLY_INVALID_STORED_TASK');
    return task;
  }

  private requireTask(taskId: string): ReplyTask {
    const task = this.findTask(taskId);
    if (!task) throw new HarnessError('REPLY_TASK_NOT_FOUND');
    return task;
  }

  private requireOwnedTask(taskId: string, ownerId: string, now: Date): ReplyTask {
    const task = this.requireTask(taskId);
    if (task.plan.ownerId !== ownerId) throw new HarnessError('REPLY_OWNER_MISMATCH');
    if (now.toISOString() < task.updatedAt) throw new HarnessError('REPLY_INVALID_TIME');
    return task;
  }

  private activeApproval(taskId: string): ReplyApproval | null {
    const row = this.database.prepare('SELECT * FROM reply_approvals WHERE task_id = ? AND used_at IS NULL AND revoked_at IS NULL').get(taskId);
    return row ? this.parseApproval(row) : null;
  }

  private hasUncertainAttempt(taskId: string): boolean {
    const row = this.database.prepare("SELECT * FROM reply_attempts WHERE task_id = ? AND status IN ('SENDING', 'UNKNOWN', 'SIMULATED') LIMIT 1").get(taskId);
    if (!row) return false;
    this.parseAttempt(row);
    return true;
  }

  private requireAttempt(attemptId: string): ReplyAttempt {
    const row = this.database.prepare('SELECT * FROM reply_attempts WHERE attempt_id = ?').get(attemptId);
    if (!row) throw new HarnessError('REPLY_ATTEMPT_NOT_FOUND');
    return this.parseAttempt(row);
  }

  private parseApproval(row: Record<string, SQLOutputValue>): ReplyApproval {
    const approval = decode<ReplyApproval>(row.payload, 'REPLY_INVALID_STORED_APPROVAL');
    this.assertApproval(approval);
    if (row.approval_id !== approval.approvalId || row.task_id !== approval.taskId || row.owner_id !== approval.ownerId
      || row.used_at !== approval.usedAt || row.revoked_at !== approval.revokedAt || row.expires_at !== approval.expiresAt) {
      throw new HarnessError('REPLY_INVALID_STORED_APPROVAL');
    }
    return approval;
  }

  private parseAttempt(row: Record<string, SQLOutputValue>): ReplyAttempt {
    const attempt = decode<ReplyAttempt>(row.payload, 'REPLY_INVALID_STORED_ATTEMPT');
    this.assertAttempt(attempt);
    if (row.attempt_id !== attempt.attemptId || row.task_id !== attempt.taskId || row.approval_id !== attempt.approvalId || row.status !== attempt.status) {
      throw new HarnessError('REPLY_INVALID_STORED_ATTEMPT');
    }
    const approvalRow = this.database.prepare('SELECT * FROM reply_approvals WHERE approval_id = ?').get(attempt.approvalId);
    if (!approvalRow) throw new HarnessError('REPLY_INVALID_STORED_ATTEMPT');
    const approval = this.parseApproval(approvalRow);
    const task = this.requireTask(attempt.taskId);
    if (approval.taskId !== attempt.taskId || approval.planHash !== attempt.planHash || approval.usedAt !== attempt.startedAt
      || task.plan.planHash !== attempt.planHash || attempt.generation > task.generation) throw new HarnessError('REPLY_INVALID_STORED_ATTEMPT');
    return attempt;
  }

  private assertTask(task: ReplyTask): void {
    if (!hasKeys(task, taskKeys) || !isText(task.taskId) || !statuses.includes(task.status)
      || !Number.isSafeInteger(task.generation) || task.generation < 0 || !isRevision(task.requestRevision) || !isRevision(task.contextRevision)
      || (task.invalidatedAt !== null && !isTimestamp(task.invalidatedAt)) || (task.failureCode !== null && !isCode(task.failureCode))
      || !isTimestamp(task.updatedAt)) throw new HarnessError('REPLY_INVALID_STORED_TASK');
    assertReplyPlan(task.plan);
    if (task.taskId !== task.plan.taskId || task.updatedAt < task.plan.createdAt
      || task.requestRevision < task.plan.source.requestRevision || task.contextRevision < task.plan.source.contextRevision
      || (task.invalidatedAt === null && (task.generation !== 0 || task.requestRevision !== task.plan.source.requestRevision
        || task.contextRevision !== task.plan.source.contextRevision))
      || (task.invalidatedAt !== null && (task.generation < 1 || task.invalidatedAt > task.updatedAt))) {
      throw new HarnessError('REPLY_INVALID_STORED_TASK');
    }
  }

  private assertApproval(approval: ReplyApproval): void {
    if (!hasKeys(approval, approvalKeys) || !isText(approval.approvalId) || !isText(approval.taskId)
      || !digest.test(approval.planHash) || !isTimestamp(approval.createdAt) || !isTimestamp(approval.expiresAt)
      || (approval.usedAt !== null && !isTimestamp(approval.usedAt)) || (approval.revokedAt !== null && !isTimestamp(approval.revokedAt))
      || (approval.reason !== null && !isCode(approval.reason))) throw new HarnessError('REPLY_INVALID_STORED_APPROVAL');
    assertReplyOwner(approval.ownerId);
    assertReplyPlan(approval.planSnapshot);
    if (approval.taskId !== approval.planSnapshot.taskId || approval.ownerId !== approval.planSnapshot.ownerId
      || approval.planHash !== approval.planSnapshot.planHash || approval.createdAt < approval.planSnapshot.createdAt
      || approval.expiresAt <= approval.createdAt || Date.parse(approval.expiresAt) - Date.parse(approval.createdAt) > 3_600_000
      || approval.expiresAt > approval.planSnapshot.expiresAt
      || (approval.usedAt !== null && (approval.revokedAt !== null || approval.usedAt < approval.createdAt || approval.usedAt >= approval.expiresAt))
      || (approval.revokedAt !== null && approval.revokedAt < approval.createdAt)) throw new HarnessError('REPLY_INVALID_STORED_APPROVAL');
  }

  private assertAttempt(attempt: ReplyAttempt): void {
    if (!hasKeys(attempt, attemptKeys) || !isText(attempt.attemptId) || !isText(attempt.taskId) || !isText(attempt.approvalId)
      || !digest.test(attempt.planHash) || !Number.isSafeInteger(attempt.generation) || attempt.generation < 0
      || !['SENDING', 'SIMULATED', 'NOT_SENT', 'UNKNOWN'].includes(attempt.status) || !isTimestamp(attempt.startedAt)
      || (attempt.reason !== null && !isCode(attempt.reason)) || (attempt.receiptId !== null && !isReceipt(attempt.receiptId))
      || (attempt.status === 'SENDING' ? attempt.finishedAt !== null : !isTimestamp(attempt.finishedAt))
      || (attempt.finishedAt !== null && attempt.finishedAt < attempt.startedAt)) throw new HarnessError('REPLY_INVALID_STORED_ATTEMPT');
  }

  private writeTask(task: ReplyTask): void {
    this.assertTask(task);
    this.database.prepare('UPDATE reply_tasks SET status = ?, updated_at = ?, payload = ? WHERE task_id = ?')
      .run(task.status, task.updatedAt, JSON.stringify(task), task.taskId);
  }

  private writeApproval(approval: ReplyApproval): void {
    this.assertApproval(approval);
    this.database.prepare('UPDATE reply_approvals SET used_at = ?, revoked_at = ?, payload = ? WHERE approval_id = ?')
      .run(approval.usedAt, approval.revokedAt, JSON.stringify(approval), approval.approvalId);
  }

  private writeAttempt(attempt: ReplyAttempt): void {
    this.assertAttempt(attempt);
    this.database.prepare('UPDATE reply_attempts SET status = ?, payload = ? WHERE attempt_id = ?')
      .run(attempt.status, JSON.stringify(attempt), attempt.attemptId);
  }

  private assertOffset(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000_000) throw new HarnessError('REPLY_INVALID_APPROVAL_OFFSET');
  }

  private assertDirectory(): void {
    if (!isAbsolute(this.filePath)) throw new HarnessError('UNSAFE_RUNTIME_PATH');
    const directory = dirname(this.filePath);
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(directory) !== directory
      || typeof process.getuid !== 'function' || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
      throw new HarnessError('UNSAFE_RUNTIME_PATH');
    }
  }

  private protectFiles(): void {
    this.assertDirectory();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const path = `${this.filePath}${suffix}`;
      assertRuntimeFile(path);
      const metadata = runtimePathMetadata(path);
      if (!metadata) continue;
      if (typeof process.getuid !== 'function' || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
        throw new HarnessError('UNSAFE_RUNTIME_FILE');
      }
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.transactionOpen) throw new HarnessError('REPLY_TRANSACTION_IN_PROGRESS');
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
