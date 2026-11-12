import { HarnessError } from '../domain/errors.js';
import type { BranchApprovalRequest, BranchControl, BranchFixture, BranchResult, BranchWorkType } from '../domain/branch.js';
import type { BranchStore, MockBranchWorkspacePort } from '../ports/branch.js';
import { createBranchPlan } from '../policy/branch-policy.js';

export class SyntheticBranchService {
  constructor(
    private readonly store: BranchStore,
    private readonly workspace: MockBranchWorkspacePort,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (workspace.mode !== 'offline') throw new HarnessError('BRANCH_LIVE_EXECUTION_DISABLED');
  }

  create(workType: BranchWorkType, fixture: BranchFixture, ownerId: string, now: Date) {
    const plan = createBranchPlan(workType, fixture, ownerId, now);
    this.store.create(plan, now);
    return this.store.inspect(plan.taskId, ownerId, now);
  }

  inspect(taskId: string, ownerId: string, now: Date, approvalOffset = 0) {
    return this.store.inspect(taskId, ownerId, now, approvalOffset);
  }

  approve(request: BranchApprovalRequest, ownerId: string, now: Date) {
    return this.store.approve(request, ownerId, now);
  }

  async simulate(taskId: string, planHash: string, ownerId: string, now: Date) {
    const claim = this.store.claim(taskId, planHash, ownerId, now);
    let result: BranchResult;
    try {
      result = await this.workspace.simulate(claim);
    } catch {
      result = { status: 'UNKNOWN', reason: 'BRANCH_SIMULATION_UNCERTAIN', receiptId: null };
    }
    return this.store.finish(claim.attempt.attemptId, result, this.clock());
  }

  control(event: BranchControl, ownerId: string, now: Date) { return this.store.control(event, ownerId, now); }

  recover(taskId: string, ownerId: string, now: Date) { return this.store.recover(taskId, ownerId, now); }
}
