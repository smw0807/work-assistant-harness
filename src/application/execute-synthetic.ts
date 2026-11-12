import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import { BRANCH_EXECUTION_POLICY_VERSION, EXECUTION_POLICY_VERSION } from '../domain/execution.js';
import type { BranchWorkType } from '../domain/branch.js';
import type {
  ExecutionApprovalContext, ExecutionApprovalRequest, ExecutionCleanupResult, ExecutionCommandResult,
  ExecutionFixture, ExecutionLifecycleHooks, ExecutionPhase, ExecutionPlan, ExecutionProgress,
  ExecutionRun, ExecutionRunRequest, ExecutionTask, IsolatedExecutionPort, ExecutionPolicyVersion,
} from '../domain/execution.js';
import type { SandboxConfig } from '../domain/sandbox.js';
import type { ExecutionStore } from '../ports/execution.js';
import { assertExecutionConfig, assertExecutionPlan, assertExecutionPlanReady, createExecutionPolicy, getExecutionCommand, hashExecutionPlan } from '../policy/execution-policy.js';
import { assertSandboxHost } from '../policy/sandbox-policy.js';
import { SyntheticExecutionWorkspace } from '../adapters/execution-workspace.js';

export interface ExecutionServiceObserver {
  checkpoint?(phase: ExecutionPhase, run: ExecutionRun): Promise<void>;
}
const cleanupFromCommand = (result: ExecutionCommandResult): ExecutionCleanupResult => ({
  found: result.containerName !== null, stopped: result.stopped, removed: result.removed,
  exitCode: result.exitCode, oomKilled: result.oomKilled, failureCode: result.failureCode,
});
const unknownCleanup = (failureCode: string): ExecutionCleanupResult => ({
  found: false, stopped: false, removed: false, exitCode: null, oomKilled: false, failureCode,
});
const retainObservedDiff = (run: ExecutionRun): void => {
  // 중간에 검증했던 본문을 현재 파일의 diff로 잘못 표시하지 않는다.
  run.diff = run.diff.filter((diff) => run.observation?.changes.some((change) => change.path === diff.path
    && change.kind === 'modified' && change.afterHash === diff.afterHash && change.beforeHash === diff.beforeHash));
};

/** 기존 조사 Task와 기록용 승인을 실제 실행 승인으로 승격하지 않는다. */
export class SyntheticExecutionService {
  constructor(
    private readonly store: ExecutionStore,
    private readonly workspace: SyntheticExecutionWorkspace,
    private readonly backend: IsolatedExecutionPort,
    private readonly config: SandboxConfig,
    private readonly host = { platform: process.platform as string, architecture: process.arch as string },
    private readonly observer: ExecutionServiceObserver = {},
    private readonly policyVersion: ExecutionPolicyVersion = EXECUTION_POLICY_VERSION,
  ) {
    if (![EXECUTION_POLICY_VERSION, BRANCH_EXECUTION_POLICY_VERSION].includes(policyVersion)) {
      throw new HarnessError('INVALID_EXECUTION_POLICY');
    }
  }

