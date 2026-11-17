import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { HarnessError } from '../domain/errors.js';
import type { CompanyGitRangeBudgetSnapshot } from '../domain/company-git-range.js';
import { CompanyGitRangeBudget, getCompanyGitRangeProfile, getCompanyGitRangeProfileHash } from '../policy/company-git-range-budget.js';
import { parseCompanyGitRangeIndex, validateCompanyGitRangePackHeader,
  type CompanyGitRangeIndex, type CompanyGitRangeIndexEntry, type CompanyGitRangePackMetadata } from '../policy/company-git-range-index.js';
import { applyCompanyGitPackedDelta, decodeCompanyGitLooseObject, decodeCompanyGitPackedObject,
  type CompanyGitDecodedObject, type CompanyGitVerifiedObject } from '../policy/company-git-range-object-codec.js';
import { assertCompanyGitWorkingIndex, findCompanyGitTreeEntry, parseCompanyGitCommitTree } from '../policy/company-git-range-payload.js';
import { createCompanyGitRangeByteProof, type CompanyGitRangeByteProof, type CompanyGitRangeObjectProof } from '../policy/company-git-range-proof.js';
import { getPersonalCollectionProfile } from '../policy/personal-readonly-collection.js';
import { assertMigrationPartialRuntimePath } from '../policy/migration-check.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { assertCompanyGitRangeSourcePath, createCompanyGitRangeFiles } from './company-git-range-files.js';

const limits = getCompanyGitRangeProfile().limits;
const collectionLimits = getPersonalCollectionProfile().limits;
type Files = ReturnType<typeof createCompanyGitRangeFiles>;
type File = NonNullable<ReturnType<Files['open']>>;
const fail = (suffix = 'INVALID_SOURCE'): never => { throw new HarnessError(`COMPANY_GIT_RANGE_${suffix}`); };
const oid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const digest = (value: unknown): string => hashReadonlyValue(canonicalReadonlyJson(value));
const inputKeys = ['version', 'profileHash', 'sourceRoot', 'baseCommit', 'selectedPaths'];

/** Internal reader input, not a company registration, policy approval, or CLI command. */
export interface CompanyGitRangeSourceRequest {
  readonly version: 'company-git-range-source-v1';
  readonly profileHash: string;
  readonly sourceRoot: string;
  readonly baseCommit: string;
  readonly selectedPaths: readonly string[];
}
export interface CompanyGitRangeSelectedFile {
  readonly path: string;
  readonly oid: string;
  readonly mode: '100644' | '100755';
  readonly sha256: string;
  readonly bytes: number;
}
interface LooseProof { readonly oid: string; readonly type: string; readonly contentSha256: string; readonly encodedSha256: string }
export interface CompanyGitRangeSourceObservation {
  readonly version: 'company-git-range-source-observation-v1';
  readonly profileHash: string;
  readonly baseCommit: string;
  readonly integrityScope: 'selected-object-chain';
  readonly packChecksum: 'not_checked';
  readonly unvisitedObjects: 'not_checked';
  readonly selectedFiles: readonly CompanyGitRangeSelectedFile[];
  readonly packs: readonly { readonly path: string; readonly metadata: CompanyGitRangePackMetadata;
    readonly byteProof: CompanyGitRangeByteProof | null }[];
  readonly looseObjects: readonly LooseProof[];
  readonly fileSystem: ReturnType<Files['proof']>;
  readonly proofHash: string;
}
export interface CompanyGitRangeSource {
  inspect(): CompanyGitRangeSourceObservation;
  verify(): CompanyGitRangeSourceObservation;
  snapshot(): CompanyGitRangeBudgetSnapshot;
  close(): void;
}

/** Snapshot data properties before any path observation. No getters or model-supplied capabilities are accepted. */
const parseRequest = (value: unknown): CompanyGitRangeSourceRequest => {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== inputKeys.length) return fail('INVALID_SOURCE_INPUT');
    const fields = Object.fromEntries(inputKeys.map(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) return fail('INVALID_SOURCE_INPUT');
      return [key, property.value];
    }));
    if (fields.version !== 'company-git-range-source-v1' || fields.profileHash !== getCompanyGitRangeProfileHash()
      || typeof fields.sourceRoot !== 'string' || fields.sourceRoot.length > 4096 || fields.sourceRoot.includes('\0')
      || resolve(fields.sourceRoot) !== fields.sourceRoot || !oid(fields.baseCommit)) return fail('INVALID_SOURCE_INPUT');
    assertMigrationPartialRuntimePath(fields.sourceRoot);
    const paths: unknown = fields.selectedPaths;
    if (!Array.isArray(paths) || types.isProxy(paths) || Object.getPrototypeOf(paths) !== Array.prototype
      || paths.length < 1 || paths.length > collectionLimits.files || Reflect.ownKeys(paths).length !== paths.length + 1) return fail('INVALID_SOURCE_INPUT');
    const selectedPaths = Array.from({ length: paths.length }, (_, position) => {
      const property = Object.getOwnPropertyDescriptor(paths, String(position));
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) return fail('INVALID_SOURCE_INPUT');
      return assertCompanyGitRangeSourcePath(property.value);
    }).sort();
    if (new Set(selectedPaths).size !== selectedPaths.length) return fail('INVALID_SOURCE_INPUT');
    return Object.freeze({ version: 'company-git-range-source-v1', profileHash: fields.profileHash,
      sourceRoot: fields.sourceRoot, baseCommit: fields.baseCommit, selectedPaths: Object.freeze(selectedPaths) });
  } catch { return fail('INVALID_SOURCE_INPUT'); }
};

