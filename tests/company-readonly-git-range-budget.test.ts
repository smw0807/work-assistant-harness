import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompanyGitRangeDependencyLease, CompanyGitRangeInflationReceipt,
  CompanyGitRangeMemoryLease, CompanyGitRangeReadReceipt } from '../src/domain/company-git-range.js';
import { CompanyGitRangeBudget, getCompanyGitRangeProfile, getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { getPersonalCollectionProfileHash } from '../src/policy/personal-readonly-collection.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const mib = 1024 * 1024;
const limits = getCompanyGitRangeProfile().limits;
const active = (): CompanyGitRangeBudget => { const budget = new CompanyGitRangeBudget(0); budget.beginPass('inspect', 0); return budget; };
const read = (budget: CompanyGitRangeBudget, requested: number, returned = requested): void => {
  budget.completeRead(budget.reserveRead(requested), returned);
};
const inflate = (budget: CompanyGitRangeBudget, maximum: number, actual = maximum): void => {
  budget.completeInflation(budget.reserveInflation(maximum), actual);
};
const limited = (operation: () => unknown): void => { assert.throws(operation, { code: 'COMPANY_GIT_RANGE_LIMIT' }); };
const invalid = (operation: () => unknown): void => { assert.throws(operation, { code: 'COMPANY_GIT_RANGE_INVALID_BUDGET' }); };

test('Git range profile freezes every limit and binds the unchanged collection profile separately', () => {
  const previous = getPersonalCollectionProfileHash(), profile = getCompanyGitRangeProfile();
  assert.equal(profile.policy, 'company-git-range-reader-v1');
  assert.equal(profile.integrityScope, 'selected-object-chain');
  assert.equal(profile.packChecksum, 'not_checked'); assert.equal(profile.unvisitedObjects, 'not_checked');
  assert.deepEqual(profile.contentPasses, ['inspect', 'verify']); assert.equal(profile.collectionProfileHash, previous);
  assert.deepEqual(profile.limits, {
    packBytes: 512 * mib, indexBytes: 8 * mib, indexObjects: 131072, indexBytesPerPass: 8 * mib, indexObjectsPerPass: 262144,
    gitFileBytes: 8 * mib, workingIndexObjects: 65536, packDirectoryEntries: 64, candidatePairs: 8,
    readChunkBytes: 65536, encodedObjectBytes: 2 * mib, objectBytes: mib, looseHeaderBytes: 128,
    dependencyNodes: 32, visitedObjects: 256, inflations: 512, inflatedBytes: 16 * mib,
    readBytesPerPass: 32 * mib, readBytes: 64 * mib, readCalls: 4096, metadataCalls: 8192, openDescriptors: 32,
    managedBytes: 32 * mib, cacheBytes: 8 * mib, oldSpaceMiB: 128, rssTargetBytes: 256 * mib,
    wallClockMs: 30000, terminationGraceMs: 250,
  });
  assert.equal(Reflect.set(profile, 'packChecksum', 'verified'), false);
  assert.equal(Reflect.set(profile.limits, 'readBytes', Number.MAX_SAFE_INTEGER), false);
  assert.equal(Reflect.set(profile.contentPasses, '0', 'verify'), false);
  assert.equal(getCompanyGitRangeProfileHash(), hashReadonlyValue(canonicalReadonlyJson(profile)));
  assert.notEqual(getCompanyGitRangeProfileHash(), previous); assert.equal(getPersonalCollectionProfileHash(), previous);
});

test('the budget permits exactly inspect then verify with an allocation-only collect interval', () => {
  const budget = active(); read(budget, 8); budget.endPass(1);
  assert.equal(budget.snapshot().phase, 'between');
  const collectBuffer = budget.reserveMemory(128); budget.assertMemory(collectBuffer, 128);
  budget.beginPass('verify', 2); read(budget, 8); budget.endPass(3);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.phase, 'complete'); assert.equal(snapshot.completedPasses, 2);
  assert.equal(snapshot.readBytesReserved, 16); assert.equal(snapshot.readBytesReturned, 16);
  budget.releaseMemory(collectBuffer); assert.equal(budget.snapshot().liveMemoryBytes, 0);
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot.passes), true);
  assert.equal(Reflect.set(snapshot.passes.inspect, 'readBytesReserved', 0), false);
  invalid(() => budget.beginPass('inspect', 4));
  for (const action of [
    (value: CompanyGitRangeBudget) => value.beginPass('verify', 0),
    (value: CompanyGitRangeBudget) => value.reserveRead(1),
    (value: CompanyGitRangeBudget) => value.endPass(0),
  ]) invalid(() => action(new CompanyGitRangeBudget(0)));
  const between = active(); between.endPass(0); invalid(() => between.reserveRead(1));
});

