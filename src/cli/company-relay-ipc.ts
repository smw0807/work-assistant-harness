import { lstat, mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { HarnessError } from '../domain/errors.js';

/** The trusted parent owns one short socket directory; cleanup never recursively removes contents. */
export const createCompanyRelayIpcDirectory = async (): Promise<{ path: string; cleanup: () => Promise<boolean> }> => {
  const path = await mkdtemp('/private/tmp/hcri-'), before = await lstat(path);
  if (await realpath(path) !== path || !before.isDirectory() || before.isSymbolicLink()
    || before.uid !== process.getuid?.() || (before.mode & 0o7777) !== 0o700) throw new HarnessError('COMPANY_RELAY_UNSAFE_IPC');
  return { path, cleanup: async () => {
    try {
      const now = await lstat(path);
      if (await realpath(path) !== path || now.dev !== before.dev || now.ino !== before.ino || now.uid !== before.uid
        || now.mode !== before.mode || !now.isDirectory() || now.isSymbolicLink()) return false;
      await rmdir(path); return true;
    } catch { return false; }
  } };
};
