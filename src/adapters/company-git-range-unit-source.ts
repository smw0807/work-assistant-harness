import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { HarnessError } from '../domain/errors.js';
import type { CompanyGitRangeMemoryLease } from '../domain/company-git-range.js';
import type { CompanyGitRangeUnitBudgetSnapshot } from '../domain/company-git-range-unit.js';
import type { PersonalCollectionEvidence, PersonalSourceView, PersonalSourceViewProof } from '../domain/personal-readonly-collection.js';
import type { ReadonlyEvidence, ReadonlyRange } from '../domain/readonly-investigation.js';
import { CompanyGitRangeUnitBudget, getCompanyGitRangeUnitProfile, getCompanyGitRangeUnitProfileHash, getCompanyGitRangeUnitGuardPolicyHash } from '../policy/company-git-range-unit-budget.js';
import { parseCompanyGitRangeIndex, validateCompanyGitRangePackHeader,
  type CompanyGitRangeIndex, type CompanyGitRangeIndexEntry, type CompanyGitRangePackMetadata } from '../policy/company-git-range-index.js';
import { applyCompanyGitPackedDelta, decodeCompanyGitLooseObject, decodeCompanyGitPackedObject,
  type CompanyGitDecodedObject, type CompanyGitVerifiedObject } from '../policy/company-git-range-object-codec.js';
import { assertCompanyGitWorkingIndex, assertCompanyGitWorkingIndexForChanges, findCompanyGitTreeEntry,
  findCompanyGitTreeEntryForChange, parseCompanyGitCommitTree } from '../policy/company-git-range-payload.js';
import { COMPANY_APPLY_PACKED_REFS_MAX_BYTES, parseCompanyApplyPackedRefs } from '../policy/company-apply-packed-refs.js';
import { createCompanyGitRangeUnitByteProof, type CompanyGitRangeUnitByteProof } from '../policy/company-git-range-unit-proof.js';
import type { CompanyGitRangeObjectProof } from '../policy/company-git-range-proof.js';
import { derivePersonalSourceView, extractPersonalCollectionEvidence, getPersonalCollectionProfile } from '../policy/personal-readonly-collection.js';
import { assertMigrationPartialRuntimePath } from '../policy/migration-check.js';
import { canonicalReadonlyJson, hashReadonlyValue, normalizeReadonlyRanges } from '../policy/readonly-investigation-policy.js';
import { assertCompanyGitRangeUnitSourcePath, createCompanyGitRangeUnitFiles } from './company-git-range-unit-files.js';
import { createCompanyGitRangeSourceFailure, type CompanyGitRangeSourceFailureReason } from '../policy/company-git-range-source-failure.js';

const limits = getCompanyGitRangeUnitProfile().limits;
const collectionLimits = getPersonalCollectionProfile().limits;
type Files = ReturnType<typeof createCompanyGitRangeUnitFiles>;
type File = NonNullable<ReturnType<Files['open']>>;
const fail = (suffix = 'INVALID_SOURCE', reason: CompanyGitRangeSourceFailureReason = 'unexpected'): never => {
  throw suffix === 'INVALID_SOURCE' ? createCompanyGitRangeSourceFailure(reason) : new HarnessError(`COMPANY_GIT_RANGE_${suffix}`);
};
const throwCleanupFailure = (error: unknown, alreadyFailed: boolean): void => { if (!alreadyFailed) throw error; };
const oid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const digest = (value: unknown): string => hashReadonlyValue(canonicalReadonlyJson(value));
const inputKeys = ['version', 'profileHash', 'guardPolicyHash', 'sourceRoot', 'baseCommit', 'selectedPaths'];

