import { randomUUID } from 'node:crypto';
import type { CompanyChangeDraft } from '../domain/company-change.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import type { SyntheticCompanyChangeApproval, SyntheticCompanyChangeApprovalRequest,
  SyntheticCompanyChangeDescriptor, SyntheticCompanyChangePlan, SyntheticCompanyChangeRequest,
  SyntheticCompanyChangeSource } from '../domain/synthetic-company-change.js';
import { assertCompanyChangeContext, copyCompanyChangeData, getCompanyChangeLimits,
  hashCompanyChangeValue, parseCompanyChangeDraft } from './company-change.js';
import { canonicalReadonlyJson, isReadonlyId } from './readonly-investigation-policy.js';

const draftLimits = getCompanyChangeLimits();
const limits = Object.freeze({ maxChanges: draftLimits.maxChanges, maxContentBytes: draftLimits.maxContentBytes,
  maxTotalContentBytes: draftLimits.maxTotalContentBytes, maxDraftJsonBytes: draftLimits.maxDraftJsonBytes,
  maxPlanJsonBytes: 16_384, maxSourceBytes: 1_048_576, maxSourceEntries: 256, maxJournalEntries: 18,
  planLifetimeMs: 86_400_000, minApprovalMinutes: 1, maxApprovalMinutes: 60, busyTimeoutMs: 100 });
const sourceKeys = ['repositoryId', 'rootHash', 'baseCommit', 'baseBranch', 'indexHash', 'sourceHash'];
const planKeys = ['version', 'id', 'ownerId', 'draftHash', 'branch', 'requestRevision', 'source', 'changes', 'createdAt', 'expiresAt',
  'limitsHash', 'planHash', 'scope', 'checks', 'transmissionAllowed'];
const descriptorKeys = ['operation', 'path', 'beforeHash', 'afterHash', 'bytes'];
const approvalKeys = ['id', 'taskId', 'ownerId', 'planHash', 'createdAt', 'expiresAt', 'usedAt', 'scope'];
const fail: (suffix: string) => never = suffix => { throw new HarnessError(`SYNTHETIC_COMPANY_CHANGE_${suffix}`); };
const record = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = descriptors[key];
    return Boolean(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
  });
};
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export const hashSyntheticCompanyChangeValue = hashCompanyChangeValue;
export const copySyntheticCompanyChangeData = copyCompanyChangeData;
export const getSyntheticCompanyChangeLimits = () => limits;
export const getSyntheticCompanyChangeLimitsHash = (): string => hashCompanyChangeValue(canonicalReadonlyJson({
  version: 'synthetic-company-change-apply-v1', limits,
}));
export const assertSyntheticCompanyChangeContext = (context: ReadonlyContext): string => {
  try { return assertCompanyChangeContext(context); }
  catch (error) {
    return fail(error instanceof HarnessError && error.code === 'COMPANY_CHANGE_OWNER_MISMATCH' ? 'OWNER_MISMATCH' : 'INVALID_TIME');
  }
};

/** Reuse the declared-input path/branch policy without pretending metadata contains actual source text. */
const assertMetadataPaths = (source: SyntheticCompanyChangeSource, changes: SyntheticCompanyChangeDescriptor[], targetBranch?: string): void => {
  const placeholder = 'synthetic descriptor validation\n';
  const branch = targetBranch ?? (source.baseBranch.toLowerCase() === 'fix/synthetic-metadata'
    ? 'fix/synthetic-metadata-alternate' : 'fix/synthetic-metadata');
  parseCompanyChangeDraft({ version: 'company-change-draft-v1', repoId: source.repositoryId, requestRevision: 1,
    objective: 'Validate synthetic metadata paths.', baseCommit: source.baseCommit, baseBranch: source.baseBranch,
    baseIndexHash: source.indexHash, workType: branch.split('/')[0], branch,
    changes: changes.map(change => ({ operation: change.operation, path: change.path, beforeHash: change.beforeHash,
      content: change.beforeHash === hashCompanyChangeValue(placeholder) ? '' : placeholder })) });
};

