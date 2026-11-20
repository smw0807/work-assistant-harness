import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createSyntheticCompanyChangeWorkspace, SYNTHETIC_COMPANY_CHANGE_FILES } from '../adapters/synthetic-company-change-workspace.js';
import { deriveCompanyWriteMutationPaths, inspectCompanyWriteSource } from '../adapters/company-write-workspace.js';
import { runIsolatedCompanyWriteWorker } from '../adapters/company-write-isolation.js';
import { assertCompanyWritePrivateDirectory, claimCompanyWrite, observeCompanyWriteJournal,
  writeCompanyWritePrivateFile } from '../adapters/company-write-journal.js';
import type { CompanyChangeDraft } from '../domain/company-change.js';
import type { CompanyWriteRegistration } from '../domain/company-write.js';
import { HarnessError } from '../domain/errors.js';
import { createCompanyWriteApproval, createCompanyWritePlan, hashCompanyWriteValue } from '../policy/company-write.js';
import { canonicalReadonlyJson, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';

export interface CompanyWriteCheckResult {
  version: 'company-write-check-v1';
  status: 'passed' | 'failed';
  scope: 'synthetic-validation';
  taskId: string;
  planHash: string;
  osIsolation: boolean;
  branchBeforeFiles: boolean;
  selectedFilesMatch: boolean;
  indexPreserved: boolean;
  baseRefPreserved: boolean;
  unselectedFilePreserved: boolean;
  approvalConsumed: boolean;
  journalEntries: number;
  actualCompanyAccess: false;
  actualCredentials: false;
  nativeCodex: false;
  modelCalls: 0;
  productChecks: 'not_run';
}

/** The only new execution CLI creates its own fixture; it accepts neither sourceRoot nor external draft/approval. */
export const checkCompanyWrite = async (directory: string): Promise<CompanyWriteCheckResult> => {
  if (process.platform !== 'darwin') throw new HarnessError('COMPANY_WRITE_ISOLATION_UNSUPPORTED');
  if (!isAbsolute(directory) || resolve(directory) !== directory || !directory.startsWith('/private/tmp/')
    || [...directory].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new HarnessError('COMPANY_WRITE_UNSAFE_STORAGE');
  await assertCompanyWritePrivateDirectory(dirname(directory));
  await mkdir(directory, { mode: 0o700 });
  const workspace = await createSyntheticCompanyChangeWorkspace(directory), repository = workspace.repositoryRoot;
  const registration: CompanyWriteRegistration = { version: 'company-write-registration-v1', repoId: 'synthetic-company-change',
    sourceRoot: repository, baseBranch: 'main', baseCommit: workspace.baseCommit, baseIndexHash: workspace.baseIndexHash,
    writeAllowedFiles: ['src/message.ts', 'src/options.ts', 'src/added.ts'], enabled: true, localRead: 'allowed', localWrite: 'allowed' };
  const draft: CompanyChangeDraft = { version: 'company-change-draft-v1', repoId: registration.repoId,
    requestRevision: 1, objective: 'Verify isolated changes using only freshly created synthetic files.',
    baseCommit: registration.baseCommit, baseBranch: registration.baseBranch, baseIndexHash: registration.baseIndexHash,
    workType: 'feature', branch: 'feature/isolated-synthetic-change', changes: [
      { operation: 'replace', path: 'src/message.ts', beforeHash: hashCompanyWriteValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']!),
        content: "export const message = 'isolated synthetic result';\n" },
      { operation: 'replace', path: 'src/options.ts', beforeHash: hashCompanyWriteValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']!),
        content: 'export const options = { enabled: true };\n' },
      { operation: 'create', path: 'src/added.ts', beforeHash: null, content: 'export const isolated = true;\n' },
    ] };
  const unselectedHash = hashCompanyWriteValue(await readFile(join(repository, 'README.md')));
  const context = () => ({ ownerId: `os-user:${process.getuid!()}`, now: new Date() });
  const { plan } = createCompanyWritePlan(draft, registration, await inspectCompanyWriteSource(registration, draft), context());
  const approval = createCompanyWriteApproval(plan, { taskId: plan.id, planHash: plan.planHash, expiresInMinutes: 1 }, context());
  await writeCompanyWritePrivateFile(directory, 'registration.json', registration);
  await writeCompanyWritePrivateFile(directory, 'draft.json', draft);
  await writeCompanyWritePrivateFile(directory, 'plan.json', plan);
  await writeCompanyWritePrivateFile(directory, 'approval.json', approval);
  const journalDirectory = join(directory, 'execution'); await mkdir(journalDirectory, { mode: 0o700 });
  await claimCompanyWrite(journalDirectory, plan, approval);
  const paths = deriveCompanyWriteMutationPaths(registration, draft, plan.id);
  let output: unknown = null;
  try {
    const text = await runIsolatedCompanyWriteWorker({ repositoryRoot: repository,
      readPaths: [...paths.readPaths, ...paths.readDirectories, journalDirectory, join(journalDirectory, 'claim.json'), join(journalDirectory, 'journal.jsonl')],
      writePaths: [...paths.writePaths, join(journalDirectory, 'journal.jsonl'), join(journalDirectory, 'worker-started.json')],
      metadataPaths: [...paths.metadataPaths, join(journalDirectory, 'worker-started.json')],
      input: canonicalReadonlyJson({ version: 'company-write-worker-v1', registration, draft, journalDirectory }) });
    output = JSON.parse(text);
  } catch { /* Read durable evidence after confirmed worker close; never retry an uncertain operation. */ }
  const observation = await observeCompanyWriteJournal(journalDirectory);
  const expectedKeys = ['status', 'taskId', 'planHash', 'approvalConsumed', 'journalEntries', 'osIsolation', 'scope'];
  const summary = readonlyExactKeys(output, expectedKeys) ? output as Record<string, unknown> : null;
  const workerSucceeded = summary?.status === 'APPLIED' && summary.taskId === plan.id
    && summary.planHash === plan.planHash && summary.approvalConsumed === true && summary.journalEntries === observation.journal.length
    && summary.osIsolation === true && summary.scope === 'synthetic-validation';
  const fileHashes = await Promise.all(draft.changes.map(async change => {
    try { return hashCompanyWriteValue(await readFile(join(repository, change.path))) === hashCompanyWriteValue(change.content); }
    catch { return false; }
  }));
  const readHash = async (path: string): Promise<string | null> => {
    try { return hashCompanyWriteValue(await readFile(join(repository, path))); } catch { return null; }
  };
  const result: CompanyWriteCheckResult = {
    version: 'company-write-check-v1', status: 'failed', scope: 'synthetic-validation', taskId: plan.id, planHash: plan.planHash,
    osIsolation: workerSucceeded, branchBeforeFiles: observation.journal[0]?.kind === 'branch' && observation.journal[1]?.state === 'DONE'
      && await readHash('.git/HEAD') === hashCompanyWriteValue(`ref: refs/heads/${draft.branch}\n`),
    selectedFilesMatch: fileHashes.every(Boolean), indexPreserved: await readHash('.git/index') === registration.baseIndexHash,
    baseRefPreserved: await readHash('.git/refs/heads/main') === hashCompanyWriteValue(`${registration.baseCommit}\n`),
    unselectedFilePreserved: await readHash('README.md') === unselectedHash, approvalConsumed: observation.approvalConsumed,
    journalEntries: observation.journal.length, actualCompanyAccess: false, actualCredentials: false, nativeCodex: false,
    modelCalls: 0, productChecks: 'not_run',
  };
  if (workerSucceeded && observation.status === 'APPLIED' && result.branchBeforeFiles && result.selectedFilesMatch
    && result.indexPreserved && result.baseRefPreserved && result.unselectedFilePreserved) result.status = 'passed';
  await writeCompanyWritePrivateFile(directory, 'result.json', result);
  return result;
};
