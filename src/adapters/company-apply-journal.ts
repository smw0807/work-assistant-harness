import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { CompanyApplyApproval, CompanyApplyPlan } from '../domain/company-apply.js';
import { HarnessError } from '../domain/errors.js';
import { assertCompanyApplyApproval, assertCompanyApplyContext, assertCompanyApplyPlan,
  copyCompanyApplyData, hashCompanyApplyValue } from '../policy/company-apply.js';
import { canonicalReadonlyJson, readonlyExactKeys } from '../policy/readonly-investigation-policy.js';

const maximumBytes = 32_768;
const fail = (suffix: string): never => { throw new HarnessError(`COMPANY_APPLY_${suffix}`); };
const identity = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
  && a.uid === b.uid && a.gid === b.gid && (a.isDirectory() || a.nlink === b.nlink);
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export interface CompanyApplyClaim {
  version: 'company-apply-claim-v1';
  locationHash: string;
  plan: CompanyApplyPlan;
  approval: CompanyApplyApproval;
}
export interface CompanyApplyJournalEntry {
  sequence: number;
  kind: 'branch' | 'file' | 'result';
  path: string | null;
  state: 'INTENT' | 'DONE' | 'APPLIED' | 'FAILED';
  at: string;
  previousHash: string;
  entryHash: string;
}
export interface CompanyApplyObservation {
  status: 'CLAIMED' | 'INTERRUPTED' | 'APPLIED' | 'FAILED';
  approvalConsumed: true;
  taskId: string;
  planHash: string;
  journal: CompanyApplyJournalEntry[];
}

/** Metadata-only private storage. A surviving claim is never replaced, resumed or automatically removed. */
export const assertCompanyApplyPrivateDirectory = async (directory: string): Promise<Stats> => {
  if (!isAbsolute(directory) || resolve(directory) !== directory) return fail('UNSAFE_STORAGE');
  const initial = await lstat(directory);
  if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== process.getuid?.()
    || (initial.mode & 0o7777) !== 0o700 || await realpath(directory) !== directory) return fail('UNSAFE_STORAGE');
  for (let path = dirname(directory); ; path = dirname(path)) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(path) !== path) return fail('UNSAFE_STORAGE');
    if (path === dirname(path)) break;
  }
  return initial;
};
const safeMetadata = (metadata: Stats): void => {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o7777) !== 0o600 || metadata.size > maximumBytes) fail('UNSAFE_STORAGE');
};
export const readCompanyApplyPrivateFile = async (path: string): Promise<string> => {
  if (!isAbsolute(path) || resolve(path) !== path || !/^[a-z][a-z-]{0,40}\.(?:json|jsonl)$/u.test(basename(path))) fail('UNSAFE_STORAGE');
  const parent = await assertCompanyApplyPrivateDirectory(dirname(path));
  const before = await lstat(path); safeMetadata(before);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat(); safeMetadata(opened);
    if (!identity(before, opened)) fail('STORAGE_CHANGED');
    const bytes = Buffer.alloc(maximumBytes + 1); const result = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (result.bytesRead !== before.size || !identity(after, before) || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !identity(await lstat(path), before) || !identity(parent, await lstat(dirname(path)))) fail('STORAGE_CHANGED');
    const text = bytes.subarray(0, result.bytesRead).toString('utf8');
    if (!Buffer.from(text).equals(bytes.subarray(0, result.bytesRead))) fail('INVALID_JOURNAL');
    return text;
  } finally { await handle.close(); }
};
export const writeCompanyApplyPrivateFile = async (directory: string, name: string, value: unknown): Promise<void> => {
  if (!/^[a-z][a-z-]{0,40}\.(?:json|jsonl)$/u.test(name)) fail('UNSAFE_STORAGE');
  const content = typeof value === 'string' ? value : `${canonicalReadonlyJson(value)}\n`;
  if (Buffer.byteLength(content) > maximumBytes) fail('INVALID_JOURNAL');
  const parent = await assertCompanyApplyPrivateDirectory(directory);
  const handle = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    safeMetadata(await handle.stat()); await handle.writeFile(content); await handle.sync();
    if (!identity(parent, await lstat(directory))) fail('STORAGE_CHANGED');
  } finally { await handle.close(); }
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
};