/** Internal reader input, not a company registration, policy approval, or CLI command. */
export interface CompanyGitRangeUnitSourceRequest {
  readonly version: 'company-git-range-source-v2';
  readonly profileHash: string;
  readonly guardPolicyHash: string;
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
export interface CompanyGitRangeUnitSourceObservation {
  readonly version: 'company-git-range-source-observation-v2';
  readonly profileHash: string;
  readonly guardPolicyHash: string;
  readonly baseCommit: string;
  readonly integrityScope: 'selected-object-chain';
  readonly packChecksum: 'not_checked';
  readonly unvisitedObjects: 'not_checked';
  readonly selectedFiles: readonly CompanyGitRangeSelectedFile[];
  readonly packs: readonly { readonly path: string; readonly metadata: CompanyGitRangePackMetadata;
    readonly byteProof: CompanyGitRangeUnitByteProof | null }[];
  readonly looseObjects: readonly LooseProof[];
  readonly fileSystem: ReturnType<Files['proof']>;
  readonly proofHash: string;
}
export interface CompanyGitRangeUnitSource {
  inspect(): CompanyGitRangeUnitSourceObservation;
  verify(): CompanyGitRangeUnitSourceObservation;
  snapshot(): CompanyGitRangeUnitBudgetSnapshot;
  close(): void;
}
interface ApplySelection { readonly absentPaths: readonly string[]; readonly baseBranch: string; readonly targetBranch: string }
interface ApplyRefProof { readonly packedRefsHash: string | null; readonly baseRefKind: 'loose' | 'packed' }
export interface CompanyGitRangeApplySourceObservation extends Omit<CompanyGitRangeUnitSourceObservation, 'version'>, ApplyRefProof {
  readonly version: 'company-git-range-apply-observation-v1';
  readonly absentPaths: readonly string[];
  readonly workingIndexHash: string;
}
export interface CompanyGitRangeApplySource {
  inspect(): CompanyGitRangeApplySourceObservation;
  verify(): CompanyGitRangeApplySourceObservation;
  snapshot(): CompanyGitRangeUnitBudgetSnapshot;
  close(): void;
}
export interface CompanyGitRangeUnitCollectionSource {
  inspect(): { observation: CompanyGitRangeUnitSourceObservation; collected: PersonalCollectionEvidence };
  verify(): { observation: CompanyGitRangeUnitSourceObservation; budget: CompanyGitRangeUnitBudgetSnapshot };
  snapshot(): CompanyGitRangeUnitBudgetSnapshot;
  close(): void;
}
interface CollectionSelection { readonly repoId: string; readonly readRanges: readonly ReadonlyRange[] }
interface RetainedSource { readonly bytes: Buffer; readonly memoryLease: CompanyGitRangeMemoryLease }
interface PassResult { observation: CompanyGitRangeUnitSourceObservation; collected?: PersonalCollectionEvidence }

/** Snapshot data properties before any path observation. No getters or model-supplied capabilities are accepted. */
const parseRequest = (value: unknown): CompanyGitRangeUnitSourceRequest => {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== inputKeys.length) return fail('INVALID_SOURCE_INPUT');
    const fields = Object.fromEntries(inputKeys.map(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) return fail('INVALID_SOURCE_INPUT');
      return [key, property.value];
    }));
    if (fields.version !== 'company-git-range-source-v2' || fields.profileHash !== getCompanyGitRangeUnitProfileHash() || fields.guardPolicyHash !== getCompanyGitRangeUnitGuardPolicyHash()
      || typeof fields.sourceRoot !== 'string' || fields.sourceRoot.length > 4096 || fields.sourceRoot.includes('\0')
      || resolve(fields.sourceRoot) !== fields.sourceRoot || !oid(fields.baseCommit)) return fail('INVALID_SOURCE_INPUT');
    assertMigrationPartialRuntimePath(fields.sourceRoot);
    const paths: unknown = fields.selectedPaths;
    if (!Array.isArray(paths) || types.isProxy(paths) || Object.getPrototypeOf(paths) !== Array.prototype
      || paths.length < 1 || paths.length > collectionLimits.files || Reflect.ownKeys(paths).length !== paths.length + 1) return fail('INVALID_SOURCE_INPUT');
    const selectedPaths = Array.from({ length: paths.length }, (_, position) => {
      const property = Object.getOwnPropertyDescriptor(paths, String(position));
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) return fail('INVALID_SOURCE_INPUT');
      return assertCompanyGitRangeUnitSourcePath(property.value);
    }).sort();
    if (new Set(selectedPaths).size !== selectedPaths.length) return fail('INVALID_SOURCE_INPUT');
    return Object.freeze({ version: 'company-git-range-source-v2', profileHash: fields.profileHash, guardPolicyHash: fields.guardPolicyHash,
      sourceRoot: fields.sourceRoot, baseCommit: fields.baseCommit, selectedPaths: Object.freeze(selectedPaths) });
  } catch { return fail('INVALID_SOURCE_INPUT'); }
};

