import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { types } from 'node:util';
import type { CompanyChangeDraft } from '../domain/company-change.js';
import type { CompanyWriteApproval, CompanyWriteApprovalRequest, CompanyWriteDescriptor, CompanyWritePlan,
  CompanyWriteRegistration, CompanyWriteSource } from '../domain/company-write.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { assertCompanyChangeContext, copyCompanyChangeData, hashCompanyChangeValue, parseCompanyChangeDraft } from './company-change.js';
import { canonicalReadonlyJson, isReadonlyId } from './readonly-investigation-policy.js';
import { containsSensitiveText } from './redaction.js';

const limits = Object.freeze({ maxChanges: 8, maxContentBytes: 65_536, maxTotalContentBytes: 131_072,
  maxDraftJsonBytes: 262_144, maxRegistrationJsonBytes: 16_384, maxPlanJsonBytes: 16_384,
  maxWorkerInputBytes: 327_680, maxIndexBytes: 1_048_576, maxGitTextBytes: 1024,
  planLifetimeMs: 86_400_000, minApprovalMinutes: 1, maxApprovalMinutes: 60,
  workerWallTimeMs: 30_000, terminationGraceMs: 250, maxWorkerOutputBytes: 16_384, workerOldSpaceMiB: 128 });
const registrationKeys = ['version', 'repoId', 'sourceRoot', 'baseBranch', 'baseCommit', 'baseIndexHash', 'writeAllowedFiles', 'enabled', 'localRead', 'localWrite'];
const sourceKeys = ['rootIdentityHash', 'headHash', 'indexHash', 'baseRefHash', 'files'];
const sourceFileKeys = ['path', 'beforeHash', 'mode', 'identityHash', 'parentIdentityHash'];
const descriptorKeys = ['operation', 'path', 'beforeHash', 'afterHash', 'bytes'];
const planKeys = ['version', 'id', 'ownerId', 'registrationHash', 'draftHash', 'source', 'branch', 'changes',
  'createdAt', 'expiresAt', 'limitsHash', 'planHash', 'scope', 'checks', 'transmissionAllowed'];
const approvalKeys = ['version', 'id', 'taskId', 'ownerId', 'planHash', 'createdAt', 'expiresAt', 'usedAt', 'scope'];
const fail: (suffix: string) => never = suffix => { throw new HarnessError(`COMPANY_WRITE_${suffix}`); };
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
const commit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const declaredRoot = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 4096 || value.endsWith('/') || !posix.isAbsolute(value)
    || posix.normalize(value) !== value || /[\\'"`]/u.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 32 || code === 127) return false;
  }
  return value.split('/').every(part => !part.toLowerCase().startsWith('.git')
    && !/^\.(?:env|ssh|aws|codex|config)(?:[._-]|$)/iu.test(part));
};
const owner = (value: unknown): value is string => typeof value === 'string' && /^os-user:(0|[1-9][0-9]{0,15})$/u.test(value);
const descriptorData = (draft: CompanyChangeDraft): CompanyWriteDescriptor[] => draft.changes.map(change => ({
  operation: change.operation, path: change.path, beforeHash: change.beforeHash,
  afterHash: hashCompanyChangeValue(change.content), bytes: Buffer.byteLength(change.content, 'utf8'),
}));

export const hashCompanyWriteValue = hashCompanyChangeValue;
export const copyCompanyWriteData = copyCompanyChangeData;
export const getCompanyWriteLimits = () => limits;
export const getCompanyWriteLimitsHash = (): string => hashCompanyChangeValue(canonicalReadonlyJson({ version: 'company-write-plan-v1', limits }));
export const assertCompanyWriteContext = (context: ReadonlyContext): string => {
  try { return assertCompanyChangeContext(context); }
  catch (error) { return fail(error instanceof HarnessError && error.code === 'COMPANY_CHANGE_OWNER_MISMATCH' ? 'OWNER_MISMATCH' : 'INVALID_TIME'); }
};

/** Reuses path and branch syntax checks with synthetic placeholders, not purported source contents. */
const validatePaths = (paths: string[], baseBranch = 'main', targetBranch?: string): void => {
  const branch = targetBranch ?? (baseBranch.toLowerCase() === 'fix/registration-validation' ? 'fix/registration-validation-other' : 'fix/registration-validation');
  parseCompanyChangeDraft({ version: 'company-change-draft-v1', repoId: 'company-write-metadata', requestRevision: 1,
    objective: 'Validate write metadata paths.', baseCommit: '1'.repeat(40), baseBranch, baseIndexHash: '2'.repeat(64),
    workType: branch.split('/')[0], branch, changes: paths.map(path => ({ operation: 'create', path, beforeHash: null, content: '' })) });
  if (targetBranch !== undefined && branch.split('/').length !== 2) fail('INVALID_PLAN');
};

