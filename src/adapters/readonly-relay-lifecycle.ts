import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { HarnessError } from '../domain/errors.js';

export interface ReadonlyRelayHashes { requestBodyHash: string; connectionProfileHash: string; requestEnvelopeHash: string }
export interface ReadonlyRelayLocation { dataDirectory: string; investigationId: string }
interface Lifecycle extends ReadonlyRelayHashes {
  version: 'readonly-relay-process-v1'; investigationId: string; controllerPid: number;
  state: 'intent' | 'running' | 'closed';
}
interface ProcessRecord { version: 'readonly-relay-child-v1'; state: 'intent' | 'spawned' | 'closed'; guardianPid: number | null; childPid: number | null }
export interface ReadonlyRelayScratchIdentity { device: number; inode: number }
const fail = (): never => { throw new HarnessError('READONLY_RELAY_LIFECYCLE_UNSAFE'); };
const validPid = (pid: unknown): pid is number => Number.isSafeInteger(pid) && (pid as number) > 1;
const assertDirectory = (path: string): void => {
  const stat = lstatSync(path);
  if (!isAbsolute(path) || realpathSync(path) !== path || !stat.isDirectory() || stat.isSymbolicLink()
    || (stat.mode & 0o7777) !== 0o700 || stat.uid !== process.getuid?.()) fail();
};
const validHashes = (hashes: ReadonlyRelayHashes): boolean => Object.keys(hashes).sort().join(',') === 'connectionProfileHash,requestBodyHash,requestEnvelopeHash'
  && Object.values(hashes).every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const locate = (where: ReadonlyRelayLocation, create = false): string => {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(where.investigationId)) fail();
  assertDirectory(where.dataDirectory);
  const parent = join(where.dataDirectory, 'readonly-relay-runs');
  if (create) { try { mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; } }
  assertDirectory(parent);
  const directory = join(parent, where.investigationId);
  if (create) mkdirSync(directory, { mode: 0o700 });
  assertDirectory(directory);
  return directory;
};
const accessRecord = <T>(path: string, update?: T): T => {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.()
    || (before.mode & 0o7777) !== 0o600 || before.size > 4096) fail();
  const fd = openSync(path, (update === undefined ? constants.O_RDONLY : constants.O_RDWR) | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || opened.size > 4096) fail();
    const raw = readFileSync(fd, 'utf8'); const result: unknown = JSON.parse(raw);
    if (JSON.stringify(result) !== raw || fstatSync(fd).size !== opened.size) fail();
    if (update !== undefined) {
      ftruncateSync(fd, 0);
      const bytes = Buffer.from(JSON.stringify(update));
      // readFileSync advanced the descriptor offset; an explicit position avoids a sparse prefix.
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
      fsyncSync(fd);
    }
    return result as T;
  } finally { closeSync(fd); }
};

export const readonlyRelayScratchIdentity = (where: ReadonlyRelayLocation): ReadonlyRelayScratchIdentity => {
  const path = join(locate(where), 'sandbox'); assertDirectory(path);
  const metadata = lstatSync(path); return { device: metadata.dev, inode: metadata.ino };
};
const scratchAbsent = (where: ReadonlyRelayLocation): boolean => {
  try { lstatSync(join(locate(where), 'sandbox')); return false; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
};

/** Only the newly owned model scratch directory is removed, after its child has closed. */
export const removeReadonlyRelayScratch = (where: ReadonlyRelayLocation, expected: ReadonlyRelayScratchIdentity): void => {
  try {
    if (scratchAbsent(where)) return;
    const path = join(locate(where), 'sandbox'); const actual = readonlyRelayScratchIdentity(where);
    if (actual.device !== expected.device || actual.inode !== expected.inode) fail();
    // rm does not follow descendant symbolic links; the root identity above must remain the owned directory.
    rmSync(path, { recursive: true });
    if (!scratchAbsent(where)) fail();
  } catch { fail(); }
};
/** The trusted guardian writes only this metadata; credentials and model text never enter it. */
export const updateReadonlyRelayChild = (where: ReadonlyRelayLocation, state: ProcessRecord['state'], guardianPid: number, childPid: number | null): void => {
  try {
    const path = join(locate(where), 'child.json');
    const prior = accessRecord<ProcessRecord>(path);
    if (prior.version !== 'readonly-relay-child-v1' || !validPid(guardianPid) || (childPid !== null && !validPid(childPid))) fail();
    accessRecord(path, { version: 'readonly-relay-child-v1', state, guardianPid, childPid });
  } catch { fail(); }
};

export const createReadonlyRelayLifecycle = (where: ReadonlyRelayLocation, hashes: ReadonlyRelayHashes) => {
  try {
    if (!validHashes(hashes)) fail();
    const directory = locate(where, true);
    const initial: Lifecycle = { version: 'readonly-relay-process-v1', investigationId: where.investigationId,
      controllerPid: process.pid, state: 'intent', ...hashes };
    writeFileSync(join(directory, 'lifecycle.json'), JSON.stringify(initial), { flag: 'wx', mode: 0o600, flush: true });
    writeFileSync(join(directory, 'child.json'), JSON.stringify({ version: 'readonly-relay-child-v1', state: 'intent', guardianPid: null, childPid: null }), { flag: 'wx', mode: 0o600, flush: true });
    return { directory,
      running: (): void => { accessRecord(join(locate(where), 'lifecycle.json'), { ...initial, state: 'running' }); },
      closed: (): void => { accessRecord(join(locate(where), 'lifecycle.json'), { ...initial, state: 'closed' }); },
    };
  } catch { return fail(); }
};
const absent = (pid: number): boolean => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH'; }
};

const childClosed = (directory: string, allowUnstarted: boolean): boolean => {
  const child = accessRecord<ProcessRecord>(join(directory, 'child.json'));
  if (Object.keys(child).sort().join(',') !== 'childPid,guardianPid,state,version' || child.version !== 'readonly-relay-child-v1') return false;
  // The initial intent is safe only before any guardian was registered. A spawned or ambiguous intent cannot prove closure.
  if (allowUnstarted && child.state === 'intent' && child.guardianPid === null && child.childPid === null) return true;
  if (child.state !== 'closed' || !validPid(child.guardianPid) || !absent(child.guardianPid)) return false;
  if (child.childPid === null) return true;
  return validPid(child.childPid) && absent(child.childPid) && absent(-child.childPid);
};

/** A vanished controller alone is insufficient: its guardian must have recorded child close. */
export const readonlyRelayCleanupConfirmed = (dataDirectory: string, investigationId: string, hashes: ReadonlyRelayHashes): boolean => {
  try {
    if (!validHashes(hashes)) return false;
    const directory = locate({ dataDirectory, investigationId });
    const record = accessRecord<Lifecycle>(join(directory, 'lifecycle.json'));
    if (Object.keys(record).sort().join(',') !== 'connectionProfileHash,controllerPid,investigationId,requestBodyHash,requestEnvelopeHash,state,version'
      || record.version !== 'readonly-relay-process-v1' || record.investigationId !== investigationId || !validPid(record.controllerPid)
      || Object.entries(hashes).some(([key, value]) => record[key as keyof ReadonlyRelayHashes] !== value)) return false;
    if (record.state === 'closed') return scratchAbsent({ dataDirectory, investigationId }) && childClosed(directory, true);
    if (record.state !== 'running' || !absent(record.controllerPid)) return false;
    return scratchAbsent({ dataDirectory, investigationId }) && childClosed(directory, false);
  } catch { return false; }
};