interface Pack {
  path: string;
  file: File;
  index: CompanyGitRangeIndex;
  metadata: CompanyGitRangePackMetadata;
  roots: Set<string>;
  objects: Map<string, CompanyGitRangeObjectProof>;
}

/** Reserve the complete owned result before reading bounded chunks; every actual request is charged by Files. */
const readBytes = (file: File, offset: number, length: number, budget: CompanyGitRangeBudget): ReturnType<File['read']> => {
  const memoryLease = budget.reserveMemory(length);
  try {
    const bytes = Buffer.allocUnsafeSlow(length);
    let cursor = 0;
    do {
      const chunk = file.read(offset + cursor, Math.min(length - cursor, limits.readChunkBytes));
      try { chunk.bytes.copy(bytes, cursor); cursor += chunk.bytes.length; }
      finally { budget.releaseMemory(chunk.memoryLease); }
    } while (cursor < length);
    return { bytes, memoryLease };
  } catch (error) { budget.releaseMemory(memoryLease); throw error; }
};
const withFileBytes = <T>(files: Files, budget: CompanyGitRangeBudget, path: string, maximum: number,
  action: (bytes: Buffer, mode: number) => T, optional = false): T | undefined => {
  const file = files.open(path, maximum, optional);
  if (!file) return undefined;
  try {
    const read = readBytes(file, 0, file.size, budget);
    try { file.close(); return action(read.bytes, file.mode); }
    finally { budget.releaseMemory(read.memoryLease); }
  } finally { file.close(); }
};
const validRef = (name: string): boolean => name.length <= 512 && /^refs\/[a-zA-Z0-9_./-]+$/u.test(name)
  && !name.endsWith('/') && !name.includes('//') && !name.includes('..')
  && !name.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'));

const verifyHead = (files: Files, budget: CompanyGitRangeBudget, baseCommit: string): void => {
  const head = withFileBytes(files, budget, '.git/HEAD', limits.gitFileBytes, bytes => bytes.toString('utf8'));
  if (head === `${baseCommit}\n`) return;
  if (head === undefined || head.length > 520) return fail();
  const match = /^ref: (refs\/heads\/[a-zA-Z0-9_./-]+)\n$/u.exec(head);
  if (!match || !validRef(match[1]!)) return fail();
  const ref = match[1]!;
  const loose = withFileBytes(files, budget, `.git/${ref}`, limits.gitFileBytes, bytes => bytes.toString('utf8'), true);
  if (loose !== undefined) { if (loose !== `${baseCommit}\n`) fail(); return; }
  withFileBytes(files, budget, '.git/packed-refs', limits.gitFileBytes, bytes => {
    let cursor = 0, found = 0, canPeel = false;
    while (cursor < bytes.length) {
      const end = bytes.indexOf(10, cursor);
      if (end < 0) return fail();
      const line = bytes.toString('utf8', cursor, end); cursor = end + 1;
      if (line.startsWith('#')) { canPeel = false; continue; }
      if (/^\^[a-f0-9]{40}$/u.test(line) && canPeel) { canPeel = false; continue; }
      const entry = /^([a-f0-9]{40}) (refs\/[a-zA-Z0-9_./-]+)$/u.exec(line);
      if (!entry || !validRef(entry[2]!)) return fail();
      canPeel = true;
      if (entry[2] === ref && (++found !== 1 || entry[1] !== baseCommit)) return fail();
    }
    if (found !== 1) fail();
  });
};

