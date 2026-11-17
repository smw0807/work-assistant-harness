import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CompanyGitRangeBudget, getCompanyGitRangeProfile } from '../src/policy/company-git-range-budget.js';
import { parseCompanyGitRangeIndex, validateCompanyGitRangePackHeader } from '../src/policy/company-git-range-index.js';

const active = () => { const budget = new CompanyGitRangeBudget(0); budget.beginPass('inspect', 0); return budget; };
const checksum = (bytes: Buffer): Buffer => {
  createHash('sha1').update(bytes.subarray(0, -20)).digest().copy(bytes, bytes.length - 20); return bytes;
};
const entry = (oid: string, offset: number, crc32 = 0xfffffffe) => ({ oid, offset, crc32 });
const fixture = (entries = [entry('11'.repeat(20), 56), entry('22'.repeat(20), 12), entry('ff'.repeat(20), 36)], packBytes = 116) => {
  const count = entries.length, bytes = Buffer.alloc(1072 + count * 28);
  bytes.writeUInt32BE(0xff744f63, 0); bytes.writeUInt32BE(2, 4);
  for (let prefix = 0; prefix < 256; prefix++) bytes.writeUInt32BE(entries.filter(item => parseInt(item.oid.slice(0, 2), 16) <= prefix).length, 8 + prefix * 4);
  for (const [position, item] of entries.entries()) {
    Buffer.from(item.oid, 'hex').copy(bytes, 1032 + position * 20);
    bytes.writeUInt32BE(item.crc32, 1032 + count * 20 + position * 4);
    bytes.writeUInt32BE(item.offset, 1032 + count * 24 + position * 4);
  }
  const trailer = Buffer.from('ab'.repeat(20), 'hex'); trailer.copy(bytes, bytes.length - 40);
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(count, 8);
  return { bytes: checksum(bytes), header, trailer, entries, packBytes };
};
const expectInvalid = (bytes: Buffer, packBytes: number, code?: string): void => {
  const budget = active();
  assert.throws(() => parseCompanyGitRangeIndex(bytes, packBytes, budget, 1), code ? { code } : /COMPANY_GIT_RANGE_/u);
  assert.equal(budget.snapshot().phase, 'failed'); assert.equal(budget.snapshot().liveMemoryBytes, 0);
};

test('range index snapshots caller bytes and resolves numeric offsets independently of OID order', () => {
  const source = fixture(), budget = active();
  const index = parseCompanyGitRangeIndex(source.bytes, source.packBytes, budget, 1);
  assert.deepEqual(index.find(source.entries[0]!.oid, 1), { ...source.entries[0], length: 40 });
  assert.deepEqual(index.atOffset(12, 1), { ...source.entries[1], length: 24 });
  assert.deepEqual(index.atOffset(36, 1), { ...source.entries[2], length: 20 });
  assert.equal(index.find('33'.repeat(20), 1), undefined); assert.equal(index.atOffset(13, 1), undefined);
  const metadata = validateCompanyGitRangePackHeader(source.header, source.trailer, index, budget, 1);
  assert.equal(metadata.packChecksum, 'not_checked'); assert.equal(metadata.unvisitedObjects, 'not_checked');
  assert.equal(metadata.integrityScope, 'selected-object-chain'); assert.equal(metadata.version, 2);
  assert.equal(index.summary.indexSha256, createHash('sha256').update(source.bytes).digest('hex'));
  source.bytes.fill(0); assert.equal(index.atOffset(56, 2)!.oid, '11'.repeat(20));
  assert.equal(budget.snapshot().readBytesReserved, 0); // Pure bytes, not a filesystem observation.
  assert.ok(Object.isFrozen(index.summary)); assert.ok(Object.isFrozen(index.atOffset(12, 2)));
  index.release(); assert.equal(budget.snapshot().liveMemoryBytes, 0);
  assert.throws(() => index.find('11'.repeat(20), 2), { code: 'COMPANY_GIT_RANGE_INVALID_INDEX_HANDLE' });
});

test('range index rejects structural corruptions even after a fresh index checksum is supplied', () => {
  const alterations: ((bytes: Buffer) => void)[] = [
    bytes => bytes.writeUInt32BE(1, 4),
    bytes => bytes.writeUInt32BE(0, 8 + 0x11 * 4),
    bytes => bytes.writeUInt32BE(3, 8 + 0x10 * 4),
    bytes => bytes.copy(bytes, 1052, 1032, 1052),
    bytes => { bytes[1032] = 0xfe; },
    bytes => bytes.writeUInt32BE(12, 1032 + 3 * 24),
    bytes => bytes.writeUInt32BE(11, 1032 + 3 * 24 + 4),
    bytes => bytes.writeUInt32BE(13, 1032 + 3 * 24 + 4),
    bytes => bytes.writeUInt32BE(96, 1032 + 3 * 24),
    bytes => bytes.writeUInt32BE(0x80000000, 1032 + 3 * 24),
  ];
  for (const alter of alterations) { const source = fixture(); alter(source.bytes); expectInvalid(checksum(source.bytes), source.packBytes); }
  const badChecksum = fixture(); badChecksum.bytes[badChecksum.bytes.length - 1] = badChecksum.bytes[badChecksum.bytes.length - 1]! ^ 1;
  expectInvalid(badChecksum.bytes, badChecksum.packBytes);
  const trailing = Buffer.concat([fixture().bytes.subarray(0, -20), Buffer.alloc(4), Buffer.alloc(20)]);
  expectInvalid(checksum(trailing), 116);
});

