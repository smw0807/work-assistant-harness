import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { HarnessError } from '../domain/errors.js';
import type { CompanyGitRangeMemoryLease } from '../domain/company-git-range.js';
import { getCompanyGitRangeProfile } from './company-git-range-budget.js';
import type { CompanyGitRangeBudgetOperations } from '../domain/company-git-range-budget-operations.js';
import { getPersonalCollectionProfile } from './personal-readonly-collection.js';

export type CompanyGitTreeMode = '40000' | '100644' | '100755' | '120000' | '160000';
export interface CompanyGitTreeEntry { readonly oid: string; readonly mode: CompanyGitTreeMode }
export interface CompanyGitWorkingSelection { readonly path: string; readonly oid: string; readonly mode: '100644' | '100755' }
const limits = getCompanyGitRangeProfile().limits;
const reject = (): never => { throw new HarnessError('COMPANY_GIT_RANGE_INVALID_PAYLOAD'); };
const isOid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const modes = new Set<CompanyGitTreeMode>(['40000', '100644', '100755', '120000', '160000']);
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const nativeLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const nativeOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const backingLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;

/** Caller inputs remain caller-owned. This codec reserves an independent, non-shared working copy before allocation. */
const snapshot = (value: Uint8Array, maximum: number, budget: CompanyGitRangeBudgetOperations): { bytes: Buffer; lease: CompanyGitRangeMemoryLease } => {
  if (!ArrayBuffer.isView(value) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value))) return reject();
  for (const key of ['length', 'byteLength', 'byteOffset', 'buffer', 'constructor', 'valueOf', 'toString', 'slice', 'subarray',
    Symbol.iterator, Symbol.toPrimitive, Symbol.toStringTag]) if (Object.hasOwn(value, key)) return reject();
  const backing = nativeBuffer.call(value) as ArrayBuffer;
  backingLength.call(backing);
  const length = nativeLength.call(value) as number, offset = nativeOffset.call(value) as number;
  if (Object.getPrototypeOf(backing) !== ArrayBuffer.prototype || resizable?.call(backing)
    || !Number.isSafeInteger(length) || length < 0 || length > maximum) return reject();
  const lease = budget.reserveMemory(length);
  try {
    const bytes = Buffer.allocUnsafeSlow(length); Uint8Array.prototype.set.call(bytes, new Uint8Array(backing, offset, length));
    return { bytes, lease };
  } catch (error) { budget.releaseMemory(lease); throw error; }
};
const parse = <T>(input: Uint8Array, maximum: number, budget: CompanyGitRangeBudgetOperations, nowMs: number,
  operation: (bytes: Buffer) => T): T => {
  let lease: CompanyGitRangeMemoryLease | undefined;
  try {
    budget.checkActive(nowMs);
    const owned = snapshot(input, maximum, budget); lease = owned.lease;
    return operation(owned.bytes);
  } catch (error) {
    budget.abort();
    if (error instanceof HarnessError && ['COMPANY_GIT_RANGE_LIMIT', 'COMPANY_GIT_RANGE_TIMEOUT', 'COMPANY_GIT_RANGE_INVALID_BUDGET',
      'COMPANY_GIT_RANGE_ABORTED', 'COMPANY_GIT_RANGE_INVALID_PAYLOAD'].includes(error.code)) throw error;
    return reject();
  } finally { if (lease) budget.releaseMemory(lease); }
};
const utf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const safeText = (text: string, multiline: boolean): boolean => {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 127 || code < 32 && !(multiline && [9, 10, 13].includes(code)) || code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
};
const safeName = (name: unknown): name is string => {
  if (typeof name !== 'string' || !name || !safeText(name, false) || /[/\\:]/u.test(name)) return false;
  // Keep Git's .git aliases out of path components on both case-insensitive and Unicode-normalizing filesystems.
  const clean = name.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, '');
  const normalized = clean.toLowerCase().replace(/[. ]+$/u, '');
  return clean !== '.' && clean !== '..' && normalized !== '' && normalized !== '.git' && !/^\.?git~[1-9]$/u.test(normalized);
};
const safePath = (path: unknown): path is string => {
  if (typeof path !== 'string' || !path) return false;
  let start = 0;
  while (start <= path.length) {
    const separator = path.indexOf('/', start), end = separator === -1 ? path.length : separator;
    if (!safeName(path.slice(start, end))) return false;
    if (separator === -1) return true;
    start = separator + 1;
  }
  return false;
};