const openPacks = (files: Files, budget: CompanyGitRangeBudget, now: () => number, packs: Pack[]): void => {
  for (const name of files.listPacks()) {
    const path = `.git/objects/pack/${name.replace(/\.idx$/u, '.pack')}`;
    const file = files.open(path, limits.packBytes)!;
    let index: CompanyGitRangeIndex | undefined, retained = false;
    try {
      index = withFileBytes(files, budget, `.git/objects/pack/${name}`, limits.indexBytes,
        bytes => parseCompanyGitRangeIndex(bytes, file.size, budget, now()))!;
      const header = file.read(0, 12);
      try {
        const trailer = file.read(file.size - 20, 20);
        try {
          const metadata = validateCompanyGitRangePackHeader(header.bytes, trailer.bytes, index, budget, now());
          packs.push({ path, file, index, metadata, roots: new Set(), objects: new Map() }); retained = true;
        } finally { budget.releaseMemory(trailer.memoryLease); }
      } finally { budget.releaseMemory(header.memoryLease); }
    } finally { if (!retained) { index?.release(); file.close(); } }
  }
};

/** Each base stays within the already validated pack/index; no fallback or second decoder pass is used. */
const loadPacked = (pack: Pack, entry: CompanyGitRangeIndexEntry, budget: CompanyGitRangeBudget,
  now: () => number): CompanyGitVerifiedObject => {
  budget.checkActive(now());
  const dependency = budget.enterDependency(`${pack.index.summary.indexSha256}:${entry.offset}:${entry.oid}`);
  let decoded: CompanyGitDecodedObject | undefined, base: CompanyGitVerifiedObject | undefined;
  let result: CompanyGitVerifiedObject | undefined, transferred = false;
  try {
    const read = readBytes(pack.file, entry.offset, entry.length, budget);
    try { decoded = decodeCompanyGitPackedObject(read.bytes, entry, pack.index.summary.indexSha256, budget, now()); }
    finally { budget.releaseMemory(read.memoryLease); }
    if (decoded.type === 'ofs-delta' || decoded.type === 'ref-delta') {
      if (!decoded.base) return fail();
      const baseEntry = decoded.base.kind === 'oid' ? pack.index.find(decoded.base.oid, now()) : pack.index.atOffset(decoded.base.offset, now());
      if (!baseEntry) return fail();
      base = loadPacked(pack, baseEntry, budget, now);
      result = applyCompanyGitPackedDelta(decoded, base, budget, now());
    } else { result = decoded as CompanyGitVerifiedObject; }
    const proof: CompanyGitRangeObjectProof = Object.freeze({ ...entry, type: result.type,
      encoding: decoded.type === 'ofs-delta' || decoded.type === 'ref-delta' ? decoded.type : 'full',
      spanSha256: decoded.encodedSha256, contentSha256: hashReadonlyValue(result.bytes), baseOid: base?.oid ?? null });
    const previous = pack.objects.get(entry.oid);
    if (previous && canonicalReadonlyJson(previous) !== canonicalReadonlyJson(proof)) return fail('SOURCE_CHANGED');
    pack.objects.set(entry.oid, proof); transferred = true;
    return result;
  } finally {
    if (result && !transferred && result !== decoded) budget.releaseMemory(result.memoryLease);
    if (decoded && (!transferred || decoded !== result)) budget.releaseMemory(decoded.memoryLease);
    if (base) budget.releaseMemory(base.memoryLease);
    budget.leaveDependency(dependency);
  }
};

/**
 * Experimental internal reader. Only synthetic fixtures exercise it; no existing source port/CLI selects it.
 * The trusted clock is sampled at I/O/codec boundaries; a synchronous operation is not forcibly preempted here.
 */
