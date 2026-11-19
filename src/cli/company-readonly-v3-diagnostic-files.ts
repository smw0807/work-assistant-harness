import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CompanyGitRangeUnitFailure } from '../domain/company-git-range-unit.js';
import { HarnessError } from '../domain/errors.js';
import { parseCompanyGitRangeUnitFailure } from '../policy/company-git-range-unit-diagnostic.js';
import { getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from '../policy/company-git-range-unit-budget.js';
import { canonicalReadonlyJson, hashReadonlyValue, isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import { companyDirectoryChain, companyPath, companyPathsOverlap } from './company-readonly-files.js';
import { companyV3FileExists, companyV3RuntimeHash, readCompanyV3Run, type CompanyV3Run } from './company-readonly-v3-files.js';
import type { CompanyV3WorkerOutcome } from './company-readonly-v3-supervisor.js';
import { isCompanyV3WorkerFailureCode, type CompanyV3WorkerFailureCode } from './company-readonly-v3-worker-failure.js';

interface CompanyV3DiagnosticContent {
  taskId: string;
  ownerId: string;
  gitProfileHash: string;
  guardPolicyHash: string;
  runtimeHash: string;
  diagnosticsDirectoryHash: string;
  createdAt: string;
  auditExpiresAt: string;
  reason: CompanyV3WorkerOutcome['reason'];
  exitConfirmed: boolean;
  failure: CompanyGitRangeUnitFailure | null;
  diagnosticHash: string;
}
export type CompanyV3DiagnosticRecord = CompanyV3DiagnosticContent & (
  { version: 'company-readonly-v3-diagnostic-record-v1'; workerFailureCode?: never }
  | { version: 'company-readonly-v3-diagnostic-record-v2'; workerFailureCode: CompanyV3WorkerFailureCode }
);
interface DiagnosticFile {
  path: string;
  metadata: Stats;
  record: CompanyV3DiagnosticRecord;
}
const maximumFileBytes = 8192;
const maximumFiles = 8192;
const fields = ['version', 'taskId', 'ownerId', 'gitProfileHash', 'guardPolicyHash', 'runtimeHash', 'diagnosticsDirectoryHash', 'createdAt', 'auditExpiresAt',
  'reason', 'exitConfirmed', 'failure', 'diagnosticHash'];
const reasons: readonly CompanyV3WorkerOutcome['reason'][] = ['completed', 'deadline', 'output_limit', 'worker_failed', 'invalid_output'];
const reject = (): never => { throw new HarnessError('COMPANY_READONLY_V3_UNSAFE_DIAGNOSTIC_FILE'); };
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const ownerId = (): string => `os-user:${process.getuid?.()}`;
const directoryHash = (directory: string): string =>
  hashReadonlyValue(canonicalReadonlyJson({ version: 'company-readonly-v3-diagnostics-location-v1', diagnosticsDirectory: directory, ownerId: ownerId() }));
const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
  && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

const assertDirectory = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o777) !== 0o700 || await realpath(path) !== path) reject();
};
const assertFile = async (path: string): Promise<Stats> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600
    || metadata.size > maximumFileBytes || await realpath(path) !== path) reject();
  return metadata;
};
const syncDirectory = async (path: string): Promise<void> => {
  const guard = await companyDirectoryChain(path);
  await assertDirectory(path);
  const before = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(before, await handle.stat())) reject();
    await handle.sync();
    await guard();
  } finally { await handle.close(); }
};
const diagnosticPath = (directory: string, taskId: string): string => {
  if (!isReadonlyId(taskId)) reject();
  return join(directory, `diagnostic-v3-${taskId}.json`);
};
const parseRecord = (input: unknown, directory: string, runtimeDirectory: string, taskId: string): CompanyV3DiagnosticRecord => {
  const value = input as CompanyV3DiagnosticRecord;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
  const expectedFields = value.version === 'company-readonly-v3-diagnostic-record-v2' ? [...fields, 'workerFailureCode'] : fields;
  if (Object.keys(value).length !== expectedFields.length || Object.keys(value).some(key => !expectedFields.includes(key))
    || !['company-readonly-v3-diagnostic-record-v1', 'company-readonly-v3-diagnostic-record-v2'].includes(value.version)
    || value.taskId !== taskId || !isReadonlyId(value.taskId) || value.ownerId !== ownerId()
    || value.gitProfileHash !== getCompanyGitRangeUnitProfileHash() || value.guardPolicyHash !== getCompanyGitRangeUnitGuardPolicyHash()
    || value.runtimeHash !== companyV3RuntimeHash(runtimeDirectory, value.ownerId)
    || value.diagnosticsDirectoryHash !== directoryHash(directory) || !validDate(value.createdAt) || !validDate(value.auditExpiresAt)
    || !reasons.includes(value.reason) || typeof value.exitConfirmed !== 'boolean') reject();
  if (value.failure !== null) parseCompanyGitRangeUnitFailure(value.failure);
  if (value.version === 'company-readonly-v3-diagnostic-record-v2'
    && (!isCompanyV3WorkerFailureCode(value.workerFailureCode) || value.reason !== 'worker_failed' || !value.exitConfirmed
      || value.failure !== null && value.failure.errorCode !== value.workerFailureCode)) reject();
  const { diagnosticHash, ...content } = value;
  if (typeof diagnosticHash !== 'string' || !/^[a-f0-9]{64}$/.test(diagnosticHash)
    || diagnosticHash !== hashReadonlyValue(canonicalReadonlyJson(content))) reject();
  return value;
};
const readDiagnosticFile = async (path: string, directory: string, runtimeDirectory: string, taskId: string): Promise<DiagnosticFile> => {
  const guard = await companyDirectoryChain(directory);
  await assertDirectory(directory);
  const before = await assertFile(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(before, await handle.stat())) reject();
    const bytes = Buffer.alloc(maximumFileBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== before.size || !sameFile(before, await handle.stat()) || !sameFile(before, await assertFile(path))) reject();
    await guard();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead));
    return { path, metadata: before, record: parseRecord(parseReadonlyTransportJson(text, maximumFileBytes), directory, runtimeDirectory, taskId) };
  } finally { await handle.close(); }
};