const validIdentity = (text: string): boolean => {
  const match = /^([^<>]+) <([^<>\s]+)> (-?(?:0|[1-9]\d*)) ([+-])(\d{2})(\d{2})$/u.exec(text);
  return Boolean(match && match[1]!.trim() && Number.isSafeInteger(Number(match[3])) && Number(match[5]) <= 23 && Number(match[6]) <= 59);
};

/** Parses structure only: OID/type verification is the object codec's responsibility; authors and signatures are never authenticated. */
export const parseCompanyGitCommitTree = (input: Uint8Array, budget: CompanyGitRangeBudgetOperations, nowMs: number): string =>
  parse(input, limits.objectBytes, budget, nowMs, bytes => {
    const text = utf8(bytes), separator = text.indexOf('\n\n');
    if (separator < 0 || !safeText(text, true)) return reject();
    let cursor = 0, lineNumber = 0, rootTree = '', previous = '', parentsFinished = false;
    let author = false, committer = false;
    while (cursor <= separator) {
      const end = text.indexOf('\n', cursor);
      if (end < cursor || end > separator) return reject();
      const line = text.slice(cursor, end); cursor = end + 1;
      if (!line || line.includes('\r') || line.includes('\t')) return reject();
      if (line.startsWith(' ')) {
        if (!previous || ['tree', 'parent', 'author', 'committer'].includes(previous)) return reject();
        continue;
      }
      const space = line.indexOf(' '), key = line.slice(0, space), value = line.slice(space + 1);
      if (space < 1 || !/^[A-Za-z][A-Za-z0-9-]*$/u.test(key) || !value) return reject();
      if (lineNumber++ === 0) {
        if (key !== 'tree' || !isOid(value)) return reject();
        // Copy the small ASCII OID from bytes so a sliced string cannot retain the entire commit message.
        rootTree = bytes.toString('ascii', 5, 45);
      } else if (key === 'tree') return reject();
      else if (key === 'parent') {
        if (parentsFinished || !isOid(value)) return reject();
      } else {
        parentsFinished = true;
        if (key === 'author') { if (author || !validIdentity(value)) return reject(); author = true; }
        if (key === 'committer') { if (committer || !validIdentity(value)) return reject(); committer = true; }
      }
      previous = key;
    }
    if (!rootTree || !author || !committer) return reject();
    return rootTree;
  });

/** Git compares tree names by UTF-8 bytes, treating a directory as if its name ended in '/'. */
const compareTreeNames = (left: Buffer, leftMode: CompanyGitTreeMode, right: Buffer, rightMode: CompanyGitTreeMode): number => {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) if (left[index] !== right[index]) return left[index]! - right[index]!;
  const nextLeft = left.length > shared ? left[shared]! : leftMode === '40000' ? 47 : 0;
  const nextRight = right.length > shared ? right[shared]! : rightMode === '40000' ? 47 : 0;
  return nextLeft - nextRight;
};

/** Validate the entire tree, including entries after the match. Only one small, immutable selected entry leaves the parser. */
const findTreeEntry = (input: Uint8Array, name: string, budget: CompanyGitRangeBudgetOperations,
  nowMs: number, rejectCaseAliases: boolean): CompanyGitTreeEntry | undefined => parse(input, limits.objectBytes, budget, nowMs, bytes => {
  if (typeof name !== 'string' || name.length > limits.objectBytes || !safeName(name)) return reject();
  let cursor = 0, previousName: Buffer | undefined, previousMode: CompanyGitTreeMode = '100644';
  let selected: CompanyGitTreeEntry | undefined;
  const names = new Set<string>();
  while (cursor < bytes.length) {
    const space = bytes.indexOf(32, cursor), end = bytes.indexOf(0, cursor);
    if (space < cursor || end <= space + 1 || end + 21 > bytes.length) return reject();
    const modeBytes = bytes.subarray(cursor, space);
    if (modeBytes.some(byte => byte > 127)) return reject();
    const mode = modeBytes.toString('ascii') as CompanyGitTreeMode;
    if (!modes.has(mode)) return reject();
    const rawName = bytes.subarray(space + 1, end), entryName = utf8(rawName);
    if (!safeName(entryName) || names.has(entryName) || previousName && compareTreeNames(previousName, previousMode, rawName, mode) >= 0) return reject();
    if (rejectCaseAliases && entryName !== name && entryName.toLowerCase() === name.toLowerCase()) return reject();
    names.add(entryName); previousName = rawName; previousMode = mode;
    if (entryName === name) selected = Object.freeze({ mode, oid: bytes.toString('hex', end + 1, end + 21) });
    cursor = end + 21;
  }
  return selected;
});

