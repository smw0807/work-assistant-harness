import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import { assertMigrationPartialRuntimePath } from '../policy/migration-check.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';

const reject = (code = 'COMPANY_READONLY_UNSAFE_PATH'): never => { throw new HarnessError(code); };
export const companyPath = (value: unknown): string => {
  try { return assertMigrationPartialRuntimePath(value); } catch { return reject(); }
};
export const companyPathsOverlap = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
const sameIdentity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
const sameFile = (left: Stats, right: Stats): boolean => right.isFile() && sameIdentity(left, right)
  && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

export const companyDirectoryChain = async (path: string): Promise<() => Promise<void>> => {
  companyPath(path);
  const entries: { path: string; metadata: Stats }[] = [];
  let current: string = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(current) !== current) reject();
    entries.push({ path: current, metadata });
  }
  return async () => {
    for (const entry of entries) {
      if (!sameIdentity(entry.metadata, await lstat(entry.path)) || await realpath(entry.path) !== entry.path) reject();
    }
  };
};
const assertPrivateDirectory = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) reject();
};

export const readCompanyPrivateJson = async (requested: string, kind: 'policy' | 'registration'): Promise<unknown> => {
  try {
    const path = companyPath(requested);
    if (![ `company-readonly-${kind}.json`, `company-readonly-${kind}.example.json` ].includes(basename(path))) reject();
    const checkParents = await companyDirectoryChain(dirname(path));
    await assertPrivateDirectory(dirname(path));
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || (before.mode & 0o777) !== 0o600 || before.size > 64_000 || await realpath(path) !== path) reject();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameFile(before, await handle.stat())) reject();
      const bytes = Buffer.alloc(64_001);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== before.size || bytesRead > 64_000 || !sameFile(before, await handle.stat())
        || !sameFile(before, await lstat(path)) || await realpath(path) !== path) reject();
      await checkParents();
      return parseReadonlyTransportJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead)), 64_000);
    } finally { await handle.close(); }
  } catch { return reject('COMPANY_READONLY_INVALID_PRIVATE_FILE'); }
};

/** A dedicated directory prevents opening personal runtime databases or creating state inside the target. */
export const prepareCompanyDirectory = async (path: string, create: boolean): Promise<void> => {
  companyPath(path);
  const checkParent = await companyDirectoryChain(dirname(path));
  await assertPrivateDirectory(dirname(path));
  try { await lstat(path); }
  catch (error) {
    if (!create || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') reject();
    await mkdir(path, { mode: 0o700 });
  }
  const checkDirectory = await companyDirectoryChain(path);
  await assertPrivateDirectory(path);
  const entries = await readdir(path);
  const allowed = ['company-readonly.sqlite', 'company-readonly.sqlite-journal', 'company-readonly.sqlite-wal', 'company-readonly.sqlite-shm'];
  if (entries.some(name => !allowed.includes(name)) || !create && !entries.includes('company-readonly.sqlite')) reject();
  for (const name of entries) {
    const metadata = await lstat(join(path, name));
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) reject();
  }
  await checkDirectory(); await checkParent();
};
