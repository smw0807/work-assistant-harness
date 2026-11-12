import { createHash, randomUUID } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import type { BranchApprovalRequest, BranchFixture, BranchPlan, BranchTask, BranchWorkType } from '../domain/branch.js';

export const branchWorkTypes: readonly BranchWorkType[] = ['feature', 'fix', 'chore', 'refactor'];
export const branchFixtures: readonly BranchFixture[] = ['success', 'collision', 'source-changed', 'unknown'];

const planKeys = ['taskId', 'ownerId', 'policy', 'mode', 'operation', 'workType', 'fixture', 'source',
  'branchName', 'createdAt', 'expiresAt', 'planHash'];
const sourceKeys = ['requestId', 'revision', 'repoId', 'remote', 'baseBranch', 'baseCommit', 'diffHash', 'allowedFiles'];
const taskKeys = ['taskId', 'plan', 'status', 'generation', 'revision', 'invalidatedAt', 'failureCode', 'updatedAt'];
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const planLifetimeMs = 24 * 60 * 60 * 1000;

// 실제 Git 객체와 diff를 읽은 결과가 아니라 오프라인 계약에 고정한 합성 identity다.
const syntheticBaseCommit = createHash('sha1').update('synthetic-branch-base-v1').digest('hex');
const syntheticDiffHash = createHash('sha256').update(JSON.stringify({
  path: 'src/message.mjs', before: 'export const message = "before";\n', after: 'export const message = "after";\n',
})).digest('hex');

const hasExactKeys = (value: unknown, keys: readonly string[]): boolean => Boolean(value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)));
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

export const assertBranchTime = (now: Date): void => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new HarnessError('BRANCH_INVALID_TIME');
};

export const assertBranchOwner = (ownerId: string): void => {
  if (typeof ownerId !== 'string' || !/^os-user:(0|[1-9]\d{0,15})$/.test(ownerId)) {
    throw new HarnessError('BRANCH_INVALID_OWNER');
  }
};

/** JSON 키 순서와 무관하게 승인 대상의 모든 필드를 고정 순서로 결합한다. */
export const hashBranchPlan = (plan: Omit<BranchPlan, 'planHash'>): string => {
  const content = {
    taskId: plan.taskId, ownerId: plan.ownerId, policy: plan.policy, mode: plan.mode, operation: plan.operation,
    workType: plan.workType, fixture: plan.fixture,
    source: {
      requestId: plan.source.requestId, revision: plan.source.revision, repoId: plan.source.repoId,
      remote: plan.source.remote, baseBranch: plan.source.baseBranch, baseCommit: plan.source.baseCommit,
      diffHash: plan.source.diffHash, allowedFiles: plan.source.allowedFiles,
    },
    branchName: plan.branchName, createdAt: plan.createdAt, expiresAt: plan.expiresAt,
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
};

export const assertBranchPlan = (plan: BranchPlan): void => {
  if (!hasExactKeys(plan, planKeys) || typeof plan.taskId !== 'string' || !uuidPattern.test(plan.taskId)
    || plan.policy !== 'synthetic-branch-v1' || plan.mode !== 'offline' || plan.operation !== 'simulate-branch'
    || !branchWorkTypes.includes(plan.workType) || !branchFixtures.includes(plan.fixture)
    || !hasExactKeys(plan.source, sourceKeys)
    || plan.source.requestId !== `synthetic-branch:${plan.taskId}` || plan.source.revision !== 1
    || plan.source.repoId !== 'synthetic-branch-repository'
    || plan.source.remote !== 'https://gitlab.example.invalid/synthetic/branch-fixture.git'
    || plan.source.baseBranch !== 'main' || plan.source.baseCommit !== syntheticBaseCommit
    || plan.source.diffHash !== syntheticDiffHash || !Array.isArray(plan.source.allowedFiles)
    || plan.source.allowedFiles.length !== 1 || plan.source.allowedFiles[0] !== 'src/message.mjs'
    || plan.branchName !== `${plan.workType}/synthetic-${plan.taskId}`
    || !isTimestamp(plan.createdAt) || !isTimestamp(plan.expiresAt)
    || typeof plan.planHash !== 'string' || !digestPattern.test(plan.planHash)) {
    throw new HarnessError('BRANCH_INVALID_PLAN');
  }
  assertBranchOwner(plan.ownerId);
  if (Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) !== planLifetimeMs) {
    throw new HarnessError('BRANCH_INVALID_PLAN');
  }
  if (hashBranchPlan(plan) !== plan.planHash) throw new HarnessError('BRANCH_PLAN_HASH_MISMATCH');
};

