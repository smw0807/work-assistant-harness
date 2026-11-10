import { randomUUID } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import type {
  ExecutionApprovalContext, ExecutionApprovalRequest, ExecutionFixture, ExecutionPlan,
  ExecutionRun, ExecutionRunRequest, ExecutionTask, IsolatedExecutionPort,
} from '../domain/execution.js';
import type { SandboxConfig } from '../domain/sandbox.js';
import type { ExecutionStore } from '../ports/execution.js';
import {
  assertExecutionConfig, assertExecutionPlan, createExecutionPolicy, getExecutionCommand, hashExecutionPlan,
} from '../policy/execution-policy.js';
import { assertSandboxHost } from '../policy/sandbox-policy.js';
import { SyntheticExecutionWorkspace } from '../adapters/execution-workspace.js';

/** 기존 조사 Task와 기록용 승인을 실제 실행 승인으로 승격하지 않는다. */
export class SyntheticExecutionService {
  constructor(
    private readonly store: ExecutionStore,
    private readonly workspace: SyntheticExecutionWorkspace,
    private readonly backend: IsolatedExecutionPort,
    private readonly config: SandboxConfig,
    private readonly host = { platform: process.platform as string, architecture: process.arch as string },
  ) {}

  async plan(taskId: string, directory: string, fixture: ExecutionFixture): Promise<ExecutionTask> {
    const source = await this.workspace.prepare(directory, fixture);
    const content: Omit<ExecutionPlan, 'planHash'> = {
      planId: randomUUID(), version: 1, taskId, requestRevision: 'synthetic-1', repoId: 'synthetic-execution',
      baseCommit: source.baseCommit, sourceHash: source.sourceHash, allowedFiles: ['src/message.mjs'],
      patches: source.patches, commands: source.commandIds.map(getExecutionCommand), policy: createExecutionPolicy(this.config),
    };
    const plan: ExecutionPlan = { ...content, planHash: hashExecutionPlan(content) };
    assertExecutionPlan(plan);
    const now = new Date().toISOString();
    const task: ExecutionTask = {
      taskId, status: 'AWAITING_APPROVAL', requestRevision: plan.requestRevision, baseCommit: plan.baseCommit,
      sourceRoot: source.sourceRoot, createdAt: now, updatedAt: now, plan,
    };
    this.store.create(task);
    return task;
  }

  async approve(request: ExecutionApprovalRequest, context: ExecutionApprovalContext) {
    const task = this.requireTask(request.taskId);
    assertExecutionConfig(task.plan, this.config);
    await this.workspace.verifySource(task);
    return this.store.approve(request, context);
  }

  async run(
    request: ExecutionRunRequest, context: ExecutionApprovalContext, artifactDirectory: string, signal?: AbortSignal,
  ): Promise<ExecutionRun> {
    const task = this.requireTask(request.taskId);
    assertExecutionConfig(task.plan, this.config);
    assertSandboxHost(this.host.platform, this.host.architecture);
    if (request.planHash !== task.plan.planHash || request.baseCommit !== task.baseCommit) {
      throw new HarnessError('EXECUTION_CONTEXT_MISMATCH');
    }
    // Docker 접속 전에도 승인을 확인하며 실제 소비 시에는 저장소가 다시 검증한다.
    const approval = this.store.listApprovalHistory(task.taskId, 0).approvals[0];
    if (!approval || approval.usedAt !== null || approval.revokedAt !== null
      || approval.ownerId !== context.ownerId || Date.parse(approval.expiresAt) <= context.now.getTime()) {
      throw new HarnessError('APPROVAL_REQUIRED');
    }
    if (signal?.aborted) throw new HarnessError('EXECUTION_ABORTED');
    const beforeHash = await this.workspace.verifySource(task);
    await this.backend.preflight(this.config, task.plan.policy);
    await this.workspace.verifySource(task);
    if (signal?.aborted) throw new HarnessError('EXECUTION_ABORTED');
    // 준비에 걸린 시간도 TTL에 포함한다. 원자적 소비는 저장소에서 다시 검증한다.
    const run = this.store.beginRun(request, { ownerId: context.ownerId, now: new Date() }, artifactDirectory);
    run.sourceBeforeHash = beforeHash;
    try {
      const workspace = await this.workspace.materialize(task, artifactDirectory);
      run.worktreeRoot = workspace.worktreeRoot;
      await this.workspace.apply(task.plan, workspace);
      run.diff = await this.workspace.inspectDiff(task.plan, workspace);
      run.checks.push({ name: 'approved_patch', status: 'passed', reason: '허용된 기존 파일의 원본 해시와 정확한 변경 내용을 확인했습니다.' });
      const containerRoot = await this.workspace.createContainerView(task.plan, workspace);
      for (const command of task.plan.commands) {
        if (signal?.aborted) throw new HarnessError('EXECUTION_ABORTED');
        const result = await this.backend.execute(command, containerRoot, signal);
        run.commands.push(result);
        const passed = result.commandId === command.commandId && result.termination === 'completed'
          && result.exitCode === 0 && !result.oomKilled && result.stopped && result.removed && result.failureCode === null;
        run.checks.push({ name: command.commandId, status: passed ? 'passed' : 'failed', reason: passed
          ? '등록된 검사가 격리 환경에서 성공하고 컨테이너 정지·제거를 확인했습니다.'
          : result.failureCode ?? `EXECUTION_${result.termination.toUpperCase()}` });
        if (!passed) throw new HarnessError(!result.stopped || !result.removed ? 'EXECUTION_CLEANUP_UNCONFIRMED' : 'EXECUTION_CHECK_FAILED');
      }
      run.diff = await this.workspace.inspectDiff(task.plan, workspace);
      run.status = 'SUCCEEDED';
    } catch (error) {
      run.status = 'FAILED';
      run.failureCode = error instanceof HarnessError ? error.code : 'EXECUTION_FAILED';
      run.checks.push({ name: 'execution', status: 'failed', reason: run.failureCode });
    } finally {
      for (const command of task.plan.commands) {
        if (!run.checks.some((check) => check.name === command.commandId)) {
          run.checks.push({ name: command.commandId, status: 'not_run', reason: run.failureCode ?? 'EXECUTION_INTERRUPTED' });
        }
      }
      try {
        run.sourceAfterHash = await this.workspace.verifySource(task);
        const unchanged = run.sourceAfterHash === run.sourceBeforeHash;
        run.checks.push({ name: 'original_unchanged', status: unchanged ? 'passed' : 'failed', reason: unchanged
          ? '합성 원본과 Git 메타데이터의 전후 해시가 같습니다.' : 'EXECUTION_SOURCE_CHANGED' });
        if (!unchanged) { run.status = 'FAILED'; run.failureCode = 'EXECUTION_SOURCE_CHANGED'; }
      } catch {
        run.status = 'FAILED'; run.failureCode = 'EXECUTION_SOURCE_CHANGED';
        run.checks.push({ name: 'original_unchanged', status: 'failed', reason: run.failureCode });
      }
      run.finishedAt = new Date().toISOString();
      this.store.finishRun(run);
    }
    return run;
  }

  private requireTask(taskId: string): ExecutionTask {
    const task = this.store.find(taskId);
    if (!task) throw new HarnessError('EXECUTION_TASK_NOT_FOUND');
    assertExecutionPlan(task.plan);
    return task;
  }
}
