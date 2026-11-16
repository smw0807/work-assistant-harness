import { HarnessError } from '../domain/errors.js';
import { COMPANY_GIT_RANGE_POLICY, type CompanyGitRangeBudgetSnapshot, type CompanyGitRangeDependencyLease,
  type CompanyGitRangeDescriptorLease, type CompanyGitRangeInflationReceipt, type CompanyGitRangeMemoryKind,
  type CompanyGitRangeMemoryLease, type CompanyGitRangeMetadataOperation, type CompanyGitRangePass,
  type CompanyGitRangePhase, type CompanyGitRangeProfile, type CompanyGitRangeReadReceipt } from '../domain/company-git-range.js';
import { getPersonalCollectionProfileHash } from './personal-readonly-collection.js';
import { canonicalReadonlyJson, hashReadonlyValue } from './readonly-investigation-policy.js';

const mib = 1024 * 1024;
const limits: CompanyGitRangeProfile['limits'] = Object.freeze({
  packBytes: 512 * mib, indexBytes: 8 * mib, indexObjects: 131072, indexBytesPerPass: 8 * mib, indexObjectsPerPass: 262144,
  gitFileBytes: 8 * mib, workingIndexObjects: 65536, packDirectoryEntries: 64, candidatePairs: 8,
  readChunkBytes: 65536, encodedObjectBytes: 2 * mib, objectBytes: mib, looseHeaderBytes: 128,
  dependencyNodes: 32, visitedObjects: 256, inflations: 512, inflatedBytes: 16 * mib,
  readBytesPerPass: 32 * mib, readBytes: 64 * mib, readCalls: 4096, metadataCalls: 8192, openDescriptors: 32,
  managedBytes: 32 * mib, cacheBytes: 8 * mib, oldSpaceMiB: 128, rssTargetBytes: 256 * mib,
  wallClockMs: 30000, terminationGraceMs: 250,
});
const profile: CompanyGitRangeProfile = Object.freeze({ policy: COMPANY_GIT_RANGE_POLICY,
  integrityScope: 'selected-object-chain', packChecksum: 'not_checked', unvisitedObjects: 'not_checked',
  collectionProfileHash: getPersonalCollectionProfileHash(), contentPasses: Object.freeze(['inspect', 'verify'] as const),
  memoryAccounting: 'managed-backing-buffers-only', clock: 'caller-supplied-monotonic-milliseconds', limits });
const profileHash = hashReadonlyValue(canonicalReadonlyJson(profile));
export const getCompanyGitRangeProfile = (): CompanyGitRangeProfile => profile;
export const getCompanyGitRangeProfileHash = (): string => profileHash;

type FailureCode = 'COMPANY_GIT_RANGE_LIMIT' | 'COMPANY_GIT_RANGE_INVALID_BUDGET'
  | 'COMPANY_GIT_RANGE_TIMEOUT' | 'COMPANY_GIT_RANGE_ABORTED';
interface MemoryGroup { bytes: number; kind: CompanyGitRangeMemoryKind; references: number }
interface MemoryRecord { group: MemoryGroup; live: boolean }
interface Reservation { bytes: number; live: boolean }
interface PassState { readBytesReserved: number; indexBytes: number; indexObjects: number; indexes: Map<string, { bytes: number; objects: number }> }
const passState = (): PassState => ({ readBytesReserved: 0, indexBytes: 0, indexObjects: 0, indexes: new Map() });
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const token = <T extends object>(): T => Object.freeze({}) as T;

/**
 * Pure logical reservations. Trusted callers supply monotonic timestamps, register every operation/allocation,
 * classify cache ownership and retain leases for live views. This cannot police unregistered JavaScript work or RSS.
 */
export class CompanyGitRangeBudget {
  #phase: CompanyGitRangePhase = 'ready';
  #failureCode: FailureCode | null = null;
  readonly #startedAtMs: number;
  #lastNowMs: number;
  #completedPasses = 0;
  readonly #passes = { inspect: passState(), verify: passState() };
  #readBytesReserved = 0;
  #readBytesReturned = 0;
  #readCalls = 0;
  #pendingReads = 0;
  #metadataCalls = 0;
  #inflations = 0;
  #pendingInflations = 0;
  #outputBytesCharged = 0;
  #inflationBytesActual = 0;
  #reconstructionBytes = 0;
  readonly #objects = new Set<string>();
  readonly #dependencies: { identity: string; lease: CompanyGitRangeDependencyLease }[] = [];
  #peakDependencyDepth = 0;
  #liveMemoryBytes = 0;
  #peakMemoryBytes = 0;
  #cacheMemoryBytes = 0;
  #liveCacheAllocations = 0;
  #peakCacheMemoryBytes = 0;
  #openDescriptors = 0;
  #peakOpenDescriptors = 0;
  readonly #memory = new WeakMap<CompanyGitRangeMemoryLease, MemoryRecord>();
  readonly #reads = new WeakMap<CompanyGitRangeReadReceipt, Reservation>();
  readonly #inflation = new WeakMap<CompanyGitRangeInflationReceipt, Reservation>();
  readonly #descriptors = new WeakMap<CompanyGitRangeDescriptorLease, { live: boolean }>();

