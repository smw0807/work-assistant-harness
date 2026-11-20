import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { CompanyChangeDraft } from '../domain/company-change.js';
import type { CompanyApplyApproval, CompanyApplyApprovalRequest, CompanyApplyDescriptor, CompanyApplyPlan,
  CompanyApplyRegistration, CompanyApplyRequest, CompanyApplySource } from '../domain/company-apply.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { copyCompanyChangeData, hashCompanyChangeValue, parseCompanyChangeDraft } from './company-change.js';
import { assertCompanyWriteContext, assertCompanyWriteSource, parseCompanyWriteDraft, parseCompanyWriteRegistration } from './company-write.js';
import { getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from './company-git-range-unit-budget.js';
import { canonicalReadonlyJson, isReadonlyId } from './readonly-investigation-policy.js';

const limits = Object.freeze({ maxChanges: 8, maxContentBytes: 65_536, maxTotalContentBytes: 131_072,
  maxDraftJsonBytes: 262_144, maxRegistrationJsonBytes: 16_384, maxPlanJsonBytes: 16_384,
  maxWorkerInputBytes: 327_680, maxIndexBytes: 1_048_576, maxGitTextBytes: 1024, maxPackedRefsBytes: 1_048_576,
  maxTaskDirectories: 256, planLifetimeMs: 86_400_000, minApprovalMinutes: 1, maxApprovalMinutes: 60,
  workerWallTimeMs: 30_000, terminationGraceMs: 250, maxWorkerOutputBytes: 16_384, workerOldSpaceMiB: 128 });
const planKeys = ['version', 'id', 'ownerId', 'registrationHash', 'draftHash', 'source', 'branch', 'changes',
  'createdAt', 'expiresAt', 'limitsHash', 'planHash', 'scope', 'checks', 'transmissionAllowed'];
const approvalKeys = ['version', 'id', 'taskId', 'ownerId', 'planHash', 'createdAt', 'expiresAt', 'usedAt', 'scope'];
const fail: (suffix: string) => never = suffix => { throw new HarnessError(`COMPANY_APPLY_${suffix}`); };
const record = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = descriptors[key];
    return Boolean(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
  });
};
const array = (value: unknown): value is unknown[] => {
  if (types.isProxy(value) || !Array.isArray(value) || value.length < 1 || value.length > limits.maxChanges
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
};
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const owner = (value: unknown): value is string => typeof value === 'string' && /^os-user:(0|[1-9][0-9]{0,15})$/u.test(value);
const descriptorData = (draft: CompanyChangeDraft): CompanyApplyDescriptor[] => draft.changes.map(change => ({
  operation: change.operation, path: change.path, beforeHash: change.beforeHash,
  afterHash: hashCompanyChangeValue(change.content), bytes: Buffer.byteLength(change.content, 'utf8'),
}));
const rethrowWriteFailure = (error: unknown, fallback: string): never => fail(error instanceof HarnessError
  && error.code.startsWith('COMPANY_WRITE_') ? error.code.slice('COMPANY_WRITE_'.length) : fallback);

export const hashCompanyApplyValue = hashCompanyChangeValue;
export const copyCompanyApplyData = copyCompanyChangeData;
export const getCompanyApplyLimits = () => limits;
export const getCompanyApplyLimitsHash = (): string => hashCompanyChangeValue(canonicalReadonlyJson({
  version: 'company-apply-plan-v1', limits, readerProfileHash: getCompanyGitRangeUnitProfileHash(),
  guardHash: getCompanyGitRangeUnitGuardPolicyHash(),
}));
export const assertCompanyApplyContext = (context: ReadonlyContext): string => {
  try { return assertCompanyWriteContext(context); } catch (error) { return rethrowWriteFailure(error, 'INVALID_TIME'); }
};
export const parseCompanyApplyRegistration = (input: unknown): CompanyApplyRegistration => {
  try { return parseCompanyWriteRegistration(input); } catch { return fail('INVALID_REGISTRATION'); }
};
export const hashCompanyApplyRegistration = (input: unknown): string =>
  hashCompanyChangeValue(canonicalReadonlyJson(parseCompanyApplyRegistration(input)));
export const parseCompanyApplyDraft = (input: unknown, registrationInput: unknown): CompanyChangeDraft => {
  try { return parseCompanyWriteDraft(input, registrationInput); }
  catch (error) { return rethrowWriteFailure(error, 'INVALID_DRAFT'); }
};
export const assertCompanyApplySource: (input: unknown) => asserts input is CompanyApplySource = input => {
  try {
    if (!record(input, ['workspace', 'packedRefsHash', 'baseRefKind', 'gitProofHash']) || !digest(input.gitProofHash)
      || input.packedRefsHash !== null && !digest(input.packedRefsHash)
      || !['loose', 'packed'].includes(input.baseRefKind as string)
      || input.baseRefKind === 'packed' && input.packedRefsHash === null) fail('INVALID_SOURCE');
    assertCompanyWriteSource(input.workspace);
  } catch { fail('INVALID_SOURCE'); }
};

const validateDescriptors = (input: unknown, source: CompanyApplySource, branch: string): void => {
  if (!array(input) || input.length !== source.workspace.files.length) fail('INVALID_PLAN');
  let total = 0; const paths: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const value = input[index], file = source.workspace.files[index]!;
    if (!record(value, ['operation', 'path', 'beforeHash', 'afterHash', 'bytes'])
      || !['create', 'replace'].includes(value.operation as string) || typeof value.path !== 'string'
      || value.path !== file.path || value.beforeHash !== file.beforeHash || !digest(value.afterHash)
      || value.beforeHash === value.afterHash || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0
      || Number(value.bytes) > limits.maxContentBytes || (value.operation === 'create') !== (file.beforeHash === null)
      || Number(value.bytes) === 0 && value.afterHash !== hashCompanyChangeValue('')) fail('INVALID_PLAN');
    total += Number(value.bytes); paths.push(value.path);
  }
  if (total > limits.maxTotalContentBytes || branch.split('/').length !== 2) fail('INVALID_PLAN');
  // This validates metadata syntax only; supplied hashes are verified against Git separately before mutation.
  parseCompanyChangeDraft({ version: 'company-change-draft-v1', repoId: 'company-apply-metadata', requestRevision: 1,
    objective: 'Validate apply metadata paths.', baseCommit: '1'.repeat(40), baseBranch: 'main', baseIndexHash: '2'.repeat(64),
    workType: branch.split('/')[0], branch, changes: paths.map(path => ({ operation: 'create', path, beforeHash: null, content: '' })) });
};
export const assertCompanyApplyPlan: (input: unknown) => asserts input is CompanyApplyPlan = input => {
  try {
    if (!record(input, planKeys) || input.version !== 'company-apply-plan-v1' || !isReadonlyId(input.id) || !owner(input.ownerId)
      || !digest(input.registrationHash) || !digest(input.draftHash) || typeof input.branch !== 'string'
      || !timestamp(input.createdAt) || !timestamp(input.expiresAt)
      || Date.parse(input.expiresAt) - Date.parse(input.createdAt) !== limits.planLifetimeMs
      || input.limitsHash !== getCompanyApplyLimitsHash() || !digest(input.planHash)
      || input.scope !== 'company-local-write' || input.checks !== 'not_run' || input.transmissionAllowed !== false) fail('INVALID_PLAN');
    assertCompanyApplySource(input.source); validateDescriptors(input.changes, input.source, input.branch);
    if (Buffer.byteLength(canonicalReadonlyJson(input)) > limits.maxPlanJsonBytes) fail('INVALID_PLAN');
    const { planHash, ...content } = input;
    if (hashCompanyChangeValue(canonicalReadonlyJson(content)) !== planHash) fail('INVALID_PLAN');
  } catch { fail('INVALID_PLAN'); }
};
const sourceMatches = (source: CompanyApplySource, registration: CompanyApplyRegistration, draft: CompanyChangeDraft): void => {
  const workspace = source.workspace;
  if (workspace.indexHash !== registration.baseIndexHash
    || workspace.headHash !== hashCompanyChangeValue(`ref: refs/heads/${registration.baseBranch}\n`)
    || workspace.baseRefHash !== hashCompanyChangeValue(`${registration.baseCommit}\n`)
    || workspace.files.length !== draft.changes.length) fail('SOURCE_MISMATCH');
  for (let index = 0; index < draft.changes.length; index++) {
    const change = draft.changes[index]!, file = workspace.files[index]!;
    if (file.path !== change.path || file.beforeHash !== change.beforeHash || (change.operation === 'create') !== (file.identityHash === null)) fail('SOURCE_MISMATCH');
  }
};
export const createCompanyApplyPlan = (input: unknown, registrationInput: unknown, source: CompanyApplySource,
  context: ReadonlyContext, id: string = randomUUID()): { plan: CompanyApplyPlan; draft: CompanyChangeDraft } => {
  const createdAt = assertCompanyApplyContext(context);
  if (!isReadonlyId(id)) fail('INVALID_ID');
  const registration = parseCompanyApplyRegistration(registrationInput), draft = parseCompanyApplyDraft(input, registration);
  assertCompanyApplySource(source); sourceMatches(source, registration, draft);
  const expiry = new Date(Date.parse(createdAt) + limits.planLifetimeMs);
  if (!Number.isFinite(expiry.getTime())) fail('INVALID_TIME');
  const expiresAt = expiry.toISOString(); if (!timestamp(expiresAt)) fail('INVALID_TIME');
  const content: Omit<CompanyApplyPlan, 'planHash'> = { version: 'company-apply-plan-v1', id, ownerId: context.ownerId,
    registrationHash: hashCompanyApplyRegistration(registration), draftHash: hashCompanyChangeValue(canonicalReadonlyJson(draft)),
    source: copyCompanyChangeData(source), branch: draft.branch, changes: descriptorData(draft), createdAt, expiresAt,
    limitsHash: getCompanyApplyLimitsHash(), scope: 'company-local-write', checks: 'not_run', transmissionAllowed: false };
  const plan = { ...content, planHash: hashCompanyChangeValue(canonicalReadonlyJson(content)) }; assertCompanyApplyPlan(plan);
  return { plan, draft };
};
export const assertCompanyApplyDraftForPlan = (plan: CompanyApplyPlan, input: unknown, registrationInput: unknown): void => {
  assertCompanyApplyPlan(plan);
  const registration = parseCompanyApplyRegistration(registrationInput), draft = parseCompanyApplyDraft(input, registration);
  if (hashCompanyApplyRegistration(registration) !== plan.registrationHash) fail('REGISTRATION_MISMATCH');
  sourceMatches(plan.source, registration, draft);
  if (draft.branch !== plan.branch || hashCompanyChangeValue(canonicalReadonlyJson(draft)) !== plan.draftHash
    || canonicalReadonlyJson(descriptorData(draft)) !== canonicalReadonlyJson(plan.changes)) fail('DRAFT_PLAN_MISMATCH');
};

