import type { BranchClaim, BranchResult } from '../domain/branch.js';
import { HarnessError } from '../domain/errors.js';
import type { MockBranchWorkspacePort } from '../ports/branch.js';
import { assertBranchPlan, assertBranchReady } from '../policy/branch-policy.js';

const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const attemptKeys = ['attemptId', 'taskId', 'approvalId', 'planHash', 'generation', 'status',
  'startedAt', 'finishedAt', 'reason', 'receiptId'];
const exactKeys = (value: unknown, keys: string[]): boolean => Boolean(value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)));

/** Git·Codex·파일·HTTP 권한 없이 고정 합성 결과만 반환한다. */
export class MockBranchWorkspace implements MockBranchWorkspacePort {
  readonly mode = 'offline' as const;

  async simulate(claim: BranchClaim): Promise<BranchResult> {
    if (!exactKeys(claim, ['task', 'attempt']) || !claim.task || !exactKeys(claim.attempt, attemptKeys)) {
      throw new HarnessError('BRANCH_INVALID_CLAIM');
    }
    const { task, attempt } = claim;
    assertBranchPlan(task.plan);
    if (typeof attempt.attemptId !== 'string' || !uuidPattern.test(attempt.attemptId)
      || typeof attempt.approvalId !== 'string' || !uuidPattern.test(attempt.approvalId)
      || attempt.taskId !== task.taskId || attempt.planHash !== task.plan?.planHash
      || attempt.generation !== task.generation || attempt.status !== 'SIMULATING' || task.status !== 'SIMULATING'
      || attempt.finishedAt !== null || attempt.reason !== null || attempt.receiptId !== null
      || typeof attempt.startedAt !== 'string' || !Number.isFinite(Date.parse(attempt.startedAt))
      || new Date(attempt.startedAt).toISOString() !== attempt.startedAt || task.updatedAt !== attempt.startedAt) {
      throw new HarnessError('BRANCH_INVALID_CLAIM');
    }
    // 실제 시각과 영속 승인 소비는 store가 검증하며, 여기서는 claim의 고정 관측 시각을 대조한다.
    assertBranchReady(task, task.plan.ownerId, new Date(attempt.startedAt));
    switch (task.plan.fixture) {
      case 'success': return { status: 'SIMULATED', reason: null, receiptId: `mock-branch:${attempt.attemptId}` };
      case 'collision': return { status: 'NOT_CREATED', reason: 'BRANCH_NAME_COLLISION', receiptId: null };
      case 'unknown': return { status: 'UNKNOWN', reason: 'BRANCH_MOCK_UNKNOWN', receiptId: null };
      default: throw new HarnessError('BRANCH_SOURCE_CHANGED');
    }
  }
}
