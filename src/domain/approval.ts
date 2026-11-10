import { createHash } from 'node:crypto';
import { HarnessError } from './errors.js';
import type { ChangePlan, Task } from './types.js';

export interface ApprovalRequest {
  taskId: string;
  planHash: string;
  baseCommit: string;
  expiresInMinutes: number;
}

export interface ApprovalContext {
  ownerId: string;
  repoId: string;
  baseCommit: string;
  now: Date;
}

export interface ApprovalRecord {
  approvalId: string;
  ownerId: string;
  taskId: string;
  repoId: string;
  planHash: string;
  baseCommit: string;
  requestRevision: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  executionPolicy: 'approval-only-v1';
  planSnapshot: ChangePlan;
}

export interface ApprovalHistoryPage {
  approvals: ApprovalRecord[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
}

const planKeys = [
  'planId', 'version', 'requestRevision', 'repoId', 'baseCommit', 'objective',
  'allowedFiles', 'proposedChanges', 'testCommandIds', 'risks', 'planHash',
];
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 16_384;
const isTextArray = (value: unknown): value is string[] => Array.isArray(value)
  && value.length <= 128 && value.every(isText);

export const assertApprovalOwner = (ownerId: string): void => {
  if (typeof ownerId !== 'string' || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(ownerId)) throw new HarnessError('INVALID_APPROVAL_OWNER');
};

export const assertApprovalTime = (now: Date): void => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new HarnessError('INVALID_APPROVAL_TIME');
};

/** 단계 1 계획 생성기의 필드 순서를 유지하여 기존 계획 해시도 검증한다. */
export const hashChangePlan = (plan: Omit<ChangePlan, 'planHash'>): string => {
  const content = {
    planId: plan.planId, version: plan.version, requestRevision: plan.requestRevision,
    repoId: plan.repoId, baseCommit: plan.baseCommit, objective: plan.objective,
    allowedFiles: plan.allowedFiles, proposedChanges: plan.proposedChanges,
    testCommandIds: plan.testCommandIds, risks: plan.risks,
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
};

export const assertChangePlan = (plan: ChangePlan): void => {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || Object.keys(plan).length !== planKeys.length || Object.keys(plan).some((key) => !planKeys.includes(key))
    || !isText(plan.planId) || !Number.isSafeInteger(plan.version) || plan.version < 1
    || !isText(plan.requestRevision) || !isText(plan.repoId) || !/^[a-f0-9]{40}$/.test(plan.baseCommit)
    || !isText(plan.objective) || !isTextArray(plan.allowedFiles) || plan.allowedFiles.length === 0
    || !isTextArray(plan.proposedChanges) || plan.proposedChanges.length === 0
    || !isTextArray(plan.testCommandIds) || !isTextArray(plan.risks)
    || !/^[a-f0-9]{64}$/.test(plan.planHash)) {
    throw new HarnessError('INVALID_CHANGE_PLAN');
  }
  if (hashChangePlan(plan) !== plan.planHash) throw new HarnessError('PLAN_HASH_MISMATCH');
};

export const validateApprovalRequest = (task: Task, request: ApprovalRequest, context: ApprovalContext): ChangePlan => {
  assertApprovalOwner(context.ownerId);
  assertApprovalTime(context.now);
  if (!Number.isSafeInteger(request.expiresInMinutes) || request.expiresInMinutes < 1 || request.expiresInMinutes > 1_440
    || request.taskId !== task.taskId || !/^[a-f0-9]{64}$/.test(request.planHash)
    || !/^[a-f0-9]{40}$/.test(request.baseCommit)) throw new HarnessError('INVALID_APPROVAL_REQUEST');
  if (task.classification !== 'change' || task.status !== 'AWAITING_APPROVAL' || !task.plan) {
    throw new HarnessError('TASK_NOT_AWAITING_APPROVAL');
  }
  assertChangePlan(task.plan);
  if (request.planHash !== task.plan.planHash) throw new HarnessError('PLAN_HASH_MISMATCH');
  if (task.plan.requestRevision !== task.requestRevision || task.plan.repoId !== task.repoId
    || task.plan.baseCommit !== task.baseCommit || task.repoId !== context.repoId
    || task.baseCommit !== context.baseCommit || request.baseCommit !== context.baseCommit) {
    throw new HarnessError('APPROVAL_CONTEXT_MISMATCH');
  }
  return task.plan;
};

/** 승인 기록의 검증만 수행한다. 이 단계에는 소비나 실행 권한을 만드는 함수가 없다. */
export const approvalInvalidationReason = (approval: ApprovalRecord, task: Task, now: Date): string | null => {
  assertApprovalTime(now);
  if (approval.usedAt !== null) return 'APPROVAL_ALREADY_USED';
  if (approval.revokedAt !== null) return 'APPROVAL_REVOKED';
  if (!Number.isFinite(Date.parse(approval.expiresAt)) || now.getTime() >= Date.parse(approval.expiresAt)) return 'APPROVAL_EXPIRED';
  if (task.status === 'CANCELLED') return 'TASK_CANCELLED';
  if (task.classification !== 'change' || task.status !== 'APPROVED' || !task.plan) return 'APPROVAL_TASK_MISMATCH';
  try {
    assertChangePlan(task.plan);
    assertChangePlan(approval.planSnapshot);
  } catch {
    return 'APPROVAL_PLAN_MISMATCH';
  }
  if (approval.executionPolicy !== 'approval-only-v1' || approval.taskId !== task.taskId
    || approval.repoId !== task.repoId || approval.baseCommit !== task.baseCommit
    || approval.requestRevision !== task.requestRevision || approval.planHash !== task.plan.planHash
    || approval.planSnapshot.planHash !== approval.planHash || approval.planSnapshot.repoId !== approval.repoId
    || approval.planSnapshot.baseCommit !== approval.baseCommit || approval.planSnapshot.requestRevision !== approval.requestRevision
    || task.plan.repoId !== task.repoId || task.plan.baseCommit !== task.baseCommit
    || task.plan.requestRevision !== task.requestRevision) return 'APPROVAL_PLAN_MISMATCH';
  return null;
};