  constructor(startedAtMs: number) {
    if (!timestamp(startedAtMs) || startedAtMs > Number.MAX_SAFE_INTEGER - limits.wallClockMs) {
      throw new HarnessError('COMPANY_GIT_RANGE_INVALID_BUDGET');
    }
    this.#startedAtMs = startedAtMs; this.#lastNowMs = startedAtMs;
    Object.freeze(this);
  }

  checkActive(nowMs: number): void {
    this.active();
    if (!timestamp(nowMs) || nowMs < this.#lastNowMs) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    this.#lastNowMs = nowMs;
    if (nowMs - this.#startedAtMs >= limits.wallClockMs) this.fail('COMPANY_GIT_RANGE_TIMEOUT');
  }

  beginPass(pass: CompanyGitRangePass, nowMs: number): void {
    this.checkActive(nowMs);
    if (!(pass === 'inspect' && this.#phase === 'ready' || pass === 'verify' && this.#phase === 'between')) {
      this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    }
    this.#phase = pass;
  }

  endPass(nowMs: number): void {
    this.checkActive(nowMs); this.currentPass();
    if (this.#pendingReads || this.#pendingInflations || this.#openDescriptors || this.#dependencies.length || this.#liveCacheAllocations) {
      this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    }
    this.#completedPasses++;
    this.#phase = this.#phase === 'inspect' ? 'between' : 'complete';
  }

  reserveRead(bytes: number): CompanyGitRangeReadReceipt {
    const pass = this.currentPass(); this.amount(bytes, limits.readChunkBytes);
    this.fits(this.#readBytesReserved, bytes, limits.readBytes);
    this.fits(pass.readBytesReserved, bytes, limits.readBytesPerPass); this.fits(this.#readCalls, 1, limits.readCalls);
    const receipt = token<CompanyGitRangeReadReceipt>();
    this.#reads.set(receipt, { bytes, live: true }); this.#pendingReads++;
    this.#readBytesReserved += bytes; pass.readBytesReserved += bytes; this.#readCalls++;
    return receipt;
  }

  completeRead(receipt: CompanyGitRangeReadReceipt, returnedBytes: number): void {
    this.active(); const reservation = this.readReservation(receipt);
    if (!integer(returnedBytes) || returnedBytes > reservation.bytes) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    reservation.live = false; this.#pendingReads--; this.#readBytesReturned += returnedBytes;
  }

  /** A failed I/O still consumes its entire reservation; this only closes its bookkeeping receipt. */
  failRead(receipt: CompanyGitRangeReadReceipt): void {
    const reservation = this.readReservation(receipt); reservation.live = false; this.#pendingReads--; this.abort();
  }

  chargeMetadata(operation: CompanyGitRangeMetadataOperation): void {
    this.currentPass();
    if (!['lstat', 'fstat', 'open', 'realpath', 'readdir'].includes(operation)) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    this.fits(this.#metadataCalls, 1, limits.metadataCalls); this.#metadataCalls++;
  }

  reserveDescriptor(): CompanyGitRangeDescriptorLease {
    this.currentPass(); this.fits(this.#openDescriptors, 1, limits.openDescriptors);
    const lease = token<CompanyGitRangeDescriptorLease>(); this.#descriptors.set(lease, { live: true });
    this.#openDescriptors++; this.#peakOpenDescriptors = Math.max(this.#peakOpenDescriptors, this.#openDescriptors);
    return lease;
  }

  releaseDescriptor(lease: CompanyGitRangeDescriptorLease): void {
    const record = this.#descriptors.get(lease);
    if (!record?.live) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    record.live = false; this.#openDescriptors--;
  }

  reserveMemory(bytes: number, kind: CompanyGitRangeMemoryKind = 'buffer'): CompanyGitRangeMemoryLease {
    this.active(); this.amount(bytes, limits.managedBytes);
    if (kind !== 'buffer' && kind !== 'cache') this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    this.fits(this.#liveMemoryBytes, bytes, limits.managedBytes);
    if (kind === 'cache') this.fits(this.#cacheMemoryBytes, bytes, limits.cacheBytes);
    const group = { bytes, kind, references: 1 }, lease = token<CompanyGitRangeMemoryLease>();
    this.#memory.set(lease, { group, live: true }); this.#liveMemoryBytes += bytes;
    if (kind === 'cache') { this.#cacheMemoryBytes += bytes; this.#liveCacheAllocations++; }
    this.#peakMemoryBytes = Math.max(this.#peakMemoryBytes, this.#liveMemoryBytes);
    this.#peakCacheMemoryBytes = Math.max(this.#peakCacheMemoryBytes, this.#cacheMemoryBytes);
    return lease;
  }

  assertMemory(lease: CompanyGitRangeMemoryLease, expectedBytes: number, kind?: CompanyGitRangeMemoryKind): void {
    this.active(); const record = this.memoryRecord(lease);
    if (!integer(expectedBytes) || expectedBytes > record.group.bytes || kind !== undefined && kind !== record.group.kind) {
      this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    }
  }

  /** Retained views share one backing allocation; its charge remains until every issued lease is released. */
  retainMemory(lease: CompanyGitRangeMemoryLease): CompanyGitRangeMemoryLease {
    this.active(); const { group } = this.memoryRecord(lease), retained = token<CompanyGitRangeMemoryLease>();
    group.references++; this.#memory.set(retained, { group, live: true }); return retained;
  }

  releaseMemory(lease: CompanyGitRangeMemoryLease): void {
    const record = this.memoryRecord(lease); record.live = false; record.group.references--;
    if (record.group.references === 0) {
      this.#liveMemoryBytes -= record.group.bytes;
      if (record.group.kind === 'cache') { this.#cacheMemoryBytes -= record.group.bytes; this.#liveCacheAllocations--; }
    }
  }

  reserveInflation(maxBytes: number): CompanyGitRangeInflationReceipt {
    this.currentPass(); this.amount(maxBytes, limits.objectBytes + limits.looseHeaderBytes);
    this.fits(this.#inflations, 1, limits.inflations); this.fits(this.#outputBytesCharged, maxBytes, limits.inflatedBytes);
    const receipt = token<CompanyGitRangeInflationReceipt>(); this.#inflation.set(receipt, { bytes: maxBytes, live: true });
    this.#pendingInflations++; this.#inflations++; this.#outputBytesCharged += maxBytes; return receipt;
  }

  completeInflation(receipt: CompanyGitRangeInflationReceipt, actualBytes: number): void {
    this.active(); const reservation = this.inflationReservation(receipt);
    if (!integer(actualBytes) || actualBytes > reservation.bytes) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    reservation.live = false; this.#pendingInflations--;
    this.#outputBytesCharged -= reservation.bytes - actualBytes; this.#inflationBytesActual += actualBytes;
  }

  /** Unsuccessful inflation keeps the reserved upper bound charged; no partial output is trusted. */
  failInflation(receipt: CompanyGitRangeInflationReceipt): void {
    const reservation = this.inflationReservation(receipt); reservation.live = false; this.#pendingInflations--; this.abort();
  }

  chargeReconstruction(targetBytes: number): void {
    this.currentPass(); this.amount(targetBytes, limits.objectBytes);
    this.fits(this.#outputBytesCharged, targetBytes, limits.inflatedBytes);
    this.#outputBytesCharged += targetBytes; this.#reconstructionBytes += targetBytes;
  }

  admitDirectory(entryCount: number, candidatePairs: number): void {
    this.currentPass(); this.amount(entryCount, limits.packDirectoryEntries); this.amount(candidatePairs, limits.candidatePairs);
    if (candidatePairs * 2 > entryCount) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
  }

  admitIndex(indexIdentity: string, bytes: number, objects: number): void {
    const pass = this.currentPass(); this.identity(indexIdentity);
    this.amount(bytes, limits.indexBytes); this.amount(objects, limits.indexObjects);
    const previous = pass.indexes.get(indexIdentity);
    if (previous) {
      if (previous.bytes !== bytes || previous.objects !== objects) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
      return;
    }
    this.fits(pass.indexes.size, 1, limits.candidatePairs);
    this.fits(pass.indexBytes, bytes, limits.indexBytesPerPass); this.fits(pass.indexObjects, objects, limits.indexObjectsPerPass);
    pass.indexes.set(indexIdentity, { bytes, objects }); pass.indexBytes += bytes; pass.indexObjects += objects;
  }

  visitObject(objectIdentity: string): void {
    this.currentPass(); this.identity(objectIdentity);
    if (this.#objects.has(objectIdentity)) return;
    this.fits(this.#objects.size, 1, limits.visitedObjects); this.#objects.add(objectIdentity);
  }

  enterDependency(objectIdentity: string): CompanyGitRangeDependencyLease {
    this.currentPass(); this.identity(objectIdentity);
    if (this.#dependencies.some(entry => entry.identity === objectIdentity)) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    this.fits(this.#dependencies.length, 1, limits.dependencyNodes); this.visitObject(objectIdentity);
    const lease = token<CompanyGitRangeDependencyLease>(); this.#dependencies.push({ identity: objectIdentity, lease });
    this.#peakDependencyDepth = Math.max(this.#peakDependencyDepth, this.#dependencies.length); return lease;
  }

  leaveDependency(lease: CompanyGitRangeDependencyLease): void {
    if (!this.#dependencies.length || this.#dependencies.at(-1)!.lease !== lease) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    this.#dependencies.pop();
  }

  abort(): void {
    if (!this.#failureCode) this.#failureCode = 'COMPANY_GIT_RANGE_ABORTED';
    this.#phase = 'failed';
  }

  snapshot(): CompanyGitRangeBudgetSnapshot {
    const pass = (value: PassState) => Object.freeze({ readBytesReserved: value.readBytesReserved,
      indexBytes: value.indexBytes, indexObjects: value.indexObjects, indexes: value.indexes.size });
    return Object.freeze({ profileHash, phase: this.#phase, failureCode: this.#failureCode,
      startedAtMs: this.#startedAtMs, lastNowMs: this.#lastNowMs, completedPasses: this.#completedPasses,
      readBytesReserved: this.#readBytesReserved, readBytesReturned: this.#readBytesReturned,
      readCalls: this.#readCalls, pendingReads: this.#pendingReads, metadataCalls: this.#metadataCalls,
      inflations: this.#inflations, pendingInflations: this.#pendingInflations, outputBytesCharged: this.#outputBytesCharged,
      inflationBytesActual: this.#inflationBytesActual, reconstructionBytes: this.#reconstructionBytes,
      visitedObjects: this.#objects.size, dependencyDepth: this.#dependencies.length, peakDependencyDepth: this.#peakDependencyDepth,
      liveMemoryBytes: this.#liveMemoryBytes, peakMemoryBytes: this.#peakMemoryBytes,
      cacheMemoryBytes: this.#cacheMemoryBytes, peakCacheMemoryBytes: this.#peakCacheMemoryBytes,
      openDescriptors: this.#openDescriptors, peakOpenDescriptors: this.#peakOpenDescriptors,
      passes: Object.freeze({ inspect: pass(this.#passes.inspect), verify: pass(this.#passes.verify) }) });
  }

  private active(): void {
    if (this.#failureCode) throw new HarnessError(this.#failureCode);
    if (this.#phase === 'complete') this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
  }
  private currentPass(): PassState {
    this.active();
    if (this.#phase !== 'inspect' && this.#phase !== 'verify') this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    return this.#passes[this.#phase];
  }
  private amount(value: number, maximum: number): void {
    if (!integer(value)) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
    if (value > maximum) this.fail('COMPANY_GIT_RANGE_LIMIT');
  }
  private fits(current: number, addition: number, maximum: number): void {
    if (addition > maximum - current) this.fail('COMPANY_GIT_RANGE_LIMIT');
  }
  private identity(value: string): void {
    if (!identity(value)) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET');
  }
  private memoryRecord(lease: CompanyGitRangeMemoryLease): MemoryRecord {
    const record = this.#memory.get(lease);
    if (!record?.live) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET'); return record;
  }
  private readReservation(receipt: CompanyGitRangeReadReceipt): Reservation {
    const record = this.#reads.get(receipt);
    if (!record?.live) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET'); return record;
  }
  private inflationReservation(receipt: CompanyGitRangeInflationReceipt): Reservation {
    const record = this.#inflation.get(receipt);
    if (!record?.live) this.fail('COMPANY_GIT_RANGE_INVALID_BUDGET'); return record;
  }
  private fail(code: FailureCode): never {
    if (!this.#failureCode) this.#failureCode = code;
    this.#phase = 'failed'; throw new HarnessError(this.#failureCode);
  }
}
Object.freeze(CompanyGitRangeBudget.prototype);