test('range index counts above old 4096 are supported only inside fixed new index limits', () => {
  const limit = getCompanyGitRangeProfile().limits.indexObjects;
  const count = limit, bytes = Buffer.alloc(1072 + count * 28), packBytes = 12 + count * 8 + 20;
  bytes.writeUInt32BE(0xff744f63, 0); bytes.writeUInt32BE(2, 4);
  for (let prefix = 0; prefix < 256; prefix++) bytes.writeUInt32BE(count, 8 + prefix * 4);
  for (let position = 0; position < count; position++) {
    bytes.writeUInt32BE(position, 1032 + position * 20 + 16);
    bytes.writeUInt32BE(12 + position * 8, 1032 + count * 24 + position * 4);
  }
  checksum(bytes);
  const budget = active(), index = parseCompanyGitRangeIndex(bytes, packBytes, budget, 1);
  assert.equal(index.summary.objectCount, 131072); assert.equal(index.atOffset(12 + (count - 1) * 8, 1)!.length, 8);
  index.release(); assert.equal(budget.snapshot().liveMemoryBytes, 0);
  const duplicateCandidate = parseCompanyGitRangeIndex(bytes, packBytes, budget, 1); duplicateCandidate.release();
  assert.equal(budget.snapshot().passes.inspect.indexObjects, 262144);
  assert.throws(() => parseCompanyGitRangeIndex(bytes, packBytes, budget, 1), { code: 'COMPANY_GIT_RANGE_LIMIT' });
  assert.equal(budget.snapshot().liveMemoryBytes, 0);
  bytes.writeUInt32BE(count + 1, 1028); expectInvalid(checksum(bytes), packBytes);
  expectInvalid(fixture().bytes, getCompanyGitRangeProfile().limits.packBytes + 1);
});

test('an oversized unvisited span is not inspected, and selecting it is refused before object decoding', () => {
  const spanLimit = getCompanyGitRangeProfile().limits.encodedObjectBytes;
  const source = fixture([entry('11'.repeat(20), 12), entry('22'.repeat(20), 32)], 32 + spanLimit + 1 + 20);
  const budget = active(), index = parseCompanyGitRangeIndex(source.bytes, source.packBytes, budget, 1);
  assert.equal(index.find('11'.repeat(20), 1)!.length, 20);
  assert.throws(() => index.find('22'.repeat(20), 1), { code: 'COMPANY_GIT_RANGE_INVALID_SPAN' });
  index.release(); assert.equal(budget.snapshot().liveMemoryBytes, 0);
});

test('pack metadata checks header/count/trailer identity without claiming a whole-pack checksum', () => {
  for (const kind of ['magic', 'high-bit-magic', 'version', 'count', 'trailer', 'short', 'cross-budget', 'forged']) {
    const source = fixture(), budget = active(), index = parseCompanyGitRangeIndex(source.bytes, source.packBytes, budget, 1);
    if (kind === 'magic') source.header.write('BACK');
    if (kind === 'high-bit-magic') source.header[0] = 0xd0;
    if (kind === 'version') source.header.writeUInt32BE(4, 4);
    if (kind === 'count') source.header.writeUInt32BE(4, 8);
    if (kind === 'trailer') source.trailer[0] = source.trailer[0]! ^ 1;
    let getterCalls = 0;
    const fake = Object.defineProperty({}, 'summary', { get: () => { getterCalls++; throw Error('must not run'); } });
    assert.throws(() => validateCompanyGitRangePackHeader(kind === 'short' ? source.header.subarray(1) : source.header,
      source.trailer, kind === 'forged' ? fake as typeof index : index, kind === 'cross-budget' ? active() : budget, 1), /COMPANY_GIT_RANGE_/u);
    assert.equal(getterCalls, 0); index.release(); assert.equal(budget.snapshot().liveMemoryBytes, 0);
  }
  const source = fixture(), budget = active(), index = parseCompanyGitRangeIndex(source.bytes, source.packBytes, budget, 1);
  source.header.writeUInt32BE(3, 4);
  assert.equal(validateCompanyGitRangePackHeader(source.header, source.trailer, index, budget, 1).version, 3); index.release();
});

test('index byte inputs exclude shared backing and never evaluate own size or buffer getters', () => {
  const source = fixture(), budget = active(); let calls = 0;
  for (const key of ['byteLength', 'byteOffset', 'buffer']) Object.defineProperty(source.bytes, key, { get: () => { calls++; throw Error('must not run'); } });
  const index = parseCompanyGitRangeIndex(source.bytes, source.packBytes, budget, 1); index.release(); assert.equal(calls, 0);
  expectInvalid(Buffer.from(new SharedArrayBuffer(1072)), 32, 'COMPANY_GIT_RANGE_INVALID_BYTES');
  const shared = new SharedArrayBuffer(1072), disguised = Buffer.from(shared);
  Object.setPrototypeOf(shared, ArrayBuffer.prototype);
  expectInvalid(disguised, 32, 'COMPANY_GIT_RANGE_INVALID_BYTES');
  expectInvalid(Buffer.from(Reflect.construct(ArrayBuffer, [1072, { maxByteLength: 2144 }]) as ArrayBuffer), 32, 'COMPANY_GIT_RANGE_INVALID_BYTES');
  expectInvalid(Buffer.alloc(1071), 32);
});
