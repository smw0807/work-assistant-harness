import { lstat, mkdir, opendir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompanyChangeDraft } from '../domain/company-change.js';
import type { CompanyApplyApproval, CompanyApplyPlan, CompanyApplyRegistration } from '../domain/company-apply.js';
import type { ReadonlyContext } from '../domain/readonly-investigation.js';
import { HarnessError } from '../domain/errors.js';
import { assertCompanyApplyPrivateDirectory, claimCompanyApply, observeCompanyApplyJournal, readCompanyApplyClaim,
  readCompanyApplyPrivateFile, writeCompanyApplyPrivateFile } from '../adapters/company-apply-journal.js';
import { deriveCompanyApplyMutationPaths, inspectCompanyApplySource } from '../adapters/company-apply-workspace.js';
import { companyApplySandboxProfile, runIsolatedCompanyApplyWorker } from '../adapters/company-apply-isolation.js';
import { assertCompanyApplyApproval, assertCompanyApplyApprovalRequest, assertCompanyApplyContext,
  assertCompanyApplyDraftForPlan, assertCompanyApplyPlan, assertCompanyApplyRequest, assertCompanyApplyTaskId,
  createCompanyApplyApproval, createCompanyApplyPlan, getCompanyApplyLimits, hashCompanyApplyValue, parseCompanyApplyDraft,
  parseCompanyApplyRegistration } from '../policy/company-apply.js';