export const claimCompanyApply = async (directory: string, plan: CompanyApplyPlan,
  approval: CompanyApplyApproval, now = new Date()): Promise<CompanyApplyClaim> => {
  assertCompanyApplyPlan(plan); assertCompanyApplyApproval(plan, approval);
  plan = copyCompanyApplyData(plan); approval = copyCompanyApplyData(approval);
  const at = assertCompanyApplyContext({ ownerId: plan.ownerId, now });
  if (approval.usedAt !== null || at < approval.createdAt || at >= approval.expiresAt) fail('APPROVAL_UNAVAILABLE');
  const claim: CompanyApplyClaim = { version: 'company-apply-claim-v1', locationHash: hashCompanyApplyValue(directory),
    plan, approval: { ...approval, usedAt: at } };
  // Claim is durable before creating the journal or starting any source mutation. Failure burns this approval.
  await writeCompanyApplyPrivateFile(directory, 'claim.json', claim);
  await writeCompanyApplyPrivateFile(directory, 'journal.jsonl', '');
  return claim;
};
export const readCompanyApplyClaim = async (directory: string): Promise<CompanyApplyClaim> => {
  await assertCompanyApplyPrivateDirectory(directory);
  let value: unknown; const text = await readCompanyApplyPrivateFile(join(directory, 'claim.json'));
  try { value = JSON.parse(text); } catch { return fail('INVALID_CLAIM'); }
  if (!readonlyExactKeys(value, ['version', 'locationHash', 'plan', 'approval'])) return fail('INVALID_CLAIM');
  const claim = value as unknown as CompanyApplyClaim;
  if (claim.version !== 'company-apply-claim-v1' || claim.locationHash !== hashCompanyApplyValue(directory)
    || text !== `${canonicalReadonlyJson(claim)}\n`) fail('INVALID_CLAIM');
  assertCompanyApplyPlan(claim.plan); assertCompanyApplyApproval(claim.plan, claim.approval);
  assertCompanyApplyContext({ ownerId: claim.plan.ownerId, now: new Date() });
  if (claim.approval.usedAt === null) fail('INVALID_CLAIM');
  return claim;
};

const validateEntries = (claim: CompanyApplyClaim, entries: CompanyApplyJournalEntry[]): void => {
  const maximum = 2 * (claim.plan.changes.length + 1);
  if (entries.length > maximum + 1) fail('INVALID_JOURNAL');
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!readonlyExactKeys(entry, ['sequence', 'kind', 'path', 'state', 'at', 'previousHash', 'entryHash'])
      || entry.sequence !== index || !timestamp(entry.at) || entry.at < claim.approval.usedAt!
      || index > 0 && entry.at < entries[index - 1]!.at
      || entry.previousHash !== (index === 0 ? hashCompanyApplyValue(canonicalReadonlyJson(claim)) : entries[index - 1]!.entryHash)) fail('INVALID_JOURNAL');
    const { entryHash, ...content } = entry;
    if (entryHash !== hashCompanyApplyValue(canonicalReadonlyJson(content))) fail('INVALID_JOURNAL');
    if (entry.kind === 'result') {
      if (index !== entries.length - 1 || entry.path !== null || !['APPLIED', 'FAILED'].includes(entry.state)
        || entry.state === 'APPLIED' && index !== maximum) fail('INVALID_JOURNAL');
    } else {
      if (index >= maximum || entry.kind !== (index < 2 ? 'branch' : 'file')
        || entry.path !== (index < 2 ? null : claim.plan.changes[Math.floor(index / 2) - 1]!.path)
        || entry.state !== (index % 2 === 0 ? 'INTENT' : 'DONE')
        || entry.state === 'INTENT' && entry.at >= claim.approval.expiresAt) fail('INVALID_JOURNAL');
    }
  }
};
export const observeCompanyApplyJournal = async (directory: string): Promise<CompanyApplyObservation> => {
  const claim = await readCompanyApplyClaim(directory), text = await readCompanyApplyPrivateFile(join(directory, 'journal.jsonl'));
  if (text !== '' && !text.endsWith('\n')) fail('INCOMPLETE_JOURNAL');
  let entries: CompanyApplyJournalEntry[];
  try {
    entries = text === '' ? [] : text.slice(0, -1).split('\n').map(line => {
      const entry: unknown = JSON.parse(line);
      if (canonicalReadonlyJson(entry) !== line) fail('INVALID_JOURNAL');
      return entry as CompanyApplyJournalEntry;
    });
  } catch { return fail('INVALID_JOURNAL'); }
  validateEntries(claim, entries);
  const last = entries.at(-1);
  return { status: last?.kind === 'result' ? last.state as 'APPLIED' | 'FAILED' : entries.length ? 'INTERRUPTED' : 'CLAIMED',
    approvalConsumed: true, taskId: claim.plan.id, planHash: claim.plan.planHash, journal: entries };
};

