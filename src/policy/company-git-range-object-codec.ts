import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { inflateSync } from 'node:zlib';
import { HarnessError } from '../domain/errors.js';
import type { CompanyGitRangeMemoryLease } from '../domain/company-git-range.js';
import { getCompanyGitRangeProfile } from './company-git-range-budget.js';
import type { CompanyGitRangeBudgetOperations } from '../domain/company-git-range-budget-operations.js';

type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
type PackedType = ObjectType | 'ofs-delta' | 'ref-delta';
type BaseReference = Readonly<{ kind: 'offset'; offset: number }> | Readonly<{ kind: 'oid'; oid: string }>;
export interface CompanyGitPackedEntry { readonly oid: string; readonly offset: number; readonly length: number; readonly crc32: number }
export interface CompanyGitPackedHeader {
  readonly type: PackedType; readonly size: number; readonly headerBytes: number; readonly base: BaseReference | null;
}
export interface CompanyGitDecodedObject {
  readonly type: PackedType; readonly oid: string; readonly offset: number | null;
  readonly base: BaseReference | null; readonly encodedSha256: string;
  /** Caller-owned standalone backing. Retain a lease for live views; release only after all consumers discard them. */
  readonly bytes: Buffer; readonly memoryLease: CompanyGitRangeMemoryLease;
}
export interface CompanyGitVerifiedObject extends CompanyGitDecodedObject { readonly type: ObjectType }
export interface CompanyGitPackedRecord { readonly entry: CompanyGitPackedEntry; readonly bytes: Uint8Array }

const limits = getCompanyGitRangeProfile().limits;
const fail = (suffix = 'INVALID_OBJECT'): never => { throw new HarnessError(`COMPANY_GIT_RANGE_${suffix}`); };
const isOid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const objectOid = (type: ObjectType, bytes: Uint8Array): string =>
  createHash('sha1').update(`${type} ${bytes.byteLength}\0`).update(bytes).digest('hex');
const isObjectType = (type: PackedType): type is ObjectType => ['commit', 'tree', 'blob', 'tag'].includes(type);
const ownRecord = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length) return fail();
  return Object.fromEntries(keys.map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return fail();
    return [key, field.value];
  }));
};

const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;

/** Intrinsic getters bypass shadowing properties. No iterator, valueOf or caller buffer method is invoked. */
const byteView = (value: unknown, maximum: number): Uint8Array => {
  try {
    if (!ArrayBuffer.isView(value) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value))) return fail('INVALID_BYTES');
    for (const key of ['buffer', 'byteOffset', 'byteLength', 'length', 'constructor', 'valueOf', 'toString', 'subarray', 'slice', 'set', 'copy',
      Symbol.iterator, Symbol.toPrimitive, Symbol.toStringTag]) {
      if (Object.hasOwn(value, key)) return fail('INVALID_BYTES');
    }
    const backing = typedBuffer.call(value) as ArrayBuffer;
    // ArrayBuffer's intrinsic rejects SharedArrayBuffer even if its prototype has been replaced.
    bufferLength.call(backing);
    if (Object.getPrototypeOf(backing) !== ArrayBuffer.prototype || resizable?.call(backing)) return fail('INVALID_BYTES');
    const length = typedLength.call(value) as number, offset = typedOffset.call(value) as number;
    if (!integer(length, 0, maximum)) return fail('INVALID_BYTES');
    return new Uint8Array(backing, offset, length);
  } catch { return fail('INVALID_BYTES'); }
};

