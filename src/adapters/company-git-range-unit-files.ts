import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { types } from 'node:util';
import { HarnessError } from '../domain/errors.js';
import type { CompanyGitRangeUnitKind } from '../domain/company-git-range-unit.js';
import { assertCompanyGitRangeUnitBudget, CompanyGitRangeUnitBudget, getCompanyGitRangeUnitProfile } from '../policy/company-git-range-unit-budget.js';
import { assertMigrationPartialRuntimePath } from '../policy/migration-check.js';
import { getPersonalCollectionProfile } from '../policy/personal-readonly-collection.js';
import { isRepositoryPath, validateReadRequest } from '../policy/read-policy.js';
import type { CompanyGitRangeParentMetadata, CompanyGitRangeReadMetadata, CompanyGitRangeFilesProof } from './company-git-range-files.js';

const limits = getCompanyGitRangeUnitProfile().limits;
const collectionLimits = getPersonalCollectionProfile().limits;
type MemoryLease = ReturnType<CompanyGitRangeUnitBudget['reserveMemory']>;
type DescriptorLease = ReturnType<CompanyGitRangeUnitBudget['reserveDescriptor']>;
const reject = (code = 'COMPANY_GIT_RANGE_SOURCE_CHANGED'): never => { throw new HarnessError(code); };
const throwCleanupFailure = (error: unknown, alreadyFailed: boolean): void => { if (!alreadyFailed) throw error; };
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const packName = /^pack-[a-f0-9]{40}\.(idx|pack)$/u;
const packFilePath = /^\.git\/objects\/pack\/pack-[a-f0-9]{40}\.pack$/u;
const indexFilePath = /^\.git\/objects\/pack\/pack-[a-f0-9]{40}\.idx$/u;
const gitPath = (path: string): boolean => /^\.git\/(?:HEAD|index|packed-refs|refs\/heads\/[a-zA-Z0-9_./-]+|objects\/[a-f0-9]{2}\/[a-f0-9]{38}|objects\/pack\/pack-[a-f0-9]{40}\.(?:idx|pack))$/u.test(path)
  && !path.split('/').slice(1).some(part => part === '.' || part === '..' || part.endsWith('.lock') || part.startsWith('.') || part.endsWith('.') || part.includes('..'));
const safeRelative = (value: unknown): value is string => typeof value === 'string' && value.length <= 512
  && value.split('/').length <= 16 && isRepositoryPath(value);
const forbiddenSource = (path: string): boolean => path.split('/').some(part =>
  /^(?:config(?:uration)?(?:\.|$)|\.gitmodules$|auth(?:\.json)?$|tokens?(?:\.json)?$|keychains$|codex$|sandbox-exec$|\.codex$)/iu.test(part));

/** Pure source-path gate shared with the caller; no metadata lookup or user-provided accessor is evaluated. */
export const assertCompanyGitRangeUnitSourcePath = (value: unknown): string => {
  if (!safeRelative(value) || forbiddenSource(value)) return reject('COMPANY_GIT_RANGE_INVALID_PATH');
  try {
    validateReadRequest({ repoId: 'range', root: '/', baseCommit: '0'.repeat(40), allowedPaths: [value],
      maxFileBytes: collectionLimits.sourceFileBytes, maxEvidenceBytes: collectionLimits.evidenceBytes },
    { repoId: 'range', path: value, startLine: 1, endLine: 1 });
  } catch { return reject('COMPANY_GIT_RANGE_INVALID_PATH'); }
  return value;
};

export interface CompanyGitRangeUnitFileHandle {
  readonly size: number; readonly mode: number;
  readUnit(kind: CompanyGitRangeUnitKind, offset: number, length: number): { bytes: Buffer; memoryLease: MemoryLease };
  close(): void;
}
export interface CompanyGitRangeUnitFiles {
  open(path: string, maximum: number, optional?: boolean): CompanyGitRangeUnitFileHandle | undefined;
  listPacks(): readonly string[];
  assertUnchanged(): void;
  proof(): CompanyGitRangeFilesProof;
  close(): void;
}
interface FileObservation { path: string; stat: fs.Stats; reads: Map<string, CompanyGitRangeReadMetadata> }
interface OpenFile { observation: FileObservation; descriptor: number | null; lease: DescriptorLease; closeUncertain: boolean }
const parentMetadata = (path: string, stat: fs.Stats): CompanyGitRangeParentMetadata => Object.freeze({ path,
  device: stat.dev, inode: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid });
