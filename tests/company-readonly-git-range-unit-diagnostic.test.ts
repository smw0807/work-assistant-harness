import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompanyGitRangeUnitFailure } from '../src/domain/company-git-range-unit.js';
import { CompanyGitRangeUnitBudget, extractCompanyGitRangeUnitFailure, getCompanyGitRangeUnitGuardPolicyHash,
  getCompanyGitRangeUnitProfile, getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';
import { CompanyGitRangeBudget, extractCompanyGitRangeFailure, getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { COMPANY_GIT_RANGE_UNIT_DIAGNOSTIC_BYTES, parseCompanyGitRangeUnitFailure } from '../src/policy/company-git-range-unit-diagnostic.js';
import { parseCompanyGitRangeFailure } from '../src/policy/company-git-range-diagnostic.js';

const limits = getCompanyGitRangeUnitProfile().limits;
const active = (): CompanyGitRangeUnitBudget => { const budget = new CompanyGitRangeUnitBudget(0); budget.beginPass('inspect', 0); return budget; };
const failure = (operation: () => unknown): CompanyGitRangeUnitFailure => {
  try { operation(); } catch (error) { const value = extractCompanyGitRangeUnitFailure(error); assert.ok(value); return value; }
  assert.fail('Expected an issued unit failure');
};
const simple = (): CompanyGitRangeUnitFailure => failure(() => active().reserveRead(limits.readChunkBytes + 1));
const rejected = (value: unknown): void => assert.throws(() => parseCompanyGitRangeUnitFailure(value), { code: 'COMPANY_READONLY_V3_INVALID_DIAGNOSTIC' });

test('failure-v2 parsing accepts actual unit limit failures and captures their independent hashes', () => {
  const operations: ((budget: CompanyGitRangeUnitBudget) => unknown)[] = [
    budget => budget.reserveRead(limits.readChunkBytes + 1),
    budget => budget.reserveMemory(limits.managedBytes + 1),
    budget => budget.reserveMemory(limits.cacheBytes + 1, 'cache'),
    budget => budget.admitIndex('synthetic', limits.indexBytes + 1, 0),
    budget => budget.admitIndex('synthetic', 0, limits.indexObjects + 1),
    budget => budget.admitDirectory(limits.packDirectoryEntries + 1, 0),
    budget => budget.reserveInflation(limits.objectBytes + limits.looseHeaderBytes + 1),
    budget => { for (let index = 0; index < limits.metadataCalls; index++) budget.chargeMetadata('lstat'); budget.chargeMetadata('fstat'); },
    budget => { for (let index = 0; index < limits.openDescriptors; index++) budget.reserveDescriptor(); budget.reserveDescriptor(); },
  ];
  for (const operation of operations) {
    const budget = active(); budget.setStage('pack_index'); const issued = failure(() => operation(budget));
    const parsed = parseCompanyGitRangeUnitFailure(issued);
    assert.deepEqual(parsed, issued); assert.notEqual(parsed, issued);
    assert.equal(parsed.version, 'company-git-range-failure-v2'); assert.equal(parsed.profileHash, getCompanyGitRangeUnitProfileHash());
    assert.equal(parsed.guardPolicyHash, getCompanyGitRangeUnitGuardPolicyHash()); assert.equal(parsed.stage, 'pack_index');
    assert.ok(Buffer.byteLength(JSON.stringify(parsed)) <= COMPANY_GIT_RANGE_UNIT_DIAGNOSTIC_BYTES);
    assert.equal(Object.hasOwn(parsed.counters, 'guardPolicyHash'), false);
  }
});

test('failure-v2 timeout parsing preserves exact elapsed time, fractional timestamps and between-pass state', () => {
  for (const phase of ['ready', 'inspect', 'between', 'verify'] as const) {
    const budget = new CompanyGitRangeUnitBudget(0.25);
    if (phase !== 'ready') budget.beginPass('inspect', 0.5);
    if (phase === 'between' || phase === 'verify') budget.endPass(1);
    if (phase === 'verify') budget.beginPass('verify', 2);
    const issued = failure(() => budget.checkActive(limits.wallClockMs + 0.75));
    assert.deepEqual(parseCompanyGitRangeUnitFailure(issued), issued); assert.equal(issued.phase, phase);
    assert.equal(issued.limit.current, limits.wallClockMs + 0.5);
    rejected({ ...issued, limit: { ...issued.limit, current: limits.wallClockMs - 1 } });
    rejected({ ...issued, limit: { ...issued.limit, current: issued.limit.current + 1 } });
    rejected({ ...issued, limit: { ...issued.limit, requested: 1 } });
  }
});

test('diagnostic parsers refuse the other reader version and wrong or missing guard hashes', () => {
  const current = simple(); let previous: unknown;
  const budget = new CompanyGitRangeBudget(0); budget.beginPass('inspect', 0);
  try { budget.reserveRead(limits.readChunkBytes + 1); } catch (error) { previous = extractCompanyGitRangeFailure(error); }
  assert.ok(previous); assert.deepEqual(parseCompanyGitRangeFailure(previous), previous); rejected(previous);
  assert.throws(() => parseCompanyGitRangeFailure(current), { code: 'COMPANY_READONLY_V2_INVALID_DIAGNOSTIC' });
  for (const changed of [{ ...current, version: 'company-git-range-failure-v1' }, { ...current, profileHash: getCompanyGitRangeProfileHash() },
    { ...current, guardPolicyHash: '0'.repeat(64) }, { ...current, guardPolicyHash: undefined }]) rejected(changed);
  const missing = Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'guardPolicyHash')); rejected(missing);
});

