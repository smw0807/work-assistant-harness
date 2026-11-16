import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompanyGitRangeByteProof, parseCompanyGitRangeByteProof } from '../src/policy/company-git-range-proof.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const body = () => ({
  pack: { version: 2, indexSha256: 'a'.repeat(64), declaredPackChecksum: 'b'.repeat(40), objectCount: 4, packBytes: 1000,
    integrityScope: 'selected-object-chain', packChecksum: 'not_checked', unvisitedObjects: 'not_checked' },
  rootOids: ['2'.repeat(40)],
  objects: [
    { oid: '1'.repeat(40), type: 'blob', encoding: 'full', offset: 12, length: 20, crc32: 0xffffffff,
      spanSha256: 'c'.repeat(64), contentSha256: 'd'.repeat(64), baseOid: null as string | null },
    { oid: '2'.repeat(40), type: 'blob', encoding: 'ofs-delta', offset: 32, length: 20, crc32: 0,
      spanSha256: 'e'.repeat(64), contentSha256: 'f'.repeat(64), baseOid: '1'.repeat(40) as string | null },
  ],
});
const resign = (proof: Record<string, unknown>) => {
  const fields = { ...proof }; delete fields.proofHash;
  return JSON.stringify({ ...fields, proofHash: hashReadonlyValue(canonicalReadonlyJson(fields)) });
};

test('byte proof is immutable, bounded metadata with explicit unverified pack scope and no source authority', () => {
  const proof = createCompanyGitRangeByteProof(JSON.stringify(body()));
  assert.deepEqual(parseCompanyGitRangeByteProof(JSON.stringify(proof)), proof);
  assert.equal(proof.packChecksum, 'not_checked'); assert.equal(proof.pack.packChecksum, 'not_checked');
  assert.equal(proof.unvisitedObjects, 'not_checked'); assert.equal(proof.integrityScope, 'selected-object-chain');
  assert.ok(Object.isFrozen(proof)); assert.ok(Object.isFrozen(proof.pack)); assert.ok(Object.isFrozen(proof.objects[0]));
  assert.equal(Object.hasOwn(proof, 'approval'), false); assert.equal(Object.hasOwn(proof, 'sourceRoot'), false);
  assert.equal(Object.hasOwn(proof, 'resourceCounters'), false); // Cumulative pass accounting is not a content identity.
});

test('new proof rejects checksum-scope upgrades, profile substitution and extra fields even after rehashing', () => {
  const valid = createCompanyGitRangeByteProof(JSON.stringify(body()));
  for (const field of ['profileHash', 'version', 'packChecksum', 'unvisitedObjects', 'integrityScope']) {
    const changed = { ...valid, [field]: field === 'profileHash' ? '0'.repeat(64) : 'verified' };
    assert.throws(() => parseCompanyGitRangeByteProof(resign(changed)), { code: 'COMPANY_GIT_RANGE_INVALID_PROOF' });
  }
  assert.throws(() => parseCompanyGitRangeByteProof(resign({ ...valid, sourceRoot: '/synthetic/should-not-be-here' })), /INVALID_PROOF/u);
  assert.throws(() => parseCompanyGitRangeByteProof(JSON.stringify({ ...valid, proofHash: '0'.repeat(64) })), /INVALID_PROOF/u);
  const nested = { ...valid, pack: { ...valid.pack, packChecksum: 'verified' } };
  assert.throws(() => parseCompanyGitRangeByteProof(resign(nested)), /INVALID_PROOF/u);
});

test('proof graph rejects missing or unused nodes, cycles, wrong delta type/order and overlapping spans', () => {
  const changes: ((value: ReturnType<typeof body>) => void)[] = [
    value => { value.rootOids = ['3'.repeat(40)]; },
    value => { value.rootOids = ['1'.repeat(40)]; },
    value => { value.rootOids.push(value.rootOids[0]!); },
    value => { value.objects[1]!.baseOid = '3'.repeat(40); },
    value => { value.objects[0]!.encoding = 'ref-delta'; value.objects[0]!.baseOid = value.objects[1]!.oid; },
    value => { value.objects[1]!.type = 'tree'; },
    value => { value.objects[0]!.baseOid = value.objects[1]!.oid; },
    value => { value.objects[1]!.offset = 31; },
    value => { value.objects[1]!.length = 2000; },
    value => { value.objects[1]!.crc32 = -1; },
    value => { value.objects[1]!.contentSha256 = 'not-a-hash'; },
  ];
  for (const change of changes) { const value = body(); change(value); assert.throws(() => createCompanyGitRangeByteProof(JSON.stringify(value)), /INVALID_PROOF/u); }
});

test('proof rejects duplicate JSON keys, oversized input and legacy repository shapes without invoking getters', () => {
  const raw = JSON.stringify(body());
  assert.throws(() => createCompanyGitRangeByteProof(raw.replace('"rootOids":', '"rootOids":[],"rootOids":')), /INVALID_PROOF/u);
  assert.throws(() => createCompanyGitRangeByteProof(' '.repeat(128 * 1024 + 1)), /INVALID_PROOF/u);
  assert.throws(() => createCompanyGitRangeByteProof(JSON.stringify({ kind: 'company-git', gitEntries: [] })), /INVALID_PROOF/u);
  let calls = 0;
  const invalid = { toString: () => { calls++; return raw; } };
  assert.throws(() => createCompanyGitRangeByteProof(invalid as unknown as string), /INVALID_PROOF/u); assert.equal(calls, 0);
});