test('read requests consume their entire reservation even when short or unsuccessful', () => {
  const budget = active(); read(budget, limits.readChunkBytes, 3);
  const failed = budget.reserveRead(limits.readChunkBytes); budget.failRead(failed);
  const snapshot = budget.snapshot();
  assert.equal(snapshot.readBytesReserved, 2 * limits.readChunkBytes); assert.equal(snapshot.readBytesReturned, 3);
  assert.equal(snapshot.readCalls, 2); assert.equal(snapshot.pendingReads, 0);
  assert.equal(snapshot.failureCode, 'COMPANY_GIT_RANGE_ABORTED');
  assert.throws(() => budget.reserveRead(0), { code: 'COMPANY_GIT_RANGE_ABORTED' });
  const oversized = active(); limited(() => oversized.reserveRead(limits.readChunkBytes + 1));
  assert.equal(oversized.snapshot().readBytesReserved, 0); assert.equal(oversized.snapshot().readCalls, 0);
});

test('each pass has 32MiB while the same request retains both reservations up to 64MiB', () => {
  const budget = active();
  for (const pass of ['inspect', 'verify'] as const) {
    if (pass === 'verify') budget.beginPass(pass, 1);
    for (let index = 0; index < limits.readBytesPerPass / limits.readChunkBytes; index++) read(budget, limits.readChunkBytes);
    assert.equal(budget.snapshot().passes[pass].readBytesReserved, limits.readBytesPerPass);
    budget.endPass(1);
  }
  assert.equal(budget.snapshot().readBytesReserved, limits.readBytes);
  assert.equal(budget.snapshot().readBytesReturned, limits.readBytes);
  invalid(() => budget.beginPass('verify', 2));
  const overflow = active();
  for (let index = 0; index < limits.readBytesPerPass / limits.readChunkBytes; index++) read(overflow, limits.readChunkBytes);
  limited(() => overflow.reserveRead(1));
  assert.equal(overflow.snapshot().readBytesReserved, limits.readBytesPerPass);
  limited(() => overflow.beginPass('verify', 1));
});

test('read and metadata API counts are cumulative and reject one beyond their fixed ceilings', () => {
  const reads = active();
  for (let index = 0; index < limits.readCalls; index++) read(reads, 1);
  limited(() => reads.reserveRead(1)); assert.equal(reads.snapshot().readCalls, limits.readCalls);
  const metadata = active();
  for (let index = 0; index < limits.metadataCalls / 2; index++) metadata.chargeMetadata('lstat');
  metadata.endPass(0); metadata.beginPass('verify', 0);
  for (let index = 0; index < limits.metadataCalls / 2; index++) metadata.chargeMetadata('fstat');
  limited(() => metadata.chargeMetadata('open')); assert.equal(metadata.snapshot().metadataCalls, limits.metadataCalls);
  const wrongOperation = active(); invalid(() => wrongOperation.chargeMetadata('readFile' as 'lstat'));
});

test('read receipts cannot be forged, transferred, completed twice or used to claim extra returned bytes', () => {
  const budget = active(), receipt = budget.reserveRead(4), other = active();
  invalid(() => other.completeRead(receipt, 4)); assert.equal(budget.snapshot().pendingReads, 1);
  invalid(() => budget.completeRead(receipt, 5)); budget.failRead(receipt);
  assert.equal(budget.snapshot().readBytesReturned, 0); assert.equal(budget.snapshot().readBytesReserved, 4);
  const forged = active(); invalid(() => forged.completeRead({} as CompanyGitRangeReadReceipt, 0));
  const duplicate = active(), completed = duplicate.reserveRead(4); duplicate.completeRead(completed, 4);
  invalid(() => duplicate.completeRead(completed, 0)); assert.equal(duplicate.snapshot().readBytesReturned, 4);
});

