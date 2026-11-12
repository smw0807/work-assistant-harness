import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import {
  EXECUTION_POLICY_VERSION, BRANCH_EXECUTION_POLICY_VERSION,
  type ExecutionApproval, type ExecutionApprovalContext, type ExecutionApprovalRequest,
  type ExecutionRun, type ExecutionRunRequest, type ExecutionTask,
  type ExecutionControlRequest, type ExecutionRequestState, type ExecutionLifecycle,
  type ExecutionPhase, type ExecutionProgress, type ExecutionObservation,
  type ExecutionSnapshot, type ExecutionPolicyVersion,
} from '../domain/execution.js';
import type { ExecutionStore } from '../ports/execution.js';
import { assertExecutionPlan, assertExecutionPlanReady, sha256 } from '../policy/execution-policy.js';
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
const taskStatuses = ['AWAITING_APPROVAL', 'APPROVED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'INTERRUPTED'];
const terminalStatuses = ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'INTERRUPTED'];
const phases: ExecutionPhase[] = ['claimed', 'workspace_preparing', 'workspace_ready', 'patch_applying', 'patch_applied',
  'view_preparing', 'view_ready', 'container_creating', 'container_created', 'container_starting', 'command_finished',
  'finalizing', 'recovering', 'finished', 'legacy_untracked'];