/** Separate apply input; it does not widen the version-two read-only input or profile. */
const parseApplyRequest = (value: unknown): { request: CompanyGitRangeUnitSourceRequest; selection: ApplySelection } => {
  try {
    const keys = [...inputKeys, 'absentPaths', 'baseBranch', 'targetBranch'];
    if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== keys.length) return fail('INVALID_SOURCE_INPUT');
    const fields = Object.fromEntries(keys.map(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) return fail('INVALID_SOURCE_INPUT');
      return [key, property.value];
    }));
    if (fields.version !== 'company-git-range-apply-source-v1' || typeof fields.baseBranch !== 'string'
      || typeof fields.targetBranch !== 'string' || !validRef(`refs/heads/${fields.baseBranch}`)
      || !validRef(`refs/heads/${fields.targetBranch}`) || fields.baseBranch.toLowerCase() === fields.targetBranch.toLowerCase()) return fail('INVALID_SOURCE_INPUT');
    const paths = (input: unknown): string[] => {
      if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype
        || input.length > collectionLimits.files || Reflect.ownKeys(input).length !== input.length + 1) return fail('INVALID_SOURCE_INPUT');
      return Array.from({ length: input.length }, (_, position) => {
        const property = Object.getOwnPropertyDescriptor(input, String(position));
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) return fail('INVALID_SOURCE_INPUT');
        return assertCompanyGitRangeUnitSourcePath(property.value);
      });
    };
    const selectedPaths = paths(fields.selectedPaths), absentPaths = paths(fields.absentPaths).sort();
    const combined = [...selectedPaths, ...absentPaths], folded = combined.map(path => path.toLowerCase());
    for (let index = 0; index < folded.length; index++) for (let other = index + 1; other < folded.length; other++) {
      if (folded[index] === folded[other] || folded[index]!.startsWith(`${folded[other]!}/`) || folded[other]!.startsWith(`${folded[index]!}/`)) return fail('INVALID_SOURCE_INPUT');
    }
    const request = parseRequest({ version: 'company-git-range-source-v2', profileHash: fields.profileHash, guardPolicyHash: fields.guardPolicyHash,
      sourceRoot: fields.sourceRoot, baseCommit: fields.baseCommit, selectedPaths: combined });
    return { request, selection: Object.freeze({ absentPaths: Object.freeze(absentPaths), baseBranch: fields.baseBranch, targetBranch: fields.targetBranch }) };
  } catch { return fail('INVALID_SOURCE_INPUT'); }
};

const parseCollectionSelection = (value: unknown, request: CompanyGitRangeUnitSourceRequest): CollectionSelection => {
  const data = (input: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      || Reflect.ownKeys(input).length !== keys.length) return fail('INVALID_SOURCE_INPUT');
    return Object.fromEntries(keys.map(key => {
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) return fail('INVALID_SOURCE_INPUT');
      return [key, property.value];
    }));
  };
  try {
    const fields = data(value, ['repoId', 'readRanges']), inputRanges = fields.readRanges;
    if (typeof fields.repoId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(fields.repoId)
      || !Array.isArray(inputRanges) || types.isProxy(inputRanges) || Object.getPrototypeOf(inputRanges) !== Array.prototype
      || inputRanges.length < 1 || inputRanges.length > 1024 || Reflect.ownKeys(inputRanges).length !== inputRanges.length + 1) return fail('INVALID_SOURCE_INPUT');
    const ranges = Array.from({ length: inputRanges.length }, (_, position) => {
      const property = Object.getOwnPropertyDescriptor(inputRanges, String(position));
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) return fail('INVALID_SOURCE_INPUT');
      const range = data(property.value, ['path', 'startLine', 'endLine']);
      return { path: assertCompanyGitRangeUnitSourcePath(range.path), startLine: range.startLine as number, endLine: range.endLine as number };
    });
    const readRanges = normalizeReadonlyRanges(ranges, [...request.selectedPaths]);
    if (canonicalReadonlyJson([...new Set(readRanges.map(range => range.path))].sort()) !== canonicalReadonlyJson(request.selectedPaths)) {
      return fail('INVALID_SOURCE_INPUT');
    }
    return Object.freeze({ repoId: fields.repoId, readRanges: Object.freeze(readRanges.map(range => Object.freeze(range))) });
  } catch { return fail('INVALID_SOURCE_INPUT'); }
};

const viewProof = (view: PersonalSourceView): PersonalSourceViewProof => Object.freeze({ path: view.path,
  sourceHash: view.sourceHash, sourceBytes: view.sourceBytes, sourceLines: view.sourceLines, viewHash: view.viewHash,
  viewBytes: view.viewBytes, viewLines: view.viewLines, rawSensitiveCheck: view.rawSensitiveCheck,
  viewSensitiveCheck: view.viewSensitiveCheck, maskCount: view.maskCount, maskedLines: view.maskedLines });

