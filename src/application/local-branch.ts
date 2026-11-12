import { randomUUID } from 'node:crypto';
import type { BranchWorkType } from '../domain/branch.js';
import type { LocalBranchApprovalRequest, LocalBranchObservation, LocalBranchPlan } from '../domain/local-branch.js';
import { HarnessError } from '../domain/errors.js';
import type { LocalBranchStore, LocalBranchWorkspacePort } from '../ports/local-branch.js';
import {
  assertLocalBranchApprovalRequest, assertLocalBranchObservation, assertLocalBranchOwner,
  assertLocalBranchTime, createLocalBranchPlan,
} from '../policy/local-branch-policy.js';

type Checkpoint = (phase: 'claimed' | 'writing' | 'created' | 'observed') => void | Promise<void>;

const failureCode = (error: unknown): string => error instanceof HarnessError && /^LOCAL_BRANCH_[A-Z_]{1,80}$/.test(error.code)
  ? error.code : 'LOCAL_BRANCH_CREATE_FAILED';

export class LocalBranchService {
  constructor(
    private readonly store: LocalBranchStore,
    private readonly workspace: LocalBranchWorkspacePort,
    private readonly clock: () => Date = () => new Date(),
    // 강제 중단 테스트를 위한 trusted 코드 hook이며 CLI·모델 입력으로 받지 않는다.
    private readonly checkpoint: Checkpoint = () => undefined,
  ) {
    if (workspace.mode !== 'local-synthetic') throw new HarnessError('LOCAL_BRANCH_WORKSPACE_REQUIRED');
  }

  async plan(workType: BranchWorkType, ownerId: string, now: Date) {
    assertLocalBranchTime(now);
    assertLocalBranchOwner(ownerId);
    if (!process.getuid || ownerId !== `os-user:${process.getuid()}`) throw new HarnessError('LOCAL_BRANCH_OWNER_MISMATCH');
    if (!['feature', 'fix', 'chore', 'refactor'].includes(workType)) throw new HarnessError('LOCAL_BRANCH_INVALID_WORK_TYPE');
    const taskId = randomUUID();
    const repository = await this.workspace.prepare(taskId, workType);
    const plan = createLocalBranchPlan(taskId, workType, ownerId, repository, now);
    this.store.create(plan, now);
    return this.store.inspect(taskId, ownerId, now);
  }

  inspect(taskId: string, ownerId: string, now: Date, approvalOffset = 0) {
    return this.store.inspect(taskId, ownerId, now, approvalOffset);
  }

  async approve(request: LocalBranchApprovalRequest, ownerId: string, now: Date) {
    assertLocalBranchApprovalRequest(request);
    const plan = this.pendingPlan(request.taskId, request.planHash, 'AWAITING_APPROVAL', ownerId, now);
    const observation = this.requireAbsent(plan, ownerId, now);
    this.store.approve(request, observation, ownerId, now);
    return this.store.inspect(request.taskId, ownerId, now);
  }

  async create(taskId: string, planHash: string, ownerId: string, now: Date) {
    const plan = this.pendingPlan(taskId, planHash, 'APPROVED', ownerId, now);
    const before = this.requireAbsent(plan, ownerId, now);
    this.store.claim(taskId, planHash, before, ownerId, now);
    await this.checkpoint('claimed');
    let failure: string | null = null;
    try { this.store.beginWrite(taskId, ownerId, this.clock()); } catch (error) { failure = failureCode(error); }
    if (failure === null) {
      await this.checkpoint('writing');
      try {
        this.store.writeGuard(taskId, ownerId, this.clock(), () => this.workspace.createRef(plan));
      } catch (error) { failure = failureCode(error); }
      if (failure === null) await this.checkpoint('created');
    }
    const after = this.observe(plan);
    await this.checkpoint('observed');
    return this.store.finish(taskId, after, failure, false, ownerId, this.clock());
  }

  cancel(taskId: string, ownerId: string, now: Date) {
    return this.store.cancel(taskId, ownerId, now);
  }

  recover(taskId: string, ownerId: string, now: Date) {
    const snapshot = this.store.inspect(taskId, ownerId, now);
    if (snapshot.task.status !== 'RUNNING') return snapshot;
    // 관찰된 ref가 있어도 이 실행이 만들었다고 추정하거나 성공으로 승격하지 않는다.
    return this.store.finish(taskId, this.observe(snapshot.task.plan), null, true, ownerId, now);
  }

  private pendingPlan(taskId: string, planHash: string, status: 'AWAITING_APPROVAL' | 'APPROVED', ownerId: string, now: Date): LocalBranchPlan {
    const { task } = this.store.inspect(taskId, ownerId, now);
    if (planHash !== task.plan.planHash) throw new HarnessError('LOCAL_BRANCH_PLAN_HASH_MISMATCH');
    if (task.status !== status) throw new HarnessError('LOCAL_BRANCH_NOT_READY');
    return task.plan;
  }

  private requireAbsent(plan: LocalBranchPlan, ownerId: string, now: Date): LocalBranchObservation {
    const observation = this.observe(plan);
    if (observation.state === 'absent') return observation;
    const reason = observation.reason ?? 'LOCAL_BRANCH_REF_COLLISION';
    this.store.block(plan.taskId, reason, ownerId, now);
    throw new HarnessError(reason);
  }

  private observe(plan: LocalBranchPlan): LocalBranchObservation {
    try {
      const observation = this.workspace.observe(plan);
      assertLocalBranchObservation(observation, plan);
      return observation;
    } catch {
      return { state: 'unsafe', sourceHash: null, workspaceHash: null, baseOid: null, branchOid: null,
        reason: 'LOCAL_BRANCH_OBSERVATION_FAILED' };
    }
  }
}