/** Keep the optional diagnostic store separate from the existing runtime layout and bind every record to both locations. */
const inspectDirectory = async (directory: string, runtimeDirectory: string, create: boolean): Promise<DiagnosticFile[]> => {
  companyPath(directory); companyPath(runtimeDirectory);
  if (companyPathsOverlap(directory, runtimeDirectory)) reject();
  const parentGuard = await companyDirectoryChain(dirname(directory));
  await assertDirectory(dirname(directory));
  const runtimeGuard = await companyDirectoryChain(dirname(runtimeDirectory));
  await assertDirectory(dirname(runtimeDirectory));
  let runtimeDirectoryGuard: (() => Promise<void>) | null = null;
  if (await companyV3FileExists(runtimeDirectory)) {
    await assertDirectory(runtimeDirectory);
    runtimeDirectoryGuard = await companyDirectoryChain(runtimeDirectory);
  }
  if (!await companyV3FileExists(directory)) {
    if (!create) reject();
    await parentGuard(); await runtimeGuard();
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(dirname(directory));
  }
  await assertDirectory(directory);
  const guard = await companyDirectoryChain(directory);
  const names: string[] = [];
  // Streaming enumeration bounds memory even when the directory contains many foreign entries.
  for await (const entry of await opendir(directory, { bufferSize: 32 })) {
    if (names.length >= maximumFiles || !/^diagnostic-v3-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(entry.name)) reject();
    names.push(entry.name);
  }
  await guard();
  const files: DiagnosticFile[] = [];
  for (const name of names.sort()) {
    const taskId = name.slice('diagnostic-v3-'.length, -'.json'.length);
    files.push(await readDiagnosticFile(join(directory, name), directory, runtimeDirectory, taskId));
  }
  await guard(); await parentGuard(); await runtimeGuard();
  if (runtimeDirectoryGuard) await runtimeDirectoryGuard();
  return files;
};