export const parseCompanyWriteRegistration = (input: unknown): CompanyWriteRegistration => {
  try {
    if (!record(input, registrationKeys) || input.version !== 'company-write-registration-v1'
      || typeof input.repoId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.repoId)
      || !declaredRoot(input.sourceRoot) || typeof input.baseBranch !== 'string' || !commit(input.baseCommit) || !digest(input.baseIndexHash)
      || !array(input.writeAllowedFiles) || input.writeAllowedFiles.some(path => typeof path !== 'string')
      || typeof input.enabled !== 'boolean' || !['unconfirmed', 'allowed'].includes(input.localRead as string)
      || !['unconfirmed', 'allowed'].includes(input.localWrite as string)) fail('INVALID_REGISTRATION');
    validatePaths(input.writeAllowedFiles as string[], input.baseBranch);
    const registration: CompanyWriteRegistration = { version: 'company-write-registration-v1', repoId: input.repoId,
      sourceRoot: input.sourceRoot, baseBranch: input.baseBranch, baseCommit: input.baseCommit, baseIndexHash: input.baseIndexHash,
      writeAllowedFiles: [...input.writeAllowedFiles] as string[], enabled: input.enabled,
      localRead: input.localRead as CompanyWriteRegistration['localRead'], localWrite: input.localWrite as CompanyWriteRegistration['localWrite'] };
    const encoded = canonicalReadonlyJson(registration);
    if (Buffer.byteLength(encoded) > limits.maxRegistrationJsonBytes || containsSensitiveText(encoded)) fail('INVALID_REGISTRATION');
    return registration;
  } catch { return fail('INVALID_REGISTRATION'); }
};
export const hashCompanyWriteRegistration = (input: unknown): string => hashCompanyChangeValue(canonicalReadonlyJson(parseCompanyWriteRegistration(input)));

export const assertCompanyWriteSource: (input: unknown) => asserts input is CompanyWriteSource = input => {
  try {
    if (!record(input, sourceKeys) || !digest(input.rootIdentityHash) || !digest(input.headHash) || !digest(input.indexHash)
      || !digest(input.baseRefHash) || !array(input.files)) fail('INVALID_SOURCE');
    const paths: string[] = [];
    for (const value of input.files) {
      if (!record(value, sourceFileKeys) || typeof value.path !== 'string' || !digest(value.parentIdentityHash)
        || (value.beforeHash === null ? value.mode !== null || value.identityHash !== null
          : !digest(value.beforeHash) || !digest(value.identityHash) || !Number.isSafeInteger(value.mode)
            || Number(value.mode) < 0 || Number(value.mode) > 0o777 || (Number(value.mode) & 0o111) !== 0)) fail('INVALID_SOURCE');
      paths.push(value.path);
    }
    validatePaths(paths);
  } catch { fail('INVALID_SOURCE'); }
};

const validateDescriptors = (input: unknown, source: CompanyWriteSource, branch: string): void => {
  if (!array(input) || input.length !== source.files.length) fail('INVALID_PLAN');
  let total = 0; const paths: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const value = input[index], file = source.files[index]!;
    if (!record(value, descriptorKeys) || !['create', 'replace'].includes(value.operation as string)
      || typeof value.path !== 'string' || value.path !== file.path || value.beforeHash !== file.beforeHash || !digest(value.afterHash)
      || value.beforeHash === value.afterHash || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0
      || Number(value.bytes) > limits.maxContentBytes || (value.operation === 'create') !== (file.beforeHash === null)
      || Number(value.bytes) === 0 && value.afterHash !== hashCompanyChangeValue('')) fail('INVALID_PLAN');
    total += Number(value.bytes); paths.push(value.path);
  }
  if (total > limits.maxTotalContentBytes) fail('INVALID_PLAN');
  validatePaths(paths, 'main', branch);
};