const actionPhases: ExecutionPhase[] = ['workspace_preparing', 'patch_applying', 'view_preparing', 'container_creating', 'container_starting'];
const commandIds = ['synthetic-check-v1', 'synthetic-timeout-v1', 'synthetic-output-v1'];
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
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1_000_000_000;
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
  private transactionOpen = false;

  constructor(private readonly filePath: string, private readonly expectedPolicy: ExecutionPolicyVersion = EXECUTION_POLICY_VERSION) {
    if (![EXECUTION_POLICY_VERSION, BRANCH_EXECUTION_POLICY_VERSION].includes(expectedPolicy)) {
      throw new HarnessError('INVALID_EXECUTION_POLICY');
    }
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
      CREATE TABLE IF NOT EXISTS execution_requests (
        task_id TEXT PRIMARY KEY REFERENCES execution_tasks(task_id), payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS execution_control_events (
        event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES execution_tasks(task_id),
        request TEXT NOT NULL, result TEXT NOT NULL, recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS execution_lifecycles (
        run_id TEXT PRIMARY KEY REFERENCES execution_runs(run_id), sequence INTEGER NOT NULL, payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS execution_lifecycle_history (
        run_id TEXT NOT NULL REFERENCES execution_runs(run_id), sequence INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS execution_control_events_immutable_update BEFORE UPDATE ON execution_control_events
        BEGIN SELECT RAISE(ABORT, 'immutable execution control event'); END;
      CREATE TRIGGER IF NOT EXISTS execution_control_events_immutable_delete BEFORE DELETE ON execution_control_events
        BEGIN SELECT RAISE(ABORT, 'immutable execution control event'); END;
      CREATE TRIGGER IF NOT EXISTS execution_lifecycle_history_immutable_update BEFORE UPDATE ON execution_lifecycle_history
        BEGIN SELECT RAISE(ABORT, 'immutable execution lifecycle history'); END;
      CREATE TRIGGER IF NOT EXISTS execution_lifecycle_history_immutable_delete BEFORE DELETE ON execution_lifecycle_history
        BEGIN SELECT RAISE(ABORT, 'immutable execution lifecycle history'); END;
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
      this.ensureRequestState(task.taskId);
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
    this.assertRequest(request, true);
    const maximumMinutes = this.expectedPolicy === BRANCH_EXECUTION_POLICY_VERSION ? 60 : 1_440;
    if (!Number.isSafeInteger(request.expiresInMinutes) || request.expiresInMinutes < 1 || request.expiresInMinutes > maximumMinutes) {
      throw new HarnessError('INVALID_EXECUTION_APPROVAL_REQUEST');
    }
    return this.transaction(() => {
      let task = this.requireTask(request.taskId);
      assertExecutionPlanReady(task.plan, context.ownerId, context.now);
      const expiresAt = new Date(context.now.getTime() + request.expiresInMinutes * 60_000).toISOString();
      if (task.plan.branch && expiresAt > task.plan.branch.expiresAt) {
        throw new HarnessError('EXECUTION_APPROVAL_EXCEEDS_PLAN_EXPIRY');
      }
      this.assertRequestActive(task.taskId, context.ownerId);
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
        executionPolicy: this.expectedPolicy, planSnapshot: structuredClone(task.plan),
        createdAt: context.now.toISOString(),
        expiresAt,
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
      const state = this.assertRequestActive(task.taskId, context.ownerId);
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
      assertExecutionPlanReady(task.plan, context.ownerId, context.now);
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
      this.writeLifecycle({
        runId: run.runId, taskId: run.taskId, generation: state.generation, sequence: 0,
        phase: 'claimed', updatedAt: startedAt, workspace: null, container: null, cleanup: null, observation: null, legacy: false,
      });
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
      const state = this.ensureRequestState(run.taskId);
      const lifecycle = this.ensureLifecycle(run.runId);
      const cancelled = state.invalidatedAt !== null || state.generation !== lifecycle.generation;
      const recordedCommand = run.commands.find((command) => command.containerName === lifecycle.container?.name);
      const containerClean = lifecycle.container === null || (lifecycle.cleanup?.stopped && lifecycle.cleanup.removed)
        || (recordedCommand?.stopped && recordedCommand.removed);
      const cleanupUnconfirmed = run.status === 'BLOCKED'
        || run.commands.some((command) => !command.stopped || !command.removed)
        || !containerClean || lifecycle.legacy;
      const finished: ExecutionRun = cancelled
        ? { ...run, status: cleanupUnconfirmed ? 'BLOCKED' : 'CANCELLED',
          failureCode: cleanupUnconfirmed ? 'EXECUTION_CLEANUP_UNCONFIRMED' : 'EXECUTION_CANCELLED' } : run;
      this.assertRun(finished);
      this.database.prepare('UPDATE execution_runs SET status = ?, payload = ? WHERE run_id = ? AND status = ?')
        .run(finished.status, JSON.stringify(finished), finished.runId, 'RUNNING');
      this.writeTask({ ...task, status: finished.status, updatedAt: finished.finishedAt as string });
      this.writeLifecycle({
        ...lifecycle, sequence: lifecycle.sequence + 1, phase: 'finished',
        updatedAt: new Date(Math.max(Date.parse(lifecycle.updatedAt), Date.parse(finished.finishedAt as string))).toISOString(),
        observation: finished.observation ?? lifecycle.observation,
      });
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

  inspect(taskId: string, offset: number): ExecutionSnapshot {
    return this.transaction(() => {
      const task = this.requireTask(taskId);
      const requestState = this.ensureRequestState(taskId);
      const runs = this.listRuns(taskId);
      const lifecycles = runs.map((run) => this.ensureLifecycle(run.runId));
      return structuredClone({ task, requestState, ...this.listApprovalHistory(taskId, offset), runs, lifecycles });
    });
  }

  requestState(taskId: string): ExecutionRequestState {
    return this.transaction(() => structuredClone(this.ensureRequestState(taskId)));
  }

  control(request: ExecutionControlRequest, context: ExecutionApprovalContext): ExecutionRequestState {
    assertContext(context);
    if (!hasKeys(request, ['taskId', 'eventId', 'kind', 'revision']) || !isText(request.taskId)
      || !isText(request.eventId) || !['cancel', 'edited', 'deleted'].includes(request.kind) || !isRevision(request.revision)) {
      throw new HarnessError('INVALID_EXECUTION_CONTROL_REQUEST');
    }
    return this.transaction(() => {
      const task = this.requireTask(request.taskId);
      const state = this.ensureRequestState(task.taskId);
      if (state.ownerId !== context.ownerId) throw new HarnessError('APPROVAL_OWNER_MISMATCH');
      this.assertOwners(this.listApprovals(task.taskId), context.ownerId);
      const encodedRequest = JSON.stringify({ taskId: request.taskId, eventId: request.eventId, kind: request.kind, revision: request.revision });
      const existing = this.database.prepare('SELECT request, result FROM execution_control_events WHERE event_id = ?').get(request.eventId);
      if (existing) {
        if (existing.request !== encodedRequest) throw new HarnessError('EXECUTION_CONTROL_EVENT_MISMATCH');
        this.assertRequestState(decode<ExecutionRequestState>(existing.result, 'INVALID_STORED_EXECUTION_REQUEST'));
        return state;
      }
      if (request.kind === 'cancel' && request.revision > state.revision) throw new HarnessError('EXECUTION_REQUEST_REVISION_MISMATCH');
      const applicable = request.kind === 'cancel' ? request.revision === state.revision : request.revision > state.revision;
      let result = state;
      if (applicable && !(request.kind === 'cancel' && state.invalidatedAt !== null)) {
        const timestamp = context.now.toISOString();
        if (timestamp < task.createdAt || this.listApprovals(task.taskId).some((approval) => timestamp < approval.createdAt)) {
          throw new HarnessError('INVALID_APPROVAL_TIME');
        }
        result = {
          ...state, revision: request.revision, generation: state.generation + 1, invalidatedAt: timestamp,
          reason: request.kind === 'cancel' ? 'OWNER_CANCELLED' : request.kind === 'edited' ? 'REQUEST_EDITED' : 'REQUEST_DELETED',
        };
        this.assertRequestState(result);
        this.database.prepare('UPDATE execution_requests SET payload = ? WHERE task_id = ?').run(JSON.stringify(result), task.taskId);
        for (const approval of this.listApprovals(task.taskId)) {
          if (approval.usedAt !== null || approval.revokedAt !== null) continue;
          const revoked = { ...approval, revokedAt: timestamp };
          this.database.prepare('UPDATE execution_approvals SET revoked_at = ?, payload = ? WHERE approval_id = ? AND used_at IS NULL AND revoked_at IS NULL')
            .run(timestamp, JSON.stringify(revoked), approval.approvalId);
        }
        if (['AWAITING_APPROVAL', 'APPROVED'].includes(task.status)) {
          this.writeTask({ ...task, status: 'CANCELLED', updatedAt: timestamp });
        }
      }
      this.database.prepare('INSERT INTO execution_control_events(event_id, task_id, request, result, recorded_at) VALUES (?, ?, ?, ?, ?)')
        .run(request.eventId, task.taskId, encodedRequest, JSON.stringify(result), context.now.toISOString());
      return structuredClone(result);
    });
  }

  lifecycle(runId: string): ExecutionLifecycle {
    return this.transaction(() => structuredClone(this.ensureLifecycle(runId)));
  }

  assertRunnable(runId: string): ExecutionLifecycle {
    if (this.transactionOpen) return this.assertRunActive(runId);
    return this.transaction(() => this.assertRunActive(runId));
  }

  checkpoint(runId: string, phase: ExecutionPhase, progress: ExecutionProgress = {}): ExecutionLifecycle {
    return this.transaction(() => this.checkpointWithinTransaction(runId, phase, progress));
  }

  /** 실제 spawn 호출까지만 직렬화하고 반환된 비동기 RPC는 트랜잭션 밖에서 기다린다. */
  dispatch<T>(runId: string, operation: () => T): T {
    return this.transaction(() => {
      this.assertRunActive(runId);
      return operation();
    });
  }

  /** 짧은 로컬 파일 동작 동안 취소 commit을 직렬화한다. 네트워크·컨테이너 대기는 이 guard에 넣지 않는다. */
  async guard<T>(runId: string, phase: ExecutionPhase, operation: () => Promise<T>): Promise<T> {
    if (!actionPhases.includes(phase)) throw new HarnessError('INVALID_EXECUTION_PHASE');
    this.beginTransaction();
    try {
      this.assertRunActive(runId);
      this.checkpointWithinTransaction(runId, phase, {});
      const result = await operation();
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

  close(): void { this.database.close(); }

  private ensureRequestState(taskId: string): ExecutionRequestState {
    const task = this.requireTask(taskId);
    const row = this.database.prepare('SELECT payload FROM execution_requests WHERE task_id = ?').get(taskId);
    if (row) {
      const state = decode<ExecutionRequestState>(row.payload, 'INVALID_STORED_EXECUTION_REQUEST');
      this.assertRequestState(state);
      if (state.taskId !== taskId || (task.plan.branch && state.ownerId !== task.plan.branch.ownerId)) {
        throw new HarnessError('INVALID_STORED_EXECUTION_REQUEST');
      }
      return state;
    }
    const approvals = this.listApprovals(taskId);
    if (typeof process.getuid !== 'function' && approvals.length === 0) throw new HarnessError('APPROVAL_OWNER_UNSUPPORTED');
    const ownerId = approvals[0]?.ownerId ?? `os-user:${process.getuid?.()}`;
    if (task.plan.branch && task.plan.branch.ownerId !== ownerId) throw new HarnessError('APPROVAL_OWNER_MISMATCH');
    this.assertOwners(approvals, ownerId);
    const state: ExecutionRequestState = {
      taskId: task.taskId, requestId: `synthetic:${task.taskId}`, ownerId, revision: 1, generation: 0,
      invalidatedAt: null, reason: null,
    };
    this.assertRequestState(state);
    this.database.prepare('INSERT INTO execution_requests(task_id, payload) VALUES (?, ?)').run(taskId, JSON.stringify(state));
    return state;
  }

  private assertRequestState(state: ExecutionRequestState): void {
    if (!hasKeys(state, ['taskId', 'requestId', 'ownerId', 'revision', 'generation', 'invalidatedAt', 'reason'])
      || !isText(state.taskId) || state.requestId !== `synthetic:${state.taskId}` || !/^os-user:\d+$/.test(state.ownerId)
      || !isRevision(state.revision) || !Number.isSafeInteger(state.generation) || state.generation < 0 || state.generation > 1_000_000_000
      || (state.invalidatedAt !== null && !isTimestamp(state.invalidatedAt))
      || (state.reason !== null && !['OWNER_CANCELLED', 'REQUEST_EDITED', 'REQUEST_DELETED'].includes(state.reason))
      || (state.invalidatedAt === null) !== (state.reason === null)
      || (state.generation === 0) !== (state.invalidatedAt === null)) throw new HarnessError('INVALID_STORED_EXECUTION_REQUEST');
  }

  private assertRequestActive(taskId: string, ownerId: string): ExecutionRequestState {
    const state = this.ensureRequestState(taskId);
    if (state.ownerId !== ownerId) throw new HarnessError('APPROVAL_OWNER_MISMATCH');
    if (state.invalidatedAt !== null) throw new HarnessError('EXECUTION_CANCELLED');
    return state;
  }

  private ensureLifecycle(runId: string): ExecutionLifecycle {
    const run = this.findRun(runId);
    if (!run) throw new HarnessError('EXECUTION_RUN_NOT_FOUND');
    const row = this.database.prepare('SELECT sequence, payload FROM execution_lifecycles WHERE run_id = ?').get(runId);
    if (row) {
      const lifecycle = decode<ExecutionLifecycle>(row.payload, 'INVALID_STORED_EXECUTION_LIFECYCLE');
      this.assertLifecycle(lifecycle);
      const history = this.database.prepare('SELECT payload FROM execution_lifecycle_history WHERE run_id = ? AND sequence = ?')
        .get(runId, lifecycle.sequence);
      if (lifecycle.runId !== runId || lifecycle.taskId !== run.taskId || row.sequence !== lifecycle.sequence) {
        throw new HarnessError('INVALID_STORED_EXECUTION_LIFECYCLE');
      }
      if (history?.payload !== row.payload) throw new HarnessError('INVALID_STORED_EXECUTION_LIFECYCLE');
      return lifecycle;
    }
    const state = this.ensureRequestState(run.taskId);
    const lifecycle: ExecutionLifecycle = {
      runId, taskId: run.taskId, generation: state.generation, sequence: 0, phase: 'legacy_untracked',
      updatedAt: run.finishedAt ?? run.startedAt, workspace: null, container: null, cleanup: null, observation: null, legacy: true,
    };
    this.writeLifecycle(lifecycle);
    return lifecycle;
  }

  private assertRunActive(runId: string): ExecutionLifecycle {
    const run = this.findRun(runId);
    if (!run) throw new HarnessError('EXECUTION_RUN_NOT_FOUND');
    const lifecycle = this.ensureLifecycle(runId);
    const task = this.requireTask(run.taskId);
    const state = this.ensureRequestState(run.taskId);
    if (run.status !== 'RUNNING' || task.status !== 'RUNNING' || lifecycle.legacy
      || state.invalidatedAt !== null || state.generation !== lifecycle.generation) throw new HarnessError('EXECUTION_CANCELLED');
    return structuredClone(lifecycle);
  }

  private checkpointWithinTransaction(runId: string, phase: ExecutionPhase, progress: ExecutionProgress): ExecutionLifecycle {
    if (!phases.includes(phase) || !progress || typeof progress !== 'object' || Array.isArray(progress)
      || Object.keys(progress).some((key) => !['workspace', 'container', 'cleanup', 'observation', 'command', 'sourceBeforeHash', 'worktreeRoot', 'diff', 'checks'].includes(key))) {
      throw new HarnessError('INVALID_EXECUTION_PROGRESS');
    }
    const run = this.findRun(runId);
    if (!run) throw new HarnessError('EXECUTION_RUN_NOT_FOUND');
    const current = actionPhases.includes(phase) ? this.assertRunActive(runId) : this.ensureLifecycle(runId);
    if (run.status !== 'RUNNING' && phase === 'finished' && current.phase === 'finished' && Object.keys(progress).length === 0) {
      return structuredClone(current);
    }
    if (run.status !== 'RUNNING' && !(run.status === 'BLOCKED' && ['recovering', 'finished'].includes(phase))) {
      throw new HarnessError('EXECUTION_RUN_ALREADY_FINISHED');
    }
    if (run.status !== 'RUNNING' && ['command', 'sourceBeforeHash', 'worktreeRoot', 'diff', 'checks'].some((key) => key in progress)) {
      throw new HarnessError('EXECUTION_RUN_ALREADY_FINISHED');
    }
    const workspace = progress.workspace ?? current.workspace;
    if (current.workspace && progress.workspace
      && (current.workspace.worktreeRoot !== progress.workspace.worktreeRoot || current.workspace.containerRoot !== progress.workspace.containerRoot
        || current.workspace.planHash !== progress.workspace.planHash || current.workspace.gitHash !== progress.workspace.gitHash
        || (current.workspace.viewHash !== null && current.workspace.viewHash !== progress.workspace.viewHash))) {
      throw new HarnessError('EXECUTION_WORKSPACE_IDENTITY_MISMATCH');
    }
    const container = progress.container ?? current.container;
    if (current.container && progress.container
      && (current.container.runId !== progress.container.runId || current.container.name !== progress.container.name
        || current.container.token !== progress.container.token || current.container.commandId !== progress.container.commandId
        || (current.container.id !== null && current.container.id !== progress.container.id))) {
      throw new HarnessError('EXECUTION_CONTAINER_IDENTITY_MISMATCH');
    }
    const lifecycle: ExecutionLifecycle = {
      ...current, sequence: current.sequence + 1, phase,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt))).toISOString(),
      workspace, container, cleanup: progress.cleanup ?? current.cleanup, observation: progress.observation ?? current.observation,
    };
    this.assertLifecycle(lifecycle);
    const task = this.requireTask(run.taskId);
    if (workspace && workspace.planHash !== task.plan.planHash) throw new HarnessError('EXECUTION_WORKSPACE_IDENTITY_MISMATCH');
    if (container && (container.runId !== runId || !task.plan.commands.some((command) => command.commandId === container.commandId))) {
      throw new HarnessError('EXECUTION_CONTAINER_IDENTITY_MISMATCH');
    }
    const worktreeRoot = progress.worktreeRoot ?? workspace?.worktreeRoot ?? run.worktreeRoot;
    if ((run.worktreeRoot !== null && worktreeRoot !== run.worktreeRoot)
      || (workspace && worktreeRoot !== workspace.worktreeRoot)) {
      throw new HarnessError('EXECUTION_WORKSPACE_IDENTITY_MISMATCH');
    }
    if (progress.sourceBeforeHash && run.sourceBeforeHash !== null && progress.sourceBeforeHash !== run.sourceBeforeHash) {
      throw new HarnessError('EXECUTION_RUN_IDENTITY_MISMATCH');
    }
    const commands = [...run.commands];
    if (progress.command) {
      const existing = commands.find((command) => command.commandId === progress.command!.commandId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(progress.command)) throw new HarnessError('EXECUTION_COMMAND_RESULT_MISMATCH');
      if (!existing) commands.push(progress.command);
    }
    const updatedRun: ExecutionRun = {
      ...run, commands, worktreeRoot,
      sourceBeforeHash: progress.sourceBeforeHash ?? run.sourceBeforeHash,
      diff: progress.diff ?? run.diff, checks: progress.checks ?? run.checks,
      ...(progress.observation ? { observation: progress.observation } : {}),
    };
    this.assertRun(updatedRun);
    if (run.status === 'RUNNING') this.database.prepare('UPDATE execution_runs SET payload = ? WHERE run_id = ?').run(JSON.stringify(updatedRun), runId);
    this.writeLifecycle(lifecycle);
    return structuredClone(lifecycle);
  }

  private writeLifecycle(lifecycle: ExecutionLifecycle): void {
    this.assertLifecycle(lifecycle);
    const payload = JSON.stringify(lifecycle);
    this.database.prepare('INSERT INTO execution_lifecycle_history(run_id, sequence, payload) VALUES (?, ?, ?)')
      .run(lifecycle.runId, lifecycle.sequence, payload);
    this.database.prepare(`INSERT INTO execution_lifecycles(run_id, sequence, payload) VALUES (?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET sequence = excluded.sequence, payload = excluded.payload`)
      .run(lifecycle.runId, lifecycle.sequence, payload);
  }

  private assertLifecycle(lifecycle: ExecutionLifecycle): void {
    const code = 'INVALID_STORED_EXECUTION_LIFECYCLE';
    if (!hasKeys(lifecycle, ['runId', 'taskId', 'generation', 'sequence', 'phase', 'updatedAt', 'workspace', 'container', 'cleanup', 'observation', 'legacy'])
      || !isText(lifecycle.runId) || !isText(lifecycle.taskId) || !Number.isSafeInteger(lifecycle.generation) || lifecycle.generation < 0
      || !Number.isSafeInteger(lifecycle.sequence) || lifecycle.sequence < 0 || !phases.includes(lifecycle.phase)
      || !isTimestamp(lifecycle.updatedAt) || typeof lifecycle.legacy !== 'boolean') throw new HarnessError(code);
    if (lifecycle.workspace !== null) {
      const value = lifecycle.workspace;
      if (!hasKeys(value, ['worktreeRoot', 'containerRoot', 'planHash', 'gitHash', 'viewHash']) || !isPath(value.worktreeRoot)
        || !isPath(value.containerRoot) || !digest.test(value.planHash) || !digest.test(value.gitHash) || !isDigestOrNull(value.viewHash)) throw new HarnessError(code);
    }
    if (lifecycle.container !== null) {
      const value = lifecycle.container;
      if (!hasKeys(value, ['runId', 'name', 'token', 'id', 'commandId']) || value.runId !== lifecycle.runId
        || !/^[a-f0-9-]{36}$/.test(value.token) || value.name !== `harness-execution-${value.token}`
        || (value.id !== null && !digest.test(value.id)) || !commandIds.includes(value.commandId)) throw new HarnessError(code);
    }
    if (lifecycle.cleanup !== null) {
      const value = lifecycle.cleanup;
      if (!hasKeys(value, ['found', 'stopped', 'removed', 'exitCode', 'oomKilled', 'failureCode'])
        || [value.found, value.stopped, value.removed, value.oomKilled].some((item) => typeof item !== 'boolean')
        || (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0))
        || (value.failureCode !== null && !isText(value.failureCode))) throw new HarnessError(code);
    }
    if (lifecycle.observation !== null) this.assertObservation(lifecycle.observation);
    decode(JSON.stringify(lifecycle), code);
  }

  private assertObservation(observation: ExecutionObservation): void {
    if (!hasKeys(observation, ['status', 'reason', 'changes', 'gitUnchanged', 'viewUnchanged', 'workspaceExists'])
      || !['passed', 'failed', 'not_run'].includes(observation.status) || !isText(observation.reason)
      || !Array.isArray(observation.changes) || observation.changes.length > 128 || typeof observation.workspaceExists !== 'boolean'
      || ![null, true, false].includes(observation.gitUnchanged) || ![null, true, false].includes(observation.viewUnchanged)) {
      throw new HarnessError('INVALID_EXECUTION_OBSERVATION');
    }
    for (const change of observation.changes) {
      if (!hasKeys(change, ['path', 'kind', 'beforeHash', 'afterHash', 'beforeMode', 'afterMode', 'inScope'])
        || !isText(change.path) || !['modified', 'added', 'deleted', 'mode', 'symlink', 'special'].includes(change.kind)
        || !isDigestOrNull(change.beforeHash) || !isDigestOrNull(change.afterHash) || typeof change.inScope !== 'boolean'
        || [change.beforeMode, change.afterMode].some((mode) => mode !== null && (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o177777))) {
        throw new HarnessError('INVALID_EXECUTION_OBSERVATION');
      }
    }
  }

  private assertTask(task: ExecutionTask): void {
    if (!hasKeys(task, taskKeys) || !isText(task.taskId) || !taskStatuses.includes(task.status)
      || !isText(task.requestRevision) || !commit.test(task.baseCommit) || !isPath(task.sourceRoot)
      || !isTimestamp(task.createdAt) || !isTimestamp(task.updatedAt) || task.updatedAt < task.createdAt) {
      throw new HarnessError('INVALID_EXECUTION_TASK');
    }
    assertExecutionPlan(task.plan);
    if (task.plan.policy.version !== this.expectedPolicy) throw new HarnessError('EXECUTION_POLICY_MISMATCH');
    if (task.plan.taskId !== task.taskId || task.plan.requestRevision !== task.requestRevision
      || task.plan.baseCommit !== task.baseCommit
      || (task.plan.branch && (task.plan.branch.sourceRoot !== task.sourceRoot || task.plan.branch.createdAt !== task.createdAt))) {
      throw new HarnessError('EXECUTION_CONTEXT_MISMATCH');
    }
  }

  private assertRequest(request: ExecutionRunRequest, approval = false): void {
    if (!request || !isText(request.taskId) || typeof request.planHash !== 'string' || !digest.test(request.planHash)
      || typeof request.baseCommit !== 'string' || !commit.test(request.baseCommit)
      || (this.expectedPolicy === BRANCH_EXECUTION_POLICY_VERSION
        && !hasKeys(request, ['taskId', 'planHash', 'baseCommit', ...(approval ? ['expiresInMinutes'] : [])]))) {
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
      || approval.executionPolicy !== this.expectedPolicy || !isTimestamp(approval.createdAt)
      || !isTimestamp(approval.expiresAt)
      || (approval.usedAt !== null && !isTimestamp(approval.usedAt))
      || (approval.revokedAt !== null && !isTimestamp(approval.revokedAt))) throw new HarnessError('INVALID_STORED_EXECUTION_APPROVAL');
    const ttl = (Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)) / 60_000;
    const maximumMinutes = this.expectedPolicy === BRANCH_EXECUTION_POLICY_VERSION ? 60 : 1_440;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > maximumMinutes
      || (approval.usedAt !== null && (approval.usedAt < approval.createdAt || approval.usedAt >= approval.expiresAt))
      || (approval.revokedAt !== null && approval.revokedAt < approval.createdAt)
      || (approval.usedAt !== null && approval.revokedAt !== null)) throw new HarnessError('INVALID_STORED_EXECUTION_APPROVAL');
    assertExecutionPlan(approval.planSnapshot);
    const branch = approval.planSnapshot.branch;
    if (approval.planSnapshot.policy.version !== this.expectedPolicy
      || approval.planSnapshot.policy.version !== approval.executionPolicy
      || (branch && (branch.ownerId !== approval.ownerId || approval.createdAt < branch.createdAt || approval.expiresAt > branch.expiresAt))
      || approval.planSnapshot.planHash !== approval.planHash || approval.planSnapshot.taskId !== approval.taskId
      || approval.planSnapshot.baseCommit !== approval.baseCommit || approval.planSnapshot.requestRevision !== approval.requestRevision) {
      throw new HarnessError('INVALID_STORED_EXECUTION_APPROVAL');
    }
  }

  private assertRun(run: ExecutionRun): void {
    if (!hasKeys(run, run?.observation === undefined ? runKeys : [...runKeys, 'observation']) || !isText(run.runId) || !isText(run.taskId) || !isText(run.approvalId)
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
    if (run.observation !== undefined) this.assertObservation(run.observation);
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
    this.requireTask(run.taskId);
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
    this.beginTransaction();
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

  private beginTransaction(): void {
    if (this.transactionOpen) throw new HarnessError('EXECUTION_TRANSACTION_IN_PROGRESS');
    this.protectFiles();
    this.database.exec('BEGIN IMMEDIATE');
    this.transactionOpen = true;
  }
}