export const assertCompanyApplyTaskId: (input: unknown) => asserts input is string = input => {
  if (!isReadonlyId(input)) fail('INVALID_ID');
};
export const assertCompanyApplyRequest: (input: unknown) => asserts input is CompanyApplyRequest = input => {
  if (!record(input, ['taskId', 'planHash']) || !isReadonlyId(input.taskId) || !digest(input.planHash)) fail('INVALID_REQUEST');
};
export const assertCompanyApplyApprovalRequest: (input: unknown) => asserts input is CompanyApplyApprovalRequest = input => {
  if (!record(input, ['taskId', 'planHash', 'expiresInMinutes']) || !isReadonlyId(input.taskId) || !digest(input.planHash)
    || !Number.isInteger(input.expiresInMinutes) || Number(input.expiresInMinutes) < limits.minApprovalMinutes
    || Number(input.expiresInMinutes) > limits.maxApprovalMinutes) fail('INVALID_APPROVAL');
};
export const assertCompanyApplyApproval: (plan: CompanyApplyPlan, input: unknown) => asserts input is CompanyApplyApproval = (plan, input) => {
  assertCompanyApplyPlan(plan);
  try {
    if (!record(input, approvalKeys) || input.version !== 'company-apply-approval-v1' || !isReadonlyId(input.id)
      || input.taskId !== plan.id || input.ownerId !== plan.ownerId || input.planHash !== plan.planHash
      || !timestamp(input.createdAt) || !timestamp(input.expiresAt) || input.createdAt < plan.createdAt || input.createdAt >= plan.expiresAt
      || input.expiresAt > plan.expiresAt || Date.parse(input.expiresAt) - Date.parse(input.createdAt) < limits.minApprovalMinutes * 60_000
      || Date.parse(input.expiresAt) - Date.parse(input.createdAt) > limits.maxApprovalMinutes * 60_000
      || (Date.parse(input.expiresAt) - Date.parse(input.createdAt)) % 60_000 !== 0
      || input.usedAt !== null && (!timestamp(input.usedAt) || input.usedAt < input.createdAt || input.usedAt >= input.expiresAt)
      || input.scope !== 'company-local-write') fail('INVALID_APPROVAL');
  } catch { fail('INVALID_APPROVAL'); }
};
export const createCompanyApplyApproval = (plan: CompanyApplyPlan, request: CompanyApplyApprovalRequest,
  context: ReadonlyContext, id: string = randomUUID()): CompanyApplyApproval => {
  assertCompanyApplyPlan(plan); assertCompanyApplyApprovalRequest(request);
  const createdAt = assertCompanyApplyContext(context);
  if (!isReadonlyId(id)) fail('INVALID_ID');
  if (context.ownerId !== plan.ownerId) fail('OWNER_MISMATCH');
  if (request.taskId !== plan.id || request.planHash !== plan.planHash) fail('PLAN_MISMATCH');
  if (createdAt < plan.createdAt) fail('INVALID_TIME');
  if (createdAt >= plan.expiresAt) fail('EXPIRED');
  const expiresAtMs = Date.parse(createdAt) + request.expiresInMinutes * 60_000;
  if (expiresAtMs > Date.parse(plan.expiresAt)) fail('APPROVAL_EXCEEDS_PLAN_TTL');
  const approval: CompanyApplyApproval = { version: 'company-apply-approval-v1', id, taskId: plan.id,
    ownerId: context.ownerId, planHash: plan.planHash, createdAt, expiresAt: new Date(expiresAtMs).toISOString(),
    usedAt: null, scope: 'company-local-write' };
  assertCompanyApplyApproval(plan, approval); return approval;
};