test('memory reservations include cache and retain shared backing until the final view releases it', () => {
  const budget = active(), backing = budget.reserveMemory(limits.managedBytes), view = budget.retainMemory(backing);
  budget.assertMemory(view, limits.managedBytes); assert.equal(budget.snapshot().liveMemoryBytes, limits.managedBytes);
  budget.releaseMemory(backing); assert.equal(budget.snapshot().liveMemoryBytes, limits.managedBytes);
  limited(() => budget.reserveMemory(1)); budget.releaseMemory(view);
  assert.equal(budget.snapshot().liveMemoryBytes, 0); assert.equal(budget.snapshot().peakMemoryBytes, limits.managedBytes);
  const cached = active(), cache = cached.reserveMemory(limits.cacheBytes, 'cache');
  const work = cached.reserveMemory(limits.managedBytes - limits.cacheBytes);
  assert.equal(cached.snapshot().liveMemoryBytes, limits.managedBytes);
  assert.equal(cached.snapshot().cacheMemoryBytes, limits.cacheBytes);
  limited(() => cached.reserveMemory(1, 'cache')); cached.releaseMemory(work); cached.releaseMemory(cache);
  assert.equal(cached.snapshot().cacheMemoryBytes, 0);
  const cacheOverflow = active(); limited(() => cacheOverflow.reserveMemory(limits.cacheBytes + 1, 'cache'));
});

test('memory leases reject foreign, copied, released and wrong-capacity capabilities', () => {
  const budget = active(), lease = budget.reserveMemory(64, 'cache'), other = active();
  invalid(() => other.releaseMemory(lease)); budget.assertMemory(lease, 64, 'cache');
  budget.releaseMemory(lease); invalid(() => budget.assertMemory(lease, 1));
  const forged = active(); invalid(() => forged.releaseMemory({} as CompanyGitRangeMemoryLease));
  const copied = active(), original = copied.reserveMemory(4);
  invalid(() => copied.releaseMemory({ ...original })); copied.releaseMemory(original);
  const double = active(), once = double.reserveMemory(0); double.releaseMemory(once); invalid(() => double.releaseMemory(once));
  const capacity = active(), small = capacity.reserveMemory(4); invalid(() => capacity.assertMemory(small, 5)); capacity.releaseMemory(small);
  const kind = active(), buffer = kind.reserveMemory(1); invalid(() => kind.assertMemory(buffer, 1, 'cache')); kind.releaseMemory(buffer);
});

test('inflation settles actual output but failures retain the maximum and reconstruction shares the same total', () => {
  const budget = active(); inflate(budget, limits.objectBytes, 7);
  budget.chargeReconstruction(11);
  assert.equal(budget.snapshot().outputBytesCharged, 18); assert.equal(budget.snapshot().inflationBytesActual, 7);
  const failed = budget.reserveInflation(limits.objectBytes + limits.looseHeaderBytes); budget.failInflation(failed);
  assert.equal(budget.snapshot().outputBytesCharged, 18 + limits.objectBytes + limits.looseHeaderBytes);
  assert.equal(budget.snapshot().pendingInflations, 0); assert.equal(budget.snapshot().reconstructionBytes, 11);
  const oversized = active(); limited(() => oversized.reserveInflation(limits.objectBytes + limits.looseHeaderBytes + 1));
  const reconstruction = active(); limited(() => reconstruction.chargeReconstruction(limits.objectBytes + 1));
});

test('two passes share inflated and reconstructed bytes even when each object fits its own bound', () => {
  const budget = active();
  for (let index = 0; index < 4; index++) { inflate(budget, limits.objectBytes); budget.chargeReconstruction(limits.objectBytes); }
  budget.endPass(1); budget.beginPass('verify', 1);
  for (let index = 0; index < 4; index++) { inflate(budget, limits.objectBytes); budget.chargeReconstruction(limits.objectBytes); }
  assert.equal(budget.snapshot().outputBytesCharged, limits.inflatedBytes);
  limited(() => budget.reserveInflation(1)); assert.equal(budget.snapshot().inflations, 8);
  const count = active();
  for (let index = 0; index < limits.inflations; index++) inflate(count, 0);
  limited(() => count.reserveInflation(0)); assert.equal(count.snapshot().inflations, limits.inflations);
});

test('inflation receipts reject oversized results and forgery while allowing conservative failure cleanup', () => {
  const budget = active(), receipt = budget.reserveInflation(5);
  invalid(() => budget.completeInflation(receipt, 6)); budget.failInflation(receipt);
  assert.equal(budget.snapshot().outputBytesCharged, 5); assert.equal(budget.snapshot().pendingInflations, 0);
  const forged = active(); invalid(() => forged.completeInflation({} as CompanyGitRangeInflationReceipt, 0));
  const duplicate = active(), completed = duplicate.reserveInflation(5); duplicate.completeInflation(completed, 2);
  invalid(() => duplicate.completeInflation(completed, 0)); assert.equal(duplicate.snapshot().outputBytesCharged, 2);
});