interface OwnedBytes { bytes: Buffer; memoryLease: CompanyGitRangeMemoryLease }
const allocate = (length: number, budget: CompanyGitRangeBudgetOperations): OwnedBytes => {
  const memoryLease = budget.reserveMemory(length);
  try { return { bytes: Buffer.allocUnsafeSlow(length), memoryLease }; }
  catch (error) { budget.releaseMemory(memoryLease); throw error; }
};
const snapshot = (value: unknown, maximum: number, budget: CompanyGitRangeBudgetOperations): OwnedBytes => {
  const view = byteView(value, maximum), owned = allocate(view.byteLength, budget);
  try { Uint8Array.prototype.set.call(owned.bytes, view); return owned; }
  catch (error) { budget.releaseMemory(owned.memoryLease); throw error; }
};
const run = <T>(budget: CompanyGitRangeBudgetOperations, nowMs: number, work: () => T): T => {
  try { budget.setStage('git_object'); budget.checkActive(nowMs); return work(); }
  catch (error) {
    budget.abort();
    if (error instanceof HarnessError && /^COMPANY_GIT_RANGE_(?:INVALID_OBJECT|INVALID_DELTA|INVALID_GRAPH|INVALID_BYTES|LIMIT|INVALID_BUDGET|TIMEOUT|ABORTED)$/u.test(error.code)) throw error;
    return fail();
  }
};
const entrySnapshot = (value: unknown): CompanyGitPackedEntry => {
  const entry = ownRecord(value, ['oid', 'offset', 'length', 'crc32']);
  if (!isOid(entry.oid) || !integer(entry.offset, 12, limits.packBytes - 20)
    || !integer(entry.length, 1, limits.encodedObjectBytes) || entry.offset + entry.length > limits.packBytes - 20
    || !integer(entry.crc32, 0, 0xffffffff)) return fail();
  return Object.freeze({ oid: entry.oid, offset: entry.offset, length: entry.length, crc32: entry.crc32 });
};

const crcTable = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let crc = index; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; return crc >>> 0;
}));
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0;
};
/** CRC is corruption detection only; this helper neither authenticates an index nor verifies an object OID. */
export const companyGitRangeCrc32 = (bytes: unknown): number => crc32(byteView(bytes, limits.encodedObjectBytes));

const packedHeader = (bytes: Uint8Array, offset: number): CompanyGitPackedHeader => {
  let cursor = 0;
  const read = (): number => { const byte = bytes[cursor++]; if (byte === undefined) return fail(); return byte; };
  const first = read(), typesByCode: Partial<Record<number, PackedType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };
  const type = typesByCode[first >>> 4 & 7]; if (!type) return fail();
  let size = first & 15, byte = first, factor = 16, groups = 0;
  while (byte & 128) {
    if (++groups > 3) return fail(); byte = read(); size += (byte & 127) * factor; factor *= 128;
    if (size > limits.objectBytes || !(byte & 128) && !(byte & 127)) return fail();
  }
  let base: BaseReference | null = null;
  if (type === 'ofs-delta') {
    byte = read(); let distance = byte & 127, count = 1;
    while (byte & 128) {
      if (++count > 5) return fail(); byte = read(); distance = (distance + 1) * 128 + (byte & 127);
      if (!Number.isSafeInteger(distance) || distance > limits.packBytes) return fail();
    }
    if (!distance || offset - distance < 12) return fail();
    base = Object.freeze({ kind: 'offset', offset: offset - distance });
  }
  if (type === 'ref-delta') {
    if (cursor + 20 > bytes.byteLength) return fail();
    let oid = ''; for (let index = 0; index < 20; index++) oid += read().toString(16).padStart(2, '0');
    base = Object.freeze({ kind: 'oid', oid });
  }
  if (cursor >= bytes.byteLength) return fail();
  return Object.freeze({ type, size, headerBytes: cursor, base });
};

