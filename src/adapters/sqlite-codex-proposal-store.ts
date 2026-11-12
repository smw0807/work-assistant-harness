import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type {
  CodexProposalApproval, CodexProposalApprovalRequest, CodexProposalAttempt, CodexProposalContext,
  CodexProposalExport, CodexProposalPlan, CodexProposalResult, CodexProposalSnapshot, CodexProposalTask,
} from '../domain/codex-proposal.js';
import { HarnessError } from '../domain/errors.js';
import type { CodexProposalStore } from '../ports/codex-proposal.js';
import {
  assertCodexProposalApprovalRequest, assertCodexProposalContext, assertCodexProposalPlan, assertCodexProposalResult,
  codexProposalExactKeys as exactKeys, hashCodexProposalValue, isCodexProposalHash as digest,
  isCodexProposalId as id, isCodexProposalTime as time,
} from '../policy/codex-proposal-policy.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

const invalid = (): HarnessError => new HarnessError('CODEX_PROPOSAL_INVALID_RECORD');
const failure = (value: unknown): value is string => typeof value === 'string'
  && ['CODEX_PROPOSAL_CALL_FAILED', 'CODEX_PROPOSAL_INVALID_RESPONSE', 'CODEX_PROPOSAL_OUTPUT_LIMIT',
    'CODEX_PROPOSAL_CANCELLED', 'CODEX_PROPOSAL_INTERRUPTED', 'CODEX_PROPOSAL_PLAN_EXPIRED'].includes(value);
const callFailure = (value: unknown): boolean => typeof value === 'string'
  && ['CODEX_PROPOSAL_CALL_FAILED', 'CODEX_PROPOSAL_INVALID_RESPONSE', 'CODEX_PROPOSAL_OUTPUT_LIMIT'].includes(value);
const resultHash = (result: CodexProposalResult | null): string | null => result === null ? null
  : hashCodexProposalValue(JSON.stringify({ path: result.path, content: result.content, responseHash: result.responseHash }));
const decode = <T>(value: unknown): T => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65_536) throw invalid();
  try { return JSON.parse(value) as T; } catch { throw invalid(); }
};

