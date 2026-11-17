import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessError } from '../src/domain/errors.js';
import { COMPANY_GIT_RANGE_DIAGNOSTIC_STAGES, COMPANY_GIT_RANGE_LIMIT_NAMES, type CompanyGitRangeDiagnosticStage,
  type CompanyGitRangeFailure, type CompanyGitRangeLimitName } from '../src/domain/company-git-range-diagnostic.js';
import { CompanyGitRangeBudget, extractCompanyGitRangeFailure, getCompanyGitRangeProfile,
  getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { getPersonalCollectionProfile } from '../src/policy/personal-readonly-collection.js';

const limits = getCompanyGitRangeProfile().limits;
const active = (): CompanyGitRangeBudget => { const value = new CompanyGitRangeBudget(0); value.beginPass('inspect', 0); return value; };
const errorFrom = (operation: () => unknown, code = 'COMPANY_GIT_RANGE_LIMIT'): HarnessError => {
  try { operation(); } catch (error) { assert.ok(error instanceof HarnessError); assert.equal(error.code, code); return error; }
  assert.fail('Expected the existing failure code');
};
const failureFrom = (operation: () => unknown, code = 'COMPANY_GIT_RANGE_LIMIT'): CompanyGitRangeFailure => {
  const failure = extractCompanyGitRangeFailure(errorFrom(operation, code)); assert.ok(failure); return failure;
};
const read = (budget: CompanyGitRangeBudget, bytes: number): void => { budget.completeRead(budget.reserveRead(bytes), bytes); };

test('diagnostics retain the exact profile hash and leave successful budget snapshots unchanged', () => {
  assert.equal(getCompanyGitRangeProfileHash(), '8fc98736b72781db4567c808f6dca086b8b9ec1a4f97eb5e551d8ee0c3f210b6');
  const budget = active(); budget.setStage('git_object'); read(budget, 3); budget.endPass(1);
  budget.setStage('final_guard'); budget.beginPass('verify', 2); read(budget, 3); budget.endPass(3);
  assert.deepEqual(budget.snapshot(), {
    profileHash: getCompanyGitRangeProfileHash(), phase: 'complete', failureCode: null,
    startedAtMs: 0, lastNowMs: 3, completedPasses: 2,
    readBytesReserved: 6, readBytesReturned: 6, readCalls: 2, pendingReads: 0, metadataCalls: 0,
    inflations: 0, pendingInflations: 0, outputBytesCharged: 0, inflationBytesActual: 0, reconstructionBytes: 0,
    visitedObjects: 0, dependencyDepth: 0, peakDependencyDepth: 0,
    liveMemoryBytes: 0, peakMemoryBytes: 0, cacheMemoryBytes: 0, peakCacheMemoryBytes: 0,
    openDescriptors: 0, peakOpenDescriptors: 0,
    passes: { inspect: { readBytesReserved: 3, indexBytes: 0, indexObjects: 0, indexes: 0 },
      verify: { readBytesReserved: 3, indexBytes: 0, indexObjects: 0, indexes: 0 } },
  });
  assert.equal(extractCompanyGitRangeFailure(errorFrom(() => budget.reserveRead(1), 'COMPANY_GIT_RANGE_INVALID_BUDGET')), null);
});

test('amount and cumulative limits identify the original check without changing reservation order', () => {
  const cases: { name: CompanyGitRangeLimitName; prepare?: (budget: CompanyGitRangeBudget) => void;
    operation: (budget: CompanyGitRangeBudget) => unknown; current: number; requested: number }[] = [
    { name: 'readChunkBytes', operation: value => value.reserveRead(limits.readChunkBytes + 1), current: 0, requested: limits.readChunkBytes + 1 },
    { name: 'managedBytes', prepare: value => { value.reserveMemory(limits.managedBytes); },
      operation: value => value.reserveMemory(1), current: limits.managedBytes, requested: 1 },
    { name: 'cacheBytes', prepare: value => { value.reserveMemory(limits.cacheBytes, 'cache'); },
      operation: value => value.reserveMemory(1, 'cache'), current: limits.cacheBytes, requested: 1 },
    { name: 'inflationOutputBytes', operation: value => value.reserveInflation(limits.objectBytes + limits.looseHeaderBytes + 1),
      current: 0, requested: limits.objectBytes + limits.looseHeaderBytes + 1 },
    { name: 'objectBytes', operation: value => value.chargeReconstruction(limits.objectBytes + 1), current: 0, requested: limits.objectBytes + 1 },
    { name: 'packDirectoryEntries', operation: value => value.admitDirectory(limits.packDirectoryEntries + 1, 0),
      current: 0, requested: limits.packDirectoryEntries + 1 },
    { name: 'candidatePairs', operation: value => value.admitDirectory(limits.packDirectoryEntries, limits.candidatePairs + 1),
      current: 0, requested: limits.candidatePairs + 1 },
    { name: 'indexBytes', operation: value => value.admitIndex('synthetic', limits.indexBytes + 1, 0), current: 0, requested: limits.indexBytes + 1 },
    { name: 'indexObjects', operation: value => value.admitIndex('synthetic', 0, limits.indexObjects + 1), current: 0, requested: limits.indexObjects + 1 },
    { name: 'indexBytesPerPass', prepare: value => value.admitIndex('first', limits.indexBytes, 0),
      operation: value => value.admitIndex('second', 1, 0), current: limits.indexBytesPerPass, requested: 1 },
    { name: 'indexObjectsPerPass', prepare: value => {
      value.admitIndex('first', 0, limits.indexObjects); value.admitIndex('second', 0, limits.indexObjects);
    }, operation: value => value.admitIndex('third', 0, 1), current: limits.indexObjectsPerPass, requested: 1 },
    { name: 'openDescriptors', prepare: value => { for (let index = 0; index < limits.openDescriptors; index++) value.reserveDescriptor(); },
      operation: value => value.reserveDescriptor(), current: limits.openDescriptors, requested: 1 },
    { name: 'dependencyNodes', prepare: value => {
      for (let index = 0; index < limits.dependencyNodes; index++) value.enterDependency(`synthetic:${index}`);
    }, operation: value => value.enterDependency('extra'), current: limits.dependencyNodes, requested: 1 },
    { name: 'visitedObjects', prepare: value => {
      for (let index = 0; index < limits.visitedObjects; index++) value.visitObject(`synthetic:${index}`);
    }, operation: value => value.visitObject('extra'), current: limits.visitedObjects, requested: 1 },
    { name: 'inflations', prepare: value => {
      for (let index = 0; index < limits.inflations; index++) value.completeInflation(value.reserveInflation(0), 0);
    }, operation: value => value.reserveInflation(0), current: limits.inflations, requested: 1 },
    { name: 'inflatedBytes', prepare: value => {
      for (let index = 0; index < limits.inflatedBytes / limits.objectBytes; index++) value.chargeReconstruction(limits.objectBytes);
    }, operation: value => value.reserveInflation(1), current: limits.inflatedBytes, requested: 1 },
    { name: 'readCalls', prepare: value => { for (let index = 0; index < limits.readCalls; index++) read(value, 0); },
      operation: value => value.reserveRead(0), current: limits.readCalls, requested: 1 },
    { name: 'metadataCalls', prepare: value => { for (let index = 0; index < limits.metadataCalls; index++) value.chargeMetadata('fstat'); },
      operation: value => value.chargeMetadata('open'), current: limits.metadataCalls, requested: 1 },
  ];
  for (const item of cases) {
    const budget = active(); budget.setStage('git_object'); item.prepare?.(budget);
    const { profileHash, phase, failureCode, ...before } = budget.snapshot();
    const failure = failureFrom(() => item.operation(budget));
    assert.equal(failure.version, 'company-git-range-failure-v1'); assert.equal(failure.profileHash, getCompanyGitRangeProfileHash());
    assert.equal(failure.errorCode, 'COMPANY_GIT_RANGE_LIMIT'); assert.equal(failure.phase, 'inspect'); assert.equal(failure.stage, 'git_object');
    assert.equal(failure.profileHash, profileHash); assert.equal(failure.phase, phase); assert.equal(failureCode, null);
    assert.deepEqual(failure.limit, { name: item.name, current: item.current, requested: item.requested,
      maximum: item.name === 'inflationOutputBytes' ? limits.objectBytes + limits.looseHeaderBytes : limits[item.name as keyof typeof limits] });
    assert.deepEqual(failure.counters, before, item.name);
  }
});

test('read failure distinguishes a pass cap from the shared cap and keeps both pass counters', () => {
  const passBudget = active();
  for (let index = 0; index < limits.readBytesPerPass / limits.readChunkBytes; index++) read(passBudget, limits.readChunkBytes);
  assert.deepEqual(failureFrom(() => passBudget.reserveRead(1)).limit,
    { name: 'readBytesPerPass', current: limits.readBytesPerPass, requested: 1, maximum: limits.readBytesPerPass });
  const totalBudget = active();
  for (const pass of ['inspect', 'verify'] as const) {
    if (pass === 'verify') totalBudget.beginPass(pass, 1);
    for (let index = 0; index < limits.readBytesPerPass / limits.readChunkBytes; index++) read(totalBudget, limits.readChunkBytes);
    if (pass === 'inspect') totalBudget.endPass(1);
  }
  const failure = failureFrom(() => totalBudget.reserveRead(1));
  assert.equal(failure.phase, 'verify'); assert.equal(failure.counters.completedPasses, 1);
  assert.deepEqual(failure.limit, { name: 'readBytes', current: limits.readBytes, requested: 1, maximum: limits.readBytes });
  assert.equal(failure.counters.passes.inspect.readBytesReserved, limits.readBytesPerPass);
  assert.equal(failure.counters.passes.verify.readBytesReserved, limits.readBytesPerPass);
});

test('the first failure snapshot and stage survive cleanup, later failures and attempted mutation', () => {
  const budget = active(), memory = budget.reserveMemory(limits.managedBytes), descriptor = budget.reserveDescriptor();
  budget.setStage('pack_index'); const originalError = errorFrom(() => budget.reserveMemory(1));
  const failure = extractCompanyGitRangeFailure(originalError); assert.ok(failure);
  budget.setStage('cleanup'); budget.releaseMemory(memory); budget.releaseDescriptor(descriptor); budget.abort();
  const repeatedError = errorFrom(() => budget.reserveRead(1));
  assert.notEqual(originalError, repeatedError); assert.equal(extractCompanyGitRangeFailure(repeatedError), failure);
  assert.equal(extractCompanyGitRangeFailure(errorFrom(() => budget.failLimit('readCalls', limits.readCalls, 1, limits.readCalls))), failure);
  assert.equal(failure.stage, 'pack_index'); assert.equal(failure.counters.liveMemoryBytes, limits.managedBytes);
  assert.equal(failure.counters.openDescriptors, 1); assert.equal(budget.snapshot().liveMemoryBytes, 0); assert.equal(budget.snapshot().openDescriptors, 0);
  for (const value of [failure, failure.limit, failure.counters, failure.counters.passes, failure.counters.passes.inspect]) {
    assert.equal(Object.isFrozen(value), true); assert.equal(Reflect.set(value, 'extra', 'synthetic'), false);
  }
  assert.equal(JSON.stringify(failure).includes('stack'), false);
});

test('timeout is captured at the original inclusive deadline with monotonic fractional timestamps', () => {
  for (const phase of ['ready', 'inspect', 'between', 'verify'] as const) {
    const budget = new CompanyGitRangeBudget(0.25);
    if (phase !== 'ready') budget.beginPass('inspect', 0.5);
    if (phase === 'between' || phase === 'verify') budget.endPass(1);
    if (phase === 'verify') budget.beginPass('verify', 2);
    budget.setStage('final_guard'); budget.checkActive(limits.wallClockMs);
    const failure = failureFrom(() => budget.checkActive(limits.wallClockMs + 0.25), 'COMPANY_GIT_RANGE_TIMEOUT');
    assert.equal(failure.phase, phase); assert.equal(failure.stage, 'final_guard');
    assert.deepEqual(failure.limit, { name: 'wallClockMs', current: limits.wallClockMs, requested: 0, maximum: limits.wallClockMs });
    assert.equal(failure.counters.startedAtMs, 0.25); assert.equal(failure.counters.lastNowMs, limits.wallClockMs + 0.25);
  }
  const fractional = new CompanyGitRangeBudget(0.25);
  assert.equal(failureFrom(() => fractional.checkActive(limits.wallClockMs + 0.75), 'COMPANY_GIT_RANGE_TIMEOUT').limit.current,
    limits.wallClockMs + 0.5);
});

test('error properties, prototypes and proxies cannot forge diagnostics or trigger getters', () => {
  const original = errorFrom(() => active().reserveRead(limits.readChunkBytes + 1));
  let accesses = 0;
  const forged = Object.defineProperties(new HarnessError('COMPANY_GIT_RANGE_LIMIT'), {
    diagnostic: { get: () => { accesses++; throw new Error('synthetic getter'); } },
    cause: { get: () => { accesses++; throw new Error('synthetic getter'); } },
    failure: { get: () => { accesses++; throw new Error('synthetic getter'); } },
  });
  const proxy = new Proxy(original, { get: () => { accesses++; throw new Error('synthetic proxy'); },
    getPrototypeOf: () => { accesses++; throw new Error('synthetic proxy'); } });
  const revoked = Proxy.revocable(original, {}); revoked.revoke();
  for (const value of [null, undefined, false, 1, 'COMPANY_GIT_RANGE_LIMIT', () => original, forged, proxy, revoked.proxy,
    Object.create(original), { ...original }, { failure: extractCompanyGitRangeFailure(original) }]) {
    assert.equal(extractCompanyGitRangeFailure(value), null);
  }
  assert.equal(accesses, 0); assert.ok(extractCompanyGitRangeFailure(original));
});

test('only fixed categories and safe numeric overflows produce a detail record', () => {
  const maximums = { ...limits, ...getPersonalCollectionProfile().limits, inflationOutputBytes: limits.objectBytes + limits.looseHeaderBytes };
  for (const name of COMPANY_GIT_RANGE_LIMIT_NAMES) {
    const maximum = maximums[name], budget = active();
    assert.deepEqual(failureFrom(() => budget.failLimit(name, maximum, 1, maximum)).limit,
      { name, current: maximum, requested: 1, maximum });
  }
  for (const stage of COMPANY_GIT_RANGE_DIAGNOSTIC_STAGES) {
    const budget = active(); budget.setStage(stage);
    assert.equal(failureFrom(() => budget.reserveRead(limits.readChunkBytes + 1)).stage, stage);
  }
  for (const values of [
    ['unknown', 0, 1, 0], ['readCalls', 0, limits.readCalls, limits.readCalls],
    ['readCalls', 0, limits.readCalls + 1, limits.readCalls + 1],
    ['readCalls', -1, limits.readCalls + 2, limits.readCalls],
    ['readCalls', 0, Infinity, limits.readCalls], ['readCalls', NaN, 1, limits.readCalls],
    ['readCalls', 0, Number.MAX_SAFE_INTEGER + 1, limits.readCalls], ['readCalls', 0, 0.5, limits.readCalls],
  ] as const) {
    assert.equal(extractCompanyGitRangeFailure(errorFrom(() => active().failLimit(values[0] as CompanyGitRangeLimitName,
      values[1], values[2], values[3]))), null);
  }
  assert.equal(failureFrom(() => active().failLimit('readCalls', Number.MAX_SAFE_INTEGER, 1, limits.readCalls)).limit.current,
    Number.MAX_SAFE_INTEGER);
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(extractCompanyGitRangeFailure(errorFrom(() => active().reserveRead(value), 'COMPANY_GIT_RANGE_INVALID_BUDGET')), null);
  }
  assert.equal(extractCompanyGitRangeFailure(errorFrom(() => active().setStage('unknown' as CompanyGitRangeDiagnosticStage),
    'COMPANY_GIT_RANGE_INVALID_BUDGET')), null);
  const aborted = active(); aborted.abort();
  assert.equal(extractCompanyGitRangeFailure(errorFrom(() => aborted.reserveRead(1), 'COMPANY_GIT_RANGE_ABORTED')), null);
});