/** Native zlib is bounded before inflation; its unobservable internal allocations are not claimed as OS memory limits. */
const inflateExact = (compressed: Uint8Array, maximum: number, budget: CompanyGitRangeBudgetOperations): OwnedBytes => {
  const allocationBound = Math.max(1, maximum), reservation = budget.reserveInflation(allocationBound);
  let completed = false, temporary: CompanyGitRangeMemoryLease | undefined;
  try {
    // Account conservatively for zlib's returned chunks/concatenation until a standalone exact-size copy owns the output.
    temporary = budget.reserveMemory(2 * (allocationBound + 65536));
    const result = inflateSync(compressed, { maxOutputLength: allocationBound, chunkSize: 65536, info: true }) as unknown as {
      buffer: Buffer; engine: { bytesWritten: number };
    };
    if (result.buffer.length > maximum || result.engine.bytesWritten !== compressed.byteLength) return fail();
    budget.completeInflation(reservation, result.buffer.length); completed = true;
    budget.assertMemory(temporary, result.buffer.buffer.byteLength);
    return snapshot(result.buffer, maximum, budget);
  } finally {
    if (!completed) budget.failInflation(reservation);
    if (temporary) budget.releaseMemory(temporary);
  }
};

interface OwnedObject { budget: CompanyGitRangeBudgetOperations; data: CompanyGitDecodedObject; contentHash: string }
const ownedObjects = new WeakMap<object, OwnedObject>();
const ownObject = (fields: Omit<CompanyGitDecodedObject, 'bytes' | 'memoryLease'>, content: OwnedBytes,
  budget: CompanyGitRangeBudgetOperations): CompanyGitDecodedObject => {
  const data = Object.freeze({ ...fields, ...content });
  ownedObjects.set(data, { budget, data, contentHash: sha256(content.bytes) }); return data;
};
const ownedObject = (value: unknown, budget: CompanyGitRangeBudgetOperations, verified: boolean): CompanyGitDecodedObject => {
  const record = value && typeof value === 'object' ? ownedObjects.get(value) : undefined;
  if (!record || record.budget !== budget || verified && !isObjectType(record.data.type)) return fail();
  const view = byteView(record.data.bytes, limits.objectBytes);
  budget.assertMemory(record.data.memoryLease, view.buffer.byteLength);
  if (sha256(view) !== record.contentHash || isObjectType(record.data.type) && objectOid(record.data.type, view) !== record.data.oid) return fail();
  return record.data;
};

/** Reject forged, released or mutated output before using it as a verified base/content again. */
export const assertCompanyGitVerifiedObject = (value: unknown, budget: CompanyGitRangeBudgetOperations, nowMs: number): void =>
  run(budget, nowMs, () => { ownedObject(value, budget, true); });

/**
 * Pure span decoding. Entry/index authenticity and actual pack geometry belong to the separate index codec/reader.
 * Inputs are snapshotted; returned bytes belong to the caller. Delta OID verification requires the resolver below.
 */
export const decodeCompanyGitPackedObject = (value: unknown, entryValue: unknown, packIdentity: unknown, budget: CompanyGitRangeBudgetOperations,
  nowMs: number): CompanyGitDecodedObject => run(budget, nowMs, () => {
  if (!isHash(packIdentity)) return fail();
  const entry = entrySnapshot(entryValue); budget.visitObject(`${packIdentity}:${entry.offset}:${entry.oid}`);
  const input = snapshot(value, limits.encodedObjectBytes, budget);
  let content: OwnedBytes | undefined, transferred = false;
  try {
    if (input.bytes.length !== entry.length || crc32(input.bytes) !== entry.crc32) return fail();
    const header = packedHeader(input.bytes, entry.offset);
    content = inflateExact(input.bytes.subarray(header.headerBytes), header.size, budget);
    if (content.bytes.length !== header.size || isObjectType(header.type) && objectOid(header.type, content.bytes) !== entry.oid) return fail();
    const result = ownObject({ type: header.type, oid: entry.oid, offset: entry.offset, base: header.base,
      encodedSha256: sha256(input.bytes) }, content, budget);
    transferred = true; return result;
  } finally {
    if (content && !transferred) budget.releaseMemory(content.memoryLease);
    budget.releaseMemory(input.memoryLease);
  }
});