export const findCompanyGitTreeEntry = (input: Uint8Array, name: string, budget: CompanyGitRangeBudgetOperations,
  nowMs: number): CompanyGitTreeEntry | undefined => findTreeEntry(input, name, budget, nowMs, false);

/** New write-proof lookup rejects case aliases without changing the older read-only lookup contract. */
export const findCompanyGitTreeEntryForChange = (input: Uint8Array, name: string, budget: CompanyGitRangeBudgetOperations,
  nowMs: number): CompanyGitTreeEntry | undefined => findTreeEntry(input, name, budget, nowMs, true);

const selectionSnapshot = (value: readonly CompanyGitWorkingSelection[], allowEmpty = false): Map<string, CompanyGitWorkingSelection> => {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || !allowEmpty && !value.length
    || value.length > getPersonalCollectionProfile().limits.files || Reflect.ownKeys(value).length !== value.length + 1) return reject();
  const selected = new Map<string, CompanyGitWorkingSelection>();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject();
    const item: unknown = descriptor.value;
    if (!item || typeof item !== 'object' || types.isProxy(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item))
      || Reflect.ownKeys(item).length !== 3) return reject();
    const fields = Object.fromEntries(['path', 'oid', 'mode'].map(key => {
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) return reject();
      return [key, property.value];
    }));
    // These are the existing source reader's selected path length/depth limits, not new Git resource allowances.
    if (typeof fields.path !== 'string' || fields.path.length > 512 || !safePath(fields.path) || fields.path.split('/').length > 16 || !isOid(fields.oid)
      || !['100644', '100755'].includes(fields.mode as string) || selected.has(fields.path)) return reject();
    selected.set(fields.path, { path: fields.path, oid: fields.oid, mode: fields.mode as CompanyGitWorkingSelection['mode'] });
  }
  return selected;
};

/**
 * Validate index-v2/v3 entries and optional extension envelopes. Optional payloads are inert hints, never evidence.
 * Unselected conflict stages/known extended bits may exist; selected entries must match stage zero with no extension flags.
 */