test('failure-v2 rejects raw fields, malformed limits and impossible or unbounded numeric observations', () => {
  const valid = simple(), counters = valid.counters;
  for (const value of [
    { ...valid, path: '/synthetic/private/source.ts' }, { ...valid, body: 'SYNTHETIC_PRIVATE_BODY' }, { ...valid, stack: 'synthetic' },
    { ...valid, body: 'x'.repeat(COMPANY_GIT_RANGE_UNIT_DIAGNOSTIC_BYTES) }, { ...valid, stage: 'unknown' }, { ...valid, phase: 'failed' },
    { ...valid, limit: { ...valid.limit, name: 'unknown' } }, { ...valid, limit: { ...valid.limit, maximum: limits.readChunkBytes + 1 } },
    { ...valid, limit: { ...valid.limit, requested: limits.readChunkBytes } },
    { ...valid, counters: { ...counters, completedPasses: 1 } }, { ...valid, counters: { ...counters, readBytesReturned: 1 } },
    { ...valid, counters: { ...counters, pendingReads: 1 } }, { ...valid, counters: { ...counters, peakMemoryBytes: limits.managedBytes + 1 } },
    { ...valid, counters: { ...counters, guardPolicyHash: valid.guardPolicyHash } },
    { ...valid, counters: { ...counters, lastNowMs: limits.wallClockMs } },
    { ...valid, counters: { ...counters, passes: { ...counters.passes, verify: { ...counters.passes.verify, indexes: 1 } } } },
  ]) rejected(value);
  for (const name of ['current', 'requested', 'maximum']) for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0.5]) {
    rejected({ ...valid, limit: { ...valid.limit, [name]: value } });
  }
  for (const name of Object.keys(counters).filter(key => key !== 'passes')) for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejected({ ...valid, counters: { ...counters, [name]: value } });
  }
});

test('failure-v2 data copying rejects proxies, accessors and foreign objects without evaluating them', () => {
  const valid = simple(); let calls = 0;
  const hostile = (): never => { calls++; throw new Error('UNEXPECTED_GETTER'); };
  const proxy = new Proxy(valid, { get: hostile, ownKeys: hostile, getPrototypeOf: hostile });
  const revoked = Proxy.revocable(valid, {}); revoked.revoke();
  const getter = Object.defineProperty({ ...valid }, 'guardPolicyHash', { enumerable: true, get: hostile });
  const nested = { ...valid, counters: Object.defineProperty({ ...valid.counters }, 'readCalls', { enumerable: true, get: hostile }) };
  for (const value of [null, [], new Error('synthetic'), proxy, revoked.proxy, getter, nested,
    Object.defineProperty({ ...valid }, 'hidden', { value: true }), { ...valid, [Symbol('extra')]: true }, { ...valid, toJSON: hostile }]) rejected(value);
  assert.equal(calls, 0);
});