/** 호출 승인 소비와 단일 시도를 commit한 뒤에만 외부 모델 포트로 넘어간다. */
export class SqliteCodexProposalStore implements CodexProposalStore {
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
      CREATE TABLE IF NOT EXISTS codex_proposal_tasks (
        proposal_id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, status TEXT NOT NULL, result_hash TEXT, payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS codex_proposal_approvals (
        approval_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES codex_proposal_tasks(proposal_id),
        used_at TEXT, revoked_at TEXT, payload TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS codex_proposal_active ON codex_proposal_approvals(proposal_id)
        WHERE used_at IS NULL AND revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS codex_proposal_attempts (
        attempt_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES codex_proposal_tasks(proposal_id),
        approval_id TEXT NOT NULL UNIQUE REFERENCES codex_proposal_approvals(approval_id), status TEXT NOT NULL, payload TEXT NOT NULL
      ) STRICT;
    `);
  }

  create(plan: CodexProposalPlan, context: CodexProposalContext): CodexProposalTask {
    assertCodexProposalContext(context);
    assertCodexProposalPlan(plan);
    if (plan.ownerId !== context.ownerId) throw new HarnessError('CODEX_PROPOSAL_OWNER_MISMATCH');
    if (context.now.toISOString() < plan.createdAt) throw new HarnessError('CODEX_PROPOSAL_INVALID_TIME');
    return this.transaction(() => {
      const previous = this.findTask(plan.proposalId);
      if (previous) {
        if (previous.plan.planHash !== plan.planHash) throw new HarnessError('CODEX_PROPOSAL_PLAN_CONFLICT');
        return this.maintain(this.owned(plan.proposalId, context), context);
      }
      const task: CodexProposalTask = { proposalId: plan.proposalId, plan: structuredClone(plan), status: 'AWAITING_APPROVAL',
        generation: 0, updatedAt: context.now.toISOString(), cancelledAt: null, exportedAt: null, failureCode: null, result: null };
      this.database.prepare('INSERT INTO codex_proposal_tasks VALUES (?, ?, ?, NULL, ?)')
        .run(task.proposalId, plan.planHash, task.status, JSON.stringify(task));
      return this.maintain(task, context);
    });
  }

  inspect(proposalId: string, context: CodexProposalContext, offset = 0): CodexProposalSnapshot {
    assertCodexProposalContext(context);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000_000) throw new HarnessError('CODEX_PROPOSAL_INVALID_OFFSET');
    return this.transaction(() => this.snapshot(this.maintain(this.owned(proposalId, context), context), offset));
  }

  approve(request: CodexProposalApprovalRequest, context: CodexProposalContext): CodexProposalApproval {
    assertCodexProposalContext(context);
    assertCodexProposalApprovalRequest(request);
    return this.outcome(() => {
      const task = this.maintain(this.owned(request.proposalId, context), context);
      if (task.plan.planHash !== request.planHash) return new HarnessError('CODEX_PROPOSAL_PLAN_HASH_MISMATCH');
      if (task.status !== 'AWAITING_APPROVAL' || this.active(task) || this.attempt(task)) return new HarnessError('CODEX_PROPOSAL_NOT_READY');
      const approval: CodexProposalApproval = { approvalId: randomUUID(), proposalId: task.proposalId, ownerId: context.ownerId,
        planHash: task.plan.planHash, planSnapshot: structuredClone(task.plan), createdAt: context.now.toISOString(),
        expiresAt: new Date(Math.min(context.now.getTime() + request.expiresInMinutes * 60_000, Date.parse(task.plan.expiresAt))).toISOString(),
        usedAt: null, revokedAt: null };
      this.assertApproval(approval, task.plan);
      this.database.prepare('INSERT INTO codex_proposal_approvals VALUES (?, ?, NULL, NULL, ?)')
        .run(approval.approvalId, task.proposalId, JSON.stringify(approval));
      this.writeTask({ ...task, status: 'APPROVED', updatedAt: context.now.toISOString() });
      return approval;
    });
  }

  claim(proposalId: string, planHash: string, context: CodexProposalContext): CodexProposalAttempt {
    assertCodexProposalContext(context);
    return this.outcome(() => {
      const task = this.maintain(this.owned(proposalId, context), context);
      if (!digest(planHash) || task.plan.planHash !== planHash) return new HarnessError('CODEX_PROPOSAL_PLAN_HASH_MISMATCH');
      const approval = this.active(task);
      if (task.status !== 'APPROVED' || !approval || this.attempt(task)) return new HarnessError('CODEX_PROPOSAL_APPROVAL_REQUIRED');
      const attempt: CodexProposalAttempt = { attemptId: randomUUID(), proposalId, approvalId: approval.approvalId, planHash,
        generation: task.generation, status: 'RUNNING', startedAt: context.now.toISOString(), finishedAt: null, failureCode: null, responseHash: null };
      this.writeApproval({ ...approval, usedAt: context.now.toISOString() }, task.plan);
      this.database.prepare('INSERT INTO codex_proposal_attempts VALUES (?, ?, ?, ?, ?)')
        .run(attempt.attemptId, proposalId, approval.approvalId, attempt.status, JSON.stringify(attempt));
      this.writeTask({ ...task, status: 'RUNNING', updatedAt: context.now.toISOString() });
      return attempt;
    });
  }

  assertRunnable(proposalId: string, generation: number, context: CodexProposalContext): void {
    assertCodexProposalContext(context);
    this.transaction(() => {
      const task = this.owned(proposalId, context);
      if (task.status !== 'RUNNING' || task.generation !== generation || task.cancelledAt !== null) throw new HarnessError('CODEX_PROPOSAL_CANCELLED');
    });
  }

  finish(proposalId: string, generation: number, result: CodexProposalResult | null, failureCode: string | null, context: CodexProposalContext): CodexProposalSnapshot {
    assertCodexProposalContext(context);
    if (result !== null) assertCodexProposalResult(result);
    if ((result === null) !== (failureCode !== null) || (failureCode !== null && !callFailure(failureCode))) throw invalid();
    return this.transaction(() => {
      const task = this.owned(proposalId, context);
      if (['CANCELLED', 'INTERRUPTED'].includes(task.status)) return this.snapshot(task);
      if (task.status !== 'RUNNING' || task.generation !== generation) throw new HarnessError('CODEX_PROPOSAL_NOT_RUNNING');
      const attempt = this.attempt(task)!;
      const status = result ? 'READY' : 'FAILED';
      this.writeAttempt({ ...attempt, status, finishedAt: context.now.toISOString(), failureCode, responseHash: result?.responseHash ?? null });
      const finished: CodexProposalTask = { ...task, status, result: result ? structuredClone(result) : null,
        failureCode, updatedAt: context.now.toISOString() };
      this.writeTask(finished);
      return this.snapshot(finished);
    });
  }

  cancel(proposalId: string, context: CodexProposalContext): CodexProposalSnapshot {
    assertCodexProposalContext(context);
    return this.transaction(() => {
      const task = this.owned(proposalId, context);
      if (['FAILED', 'CANCELLED', 'INTERRUPTED', 'EXPORTED'].includes(task.status)) return this.snapshot(task);
      this.revoke(task, context);
      const attempt = this.attempt(task);
      if (attempt?.status === 'RUNNING') this.writeAttempt({ ...attempt, status: 'CANCELLED',
        finishedAt: context.now.toISOString(), failureCode: 'CODEX_PROPOSAL_CANCELLED' });
      const cancelled: CodexProposalTask = { ...task, status: 'CANCELLED', generation: task.generation + 1,
        cancelledAt: context.now.toISOString(), updatedAt: context.now.toISOString(), failureCode: 'CODEX_PROPOSAL_CANCELLED' };
      this.writeTask(cancelled);
      return this.snapshot(cancelled);
    });
  }

  recover(proposalId: string, context: CodexProposalContext): CodexProposalSnapshot {
    assertCodexProposalContext(context);
    return this.transaction(() => {
      const task = this.owned(proposalId, context);
      if (task.status !== 'RUNNING') return this.snapshot(task);
      const attempt = this.attempt(task)!;
      this.writeAttempt({ ...attempt, status: 'INTERRUPTED', finishedAt: context.now.toISOString(), failureCode: 'CODEX_PROPOSAL_INTERRUPTED' });
      const recovered: CodexProposalTask = { ...task, status: 'INTERRUPTED', updatedAt: context.now.toISOString(), failureCode: 'CODEX_PROPOSAL_INTERRUPTED' };
      this.writeTask(recovered);
      return this.snapshot(recovered);
    });
  }

  consumeForExecution(proposalId: string, context: CodexProposalContext): CodexProposalExport {
    assertCodexProposalContext(context);
    return this.transaction(() => {
      const task = this.owned(proposalId, context);
      if (context.now.toISOString() >= task.plan.expiresAt) throw new HarnessError('CODEX_PROPOSAL_PLAN_EXPIRED');
      if (task.status !== 'READY' || task.result === null || task.exportedAt !== null) throw new HarnessError('CODEX_PROPOSAL_NOT_READY');
      this.writeTask({ ...task, status: 'EXPORTED', exportedAt: context.now.toISOString(), updatedAt: context.now.toISOString() });
      return { proposalId, workType: task.plan.workType, inputHash: task.plan.inputHash, configHash: task.plan.configHash, ...structuredClone(task.result) };
    });
  }

  close(): void { this.database.close(); }

  private maintain(task: CodexProposalTask, context: CodexProposalContext): CodexProposalTask {
    if (!['AWAITING_APPROVAL', 'APPROVED'].includes(task.status)) return task;
    if (context.now.toISOString() >= task.plan.expiresAt) {
      this.revoke(task, context);
      task = { ...task, status: 'FAILED', failureCode: 'CODEX_PROPOSAL_PLAN_EXPIRED', updatedAt: context.now.toISOString() };
      this.writeTask(task);
    } else {
      const approval = this.active(task);
      if (approval && context.now.toISOString() >= approval.expiresAt) {
        this.revoke(task, context);
        task = { ...task, status: 'AWAITING_APPROVAL', updatedAt: context.now.toISOString() };
        this.writeTask(task);
      }
    }
    return task;
  }

  private revoke(task: CodexProposalTask, context: CodexProposalContext): void {
    const approval = this.active(task);
    if (approval) this.writeApproval({ ...approval, revokedAt: context.now.toISOString() }, task.plan);
  }

  private snapshot(task: CodexProposalTask, offset = 0): CodexProposalSnapshot {
    this.assertRelations(task);
    const total = Number(this.database.prepare('SELECT COUNT(*) AS count FROM codex_proposal_approvals WHERE proposal_id = ?').get(task.proposalId)!.count);
    const rows = this.database.prepare('SELECT * FROM codex_proposal_approvals WHERE proposal_id = ? ORDER BY rowid DESC LIMIT 1 OFFSET ?').all(task.proposalId, offset);
    return { task: structuredClone(task), approvals: rows.map((row) => this.parseApproval(row, task.plan)),
      approvalPage: { offset, total, nextOffset: offset + rows.length < total ? offset + rows.length : null }, attempt: this.attempt(task) };
  }

  private findTask(proposalId: string): CodexProposalTask | null {
    if (!id(proposalId)) throw new HarnessError('CODEX_PROPOSAL_INVALID_ID');
    const row = this.database.prepare('SELECT * FROM codex_proposal_tasks WHERE proposal_id = ?').get(proposalId);
    if (!row) return null;
    const task = decode<CodexProposalTask>(row.payload);
    this.assertTask(task);
    if (row.proposal_id !== task.proposalId || row.plan_hash !== task.plan.planHash || row.status !== task.status
      || row.result_hash !== resultHash(task.result)) throw invalid();
    return task;
  }

  private owned(proposalId: string, context: CodexProposalContext): CodexProposalTask {
    const task = this.findTask(proposalId);
    if (!task) throw new HarnessError('CODEX_PROPOSAL_NOT_FOUND');
    if (task.plan.ownerId !== context.ownerId) throw new HarnessError('CODEX_PROPOSAL_OWNER_MISMATCH');
    if (context.now.toISOString() < task.updatedAt) throw new HarnessError('CODEX_PROPOSAL_INVALID_TIME');
    this.assertRelations(task);
    return task;
  }

  private active(task: CodexProposalTask): CodexProposalApproval | null {
    const row = this.database.prepare('SELECT * FROM codex_proposal_approvals WHERE proposal_id = ? AND used_at IS NULL AND revoked_at IS NULL').get(task.proposalId);
    return row ? this.parseApproval(row, task.plan) : null;
  }

  private parseApproval(row: Record<string, SQLOutputValue>, plan: CodexProposalPlan): CodexProposalApproval {
    const approval = decode<CodexProposalApproval>(row.payload);
    this.assertApproval(approval, plan);
    if (row.approval_id !== approval.approvalId || row.proposal_id !== approval.proposalId
      || row.used_at !== approval.usedAt || row.revoked_at !== approval.revokedAt) throw invalid();
    return approval;
  }

  private attempt(task: CodexProposalTask): CodexProposalAttempt | null {
    const row = this.database.prepare('SELECT * FROM codex_proposal_attempts WHERE proposal_id = ?').get(task.proposalId);
    if (!row) return null;
    const attempt = decode<CodexProposalAttempt>(row.payload);
    if (!exactKeys(attempt, ['attemptId', 'proposalId', 'approvalId', 'planHash', 'generation', 'status', 'startedAt', 'finishedAt', 'failureCode', 'responseHash'])
      || !id(attempt.attemptId) || !id(attempt.approvalId) || attempt.proposalId !== task.proposalId || attempt.planHash !== task.plan.planHash
      || attempt.generation !== 0 || !time(attempt.startedAt) || attempt.startedAt < task.plan.createdAt
      || !['RUNNING', 'READY', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(attempt.status)
      || (attempt.status === 'RUNNING' ? attempt.finishedAt !== null || attempt.failureCode !== null || attempt.responseHash !== null
        : !time(attempt.finishedAt) || attempt.finishedAt < attempt.startedAt)
      || (attempt.status === 'READY' ? !digest(attempt.responseHash) || attempt.failureCode !== null
        : attempt.responseHash !== null || (attempt.status !== 'RUNNING' && !failure(attempt.failureCode)))
      || (attempt.status === 'FAILED' && !callFailure(attempt.failureCode))
      || (attempt.status === 'CANCELLED' && attempt.failureCode !== 'CODEX_PROPOSAL_CANCELLED')
      || (attempt.status === 'INTERRUPTED' && attempt.failureCode !== 'CODEX_PROPOSAL_INTERRUPTED')
      || row.attempt_id !== attempt.attemptId || row.proposal_id !== attempt.proposalId
      || row.approval_id !== attempt.approvalId || row.status !== attempt.status) throw invalid();
    const approvalRow = this.database.prepare('SELECT * FROM codex_proposal_approvals WHERE approval_id = ?').get(attempt.approvalId);
    if (!approvalRow) throw invalid();
    const approval = this.parseApproval(approvalRow, task.plan);
    if (approval.usedAt !== attempt.startedAt || approval.revokedAt !== null) throw invalid();
    return attempt;
  }

  private assertRelations(task: CodexProposalTask): void {
    const active = this.active(task);
    const attempt = this.attempt(task);
    if ((task.status === 'APPROVED') !== (active !== null) || (attempt !== null && active !== null)
      || (['AWAITING_APPROVAL', 'APPROVED'].includes(task.status) && attempt !== null)
      || (['RUNNING', 'READY', 'EXPORTED', 'INTERRUPTED'].includes(task.status) && attempt === null)) throw invalid();
    if (attempt) {
      const expected = task.status === 'EXPORTED' || (task.status === 'CANCELLED' && task.result !== null) ? 'READY' : task.status;
      if (attempt.status !== expected || attempt.generation > task.generation
        || attempt.startedAt > task.updatedAt || (attempt.finishedAt !== null && attempt.finishedAt > task.updatedAt)
        || (task.exportedAt !== null && task.exportedAt < attempt.finishedAt!)
        || (task.cancelledAt !== null && task.cancelledAt < (attempt.finishedAt ?? attempt.startedAt))
        || attempt.responseHash !== (task.result?.responseHash ?? null)
        || (attempt.status !== 'READY' && attempt.failureCode !== task.failureCode)) throw invalid();
    } else if (task.result !== null || (task.status === 'FAILED' && task.failureCode !== 'CODEX_PROPOSAL_PLAN_EXPIRED')) throw invalid();
  }

  private assertTask(task: CodexProposalTask): void {
    if (!exactKeys(task, ['proposalId', 'plan', 'status', 'generation', 'updatedAt', 'cancelledAt', 'exportedAt', 'failureCode', 'result'])) throw invalid();
    assertCodexProposalPlan(task.plan);
    if (task.proposalId !== task.plan.proposalId || !time(task.updatedAt) || task.updatedAt < task.plan.createdAt
      || !['AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'READY', 'EXPORTED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status)
      || ![0, 1].includes(task.generation)
      || (task.status === 'CANCELLED' ? task.generation !== 1 || !time(task.cancelledAt) || task.cancelledAt > task.updatedAt || task.cancelledAt < task.plan.createdAt
        || task.failureCode !== 'CODEX_PROPOSAL_CANCELLED' : task.generation !== 0 || task.cancelledAt !== null)
      || (task.status === 'EXPORTED' ? !time(task.exportedAt) || task.exportedAt > task.updatedAt || task.exportedAt < task.plan.createdAt : task.exportedAt !== null)
      || (['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status) ? !failure(task.failureCode) : task.failureCode !== null)
      || (task.status === 'FAILED' && !callFailure(task.failureCode) && task.failureCode !== 'CODEX_PROPOSAL_PLAN_EXPIRED')
      || (task.status === 'INTERRUPTED' && task.failureCode !== 'CODEX_PROPOSAL_INTERRUPTED')
      || (['READY', 'EXPORTED'].includes(task.status) && task.result === null)
      || (!['READY', 'EXPORTED', 'CANCELLED'].includes(task.status) && task.result !== null)) throw invalid();
    if (task.result !== null) assertCodexProposalResult(task.result);
  }

  private assertApproval(approval: CodexProposalApproval, plan: CodexProposalPlan): void {
    if (!exactKeys(approval, ['approvalId', 'proposalId', 'ownerId', 'planHash', 'planSnapshot', 'createdAt', 'expiresAt', 'usedAt', 'revokedAt'])) throw invalid();
    assertCodexProposalPlan(approval.planSnapshot);
    if (!id(approval.approvalId) || approval.proposalId !== plan.proposalId || approval.ownerId !== plan.ownerId
      || approval.planHash !== plan.planHash || JSON.stringify(approval.planSnapshot) !== JSON.stringify(plan)
      || !time(approval.createdAt) || !time(approval.expiresAt) || approval.createdAt < plan.createdAt
      || approval.expiresAt <= approval.createdAt || approval.expiresAt > plan.expiresAt
      || Date.parse(approval.expiresAt) - Date.parse(approval.createdAt) > 3_600_000
      || (approval.usedAt !== null && (!time(approval.usedAt) || approval.usedAt < approval.createdAt || approval.usedAt >= approval.expiresAt))
      || (approval.revokedAt !== null && (!time(approval.revokedAt) || approval.revokedAt < approval.createdAt))
      || (approval.usedAt !== null && approval.revokedAt !== null)) throw invalid();
  }

  private writeTask(task: CodexProposalTask): void {
    this.assertTask(task);
    this.database.prepare('UPDATE codex_proposal_tasks SET status = ?, result_hash = ?, payload = ? WHERE proposal_id = ?')
      .run(task.status, resultHash(task.result), JSON.stringify(task), task.proposalId);
  }
  private writeApproval(approval: CodexProposalApproval, plan: CodexProposalPlan): void {
    this.assertApproval(approval, plan);
    this.database.prepare('UPDATE codex_proposal_approvals SET used_at = ?, revoked_at = ?, payload = ? WHERE approval_id = ?')
      .run(approval.usedAt, approval.revokedAt, JSON.stringify(approval), approval.approvalId);
  }
  private writeAttempt(attempt: CodexProposalAttempt): void {
    this.database.prepare('UPDATE codex_proposal_attempts SET status = ?, payload = ? WHERE attempt_id = ?')
      .run(attempt.status, JSON.stringify(attempt), attempt.attemptId);
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
  private outcome<T>(operation: () => T | HarnessError): T {
    const result = this.transaction(operation);
    if (result instanceof HarnessError) throw result;
    return result;
  }
  private transaction<T>(operation: () => T): T {
    if (this.transactionOpen) throw new HarnessError('CODEX_PROPOSAL_TRANSACTION_IN_PROGRESS');
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