  async plan(taskId: string, directory: string, fixture: ExecutionFixture, workType?: BranchWorkType): Promise<ExecutionTask> {
    const branchExecution = this.policyVersion === BRANCH_EXECUTION_POLICY_VERSION;
    if (branchExecution ? !workType || !['feature', 'fix', 'chore', 'refactor'].includes(workType) : workType !== undefined) {
      throw new HarnessError('INVALID_EXECUTION_WORK_TYPE');
    }
    if (branchExecution && !process.getuid) throw new HarnessError('APPROVAL_OWNER_UNSUPPORTED');
    if (branchExecution && (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(taskId)
      || !isAbsolute(directory) || normalize(directory) !== directory
      || directory !== join(dirname(dirname(directory)), 'branch-executions', taskId)
      || /[\\*,]/.test(directory) || [...directory].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
      throw new HarnessError('UNSAFE_EXECUTION_DIRECTORY');
    }
    const source = await this.workspace.prepare(directory, fixture);
    const now = new Date().toISOString();
    const branchName = `${workType}/task-${taskId}`;
    const content: Omit<ExecutionPlan, 'planHash'> = {
      planId: randomUUID(), version: 1, taskId, requestRevision: 'synthetic-1',
      repoId: branchExecution ? 'synthetic-branch-execution' : 'synthetic-execution',
      baseCommit: source.baseCommit, sourceHash: source.sourceHash, allowedFiles: ['src/message.mjs'],
      patches: source.patches, commands: source.commandIds.map(getExecutionCommand), policy: createExecutionPolicy(this.config, this.policyVersion),
      ...(branchExecution ? { branch: {
        workType: workType!, name: branchName, baseBranch: 'main' as const, headRef: `refs/heads/${branchName}`,
        ownerId: `os-user:${process.getuid!()}`, sourceRoot: source.sourceRoot,
        createdAt: now, expiresAt: new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(),
      } } : {}),
    };
    const plan: ExecutionPlan = { ...content, planHash: hashExecutionPlan(content) };
    assertExecutionPlan(plan);
    const task: ExecutionTask = {
      taskId, status: 'AWAITING_APPROVAL', requestRevision: plan.requestRevision, baseCommit: plan.baseCommit,
      sourceRoot: source.sourceRoot, createdAt: now, updatedAt: now, plan,
    };
    this.store.create(task);
    return task;
  }

  async approve(request: ExecutionApprovalRequest, context: ExecutionApprovalContext) {
    const task = this.requireTask(request.taskId);
    assertExecutionPlanReady(task.plan, context.ownerId, context.now);
    assertExecutionConfig(task.plan, this.config);
    await this.workspace.verifySource(task);
    return this.store.approve(request, context);
  }

  async run(request: ExecutionRunRequest, context: ExecutionApprovalContext, artifactDirectory: string, signal?: AbortSignal): Promise<ExecutionRun> {
    const task = this.requireTask(request.taskId);
    const entryTime = task.plan.branch ? new Date() : context.now;
    assertExecutionPlanReady(task.plan, context.ownerId, entryTime);
    assertExecutionConfig(task.plan, this.config);
    assertSandboxHost(this.host.platform, this.host.architecture);
    if (request.planHash !== task.plan.planHash || request.baseCommit !== task.baseCommit) throw new HarnessError('EXECUTION_CONTEXT_MISMATCH');
    if (this.store.requestState(task.taskId).invalidatedAt !== null) throw new HarnessError('EXECUTION_CANCELLED');
    const approval = this.store.listApprovalHistory(task.taskId, 0).approvals[0];
    if (!approval || approval.usedAt !== null || approval.revokedAt !== null
      || approval.ownerId !== context.ownerId || Date.parse(approval.expiresAt) <= entryTime.getTime()
      || (task.plan.branch && Date.parse(approval.createdAt) > entryTime.getTime())) throw new HarnessError('APPROVAL_REQUIRED');
    if (signal?.aborted) throw new HarnessError('EXECUTION_ABORTED');
    const beforeHash = await this.workspace.verifySource(task);
    await this.backend.preflight(this.config, task.plan.policy);
    await this.workspace.verifySource(task);
    if (signal?.aborted) throw new HarnessError('EXECUTION_ABORTED');
    const run = this.store.beginRun(request, { ownerId: context.ownerId, now: new Date() }, artifactDirectory);
    run.sourceBeforeHash = beforeHash;
    const controller = new AbortController();
    let externalAbort = false;
    const abort = (): void => { externalAbort = true; controller.abort(); };
    signal?.addEventListener('abort', abort, { once: true });
    const poll = setInterval(() => {
      try { this.store.assertRunnable(run.runId); }
      catch (error) {
        if (!(error instanceof HarnessError && error.code === 'EXECUTION_TRANSACTION_IN_PROGRESS')) controller.abort();
      }
    }, 50);
    poll.unref();
    const live = (): void => {
      if (controller.signal.aborted || signal?.aborted) throw new HarnessError('EXECUTION_CANCELLED');
      this.store.assertRunnable(run.runId);
    };
    const checkpoint = async (phase: ExecutionPhase, progress: ExecutionProgress = {}): Promise<void> => {
      this.store.checkpoint(run.runId, phase, { diff: run.diff, checks: run.checks, ...progress });
      await this.observer.checkpoint?.(phase, run);
    };
    const recordExternalCancellation = (): void => {
      if (!externalAbort && !signal?.aborted) return;
      const state = this.store.requestState(task.taskId);
      if (state.invalidatedAt === null) this.store.control({
        taskId: task.taskId, eventId: randomUUID(), kind: 'cancel', revision: state.revision,
      }, { ownerId: context.ownerId, now: new Date() });
    };
    try {
      await checkpoint('claimed', { sourceBeforeHash: beforeHash });
      live(); await checkpoint('workspace_preparing'); live();
      const workspace = await this.store.guard(run.runId, 'workspace_preparing', () => this.workspace.materialize(task, artifactDirectory));
      run.worktreeRoot = workspace.worktreeRoot;
      await checkpoint('workspace_ready', { worktreeRoot: workspace.worktreeRoot, workspace: await this.workspace.evidence(task.plan, workspace) });
      if (task.plan.branch) run.checks.push({ name: 'approved_branch', status: 'passed',
        reason: '계획한 작업 브랜치의 HEAD·ref와 보존된 main을 확인했습니다.' });
      live(); await checkpoint('patch_applying'); live();
      await this.store.guard(run.runId, 'patch_applying', () => this.workspace.apply(task.plan, workspace));
      run.diff = await this.workspace.inspectDiff(task.plan, workspace);
      run.checks.push({ name: 'approved_patch', status: 'passed', reason: '허용된 원본 해시와 정확한 변경 내용을 확인했습니다.' });
      await checkpoint('patch_applied');
      live(); await checkpoint('view_preparing'); live();
      const containerRoot = await this.store.guard(run.runId, 'view_preparing', () => this.workspace.createContainerView(task.plan, workspace));
      await checkpoint('view_ready', { workspace: await this.workspace.evidence(task.plan, workspace) });
      const verifyApprovedWorkspace = async (): Promise<void> => {
        if (!task.plan.branch) return;
        // 준비 뒤 교체된 검사 파일을 실행하지 않도록 create/start 직전에도 승인 증거를 대조한다.
        await this.workspace.verifySource(task);
        await this.workspace.inspectDiff(task.plan, workspace);
        await this.workspace.evidence(task.plan, workspace);
        live();
      };
      for (const command of task.plan.commands) {
        live();
        await verifyApprovedWorkspace();
        const hooks: ExecutionLifecycleHooks = {
          runId: run.runId,
          dispatch: (operation) => this.store.dispatch(run.runId, operation),
          beforeCreate: async (container) => { live(); await checkpoint('container_creating', { container }); live(); await verifyApprovedWorkspace(); },
          created: async (container) => { await checkpoint('container_created', { container }); },
          beforeStart: async () => { live(); await checkpoint('container_starting'); live(); await verifyApprovedWorkspace(); },
          finished: async (result) => { await checkpoint('command_finished', { command: result, cleanup: cleanupFromCommand(result) }); },
        };
        const result = await this.backend.execute(command, containerRoot, controller.signal, hooks);
        run.commands.push(result);
        const passed = result.commandId === command.commandId && result.termination === 'completed'
          && result.exitCode === 0 && !result.oomKilled && result.stopped && result.removed && result.failureCode === null;
        run.checks.push({ name: command.commandId, status: passed ? 'passed' : 'failed', reason: passed
          ? '등록 검사의 성공과 컨테이너 정지·제거를 확인했습니다.' : result.failureCode ?? `EXECUTION_${result.termination.toUpperCase()}` });
        await checkpoint('command_finished', { command: result, cleanup: cleanupFromCommand(result) });
        live();
        if (!passed) throw new HarnessError(!result.stopped || !result.removed ? 'EXECUTION_CLEANUP_UNCONFIRMED' : 'EXECUTION_CHECK_FAILED');
      }
      run.diff = await this.workspace.inspectDiff(task.plan, workspace);
      run.status = 'SUCCEEDED';
    } catch (error) {
      const code = error instanceof HarnessError ? error.code : 'EXECUTION_FAILED';
      run.status = code === 'EXECUTION_CLEANUP_UNCONFIRMED' ? 'BLOCKED' : controller.signal.aborted || code === 'EXECUTION_CANCELLED' ? 'CANCELLED' : 'FAILED';
      run.failureCode = code;
      run.checks.push({ name: 'execution', status: 'failed', reason: code });
    } finally {
      clearInterval(poll);
      try {
        recordExternalCancellation();
        const lifecycle = this.store.lifecycle(run.runId);
        if (lifecycle.container && (!lifecycle.cleanup?.stopped || !lifecycle.cleanup.removed)) {
          run.status = 'BLOCKED'; run.failureCode = 'EXECUTION_CLEANUP_UNCONFIRMED';
        }
        for (const command of task.plan.commands) {
          if (!run.checks.some((check) => check.name === command.commandId)) run.checks.push({ name: command.commandId, status: 'not_run', reason: run.failureCode ?? 'EXECUTION_INTERRUPTED' });
        }
        run.observation = await this.workspace.observe(task, artifactDirectory, lifecycle.workspace);
        retainObservedDiff(run);
        if (run.observation.status === 'failed') { run.status = 'BLOCKED'; run.failureCode = 'EXECUTION_OBSERVATION_FAILED'; }
        await this.checkOriginal(task, run);
        await checkpoint('finalizing', { observation: run.observation });
        // 최종 관찰 중 도착한 종료 신호도 terminal commit의 세대 검사에 포함한다.
        recordExternalCancellation();
        run.finishedAt = new Date().toISOString();
        this.store.finishRun(run);
        await this.observer.checkpoint?.('finished', this.store.findRun(run.runId)!);
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    }
    return this.store.findRun(run.runId)!;
  }

  /** 실행은 재개하지 않고 기록된 소유권과 잔여 상태만 조사한다. */
  async recover(taskId: string, context: ExecutionApprovalContext): Promise<ExecutionRun | null> {
    const task = this.requireTask(taskId);
    const request = this.store.requestState(taskId);
    if (!process.getuid || request.ownerId !== context.ownerId || context.ownerId !== `os-user:${process.getuid()}`) throw new HarnessError('APPROVAL_OWNER_MISMATCH');
    const run = this.store.listRuns(taskId)[0];
    if (!run) return null;
    if (run.status !== 'RUNNING' && run.status !== 'BLOCKED') return run;
    const lifecycle = this.store.lifecycle(run.runId);
    this.store.checkpoint(run.runId, 'recovering');
    let cleanup: ExecutionCleanupResult = { found: false, stopped: true, removed: true, exitCode: null, oomKilled: false, failureCode: null };
    if (lifecycle.legacy) cleanup = unknownCleanup('LEGACY_EXECUTION_UNTRACKED');
    else if (lifecycle.container) {
      try {
        assertExecutionConfig(task.plan, this.config);
        assertSandboxHost(this.host.platform, this.host.architecture);
        await this.backend.preflight(this.config, task.plan.policy);
        cleanup = this.backend.recover ? await this.backend.recover(lifecycle.container) : unknownCleanup('EXECUTION_RECOVERY_UNSUPPORTED');
      } catch { cleanup = unknownCleanup('EXECUTION_RECOVERY_BACKEND_UNAVAILABLE'); }
    }
    const observation = await this.workspace.observe(task, run.artifactDirectory, lifecycle.workspace);
    this.store.checkpoint(run.runId, 'recovering', { cleanup, observation });
    if (run.status === 'BLOCKED') {
      this.store.checkpoint(run.runId, 'finished', { cleanup, observation });
      return run;
    }
    run.observation = observation;
    retainObservedDiff(run);
    const state = this.store.requestState(taskId);
    const confirmed = cleanup.stopped && cleanup.removed && observation.status !== 'failed';
    run.status = confirmed ? state.invalidatedAt ? 'CANCELLED' : 'INTERRUPTED' : 'BLOCKED';
    run.failureCode = cleanup.failureCode ?? (observation.status === 'failed' ? 'EXECUTION_OBSERVATION_FAILED' : state.reason ?? 'EXECUTION_INTERRUPTED');
    run.checks.push({ name: 'recovery_cleanup', status: cleanup.stopped && cleanup.removed ? 'passed' : 'failed', reason: cleanup.failureCode ?? 'RECORDED_CONTAINER_OWNERSHIP_CHECKED' });
    for (const command of task.plan.commands) {
      if (!run.checks.some((check) => check.name === command.commandId)) {
        const result = run.commands.find((entry) => entry.commandId === command.commandId);
        const passed = result?.termination === 'completed' && result.exitCode === 0 && result.stopped && result.removed && !result.oomKilled && result.failureCode === null;
        const mayHaveStarted = lifecycle.container !== null && !['container_creating', 'container_created'].includes(lifecycle.phase);
        run.checks.push({ name: command.commandId, status: result ? passed ? 'passed' : 'failed' : mayHaveStarted ? 'failed' : 'not_run', reason: result ? 'RECORDED_COMMAND_RESULT' : mayHaveStarted ? 'EXECUTION_RESULT_UNKNOWN' : 'EXECUTION_INTERRUPTED_BEFORE_COMMAND' });
      }
    }
    await this.checkOriginal(task, run);
    run.finishedAt = new Date().toISOString();
    this.store.finishRun(run);
    return this.store.findRun(run.runId)!;
  }

  private async checkOriginal(task: ExecutionTask, run: ExecutionRun): Promise<void> {
    run.sourceBeforeHash ??= task.plan.sourceHash;
    try {
      run.sourceAfterHash = await this.workspace.verifySource(task);
      const unchanged = run.sourceAfterHash === run.sourceBeforeHash;
      run.checks.push({ name: 'original_unchanged', status: unchanged ? 'passed' : 'failed', reason: unchanged ? '원본과 Git 메타데이터의 전후 해시가 같습니다.' : 'EXECUTION_SOURCE_CHANGED' });
      if (!unchanged) { run.status = 'BLOCKED'; run.failureCode = 'EXECUTION_SOURCE_CHANGED'; }
    } catch {
      run.status = 'BLOCKED'; run.failureCode = 'EXECUTION_SOURCE_CHANGED';
      run.checks.push({ name: 'original_unchanged', status: 'failed', reason: run.failureCode });
    }
  }

  private requireTask(taskId: string): ExecutionTask {
    const task = this.store.find(taskId);
    if (!task) throw new HarnessError('EXECUTION_TASK_NOT_FOUND');
    assertExecutionPlan(task.plan);
    if (task.plan.policy.version !== this.policyVersion) throw new HarnessError('EXECUTION_POLICY_MISMATCH');
    return task;
  }
}