export const createCompanyGitRangeSource = (input: unknown, clock: () => number = () => performance.now()): CompanyGitRangeSource => {
  const now = (): number => { try { return clock(); } catch { return fail(); } };
  const request = parseRequest(input), budget = new CompanyGitRangeBudget(now());
  let firstProof: string | undefined;
  const runPass = (pass: 'inspect' | 'verify'): CompanyGitRangeSourceObservation => {
    let files: Files | undefined;
    const packs: Pack[] = [];
    try {
      budget.beginPass(pass, now());
      files = createCompanyGitRangeFiles(request.sourceRoot, request.selectedPaths, budget, now);
      verifyHead(files, budget, request.baseCommit);
      openPacks(files, budget, now, packs);
      const looseObjects = new Map<string, LooseProof>();
      const load = (wanted: string): CompanyGitVerifiedObject => {
        budget.checkActive(now());
        const loose = withFileBytes(files!, budget, `.git/objects/${wanted.slice(0, 2)}/${wanted.slice(2)}`, limits.gitFileBytes,
          bytes => decodeCompanyGitLooseObject(bytes, wanted, budget, now()), true);
        if (loose) {
          const proof = Object.freeze({ oid: loose.oid, type: loose.type, contentSha256: hashReadonlyValue(loose.bytes), encodedSha256: loose.encodedSha256 });
          const previous = looseObjects.get(wanted);
          if (previous && canonicalReadonlyJson(previous) !== canonicalReadonlyJson(proof)) {
            budget.releaseMemory(loose.memoryLease); return fail('SOURCE_CHANGED');
          }
          looseObjects.set(wanted, proof); return loose;
        }
        for (const pack of packs) {
          const entry = pack.index.find(wanted, now());
          if (entry) { pack.roots.add(wanted); return loadPacked(pack, entry, budget, now); }
        }
        return fail();
      };
      const consume = <T>(wanted: string, expected: 'commit' | 'tree' | 'blob', action: (object: CompanyGitVerifiedObject) => T): T => {
        const object = load(wanted);
        try { if (object.type !== expected) return fail(); return action(object); }
        finally { budget.releaseMemory(object.memoryLease); }
      };
      const rootTree = consume(request.baseCommit, 'commit', object => parseCompanyGitCommitTree(object.bytes, budget, now()));
      const selectedFiles: CompanyGitRangeSelectedFile[] = [];
      for (const path of request.selectedPaths) {
        const parts = path.split('/'); let currentOid = rootTree, mode: '100644' | '100755' | undefined;
        for (const [position, name] of parts.entries()) {
          const entry = consume(currentOid, 'tree', object => findCompanyGitTreeEntry(object.bytes, name, budget, now()));
          if (!entry) return fail();
          if (position < parts.length - 1) { if (entry.mode !== '40000') return fail(); }
          else { if (entry.mode !== '100644' && entry.mode !== '100755') return fail(); mode = entry.mode; }
          currentOid = entry.oid;
        }
        consume(currentOid, 'blob', object => {
          if (!mode || object.bytes.length > collectionLimits.sourceFileBytes) return fail();
          const selectedMode = mode;
          withFileBytes(files!, budget, path, collectionLimits.sourceFileBytes, (bytes, fileMode) => {
            if (!bytes.equals(object.bytes) || Boolean(fileMode & 0o111) !== (selectedMode === '100755')) return fail('SOURCE_CHANGED');
            selectedFiles.push(Object.freeze({ path, oid: currentOid, mode: selectedMode, sha256: hashReadonlyValue(bytes), bytes: bytes.length }));
          });
        });
      }
      withFileBytes(files, budget, '.git/index', limits.gitFileBytes, bytes =>
        assertCompanyGitWorkingIndex(bytes, selectedFiles.map(({ path, oid, mode }) => ({ path, oid, mode })), budget, now()));
      files.assertUnchanged();
      const packProofs = packs.map(pack => Object.freeze({ path: pack.path, metadata: pack.metadata,
        byteProof: pack.roots.size ? createCompanyGitRangeByteProof(JSON.stringify({ pack: pack.metadata,
          rootOids: [...pack.roots].sort(), objects: [...pack.objects.values()].sort((left, right) => left.offset - right.offset) })) : null }));
      const fields = { version: 'company-git-range-source-observation-v1' as const, profileHash: request.profileHash,
        baseCommit: request.baseCommit, integrityScope: 'selected-object-chain' as const,
        packChecksum: 'not_checked' as const, unvisitedObjects: 'not_checked' as const,
        selectedFiles: Object.freeze(selectedFiles), packs: Object.freeze(packProofs),
        looseObjects: Object.freeze([...looseObjects.values()].sort((left, right) => left.oid.localeCompare(right.oid))), fileSystem: files.proof() };
      return Object.freeze({ ...fields, proofHash: digest(fields) });
    } catch (error) {
      budget.abort();
      if (error instanceof HarnessError && error.code.startsWith('COMPANY_GIT_RANGE_')) throw error;
      return fail();
    } finally {
      for (const pack of packs) pack.index.release();
      files?.close();
    }
  };
  const execute = (pass: 'inspect' | 'verify'): CompanyGitRangeSourceObservation => {
    try {
      const result = runPass(pass);
      if (pass === 'verify' && result.proofHash !== firstProof) return fail('SOURCE_CHANGED');
      budget.endPass(now());
      if (pass === 'inspect') firstProof = result.proofHash;
      return result;
    } catch (error) {
      budget.abort();
      if (error instanceof HarnessError && /^COMPANY_GIT_RANGE_[A-Z_]+$/u.test(error.code)) throw error;
      return fail();
    }
  };
  return Object.freeze({ inspect: () => execute('inspect'), verify: () => execute('verify'), snapshot: () => budget.snapshot(),
    close: () => { firstProof = undefined; if (budget.snapshot().phase !== 'complete') budget.abort(); } });
};