export const prepCompanyV3DiagnosticsDirectory = async (directory: string, runtimeDirectory: string, create: boolean): Promise<void> => {
  try { await inspectDirectory(directory, runtimeDirectory, create); } catch { return reject(); }
};
export const readCompanyV3Diagnostic = async (directory: string, runtimeDirectory: string, taskId: string): Promise<CompanyV3DiagnosticRecord> => {
  try {
    diagnosticPath(directory, taskId);
    const files = await inspectDirectory(directory, runtimeDirectory, false);
    const file = files.find(item => item.record.taskId === taskId);
    if (!file) return reject();
    return file.record;
  } catch { return reject(); }
};
export const writeCompanyV3Diagnostic = async (directory: string, runtimeDirectory: string, run: CompanyV3Run,
  outcome: Pick<CompanyV3WorkerOutcome, 'reason' | 'exitConfirmed' | 'workerFailureCode'>, failure: CompanyGitRangeUnitFailure | null): Promise<void> => {
  try {
    const files = await inspectDirectory(directory, runtimeDirectory, false);
    if (files.length >= maximumFiles) reject();
    const storedRun = await readCompanyV3Run(runtimeDirectory, run.taskId);
    if (canonicalReadonlyJson(storedRun) !== canonicalReadonlyJson(run)) reject();
    const workerFields = Object.hasOwn(outcome, 'workerFailureCode')
      ? { version: 'company-readonly-v3-diagnostic-record-v2' as const, workerFailureCode: outcome.workerFailureCode }
      : { version: 'company-readonly-v3-diagnostic-record-v1' as const };
    const content = {
      ...workerFields, taskId: run.taskId, ownerId: run.ownerId,
      gitProfileHash: run.gitProfileHash, guardPolicyHash: run.guardPolicyHash,
      runtimeHash: run.runtimeHash, diagnosticsDirectoryHash: directoryHash(directory), createdAt: new Date().toISOString(),
      auditExpiresAt: run.auditExpiresAt, reason: outcome.reason, exitConfirmed: outcome.exitConfirmed,
      failure: failure === null ? null : parseCompanyGitRangeUnitFailure(failure),
    };
    const record = { ...content, diagnosticHash: hashReadonlyValue(canonicalReadonlyJson(content)) };
    parseRecord(record, directory, runtimeDirectory, run.taskId);
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (bytes.length > maximumFileBytes) reject();
    const path = diagnosticPath(directory, run.taskId);
    const guard = await companyDirectoryChain(directory);
    await assertDirectory(directory);
    for (const file of files) if (!sameFile(file.metadata, await assertFile(file.path))) reject();
    await guard();
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes); await handle.sync();
      if (!sameFile(await handle.stat(), await assertFile(path))) reject();
      await guard();
    } finally { await handle.close(); }
    await syncDirectory(directory);
    await guard();
  } catch { return reject(); }
};
export const pruneCompanyV3Diagnostics = async (directory: string, runtimeDirectory: string, now: Date): Promise<number> => {
  try {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) reject();
    const files = await inspectDirectory(directory, runtimeDirectory, false);
    const guard = await companyDirectoryChain(directory);
    let removed = 0;
    // Validate the whole collection before removing even an expired record.
    for (const file of files) if (!sameFile(file.metadata, await assertFile(file.path))) reject();
    for (const file of files) {
      if (Date.parse(file.record.auditExpiresAt) > now.getTime()) continue;
      await guard();
      if (!sameFile(file.metadata, await assertFile(file.path))) reject();
      await unlink(file.path);
      removed += 1;
    }
    if (removed > 0) await syncDirectory(directory);
    await guard();
    return removed;
  } catch { return reject(); }
};
