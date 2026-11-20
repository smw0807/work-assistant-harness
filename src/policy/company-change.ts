import { createHash, randomUUID } from 'node:crypto';
import type { CompanyChangeApproval, CompanyChangeApprovalRequest, CompanyChangeDraft,
  CompanyChangeDraftChange, CompanyChangePlan, CompanyChangeWorkType } from '../domain/company-change.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { HarnessError } from '../domain/errors.js';
import { canonicalReadonlyJson } from './readonly-investigation-policy.js';
import { containsSensitiveText } from './redaction.js';

const limits = Object.freeze({ maxChanges: 8, maxContentBytes: 65_536, maxTotalContentBytes: 131_072,
  maxDraftJsonBytes: 262_144, maxPlanJsonBytes: 16_384, maxReviewJsonBytes: 294_912,
  planLifetimeMs: 24 * 60 * 60 * 1000, auditLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  minApprovalMinutes: 1, maxApprovalMinutes: 60 });
const draftKeys = ['version', 'repoId', 'requestRevision', 'objective', 'baseCommit', 'baseBranch', 'baseIndexHash', 'workType', 'branch', 'changes'];
const changeKeys = ['operation', 'path', 'beforeHash', 'content'];
const planKeys = ['version', 'id', 'ownerId', 'draftHash', 'changeCount', 'createdAt', 'expiresAt', 'auditExpiresAt',
  'limitsHash', 'sourceVerification', 'approvalScope', 'executionAllowed', 'transmissionAllowed', 'planHash'];
const approvalKeys = ['id', 'taskId', 'ownerId', 'planHash', 'createdAt', 'expiresAt', 'revokedAt', 'usedAt', 'scope', 'executionAllowed'];
const workTypes: readonly CompanyChangeWorkType[] = ['feature', 'fix', 'chore', 'refactor'];
const fail: (suffix: string) => never = (suffix) => { throw new HarnessError(`COMPANY_CHANGE_${suffix}`); };
const record = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = descriptors[key]; return Boolean(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
  });
};
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const owner = (value: unknown): value is string => typeof value === 'string' && /^os-user:(0|[1-9][0-9]{0,15})$/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const hasBinaryControls = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === 127 || code < 32 && ![9, 10, 13].includes(code)) return true;
  }
  return false;
};
const text = (value: unknown, maximum: number): value is string => typeof value === 'string'
  && Buffer.byteLength(value, 'utf8') <= maximum && Buffer.from(value, 'utf8').toString('utf8') === value
  && !hasBinaryControls(value);
const branchName = (value: unknown): value is string => typeof value === 'string' && value.length <= 255
  && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) && !value.startsWith('refs/') && value !== 'HEAD'
  && !value.includes('..') && value.split('/').every(part => part.length > 0 && !part.startsWith('.')
    && !part.endsWith('.') && !part.toLowerCase().endsWith('.lock'));
const sourcePath = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value)) return false;
  return value.split('/').every(part => {
    const lower = part.toLowerCase();
    return part !== '.' && part !== '..' && part.length <= 255 && !part.endsWith('.')
      && !lower.startsWith('.git') && !/^\.env(?:[._-]|$)/u.test(lower)
      && !['node_modules', '.hg', '.svn', '.ssh', '.aws', '.codex', '.config', '.cache', '.npmrc', '.pnpmrc', '.netrc', '.pypirc'].includes(lower)
      && !/^\.yarnrc(?:\.|$)/u.test(lower) && !/^(?:secrets?|credentials?)(?:[._-]|$)/u.test(lower)
      && !/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u.test(lower) && !/\.(?:env|pem|key|p12|pfx|keystore)$/u.test(lower);
  });
};
const canonical = (value: unknown): string => canonicalReadonlyJson(value);

export const hashCompanyChangeValue = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const copyCompanyChangeData = <T>(value: T): T => JSON.parse(canonical(value)) as T;
export const getCompanyChangeLimits = () => limits;
export const getCompanyChangeLimitsHash = (): string => hashCompanyChangeValue(canonical({ version: 'company-change-review-v1', limits }));

