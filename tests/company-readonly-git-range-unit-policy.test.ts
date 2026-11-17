import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HarnessError } from '../src/domain/errors.js';
import { COMPANY_GIT_RANGE_UNIT_KINDS } from '../src/domain/company-git-range-unit.js';
import { CompanyGitRangeBudget, extractCompanyGitRangeFailure, getCompanyGitRangeProfile,
  getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { assertCompanyGitRangeUnitBudget, CompanyGitRangeUnitBudget, extractCompanyGitRangeUnitFailure,
  getCompanyGitRangeUnitGuardPolicy, getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfile,
  getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';
import { createCompanyGitRangeByteProof, parseCompanyGitRangeByteProof } from '../src/policy/company-git-range-proof.js';
import { createCompanyGitRangeUnitByteProof, parseCompanyGitRangeUnitByteProof } from '../src/policy/company-git-range-unit-proof.js';
import { parseCompanyGitRangeFailure } from '../src/policy/company-git-range-diagnostic.js';
import { getPersonalCollectionProfileHash } from '../src/policy/personal-readonly-collection.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const limits = getCompanyGitRangeUnitProfile().limits;
const active = (): CompanyGitRangeUnitBudget => { const budget = new CompanyGitRangeUnitBudget(0); budget.beginPass('inspect', 0); return budget; };
const caught = (operation: () => unknown, code = 'COMPANY_GIT_RANGE_LIMIT'): HarnessError => {
  try { operation(); } catch (error) { assert.ok(error instanceof HarnessError); assert.equal(error.code, code); return error; }
  assert.fail('Expected the fixed failure code');
};
const read = (budget: CompanyGitRangeUnitBudget, bytes: number): void => { budget.completeRead(budget.reserveRead(bytes), bytes); };
const counters = (budget: CompanyGitRangeBudget | CompanyGitRangeUnitBudget): Record<string, unknown> => {
  const snapshot: Record<string, unknown> = { ...budget.snapshot() }; delete snapshot.profileHash; delete snapshot.guardPolicyHash; return snapshot;
};
const digest = (value: unknown): string => hashReadonlyValue(canonicalReadonlyJson(value));
const proofBody = () => ({ pack: { indexSha256: 'a'.repeat(64), declaredPackChecksum: 'b'.repeat(40), objectCount: 1,
  packBytes: 39, version: 2, integrityScope: 'selected-object-chain', packChecksum: 'not_checked', unvisitedObjects: 'not_checked' },
  rootOids: ['1'.repeat(40)], objects: [{ oid: '1'.repeat(40), type: 'blob', encoding: 'full', offset: 12, length: 7,
    crc32: 0, spanSha256: 'c'.repeat(64), contentSha256: 'd'.repeat(64), baseOid: null }] });

test('unit profile freezes every observation boundary and preserves all v1 limits and hashes', () => {
  const profile = getCompanyGitRangeUnitProfile(), policy = getCompanyGitRangeUnitGuardPolicy(), legacy = getCompanyGitRangeProfile();
  assert.equal(profile.policy, 'company-git-range-reader-v2'); assert.equal(policy.policy, 'company-git-range-read-unit-guard-v1');
  assert.equal(getCompanyGitRangeProfileHash(), '8fc98736b72781db4567c808f6dca086b8b9ec1a4f97eb5e551d8ee0c3f210b6');
  assert.equal(getCompanyGitRangeUnitProfileHash(), '6d222ffbf013f3f96eb18c72e62df6774b53027de6b05e07fd4d5bd7270d7a6a');
  assert.equal(getCompanyGitRangeUnitGuardPolicyHash(), '53b83bf31d858132ff3e732ef705ba6b5a9431e35f2aed74c7807287de6e6f13');
  assert.deepEqual(profile.limits, legacy.limits); assert.equal(profile.collectionProfileHash, getPersonalCollectionProfileHash());
  assert.notEqual(getCompanyGitRangeUnitProfileHash(), getCompanyGitRangeProfileHash());
  assert.equal(getCompanyGitRangeUnitProfileHash(), digest(profile)); assert.equal(getCompanyGitRangeUnitGuardPolicyHash(), digest(policy));
  assert.equal(profile.guardPolicy, policy); assert.equal(profile.guardPolicyHash, getCompanyGitRangeUnitGuardPolicyHash());
  assert.deepEqual(profile.contentPasses, ['inspect', 'verify']);
  assert.deepEqual(policy.units, {
    'pack-index': { scope: 'whole-file', maximumBytes: 8 * 1024 * 1024 },
    'git-file': { scope: 'whole-file', maximumBytes: 8 * 1024 * 1024 },
    'selected-file': { scope: 'whole-file', maximumBytes: 65536 },
    'pack-object': { scope: 'encoded-span', maximumBytes: 2 * 1024 * 1024 },
    'pack-header': { scope: 'fixed-span', maximumBytes: 12, fixedBytes: 12 },
    'pack-trailer': { scope: 'fixed-span', maximumBytes: 20, fixedBytes: 20 },
  });
  assert.deepEqual(Object.keys(policy.units), COMPANY_GIT_RANGE_UNIT_KINDS);
  assert.deepEqual(policy.fullPathChecks, ['open-before', 'open-after', 'unit-before', 'unit-after', 'pass-final']);
  assert.deepEqual(policy.chunkLeafAndDescriptorChecks, ['before-read', 'after-read']);
  assert.equal(policy.chunkMaximumBytes, 65536); assert.equal(policy.resultDelivery, 'after-unit-final-guard');
  assert.equal(policy.emptyFileRead, 'one-charged-zero-byte-read'); assert.equal(policy.sameDescriptorWithinUnit, true);
  assert.equal(policy.freshReadsEachPass, true); assert.equal(policy.mergedUnits, false); assert.equal(policy.bodyCache, false);
  assert.equal(policy.transientAncestorChanges, 'may-be-unobserved-within-unit');
  assert.equal(policy.continuousPathIdentity, false); assert.equal(policy.atomicSnapshot, false);
  for (const value of [profile, profile.limits, profile.contentPasses, policy, policy.units, policy.fullPathChecks,
    policy.chunkLeafAndDescriptorChecks, COMPANY_GIT_RANGE_UNIT_KINDS, ...Object.values(policy.units)]) {
    assert.equal(Object.isFrozen(value), true); assert.equal(Reflect.set(value, 'extra', 'synthetic'), false);
  }
  for (const changed of [{ ...policy, transientAncestorChanges: 'continuous' }, { ...policy, fullPathChecks: ['pass-final'] },
    { ...policy, chunkMaximumBytes: 131072 }, { ...policy, units: { ...policy.units, 'pack-object': { scope: 'encoded-span', maximumBytes: 3 * 1024 * 1024 } } }]) {
    assert.notEqual(digest(changed), profile.guardPolicyHash);
    assert.notEqual(digest({ ...profile, guardPolicy: changed, guardPolicyHash: digest(changed) }), getCompanyGitRangeUnitProfileHash());
  }
  assert.equal(Object.hasOwn(legacy, 'guardPolicy'), false); assert.equal(digest(legacy), getCompanyGitRangeProfileHash());
});

test('unit budget identity rejects legacy, copied and proxied surfaces without invoking accessors', () => {
  const valid = new CompanyGitRangeUnitBudget(0); assertCompanyGitRangeUnitBudget(valid);
  assert.equal(valid.snapshot().profileHash, getCompanyGitRangeUnitProfileHash());
  assert.equal(valid.snapshot().guardPolicyHash, getCompanyGitRangeUnitGuardPolicyHash());
  let accesses = 0; const hostile = (): never => { accesses++; throw new Error('synthetic getter'); };
  const proxy = new Proxy(valid, { get: hostile, getPrototypeOf: hostile, ownKeys: hostile });
  const revoked = Proxy.revocable(valid, {}); revoked.revoke();
  class DerivedBudget extends CompanyGitRangeUnitBudget {}
  for (const value of [null, {}, new CompanyGitRangeBudget(0), { ...valid }, Object.create(CompanyGitRangeUnitBudget.prototype),
    Object.defineProperty({}, 'snapshot', { get: hostile }), proxy, revoked.proxy, new DerivedBudget(0)]) {
    caught(() => assertCompanyGitRangeUnitBudget(value), 'COMPANY_GIT_RANGE_INVALID_BUDGET');
  }
  assert.equal(accesses, 0); assert.equal(Object.isFrozen(valid), true); assert.equal(Object.isFrozen(CompanyGitRangeUnitBudget.prototype), true);
  assert.equal(Reflect.set(valid, 'reserveRead', () => ({})), false);
});

test('both version-local budget engines retain identical accounting for equivalent work', () => {
  const legacy = new CompanyGitRangeBudget(0), unit = new CompanyGitRangeUnitBudget(0);
  for (const budget of [legacy, unit]) {
    const retained = budget.reserveMemory(128);
    budget.beginPass('inspect', 0.25); budget.setStage('pack_index');
    budget.admitDirectory(2, 1); budget.admitIndex('synthetic-index', 1024, 1);
    budget.completeRead(budget.reserveRead(16), 7); budget.chargeMetadata('lstat');
    budget.completeInflation(budget.reserveInflation(20), 5); budget.chargeReconstruction(3);
    const descriptor = budget.reserveDescriptor(), dependency = budget.enterDependency('synthetic-object');
    budget.leaveDependency(dependency); budget.releaseDescriptor(descriptor);
    const cache = budget.reserveMemory(16, 'cache'); budget.releaseMemory(cache); budget.endPass(1.5);
    budget.beginPass('verify', 2); budget.admitIndex('synthetic-index', 1024, 1);
    budget.completeRead(budget.reserveRead(16), 7); budget.visitObject('synthetic-object'); budget.endPass(3);
    assert.equal(budget.snapshot().liveMemoryBytes, 128); budget.releaseMemory(retained);
  }
  assert.deepEqual(counters(unit), counters(legacy));
  assert.equal(Object.hasOwn(legacy.snapshot(), 'guardPolicyHash'), false);
  assert.equal(unit.snapshot().phase, 'complete'); assert.equal(unit.snapshot().visitedObjects, 1);
});

test('unit memory and descriptor limits preserve leases, first failure and cleanup accounting', () => {
  const memory = active(), backing = memory.reserveMemory(limits.managedBytes), retained = memory.retainMemory(backing);
  memory.releaseMemory(backing); assert.equal(memory.snapshot().liveMemoryBytes, limits.managedBytes);
  const error = caught(() => memory.reserveMemory(1)), failure = extractCompanyGitRangeUnitFailure(error); assert.ok(failure);
  assert.equal(failure.version, 'company-git-range-failure-v2'); assert.equal(failure.profileHash, getCompanyGitRangeUnitProfileHash());
  assert.equal(failure.guardPolicyHash, getCompanyGitRangeUnitGuardPolicyHash()); assert.equal(Object.hasOwn(failure.counters, 'guardPolicyHash'), false);
  assert.equal(failure.limit.name, 'managedBytes'); assert.equal(failure.counters.liveMemoryBytes, limits.managedBytes);
  memory.setStage('cleanup'); memory.releaseMemory(retained); memory.abort();
  assert.equal(memory.snapshot().liveMemoryBytes, 0); assert.equal(failure.counters.liveMemoryBytes, limits.managedBytes);
  assert.equal(extractCompanyGitRangeUnitFailure(caught(() => memory.reserveRead(0))), failure);
  const cache = active(), cached = cache.reserveMemory(limits.cacheBytes, 'cache');
  assert.equal(extractCompanyGitRangeUnitFailure(caught(() => cache.reserveMemory(1, 'cache')))!.limit.name, 'cacheBytes');
  cache.releaseMemory(cached); assert.equal(cache.snapshot().cacheMemoryBytes, 0);
  const descriptors = active(), leases = Array.from({ length: limits.openDescriptors }, () => descriptors.reserveDescriptor());
  const descriptorFailure = extractCompanyGitRangeUnitFailure(caught(() => descriptors.reserveDescriptor())); assert.ok(descriptorFailure);
  assert.deepEqual(descriptorFailure.limit, { name: 'openDescriptors', current: 32, requested: 1, maximum: 32 });
  for (const lease of leases) descriptors.releaseDescriptor(lease);
  assert.equal(descriptors.snapshot().openDescriptors, 0); assert.equal(descriptorFailure.counters.openDescriptors, 32);
  caught(() => descriptors.releaseDescriptor(leases[0]!));
});

test('unit read limits share exactly two passes and preserve short and failed reservations', () => {
  const complete = active();
  for (const pass of ['inspect', 'verify'] as const) {
    if (pass === 'verify') complete.beginPass(pass, 1);
    for (let index = 0; index < limits.readBytesPerPass / limits.readChunkBytes; index++) read(complete, limits.readChunkBytes);
    complete.endPass(1);
  }
  assert.equal(complete.snapshot().readBytesReserved, limits.readBytes); assert.equal(complete.snapshot().completedPasses, 2);
  const pass = active();
  for (let index = 0; index < limits.readBytesPerPass / limits.readChunkBytes; index++) read(pass, limits.readChunkBytes);
  assert.equal(extractCompanyGitRangeUnitFailure(caught(() => pass.reserveRead(1)))!.limit.name, 'readBytesPerPass');
  const shared = active();
  for (const name of ['inspect', 'verify'] as const) {
    if (name === 'verify') shared.beginPass(name, 1);
    for (let index = 0; index < limits.readBytesPerPass / limits.readChunkBytes; index++) read(shared, limits.readChunkBytes);
    if (name === 'inspect') shared.endPass(1);
  }
  assert.equal(extractCompanyGitRangeUnitFailure(caught(() => shared.reserveRead(1)))!.limit.name, 'readBytes');
  const short = active(); short.completeRead(short.reserveRead(16), 1); short.failRead(short.reserveRead(16));
  assert.equal(short.snapshot().readBytesReserved, 32); assert.equal(short.snapshot().readBytesReturned, 1);
  assert.equal(short.snapshot().readCalls, 2); assert.equal(short.snapshot().pendingReads, 0);
  caught(() => short.reserveRead(0), 'COMPANY_GIT_RANGE_ABORTED');
  const calls = active(); for (let index = 0; index < limits.readCalls; index++) read(calls, 0);
  assert.equal(extractCompanyGitRangeUnitFailure(caught(() => calls.reserveRead(0)))!.limit.name, 'readCalls');
  assert.equal(extractCompanyGitRangeUnitFailure(caught(() => active().reserveRead(limits.readChunkBytes + 1)))!.limit.name, 'readChunkBytes');
});

test('unit dependency, metadata and inflation limits remain cumulative without allowing incomplete passes', () => {
  const dependency = active(), leases = Array.from({ length: limits.dependencyNodes }, (_, index) => dependency.enterDependency(`synthetic:${index}`));
  const failure = extractCompanyGitRangeUnitFailure(caught(() => dependency.enterDependency('extra'))); assert.ok(failure);
  assert.equal(failure.limit.name, 'dependencyNodes'); assert.equal(failure.counters.visitedObjects, limits.dependencyNodes);
  for (const lease of leases.reverse()) dependency.leaveDependency(lease);
  assert.equal(dependency.snapshot().dependencyDepth, 0); assert.equal(dependency.snapshot().peakDependencyDepth, limits.dependencyNodes);
  const metadata = active(); for (let index = 0; index < limits.metadataCalls; index++) metadata.chargeMetadata('fstat');
  assert.equal(extractCompanyGitRangeUnitFailure(caught(() => metadata.chargeMetadata('lstat')))!.limit.name, 'metadataCalls');
  const inflated = active();
  for (let index = 0; index < limits.inflatedBytes / limits.objectBytes; index++) inflated.completeInflation(inflated.reserveInflation(limits.objectBytes), limits.objectBytes);
  assert.equal(extractCompanyGitRangeUnitFailure(caught(() => inflated.reserveInflation(1)))!.limit.name, 'inflatedBytes');
  for (const prepare of [
    (budget: CompanyGitRangeUnitBudget) => { budget.reserveRead(0); },
    (budget: CompanyGitRangeUnitBudget) => { budget.reserveInflation(0); },
    (budget: CompanyGitRangeUnitBudget) => { budget.reserveDescriptor(); },
    (budget: CompanyGitRangeUnitBudget) => { budget.enterDependency('synthetic'); },
    (budget: CompanyGitRangeUnitBudget) => { budget.reserveMemory(0, 'cache'); },
  ]) { const budget = active(); prepare(budget); caught(() => budget.endPass(0), 'COMPANY_GIT_RANGE_INVALID_BUDGET'); }
});

test('capability tokens cannot cross engine versions or unit budget instances', () => {
  for (const origin of [new CompanyGitRangeBudget(0), new CompanyGitRangeUnitBudget(0)]) {
    origin.beginPass('inspect', 0);
    const memory = origin.reserveMemory(8), descriptor = origin.reserveDescriptor(), receipt = origin.reserveRead(4);
    const inflation = origin.reserveInflation(4), dependency = origin.enterDependency('synthetic');
    const operations = [
      (target: CompanyGitRangeBudget | CompanyGitRangeUnitBudget) => target.assertMemory(memory, 8),
      (target: CompanyGitRangeBudget | CompanyGitRangeUnitBudget) => target.releaseDescriptor(descriptor),
      (target: CompanyGitRangeBudget | CompanyGitRangeUnitBudget) => target.completeRead(receipt, 4),
      (target: CompanyGitRangeBudget | CompanyGitRangeUnitBudget) => target.completeInflation(inflation, 4),
      (target: CompanyGitRangeBudget | CompanyGitRangeUnitBudget) => target.leaveDependency(dependency),
    ];
    for (const Constructor of [CompanyGitRangeBudget, CompanyGitRangeUnitBudget]) {
      for (const operation of operations) {
        const target = new Constructor(0); target.beginPass('inspect', 0);
        caught(() => operation(target), 'COMPANY_GIT_RANGE_INVALID_BUDGET');
      }
    }
    origin.completeRead(receipt, 4); origin.completeInflation(inflation, 4); origin.leaveDependency(dependency);
    origin.releaseDescriptor(descriptor); origin.releaseMemory(memory); origin.endPass(0);
    assert.equal(origin.snapshot().openDescriptors, 0); assert.equal(origin.snapshot().liveMemoryBytes, 0);
  }
});

test('unit failure identity and deadline diagnostics stay private to the new version', () => {
  const unitError = caught(() => active().reserveRead(limits.readChunkBytes + 1));
  const legacy = new CompanyGitRangeBudget(0); legacy.beginPass('inspect', 0);
  const legacyError = caught(() => legacy.reserveRead(limits.readChunkBytes + 1));
  assert.equal(extractCompanyGitRangeFailure(unitError), null); assert.equal(extractCompanyGitRangeUnitFailure(legacyError), null);
  const failure = extractCompanyGitRangeUnitFailure(unitError); assert.ok(failure);
  caught(() => parseCompanyGitRangeFailure(failure), 'COMPANY_READONLY_V2_INVALID_DIAGNOSTIC');
  const timeout = new CompanyGitRangeUnitBudget(0.25); timeout.beginPass('inspect', 0.5); timeout.endPass(1); timeout.beginPass('verify', 2);
  const timed = extractCompanyGitRangeUnitFailure(caught(() => timeout.checkActive(limits.wallClockMs + 0.75), 'COMPANY_GIT_RANGE_TIMEOUT'));
  assert.ok(timed); assert.equal(timed.phase, 'verify'); assert.equal(timed.limit.current, limits.wallClockMs + 0.5);
  assert.equal(timed.counters.completedPasses, 1); assert.equal(timed.version, 'company-git-range-failure-v2');
  let accesses = 0; const hostile = (): never => { accesses++; throw new Error('synthetic getter'); };
  const proxy = new Proxy(unitError, { get: hostile, getPrototypeOf: hostile });
  const revoked = Proxy.revocable(unitError, {}); revoked.revoke();
  for (const value of [new HarnessError(unitError.code), { failure }, Object.create(unitError), proxy, revoked.proxy,
    Object.defineProperty({}, 'diagnostic', { get: hostile })]) assert.equal(extractCompanyGitRangeUnitFailure(value), null);
  assert.equal(accesses, 0); assert.equal(Object.isFrozen(failure), true); assert.equal(Object.isFrozen(failure.counters.passes.inspect), true);
});

test('byte proof v2 binds both new hashes and refuses legacy proof and profile mixing', () => {
  const body = proofBody(), proof = createCompanyGitRangeUnitByteProof(JSON.stringify(body));
  assert.equal(proof.version, 'company-git-range-byte-proof-v2'); assert.equal(proof.profileHash, getCompanyGitRangeUnitProfileHash());
  assert.equal(proof.guardPolicyHash, getCompanyGitRangeUnitGuardPolicyHash());
  assert.deepEqual(parseCompanyGitRangeUnitByteProof(JSON.stringify(proof)), proof);
  assert.equal(proof.packChecksum, 'not_checked'); assert.equal(proof.unvisitedObjects, 'not_checked');
  for (const value of [proof, proof.pack, proof.rootOids, proof.objects, proof.objects[0]!]) assert.equal(Object.isFrozen(value), true);
  const old = createCompanyGitRangeByteProof(JSON.stringify(body)); assert.notEqual(old.proofHash, proof.proofHash);
  caught(() => parseCompanyGitRangeByteProof(JSON.stringify(proof)), 'COMPANY_GIT_RANGE_INVALID_PROOF');
  caught(() => parseCompanyGitRangeUnitByteProof(JSON.stringify(old)), 'COMPANY_GIT_RANGE_INVALID_PROOF');
  for (const changed of [{ ...proof, profileHash: getCompanyGitRangeProfileHash() }, { ...proof, guardPolicyHash: '0'.repeat(64) },
    { ...proof, version: 'company-git-range-byte-proof-v1' }, { ...proof, guardPolicyHash: undefined }, { ...proof, extra: 'synthetic' }]) {
    caught(() => parseCompanyGitRangeUnitByteProof(JSON.stringify(changed)), 'COMPANY_GIT_RANGE_INVALID_PROOF');
  }
  assert.deepEqual(parseCompanyGitRangeByteProof(JSON.stringify(old)), old);
});

test('byte proof v2 independently rejects malformed ranges, unreachable objects and excessive dependency chains', () => {
  const body = proofBody();
  for (const value of [
    { ...body, body: 'synthetic private text' }, { ...body, pack: { ...body.pack, packBytes: limits.packBytes + 1 } },
    { ...body, pack: { ...body.pack, objectCount: limits.indexObjects + 1 } }, { ...body, rootOids: [] },
    { ...body, objects: [{ ...body.objects[0]!, length: limits.encodedObjectBytes + 1 }] },
    { ...body, objects: [{ ...body.objects[0]!, offset: 11 }] },
    { ...body, objects: [{ ...body.objects[0]!, encoding: 'ref-delta', baseOid: '2'.repeat(40) }] },
    { ...body, objects: [{ ...body.objects[0]!, encoding: 'ref-delta', baseOid: body.rootOids[0] }] },
    { ...body, objects: [{ ...body.objects[0]!, contentSha256: 'invalid' }] },
  ]) caught(() => createCompanyGitRangeUnitByteProof(JSON.stringify(value)), 'COMPANY_GIT_RANGE_INVALID_PROOF');
  for (const count of [limits.dependencyNodes, limits.dependencyNodes + 1]) {
    const oid = (index: number): string => index.toString(16).padStart(40, '0');
    const objects = Array.from({ length: count }, (_, index) => ({ ...body.objects[0]!, oid: oid(index + 1), offset: 12 + index,
      length: 1, encoding: index === 0 ? 'full' : 'ofs-delta', baseOid: index === 0 ? null : oid(index) }));
    const input = { pack: { ...body.pack, objectCount: count, packBytes: 12 + count + 20 }, rootOids: [oid(count)], objects };
    if (count === limits.dependencyNodes) assert.equal(createCompanyGitRangeUnitByteProof(JSON.stringify(input)).objects.length, count);
    else caught(() => createCompanyGitRangeUnitByteProof(JSON.stringify(input)), 'COMPANY_GIT_RANGE_INVALID_PROOF');
  }
});