/** One append writer per approval claim. A second worker fails on the exclusive marker, even after SIGKILL. */
export class CompanyApplyJournal {
  private constructor(private readonly directory: string, private readonly claim: CompanyApplyClaim,
    private readonly handle: FileHandle, private readonly initial: Stats, private readonly parent: Stats) {}
  private entries: CompanyApplyJournalEntry[] = [];
  private failed = false;

  static async open(directory: string): Promise<CompanyApplyJournal> {
    const parent = await assertCompanyApplyPrivateDirectory(directory), claim = await readCompanyApplyClaim(directory);
    const observation = await observeCompanyApplyJournal(directory);
    if (observation.journal.length) fail('ALREADY_STARTED');
    await writeCompanyApplyPrivateFile(directory, 'worker-started.json', { taskId: claim.plan.id, planHash: claim.plan.planHash });
    const file = join(directory, 'journal.jsonl'), initial = await lstat(file); safeMetadata(initial);
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      if (initial.size !== 0 || !identity(await handle.stat(), initial)) fail('STORAGE_CHANGED');
      return new CompanyApplyJournal(directory, claim, handle, initial, parent);
    } catch (error) { await handle.close(); throw error; }
  }

  async record(kind: CompanyApplyJournalEntry['kind'], path: string | null, state: CompanyApplyJournalEntry['state'], now = new Date()): Promise<void> {
    if (this.failed) fail('JOURNAL_UNAVAILABLE');
    try {
      const at = assertCompanyApplyContext({ ownerId: this.claim.plan.ownerId, now });
      const content = { sequence: this.entries.length, kind, path, state, at,
        previousHash: this.entries.at(-1)?.entryHash ?? hashCompanyApplyValue(canonicalReadonlyJson(this.claim)) };
      const entry = { ...content, entryHash: hashCompanyApplyValue(canonicalReadonlyJson(content)) };
      validateEntries(this.claim, [...this.entries, entry]);
      if (!identity(this.parent, await lstat(this.directory)) || !identity(this.initial, await this.handle.stat())
        || !identity(this.initial, await lstat(join(this.directory, 'journal.jsonl')))) fail('STORAGE_CHANGED');
      const expectedSize = this.entries.reduce((sum, value) => sum + Buffer.byteLength(canonicalReadonlyJson(value)) + 1, 0);
      if ((await this.handle.stat()).size !== expectedSize) fail('STORAGE_CHANGED');
      const line = `${canonicalReadonlyJson(entry)}\n`;
      if (expectedSize + Buffer.byteLength(line) > maximumBytes) fail('INVALID_JOURNAL');
      await this.handle.writeFile(line); await this.handle.sync();
      if (!identity(this.initial, await lstat(join(this.directory, 'journal.jsonl')))) fail('STORAGE_CHANGED');
      this.entries.push(entry);
    } catch (error) { this.failed = true; throw error; }
  }

  async close(): Promise<void> { await this.handle.close(); }
}