/**
 * Only these fixed pure transforms see retained source bytes. Reserve conservative backing space for the
 * collector's source/view/extraction Buffer copies, including a possible pool backing and redaction expansion.
 * Returned excerpts/proofs are bounded JS data, not managed Buffer leases; JS strings/native scratch are not RSS limits.
 */
const collectSources = (request: CompanyGitRangeUnitSourceRequest, selection: CollectionSelection,
  sources: Map<string, RetainedSource>, budget: CompanyGitRangeUnitBudget, now: () => number): PersonalCollectionEvidence => {
  const evidence = new Array<ReadonlyEvidence>(selection.readRanges.length), sourceViews: PersonalSourceViewProof[] = [];
  let evidenceBytes = 0;
  for (const path of request.selectedPaths) {
    budget.checkActive(now());
    const source = sources.get(path);
    if (!source) return fail();
    budget.assertMemory(source.memoryLease, source.bytes.buffer.byteLength);
    const poolBytes = Buffer.poolSize;
    if (!Number.isSafeInteger(poolBytes) || poolBytes < 0) return fail('INVALID_SOURCE');
    const copies = Math.max(source.bytes.length, poolBytes)
      // A multiline sensitive span can expand once per nonempty line before the fixed view-size check rejects it.
      + Math.max(source.bytes.length * '[REDACTED]'.length, poolBytes)
      + Math.max(collectionLimits.fullViewBytes, poolBytes);
    const temporary = budget.reserveMemory(copies);
    try {
      let view: PersonalSourceView;
      try { view = derivePersonalSourceView(path, source.bytes); }
      catch { return fail('INVALID_SOURCE', 'safe_view'); }
      sourceViews.push(viewProof(view));
      for (const [position, range] of selection.readRanges.entries()) {
        if (range.path !== path) continue;
        let item: ReadonlyEvidence;
        try { item = extractPersonalCollectionEvidence(selection.repoId, request.baseCommit, range, view); }
        catch { return fail('INVALID_SOURCE', 'excerpt'); }
        const bytes = Buffer.byteLength(item.excerpt);
        if (evidenceBytes + bytes > collectionLimits.evidenceBytes) {
          budget.failLimit('evidenceBytes', evidenceBytes, bytes, collectionLimits.evidenceBytes);
        }
        evidenceBytes += bytes;
        evidence[position] = Object.freeze(item);
      }
      budget.checkActive(now());
    } finally { budget.releaseMemory(temporary); }
  }
  return Object.freeze({ evidence: Object.freeze(evidence) as unknown as ReadonlyEvidence[],
    sourceViews: Object.freeze(sourceViews) as unknown as PersonalSourceViewProof[] });
};

interface Pack {
  path: string;
  file: File;
  index: CompanyGitRangeIndex;
  metadata: CompanyGitRangePackMetadata;
  roots: Set<string>;
  objects: Map<string, CompanyGitRangeObjectProof>;
}

const withFileBytes = <T>(files: Files, budget: CompanyGitRangeUnitBudget, path: string, maximum: number,
  action: (bytes: Buffer, mode: number, memoryLease: CompanyGitRangeMemoryLease) => T, optional = false): T | undefined => {
  const file = files.open(path, maximum, optional);
  if (!file) return undefined;
  let failed = false;
  try {
    const kind = /^\.git\/objects\/pack\/pack-[a-f0-9]{40}\.idx$/u.test(path) ? 'pack-index'
      : path.startsWith('.git/') ? 'git-file' : 'selected-file';
    const read = file.readUnit(kind, 0, file.size);
    try { file.close(); return action(read.bytes, file.mode, read.memoryLease); }
    finally { budget.releaseMemory(read.memoryLease); }
  } catch (error) { failed = true; throw error; }
  finally { try { file.close(); } catch (error) { throwCleanupFailure(error, failed); } }
};
const validRef = (name: string): boolean => name.length <= 512 && /^refs\/[a-zA-Z0-9_./-]+$/u.test(name)
  && !name.endsWith('/') && !name.includes('//') && !name.includes('..')
  && !name.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'));