const sameParent = (left: CompanyGitRangeParentMetadata, right: CompanyGitRangeParentMetadata): boolean =>
  left.device === right.device && left.inode === right.inode && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
const sameFile = (left: fs.Stats, right: fs.Stats): boolean => sameParent(parentMetadata('', left), parentMetadata('', right))
  && left.size === right.size && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
const missing = (error: unknown): boolean => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');

/**
 * One content-pass session under the independent read-unit guard contract. Only the trusted clock is injected.
 * Full ancestry is observed at open/unit boundaries/final guards; each chunk checks its leaf and retained FD.
 * A transient ancestor alias restored within a unit can escape these observations. This is not the v1 contract.
 * Metadata guards are observations, not an atomic snapshot or an OS read sandbox. Read buffers belong to callers,
 * which must retain their leases while bytes/views are live. Closing a handle does not continuously guard its inode.
 */
export const createCompanyGitRangeUnitFiles = (inputRoot: string, inputSelectedPaths: readonly string[],
  budget: CompanyGitRangeUnitBudget, now: () => number): CompanyGitRangeUnitFiles => {
  // Identity is checked before any path, clock or caller-budget method can be observed.
  assertCompanyGitRangeUnitBudget(budget);
  const parents = new Map<string, CompanyGitRangeParentMetadata>(), files = new Map<string, FileObservation>();
  const absentPaths = new Map<string, string>(), openFiles = new Set<OpenFile>();
  let root = '', closed = false, packNames: readonly string[] | null = null;
  const selectedPaths = new Set<string>();
  const closeFile = (file: OpenFile): void => {
    if (file.descriptor === null) return;
    // A native close error does not prove that the descriptor is closed. Retain its charge and never retry a
    // possibly reused descriptor number; the surrounding process supervisor must resolve uncertain cleanup.
    if (file.closeUncertain) reject();
    try { fs.closeSync(file.descriptor); }
    catch (error) { file.closeUncertain = true; throw error; }
    file.descriptor = null; openFiles.delete(file); budget.releaseDescriptor(file.lease);
  };
  const close = (): void => {
    let failed = false;
    for (const file of openFiles) { try { closeFile(file); } catch { failed = true; } }
    closed = true;
    if (failed) { budget.abort(); reject(); }
  };
  const run = <T>(operation: () => T): T => {
    try { return operation(); }
    catch (error) {
      budget.abort(); try { close(); } catch { /* Continue cleanup without exposing native errors. */ }
      if (error instanceof HarnessError && /^COMPANY_GIT_RANGE_/u.test(error.code)) throw error;
      const failure = budget.snapshot().failureCode;
      if (failure && failure !== 'COMPANY_GIT_RANGE_ABORTED') throw new HarnessError(failure);
      return reject();
    }
  };
  const active = (): void => {
    if (closed) reject('COMPANY_GIT_RANGE_INVALID_FILES');
    budget.checkActive(now());
  };
  const metadata = <T>(operation: 'lstat' | 'fstat' | 'open' | 'realpath' | 'readdir', action: () => T): T => {
    active(); budget.chargeMetadata(operation); return action();
  };
  const stat = (path: string): fs.Stats | undefined => {
    try { return metadata('lstat', () => fs.lstatSync(path)); }
    catch (error) { if (missing(error)) return undefined; throw error; }
  };
  const observeParents = (path: string, optional = false): string | undefined => {
    let current: string = sep;
    for (const part of ['', ...path.split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      const value = stat(current);
      if (!value) { if (optional && !parents.has(current)) return current; return reject(); }
      if (!value.isDirectory() || value.isSymbolicLink()
        || metadata('realpath', () => fs.realpathSync(current)) !== current) reject();
      const observed = parentMetadata(current, value), previous = parents.get(current);
      if (previous && !sameParent(previous, observed)) reject();
      parents.set(current, observed);
    }
    return undefined;
  };
  const regular = (value: fs.Stats, maximum: number, path: string): void => {
    if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.uid !== process.getuid?.()
      || !integer(value.size)) reject();
    if (value.size > maximum) budget.failLimit(gitPath(path)
      ? packFilePath.test(path) ? 'packBytes' : indexFilePath.test(path) ? 'indexBytes' : 'gitFileBytes'
      : 'sourceFileBytes', 0, value.size, maximum);
  };
  const compareLeaf = (observation: FileObservation): void => {
    const absolute = join(root, observation.path);
    const current = stat(absolute);
    if (!current || !sameFile(observation.stat, current)) return reject();
    regular(current, observation.stat.size, observation.path);
  };
  const comparePath = (observation: FileObservation): void => {
    observeParents(dirname(join(root, observation.path))); compareLeaf(observation);
  };
  const compareDescriptor = (file: OpenFile): void => {
    if (file.descriptor === null) reject('COMPANY_GIT_RANGE_INVALID_FILES');
    const current = metadata('fstat', () => fs.fstatSync(file.descriptor!));
    if (!sameFile(file.observation.stat, current)) reject();
    regular(current, file.observation.stat.size, file.observation.path);
  };
  const compareFile = (file: OpenFile): void => { comparePath(file.observation); compareDescriptor(file); };
  const compareChunkFile = (file: OpenFile): void => { compareLeaf(file.observation); compareDescriptor(file); };
  const admitUnit = (file: OpenFile, kind: CompanyGitRangeUnitKind, offset: number, length: number): void => {
    const path = file.observation.path, size = file.observation.stat.size;
    if (file.descriptor === null || !integer(offset) || !integer(length) || offset > size || length > size - offset) {
      reject('COMPANY_GIT_RANGE_INVALID_UNIT');
    }
    const pack = packFilePath.test(path), index = indexFilePath.test(path);
    if (kind === 'pack-index' && index || kind === 'git-file' && gitPath(path) && !pack && !index
      || kind === 'selected-file' && selectedPaths.has(path) && !gitPath(path)) {
      if (offset !== 0 || length !== size) reject('COMPANY_GIT_RANGE_INVALID_UNIT');
      return;
    }
    if (!pack || size < 32) reject('COMPANY_GIT_RANGE_INVALID_UNIT');
    if (kind === 'pack-header' && offset === 0 && length === 12 || kind === 'pack-trailer' && offset === size - 20 && length === 20) return;
    if (kind !== 'pack-object' || offset < 12 || length < 1 || length > size - 20 - offset) reject('COMPANY_GIT_RANGE_INVALID_UNIT');
    if (length > limits.encodedObjectBytes) budget.failLimit('encodedObjectBytes', 0, length, limits.encodedObjectBytes);
  };
  const readUnit = (file: OpenFile, kind: CompanyGitRangeUnitKind, offset: number, length: number): { bytes: Buffer; memoryLease: MemoryLease } => run(() => {
    active();
    admitUnit(file, kind, offset, length);
    compareFile(file);
    const memoryLease = budget.reserveMemory(length);
    try {
      const bytes = Buffer.allocUnsafeSlow(length);
      const records = new Map<string, CompanyGitRangeReadMetadata>();
      let cursor = 0;
      do {
        const chunkLength = Math.min(length - cursor, limits.readChunkBytes), position = offset + cursor;
        compareChunkFile(file);
        const chunkLease = budget.reserveMemory(chunkLength);
        let receipt: ReturnType<CompanyGitRangeUnitBudget['reserveRead']> | undefined;
        try {
          const chunk = Buffer.allocUnsafeSlow(chunkLength);
          receipt = budget.reserveRead(chunkLength); active();
          const returned = fs.readSync(file.descriptor!, chunk, 0, chunkLength, position);
          budget.completeRead(receipt, returned); receipt = undefined;
          if (returned !== chunkLength) reject();
          compareChunkFile(file);
          const record = Object.freeze({ offset: position, length: chunkLength, sha256: createHash('sha256').update(chunk).digest('hex') });
          const key = `${position}:${chunkLength}`, previous = file.observation.reads.get(key);
          if (previous && previous.sha256 !== record.sha256) reject();
          records.set(key, record); chunk.copy(bytes, cursor); cursor += returned;
        } catch (error) {
          if (receipt) budget.failRead(receipt);
          throw error;
        } finally { budget.releaseMemory(chunkLease); }
      } while (cursor < length);
      compareFile(file);
      // No partial unit proof or buffer escapes before its complete end-boundary guard succeeds.
      for (const [key, record] of records) file.observation.reads.set(key, record);
      return { bytes, memoryLease };
    } catch (error) {
      budget.releaseMemory(memoryLease); throw error;
    }
  });
  const capFor = (path: string): number => packFilePath.test(path) ? limits.packBytes
    : indexFilePath.test(path) ? limits.indexBytes : gitPath(path) ? limits.gitFileBytes : collectionLimits.sourceFileBytes;
  const allowed = (path: unknown): path is string => safeRelative(path) && (gitPath(path) || selectedPaths.has(path));
  const open = (path: string, maximum: number, optional = false): CompanyGitRangeUnitFileHandle | undefined => run(() => {
    active();
    if (!allowed(path) || !integer(maximum) || maximum > capFor(path) || typeof optional !== 'boolean') {
      reject('COMPANY_GIT_RANGE_INVALID_PATH');
    }
    const absolute = join(root, path), missingParent = observeParents(dirname(absolute), optional);
    const current = missingParent ? undefined : stat(absolute);
    if (!current) {
      if (!optional || files.has(path)) reject();
      const frontier = missingParent ?? absolute, previous = absentPaths.get(path);
      if (previous && previous !== frontier) reject();
      absentPaths.set(path, frontier); return undefined;
    }
    if (absentPaths.has(path)) reject();
    regular(current, maximum, path);
    const previous = files.get(path);
    if (previous && !sameFile(previous.stat, current)) reject();
    const observation = previous ?? { path, stat: current, reads: new Map<string, CompanyGitRangeReadMetadata>() };
    const lease = budget.reserveDescriptor();
    let descriptor: number;
    try { descriptor = metadata('open', () => fs.openSync(absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)); }
    catch (error) { budget.releaseDescriptor(lease); throw error; }
    const file: OpenFile = { observation, descriptor, lease, closeUncertain: false }; openFiles.add(file);
    compareFile(file); files.set(path, observation);
    return Object.freeze({ size: current.size, mode: current.mode,
      readUnit: (kind: CompanyGitRangeUnitKind, offset: number, length: number) => readUnit(file, kind, offset, length),
      close: () => run(() => closeFile(file)) });
  });
  const enumeratePacks = (): readonly string[] => {
    const path = '.git/objects/pack', absolute = join(root, path), missingParent = observeParents(absolute, true);
    if (missingParent) {
      const previous = absentPaths.get(path);
      if (packNames && packNames.length || previous && previous !== missingParent) reject();
      absentPaths.set(path, missingParent); return Object.freeze([]);
    }
    if (absentPaths.has(path)) reject();
    const lease = budget.reserveDescriptor();
    let directory: fs.Dir;
    try { directory = metadata('open', () => fs.opendirSync(absolute, { bufferSize: 1 })); }
    catch (error) { budget.releaseDescriptor(lease); throw error; }
    const names: string[] = [], candidates = new Set<string>();
    let failed = false;
    try {
      for (;;) {
        const entry = metadata('readdir', () => directory.readSync());
        if (!entry) break;
        if (names.length >= limits.packDirectoryEntries) budget.failLimit('packDirectoryEntries', names.length, 1, limits.packDirectoryEntries);
        if (!safeRelative(entry.name) || entry.name.includes('/')) reject();
        names.push(entry.name);
        if (packName.test(entry.name)) {
          if (!entry.isFile()) reject();
          candidates.add(entry.name);
        }
      }
    } catch (error) { failed = true; throw error; }
    finally {
      // An uncertain directory close also keeps its descriptor charge; do not report unconfirmed cleanup.
      try { directory.closeSync(); budget.releaseDescriptor(lease); }
      catch (error) { throwCleanupFailure(error, failed); }
    }
    observeParents(absolute);
    for (const candidate of candidates) {
      const counterpart = candidate.endsWith('.idx') ? candidate.replace(/\.idx$/u, '.pack') : candidate.replace(/\.pack$/u, '.idx');
      if (!candidates.has(counterpart)) reject();
    }
    budget.admitDirectory(names.length, candidates.size / 2);
    return Object.freeze(names.sort());
  };
  const listPacks = (): readonly string[] => run(() => {
    active(); const current = enumeratePacks();
    if (packNames && (packNames.length !== current.length || packNames.some((name, index) => name !== current[index]))) reject();
    packNames = current;
    return Object.freeze(current.filter(name => packName.test(name) && name.endsWith('.idx')));
  });
  const assertUnchanged = (): void => run(() => {
    active();
    for (const [path, previous] of parents) {
      const current = stat(path);
      if (!current || !current.isDirectory() || current.isSymbolicLink() || !sameParent(previous, parentMetadata(path, current))
        || metadata('realpath', () => fs.realpathSync(path)) !== path) reject();
    }
    for (const file of files.values()) comparePath(file);
    for (const file of openFiles) compareFile(file);
    for (const [path, frontier] of absentPaths) {
      observeParents(dirname(frontier));
      if (stat(frontier)) reject();
      if (!join(root, path).startsWith(frontier)) reject('COMPANY_GIT_RANGE_INVALID_FILES');
    }
    if (packNames) listPacks();
  });
  // Alternate stores are unsupported. Probe only these names' presence; never open their contents.
  const rejectAlternateStores = (): void => {
    for (const path of ['.git/objects/info/alternates', '.git/objects/info/http-alternates']) {
      const absolute = join(root, path), missingParent = observeParents(dirname(absolute), true);
      if (!missingParent && stat(absolute)) reject();
      absentPaths.set(path, missingParent ?? absolute);
    }
  };
  const proof = (): CompanyGitRangeFilesProof => Object.freeze({
    files: Object.freeze([...files.values()].sort((left, right) => left.path.localeCompare(right.path, 'en')).map(file => Object.freeze({
      ...parentMetadata(file.path, file.stat), size: file.stat.size, links: file.stat.nlink,
      modified: String(file.stat.mtimeMs), changed: String(file.stat.ctimeMs),
      reads: Object.freeze([...file.reads.values()].sort((left, right) => left.offset - right.offset || left.length - right.length)),
    }))),
    parents: Object.freeze([...parents.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'))),
    absentPaths: Object.freeze([...absentPaths.keys()].sort()),
    missingParents: Object.freeze([...new Set([...absentPaths].filter(([path, frontier]) => join(root, path) !== frontier)
      .map(([, frontier]) => relative(root, frontier)))].sort()),
    packNames,
  });
  return run(() => {
    if (typeof now !== 'function') reject('COMPANY_GIT_RANGE_INVALID_FILES');
    try { root = assertMigrationPartialRuntimePath(inputRoot); }
    catch { reject('COMPANY_GIT_RANGE_INVALID_PATH'); }
    if (resolve(root) !== root || types.isProxy(inputSelectedPaths) || !Array.isArray(inputSelectedPaths) || Object.getPrototypeOf(inputSelectedPaths) !== Array.prototype
      || inputSelectedPaths.length < 1 || inputSelectedPaths.length > collectionLimits.files
      || Reflect.ownKeys(inputSelectedPaths).length !== inputSelectedPaths.length + 1) reject('COMPANY_GIT_RANGE_INVALID_PATH');
    for (let index = 0; index < inputSelectedPaths.length; index++) {
      const property = Object.getOwnPropertyDescriptor(inputSelectedPaths, String(index));
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) return reject('COMPANY_GIT_RANGE_INVALID_PATH');
      const path = assertCompanyGitRangeUnitSourcePath(property.value);
      if (selectedPaths.has(path)) return reject('COMPANY_GIT_RANGE_INVALID_PATH');
      selectedPaths.add(path);
    }
    active(); observeParents(join(root, '.git')); rejectAlternateStores();
    return Object.freeze({ open, listPacks, assertUnchanged, proof, close });
  });
};