export const createBranchPlan = (workType: BranchWorkType, fixture: BranchFixture, ownerId: string, now: Date): BranchPlan => {
  assertBranchTime(now);
  assertBranchOwner(ownerId);
  if (!branchWorkTypes.includes(workType)) throw new HarnessError('BRANCH_INVALID_WORK_TYPE');
  if (!branchFixtures.includes(fixture)) throw new HarnessError('BRANCH_INVALID_FIXTURE');
  const expires = new Date(now.getTime() + planLifetimeMs);
  assertBranchTime(expires);
  const taskId = randomUUID();
  const content: Omit<BranchPlan, 'planHash'> = {
    taskId, ownerId, policy: 'synthetic-branch-v1', mode: 'offline', operation: 'simulate-branch', workType, fixture,
    source: {
      requestId: `synthetic-branch:${taskId}`, revision: 1, repoId: 'synthetic-branch-repository',
      remote: 'https://gitlab.example.invalid/synthetic/branch-fixture.git', baseBranch: 'main',
      baseCommit: syntheticBaseCommit, diffHash: syntheticDiffHash, allowedFiles: ['src/message.mjs'],
    },
    branchName: `${workType}/synthetic-${taskId}`, createdAt: now.toISOString(), expiresAt: expires.toISOString(),
  };
  const plan = { ...content, planHash: hashBranchPlan(content) };
  assertBranchPlan(plan);
  return plan;
};

export const assertBranchReady = (task: BranchTask, ownerId: string, now: Date): void => {
  assertBranchTime(now);
  assertBranchOwner(ownerId);
  if (!hasExactKeys(task, taskKeys)) throw new HarnessError('BRANCH_INVALID_TASK');
  assertBranchPlan(task.plan);
  if (task.plan.ownerId !== ownerId) throw new HarnessError('BRANCH_OWNER_MISMATCH');
  if (now.getTime() < Date.parse(task.plan.createdAt) || !isTimestamp(task.updatedAt)
    || now.getTime() < Date.parse(task.updatedAt)) throw new HarnessError('BRANCH_INVALID_TIME');
  if (now.getTime() >= Date.parse(task.plan.expiresAt)) throw new HarnessError('BRANCH_PLAN_EXPIRED');
  if (task.taskId !== task.plan.taskId || task.generation !== 0 || task.revision !== task.plan.source.revision
    || task.invalidatedAt !== null
    || !['AWAITING_APPROVAL', 'APPROVED', 'SIMULATING'].includes(task.status)) {
    throw new HarnessError('BRANCH_INVALIDATED');
  }
  if (task.plan.fixture === 'source-changed') throw new HarnessError('BRANCH_SOURCE_CHANGED');
};

export const validateBranchApproval = (task: BranchTask, request: BranchApprovalRequest, ownerId: string, now: Date): void => {
  assertBranchReady(task, ownerId, now);
  if (!hasExactKeys(request, ['taskId', 'planHash', 'expiresInMinutes']) || request.taskId !== task.taskId
    || typeof request.planHash !== 'string' || !digestPattern.test(request.planHash)
    || !Number.isSafeInteger(request.expiresInMinutes) || request.expiresInMinutes < 1 || request.expiresInMinutes > 60) {
    throw new HarnessError('BRANCH_INVALID_APPROVAL');
  }
  if (request.planHash !== task.plan.planHash) throw new HarnessError('BRANCH_PLAN_HASH_MISMATCH');
};