const verifyHead = (files: Files, budget: CompanyGitRangeUnitBudget, baseCommit: string): void => {
  const head = withFileBytes(files, budget, '.git/HEAD', limits.gitFileBytes, bytes => bytes.toString('utf8'));
  if (head === `${baseCommit}\n`) return;
  if (head === undefined || head.length > 520) return fail('INVALID_SOURCE', 'head_ref');
  const match = /^ref: (refs\/heads\/[a-zA-Z0-9_./-]+)\n$/u.exec(head);
  if (!match || !validRef(match[1]!)) return fail('INVALID_SOURCE', 'head_ref');
  const ref = match[1]!;
  const loose = withFileBytes(files, budget, `.git/${ref}`, limits.gitFileBytes, bytes => bytes.toString('utf8'), true);
  if (loose !== undefined) { if (loose !== `${baseCommit}\n`) fail('INVALID_SOURCE', 'head_ref'); return; }
  withFileBytes(files, budget, '.git/packed-refs', limits.gitFileBytes, bytes => {
    let cursor = 0, found = 0, canPeel = false;
    while (cursor < bytes.length) {
      const end = bytes.indexOf(10, cursor);
      if (end < 0) return fail('INVALID_SOURCE', 'head_ref');
      const line = bytes.toString('utf8', cursor, end); cursor = end + 1;
      if (line.startsWith('#')) { canPeel = false; continue; }
      if (/^\^[a-f0-9]{40}$/u.test(line) && canPeel) { canPeel = false; continue; }
      const entry = /^([a-f0-9]{40}) (refs\/[a-zA-Z0-9_./-]+)$/u.exec(line);
      if (!entry || !validRef(entry[2]!)) return fail('INVALID_SOURCE', 'head_ref');
      canPeel = true;
      if (entry[2] === ref && (++found !== 1 || entry[1] !== baseCommit)) return fail('INVALID_SOURCE', 'head_ref');
    }
    if (found !== 1) fail('INVALID_SOURCE', 'head_ref');
  });
};

const verifyApplyHead = (files: Files, budget: CompanyGitRangeUnitBudget, baseCommit: string, selection: ApplySelection): ApplyRefProof => {
  const base = `refs/heads/${selection.baseBranch}`, target = `refs/heads/${selection.targetBranch}`;
  const head = withFileBytes(files, budget, '.git/HEAD', 1024, bytes => bytes.toString('utf8'));
  if (head !== `ref: ${base}\n`) return fail('INVALID_SOURCE', 'head_ref');
  const loose = withFileBytes(files, budget, `.git/${base}`, 1024, bytes => bytes.toString('utf8'), true);
  const packed = withFileBytes(files, budget, '.git/packed-refs', COMPANY_APPLY_PACKED_REFS_MAX_BYTES,
    bytes => ({ entries: parseCompanyApplyPackedRefs(bytes), hash: hashReadonlyValue(bytes) }), true);
  const folded = target.toLowerCase();
  if (packed?.entries.some(entry => entry.ref.toLowerCase() === folded || entry.ref.toLowerCase().startsWith(`${folded}/`)
    || folded.startsWith(`${entry.ref.toLowerCase()}/`))) return fail('INVALID_SOURCE', 'head_ref');
  const targetFile = files.open(`.git/${target}`, 1024, true);
  if (targetFile) { targetFile.close(); return fail('INVALID_SOURCE', 'head_ref'); }
  if (loose !== undefined ? loose !== `${baseCommit}\n` : packed?.entries.find(entry => entry.ref === base)?.oid !== baseCommit) return fail('INVALID_SOURCE', 'head_ref');
  return Object.freeze({ packedRefsHash: packed?.hash ?? null, baseRefKind: loose === undefined ? 'packed' : 'loose' });
};

const openPacks = (files: Files, budget: CompanyGitRangeUnitBudget, now: () => number, packs: Pack[]): void => {
  budget.setStage('pack_inventory');
  for (const name of files.listPacks()) {
    const path = `.git/objects/pack/${name.replace(/\.idx$/u, '.pack')}`;
    budget.setStage('pack_inventory');
    const file = files.open(path, limits.packBytes)!;
    let index: CompanyGitRangeIndex | undefined, retained = false, failed = false;
    try {
      budget.setStage('pack_index');
      index = withFileBytes(files, budget, `.git/objects/pack/${name}`, limits.indexBytes,
        bytes => parseCompanyGitRangeIndex(bytes, file.size, budget, now()))!;
      budget.setStage('pack_header');
      const header = file.readUnit('pack-header', 0, 12);
      try {
        const trailer = file.readUnit('pack-trailer', file.size - 20, 20);
        try {
          const metadata = validateCompanyGitRangePackHeader(header.bytes, trailer.bytes, index, budget, now());
          packs.push({ path, file, index, metadata, roots: new Set(), objects: new Map() }); retained = true;
        } finally { budget.releaseMemory(trailer.memoryLease); }
      } finally { budget.releaseMemory(header.memoryLease); }
    } catch (error) { failed = true; throw error; }
    finally {
      if (!retained) {
        let cleanupFailed = false, cleanupError: unknown;
        try { index?.release(); }
        catch (error) { cleanupFailed = true; cleanupError = error; }
        try { file.close(); }
        catch (error) { if (!cleanupFailed) cleanupError = error; cleanupFailed = true; }
        if (cleanupFailed) throwCleanupFailure(cleanupError, failed);
      }
    }
  }
};

