import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import { getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from '../policy/company-git-range-unit-budget.js';
import { canonicalReadonlyJson, hashReadonlyValue, isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import { companyDirectoryChain, companyPath } from './company-readonly-files.js';

export interface CompanyV3Run {
  version: 'company-readonly-v3-run-v1';
  taskId: string;
  ownerId: string;
  startedAt: string;
  auditExpiresAt: string;
  gitProfileHash: string;
  guardPolicyHash: string;
  registrationHash: string;
  policyHash: string;
  runtimeHash: string;
}
export interface CompanyV3RunResult {
  version: 'company-readonly-v3-run-result-v1';
  taskId: string;
  status: 'succeeded' | 'unknown';
  planHash: string | null;
  endedAt: string;
  exitConfirmed: boolean;
}
const reject = (): never => { throw new HarnessError('COMPANY_READONLY_V3_UNSAFE_PRIVATE_FILE'); };
const hash = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const companyV3RuntimeHash = (root: string, ownerId: string): string =>
  hashReadonlyValue(canonicalReadonlyJson({ version: 'company-readonly-v3-runtime-v1', runtimeDirectory: root, ownerId,
    gitProfileHash: getCompanyGitRangeUnitProfileHash(), guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash() }));
const same = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.size === right.size
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
const assertDirectory = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o777) !== 0o700 || await realpath(path) !== path) reject();
};
const assertFile = async (path: string): Promise<Stats> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o777) !== 0o600 || await realpath(path) !== path) reject();
  return metadata;
};
export const companyV3FileExists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
};
const ensureDirectory = async (path: string, create: boolean): Promise<void> => {
  if (!await companyV3FileExists(path)) {
    if (!create) reject();
    await mkdir(path, { mode: 0o700 });
  }
  await assertDirectory(path);
};

/** The child can write only store/, never the parent's durable start and result records in runs/. */
export const prepareCompanyV3Directory = async (path: string, create: boolean): Promise<void> => {
  companyPath(path);
  const parentGuard = await companyDirectoryChain(dirname(path));
  await assertDirectory(dirname(path));
  await ensureDirectory(path, create);
  const guard = await companyDirectoryChain(path);
  const rootEntries = await readdir(path);
  if (rootEntries.some(name => !['store', 'runs'].includes(name))) reject();
  // A partially moved runtime must be rejected before creating any missing child directory.
  for (const directory of ['store', 'runs']) await ensureDirectory(join(path, directory), create && rootEntries.length === 0);
  const dbNames = ['company-readonly-v3.sqlite', 'company-readonly-v3.sqlite-journal', 'company-readonly-v3.sqlite-wal', 'company-readonly-v3.sqlite-shm'];
  for (const directory of ['store', 'runs']) {
    const entries = await readdir(join(path, directory));
    if (entries.length > 8192) reject();
    for (const name of entries) {
      if (directory === 'store' ? !dbNames.includes(name) : !/^(run|result)-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(name)) reject();
      await assertFile(join(path, directory, name));
      if (directory === 'runs') {
        const id = name.slice(name.startsWith('run-') ? 4 : 7, -5);
        await readCompanyV3Run(path, id);
        if (name.startsWith('result-')) await readCompanyV3RunResult(path, id);
      }
    }
  }
  await guard(); await parentGuard();
};

