import fs, { constants, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import { isReadonlyId } from '../policy/readonly-investigation-policy.js';

const filename = 'slack-analysis-active.json';
const fail: () => never = () => { throw new HarnessError('SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED'); };
const sameIdentity = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid
  && a.gid === b.gid && a.mode === b.mode;
const directoryGuard = (directory: string): (() => void) => {
  if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory || process.getuid?.() === undefined) fail();
  const parents: { path: string; metadata: Stats }[] = [];
  for (let path = directory; ; path = dirname(path)) {
    const metadata = fs.lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || fs.realpathSync(path) !== path
      || path === directory && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== 0o700)) fail();
    parents.push({ path, metadata }); if (path === dirname(path)) break;
  }
  return () => {
    for (const parent of parents) {
      const current = fs.lstatSync(parent.path);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(parent.metadata, current)
        || fs.realpathSync(parent.path) !== parent.path) fail();
    }
  };
};
const syncDirectory = (directory: string, guard: () => void): void => {
  guard(); const handle = fs.openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameIdentity(fs.fstatSync(handle), fs.lstatSync(directory))) fail();
    fs.fsyncSync(handle); guard();
  } finally { fs.closeSync(handle); }
};
const absent = (path: string): void => {
  try { fs.lstatSync(path); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  fail();
};

/** A surviving marker needs local review; no PID guess, stale timeout, or stored contents authorize its removal. */
export const assertSlackAnalysisIdle = (directory: string): void => {
  try { const guard = directoryGuard(directory); absent(join(directory, filename)); guard(); }
  catch { fail(); }
};

/** The callback's confirmed lifecycle outcome decides cleanup. No original Slack body, credential, or native PID is retained. */
export const withSlackAnalysisNativeRun = async <T>(directory: string, runId: string, invoke: () => Promise<T>): Promise<T> => {
  if (!isReadonlyId(runId) || typeof invoke !== 'function') throw new HarnessError('SLACK_ANALYSIS_INVALID_INPUT');
  const path = join(directory, filename); let guard: () => void, owned: Stats;
  try {
    guard = directoryGuard(directory); absent(path);
    const handle = fs.openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify({ version: 'slack-analysis-active-v1', runId }) + '\n');
      fs.fsyncSync(handle); owned = fs.fstatSync(handle);
      if (!owned.isFile() || owned.nlink !== 1 || owned.uid !== process.getuid?.() || (owned.mode & 0o7777) !== 0o600
        || !sameIdentity(owned, fs.lstatSync(path))) fail();
    } finally { fs.closeSync(handle); }
    syncDirectory(directory, guard);
  } catch { return fail(); }
  const removeOwned = (): void => {
    try {
      guard(); const current = fs.lstatSync(path);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameIdentity(owned, current)
        || current.size !== owned.size || current.mtimeMs !== owned.mtimeMs || current.ctimeMs !== owned.ctimeMs) fail();
      fs.unlinkSync(path); syncDirectory(directory, guard);
    } catch { fail(); }
  };
  let result: T;
  try { result = await invoke(); }
  catch (error) {
    if (error instanceof HarnessError && error.code !== 'READONLY_RELAY_LIFECYCLE_UNSAFE') removeOwned();
    throw error;
  }
  removeOwned(); return result;
};
