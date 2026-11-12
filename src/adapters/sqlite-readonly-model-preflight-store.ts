import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { ReadonlyModelPreflightPayload, ReadonlyModelPreflightPlan, ReadonlyModelPreflightDispatch } from '../domain/readonly-model-preflight.js';
import type {
  ReadonlyModelPreflightApproval, ReadonlyModelPreflightApprovalRequest, ReadonlyModelPreflightAttempt, ReadonlyModelPreflightStore, ReadonlyModelPreflightPruneResult,
  ReadonlyModelPreflightReport, ReadonlyModelPreflightRunRequest, ReadonlyModelPreflightSnapshot, ReadonlyModelPreflightStatus, ReadonlyModelPreflightTask,
} from '../ports/readonly-model-preflight.js';
import { assertReadonlyModelPreflightPlan, parseReadonlyModelPreflightResult, validateReadonlyModelPreflightPayload } from '../policy/readonly-model-preflight-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

const invalid = (): HarnessError => new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_RECORD');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const exact = (value: unknown, keys: string[]): boolean => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const statuses: ReadonlyModelPreflightStatus[] = ['AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'REPORTED', 'FAILED', 'BLOCKED', 'CANCELLED', 'INTERRUPTED'];
const terminal = (status: ReadonlyModelPreflightStatus): boolean => !['AWAITING_APPROVAL', 'APPROVED', 'RUNNING'].includes(status);
const failures = ['READONLY_MODEL_PREFLIGHT_CALL_FAILED', 'READONLY_MODEL_PREFLIGHT_INVALID_RESPONSE', 'READONLY_MODEL_PREFLIGHT_OUTPUT_LIMIT', 'READONLY_MODEL_PREFLIGHT_TIMEOUT',
  'READONLY_MODEL_PREFLIGHT_CANCELLED', 'READONLY_MODEL_PREFLIGHT_INVALIDATED', 'READONLY_MODEL_PREFLIGHT_INTERRUPTED', 'READONLY_MODEL_PREFLIGHT_RECOVERY_UNCERTAIN', 'READONLY_MODEL_PREFLIGHT_EXPIRED', 'READONLY_MODEL_PREFLIGHT_SOURCE_CHANGED'];