export const decodeCompanyGitLooseObject = (value: unknown, expectedOid: unknown, budget: CompanyGitRangeBudgetOperations,
  nowMs: number): CompanyGitVerifiedObject => run(budget, nowMs, () => {
  if (!isOid(expectedOid)) return fail();
  budget.visitObject(`loose:${expectedOid}`);
  const input = snapshot(value, limits.gitFileBytes, budget);
  let inflated: OwnedBytes | undefined, content: OwnedBytes | undefined, transferred = false;
  try {
    inflated = inflateExact(input.bytes, limits.objectBytes + limits.looseHeaderBytes, budget);
    const end = inflated.bytes.indexOf(0);
    if (end < 0 || end + 1 > limits.looseHeaderBytes) return fail();
    const header = inflated.bytes.subarray(0, end);
    if (header.some(byte => byte > 127)) return fail();
    const match = /^(commit|tree|blob|tag) (0|[1-9]\d*)$/u.exec(header.toString('ascii'));
    if (!match || !integer(Number(match[2]), 0, limits.objectBytes) || Number(match[2]) !== inflated.bytes.length - end - 1) return fail();
    const type = match[1] as ObjectType;
    content = snapshot(inflated.bytes.subarray(end + 1), limits.objectBytes, budget);
    if (objectOid(type, content.bytes) !== expectedOid) return fail();
    const result = ownObject({ type, oid: expectedOid, offset: null, base: null, encodedSha256: sha256(input.bytes) }, content, budget);
    transferred = true; return result as CompanyGitVerifiedObject;
  } finally {
    if (content && !transferred) budget.releaseMemory(content.memoryLease);
    if (inflated) budget.releaseMemory(inflated.memoryLease);
    budget.releaseMemory(input.memoryLease);
  }
});

/** Validate once before allocation, then replay the same private bytes into the bounded target. No operation list is allocated. */
const walkDelta = (delta: Buffer, base: Buffer, target?: Buffer): number => {
  let cursor = 0, written = 0;
  const read = (): number => { const byte = delta[cursor++]; if (byte === undefined) return fail('INVALID_DELTA'); return byte; };
  const size = (): number => {
    let value = 0, factor = 1;
    for (let index = 0; index < 4; index++) {
      const byte = read(); value += (byte & 127) * factor;
      if (value > limits.objectBytes) return fail('INVALID_DELTA');
      if (!(byte & 128)) { if (index && !(byte & 127)) return fail('INVALID_DELTA'); return value; }
      factor *= 128;
    }
    return fail('INVALID_DELTA');
  };
  if (size() !== base.length) return fail('INVALID_DELTA');
  const targetSize = size();
  while (cursor < delta.length) {
    const opcode = read(); if (!opcode) return fail('INVALID_DELTA');
    let length: number, source: Buffer;
    if (opcode & 128) {
      let offset = 0; length = 0;
      for (let index = 0; index < 4; index++) if (opcode & 1 << index) offset += read() * 2 ** (8 * index);
      for (let index = 0; index < 3; index++) if (opcode & 1 << (index + 4)) length += read() * 2 ** (8 * index);
      if (!length) length = 65536;
      if (offset + length > base.length || written + length > targetSize) return fail('INVALID_DELTA');
      source = base.subarray(offset, offset + length);
    } else {
      length = opcode;
      if (cursor + length > delta.length || written + length > targetSize) return fail('INVALID_DELTA');
      source = delta.subarray(cursor, cursor + length); cursor += length;
    }
    if (target) Uint8Array.prototype.set.call(target, source, written);
    written += length;
  }
  if (written !== targetSize) return fail('INVALID_DELTA');
  return targetSize;
};
const applyDelta = (value: CompanyGitDecodedObject, baseValue: CompanyGitVerifiedObject,
  budget: CompanyGitRangeBudgetOperations): CompanyGitVerifiedObject => {
  const delta = ownedObject(value, budget, false), base = ownedObject(baseValue, budget, true);
  if (isObjectType(delta.type) || !delta.base || base.offset === null
    || (delta.base.kind === 'oid' ? delta.base.oid !== base.oid : delta.base.offset !== base.offset)) return fail('INVALID_DELTA');
  const length = walkDelta(delta.bytes, base.bytes); budget.chargeReconstruction(length);
  const content = allocate(length, budget); let transferred = false;
  try {
    walkDelta(delta.bytes, base.bytes, content.bytes);
    if (objectOid(base.type as ObjectType, content.bytes) !== delta.oid) return fail('INVALID_DELTA');
    const result = ownObject({ type: base.type, oid: delta.oid, offset: delta.offset, base: delta.base,
      encodedSha256: delta.encodedSha256 }, content, budget);
    transferred = true; return result as CompanyGitVerifiedObject;
  } finally { if (!transferred) budget.releaseMemory(content.memoryLease); }
};