import { canonicalReadonlyJson, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';

export type CompanyApplyStatus = 'AWAITING_APPROVAL' | 'APPROVED' | 'APPLYING' | 'APPLIED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'UNKNOWN';
export interface CompanyApplySummary {
  version: 'company-apply-summary-v1'; taskId: string; planHash: string; status: CompanyApplyStatus;
  changeCount: number; approvalConsumed: boolean; checks: 'not_run'; transmissionAllowed: false;
}
interface ContextRequest { directory: string; context: ReadonlyContext }
interface TaskRequest extends ContextRequest { taskId: string }
interface SourceRequest extends ContextRequest { registration: unknown; draft: unknown }
interface RunRequest extends SourceRequest { taskId: string; planHash: string }
interface ApproveRequest extends RunRequest { expiresInMinutes: number }
interface Stored { path: string; plan: CompanyApplyPlan; approval: CompanyApplyApproval | null; summary: CompanyApplySummary }
const limits = getCompanyApplyLimits();
const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fail = (suffix: string): never => { throw new HarnessError(`COMPANY_APPLY_${suffix}`); };
const current = (): ReadonlyContext => ({ ownerId: `os-user:${process.getuid!()}`, now: new Date() });
const overlaps = (left: string, right: string): boolean => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
};
const decode = async (path: string): Promise<unknown> => {
  const text = await readCompanyApplyPrivateFile(path);
  try { const value: unknown = JSON.parse(text); if (`${canonicalReadonlyJson(value)}\n` !== text) fail('INVALID_STORE'); return value; }
  catch { return fail('INVALID_STORE'); }
};
const assertStorage = async (request: ContextRequest): Promise<void> => {
  assertCompanyApplyContext(request.context);
  await assertCompanyApplyPrivateDirectory(request.directory);
  await assertCompanyApplyPrivateDirectory(join(request.directory, 'tasks'));
  if (overlaps(request.directory, harnessRoot)) fail('OVERLAPPING_PATHS');
};
const readSourceInput = (request: SourceRequest): { registration: CompanyApplyRegistration; draft: CompanyChangeDraft } => {
  assertCompanyApplyContext(request.context);
  const registration = parseCompanyApplyRegistration(request.registration), draft = parseCompanyApplyDraft(request.draft, registration);
  if (overlaps(registration.sourceRoot, request.directory) || overlaps(registration.sourceRoot, harnessRoot)) fail('OVERLAPPING_PATHS');
  return { registration, draft };
};
const load = async (request: TaskRequest): Promise<Stored> => {
  assertCompanyApplyTaskId(request.taskId); await assertStorage(request);
  const path = join(request.directory, 'tasks', request.taskId); await assertCompanyApplyPrivateDirectory(path);
  const value = await decode(join(path, 'plan.json')); assertCompanyApplyPlan(value);
  const plan = value;
  if (plan.id !== request.taskId || plan.ownerId !== request.context.ownerId) fail('OWNER_MISMATCH');
  const binding = await decode(join(path, 'binding.json'));
  const expectedBinding = { version: 'company-apply-storage-v1', taskId: plan.id, planHash: plan.planHash,
    locationHash: hashCompanyApplyValue(path) };
  if (canonicalReadonlyJson(binding) !== canonicalReadonlyJson(expectedBinding)) fail('STORAGE_CHANGED');
  const now = assertCompanyApplyContext(request.context);
  if (now < plan.createdAt) fail('INVALID_TIME');
  let approval: CompanyApplyApproval | null = null;
  if (await exists(join(path, 'approval.json'))) {
    const value = await decode(join(path, 'approval.json')); assertCompanyApplyApproval(plan, value); approval = value;
    if (approval.usedAt !== null || now < approval.createdAt) fail('INVALID_STORE');
  }
  const summary: CompanyApplySummary = { version: 'company-apply-summary-v1', taskId: plan.id, planHash: plan.planHash,
    status: approval ? 'APPROVED' : 'AWAITING_APPROVAL', changeCount: plan.changes.length,
    approvalConsumed: false, checks: 'not_run', transmissionAllowed: false };
  const execution = join(path, 'execution'); await assertCompanyApplyPrivateDirectory(execution);
  const cancelled = await exists(join(path, 'cancelled.json'));
  if (await exists(join(execution, 'claim.json'))) {
    summary.approvalConsumed = true; summary.status = 'UNKNOWN';
    try {
      const claim = await readCompanyApplyClaim(execution), observation = await observeCompanyApplyJournal(execution);
      if (cancelled || !approval || canonicalReadonlyJson(claim.plan) !== canonicalReadonlyJson(plan)
        || canonicalReadonlyJson({ ...claim.approval, usedAt: null }) !== canonicalReadonlyJson(approval)) fail('INVALID_STORE');
      if (observation.status === 'APPLIED' || observation.status === 'FAILED') summary.status = observation.status;
    } catch { /* A partial/corrupt claim or journal is uncertain, never an unused approval. */ }
  } else {
    if (await exists(join(execution, 'worker-started.json')) || await exists(join(execution, 'journal.jsonl'))) fail('INVALID_STORE');
    if (cancelled) {
      const value = await decode(join(path, 'cancelled.json'));
      if (!readonlyExactKeys(value, ['taskId', 'planHash', 'ownerId', 'at'])) fail('INVALID_STORE');
      const record = value as Record<string, unknown>;
      if (record.taskId !== plan.id || record.planHash !== plan.planHash || record.ownerId !== plan.ownerId
        || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at)) || new Date(record.at).toISOString() !== record.at
        || record.at < plan.createdAt || record.at > now) fail('INVALID_STORE');
      summary.status = 'CANCELLED';
    } else if (now >= plan.expiresAt || approval && now >= approval.expiresAt) summary.status = 'EXPIRED';
  }
  return { path, plan, approval, summary };
};
const assertSource = async (plan: CompanyApplyPlan, registration: CompanyApplyRegistration, draft: CompanyChangeDraft) => {
  assertCompanyApplyDraftForPlan(plan, draft, registration);
  const observation = await inspectCompanyApplySource(registration, draft);
  if (canonicalReadonlyJson(observation.source) !== canonicalReadonlyJson(plan.source)) fail('SOURCE_CHANGED');
  return observation;
};
export const inspectCompanyApply = async (request: TaskRequest): Promise<CompanyApplySummary> => (await load(request)).summary;

/** The caller serializes lifecycle operations with the private runtime control lease. */
export const planCompanyApply = async (request: SourceRequest): Promise<CompanyApplySummary> => {
  const { registration, draft } = readSourceInput(request); await assertStorage(request);
  const tasks = join(request.directory, 'tasks'); let count = 0;
  const entries = await opendir(tasks);
  for await (const entry of entries) {
    if (!entry.isDirectory() || ++count >= limits.maxTaskDirectories) fail('TASK_LIMIT');
    assertCompanyApplyTaskId(entry.name);
  }
  const observation = await inspectCompanyApplySource(registration, draft);
  const { plan } = createCompanyApplyPlan(draft, registration, observation.source, current());
  const path = join(tasks, plan.id); await mkdir(path, { mode: 0o700 });
  await mkdir(join(path, 'execution'), { mode: 0o700 });
  await writeCompanyApplyPrivateFile(path, 'plan.json', plan);
  await writeCompanyApplyPrivateFile(path, 'binding.json', { version: 'company-apply-storage-v1', taskId: plan.id,
    planHash: plan.planHash, locationHash: hashCompanyApplyValue(path) });
  return inspectCompanyApply({ directory: request.directory, taskId: plan.id, context: current() });
};