export const assertSyntheticCompanyChangeSource: (input: unknown) => asserts input is SyntheticCompanyChangeSource = input => {
  try {
    if (!record(input, sourceKeys) || input.repositoryId !== 'synthetic-company-change' || !digest(input.rootHash)
      || typeof input.baseCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(input.baseCommit)
      || typeof input.baseBranch !== 'string' || !digest(input.indexHash) || !digest(input.sourceHash)) fail('INVALID_SOURCE');
    assertMetadataPaths(input as unknown as SyntheticCompanyChangeSource, [
      { operation: 'create', path: 'synthetic-metadata.ts', beforeHash: null, afterHash: hashCompanyChangeValue(''), bytes: 0 },
    ]);
  } catch { fail('INVALID_SOURCE'); }
};

const descriptorsFromDraft = (draft: CompanyChangeDraft): SyntheticCompanyChangeDescriptor[] => draft.changes.map(change => ({
  operation: change.operation, path: change.path, beforeHash: change.beforeHash,
  afterHash: hashCompanyChangeValue(change.content), bytes: Buffer.byteLength(change.content, 'utf8'),
}));

const assertDescriptors = (source: SyntheticCompanyChangeSource, value: unknown, branch: string): void => {
  if (!Array.isArray(value) || value.length < 1 || value.length > limits.maxChanges
    || Reflect.ownKeys(value).length !== value.length + 1) fail('INVALID_PLAN');
  let totalBytes = 0;
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('INVALID_PLAN');
    const descriptor: unknown = property.value;
    if (!record(descriptor, descriptorKeys) || typeof descriptor.operation !== 'string'
      || !['replace', 'create'].includes(descriptor.operation) || typeof descriptor.path !== 'string'
      || !digest(descriptor.afterHash) || !Number.isSafeInteger(descriptor.bytes) || Number(descriptor.bytes) < 0
      || Number(descriptor.bytes) > limits.maxContentBytes
      || (descriptor.operation === 'replace' ? !digest(descriptor.beforeHash) : descriptor.beforeHash !== null)
      || descriptor.beforeHash === descriptor.afterHash) fail('INVALID_PLAN');
    totalBytes += Number(descriptor.bytes);
  }
  if (totalBytes > limits.maxTotalContentBytes) fail('INVALID_PLAN');
  assertMetadataPaths(source, value as SyntheticCompanyChangeDescriptor[], branch);
};

export const assertSyntheticCompanyChangePlan: (input: unknown) => asserts input is SyntheticCompanyChangePlan = input => {
  try {
    if (!record(input, planKeys) || input.version !== 'synthetic-company-change-apply-v1' || !isReadonlyId(input.id)
      || typeof input.ownerId !== 'string' || !/^os-user:(0|[1-9][0-9]{0,15})$/u.test(input.ownerId)
      || typeof input.branch !== 'string' || !Number.isSafeInteger(input.requestRevision) || Number(input.requestRevision) < 1
      || !digest(input.draftHash) || !timestamp(input.createdAt) || !timestamp(input.expiresAt)
      || Date.parse(input.expiresAt) - Date.parse(input.createdAt) !== limits.planLifetimeMs
      || input.limitsHash !== getSyntheticCompanyChangeLimitsHash() || !digest(input.planHash)
      || input.scope !== 'synthetic-only' || input.checks !== 'not_run' || input.transmissionAllowed !== false) fail('INVALID_PLAN');
    assertSyntheticCompanyChangeSource(input.source);
    assertDescriptors(input.source, input.changes, input.branch);
    if (Buffer.byteLength(canonicalReadonlyJson(input)) > limits.maxPlanJsonBytes) fail('INVALID_PLAN');
    const { planHash, ...content } = input;
    if (hashCompanyChangeValue(canonicalReadonlyJson(content)) !== planHash) fail('INVALID_PLAN');
  } catch { fail('INVALID_PLAN'); }
};

const boundDraft = (input: unknown, source: SyntheticCompanyChangeSource): CompanyChangeDraft => {
  let draft: CompanyChangeDraft;
  try { draft = parseCompanyChangeDraft(input); } catch { return fail('INVALID_DRAFT'); }
  if (draft.repoId !== source.repositoryId || draft.baseCommit !== source.baseCommit
    || draft.baseBranch !== source.baseBranch || draft.baseIndexHash !== source.indexHash) fail('SOURCE_MISMATCH');
  return draft;
};