/** The positioned reader resolves a same-pack base before applying an issued, still-owned delta. */
export const applyCompanyGitPackedDelta = (delta: unknown, base: unknown, budget: CompanyGitRangeBudgetOperations,
  nowMs: number): CompanyGitVerifiedObject => run(budget, nowMs, () =>
  applyDelta(ownedObject(delta, budget, false), ownedObject(base, budget, true) as CompanyGitVerifiedObject, budget));

/**
 * Resolve a bounded in-memory dependency set declared to belong to one pack. No file or callback is consulted.
 * packIdentity must come from the trusted index/reader; neither this value nor these records prove filesystem provenance.
 * No cache crosses calls/passes. All intermediate buffers are released; only the returned object's lease remains live.
 */
export const resolveCompanyGitPackedObjects = (value: unknown, targetOid: unknown, packIdentity: unknown,
  budget: CompanyGitRangeBudgetOperations, nowMs: number): CompanyGitVerifiedObject => run(budget, nowMs, () => {
  if (!isOid(targetOid) || !isHash(packIdentity) || !Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype || !integer(value.length, 1, limits.visitedObjects)
    || Reflect.ownKeys(value).length !== value.length + 1) return fail('INVALID_GRAPH');
  const byOid = new Map<string, CompanyGitPackedRecord>(), byOffset = new Map<number, CompanyGitPackedRecord>();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail('INVALID_GRAPH');
    const record = ownRecord(descriptor.value, ['entry', 'bytes']), entry = entrySnapshot(record.entry);
    const bytes = byteView(record.bytes, limits.encodedObjectBytes);
    if (bytes.length !== entry.length || byOid.has(entry.oid) || byOffset.has(entry.offset)) return fail('INVALID_GRAPH');
    const copied = { entry, bytes }; byOid.set(entry.oid, copied); byOffset.set(entry.offset, copied);
  }
  const ordered = [...byOffset.values()].sort((left, right) => left.entry.offset - right.entry.offset);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index - 1]!.entry.offset + ordered[index - 1]!.entry.length > ordered[index]!.entry.offset) return fail('INVALID_GRAPH');
  }
  const active = new Set<number>();
  const resolve = (record: CompanyGitPackedRecord | undefined): CompanyGitVerifiedObject => {
    if (!record || active.has(record.entry.offset)) return fail('INVALID_GRAPH');
    budget.checkActive(nowMs);
    const dependency = budget.enterDependency(`${packIdentity}:${record.entry.offset}:${record.entry.oid}`); active.add(record.entry.offset);
    let decoded: CompanyGitDecodedObject | undefined, base: CompanyGitVerifiedObject | undefined, transferred = false;
    try {
      decoded = decodeCompanyGitPackedObject(record.bytes, record.entry, packIdentity, budget, nowMs);
      if (isObjectType(decoded.type)) { transferred = true; return decoded as CompanyGitVerifiedObject; }
      if (!decoded.base) return fail('INVALID_GRAPH');
      base = resolve(decoded.base.kind === 'oid' ? byOid.get(decoded.base.oid) : byOffset.get(decoded.base.offset));
      return applyDelta(decoded, base, budget);
    } finally {
      if (base) budget.releaseMemory(base.memoryLease);
      if (decoded && !transferred) budget.releaseMemory(decoded.memoryLease);
      active.delete(record.entry.offset); budget.leaveDependency(dependency);
    }
  };
  return resolve(byOid.get(targetOid));
});