export const assertCompanyChangeContext = (context: ReadonlyContext): string => {
  if (!context || !(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) fail('INVALID_TIME');
  if (!process.getuid || context.ownerId !== `os-user:${process.getuid()}`) fail('OWNER_MISMATCH');
  const now = context.now.toISOString();
  if (!timestamp(now)) fail('INVALID_TIME');
  return now;
};

export const parseCompanyChangeDraft = (input: unknown): CompanyChangeDraft => {
  try {
    if (!record(input, draftKeys) || input.version !== 'company-change-draft-v1'
      || typeof input.repoId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.repoId)
      || !Number.isSafeInteger(input.requestRevision) || Number(input.requestRevision) < 1
      || !text(input.objective, limits.maxDraftJsonBytes) || !input.objective.trim()
      || typeof input.baseCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(input.baseCommit)
      || !branchName(input.baseBranch) || !digest(input.baseIndexHash)
      || !workTypes.includes(input.workType as CompanyChangeWorkType) || !branchName(input.branch)
      || !input.branch.startsWith(`${String(input.workType)}/`) || input.branch.toLowerCase() === input.baseBranch.toLowerCase()
      || !Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > limits.maxChanges
      || Reflect.ownKeys(input.changes).length !== input.changes.length + 1) fail('INVALID_DRAFT');
    const changes: CompanyChangeDraftChange[] = [], paths: string[] = [];
    let totalBytes = 0;
    for (let index = 0; index < input.changes.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input.changes, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_DRAFT');
      const change: unknown = descriptor.value;
      if (!record(change, changeKeys) || typeof change.operation !== 'string' || !['replace', 'create'].includes(change.operation) || !sourcePath(change.path)
        || !text(change.content, limits.maxContentBytes)
        || (change.operation === 'replace' ? !digest(change.beforeHash) : change.beforeHash !== null)
        || change.beforeHash === hashCompanyChangeValue(change.content)) fail('INVALID_DRAFT');
      const folded = change.path.toLowerCase();
      if (paths.some(path => path === folded || path.startsWith(`${folded}/`) || folded.startsWith(`${path}/`))) fail('INVALID_DRAFT');
      paths.push(folded); totalBytes += Buffer.byteLength(change.content, 'utf8');
      if (totalBytes > limits.maxTotalContentBytes || containsSensitiveText(change.content)) fail('INVALID_DRAFT');
      changes.push({ operation: change.operation as 'replace' | 'create', path: change.path, beforeHash: change.beforeHash as string | null, content: change.content });
    }
    const draft: CompanyChangeDraft = { version: 'company-change-draft-v1', repoId: input.repoId, requestRevision: Number(input.requestRevision),
      objective: input.objective, baseCommit: input.baseCommit, baseBranch: input.baseBranch, baseIndexHash: input.baseIndexHash,
      workType: input.workType as CompanyChangeWorkType, branch: input.branch, changes };
    const encoded = canonical(draft);
    if (Buffer.byteLength(encoded) > limits.maxDraftJsonBytes || containsSensitiveText(encoded)) fail('INVALID_DRAFT');
    return draft;
  } catch { return fail('INVALID_DRAFT'); }
};

const planHash = (plan: Omit<CompanyChangePlan, 'planHash'>): string => hashCompanyChangeValue(canonical(plan));
export const assertCompanyChangePlan: (input: unknown) => asserts input is CompanyChangePlan = (input) => {
  try {
    if (!record(input, planKeys) || input.version !== 'company-change-review-v1' || !id(input.id) || !owner(input.ownerId)
      || !digest(input.draftHash) || !Number.isSafeInteger(input.changeCount) || Number(input.changeCount) < 1 || Number(input.changeCount) > limits.maxChanges
      || !timestamp(input.createdAt) || !timestamp(input.expiresAt) || !timestamp(input.auditExpiresAt)
      || Date.parse(input.expiresAt) - Date.parse(input.createdAt) !== limits.planLifetimeMs
      || Date.parse(input.auditExpiresAt) - Date.parse(input.createdAt) !== limits.auditLifetimeMs
      || input.limitsHash !== getCompanyChangeLimitsHash() || input.sourceVerification !== 'not_run' || input.approvalScope !== 'review-only'
      || input.executionAllowed !== false || input.transmissionAllowed !== false || !digest(input.planHash)
      || Buffer.byteLength(canonical(input)) > limits.maxPlanJsonBytes) fail('INVALID_PLAN');
    const { planHash: expected, ...content } = input;
    if (planHash(content as unknown as Omit<CompanyChangePlan, 'planHash'>) !== expected) fail('INVALID_PLAN');
  } catch { fail('INVALID_PLAN'); }
};