test('index admission checks per-file, candidate count and aggregate ceilings and resets only pass-local admission', () => {
  const budget = active();
  for (const pass of ['inspect', 'verify'] as const) {
    if (pass === 'verify') budget.beginPass(pass, 1);
    budget.admitDirectory(limits.packDirectoryEntries, limits.candidatePairs);
    budget.admitIndex('first', limits.indexBytesPerPass / 2, limits.indexObjects);
    budget.admitIndex('second', limits.indexBytesPerPass / 2, limits.indexObjects);
    budget.admitIndex('first', limits.indexBytesPerPass / 2, limits.indexObjects);
    assert.equal(budget.snapshot().passes[pass].indexBytes, limits.indexBytesPerPass);
    assert.equal(budget.snapshot().passes[pass].indexObjects, limits.indexObjectsPerPass);
    budget.endPass(1);
  }
  for (const action of [
    (value: CompanyGitRangeBudget) => value.admitIndex('file', limits.indexBytes + 1, 0),
    (value: CompanyGitRangeBudget) => value.admitIndex('file', 1, limits.indexObjects + 1),
    (value: CompanyGitRangeBudget) => value.admitDirectory(limits.packDirectoryEntries + 1, 0),
    (value: CompanyGitRangeBudget) => value.admitDirectory(64, limits.candidatePairs + 1),
  ]) limited(() => action(active()));
  const bytes = active(); bytes.admitIndex('first', limits.indexBytes, 0); limited(() => bytes.admitIndex('second', 1, 0));
  const objects = active(); objects.admitIndex('first', 1, limits.indexObjects); objects.admitIndex('second', 1, limits.indexObjects);
  limited(() => objects.admitIndex('third', 1, 1));
  const pairs = active(); for (let index = 0; index < limits.candidatePairs; index++) pairs.admitIndex(`index:${index}`, 1, 0);
  limited(() => pairs.admitIndex('extra', 1, 0));
  const mismatch = active(); mismatch.admitIndex('same', 1, 0); invalid(() => mismatch.admitIndex('same', 2, 0));
});

test('unique object identities persist across passes and distinct offsets remain distinct', () => {
  const budget = active();
  for (let index = 0; index < limits.visitedObjects; index++) budget.visitObject(`synthetic-pack:${index}`);
  budget.endPass(0); budget.beginPass('verify', 0);
  for (let index = 0; index < limits.visitedObjects; index++) budget.visitObject(`synthetic-pack:${index}`);
  assert.equal(budget.snapshot().visitedObjects, limits.visitedObjects);
  limited(() => budget.visitObject('synthetic-pack:extra'));
});

test('dependency chains reject cycles, excessive depth and non-LIFO leave while valid cleanup remains possible', () => {
  const budget = active(), leases: CompanyGitRangeDependencyLease[] = [];
  for (let index = 0; index < limits.dependencyNodes; index++) leases.push(budget.enterDependency(`object:${index}`));
  assert.equal(budget.snapshot().dependencyDepth, limits.dependencyNodes);
  limited(() => budget.enterDependency('extra'));
  for (const lease of leases.reverse()) budget.leaveDependency(lease);
  assert.equal(budget.snapshot().dependencyDepth, 0);
  const cycle = active(), first = cycle.enterDependency('same'); invalid(() => cycle.enterDependency('same')); cycle.leaveDependency(first);
  const order = active(), outer = order.enterDependency('outer'), inner = order.enterDependency('inner');
  invalid(() => order.leaveDependency(outer)); order.leaveDependency(inner); order.leaveDependency(outer);
  invalid(() => order.leaveDependency(outer));
});

test('descriptor leases enforce the live limit and can be released after a sticky limit failure', () => {
  const budget = active(), leases = Array.from({ length: limits.openDescriptors }, () => budget.reserveDescriptor());
  limited(() => budget.reserveDescriptor()); for (const lease of leases) budget.releaseDescriptor(lease);
  assert.equal(budget.snapshot().openDescriptors, 0); assert.equal(budget.snapshot().peakOpenDescriptors, limits.openDescriptors);
  limited(() => budget.releaseDescriptor(leases[0]!));
});

