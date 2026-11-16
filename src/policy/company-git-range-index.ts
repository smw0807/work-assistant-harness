import { createHash } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import { CompanyGitRangeBudget, getCompanyGitRangeProfile } from './company-git-range-budget.js';

const limits = getCompanyGitRangeProfile().limits;
type Lease = ReturnType<CompanyGitRangeBudget['reserveMemory']>;
export interface CompanyGitRangeIndexEntry { readonly oid: string; readonly offset: number; readonly length: number; readonly crc32: number }
export interface CompanyGitRangeIndexSummary {
  readonly indexSha256: string;
  readonly declaredPackChecksum: string;
  readonly objectCount: number;
  readonly packBytes: number;
}
export interface CompanyGitRangeIndex {
  readonly summary: CompanyGitRangeIndexSummary;
  find(oid: string, nowMs: number): CompanyGitRangeIndexEntry | undefined;
  atOffset(offset: number, nowMs: number): CompanyGitRangeIndexEntry | undefined;
  release(): void;
}
export interface CompanyGitRangePackMetadata extends CompanyGitRangeIndexSummary {
  readonly version: 2 | 3;
  readonly integrityScope: 'selected-object-chain';
  readonly packChecksum: 'not_checked';
  readonly unvisitedObjects: 'not_checked';
}
interface IndexState { budget: CompanyGitRangeBudget; released: boolean; summary: CompanyGitRangeIndexSummary }
const indexStates = new WeakMap<CompanyGitRangeIndex, IndexState>();
const candidateCounts = new WeakMap<CompanyGitRangeBudget, number>();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const nativeGetter = (key: string) => Object.getOwnPropertyDescriptor(typedArrayPrototype, key)!.get!;
const byteLength = nativeGetter('byteLength'), byteOffset = nativeGetter('byteOffset'), arrayBuffer = nativeGetter('buffer');
const backingLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const reject = (code = 'INVALID_INDEX'): never => { throw new HarnessError(`COMPANY_GIT_RANGE_${code}`); };
const fail = (budget: CompanyGitRangeBudget, error: unknown, code: string): never => {
  budget.abort();
  if (error instanceof HarnessError && error.code.startsWith('COMPANY_GIT_RANGE_')) throw error;
  return reject(code);
};
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;

/** Caller-owned input is not an allocation by this codec; the immutable working copy is reserved first. */
const snapshot = (input: Uint8Array, maximum: number, budget: CompanyGitRangeBudget): { bytes: Buffer; lease: Lease } => {
  if (!ArrayBuffer.isView(input) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(input))) reject('INVALID_BYTES');
  const length = Reflect.apply(byteLength, input, []) as number, offset = Reflect.apply(byteOffset, input, []) as number;
  const backing = Reflect.apply(arrayBuffer, input, []) as ArrayBuffer;
  try { Reflect.apply(backingLength, backing, []); } catch { return reject('INVALID_BYTES'); }
  if (Object.getPrototypeOf(backing) !== ArrayBuffer.prototype || resizable?.call(backing) || !integer(length, 0, maximum)) reject('INVALID_BYTES');
  const lease = budget.reserveMemory(length);
  try {
    const bytes = Buffer.alloc(length);
    Uint8Array.prototype.set.call(bytes, new Uint8Array(backing, offset, length));
    return { bytes, lease };
  } catch (error) { budget.releaseMemory(lease); throw error; }
};

