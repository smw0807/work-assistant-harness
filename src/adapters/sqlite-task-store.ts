import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import { transitionTask } from '../domain/state.js';
import type { Task } from '../domain/types.js';
import {
  approvalInvalidationReason, assertApprovalOwner, assertApprovalTime, validateApprovalRequest,
  type ApprovalContext, type ApprovalHistoryPage, type ApprovalRecord, type ApprovalRequest,
} from '../domain/approval.js';
import type { ApprovalStore, TaskStore } from '../ports/index.js';
import { assertRuntimeFile } from '../policy/runtime-path.js';

export class SqliteTaskStore implements TaskStore, ApprovalStore {
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) assertRuntimeFile(`${filePath}${suffix}`);
    this.database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    chmodSync(filePath, 0o600);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(workspace_id, event_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        owner_id TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_active_per_task
        ON approvals(task_id) WHERE used_at IS NULL AND revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS approval_cancellations (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
        owner_id TEXT NOT NULL,
        cancelled_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  create(task: Task): boolean {
    if (task.status === 'APPROVED') throw new HarnessError('APPROVAL_STATE_MANAGED');
    const result = this.database.prepare(`
      INSERT INTO tasks(task_id, workspace_id, event_id, status, payload)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, event_id) DO NOTHING
    `).run(task.taskId, task.workspaceId, task.eventId, task.status, JSON.stringify(task));
    return result.changes === 1;
  }

  save(task: Task): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.find(task.taskId);
      if (!existing) throw new HarnessError('TASK_NOT_FOUND');
      if (existing.status === 'APPROVED' || task.status === 'APPROVED' || this.hasActiveApproval(task.taskId)) {
        throw new HarnessError('APPROVAL_STATE_MANAGED');
      }
      if (existing.status !== task.status) transitionTask(existing, task.status);
      this.database.prepare('UPDATE tasks SET status = ?, payload = ? WHERE task_id = ?')
        .run(task.status, JSON.stringify(task), task.taskId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  find(taskId: string): Task | null {
    const row = this.database.prepare('SELECT payload FROM tasks WHERE task_id = ?').get(taskId);
    return row ? this.parseTask(row.payload) : null;
  }

  list(): Task[] {
    return this.database.prepare('SELECT payload FROM tasks ORDER BY rowid')
      .all().map((row) => this.parseTask(row.payload));
  }

  approve(request: ApprovalRequest, context: ApprovalContext): ApprovalRecord {
    assertApprovalTime(context.now);
    assertApprovalOwner(context.ownerId);
    this.reconcileApprovals(context.now);
    return this.transaction(() => {
      const task = this.find(request.taskId);
      if (!task) throw new HarnessError('TASK_NOT_FOUND');
      const records = this.listApprovals(task.taskId);
      if (records.some((record) => record.ownerId !== context.ownerId)) throw new HarnessError('APPROVAL_OWNER_MISMATCH');
      if (task.status === 'APPROVED' || this.hasActiveApproval(task.taskId)) throw new HarnessError('APPROVAL_ALREADY_EXISTS');
      const plan = validateApprovalRequest(task, request, context);
      const approval: ApprovalRecord = {
        approvalId: randomUUID(), ownerId: context.ownerId, taskId: task.taskId,
        repoId: task.repoId, planHash: plan.planHash, baseCommit: task.baseCommit,
        requestRevision: task.requestRevision, createdAt: context.now.toISOString(),
        expiresAt: new Date(context.now.getTime() + request.expiresInMinutes * 60_000).toISOString(),
        usedAt: null, revokedAt: null, revocationReason: null,
        executionPolicy: 'approval-only-v1', planSnapshot: structuredClone(plan),
      };
      const approvalPayload = JSON.stringify(approval);
      this.parseApproval(approvalPayload);
      this.database.prepare(`
        INSERT INTO approvals(approval_id, task_id, owner_id, used_at, revoked_at, payload)
        VALUES (?, ?, ?, NULL, NULL, ?)
      `).run(approval.approvalId, task.taskId, approval.ownerId, approvalPayload);
      this.writeTask({
        ...transitionTask(task, 'APPROVED'), updatedAt: context.now.toISOString(), failureCode: null,
        report: task.report ? { ...task.report, nextApproval: '로컬 승인만 기록했습니다. 실행은 비활성화되어 있습니다. cancel 명령으로 취소할 수 있습니다.' } : null,
      });
      return approval;
    });
  }

  cancelApproval(taskId: string, ownerId: string, now: Date): Task {
    assertApprovalOwner(ownerId);
    assertApprovalTime(now);
    return this.transaction(() => {
      const task = this.find(taskId);
      if (!task) throw new HarnessError('TASK_NOT_FOUND');
      const cancellation = this.database.prepare('SELECT owner_id FROM approval_cancellations WHERE task_id = ?').get(taskId);
      if ((cancellation && cancellation.owner_id !== ownerId)
        || this.listApprovals(taskId).some((record) => record.ownerId !== ownerId)) {
        throw new HarnessError('APPROVAL_OWNER_MISMATCH');
      }
      if (task.classification !== 'change') throw new HarnessError('TASK_NOT_CANCELLABLE');
      if (task.status === 'CANCELLED') return task;
      if (!['AWAITING_APPROVAL', 'APPROVED'].includes(task.status)) {
        throw new HarnessError('TASK_NOT_CANCELLABLE');
      }
      for (const approval of this.listApprovals(taskId)) {
        if (approval.revokedAt === null) this.revokeApproval(approval, now, 'OWNER_CANCELLED');
      }
      this.database.prepare(`
        INSERT INTO approval_cancellations(task_id, owner_id, cancelled_at) VALUES (?, ?, ?)
      `).run(taskId, ownerId, now.toISOString());
      const cancelled = {
        ...transitionTask(task, 'CANCELLED'), updatedAt: now.toISOString(), failureCode: 'OWNER_CANCELLED',
        report: task.report ? { ...task.report, nextApproval: '소유자가 변경 작업을 취소했습니다. 코드 변경과 검사는 실행되지 않았습니다.' } : null,
      };
      this.writeTask(cancelled);
      return cancelled;
    });
  }

  listApprovals(taskId: string): ApprovalRecord[] {
    return this.database.prepare('SELECT payload FROM approvals WHERE task_id = ? ORDER BY rowid')
      .all(taskId).map((row) => this.parseApproval(row.payload));
  }

  listApprovalHistory(taskId: string, offset: number): ApprovalHistoryPage {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000_000) {
      throw new HarnessError('INVALID_APPROVAL_OFFSET');
    }
    const count = this.database.prepare('SELECT COUNT(*) AS total FROM approvals WHERE task_id = ?').get(taskId);
    const total = Number(count?.total ?? 0);
    const approvals = this.database.prepare('SELECT payload FROM approvals WHERE task_id = ? ORDER BY rowid DESC LIMIT 1 OFFSET ?')
      .all(taskId, offset).map((row) => this.parseApproval(row.payload));
    const nextOffset = approvals.length > 0 && offset + approvals.length < total ? offset + approvals.length : null;
    return { approvals, approvalPage: { offset, total, nextOffset } };
  }

  reconcileApprovals(now: Date): number {
    assertApprovalTime(now);
    return this.transaction(() => {
      let revokedCount = 0;
      const rows = this.database.prepare('SELECT payload FROM approvals WHERE revoked_at IS NULL AND used_at IS NULL').all();
      for (const row of rows) {
        const approval = this.parseApproval(row.payload);
        const task = this.find(approval.taskId);
        const reason = task ? approvalInvalidationReason(approval, task, now) : 'APPROVAL_TASK_MISMATCH';
        if (!reason) continue;
        this.revokeApproval(approval, now, reason);
        revokedCount += 1;
        if (task?.status === 'APPROVED') {
          this.writeTask(this.awaitingReapproval(task, now, reason));
        }
      }
      // 불완전한 DB 복구로 승인 기록 없는 APPROVED가 남아도 실행 가능 상태로 유지하지 않는다.
      for (const task of this.list()) {
        if (task.status === 'APPROVED' && !this.hasActiveApproval(task.taskId)) {
          this.writeTask(this.awaitingReapproval(task, now, 'APPROVAL_MISSING'));
        }
      }
      return revokedCount;
    });
  }

  recoverInterrupted(): number {
    let recoveredCount = 0;
    for (const task of this.list()) {
      if (['RECEIVED', 'TRIAGED', 'ANALYZED'].includes(task.status)) {
        this.save({
          ...transitionTask(task, 'BLOCKED'),
          failureCode: 'INTERRUPTED_REVIEW_REQUIRED',
        });
        recoveredCount += 1;
      }
    }
    return recoveredCount;
  }

  close(): void {
    this.database.close();
  }

  private parseTask(payload: unknown): Task {
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > 256_000) {
      throw new HarnessError('INVALID_STORED_TASK');
    }
    // DB는 같은 OS 사용자의 비공개 런타임 자료이며 외부 입력으로 사용하지 않는다.
    return JSON.parse(payload) as Task;
  }

  private parseApproval(payload: unknown): ApprovalRecord {
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > 256_000) throw new HarnessError('INVALID_STORED_APPROVAL');
    return JSON.parse(payload) as ApprovalRecord;
  }

  private awaitingReapproval(task: Task, now: Date, reason: string): Task {
    return {
      ...transitionTask(task, 'AWAITING_APPROVAL'), updatedAt: now.toISOString(), failureCode: reason,
      report: task.report ? { ...task.report, nextApproval: '기존 승인이 유효하지 않습니다. 최신 계획과 기준 커밋을 확인한 뒤 다시 승인해야 합니다. 실행은 비활성화되어 있습니다.' } : null,
    };
  }

  private hasActiveApproval(taskId: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM approvals WHERE task_id = ? AND revoked_at IS NULL AND used_at IS NULL').get(taskId));
  }

  private revokeApproval(approval: ApprovalRecord, now: Date, reason: string): void {
    const revoked = { ...approval, revokedAt: now.toISOString(), revocationReason: reason };
    this.database.prepare('UPDATE approvals SET revoked_at = ?, payload = ? WHERE approval_id = ? AND revoked_at IS NULL')
      .run(revoked.revokedAt, JSON.stringify(revoked), approval.approvalId);
  }

  private writeTask(task: Task): void {
    const payload = JSON.stringify(task);
    this.parseTask(payload);
    this.database.prepare('UPDATE tasks SET status = ?, payload = ? WHERE task_id = ?')
      .run(task.status, payload, task.taskId);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
