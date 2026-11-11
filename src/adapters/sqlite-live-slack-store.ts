import { randomUUID } from 'node:crypto';
import { chmodSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import type { LiveApproval, LiveAttempt, LiveClaim, LiveDeliveryResult, LivePlan, LiveSnapshot, LiveSource, LiveTask } from '../domain/live-slack.js';
import type { LiveSlackStore } from '../ports/live-slack.js';
import {
  assertLiveCurrent, assertLiveOwner, assertLivePlan, compareLiveTimestamp, liveAuditRetentionMs, liveDate, liveDigest,
  liveKeys, liveTargetKey, liveTestBody, liveTimestamp, liveUuid,
} from '../policy/live-slack-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

const statuses = ['AWAITING_APPROVAL', 'APPROVED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'BLOCKED', 'CANCELLED'];
const terminal = ['SENT', 'FAILED', 'UNKNOWN', 'BLOCKED', 'CANCELLED'];
const safeCode = (value: unknown): boolean => value === null || (typeof value === 'string' && /^(LIVE|SLACK)_[A-Z0-9_]{1,100}$/.test(value));
const decode = <T>(value: unknown): T => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 32_768) throw new HarnessError('LIVE_INVALID_STORED_RECORD');
  try { return JSON.parse(value) as T; } catch { throw new HarnessError('LIVE_INVALID_STORED_RECORD'); }
};

/** 승인 소비·시도·대상 중복 marker를 한 트랜잭션으로 고정한다. 본문은 저장하지 않는다. */
export class SqliteLiveSlackStore implements LiveSlackStore {
  private readonly database: DatabaseSync;

