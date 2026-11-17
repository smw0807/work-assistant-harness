import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompanyGitRangeUnitFailure } from '../src/domain/company-git-range-unit.js';
import { HarnessError } from '../src/domain/errors.js';
import { formatCompanyV3Diagnostic, parseCompanyV3Diagnostic } from '../src/cli/company-readonly-v3-diagnostic-protocol.js';
import { CompanyGitRangeUnitBudget, extractCompanyGitRangeUnitFailure, getCompanyGitRangeUnitProfile } from '../src/policy/company-git-range-unit-budget.js';
import { parseCompanyGitRangeUnitFailure } from '../src/policy/company-git-range-unit-diagnostic.js';
import { CompanyGitRangeBudget, extractCompanyGitRangeFailure, getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { formatCompanyV2Diagnostic, parseCompanyV2Diagnostic } from '../src/cli/company-readonly-v2-diagnostic-protocol.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const prefix = 'COMPANY_GIT_RANGE_DIAGNOSTIC_V2 ';
const limits = getCompanyGitRangeUnitProfile().limits;
const active = (): CompanyGitRangeUnitBudget => { const value = new CompanyGitRangeUnitBudget(0); value.beginPass('inspect', 0); return value; };
const capture = (operation: () => unknown): CompanyGitRangeUnitFailure => {
  try { operation(); } catch (error) {
    const failure = extractCompanyGitRangeUnitFailure(error); assert.ok(failure); return failure;
  }
  assert.fail('Expected a genuine budget failure');
};
const simpleFailure = (): CompanyGitRangeUnitFailure => capture(() => active().reserveRead(limits.readChunkBytes + 1));
const repeat = (count: number, operation: (index: number) => unknown): void => { for (let index = 0; index < count; index++) operation(index); };
const frame = (failure: unknown): Buffer => Buffer.from(`${prefix}${JSON.stringify({ version: 'company-git-range-failure-v2', taskId, failure })}\n`);
const rejected = (value: unknown): void => {
  assert.throws(() => parseCompanyGitRangeUnitFailure(value), { code: 'COMPANY_READONLY_V3_INVALID_DIAGNOSTIC' });
};

test('the strict diagnostic parser accepts actual failures from all eighteen budget checks', () => {
  const cases: [string, (budget: CompanyGitRangeUnitBudget) => unknown][] = [
    ['readChunkBytes', value => value.reserveRead(limits.readChunkBytes + 1)],
    ['managedBytes', value => { value.reserveMemory(limits.managedBytes); value.reserveMemory(1); }],
    ['cacheBytes', value => { value.reserveMemory(limits.cacheBytes, 'cache'); value.reserveMemory(1, 'cache'); }],
    ['inflationOutputBytes', value => value.reserveInflation(limits.objectBytes + limits.looseHeaderBytes + 1)],
    ['objectBytes', value => value.chargeReconstruction(limits.objectBytes + 1)],
    ['packDirectoryEntries', value => value.admitDirectory(limits.packDirectoryEntries + 1, 0)],
    ['candidatePairs', value => value.admitDirectory(limits.packDirectoryEntries, limits.candidatePairs + 1)],
    ['indexBytes', value => value.admitIndex('synthetic', limits.indexBytes + 1, 0)],
    ['indexObjects', value => value.admitIndex('synthetic', 0, limits.indexObjects + 1)],
    ['indexBytesPerPass', value => { value.admitIndex('first', limits.indexBytes, 0); value.admitIndex('second', 1, 0); }],
    ['indexObjectsPerPass', value => {
      value.admitIndex('first', 0, limits.indexObjects); value.admitIndex('second', 0, limits.indexObjects); value.admitIndex('third', 0, 1);
    }],
    ['openDescriptors', value => { repeat(limits.openDescriptors, () => value.reserveDescriptor()); value.reserveDescriptor(); }],
    ['dependencyNodes', value => {
      repeat(limits.dependencyNodes, index => value.enterDependency(`synthetic:${index}`)); value.enterDependency('extra');
    }],
    ['visitedObjects', value => { repeat(limits.visitedObjects, index => value.visitObject(`synthetic:${index}`)); value.visitObject('extra'); }],
    ['inflations', value => { repeat(limits.inflations, () => value.completeInflation(value.reserveInflation(0), 0)); value.reserveInflation(0); }],
    ['inflatedBytes', value => {
      repeat(limits.inflatedBytes / limits.objectBytes, () => value.chargeReconstruction(limits.objectBytes)); value.reserveInflation(1);
    }],
    ['readCalls', value => { repeat(limits.readCalls, () => value.completeRead(value.reserveRead(0), 0)); value.reserveRead(0); }],
    ['metadataCalls', value => { repeat(limits.metadataCalls, () => value.chargeMetadata('fstat')); value.chargeMetadata('open'); }],
  ];
  for (const [name, operation] of cases) {
    const budget = active(); budget.setStage('git_object');
    const failure = capture(() => operation(budget)); assert.equal(failure.limit.name, name);
    assert.deepEqual(parseCompanyGitRangeUnitFailure(failure), failure, name);
    const encoded = formatCompanyV3Diagnostic(taskId, failure);
    assert.deepEqual(parseCompanyV3Diagnostic(Buffer.from(encoded), taskId), failure, name);
    assert.equal(encoded.includes('synthetic:0'), false);
  }
});

test('strict parsing preserves two passes, pending work and valid fractional timeout observations', () => {
  const reads = active();
  for (const pass of ['inspect', 'verify'] as const) {
    if (pass === 'verify') reads.beginPass(pass, 1);
    repeat(limits.readBytesPerPass / limits.readChunkBytes, () => reads.completeRead(reads.reserveRead(limits.readChunkBytes), limits.readChunkBytes));
    if (pass === 'inspect') reads.endPass(1);
  }
  const total = capture(() => reads.reserveRead(1)); assert.equal(total.limit.name, 'readBytes');
  assert.deepEqual(parseCompanyV3Diagnostic(frame(total), taskId), total);
  const pending = active(); pending.reserveRead(1); pending.reserveInflation(4); pending.reserveDescriptor(); pending.enterDependency('synthetic');
  const failure = capture(() => pending.checkActive(limits.wallClockMs));
  assert.equal(failure.counters.pendingReads, 1); assert.equal(failure.counters.pendingInflations, 1);
  assert.deepEqual(parseCompanyV3Diagnostic(frame(failure), taskId), failure);
  for (const phase of ['ready', 'inspect', 'between', 'verify'] as const) {
    const budget = new CompanyGitRangeUnitBudget(0.25);
    if (phase !== 'ready') budget.beginPass('inspect', 0.5);
    if (phase === 'between' || phase === 'verify') budget.endPass(1);
    if (phase === 'verify') budget.beginPass('verify', 2);
    budget.setStage('final_guard');
    const timeout = capture(() => budget.checkActive(limits.wallClockMs + 0.75));
    assert.equal(timeout.phase, phase); assert.equal(timeout.limit.current, limits.wallClockMs + 0.5);
    assert.deepEqual(parseCompanyV3Diagnostic(frame(timeout), taskId), timeout);
  }
  const readyCache = new CompanyGitRangeUnitBudget(0); readyCache.reserveMemory(limits.cacheBytes, 'cache');
  const readyFailure = capture(() => readyCache.reserveMemory(1, 'cache'));
  assert.deepEqual(parseCompanyV3Diagnostic(frame(readyFailure), taskId), readyFailure);
});

test('the schema rejects invented categories, private text, unsafe numbers and impossible counters', () => {
  const valid = simpleFailure(), counters = valid.counters;
  const values: unknown[] = [
    null, [], true, new HarnessError('COMPANY_GIT_RANGE_LIMIT'),
    { ...valid, extra: 1 }, { ...valid, body: 'synthetic private text' }, { ...valid, path: '/synthetic/private/source.ts' },
    { ...valid, stack: 'synthetic stack' }, { ...valid, version: 'other' }, { ...valid, profileHash: '0'.repeat(64) },
    { ...valid, version: 'company-git-range-failure-v1' }, { ...valid, profileHash: getCompanyGitRangeProfileHash() },
    { ...valid, guardPolicyHash: '0'.repeat(64) }, { ...valid, guardPolicyHash: undefined },
    { ...valid, errorCode: 'COMPANY_GIT_RANGE_INVALID_BUDGET' }, { ...valid, phase: 'failed' },
    { ...valid, phase: 'complete' }, { ...valid, stage: '/synthetic/private/source.ts' },
    { ...valid, limit: { ...valid.limit, body: 'synthetic' } }, { ...valid, limit: { ...valid.limit, name: 'unknown' } },
    { ...valid, limit: { ...valid.limit, maximum: limits.readChunkBytes + 1 } },
    { ...valid, limit: { ...valid.limit, requested: limits.readChunkBytes } },
    { ...valid, limit: { ...valid.limit, current: 0.5 } },
    { ...valid, counters: { ...counters, body: 'synthetic' } },
    { ...valid, counters: { ...counters, startedAtMs: 1 } },
    { ...valid, counters: { ...counters, lastNowMs: limits.wallClockMs } },
    { ...valid, counters: { ...counters, completedPasses: 1 } },
    { ...valid, counters: { ...counters, readBytesReturned: 1 } },
    { ...valid, counters: { ...counters, readBytesReserved: 1 } },
    { ...valid, counters: { ...counters, pendingReads: 1 } },
    { ...valid, counters: { ...counters, pendingInflations: 1 } },
    { ...valid, counters: { ...counters, dependencyDepth: 1 } },
    { ...valid, counters: { ...counters, peakDependencyDepth: 1 } },
    { ...valid, counters: { ...counters, liveMemoryBytes: 1 } },
    { ...valid, counters: { ...counters, cacheMemoryBytes: 1 } },
    { ...valid, counters: { ...counters, peakCacheMemoryBytes: 1 } },
    { ...valid, counters: { ...counters, openDescriptors: 1 } },
    { ...valid, counters: { ...counters, inflationBytesActual: 1, outputBytesCharged: 1 } },
    { ...valid, counters: { ...counters, reconstructionBytes: 1 } },
    { ...valid, counters: { ...counters, passes: { ...counters.passes, body: 'synthetic' } } },
    { ...valid, counters: { ...counters, passes: { ...counters.passes, inspect: { ...counters.passes.inspect, indexBytes: 1 } } } },
    { ...valid, counters: { ...counters, passes: { ...counters.passes, inspect: { ...counters.passes.inspect, body: 'synthetic' } } } },
    { ...valid, counters: { ...counters, passes: { ...counters.passes, verify: { ...counters.passes.verify, indexes: 1 } } } },
  ];
  for (const [name, count] of Object.entries(counters)) {
    if (typeof count !== 'number') continue;
    for (const number of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) values.push({ ...valid, counters: { ...counters, [name]: number } });
    if (!['startedAtMs', 'lastNowMs'].includes(name)) values.push({ ...valid, counters: { ...counters, [name]: 0.5 } });
  }
  for (const name of ['current', 'requested', 'maximum']) {
    for (const number of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) values.push({ ...valid, limit: { ...valid.limit, [name]: number } });
  }
  for (const value of values) { rejected(value); assert.equal(parseCompanyV3Diagnostic(frame(value), taskId), null); }
  const timeout = capture(() => active().checkActive(limits.wallClockMs));
  for (const value of [
    { ...timeout, limit: { ...timeout.limit, current: limits.wallClockMs - 1 } },
    { ...timeout, limit: { ...timeout.limit, current: limits.wallClockMs + 1 } },
    { ...timeout, limit: { ...timeout.limit, requested: 1 } },
    { ...timeout, errorCode: 'COMPANY_GIT_RANGE_LIMIT' },
  ]) rejected(value);
});

test('schema validation does not evaluate foreign getters, proxy traps or toJSON hooks', () => {
  const valid = simpleFailure(); let accesses = 0;
  const hostile = (): never => { accesses++; throw new Error('synthetic access'); };
  const getter = Object.defineProperty({ ...valid }, 'body', { enumerable: true, get: hostile });
  const nestedGetter = { ...valid, counters: Object.defineProperty({ ...valid.counters }, 'readCalls', { enumerable: true, get: hostile }) };
  const proxy = new Proxy(valid, { get: hostile, getPrototypeOf: hostile, ownKeys: hostile, getOwnPropertyDescriptor: hostile });
  const revoked = Proxy.revocable(valid, {}); revoked.revoke();
  const cyclic = { ...valid, extra: {} }; cyclic.extra = cyclic;
  for (const value of [getter, nestedGetter, proxy, revoked.proxy, cyclic, { ...valid, toJSON: hostile },
    Object.defineProperty({ ...valid }, 'hidden', { value: 'synthetic' }), { ...valid, [Symbol('synthetic')]: 1 }]) rejected(value);
  assert.equal(accesses, 0);
  assert.throws(() => formatCompanyV3Diagnostic(taskId, getter), { code: 'COMPANY_READONLY_V3_INVALID_DIAGNOSTIC' });
  assert.throws(() => formatCompanyV3Diagnostic('../synthetic', valid), { code: 'COMPANY_READONLY_V3_INVALID_DIAGNOSTIC' });
  assert.equal(accesses, 0);
});

test('v3 and v2 diagnostic frames cannot be exchanged even when the task and numeric limits match', () => {
  const current = simpleFailure();
  assert.equal(parseCompanyV2Diagnostic(Buffer.from(formatCompanyV3Diagnostic(taskId, current)), taskId), null);
  const oldBudget = new CompanyGitRangeBudget(0); oldBudget.beginPass('inspect', 0);
  try { oldBudget.reserveRead(limits.readChunkBytes + 1); }
  catch (error) {
    const oldFailure = extractCompanyGitRangeFailure(error); assert.ok(oldFailure);
    assert.equal(parseCompanyV3Diagnostic(Buffer.from(formatCompanyV2Diagnostic(taskId, oldFailure)), taskId), null);
    assert.equal(parseCompanyV3Diagnostic(frame(oldFailure), taskId), null);
    rejected(oldFailure);
    return;
  }
  assert.fail('Expected the synthetic old-budget failure');
});

test('wire decoding rejects duplicate keys or frames, incomplete frames, task mismatch and malformed UTF-8', () => {
  const valid = simpleFailure(), raw = formatCompanyV3Diagnostic(taskId, valid);
  assert.deepEqual(parseCompanyV3Diagnostic(Buffer.from(`synthetic warning\n${raw}synthetic notice\n`), taskId), valid);
  const invalid = [
    '', raw + raw, raw + prefix, raw + `${prefix}{\n`, raw.slice(0, -1), raw.slice(0, -3), raw.replace(/\n$/u, ' trailing\n'),
    raw.replace(/\n$/u, '\r\n'), `prefix ${raw}`, `\uFEFF${raw}`, raw.replace(taskId, '22222222-2222-4222-8222-222222222222'),
    raw.replace('"taskId":', '"body":"synthetic private text","taskId":'),
    raw.replace('"taskId":', `"taskId":"${taskId}","taskId":`),
    raw.replace('"taskId":', `"taskId":"${taskId}","task\\u0049d":`),
    raw.replace('"readCalls":0', '"readCalls":0,"readCalls":0'),
    raw.replace('"requested":65537', '"requested":1e999'),
    raw.replace('"stage":"budget"', '"stage":"\\ud800"'),
    raw.replace('"failure":', '"__proto__":{},"failure":'),
  ];
  for (const value of invalid) assert.equal(parseCompanyV3Diagnostic(Buffer.from(value), taskId), null, value.slice(0, 80));
  for (const suffix of [Buffer.from([0xc3, 0x28]), Buffer.from([0xff]), Buffer.from([0xe2, 0x82])]) {
    assert.equal(parseCompanyV3Diagnostic(Buffer.concat([Buffer.from(raw), suffix]), taskId), null);
  }
  const bounded = `${'x'.repeat(65_536 - Buffer.byteLength(raw) - 1)}\n${raw}`;
  assert.equal(Buffer.byteLength(bounded), 65_536); assert.deepEqual(parseCompanyV3Diagnostic(Buffer.from(bounded), taskId), valid);
  assert.equal(parseCompanyV3Diagnostic(Buffer.from(`x${bounded}`), taskId), null);
  assert.equal(parseCompanyV3Diagnostic(Buffer.from(raw), '../synthetic'), null);
});

test('wire input validation rejects shared memory and foreign views without evaluating properties', () => {
  const valid = simpleFailure(), raw = Buffer.from(formatCompanyV3Diagnostic(taskId, valid)); let accesses = 0;
  const hostile = (): never => { accesses++; throw new Error('synthetic access'); };
  const fake = Object.defineProperty({}, 'byteLength', { get: hostile });
  const proxy = new Proxy(raw, { get: hostile, getPrototypeOf: hostile });
  const revoked = Proxy.revocable(raw, {}); revoked.revoke();
  const shared = new Uint8Array(new SharedArrayBuffer(raw.byteLength)); shared.set(raw);
  for (const value of [fake, proxy, revoked.proxy, shared, new DataView(raw.buffer, raw.byteOffset, raw.byteLength)]) {
    assert.equal(parseCompanyV3Diagnostic(value as Uint8Array, taskId), null);
  }
  Object.defineProperty(raw, 'byteLength', { get: hostile });
  assert.deepEqual(parseCompanyV3Diagnostic(raw, taskId), valid);
  assert.equal(accesses, 0);
});