const readPrivateJson = async (path: string): Promise<unknown> => {
  companyPath(path);
  const guard = await companyDirectoryChain(dirname(path));
  await assertDirectory(dirname(path));
  const before = await assertFile(path);
  if (before.size > 64_000) reject();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(before, await handle.stat())) reject();
    const bytes = Buffer.alloc(64_001);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== before.size || !same(before, await handle.stat()) || !same(before, await assertFile(path))) reject();
    await guard();
    return parseReadonlyTransportJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, result.bytesRead)), 64_000);
  } finally { await handle.close(); }
};
export const readCompanyV3Registration = async (path: string): Promise<unknown> => {
  if (!['company-readonly-registration-v3.json', 'company-readonly-registration-v3.example.json'].includes(basename(path))) reject();
  return readPrivateJson(path);
};
const writePrivateJson = async (path: string, value: unknown): Promise<void> => {
  companyPath(path);
  const guard = await companyDirectoryChain(dirname(path));
  await assertDirectory(dirname(path));
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > 64_000) reject();
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync();
    if (!same(await handle.stat(), await assertFile(path))) reject();
    await guard();
  } finally { await handle.close(); }
  // Persist the directory entry before allowing a worker to commit under this ID.
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
  await guard();
};
const runPath = (root: string, id: string, prefix: 'run' | 'result'): string => {
  if (!isReadonlyId(id)) reject();
  return join(root, 'runs', `${prefix}-${id}.json`);
};
export const readCompanyV3Run = async (root: string, id: string): Promise<CompanyV3Run> => {
  const value = await readPrivateJson(runPath(root, id, 'run')) as CompanyV3Run;
  const fields = ['version', 'taskId', 'ownerId', 'startedAt', 'auditExpiresAt', 'gitProfileHash', 'guardPolicyHash', 'registrationHash', 'policyHash', 'runtimeHash'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(key => !fields.includes(key)) || value.version !== 'company-readonly-v3-run-v1'
    || value.taskId !== id || value.ownerId !== `os-user:${process.getuid?.()}`
    || value.runtimeHash !== companyV3RuntimeHash(root, value.ownerId)
    || value.gitProfileHash !== getCompanyGitRangeUnitProfileHash() || value.guardPolicyHash !== getCompanyGitRangeUnitGuardPolicyHash()
    || !hash(value.registrationHash) || !hash(value.policyHash)
    || !date(value.startedAt) || !date(value.auditExpiresAt) || Date.parse(value.startedAt) >= Date.parse(value.auditExpiresAt)) reject();
  return value;
};
export const readCompanyV3RunResult = async (root: string, id: string): Promise<CompanyV3RunResult | null> => {
  const path = runPath(root, id, 'result');
  if (!await companyV3FileExists(path)) return null;
  const value = await readPrivateJson(path) as CompanyV3RunResult;
  const fields = ['version', 'taskId', 'status', 'planHash', 'endedAt', 'exitConfirmed'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || Object.keys(value).some(key => !fields.includes(key)) || value.version !== 'company-readonly-v3-run-result-v1'
    || value.taskId !== id || !['succeeded', 'unknown'].includes(value.status) || !date(value.endedAt)
    || typeof value.exitConfirmed !== 'boolean' || (value.status === 'succeeded'
      ? !hash(value.planHash) || !value.exitConfirmed : value.planHash !== null)) reject();
  return value;
};
export const writeCompanyV3Run = async (root: string, value: CompanyV3Run): Promise<void> => {
  await writePrivateJson(runPath(root, value.taskId, 'run'), value);
  await readCompanyV3Run(root, value.taskId);
};
export const writeCompanyV3RunResult = async (root: string, value: CompanyV3RunResult): Promise<void> => {
  await readCompanyV3Run(root, value.taskId);
  await writePrivateJson(runPath(root, value.taskId, 'result'), value);
};
export const pruneCompanyV3Runs = async (root: string, now: Date): Promise<number> => {
  const directory = join(root, 'runs'), guard = await companyDirectoryChain(directory);
  let removed = 0;
  for (const name of await readdir(directory)) {
    if (!name.startsWith('run-')) continue;
    const id = name.slice(4, -5), run = await readCompanyV3Run(root, id);
    if (Date.parse(run.auditExpiresAt) > now.getTime()) continue;
    const result = runPath(root, id, 'result');
    if (await companyV3FileExists(result)) { await readCompanyV3RunResult(root, id); await guard(); await unlink(result); }
    await guard(); await unlink(runPath(root, id, 'run')); removed += 1;
  }
  return removed;
};