test('logical time is finite, monotonic and shares one deadline without reading a clock or accepting overrides', () => {
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, {}]) {
    invalid(() => new CompanyGitRangeBudget(value as number));
  }
  const budget = active(); budget.checkActive(limits.wallClockMs - 1);
  assert.throws(() => budget.checkActive(limits.wallClockMs), { code: 'COMPANY_GIT_RANGE_TIMEOUT' });
  assert.throws(() => budget.beginPass('verify', limits.wallClockMs), { code: 'COMPANY_GIT_RANGE_TIMEOUT' });
  const reversed = active(); reversed.checkActive(10); invalid(() => reversed.checkActive(9));
  const shared = active(); shared.endPass(limits.wallClockMs - 1);
  assert.throws(() => shared.beginPass('verify', limits.wallClockMs), { code: 'COMPANY_GIT_RANGE_TIMEOUT' });
  const fractional = new CompanyGitRangeBudget(0.25); fractional.beginPass('inspect', 0.5); fractional.endPass(0.75);
  fractional.beginPass('verify', 1.25); fractional.endPass(1.5); assert.equal(fractional.snapshot().lastNowMs, 1.5);
  assert.equal(Reflect.set(new CompanyGitRangeBudget(0), 'reserveRead', () => ({})), false);
  assert.equal(Object.isFrozen(CompanyGitRangeBudget.prototype), true);
});

test('cache leases must be completely released before changing passes while ordinary output may remain', () => {
  const budget = active(), cached = budget.reserveMemory(1, 'cache'), retained = budget.retainMemory(cached);
  budget.releaseMemory(cached); invalid(() => budget.endPass(0)); budget.releaseMemory(retained);
  assert.equal(budget.snapshot().cacheMemoryBytes, 0);
  const valid = active(), output = valid.reserveMemory(8), cache = valid.reserveMemory(8, 'cache');
  valid.releaseMemory(cache); valid.endPass(0); valid.beginPass('verify', 0);
  valid.assertMemory(output, 8); valid.endPass(0); valid.releaseMemory(output);
  assert.equal(valid.snapshot().phase, 'complete');
  const zero = active(), emptyCache = zero.reserveMemory(0, 'cache'); invalid(() => zero.endPass(0)); zero.releaseMemory(emptyCache);
});

test('a pass cannot end with pending work and abort keeps cleanup capabilities without resetting counters', () => {
  const readBudget = active(), receipt = readBudget.reserveRead(4); invalid(() => readBudget.endPass(0)); readBudget.failRead(receipt);
  const inflationBudget = active(), inflation = inflationBudget.reserveInflation(4);
  invalid(() => inflationBudget.endPass(0)); inflationBudget.failInflation(inflation);
  const fdBudget = active(), fd = fdBudget.reserveDescriptor(); invalid(() => fdBudget.endPass(0)); fdBudget.releaseDescriptor(fd);
  const dependencyBudget = active(), dependency = dependencyBudget.enterDependency('object');
  invalid(() => dependencyBudget.endPass(0)); dependencyBudget.leaveDependency(dependency);
  const budget = active(), memory = budget.reserveMemory(8), descriptor = budget.reserveDescriptor();
  read(budget, 8, 2); budget.abort(); budget.abort(); budget.releaseDescriptor(descriptor); budget.releaseMemory(memory);
  const snapshot = budget.snapshot(); assert.equal(snapshot.phase, 'failed'); assert.equal(snapshot.failureCode, 'COMPANY_GIT_RANGE_ABORTED');
  assert.equal(snapshot.readBytesReserved, 8); assert.equal(snapshot.readBytesReturned, 2);
  assert.equal(snapshot.liveMemoryBytes, 0); assert.equal(snapshot.openDescriptors, 0);
  assert.throws(() => budget.beginPass('inspect', 0), { code: 'COMPANY_GIT_RANGE_ABORTED' });
});

test('invalid primitive charges cannot invoke getters or make partial accounting updates', () => {
  let reads = 0;
  const malicious = Object.defineProperty({}, 'valueOf', { get() { reads++; throw new Error('SYNTHETIC_GETTER'); } });
  for (const value of [malicious, -1, NaN, Infinity, 0.25]) {
    const budget = active(); invalid(() => budget.reserveMemory(value as number));
    assert.equal(budget.snapshot().liveMemoryBytes, 0);
  }
  assert.equal(reads, 0);
  const budget = active(), first = budget.reserveMemory(1); budget.assertMemory(first, 0); budget.releaseMemory(first);
  const empty = budget.reserveMemory(0); budget.releaseMemory(empty); inflate(budget, 0); read(budget, 0);
  assert.equal(budget.snapshot().readBytesReserved, 0); assert.equal(budget.snapshot().outputBytesCharged, 0);
});
