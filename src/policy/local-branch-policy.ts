import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import type { BranchWorkType } from '../domain/branch.js';
import type {
  LocalBranchApprovalRequest, LocalBranchObservation, LocalBranchPlan, LocalBranchRepository,
} from '../domain/local-branch.js';
import { HarnessError } from '../domain/errors.js';

const workTypes: readonly BranchWorkType[] = ['feature', 'fix', 'chore', 'refactor'];
const planKeys = ['taskId', 'ownerId', 'policy', 'mode', 'operation', 'workType', 'branchName',
  'repository', 'createdAt', 'expiresAt', 'planHash'];
const repositoryKeys = ['root', 'ownerToken', 'baseBranch', 'baseCommit', 'sourceHash', 'workspaceHash'];
const observationKeys = ['state', 'sourceHash', 'workspaceHash', 'baseOid', 'branchOid', 'reason'];
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const oidPattern = /^[a-f0-9]{40}$/;
const reasonPattern = /^LOCAL_BRANCH_[A-Z_]{1,80}$/;
const planLifetimeMs = 24 * 60 * 60 * 1000;

const hasExactKeys = (value: unknown, keys: readonly string[]): boolean => Boolean(value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)));
const isDigest = (value: unknown): value is string => typeof value === 'string' && digestPattern.test(value);
const isOid = (value: unknown): value is string => typeof value === 'string' && oidPattern.test(value);
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

export const assertLocalBranchTime = (now: Date): void => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new HarnessError('LOCAL_BRANCH_INVALID_TIME');
};

export const assertLocalBranchOwner = (ownerId: string): void => {
  if (typeof ownerId !== 'string' || !/^os-user:(0|[1-9]\d{0,15})$/.test(ownerId)) {
    throw new HarnessError('LOCAL_BRANCH_INVALID_OWNER');
  }
};

const assertRepository = (repository: LocalBranchRepository, taskId: string): void => {
  if (!hasExactKeys(repository, repositoryKeys) || typeof repository.root !== 'string'
    || Buffer.byteLength(repository.root) > 4096 || !isAbsolute(repository.root)
    || normalize(repository.root) !== repository.root || /[\\*,]/.test(repository.root)
    || [...repository.root].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || repository.root.split('/').some((part) => part === '.' || part === '..')
    || !repository.root.endsWith(`/git-branches/${taskId}`)
    || !isDigest(repository.ownerToken) || repository.baseBranch !== 'main'
    || !isOid(repository.baseCommit) || !isDigest(repository.sourceHash) || !isDigest(repository.workspaceHash)) {
    throw new HarnessError('LOCAL_BRANCH_INVALID_REPOSITORY');
  }
};

/** 키 순서와 무관하게 승인 대상의 저장소 identity와 계획을 함께 결합한다. */
export const hashLocalBranchPlan = (plan: Omit<LocalBranchPlan, 'planHash'>): string => {
  const content = {
    taskId: plan.taskId, ownerId: plan.ownerId, policy: plan.policy, mode: plan.mode, operation: plan.operation,
    workType: plan.workType, branchName: plan.branchName,
    repository: {
      root: plan.repository.root, ownerToken: plan.repository.ownerToken, baseBranch: plan.repository.baseBranch,
      baseCommit: plan.repository.baseCommit, sourceHash: plan.repository.sourceHash, workspaceHash: plan.repository.workspaceHash,
    },
    createdAt: plan.createdAt, expiresAt: plan.expiresAt,
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
};

export const assertLocalBranchPlan = (plan: LocalBranchPlan): void => {
  if (!hasExactKeys(plan, planKeys) || typeof plan.taskId !== 'string' || !uuidPattern.test(plan.taskId)
    || plan.policy !== 'local-synthetic-branch-v1' || plan.mode !== 'local-synthetic' || plan.operation !== 'create-branch'
    || !workTypes.includes(plan.workType) || plan.branchName !== `${plan.workType}/task-${plan.taskId}`
    || !isTimestamp(plan.createdAt) || !isTimestamp(plan.expiresAt) || !isDigest(plan.planHash)) {
    throw new HarnessError('LOCAL_BRANCH_INVALID_PLAN');
  }
  assertLocalBranchOwner(plan.ownerId);
  assertRepository(plan.repository, plan.taskId);
  if (Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) !== planLifetimeMs) {
    throw new HarnessError('LOCAL_BRANCH_INVALID_PLAN');
  }
  if (hashLocalBranchPlan(plan) !== plan.planHash) throw new HarnessError('LOCAL_BRANCH_PLAN_HASH_MISMATCH');
};