/** Each base stays within the already validated pack/index; no fallback or second decoder pass is used. */
const loadPacked = (pack: Pack, entry: CompanyGitRangeIndexEntry, budget: CompanyGitRangeUnitBudget,
  now: () => number): CompanyGitVerifiedObject => {
  budget.checkActive(now());
  const dependency = budget.enterDependency(`${pack.index.summary.indexSha256}:${entry.offset}:${entry.oid}`);
  let decoded: CompanyGitDecodedObject | undefined, base: CompanyGitVerifiedObject | undefined;
  let result: CompanyGitVerifiedObject | undefined, transferred = false;
  try {
    const read = pack.file.readUnit('pack-object', entry.offset, entry.length);
    try { decoded = decodeCompanyGitPackedObject(read.bytes, entry, pack.index.summary.indexSha256, budget, now()); }
    finally { budget.releaseMemory(read.memoryLease); }
    if (decoded.type === 'ofs-delta' || decoded.type === 'ref-delta') {
      if (!decoded.base) return fail('INVALID_SOURCE', 'delta_base');
      const baseEntry = decoded.base.kind === 'oid' ? pack.index.find(decoded.base.oid, now()) : pack.index.atOffset(decoded.base.offset, now());
      if (!baseEntry) return fail('INVALID_SOURCE', 'delta_base');
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
 * The company v3 adapter selects this read-unit contract; older company paths retain their original reader.
 * The trusted clock is sampled at I/O/codec boundaries; a synchronous operation is not forcibly preempted here.
 */
const createSource = (request: CompanyGitRangeUnitSourceRequest, clock: () => number, collection?: CollectionSelection, apply?: ApplySelection) => {
  const now = (): number => { try { return clock(); } catch { return fail(); } };
  const budget = new CompanyGitRangeUnitBudget(now());
  let firstProof: string | undefined, firstCollectionHash: string | undefined;
  let applyRefProof: ApplyRefProof | undefined;
  let applyIndexHash: string | undefined;
  const runPass = (pass: 'inspect' | 'verify', sources: Map<string, RetainedSource>): CompanyGitRangeUnitSourceObservation => {
    let files: Files | undefined;
    let failed = false;
    const packs: Pack[] = [];
    try {
      budget.setStage('budget'); budget.beginPass(pass, now());
      budget.setStage('head');
      files = createCompanyGitRangeUnitFiles(request.sourceRoot, request.selectedPaths, budget, now);
      if (apply) applyRefProof = verifyApplyHead(files, budget, request.baseCommit, apply);
      else verifyHead(files, budget, request.baseCommit);
      openPacks(files, budget, now, packs);
      const looseObjects = new Map<string, LooseProof>();
      const load = (wanted: string): CompanyGitVerifiedObject => {
        budget.setStage('git_object');
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
        return fail('INVALID_SOURCE', 'object_lookup');
      };
      const consume = <T>(wanted: string, expected: 'commit' | 'tree' | 'blob', action: (object: CompanyGitVerifiedObject) => T): T => {
        const object = load(wanted);
        try {
          if (object.type !== expected) return fail('INVALID_SOURCE', 'object_type');
          budget.setStage(expected === 'blob' ? 'selected_file' : expected);
          return action(object);
        }
        finally { budget.releaseMemory(object.memoryLease); }
      };
      const rootTree = consume(request.baseCommit, 'commit', object => parseCompanyGitCommitTree(object.bytes, budget, now()));
      const selectedEntries = new Map<string, { oid: string; mode: '100644' | '100755' }>();
      const absent = new Set(apply?.absentPaths ?? []);
      const selectedPaths = request.selectedPaths.map(path => ({ path, parts: path.split('/') }));
      const resolveTree = (treeOid: string, paths: typeof selectedPaths, depth: number): void => {
        const children = new Map<string, typeof selectedPaths>();
        for (const selected of paths) {
          const name = selected.parts[depth]!;
          const group = children.get(name);
          if (group) group.push(selected); else children.set(name, [selected]);
        }
        // Resolve only this prefix's requested names while its verified body is owned by consume.
        // The parser still validates the whole tree for every name. Only small mode/OID metadata
        // survives the release; no body, parsed-tree cache or cross-path OID cache is retained.
        const resolved = consume(treeOid, 'tree', object => [...children].map(([name, group]) => ({
          group, entry: (apply ? findCompanyGitTreeEntryForChange : findCompanyGitTreeEntry)(object.bytes, name, budget, now()),
        })));
        for (const { group, entry } of resolved) {
          if (!entry) {
            if (apply && group.every(selected => absent.has(selected.path))) continue;
            return fail('INVALID_SOURCE', 'tree_selection');
          }
          const leaf = group.find(selected => selected.parts.length === depth + 1);
          if (leaf) {
            if (absent.has(leaf.path)) return fail('INVALID_SOURCE', 'tree_selection');
            if (group.length !== 1 || entry.mode !== '100644' && entry.mode !== '100755') return fail('INVALID_SOURCE', 'tree_selection');
            selectedEntries.set(leaf.path, { oid: entry.oid, mode: entry.mode });
          } else {
            if (entry.mode !== '40000') return fail('INVALID_SOURCE', 'tree_selection');
            resolveTree(entry.oid, group, depth + 1);
          }
        }
      };
      // Each path prefix is resolved independently even if different directories share a tree OID.
      // The same bounded traversal starts from fresh objects again in the verification pass.
      resolveTree(rootTree, selectedPaths, 0);
      const selectedFiles: CompanyGitRangeSelectedFile[] = [];
      let applySourceBytes = 0;
      for (const path of request.selectedPaths) {
        if (absent.has(path)) {
          const existing = files.open(path, collectionLimits.sourceFileBytes, true);
          if (existing) { existing.close(); return fail('SOURCE_CHANGED'); }
          continue;
        }
        const selected = selectedEntries.get(path);
        if (!selected) return fail('INVALID_SOURCE', 'tree_selection');
        consume(selected.oid, 'blob', object => {
          if (object.bytes.length > collectionLimits.sourceFileBytes) return fail('INVALID_SOURCE', 'source_size');
          if (apply && (applySourceBytes += object.bytes.length) > 131_072) return fail('INVALID_SOURCE', 'source_size');
          withFileBytes(files!, budget, path, collectionLimits.sourceFileBytes, (bytes, fileMode, memoryLease) => {
            if (!bytes.equals(object.bytes) || Boolean(fileMode & 0o111) !== (selected.mode === '100755')) return fail('SOURCE_CHANGED');
            selectedFiles.push(Object.freeze({ path, oid: selected.oid, mode: selected.mode, sha256: hashReadonlyValue(bytes), bytes: bytes.length }));
            if (collection) sources.set(path, { bytes, memoryLease: budget.retainMemory(memoryLease) });
          });
        });
      }
      budget.setStage('working_index');
      withFileBytes(files, budget, '.git/index', apply ? 1_048_576 : limits.gitFileBytes, bytes => {
        if (apply) {
          applyIndexHash = hashReadonlyValue(bytes);
          return assertCompanyGitWorkingIndexForChanges(bytes, selectedFiles.map(({ path, oid, mode }) => ({ path, oid, mode })), apply.absentPaths, budget, now());
        }
        return assertCompanyGitWorkingIndex(bytes, selectedFiles.map(({ path, oid, mode }) => ({ path, oid, mode })), budget, now());
      });
      budget.setStage('final_guard');
      files.assertUnchanged();
      const packProofs = packs.map(pack => Object.freeze({ path: pack.path, metadata: pack.metadata,
        byteProof: pack.roots.size ? createCompanyGitRangeUnitByteProof(JSON.stringify({ pack: pack.metadata,
          rootOids: [...pack.roots].sort(), objects: [...pack.objects.values()].sort((left, right) => left.offset - right.offset) })) : null }));
      const fields = { version: 'company-git-range-source-observation-v2' as const, profileHash: request.profileHash, guardPolicyHash: request.guardPolicyHash,
        baseCommit: request.baseCommit, integrityScope: 'selected-object-chain' as const,
        packChecksum: 'not_checked' as const, unvisitedObjects: 'not_checked' as const,
        selectedFiles: Object.freeze(selectedFiles), packs: Object.freeze(packProofs),
        looseObjects: Object.freeze([...looseObjects.values()].sort((left, right) => left.oid.localeCompare(right.oid))), fileSystem: files.proof() };
      return Object.freeze({ ...fields, proofHash: digest(fields) });
    } catch (error) {
      failed = true; budget.abort();
      if (error instanceof HarnessError && error.code.startsWith('COMPANY_GIT_RANGE_')) throw error;
      return fail();
    } finally {
      budget.setStage('cleanup');
      // Keep the first failure and its pre-cleanup diagnostic; uncertain closes retain their descriptor charge.
      let cleanupFailed = false, cleanupError: unknown;
      for (const pack of packs) {
        try { pack.index.release(); }
        catch (error) { if (!cleanupFailed) cleanupError = error; cleanupFailed = true; }
      }
      try { files?.close(); }
      catch (error) { if (!cleanupFailed) cleanupError = error; cleanupFailed = true; }
      if (cleanupFailed) throwCleanupFailure(cleanupError, failed);
    }
  };
  const execute = (pass: 'inspect' | 'verify'): PassResult => {
    const sources = new Map<string, RetainedSource>();
    try {
      const result = runPass(pass, sources);
      if (pass === 'verify' && result.proofHash !== firstProof) return fail('SOURCE_CHANGED');
      // Ordinary owned source buffers may survive endPass; no cache or file descriptor survives this boundary.
      budget.setStage('budget');
      if (pass === 'inspect') budget.endPass(now());
      budget.setStage('safe_view');
      const collected = collection ? collectSources(request, collection, sources, budget, now) : undefined;
      if (pass === 'verify' && collected && digest(collected) !== firstCollectionHash) return fail('SOURCE_CHANGED');
      budget.setStage('budget');
      if (pass === 'verify') budget.endPass(now());
      if (pass === 'inspect') { firstProof = result.proofHash; firstCollectionHash = collected ? digest(collected) : undefined; }
      return collected ? { observation: result, collected } : { observation: result };
    } catch (error) {
      budget.abort();
      if (error instanceof HarnessError && /^COMPANY_GIT_RANGE_[A-Z_]+$/u.test(error.code)) throw error;
      return fail();
    } finally {
      for (const source of sources.values()) budget.releaseMemory(source.memoryLease);
      sources.clear();
    }
  };
  return Object.freeze({ inspect: () => execute('inspect'), verify: () => execute('verify'), snapshot: () => budget.snapshot(),
    applyRefs: (): ApplyRefProof => applyRefProof ?? fail(),
    applyIndexHash: (): string => applyIndexHash ?? fail(),
    close: () => { firstProof = undefined; firstCollectionHash = undefined; if (budget.snapshot().phase !== 'complete') budget.abort(); } });
};

/** New mixed replace/create proof uses the unchanged reader budget and fresh two-pass verification. */
export const createCompanyGitRangeApplySource = (input: unknown, clock: () => number = () => performance.now()): CompanyGitRangeApplySource => {
  const { request, selection } = parseApplyRequest(input), source = createSource(request, clock, undefined, selection);
  const observation = (value: CompanyGitRangeUnitSourceObservation): CompanyGitRangeApplySourceObservation => {
    const fields = { ...value, version: 'company-git-range-apply-observation-v1' as const,
      absentPaths: selection.absentPaths, workingIndexHash: source.applyIndexHash(), ...source.applyRefs() };
    return Object.freeze({ ...fields, proofHash: digest(Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'proofHash'))) });
  };
  return Object.freeze({ inspect: () => observation(source.inspect().observation), verify: () => observation(source.verify().observation),
    snapshot: source.snapshot, close: source.close });
};

/** Metadata-only reader entry point; company v3 uses the separate fixed safe-collection entry point below. */
export const createCompanyGitRangeUnitSource = (input: unknown, clock: () => number = () => performance.now()): CompanyGitRangeUnitSource => {
  const source = createSource(parseRequest(input), clock);
  return Object.freeze({ inspect: () => source.inspect().observation, verify: () => source.verify().observation,
    snapshot: source.snapshot, close: source.close });
};

/** Fixed safe collection only; no caller callback, raw-buffer return, transport or extra source read is exposed. */
export const createCompanyGitRangeUnitCollectionSource = (input: unknown, selection: unknown,
  clock: () => number = () => performance.now()): CompanyGitRangeUnitCollectionSource => {
  const request = parseRequest(input), collection = parseCollectionSelection(selection, request);
  const source = createSource(request, clock, collection);
  return Object.freeze({ inspect: () => {
    const result = source.inspect();
    if (!result.collected) return fail();
    return Object.freeze({ observation: result.observation, collected: result.collected });
  }, verify: () => Object.freeze({ observation: source.verify().observation, budget: source.snapshot() }),
  snapshot: source.snapshot, close: source.close });
};