  constructor(private readonly filePath: string) {
    if (!isAbsolute(filePath) || basename(filePath) !== 'live-replies.sqlite') throw new HarnessError('LIVE_INVALID_DATABASE_PATH');
    this.protect();
    const exists = runtimePathMetadata(filePath) !== null;
    this.database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    if (!exists) chmodSync(filePath, 0o600);
    this.protect();
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS live_tasks(task_id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS live_approvals(approval_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES live_tasks(task_id),
        used_at TEXT, revoked_at TEXT, payload TEXT NOT NULL) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS live_one_approval ON live_approvals(task_id) WHERE used_at IS NULL AND revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS live_attempts(attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES live_tasks(task_id),
        approval_id TEXT NOT NULL UNIQUE REFERENCES live_approvals(approval_id), status TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS live_one_uncertain ON live_attempts(task_id) WHERE status IN ('SENDING','SENT','UNKNOWN');
      CREATE TABLE IF NOT EXISTS live_targets(target_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, locked INTEGER NOT NULL CHECK(locked IN (0,1))) STRICT;
    `);
    this.protect();
  }

  create(plan: LivePlan, now: Date): LiveSnapshot {
    assertLiveOwner(plan.ownerId);
    assertLivePlan(plan);
    assertLiveCurrent(plan, plan.source, now);
    return this.transaction(() => {
      const key = liveTargetKey(plan.config);
      const previous = this.database.prepare('SELECT task_id, locked FROM live_targets WHERE target_key = ?').get(key);
      if (previous) {
        if (previous.locked === 1) throw new HarnessError('LIVE_TARGET_ALREADY_ATTEMPTED');
        const old = this.findTask(String(previous.task_id));
        if (old && ['AWAITING_APPROVAL', 'APPROVED', 'SENDING'].includes(old.status)) throw new HarnessError('LIVE_TARGET_HAS_PLAN');
      }
      const task: LiveTask = { plan: structuredClone(plan), status: 'AWAITING_APPROVAL', updatedAt: now.toISOString(), reason: null };
      this.database.prepare('INSERT INTO live_tasks VALUES (?, ?, ?)').run(plan.taskId, task.status, JSON.stringify(task));
      this.database.prepare('INSERT INTO live_targets VALUES (?, ?, 0) ON CONFLICT(target_key) DO UPDATE SET task_id=excluded.task_id, locked=0')
        .run(key, plan.taskId);
      return this.snapshot(task, now);
    });
  }

  inspect(taskId: string, ownerId: string, now: Date): LiveSnapshot {
    return this.transaction(() => this.snapshot(this.maintainTask(this.owned(taskId, ownerId, now), now), now));
  }

  list(ownerId: string, now: Date): LiveTask[] {
    assertLiveOwner(ownerId);
    return this.transaction(() => this.database.prepare('SELECT task_id FROM live_tasks ORDER BY rowid DESC LIMIT 100').all()
      .map((row) => this.maintainTask(this.owned(String(row.task_id), ownerId, now), now)));
  }

  approve(taskId: string, planHash: string, minutes: number, ownerId: string, source: LiveSource, now: Date): LiveApproval {
    return this.transaction(() => {
      const task = this.owned(taskId, ownerId, now);
      this.ready(task, planHash, source, now);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new HarnessError('LIVE_INVALID_TTL');
      if (!['AWAITING_APPROVAL', 'FAILED'].includes(task.status)) throw new HarnessError('LIVE_NOT_AWAITING_APPROVAL');
      if (this.activeApproval(taskId)) throw new HarnessError('LIVE_APPROVAL_EXISTS');
      const count = this.database.prepare('SELECT COUNT(*) AS total FROM live_approvals WHERE task_id = ?').get(taskId);
      if (Number(count?.total) >= 100) throw new HarnessError('LIVE_APPROVAL_LIMIT');
      const approval: LiveApproval = {
        approvalId: randomUUID(), taskId, ownerId, planHash, planSnapshot: structuredClone(task.plan),
        createdAt: now.toISOString(), expiresAt: new Date(Math.min(now.getTime() + minutes * 60_000, Date.parse(task.plan.expiresAt))).toISOString(),
        usedAt: null, revokedAt: null,
      };
      this.database.prepare('INSERT INTO live_approvals VALUES (?, ?, NULL, NULL, ?)').run(approval.approvalId, taskId, JSON.stringify(approval));
      this.writeTask({ ...task, status: 'APPROVED', updatedAt: now.toISOString(), reason: null });
      return approval;
    });
  }

  claim(taskId: string, planHash: string, ownerId: string, source: LiveSource, now: Date): LiveClaim {
    return this.transaction(() => {
      const task = this.owned(taskId, ownerId, now);
      this.ready(task, planHash, source, now);
      const approval = this.activeApproval(taskId);
      if (task.status !== 'APPROVED' || !approval || now.getTime() >= Date.parse(approval.expiresAt)) throw new HarnessError('LIVE_APPROVAL_REQUIRED');
      if (approval.planHash !== planHash || approval.ownerId !== ownerId) throw new HarnessError('LIVE_APPROVAL_MISMATCH');
      const consumed = { ...approval, usedAt: now.toISOString() };
      this.writeApproval(consumed);
      const attempt: LiveAttempt = {
        attemptId: randomUUID(), taskId, approvalId: approval.approvalId, planHash, status: 'SENDING',
        startedAt: now.toISOString(), finishedAt: null, receipt: null, reason: null,
      };
      this.database.prepare('INSERT INTO live_attempts VALUES (?, ?, ?, ?, ?)')
        .run(attempt.attemptId, taskId, attempt.approvalId, attempt.status, JSON.stringify(attempt));
      const sending: LiveTask = { ...task, status: 'SENDING', updatedAt: now.toISOString(), reason: null };
      this.writeTask(sending);
      this.database.prepare('UPDATE live_targets SET locked=1 WHERE target_key=? AND task_id=?').run(liveTargetKey(task.plan.config), taskId);
      return { task: sending, approval: consumed, attempt, checkedAt: source.observedAt };
    });
  }

  finish(attemptId: string, result: LiveDeliveryResult, now: Date): LiveAttempt {
    return this.transaction(() => {
      const attempt = this.readAttempt(attemptId);
      const task = this.owned(attempt.taskId, `os-user:${process.getuid?.()}`, now);
      if (attempt.status !== 'SENDING' || task.status !== 'SENDING') throw new HarnessError('LIVE_ATTEMPT_FINISHED');
      if (!liveKeys(result, ['status', 'reason', 'receipt']) || !['SENT', 'NOT_SENT', 'UNKNOWN'].includes(result.status) || !safeCode(result.reason)) {
        throw new HarnessError('LIVE_INVALID_DELIVERY_RESULT');
      }
      if (result.status === 'SENT') {
        if (result.reason !== null || !liveKeys(result.receipt, ['channelId', 'threadTs', 'messageTs'])
          || result.receipt?.channelId !== task.plan.config.channelId || result.receipt.threadTs !== task.plan.config.threadTs
          || !liveTimestamp(result.receipt.messageTs) || compareLiveTimestamp(result.receipt.messageTs, task.plan.config.threadTs) <= 0) throw new HarnessError('LIVE_INVALID_DELIVERY_RESULT');
      } else if (result.receipt !== null || result.reason === null) throw new HarnessError('LIVE_INVALID_DELIVERY_RESULT');
      if (now.toISOString() < attempt.startedAt) throw new HarnessError('LIVE_INVALID_TIME');
      const finished: LiveAttempt = { ...attempt, ...result, finishedAt: now.toISOString() };
      this.database.prepare('UPDATE live_attempts SET status=?,payload=? WHERE attempt_id=?').run(finished.status, JSON.stringify(finished), attemptId);
      this.writeTask({ ...task, status: result.status === 'NOT_SENT' ? 'FAILED' : result.status, updatedAt: now.toISOString(), reason: result.reason });
      this.database.prepare('UPDATE live_targets SET locked=? WHERE target_key=? AND task_id=?')
        .run(result.status === 'NOT_SENT' ? 0 : 1, liveTargetKey(task.plan.config), task.plan.taskId);
      return finished;
    });
  }

  block(taskId: string, ownerId: string, reason: string, now: Date): LiveSnapshot {
    return this.transaction(() => {
      const task = this.owned(taskId, ownerId, now);
      if (!safeCode(reason)) throw new HarnessError('LIVE_INVALID_REASON');
      if (!terminal.includes(task.status) && task.status !== 'SENDING') {
        this.revoke(taskId, now);
        this.writeTask({ ...task, status: 'BLOCKED', updatedAt: now.toISOString(), reason });
      }
      return this.snapshot(this.owned(taskId, ownerId, now), now);
    });
  }

  cancel(taskId: string, ownerId: string, now: Date): LiveSnapshot {
    return this.transaction(() => {
      const task = this.owned(taskId, ownerId, now);
      if (task.status === 'SENDING') throw new HarnessError('LIVE_RECOVERY_REQUIRED');
      if (!['SENT', 'UNKNOWN', 'CANCELLED'].includes(task.status)) {
        this.revoke(taskId, now);
        this.writeTask({ ...task, status: 'CANCELLED', updatedAt: now.toISOString(), reason: 'LIVE_CANCELLED' });
      }
      return this.snapshot(this.owned(taskId, ownerId, now), now);
    });
  }

  recover(taskId: string, ownerId: string, now: Date): LiveSnapshot {
    return this.transaction(() => {
      const task = this.owned(taskId, ownerId, now);
      if (task.status === 'SENDING') this.uncertain(task, now);
      return this.snapshot(this.maintainTask(this.owned(taskId, ownerId, now), now), now);
    });
  }

  maintain(now: Date): { expiredPlans: number; purgedAudits: number } {
    if (!Number.isFinite(now.getTime())) throw new HarnessError('LIVE_INVALID_TIME');
    return this.transaction(() => {
      let expiredPlans = 0;
      let purgedAudits = 0;
      for (const row of this.database.prepare('SELECT task_id FROM live_tasks').all()) {
        const task = this.owned(String(row.task_id), `os-user:${process.getuid?.()}`, now);
        const current = this.maintainTask(task, now);
        if (current.status !== task.status && current.reason === 'LIVE_PLAN_EXPIRED') expiredPlans += 1;
        if (!terminal.includes(current.status) || now.getTime() < Date.parse(current.updatedAt) + liveAuditRetentionMs) continue;
        this.database.prepare('DELETE FROM live_attempts WHERE task_id=?').run(task.plan.taskId);
        this.database.prepare('DELETE FROM live_approvals WHERE task_id=?').run(task.plan.taskId);
        this.database.prepare('DELETE FROM live_tasks WHERE task_id=?').run(task.plan.taskId);
        purgedAudits += 1;
      }
      return { expiredPlans, purgedAudits };
    });
  }

  close(): void { this.database.close(); }

  private ready(task: LiveTask, planHash: string, source: LiveSource, now: Date): void {
    if (!liveDigest(planHash) || task.plan.planHash !== planHash) throw new HarnessError('LIVE_PLAN_HASH_MISMATCH');
    assertLiveCurrent(task.plan, source, now);
    const target = this.database.prepare('SELECT task_id,locked FROM live_targets WHERE target_key=?').get(liveTargetKey(task.plan.config));
    if (target?.task_id !== task.plan.taskId || target.locked !== 0) throw new HarnessError('LIVE_TARGET_ALREADY_ATTEMPTED');
    if (['SENT', 'UNKNOWN', 'SENDING', 'BLOCKED', 'CANCELLED'].includes(task.status)) throw new HarnessError('LIVE_TASK_NOT_READY');
  }

  private owned(taskId: string, ownerId: string, now: Date): LiveTask {
    assertLiveOwner(ownerId);
    if (!liveUuid(taskId) || !Number.isFinite(now.getTime())) throw new HarnessError('LIVE_INVALID_ARGUMENTS');
    const task = this.findTask(taskId);
    if (!task) throw new HarnessError('LIVE_TASK_NOT_FOUND');
    if (task.plan.ownerId !== ownerId) throw new HarnessError('LIVE_OWNER_MISMATCH');
    if (now.toISOString() < task.updatedAt) throw new HarnessError('LIVE_INVALID_TIME');
    return task;
  }

  private findTask(taskId: string): LiveTask | null {
    const row = this.database.prepare('SELECT * FROM live_tasks WHERE task_id=?').get(taskId);
    if (!row) return null;
    const task = decode<LiveTask>(row.payload);
    if (!liveKeys(task, ['plan', 'status', 'updatedAt', 'reason']) || !statuses.includes(task.status)
      || !liveDate(task.updatedAt) || !safeCode(task.reason) || row.task_id !== task.plan?.taskId || row.status !== task.status) {
      throw new HarnessError('LIVE_INVALID_STORED_TASK');
    }
    assertLivePlan(task.plan);
    return task;
  }

  private readApproval(payload: unknown): LiveApproval {
    const approval = decode<LiveApproval>(payload);
    if (!liveKeys(approval, ['approvalId', 'taskId', 'ownerId', 'planHash', 'planSnapshot', 'createdAt', 'expiresAt', 'usedAt', 'revokedAt'])
      || !liveUuid(approval.approvalId) || !liveUuid(approval.taskId) || !liveDigest(approval.planHash)
      || !liveDate(approval.createdAt) || !liveDate(approval.expiresAt) || (approval.usedAt !== null && !liveDate(approval.usedAt))
      || (approval.revokedAt !== null && !liveDate(approval.revokedAt))) throw new HarnessError('LIVE_INVALID_STORED_APPROVAL');
    assertLivePlan(approval.planSnapshot);
    if (approval.planSnapshot.planHash !== approval.planHash || approval.planSnapshot.taskId !== approval.taskId
      || approval.planSnapshot.ownerId !== approval.ownerId || approval.expiresAt > approval.planSnapshot.expiresAt
      || Date.parse(approval.expiresAt) <= Date.parse(approval.createdAt)
      || Date.parse(approval.expiresAt) - Date.parse(approval.createdAt) > 60 * 60_000) throw new HarnessError('LIVE_INVALID_STORED_APPROVAL');
    return approval;
  }

  private activeApproval(taskId: string): LiveApproval | null {
    const row = this.database.prepare('SELECT * FROM live_approvals WHERE task_id=? AND used_at IS NULL AND revoked_at IS NULL').get(taskId);
    if (!row) return null;
    const approval = this.readApprovalRow(row);
    if (approval.taskId !== taskId || approval.approvalId !== row.approval_id || approval.usedAt !== null || approval.revokedAt !== null) {
      throw new HarnessError('LIVE_INVALID_STORED_APPROVAL');
    }
    return approval;
  }

  private readApprovalRow(row: Record<string, unknown>): LiveApproval {
    const approval = this.readApproval(row.payload);
    const task = this.findTask(approval.taskId);
    if (row.approval_id !== approval.approvalId || row.task_id !== approval.taskId
      || row.used_at !== approval.usedAt || row.revoked_at !== approval.revokedAt
      || !task || task.plan.planHash !== approval.planHash || task.plan.ownerId !== approval.ownerId
      || approval.createdAt < task.plan.createdAt || (approval.usedAt !== null
        && (approval.usedAt < approval.createdAt || approval.usedAt >= approval.expiresAt))) {
      throw new HarnessError('LIVE_INVALID_STORED_APPROVAL');
    }
    return approval;
  }

  private readAttempt(attemptId: string): LiveAttempt {
    const row = this.database.prepare('SELECT * FROM live_attempts WHERE attempt_id=?').get(attemptId);
    if (!row) throw new HarnessError('LIVE_ATTEMPT_NOT_FOUND');
    const value = decode<LiveAttempt>(row.payload);
    if (!liveKeys(value, ['attemptId', 'taskId', 'approvalId', 'planHash', 'status', 'startedAt', 'finishedAt', 'receipt', 'reason'])
      || !liveUuid(value.attemptId) || !liveUuid(value.taskId) || !liveUuid(value.approvalId) || !liveDigest(value.planHash)
      || !['SENDING', 'SENT', 'NOT_SENT', 'UNKNOWN'].includes(value.status) || !liveDate(value.startedAt)
      || (value.finishedAt !== null && !liveDate(value.finishedAt)) || !safeCode(value.reason)
      || row.attempt_id !== value.attemptId || row.task_id !== value.taskId || row.approval_id !== value.approvalId || row.status !== value.status) {
      throw new HarnessError('LIVE_INVALID_STORED_ATTEMPT');
    }
    const task = this.findTask(value.taskId);
    const approvalRow = this.database.prepare('SELECT * FROM live_approvals WHERE approval_id=?').get(value.approvalId);
    const approval = approvalRow ? this.readApprovalRow(approvalRow) : null;
    if (!task || !approval || task.plan.planHash !== value.planHash || approval.planHash !== value.planHash
      || approval.taskId !== value.taskId || approval.usedAt !== value.startedAt
      || (value.finishedAt !== null && value.finishedAt < value.startedAt)) throw new HarnessError('LIVE_INVALID_STORED_ATTEMPT');
    if (value.status === 'SENDING') {
      if (value.finishedAt !== null || value.receipt !== null || value.reason !== null) throw new HarnessError('LIVE_INVALID_STORED_ATTEMPT');
    } else if (value.finishedAt === null) throw new HarnessError('LIVE_INVALID_STORED_ATTEMPT');
    if (value.status === 'SENT') {
      if (value.reason !== null || !liveKeys(value.receipt, ['channelId', 'threadTs', 'messageTs'])
        || value.receipt?.channelId !== task.plan.config.channelId || value.receipt.threadTs !== task.plan.config.threadTs
        || !liveTimestamp(value.receipt.messageTs) || compareLiveTimestamp(value.receipt.messageTs, task.plan.config.threadTs) <= 0) {
        throw new HarnessError('LIVE_INVALID_STORED_ATTEMPT');
      }
    } else if (value.receipt !== null || (value.status !== 'SENDING' && value.reason === null)) throw new HarnessError('LIVE_INVALID_STORED_ATTEMPT');
    return value;
  }

  private snapshot(task: LiveTask, now: Date): LiveSnapshot {
    const approvals = this.database.prepare('SELECT * FROM live_approvals WHERE task_id=? ORDER BY rowid DESC LIMIT 100').all(task.plan.taskId)
      .map((row) => this.readApprovalRow(row));
    const attempts = this.database.prepare('SELECT attempt_id FROM live_attempts WHERE task_id=? ORDER BY rowid DESC LIMIT 100').all(task.plan.taskId)
      .map((row) => this.readAttempt(String(row.attempt_id)));
    return { task, approvals, attempts, body: now.getTime() < Date.parse(task.plan.expiresAt) ? liveTestBody : null };
  }

  private maintainTask(task: LiveTask, now: Date): LiveTask {
    if (!terminal.includes(task.status) && now.getTime() >= Date.parse(task.plan.expiresAt)) {
      if (task.status === 'SENDING') this.uncertain(task, now);
      else {
        this.revoke(task.plan.taskId, now);
        this.writeTask({ ...task, status: 'BLOCKED', updatedAt: now.toISOString(), reason: 'LIVE_PLAN_EXPIRED' });
      }
      return this.findTask(task.plan.taskId)!;
    }
    const approval = this.activeApproval(task.plan.taskId);
    if (approval && now.getTime() >= Date.parse(approval.expiresAt)) {
      this.revoke(task.plan.taskId, now);
      if (task.status === 'APPROVED') {
        task = { ...task, status: 'AWAITING_APPROVAL', updatedAt: now.toISOString(), reason: 'LIVE_APPROVAL_EXPIRED' };
        this.writeTask(task);
      }
    }
    return task;
  }

  private revoke(taskId: string, now: Date): void {
    const approval = this.activeApproval(taskId);
    if (approval) this.writeApproval({ ...approval, revokedAt: now.toISOString() });
  }

  private uncertain(task: LiveTask, now: Date): void {
    const row = this.database.prepare("SELECT attempt_id FROM live_attempts WHERE task_id=? AND status='SENDING'").get(task.plan.taskId);
    if (!row) throw new HarnessError('LIVE_INVALID_STORED_ATTEMPT');
    const attempt = this.readAttempt(String(row.attempt_id));
    const finished = { ...attempt, status: 'UNKNOWN', finishedAt: now.toISOString(), reason: 'LIVE_RECOVERED_UNCERTAIN' };
    this.database.prepare('UPDATE live_attempts SET status=?,payload=? WHERE attempt_id=?').run('UNKNOWN', JSON.stringify(finished), attempt.attemptId);
    this.writeTask({ ...task, status: 'UNKNOWN', updatedAt: now.toISOString(), reason: 'LIVE_RECOVERED_UNCERTAIN' });
    this.database.prepare('UPDATE live_targets SET locked=1 WHERE target_key=?').run(liveTargetKey(task.plan.config));
  }

  private writeTask(task: LiveTask): void {
    this.database.prepare('UPDATE live_tasks SET status=?,payload=? WHERE task_id=?').run(task.status, JSON.stringify(task), task.plan.taskId);
  }

  private writeApproval(approval: LiveApproval): void {
    this.database.prepare('UPDATE live_approvals SET used_at=?,revoked_at=?,payload=? WHERE approval_id=?')
      .run(approval.usedAt, approval.revokedAt, JSON.stringify(approval), approval.approvalId);
  }

  private transaction<T>(action: () => T): T {
    this.protect();
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.protect(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  private protect(): void {
    if (!process.getuid) throw new HarnessError('LOCAL_OWNER_UNAVAILABLE');
    const directory = runtimePathMetadata(dirname(this.filePath));
    if (!directory?.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()
      || (directory.mode & 0o077) !== 0 || realpathSync(dirname(this.filePath)) !== dirname(this.filePath)) throw new HarnessError('LIVE_DATABASE_NOT_PRIVATE');
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const path = `${this.filePath}${suffix}`;
      assertRuntimeFile(path);
      const metadata = runtimePathMetadata(path);
      if (metadata && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)) throw new HarnessError('LIVE_DATABASE_NOT_PRIVATE');
    }
  }
}