/** prepare가 만든 metadata의 형식을 검사한다. 실제 파일·소유 증거 검사는 workspace의 책임이다. */
export const createLocalBranchPlan = (
  taskId: string, workType: BranchWorkType, ownerId: string, repository: LocalBranchRepository, now: Date,
): LocalBranchPlan => {
  assertLocalBranchTime(now);
  assertLocalBranchOwner(ownerId);
  if (typeof taskId !== 'string' || !uuidPattern.test(taskId)) throw new HarnessError('LOCAL_BRANCH_INVALID_TASK_ID');
  if (!workTypes.includes(workType)) throw new HarnessError('LOCAL_BRANCH_INVALID_WORK_TYPE');
  assertRepository(repository, taskId);
  const expires = new Date(now.getTime() + planLifetimeMs);
  assertLocalBranchTime(expires);
  const content: Omit<LocalBranchPlan, 'planHash'> = {
    taskId, ownerId, policy: 'local-synthetic-branch-v1', mode: 'local-synthetic', operation: 'create-branch',
    workType, branchName: `${workType}/task-${taskId}`, repository: { ...repository },
    createdAt: now.toISOString(), expiresAt: expires.toISOString(),
  };
  const plan = { ...content, planHash: hashLocalBranchPlan(content) };
  assertLocalBranchPlan(plan);
  return plan;
};

export const assertLocalBranchObservation = (observation: LocalBranchObservation, plan: LocalBranchPlan): void => {
  assertLocalBranchPlan(plan);
  if (!hasExactKeys(observation, observationKeys) || !['absent', 'created', 'unsafe'].includes(observation.state)
    || (observation.sourceHash !== null && !isDigest(observation.sourceHash))
    || (observation.workspaceHash !== null && !isDigest(observation.workspaceHash))
    || (observation.baseOid !== null && !isOid(observation.baseOid))
    || (observation.branchOid !== null && !isOid(observation.branchOid))) {
    throw new HarnessError('LOCAL_BRANCH_INVALID_OBSERVATION');
  }
  if (observation.state === 'unsafe') {
    if (typeof observation.reason !== 'string' || !reasonPattern.test(observation.reason)) {
      throw new HarnessError('LOCAL_BRANCH_INVALID_OBSERVATION');
    }
    return;
  }
  if (observation.reason !== null || observation.sourceHash !== plan.repository.sourceHash
    || observation.workspaceHash !== plan.repository.workspaceHash || observation.baseOid !== plan.repository.baseCommit
    || (observation.state === 'absent' ? observation.branchOid !== null : observation.branchOid !== plan.repository.baseCommit)) {
    throw new HarnessError('LOCAL_BRANCH_INVALID_OBSERVATION');
  }
};

export const assertLocalBranchApprovalRequest = (request: LocalBranchApprovalRequest): void => {
  if (!hasExactKeys(request, ['taskId', 'planHash', 'expiresInMinutes'])
    || typeof request.taskId !== 'string' || !uuidPattern.test(request.taskId) || !isDigest(request.planHash)
    || !Number.isSafeInteger(request.expiresInMinutes) || request.expiresInMinutes < 1 || request.expiresInMinutes > 60) {
    throw new HarnessError('LOCAL_BRANCH_INVALID_APPROVAL');
  }
};