export const approveCompanyApply = async (request: ApproveRequest): Promise<CompanyApplySummary> => {
  const approvalRequest = { taskId: request.taskId, planHash: request.planHash, expiresInMinutes: request.expiresInMinutes };
  assertCompanyApplyApprovalRequest(approvalRequest);
  const { registration, draft } = readSourceInput(request), stored = await load(request);
  if (stored.plan.planHash !== request.planHash) fail('PLAN_MISMATCH');
  if (!['AWAITING_APPROVAL', 'APPROVED'].includes(stored.summary.status)) fail('APPROVAL_UNAVAILABLE');
  await assertSource(stored.plan, registration, draft);
  if (stored.approval) {
    if (Date.parse(stored.approval.expiresAt) - Date.parse(stored.approval.createdAt) !== request.expiresInMinutes * 60_000) fail('ALREADY_APPROVED');
  } else {
    const approval = createCompanyApplyApproval(stored.plan, approvalRequest, current());
    await writeCompanyApplyPrivateFile(stored.path, 'approval.json', approval);
  }
  return inspectCompanyApply({ ...request, context: current() });
};

export const cancelCompanyApply = async (request: TaskRequest): Promise<CompanyApplySummary> => {
  const stored = await load(request);
  if (stored.summary.status === 'CANCELLED' || stored.summary.status === 'EXPIRED') return stored.summary;
  if (stored.summary.approvalConsumed) fail('ALREADY_STARTED');
  await writeCompanyApplyPrivateFile(stored.path, 'cancelled.json', { taskId: stored.plan.id, planHash: stored.plan.planHash,
    ownerId: stored.plan.ownerId, at: assertCompanyApplyContext(current()) });
  return inspectCompanyApply({ ...request, context: current() });
};

export const runCompanyApply = async (request: RunRequest): Promise<CompanyApplySummary> => {
  assertCompanyApplyRequest({ taskId: request.taskId, planHash: request.planHash });
  const { registration, draft } = readSourceInput(request), stored = await load(request);
  if (stored.plan.planHash !== request.planHash) fail('PLAN_MISMATCH');
  if (stored.summary.status !== 'APPROVED' || !stored.approval) fail('APPROVAL_UNAVAILABLE');
  const deadline = Date.now() + limits.workerWallTimeMs, abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), limits.workerWallTimeMs);
  const assertLive = (): void => {
    const now = new Date().toISOString();
    if (Date.now() >= deadline || abort.signal.aborted) fail('WORKER_TIMEOUT');
    if (now < stored.approval!.createdAt || now >= stored.approval!.expiresAt) fail('APPROVAL_UNAVAILABLE');
  };
  try {
    const observed = await assertSource(stored.plan, registration, draft); assertLive();
    const paths = deriveCompanyApplyMutationPaths(registration, draft, stored.plan.id), execution = join(stored.path, 'execution');
    const unique = (values: string[]): string[] => [...new Set(values)];
    const isolation = { repositoryRoot: registration.sourceRoot,
      readPaths: unique([...paths.readPaths, ...paths.readDirectories, ...observed.readPaths, ...observed.readDirectories,
        execution, join(execution, 'claim.json'), join(execution, 'journal.jsonl')]),
      writePaths: unique([...paths.writePaths, join(execution, 'journal.jsonl'), join(execution, 'worker-started.json')]),
      metadataPaths: unique([...paths.metadataPaths, ...observed.metadataPaths, join(execution, 'worker-started.json')]) };
    companyApplySandboxProfile(isolation);
    const canary = join(stored.path, 'isolation-canary.json');
    if (!await exists(canary)) await writeCompanyApplyPrivateFile(stored.path, 'isolation-canary.json', { syntheticCanary: true });
    const probe = await runIsolatedCompanyApplyWorker({ ...isolation, signal: abort.signal,
      input: canonicalReadonlyJson({ version: 'company-apply-probe-v1', canary }) });
    if (probe !== '{"isolationVerified":true}\n') fail('ISOLATION_FAILED');
    assertLive();
    // A failed preflight never consumes approval. The child re-proves the exact Git/source baseline after this durable claim.
    await claimCompanyApply(execution, stored.plan, stored.approval!);
    try {
      await runIsolatedCompanyApplyWorker({ ...isolation, signal: abort.signal,
        input: canonicalReadonlyJson({ version: 'company-apply-worker-v1', registration, draft, journalDirectory: execution }) });
    } catch { /* Confirmed close may leave complete evidence or UNKNOWN; never retry a consumed claim. */ }
    return inspectCompanyApply({ ...request, context: current() });
  } finally { clearTimeout(timer); }
};