export const assertCompanyWritePlan: (input: unknown) => asserts input is CompanyWritePlan = input => {
  try {
    if (!record(input, planKeys) || input.version !== 'company-write-plan-v1' || !isReadonlyId(input.id) || !owner(input.ownerId)
      || !digest(input.registrationHash) || !digest(input.draftHash) || typeof input.branch !== 'string'
      || !timestamp(input.createdAt) || !timestamp(input.expiresAt)
      || Date.parse(input.expiresAt) - Date.parse(input.createdAt) !== limits.planLifetimeMs
      || input.limitsHash !== getCompanyWriteLimitsHash() || !digest(input.planHash)
      || input.scope !== 'synthetic-validation' || input.checks !== 'not_run' || input.transmissionAllowed !== false) fail('INVALID_PLAN');
    assertCompanyWriteSource(input.source); validateDescriptors(input.changes, input.source, input.branch);
    if (Buffer.byteLength(canonicalReadonlyJson(input)) > limits.maxPlanJsonBytes) fail('INVALID_PLAN');
    const { planHash, ...content } = input;
    if (hashCompanyChangeValue(canonicalReadonlyJson(content)) !== planHash) fail('INVALID_PLAN');
  } catch { fail('INVALID_PLAN'); }
};

const enabledRegistration = (input: unknown): CompanyWriteRegistration => {
  const registration = parseCompanyWriteRegistration(input);
  if (!registration.enabled || registration.localRead !== 'allowed' || registration.localWrite !== 'allowed') fail('REGISTRATION_DISABLED');
  return registration;
};
const boundDraft = (input: unknown, registration: CompanyWriteRegistration): CompanyChangeDraft => {
  let draft: CompanyChangeDraft;
  try {
    if (!record(input, ['version', 'repoId', 'requestRevision', 'objective', 'baseCommit', 'baseBranch', 'baseIndexHash', 'workType', 'branch', 'changes'])
      || !array(input.changes) || input.changes.some(change => !record(change, ['operation', 'path', 'beforeHash', 'content']))) fail('INVALID_DRAFT');
    draft = parseCompanyChangeDraft(input);
  } catch { return fail('INVALID_DRAFT'); }
  if (draft.repoId !== registration.repoId || draft.baseCommit !== registration.baseCommit
    || draft.baseBranch !== registration.baseBranch || draft.baseIndexHash !== registration.baseIndexHash) fail('REGISTRATION_MISMATCH');
  if (draft.branch.split('/').length !== 2 || draft.changes.some(change => !registration.writeAllowedFiles.includes(change.path))) fail('WRITE_SCOPE_MISMATCH');
  return draft;
};
export const parseCompanyWriteDraft = (input: unknown, registrationInput: unknown): CompanyChangeDraft =>
  boundDraft(input, enabledRegistration(registrationInput));
const sourceMatches = (source: CompanyWriteSource, registration: CompanyWriteRegistration, draft: CompanyChangeDraft): void => {
  if (source.indexHash !== registration.baseIndexHash
    || source.headHash !== hashCompanyChangeValue(`ref: refs/heads/${registration.baseBranch}\n`)
    || source.baseRefHash !== hashCompanyChangeValue(`${registration.baseCommit}\n`)
    || source.files.length !== draft.changes.length) fail('SOURCE_MISMATCH');
  for (let index = 0; index < draft.changes.length; index++) {
    const change = draft.changes[index]!, file = source.files[index]!;
    if (file.path !== change.path || file.beforeHash !== change.beforeHash || (change.operation === 'create') !== (file.identityHash === null)) fail('SOURCE_MISMATCH');
  }
};

export const createCompanyWritePlan = (input: unknown, registrationInput: unknown, source: CompanyWriteSource,
  context: ReadonlyContext, id: string = randomUUID()): { plan: CompanyWritePlan; draft: CompanyChangeDraft } => {
  const createdAt = assertCompanyWriteContext(context);
  if (!isReadonlyId(id)) fail('INVALID_ID');
  const registration = enabledRegistration(registrationInput), draft = boundDraft(input, registration);
  assertCompanyWriteSource(source); sourceMatches(source, registration, draft);
  const expiry = new Date(Date.parse(createdAt) + limits.planLifetimeMs);
  if (!Number.isFinite(expiry.getTime())) fail('INVALID_TIME');
  const expiresAt = expiry.toISOString(); if (!timestamp(expiresAt)) fail('INVALID_TIME');
  const content: Omit<CompanyWritePlan, 'planHash'> = { version: 'company-write-plan-v1', id, ownerId: context.ownerId,
    registrationHash: hashCompanyWriteRegistration(registration), draftHash: hashCompanyChangeValue(canonicalReadonlyJson(draft)),
    source: copyCompanyChangeData(source), branch: draft.branch, changes: descriptorData(draft), createdAt, expiresAt,
    limitsHash: getCompanyWriteLimitsHash(), scope: 'synthetic-validation', checks: 'not_run', transmissionAllowed: false };
  const plan = { ...content, planHash: hashCompanyChangeValue(canonicalReadonlyJson(content)) }; assertCompanyWritePlan(plan);
  return { plan, draft };
};