const workingIndex = (input: Uint8Array, selection: readonly CompanyGitWorkingSelection[],
  budget: CompanyGitRangeBudgetOperations, nowMs: number, absence?: readonly string[]): void => parse(input, limits.gitFileBytes, budget, nowMs, bytes => {
  const selected = selectionSnapshot(selection, absence !== undefined), found = new Set<string>();
  const absent = new Set<string>();
  if (absence !== undefined) {
    if (!Array.isArray(absence) || types.isProxy(absence) || Object.getPrototypeOf(absence) !== Array.prototype
      || Reflect.ownKeys(absence).length !== absence.length + 1 || absence.length + selected.size < 1
      || absence.length + selected.size > getPersonalCollectionProfile().limits.files) return reject();
    for (let index = 0; index < absence.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(absence, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject();
      const path: unknown = descriptor.value;
      if (typeof path !== 'string' || path.length > 512 || !safePath(path) || path.split('/').length > 16 || absent.has(path)) return reject();
      absent.add(path);
    }
    const paths = [...selected.keys(), ...absent].map(path => path.toLowerCase());
    for (let index = 0; index < paths.length; index++) for (let other = index + 1; other < paths.length; other++) {
      if (paths[index] === paths[other] || paths[index]!.startsWith(`${paths[other]!}/`) || paths[other]!.startsWith(`${paths[index]!}/`)) return reject();
    }
  }
  const bodyEnd = bytes.length - 20;
  if (bytes.length < 32 || bytes[0] !== 68 || bytes[1] !== 73 || bytes[2] !== 82 || bytes[3] !== 67
    || !createHash('sha1').update(bytes.subarray(0, bodyEnd)).digest().equals(bytes.subarray(bodyEnd))) return reject();
  const version = bytes.readUInt32BE(4), count = bytes.readUInt32BE(8);
  if (![2, 3].includes(version) || count > limits.workingIndexObjects || count * 64 > bodyEnd - 12) return reject();
  let cursor = 12, previousPath: Buffer | undefined, previousStage = 0;
  for (let index = 0; index < count; index++) {
    const start = cursor;
    if (cursor + 62 > bodyEnd) return reject();
    const mode = bytes.readUInt32BE(cursor + 24).toString(8), oid = bytes.toString('hex', cursor + 40, cursor + 60);
    const flags = bytes.readUInt16BE(cursor + 60), stage = flags >>> 12 & 3;
    if (!['100644', '100755', '120000', '160000'].includes(mode)
      || bytes.readUInt32BE(cursor + 4) > 999999999 || bytes.readUInt32BE(cursor + 12) > 999999999) return reject();
    cursor += 62;
    if (flags & 0x4000) {
      if (version !== 3 || cursor + 2 > bodyEnd || bytes.readUInt16BE(cursor) & ~0x6000) return reject();
      cursor += 2;
    }
    const end = bytes.indexOf(0, cursor);
    if (end <= cursor || end >= bodyEnd || (flags & 0xfff) !== Math.min(end - cursor, 0xfff)) return reject();
    const rawPath = bytes.subarray(cursor, end), path = utf8(rawPath);
    if (!safePath(path)) return reject();
    const order = previousPath ? Buffer.compare(previousPath, rawPath) : -1;
    if (order > 0 || order === 0 && (!previousStage || !stage || stage <= previousStage)) return reject();
    previousPath = rawPath; previousStage = stage;
    const next = start + Math.ceil((end + 1 - start) / 8) * 8;
    if (next > bodyEnd) return reject();
    for (let padding = end; padding < next; padding++) if (bytes[padding] !== 0) return reject();
    cursor = next;
    const expected = selected.get(path);
    if (absence !== undefined) {
      const folded = path.toLowerCase();
      for (const missing of absent) {
        const target = missing.toLowerCase();
        if (folded === target || folded.startsWith(`${target}/`) || target.startsWith(`${folded}/`)) return reject();
      }
      for (const target of selected.keys()) {
        const selectedPath = target.toLowerCase();
        if (path !== target && (folded === selectedPath || folded.startsWith(`${selectedPath}/`) || selectedPath.startsWith(`${folded}/`))) return reject();
      }
    }
    if (expected) {
      if (found.has(path) || stage !== 0 || flags & 0x4000 || expected.oid !== oid || expected.mode !== mode) return reject();
      found.add(path);
    }
  }
  const extensions = new Set<string>();
  while (cursor < bodyEnd) {
    if (cursor + 8 > bodyEnd) return reject();
    const signature = bytes.subarray(cursor, cursor + 4);
    if (signature.some(byte => byte > 127)) return reject();
    const name = signature.toString('ascii'), size = bytes.readUInt32BE(cursor + 4);
    if (!/^[A-Z][A-Za-z]{3}$/u.test(name) || extensions.has(name) || size > bodyEnd - cursor - 8) return reject();
    extensions.add(name); cursor += 8 + size;
  }
  if (cursor !== bodyEnd || found.size !== selected.size) return reject();
});

export const assertCompanyGitWorkingIndex = (input: Uint8Array, selection: readonly CompanyGitWorkingSelection[],
  budget: CompanyGitRangeBudgetOperations, nowMs: number): void => workingIndex(input, selection, budget, nowMs);

/** Creates require absence at every index stage, including conflicting case or ancestor/descendant entries. */
export const assertCompanyGitWorkingIndexForChanges = (input: Uint8Array, selection: readonly CompanyGitWorkingSelection[],
  absentPaths: readonly string[], budget: CompanyGitRangeBudgetOperations, nowMs: number): void =>
  workingIndex(input, selection, budget, nowMs, absentPaths);