/** Pure index-v2 parsing. It never receives a path, opens a file, or validates a whole pack checksum. */
export const parseCompanyGitRangeIndex = (input: Uint8Array, packBytes: number,
  budget: CompanyGitRangeBudget, nowMs: number): CompanyGitRangeIndex => {
  let inputLease: Lease | undefined, orderLease: Lease | undefined, rankLease: Lease | undefined;
  try {
    budget.checkActive(nowMs);
    if (!integer(packBytes, 32, limits.packBytes)) reject();
    const owned = snapshot(input, limits.indexBytes, budget); inputLease = owned.lease;
    let bytes = owned.bytes;
    if (bytes.length < 1072 || bytes.readUInt32BE(0) !== 0xff744f63 || bytes.readUInt32BE(4) !== 2) reject();
    const count = bytes.readUInt32BE(1028);
    if (count > limits.indexObjects || bytes.length !== 1072 + count * 28 || count === 0 && packBytes !== 32
      || !createHash('sha1').update(bytes.subarray(0, -20)).digest().equals(bytes.subarray(-20))) reject();
    const summary = Object.freeze({ indexSha256: createHash('sha256').update(bytes).digest('hex'),
      declaredPackChecksum: bytes.subarray(-40, -20).toString('hex'), objectCount: count, packBytes });
    // Equal bytes do not prove two candidates are the same file. Reuse a handle instead of reparsing to avoid a new admission.
    const candidate = (candidateCounts.get(budget) ?? 0) + 1; candidateCounts.set(budget, candidate);
    budget.admitIndex(`index-codec-candidate:${candidate}`, bytes.length, count);
    const oidStart = 1032, crcStart = oidStart + count * 20, offsetStart = crcStart + count * 4;
    let seen = 0;
    for (let prefix = 0; prefix < 256; prefix++) {
      const end = bytes.readUInt32BE(8 + prefix * 4);
      if (end < seen || end > count) reject();
      for (let position = seen; position < end; position++) {
        const start = oidStart + position * 20;
        if (bytes[start] !== prefix || position > 0 && Buffer.compare(bytes.subarray(start - 20, start), bytes.subarray(start, start + 20)) >= 0) reject();
      }
      seen = end;
    }
    if (seen !== count) reject();
    orderLease = budget.reserveMemory(count * 4); let order = new Uint32Array(count);
    rankLease = budget.reserveMemory(count * 4); let rank = new Uint32Array(count);
    const offsetAt = (position: number): number => bytes.readUInt32BE(offsetStart + position * 4);
    for (let position = 0; position < count; position++) {
      const offset = offsetAt(position);
      if (offset & 0x80000000 || offset < 12 || offset >= packBytes - 20) reject();
      order[position] = position;
    }
    order.sort((left, right) => offsetAt(left) - offsetAt(right));
    for (let position = 0; position < count; position++) {
      if (position === 0 ? offsetAt(order[position]!) !== 12 : offsetAt(order[position - 1]!) >= offsetAt(order[position]!)) reject();
      rank[order[position]!] = position;
    }
    const state: IndexState = { budget, released: false, summary };
    const active = (time: number): void => { budget.checkActive(time); if (state.released) reject('INVALID_INDEX_HANDLE'); };
    const entryAt = (position: number): CompanyGitRangeIndexEntry => {
      const offset = offsetAt(position), next = rank[position]! + 1;
      const length = (next < count ? offsetAt(order[next]!) : packBytes - 20) - offset;
      if (length < 1 || length > limits.encodedObjectBytes) reject('INVALID_SPAN');
      return Object.freeze({ oid: bytes.subarray(oidStart + position * 20, oidStart + (position + 1) * 20).toString('hex'),
        offset, length, crc32: bytes.readUInt32BE(crcStart + position * 4) });
    };
    const handle: CompanyGitRangeIndex = Object.freeze({ summary,
      find: (oid: string, time: number): CompanyGitRangeIndexEntry | undefined => {
        try {
          active(time); if (typeof oid !== 'string' || !/^[a-f0-9]{40}$/u.test(oid)) reject('INVALID_OID');
          let low = 0, high = count;
          while (low < high) {
            const middle = Math.floor((low + high) / 2), candidate = bytes.toString('hex', oidStart + middle * 20, oidStart + (middle + 1) * 20);
            if (candidate < oid) low = middle + 1; else high = middle;
          }
          return low < count && bytes.toString('hex', oidStart + low * 20, oidStart + (low + 1) * 20) === oid ? entryAt(low) : undefined;
        } catch (error) { return fail(budget, error, 'INVALID_INDEX'); }
      },
      atOffset: (offset: number, time: number): CompanyGitRangeIndexEntry | undefined => {
        try {
          active(time); if (!integer(offset, 12, packBytes - 21)) reject('INVALID_SPAN');
          let low = 0, high = count;
          while (low < high) { const middle = Math.floor((low + high) / 2); if (offsetAt(order[middle]!) < offset) low = middle + 1; else high = middle; }
          return low < count && offsetAt(order[low]!) === offset ? entryAt(order[low]!) : undefined;
        } catch (error) { return fail(budget, error, 'INVALID_INDEX'); }
      },
      release: (): void => {
        if (state.released) return fail(budget, new HarnessError('COMPANY_GIT_RANGE_INVALID_INDEX_HANDLE'), 'INVALID_INDEX_HANDLE');
        state.released = true;
        bytes = Buffer.alloc(0); order = new Uint32Array(0); rank = new Uint32Array(0);
        budget.releaseMemory(rankLease!); budget.releaseMemory(orderLease!); budget.releaseMemory(inputLease!);
      },
    });
    indexStates.set(handle, state); return handle;
  } catch (error) {
    budget.abort();
    for (const lease of [rankLease, orderLease, inputLease]) if (lease) budget.releaseMemory(lease);
    return fail(budget, error, 'INVALID_INDEX');
  }
};

export const validateCompanyGitRangePackHeader = (header: Uint8Array, trailer: Uint8Array, index: CompanyGitRangeIndex,
  budget: CompanyGitRangeBudget, nowMs: number): CompanyGitRangePackMetadata => {
  const leases: Lease[] = [];
  try {
    budget.checkActive(nowMs);
    const state = indexStates.get(index);
    if (!state || state.budget !== budget || state.released) return reject('INVALID_INDEX_HANDLE');
    const first = snapshot(header, 12, budget); leases.push(first.lease);
    const last = snapshot(trailer, 20, budget); leases.push(last.lease);
    if (first.bytes.length !== 12 || last.bytes.length !== 20 || first.bytes.toString('ascii', 0, 4) !== 'PACK') reject('INVALID_PACK_HEADER');
    const version = first.bytes.readUInt32BE(4);
    if (![2, 3].includes(version) || first.bytes.readUInt32BE(8) !== state.summary.objectCount
      || last.bytes.toString('hex') !== state.summary.declaredPackChecksum) reject('INVALID_PACK_HEADER');
    return Object.freeze({ ...state.summary, version: version as 2 | 3, integrityScope: 'selected-object-chain',
      packChecksum: 'not_checked', unvisitedObjects: 'not_checked' });
  } catch (error) { return fail(budget, error, 'INVALID_PACK_HEADER'); }
  finally { for (const lease of leases) budget.releaseMemory(lease); }
};