export const assertCompanyWriteDraftForPlan = (plan: CompanyWritePlan, input: unknown, registrationInput: unknown): void => {
  assertCompanyWritePlan(plan);
  const registration = enabledRegistration(registrationInput), draft = boundDraft(input, registration);
  if (hashCompanyWriteRegistration(registration) !== plan.registrationHash) fail('REGISTRATION_MISMATCH');
  sourceMatches(plan.source, registration, draft);
  if (draft.branch !== plan.branch || hashCompanyChangeValue(canonicalReadonlyJson(draft)) !== plan.draftHash
    || canonicalReadonlyJson(descriptorData(draft)) !== canonicalReadonlyJson(plan.changes)) fail('DRAFT_PLAN_MISMATCH');
};

export const assertCompanyWriteApprovalRequest: (input: unknown) => asserts input is CompanyWriteApprovalRequest = input => {
  try {
    if (!record(input, ['taskId', 'planHash', 'expiresInMinutes']) || !isReadonlyId(input.taskId) || !digest(input.planHash)
      || !Number.isInteger(input.expiresInMinutes) || Number(input.expiresInMinutes) < limits.minApprovalMinutes
      || Number(input.expiresInMinutes) > limits.maxApprovalMinutes) fail('INVALID_APPROVAL');
  } catch { fail('INVALID_APPROVAL'); }
};
export const assertCompanyWriteApproval: (plan: CompanyWritePlan, input: unknown) => asserts input is CompanyWriteApproval = (plan, input) => {
  assertCompanyWritePlan(plan);
  try {
    if (!record(input, approvalKeys) || input.version !== 'company-write-approval-v1' || !isReadonlyId(input.id)
      || input.taskId !== plan.id || input.ownerId !== plan.ownerId || input.planHash !== plan.planHash
      || !timestamp(input.createdAt) || !timestamp(input.expiresAt) || input.createdAt < plan.createdAt || input.createdAt >= plan.expiresAt
      || input.expiresAt > plan.expiresAt || Date.parse(input.expiresAt) - Date.parse(input.createdAt) < limits.minApprovalMinutes * 60_000
      || Date.parse(input.expiresAt) - Date.parse(input.createdAt) > limits.maxApprovalMinutes * 60_000
      || (Date.parse(input.expiresAt) - Date.parse(input.createdAt)) % 60_000 !== 0
      || input.usedAt !== null && (!timestamp(input.usedAt) || input.usedAt < input.createdAt || input.usedAt >= input.expiresAt)
      || input.scope !== 'synthetic-validation') fail('INVALID_APPROVAL');
  } catch { fail('INVALID_APPROVAL'); }
};
export const createCompanyWriteApproval = (plan: CompanyWritePlan, request: CompanyWriteApprovalRequest,
  context: ReadonlyContext, id: string = randomUUID()): CompanyWriteApproval => {
  assertCompanyWritePlan(plan); assertCompanyWriteApprovalRequest(request);
  const createdAt = assertCompanyWriteContext(context);
  if (!isReadonlyId(id)) fail('INVALID_ID');
  if (context.ownerId !== plan.ownerId) fail('OWNER_MISMATCH');
  if (request.taskId !== plan.id || request.planHash !== plan.planHash) fail('PLAN_MISMATCH');
  if (createdAt < plan.createdAt) fail('INVALID_TIME');
  if (createdAt >= plan.expiresAt) fail('EXPIRED');
  const expiresAtMs = Date.parse(createdAt) + request.expiresInMinutes * 60_000;
  if (expiresAtMs > Date.parse(plan.expiresAt)) fail('APPROVAL_EXCEEDS_PLAN_TTL');
  const expiresAt = new Date(expiresAtMs).toISOString();
  const approval: CompanyWriteApproval = { version: 'company-write-approval-v1', id, taskId: plan.id,
    ownerId: context.ownerId, planHash: plan.planHash, createdAt, expiresAt, usedAt: null, scope: 'synthetic-validation' };
  assertCompanyWriteApproval(plan, approval); return approval;
};