export const createSyntheticCompanyChangePlan = (input: unknown, source: SyntheticCompanyChangeSource,
  context: ReadonlyContext, id: string = randomUUID()): { plan: SyntheticCompanyChangePlan; draft: CompanyChangeDraft } => {
  const createdAt = assertSyntheticCompanyChangeContext(context);
  if (!isReadonlyId(id)) fail('INVALID_ID');
  assertSyntheticCompanyChangeSource(source);
  const draft = boundDraft(input, source), expiry = new Date(Date.parse(createdAt) + limits.planLifetimeMs);
  if (!Number.isFinite(expiry.getTime())) fail('INVALID_TIME');
  const expiresAt = expiry.toISOString();
  if (!timestamp(expiresAt)) fail('INVALID_TIME');
  const content: Omit<SyntheticCompanyChangePlan, 'planHash'> = { version: 'synthetic-company-change-apply-v1', id,
    ownerId: context.ownerId, draftHash: hashCompanyChangeValue(canonicalReadonlyJson(draft)),
    branch: draft.branch, requestRevision: draft.requestRevision,
    source: copyCompanyChangeData(source), changes: descriptorsFromDraft(draft), createdAt, expiresAt,
    limitsHash: getSyntheticCompanyChangeLimitsHash(), scope: 'synthetic-only', checks: 'not_run', transmissionAllowed: false };
  const plan = { ...content, planHash: hashCompanyChangeValue(canonicalReadonlyJson(content)) };
  assertSyntheticCompanyChangePlan(plan);
  return { plan, draft };
};

export const assertSyntheticCompanyChangeDraftForPlan = (plan: SyntheticCompanyChangePlan, input: unknown): void => {
  assertSyntheticCompanyChangePlan(plan);
  const draft = boundDraft(input, plan.source);
  if (hashCompanyChangeValue(canonicalReadonlyJson(draft)) !== plan.draftHash
    || draft.branch !== plan.branch || draft.requestRevision !== plan.requestRevision
    || canonicalReadonlyJson(descriptorsFromDraft(draft)) !== canonicalReadonlyJson(plan.changes)) fail('DRAFT_PLAN_MISMATCH');
};

export const assertSyntheticCompanyChangeRequest: (input: unknown) => asserts input is SyntheticCompanyChangeRequest = input => {
  try {
    if (!record(input, ['taskId', 'planHash']) || !isReadonlyId(input.taskId) || !digest(input.planHash)) fail('INVALID_REQUEST');
  } catch { fail('INVALID_REQUEST'); }
};
export const assertSyntheticCompanyChangeClaimRequest: (input: unknown) => asserts input is SyntheticCompanyChangeRequest
  = assertSyntheticCompanyChangeRequest;

export const assertSyntheticCompanyChangeApprovalRequest: (input: unknown) => asserts input is SyntheticCompanyChangeApprovalRequest = input => {
  try {
    if (!record(input, ['taskId', 'planHash', 'expiresInMinutes']) || !isReadonlyId(input.taskId) || !digest(input.planHash)
      || !Number.isInteger(input.expiresInMinutes) || Number(input.expiresInMinutes) < limits.minApprovalMinutes
      || Number(input.expiresInMinutes) > limits.maxApprovalMinutes) fail('INVALID_APPROVAL');
  } catch { fail('INVALID_APPROVAL'); }
};

export const assertSyntheticCompanyChangeApproval: (plan: SyntheticCompanyChangePlan, input: unknown) => asserts input is SyntheticCompanyChangeApproval = (plan, input) => {
  assertSyntheticCompanyChangePlan(plan);
  try {
    if (!record(input, approvalKeys) || !isReadonlyId(input.id) || input.taskId !== plan.id || input.ownerId !== plan.ownerId
      || input.planHash !== plan.planHash || !timestamp(input.createdAt) || !timestamp(input.expiresAt)
      || input.createdAt < plan.createdAt || input.createdAt >= plan.expiresAt || input.expiresAt > plan.expiresAt
      || Date.parse(input.expiresAt) - Date.parse(input.createdAt) < limits.minApprovalMinutes * 60_000
      || Date.parse(input.expiresAt) - Date.parse(input.createdAt) > limits.maxApprovalMinutes * 60_000
      || (Date.parse(input.expiresAt) - Date.parse(input.createdAt)) % 60_000 !== 0
      || input.usedAt !== null && (!timestamp(input.usedAt) || input.usedAt < input.createdAt || input.usedAt >= input.expiresAt)
      || input.scope !== 'synthetic-apply') fail('INVALID_APPROVAL');
  } catch { fail('INVALID_APPROVAL'); }
};