const validFailure = (value: unknown): value is string => typeof value === 'string' && failures.includes(value);
const assertContext = (context: ReadonlyContext): void => {
  if (!context || !(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_TIME');
  if (!process.getuid || context.ownerId !== `os-user:${process.getuid()}`) throw new HarnessError('READONLY_MODEL_PREFLIGHT_OWNER_MISMATCH');
};
const decode = <T>(value: unknown, limit = 262_144): T => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  // 자체 writer의 직렬화만 받으면 중복 JSON 키도 조용히 덮어쓸 수 없다.
  if (JSON.stringify(parsed) !== value) throw invalid();
  return parsed as T;
};
interface PayloadRecord { payload: ReadonlyModelPreflightPayload; report: ReadonlyModelPreflightReport | null }

/** 본문은 24시간 payload 테이블에만 두고 승인·시도·감사에는 hash와 상태만 보관한다. */
export class SqliteReadonlyModelPreflightStore implements ReadonlyModelPreflightStore {
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
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS readonly_model_preflight_markers (
        investigation_id TEXT PRIMARY KEY, consumed INTEGER NOT NULL CHECK(consumed IN (0,1)), plan_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS readonly_model_preflight_tasks (
        investigation_id TEXT PRIMARY KEY REFERENCES readonly_model_preflight_markers(investigation_id),
        plan_hash TEXT NOT NULL, status TEXT NOT NULL, terminal_at TEXT, payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS readonly_model_preflight_payloads (
        investigation_id TEXT PRIMARY KEY REFERENCES readonly_model_preflight_tasks(investigation_id), expires_at TEXT NOT NULL,
        payload_hash TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS readonly_model_preflight_approvals (
        approval_id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL REFERENCES readonly_model_preflight_tasks(investigation_id),
        used_at TEXT, revoked_at TEXT, payload TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS readonly_model_preflight_one_approval ON readonly_model_preflight_approvals(investigation_id)
        WHERE used_at IS NULL AND revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS readonly_model_preflight_attempts (
        attempt_id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL UNIQUE REFERENCES readonly_model_preflight_tasks(investigation_id),
        approval_id TEXT NOT NULL UNIQUE REFERENCES readonly_model_preflight_approvals(approval_id), status TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
    `);
    this.protectFiles();
  }

  create(plan: ReadonlyModelPreflightPlan, payload: ReadonlyModelPreflightPayload, context: ReadonlyContext): ReadonlyModelPreflightSnapshot {
    this.prune(context);
    assertReadonlyModelPreflightPlan(plan);
    validateReadonlyModelPreflightPayload(plan, payload);
    if (plan.ownerId !== context.ownerId) throw new HarnessError('READONLY_MODEL_PREFLIGHT_OWNER_MISMATCH');
    if (context.now.toISOString() < plan.createdAt || context.now.toISOString() >= plan.expiresAt) throw new HarnessError('READONLY_MODEL_PREFLIGHT_EXPIRED');
    return this.transaction(() => {
      if (this.database.prepare('SELECT investigation_id FROM readonly_model_preflight_markers WHERE investigation_id = ?').get(plan.id)) throw new HarnessError('READONLY_MODEL_PREFLIGHT_ID_REUSED');
      const task: ReadonlyModelPreflightTask = { investigationId: plan.id, plan: structuredClone(plan), status: 'AWAITING_APPROVAL', generation: 0,
        updatedAt: context.now.toISOString(), terminalAt: null, failureCode: null, reportHash: null };
      this.database.prepare('INSERT INTO readonly_model_preflight_markers VALUES (?, 0, ?)').run(plan.id, plan.planHash);
      this.database.prepare('INSERT INTO readonly_model_preflight_tasks VALUES (?, ?, ?, NULL, ?)').run(plan.id, plan.planHash, task.status, JSON.stringify(task));
      this.writePayload(task, { payload: structuredClone(payload), report: null }, true);
      return this.snapshot(task, context);
    });
  }

  inspect(id: string, context: ReadonlyContext, offset = 0): ReadonlyModelPreflightSnapshot {
    this.prune(context);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000_000) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_OFFSET');
    return this.transaction(() => this.snapshot(this.owned(id, context), context, offset));
  }

  approve(request: ReadonlyModelPreflightApprovalRequest, context: ReadonlyContext): ReadonlyModelPreflightApproval {
    this.prune(context);
    if (!exact(request, ['investigationId', 'planHash', 'expiresInMinutes']) || !identifier(request.investigationId) || !digest(request.planHash)
      || !Number.isInteger(request.expiresInMinutes) || request.expiresInMinutes < 1 || request.expiresInMinutes > 60) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_APPROVAL');
    return this.transaction(() => {
      const task = this.owned(request.investigationId, context);
      this.assertPayloadAvailable(task, context);
      if (task.plan.planHash !== request.planHash) throw new HarnessError('READONLY_MODEL_PREFLIGHT_PLAN_HASH_MISMATCH');
      if (task.status !== 'AWAITING_APPROVAL' || this.active(task) || this.attempt(task)) throw new HarnessError('READONLY_MODEL_PREFLIGHT_NOT_READY');
      const approval: ReadonlyModelPreflightApproval = { approvalId: randomUUID(), investigationId: task.investigationId, ownerId: context.ownerId,
        planHash: task.plan.planHash, planSnapshot: structuredClone(task.plan), createdAt: context.now.toISOString(),
        expiresAt: new Date(Math.min(context.now.getTime() + request.expiresInMinutes * 60_000, Date.parse(task.plan.expiresAt))).toISOString(),
        usedAt: null, revokedAt: null };
      this.assertApproval(approval, task.plan);
      this.database.prepare('INSERT INTO readonly_model_preflight_approvals VALUES (?, ?, NULL, NULL, ?)').run(approval.approvalId, task.investigationId, JSON.stringify(approval));
      this.writeTask({ ...task, status: 'APPROVED', updatedAt: context.now.toISOString() });
      return approval;
    });
  }

  claim(request: ReadonlyModelPreflightRunRequest, context: ReadonlyContext): ReadonlyModelPreflightAttempt {
    this.prune(context);
    if (!exact(request, ['investigationId', 'planHash']) || !identifier(request.investigationId) || !digest(request.planHash)) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_RUN');
    return this.transaction(() => {
      const task = this.owned(request.investigationId, context);
      this.assertPayloadAvailable(task, context);
      if (task.plan.planHash !== request.planHash) throw new HarnessError('READONLY_MODEL_PREFLIGHT_PLAN_HASH_MISMATCH');
      const approval = this.active(task);
      if (task.status !== 'APPROVED' || !approval || this.attempt(task)) throw new HarnessError('READONLY_MODEL_PREFLIGHT_APPROVAL_REQUIRED');
      const attempt: ReadonlyModelPreflightAttempt = { attemptId: randomUUID(), investigationId: task.investigationId, approvalId: approval.approvalId,
        planHash: task.plan.planHash, inputHash: task.plan.inputHash, requestBodyHash: task.plan.requestBodyHash, connectionProfileHash: task.plan.connectionProfileHash, requestEnvelopeHash: task.plan.requestEnvelopeHash,
        configHash: task.plan.configHash, generation: task.generation, status: 'RUNNING', startedAt: context.now.toISOString(),
        dispatchedAt: null, finishedAt: null, failureCode: null, responseHash: null };
      const changed = this.database.prepare('UPDATE readonly_model_preflight_markers SET consumed = 1 WHERE investigation_id = ? AND consumed = 0').run(task.investigationId);
      if (changed.changes !== 1) throw new HarnessError('READONLY_MODEL_PREFLIGHT_ALREADY_CONSUMED');
      this.writeApproval({ ...approval, usedAt: context.now.toISOString() }, task.plan);
      this.database.prepare('INSERT INTO readonly_model_preflight_attempts VALUES (?, ?, ?, ?, ?)').run(attempt.attemptId, task.investigationId, approval.approvalId, 'RUNNING', JSON.stringify(attempt));
      this.writeTask({ ...task, status: 'RUNNING', updatedAt: context.now.toISOString() });
      return attempt;
    });
  }

  assertRunnable(id: string, generation: number, context: ReadonlyContext): void {
    this.prune(context);
    this.transaction(() => { this.runnable(id, generation, context); });
  }

  dispatch<T>(id: string, generation: number, context: ReadonlyContext, invoke: (request: ReadonlyModelPreflightDispatch) => T): T {
    this.prune(context);
    // 전송 예약을 먼저 commit한다. 이후 실패해도 예약·승인을 복원하지 않는다.
    this.transaction(() => {
      const task = this.runnable(id, generation, context);
      const attempt = this.attempt(task)!;
      if (attempt.dispatchedAt !== null) throw new HarnessError('READONLY_MODEL_PREFLIGHT_ALREADY_DISPATCHED');
      this.writeAttempt({ ...attempt, dispatchedAt: context.now.toISOString() });
    });
    // 취소 writer와 실제 동기 호출 시작을 직렬화하고 응답 대기는 잠금 밖에서 한다.
    return this.transaction(() => {
      const fresh = { ownerId: context.ownerId, now: new Date(Math.max(Date.now(), context.now.getTime())) };
      const task = this.runnable(id, generation, fresh);
      const stored = this.assertPayloadAvailable(task, fresh);
      return invoke({ requestEnvelope: structuredClone(stored.payload.requestEnvelope), requestBodyHash: task.plan.requestBodyHash, requestEnvelopeHash: task.plan.requestEnvelopeHash });
    });
  }

  finish(id: string, generation: number, report: ReadonlyModelPreflightReport | null, failureCode: string | null, context: ReadonlyContext): ReadonlyModelPreflightSnapshot {
    this.prune(context);
    if ((report === null) !== (failureCode !== null) || (failureCode !== null && !validFailure(failureCode))) throw invalid();
    return this.transaction(() => {
      const task = this.owned(id, context);
      if (terminal(task.status)) {
        if (task.status === 'CANCELLED' && ['READONLY_MODEL_PREFLIGHT_RECOVERY_UNCERTAIN', 'READONLY_MODEL_PREFLIGHT_SOURCE_CHANGED'].includes(failureCode ?? '')) {
          const previousAttempt = this.attempt(task);
          if (previousAttempt) this.writeAttempt({ ...previousAttempt, status: 'BLOCKED', failureCode });
          const blocked: ReadonlyModelPreflightTask = { ...task, status: 'BLOCKED', failureCode, updatedAt: context.now.toISOString() };
          this.writeTask(blocked);
          return this.snapshot(blocked, context);
        }
        return this.snapshot(task, context);
      }
      if (task.status !== 'RUNNING' || task.generation !== generation) throw new HarnessError('READONLY_MODEL_PREFLIGHT_NOT_RUNNING');
      const attempt = this.attempt(task)!;
      if (context.now.toISOString() >= task.plan.expiresAt) { report = null; failureCode = 'READONLY_MODEL_PREFLIGHT_EXPIRED'; }
      const stored = this.payload(task);
      if (report) {
        if (!stored || attempt.dispatchedAt === null) throw invalid();
        this.assertReport(report, task, stored.payload);
      }
      const status = report ? 'REPORTED' : ['READONLY_MODEL_PREFLIGHT_SOURCE_CHANGED', 'READONLY_MODEL_PREFLIGHT_RECOVERY_UNCERTAIN'].includes(failureCode ?? '') ? 'BLOCKED' : 'FAILED';
      const finished: ReadonlyModelPreflightTask = { ...task, status, terminalAt: context.now.toISOString(), updatedAt: context.now.toISOString(),
        failureCode, reportHash: report ? hash(JSON.stringify(report)) : null };
      this.writeAttempt({ ...attempt, status, finishedAt: context.now.toISOString(), failureCode, responseHash: report?.responseHash ?? null });
      if (report && stored) this.writePayload(finished, { payload: stored.payload, report }, false);
      this.writeTask(finished);
      return this.snapshot(finished, context);
    });
  }

  cancel(id: string, context: ReadonlyContext): ReadonlyModelPreflightSnapshot { return this.control(id, context, 'READONLY_MODEL_PREFLIGHT_CANCELLED'); }
  invalidate(id: string, context: ReadonlyContext): ReadonlyModelPreflightSnapshot { return this.control(id, context, 'READONLY_MODEL_PREFLIGHT_INVALIDATED'); }

  recover(id: string, context: ReadonlyContext, cleanupConfirmed = false): ReadonlyModelPreflightSnapshot {
    this.prune(context);
    if (typeof cleanupConfirmed !== 'boolean') throw invalid();
    return this.transaction(() => {
      const task = this.owned(id, context);
      if (task.status !== 'RUNNING') return this.snapshot(task, context);
      const payloadAvailable = context.now.toISOString() < task.plan.expiresAt && this.payload(task) !== null;
      const confirmed = cleanupConfirmed && payloadAvailable;
      const status = confirmed ? 'INTERRUPTED' : 'BLOCKED';
      const failureCode = confirmed ? 'READONLY_MODEL_PREFLIGHT_INTERRUPTED' : 'READONLY_MODEL_PREFLIGHT_RECOVERY_UNCERTAIN';
      this.writeAttempt({ ...this.attempt(task)!, status, finishedAt: context.now.toISOString(), failureCode });
      const recovered: ReadonlyModelPreflightTask = { ...task, status, generation: task.generation + 1, terminalAt: context.now.toISOString(), updatedAt: context.now.toISOString(), failureCode };
      this.writeTask(recovered);
      return this.snapshot(recovered, context);
    });
  }

  prune(context: ReadonlyContext): ReadonlyModelPreflightPruneResult {
    assertContext(context);
    return this.transaction(() => {
      let payloadsRemoved = 0;
      let auditsRemoved = 0;
      const rows = this.database.prepare('SELECT investigation_id FROM readonly_model_preflight_tasks').all();
      for (const row of rows) {
        let task = this.readTask(String(row.investigation_id));
        if (!task || task.plan.ownerId !== context.ownerId) throw invalid();
        if (context.now.toISOString() < task.updatedAt) continue;
        if (context.now.toISOString() >= task.plan.expiresAt) {
          payloadsRemoved += Number(this.database.prepare('DELETE FROM readonly_model_preflight_payloads WHERE investigation_id = ?').run(task.investigationId).changes);
          if (task.status === 'AWAITING_APPROVAL' || task.status === 'APPROVED') {
            this.revoke(task, context);
            task = { ...task, status: 'FAILED', terminalAt: context.now.toISOString(), updatedAt: context.now.toISOString(), failureCode: 'READONLY_MODEL_PREFLIGHT_EXPIRED' };
            this.writeTask(task);
          }
        } else if (task.status === 'APPROVED') {
          const approval = this.active(task);
          if (!approval) throw invalid();
          if (context.now.toISOString() >= approval.expiresAt) {
            this.revoke(task, context);
            task = { ...task, status: 'AWAITING_APPROVAL', updatedAt: context.now.toISOString() };
            this.writeTask(task);
          }
        }
        if (task.terminalAt && context.now.getTime() >= Date.parse(task.terminalAt) + 30 * 86_400_000) {
          this.database.prepare('DELETE FROM readonly_model_preflight_payloads WHERE investigation_id = ?').run(task.investigationId);
          this.database.prepare('DELETE FROM readonly_model_preflight_attempts WHERE investigation_id = ?').run(task.investigationId);
          this.database.prepare('DELETE FROM readonly_model_preflight_approvals WHERE investigation_id = ?').run(task.investigationId);
          this.database.prepare('DELETE FROM readonly_model_preflight_tasks WHERE investigation_id = ?').run(task.investigationId);
          auditsRemoved++;
        }
      }
      return { payloadsRemoved, auditsRemoved };
    });
  }

  close(): void { this.database.close(); }

  private control(id: string, context: ReadonlyContext, failureCode: 'READONLY_MODEL_PREFLIGHT_CANCELLED' | 'READONLY_MODEL_PREFLIGHT_INVALIDATED'): ReadonlyModelPreflightSnapshot {
    this.prune(context);
    return this.transaction(() => {
      const task = this.owned(id, context);
      if (terminal(task.status)) return this.snapshot(task, context);
      this.revoke(task, context);
      const attempt = this.attempt(task);
      if (attempt) this.writeAttempt({ ...attempt, status: 'CANCELLED', finishedAt: context.now.toISOString(), failureCode });
      const cancelled: ReadonlyModelPreflightTask = { ...task, status: 'CANCELLED', generation: task.generation + 1,
        terminalAt: context.now.toISOString(), updatedAt: context.now.toISOString(), failureCode };
      this.writeTask(cancelled);
      return this.snapshot(cancelled, context);
    });
  }

  private runnable(id: string, generation: number, context: ReadonlyContext): ReadonlyModelPreflightTask {
    const task = this.owned(id, context);
    if (task.status !== 'RUNNING' || task.generation !== generation) throw new HarnessError('READONLY_MODEL_PREFLIGHT_CANCELLED');
    this.assertPayloadAvailable(task, context);
    const attempt = this.attempt(task)!;
    const row = this.database.prepare('SELECT * FROM readonly_model_preflight_approvals WHERE approval_id = ?').get(attempt.approvalId);
    if (!row) throw invalid();
    const approval = this.parseApproval(row, task.plan);
    if (context.now.toISOString() >= approval.expiresAt) throw new HarnessError('READONLY_MODEL_PREFLIGHT_EXPIRED');
    return task;
  }

  private assertPayloadAvailable(task: ReadonlyModelPreflightTask, context: ReadonlyContext): PayloadRecord {
    if (context.now.toISOString() >= task.plan.expiresAt) throw new HarnessError('READONLY_MODEL_PREFLIGHT_EXPIRED');
    const record = this.payload(task);
    if (!record) throw new HarnessError('READONLY_MODEL_PREFLIGHT_PAYLOAD_UNAVAILABLE');
    return record;
  }

  private readTask(id: string): ReadonlyModelPreflightTask | null {
    if (!identifier(id)) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_ID');
    const row = this.database.prepare('SELECT * FROM readonly_model_preflight_tasks WHERE investigation_id = ?').get(id);
    if (!row) return null;
    const task = decode<ReadonlyModelPreflightTask>(row.payload);
    if (!exact(task, ['investigationId', 'plan', 'status', 'generation', 'updatedAt', 'terminalAt', 'failureCode', 'reportHash'])) throw invalid();
    try { assertReadonlyModelPreflightPlan(task.plan); } catch { throw invalid(); }
    if (task.investigationId !== id || task.plan.id !== id || !statuses.includes(task.status) || !Number.isSafeInteger(task.generation)
      || task.generation < 0 || task.generation > 1 || !timestamp(task.updatedAt) || task.updatedAt < task.plan.createdAt
      || (terminal(task.status) ? !timestamp(task.terminalAt) || task.terminalAt > task.updatedAt || task.terminalAt < task.plan.createdAt : task.terminalAt !== null)
      || (['FAILED', 'BLOCKED', 'CANCELLED', 'INTERRUPTED'].includes(task.status) ? !validFailure(task.failureCode) : task.failureCode !== null)
      || (task.status === 'REPORTED' ? !digest(task.reportHash) : task.reportHash !== null)
      || (task.status === 'CANCELLED' && !['READONLY_MODEL_PREFLIGHT_CANCELLED', 'READONLY_MODEL_PREFLIGHT_INVALIDATED'].includes(task.failureCode!))
      || (task.status === 'INTERRUPTED' && task.failureCode !== 'READONLY_MODEL_PREFLIGHT_INTERRUPTED')
      || row.plan_hash !== task.plan.planHash || row.status !== task.status || row.terminal_at !== task.terminalAt) throw invalid();
    const marker = this.database.prepare('SELECT * FROM readonly_model_preflight_markers WHERE investigation_id = ?').get(id);
    if (!marker || marker.plan_hash !== task.plan.planHash || ![0, 1].includes(Number(marker.consumed))) throw invalid();
    return task;
  }

  private owned(id: string, context: ReadonlyContext): ReadonlyModelPreflightTask {
    const task = this.readTask(id);
    if (!task) throw new HarnessError('READONLY_MODEL_PREFLIGHT_NOT_FOUND');
    if (task.plan.ownerId !== context.ownerId) throw new HarnessError('READONLY_MODEL_PREFLIGHT_OWNER_MISMATCH');
    if (context.now.toISOString() < task.updatedAt) throw new HarnessError('READONLY_MODEL_PREFLIGHT_INVALID_TIME');
    this.assertRelations(task);
    return task;
  }

  private active(task: ReadonlyModelPreflightTask): ReadonlyModelPreflightApproval | null {
    const row = this.database.prepare('SELECT * FROM readonly_model_preflight_approvals WHERE investigation_id = ? AND used_at IS NULL AND revoked_at IS NULL').get(task.investigationId);
    return row ? this.parseApproval(row, task.plan) : null;
  }

  private parseApproval(row: Record<string, SQLOutputValue>, plan: ReadonlyModelPreflightPlan): ReadonlyModelPreflightApproval {
    const approval = decode<ReadonlyModelPreflightApproval>(row.payload);
    this.assertApproval(approval, plan);
    if (row.approval_id !== approval.approvalId || row.investigation_id !== approval.investigationId || row.used_at !== approval.usedAt || row.revoked_at !== approval.revokedAt) throw invalid();
    return approval;
  }

  private assertApproval(approval: ReadonlyModelPreflightApproval, plan: ReadonlyModelPreflightPlan): void {
    if (!exact(approval, ['approvalId', 'investigationId', 'ownerId', 'planHash', 'planSnapshot', 'createdAt', 'expiresAt', 'usedAt', 'revokedAt'])
      || !identifier(approval.approvalId) || approval.investigationId !== plan.id || approval.ownerId !== plan.ownerId
      || approval.planHash !== plan.planHash || JSON.stringify(approval.planSnapshot) !== JSON.stringify(plan)
      || !timestamp(approval.createdAt) || !timestamp(approval.expiresAt) || approval.createdAt < plan.createdAt
      || approval.expiresAt <= approval.createdAt || approval.expiresAt > plan.expiresAt
      || Date.parse(approval.expiresAt) - Date.parse(approval.createdAt) > 3_600_000
      || (approval.usedAt !== null && (!timestamp(approval.usedAt) || approval.usedAt < approval.createdAt || approval.usedAt >= approval.expiresAt))
      || (approval.revokedAt !== null && (!timestamp(approval.revokedAt) || approval.revokedAt < approval.createdAt))
      || (approval.usedAt !== null && approval.revokedAt !== null)) throw invalid();
  }

  private attempt(task: ReadonlyModelPreflightTask): ReadonlyModelPreflightAttempt | null {
    const row = this.database.prepare('SELECT * FROM readonly_model_preflight_attempts WHERE investigation_id = ?').get(task.investigationId);
    if (!row) return null;
    const attempt = decode<ReadonlyModelPreflightAttempt>(row.payload);
    if (!exact(attempt, ['attemptId', 'investigationId', 'approvalId', 'planHash', 'inputHash', 'requestBodyHash', 'connectionProfileHash', 'requestEnvelopeHash', 'configHash', 'generation', 'status', 'startedAt', 'dispatchedAt', 'finishedAt', 'failureCode', 'responseHash'])
      || !identifier(attempt.attemptId) || !identifier(attempt.approvalId) || attempt.investigationId !== task.investigationId || attempt.planHash !== task.plan.planHash
      || attempt.inputHash !== task.plan.inputHash || attempt.requestBodyHash !== task.plan.requestBodyHash || attempt.connectionProfileHash !== task.plan.connectionProfileHash || attempt.requestEnvelopeHash !== task.plan.requestEnvelopeHash || attempt.configHash !== task.plan.configHash
      || attempt.generation !== 0 || !timestamp(attempt.startedAt) || attempt.startedAt < task.plan.createdAt
      || !['RUNNING', 'REPORTED', 'FAILED', 'BLOCKED', 'CANCELLED', 'INTERRUPTED'].includes(attempt.status)
      || (attempt.dispatchedAt !== null && (!timestamp(attempt.dispatchedAt) || attempt.dispatchedAt < attempt.startedAt || attempt.dispatchedAt >= task.plan.expiresAt))
      || (attempt.status === 'RUNNING' ? attempt.finishedAt !== null || attempt.failureCode !== null || attempt.responseHash !== null
        : !timestamp(attempt.finishedAt) || attempt.finishedAt < attempt.startedAt || (attempt.dispatchedAt !== null && attempt.finishedAt < attempt.dispatchedAt))
      || (attempt.status === 'REPORTED' ? !digest(attempt.responseHash) || attempt.failureCode !== null || attempt.dispatchedAt === null
        : attempt.responseHash !== null || (attempt.status !== 'RUNNING' && !validFailure(attempt.failureCode)))
      || row.attempt_id !== attempt.attemptId || row.approval_id !== attempt.approvalId || row.status !== attempt.status) throw invalid();
    const approvalRow = this.database.prepare('SELECT * FROM readonly_model_preflight_approvals WHERE approval_id = ?').get(attempt.approvalId);
    if (!approvalRow) throw invalid();
    const approval = this.parseApproval(approvalRow, task.plan);
    if (approval.usedAt !== attempt.startedAt || approval.revokedAt !== null) throw invalid();
    return attempt;
  }

  private assertRelations(task: ReadonlyModelPreflightTask): void {
    const active = this.active(task);
    const attempt = this.attempt(task);
    const marker = this.database.prepare('SELECT consumed FROM readonly_model_preflight_markers WHERE investigation_id = ?').get(task.investigationId)!;
    if ((task.status === 'APPROVED') !== (active !== null) || (attempt !== null && active !== null)
      || (['AWAITING_APPROVAL', 'APPROVED'].includes(task.status) && attempt !== null)
      || (['RUNNING', 'REPORTED', 'INTERRUPTED'].includes(task.status) && attempt === null)
      || Number(marker.consumed) !== (attempt ? 1 : 0)) throw invalid();
    if (attempt && (attempt.status !== task.status || attempt.generation > task.generation || attempt.startedAt > task.updatedAt
      || (attempt.finishedAt !== null && (attempt.finishedAt > task.updatedAt || attempt.finishedAt !== task.terminalAt))
      || attempt.failureCode !== task.failureCode)) throw invalid();
  }

  private payload(task: ReadonlyModelPreflightTask): PayloadRecord | null {
    const row = this.database.prepare('SELECT * FROM readonly_model_preflight_payloads WHERE investigation_id = ?').get(task.investigationId);
    if (!row) return null;
    const record = decode<PayloadRecord>(row.payload, 2_097_152);
    if (!exact(record, ['payload', 'report']) || row.expires_at !== task.plan.expiresAt || row.payload_hash !== hash(String(row.payload))) throw invalid();
    try { validateReadonlyModelPreflightPayload(task.plan, record.payload); } catch { throw invalid(); }
    if (record.report !== null) this.assertReport(record.report, task, record.payload);
    if ((record.report ? hash(JSON.stringify(record.report)) : null) !== task.reportHash) throw invalid();
    const attempt = this.attempt(task);
    if (record.report && attempt?.responseHash !== record.report.responseHash) throw invalid();
    return record;
  }

  private assertReport(report: ReadonlyModelPreflightReport, task: ReadonlyModelPreflightTask, payload: ReadonlyModelPreflightPayload): void {
    if (!exact(report, ['mode', 'transport', 'responseOrigin', 'investigationId', 'planHash', 'contextHash', 'inputHash', 'requestBodyHash', 'connectionProfileHash', 'requestEnvelopeHash', 'responseHash', 'result', 'createdAt', 'targetUnchanged', 'executionAllowed', 'semanticAccuracyVerified', 'liveReady', 'offlineContractVerified', 'excludedOperationsReason', 'checks'])
      || report.mode !== 'offline' || report.transport !== 'in-memory-fake' || report.responseOrigin !== 'synthetic' || report.investigationId !== task.investigationId || report.planHash !== task.plan.planHash
      || report.contextHash !== task.plan.contextHash || report.inputHash !== task.plan.inputHash || report.requestBodyHash !== task.plan.requestBodyHash || report.connectionProfileHash !== task.plan.connectionProfileHash || report.requestEnvelopeHash !== task.plan.requestEnvelopeHash || !digest(report.responseHash)
      || !timestamp(report.createdAt) || report.createdAt < task.plan.createdAt || report.createdAt >= task.plan.expiresAt
      || report.targetUnchanged !== true || report.executionAllowed !== false || report.semanticAccuracyVerified !== false || report.liveReady !== false
      || JSON.stringify(report.offlineContractVerified) !== JSON.stringify({ profile: 'passed', envelope: 'passed', response: 'passed', evidence: 'passed' }) || report.excludedOperationsReason !== 'offline-fake-only'
      || JSON.stringify(report.checks) !== JSON.stringify({ sourceUnchanged: 'passed', targetCodeExecution: 'not_run', realModel: 'not_run', externalTransmission: 'not_run', credentialAccess: 'not_run', providerCompatibility: 'not_run', liveIsolation: 'not_run', semanticAccuracy: 'not_run' })) throw invalid();
    try { parseReadonlyModelPreflightResult(JSON.stringify(report.result), payload); } catch { throw invalid(); }
  }

  private snapshot(task: ReadonlyModelPreflightTask, context: ReadonlyContext, offset = 0): ReadonlyModelPreflightSnapshot {
    this.assertRelations(task);
    const count = Number(this.database.prepare('SELECT COUNT(*) AS total FROM readonly_model_preflight_approvals WHERE investigation_id = ?').get(task.investigationId)!.total);
    const rows = this.database.prepare('SELECT * FROM readonly_model_preflight_approvals WHERE investigation_id = ? ORDER BY rowid DESC LIMIT 1 OFFSET ?').all(task.investigationId, offset);
    const stored = context.now.toISOString() < task.plan.expiresAt ? this.payload(task) : null;
    return { task: structuredClone(task), approvals: rows.map((row) => this.parseApproval(row, task.plan)),
      approvalPage: { offset, total: count, nextOffset: offset + rows.length < count ? offset + rows.length : null }, attempt: this.attempt(task),
      payload: stored?.payload ?? null, report: stored?.report ?? null, payloadExpired: context.now.toISOString() >= task.plan.expiresAt };
  }

  private revoke(task: ReadonlyModelPreflightTask, context: ReadonlyContext): void {
    const approval = this.active(task);
    if (approval) this.writeApproval({ ...approval, revokedAt: context.now.toISOString() }, task.plan);
  }
  private writeTask(task: ReadonlyModelPreflightTask): void {
    this.database.prepare('UPDATE readonly_model_preflight_tasks SET status = ?, terminal_at = ?, payload = ? WHERE investigation_id = ?')
      .run(task.status, task.terminalAt, JSON.stringify(task), task.investigationId);
  }
  private writeApproval(approval: ReadonlyModelPreflightApproval, plan: ReadonlyModelPreflightPlan): void {
    this.assertApproval(approval, plan);
    this.database.prepare('UPDATE readonly_model_preflight_approvals SET used_at = ?, revoked_at = ?, payload = ? WHERE approval_id = ?')
      .run(approval.usedAt, approval.revokedAt, JSON.stringify(approval), approval.approvalId);
  }
  private writeAttempt(attempt: ReadonlyModelPreflightAttempt): void {
    this.database.prepare('UPDATE readonly_model_preflight_attempts SET status = ?, payload = ? WHERE attempt_id = ?').run(attempt.status, JSON.stringify(attempt), attempt.attemptId);
  }
  private writePayload(task: ReadonlyModelPreflightTask, record: PayloadRecord, insert: boolean): void {
    const text = JSON.stringify(record);
    if (Buffer.byteLength(text) > 2_097_152) throw invalid();
    if (insert) this.database.prepare('INSERT INTO readonly_model_preflight_payloads VALUES (?, ?, ?, ?)').run(task.investigationId, task.plan.expiresAt, hash(text), text);
    else if (this.database.prepare('UPDATE readonly_model_preflight_payloads SET payload_hash = ?, payload = ? WHERE investigation_id = ?').run(hash(text), text, task.investigationId).changes !== 1) throw invalid();
  }
  private protectFiles(): void {
    if (!isAbsolute(this.filePath)) throw new HarnessError('UNSAFE_RUNTIME_PATH');
    const directory = dirname(this.filePath);
    const metadata = lstatSync(directory);
    if (!process.getuid || !metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
      || (metadata.mode & 0o7777) !== 0o700 || realpathSync(directory) !== directory) throw new HarnessError('UNSAFE_RUNTIME_PATH');
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const path = `${this.filePath}${suffix}`;
      assertRuntimeFile(path);
      const file = runtimePathMetadata(path);
      if (file && (file.uid !== process.getuid() || (file.mode & 0o7777) !== 0o600)) throw new HarnessError('UNSAFE_RUNTIME_FILE');
    }
  }
  private transaction<T>(operation: () => T): T {
    if (this.transactionOpen) throw new HarnessError('READONLY_MODEL_PREFLIGHT_TRANSACTION_IN_PROGRESS');
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