export const createCompanyChangePlan = (input: unknown, context: ReadonlyContext, taskId: string = randomUUID()): { plan: CompanyChangePlan; draft: CompanyChangeDraft } => {
  const createdAt = assertCompanyChangeContext(context);
  if (!id(taskId)) fail('INVALID_ID');
  const draft = parseCompanyChangeDraft(input);
  const expiry = new Date(Date.parse(createdAt) + limits.planLifetimeMs), auditExpiry = new Date(Date.parse(createdAt) + limits.auditLifetimeMs);
  if (!Number.isFinite(expiry.getTime()) || !Number.isFinite(auditExpiry.getTime())) fail('INVALID_TIME');
  const expiresAt = expiry.toISOString(), auditExpiresAt = auditExpiry.toISOString();
  if (!timestamp(expiresAt) || !timestamp(auditExpiresAt)) fail('INVALID_TIME');
  const content: Omit<CompanyChangePlan, 'planHash'> = { version: 'company-change-review-v1', id: taskId, ownerId: context.ownerId,
    draftHash: hashCompanyChangeValue(canonical(draft)), changeCount: draft.changes.length, createdAt,
    expiresAt, auditExpiresAt, limitsHash: getCompanyChangeLimitsHash(),
    sourceVerification: 'not_run', approvalScope: 'review-only', executionAllowed: false, transmissionAllowed: false };
  const plan = { ...content, planHash: planHash(content) }; assertCompanyChangePlan(plan);
  return { plan, draft };
};

export const assertCompanyChangeDraftForPlan = (plan: CompanyChangePlan, draft: unknown): void => {
  assertCompanyChangePlan(plan);
  const parsed = parseCompanyChangeDraft(draft);
  if (hashCompanyChangeValue(canonical(parsed)) !== plan.draftHash || parsed.changes.length !== plan.changeCount) fail('DRAFT_PLAN_MISMATCH');
};

export const assertCompanyChangeApprovalRequest: (input: unknown) => asserts input is CompanyChangeApprovalRequest = (input) => {
  try {
    if (!record(input, ['taskId', 'planHash', 'expiresInMinutes']) || !id(input.taskId) || !digest(input.planHash)
      || !Number.isInteger(input.expiresInMinutes) || Number(input.expiresInMinutes) < limits.minApprovalMinutes
      || Number(input.expiresInMinutes) > limits.maxApprovalMinutes) fail('INVALID_APPROVAL');
  } catch { fail('INVALID_APPROVAL'); }
};

export const assertCompanyChangeApproval: (plan: CompanyChangePlan, input: unknown) => asserts input is CompanyChangeApproval = (plan, input) => {
  assertCompanyChangePlan(plan);
  try {
    if (!record(input, approvalKeys) || !id(input.id) || input.taskId !== plan.id || input.ownerId !== plan.ownerId || input.planHash !== plan.planHash
      || !timestamp(input.createdAt) || !timestamp(input.expiresAt) || input.createdAt < plan.createdAt || input.createdAt >= plan.expiresAt
      || input.expiresAt > plan.expiresAt || Date.parse(input.expiresAt) - Date.parse(input.createdAt) < limits.minApprovalMinutes * 60_000
      || Date.parse(input.expiresAt) - Date.parse(input.createdAt) > limits.maxApprovalMinutes * 60_000
      || (Date.parse(input.expiresAt) - Date.parse(input.createdAt)) % 60_000 !== 0
      || input.revokedAt !== null && (!timestamp(input.revokedAt) || input.revokedAt < input.createdAt || input.revokedAt > plan.auditExpiresAt)
      || input.usedAt !== null || input.scope !== 'review-only' || input.executionAllowed !== false) fail('INVALID_APPROVAL');
  } catch { fail('INVALID_APPROVAL'); }
};
