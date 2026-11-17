import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import { companyDirectoryChain, companyPath } from './company-readonly-files.js';
import { companyV3FileExists } from './company-readonly-v3-files.js';

const reject = (): never => { throw new HarnessError('COMPANY_INVESTIGATION_UNSAFE_DIRECTORY'); };
const assertDirectory = async (path: string): Promise<void> => {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid?.()
    || (value.mode & 0o7777) !== 0o700 || await realpath(path) !== path) reject();
};
/** Dedicated storage cannot silently adopt a preparation or personal investigation database. */
export const prepareCompanyInvestigationDirectory = async (path: string, create: boolean): Promise<void> => {
  companyPath(path);
  const parentGuard = await companyDirectoryChain(dirname(path));
  await assertDirectory(dirname(path));
  if (!await companyV3FileExists(path)) { if (!create) reject(); await mkdir(path, { mode: 0o700 }); }
  await assertDirectory(path);
  const guard = await companyDirectoryChain(path), entries = await readdir(path);
  if (entries.some(name => name !== 'store')) reject();
  const store = join(path, 'store');
  if (!await companyV3FileExists(store)) {
    if (!create || entries.length !== 0) reject();
    await mkdir(store, { mode: 0o700 });
  }
  await assertDirectory(store);
  const names = await readdir(store);
  for (const name of names) {
    if (!['company-investigation.sqlite', 'company-investigation.sqlite-journal', 'company-investigation.sqlite-wal', 'company-investigation.sqlite-shm'].includes(name)) reject();
    const file = join(store, name), metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o7777) !== 0o600 || await realpath(file) !== file) reject();
  }
  await guard(); await parentGuard();
};
