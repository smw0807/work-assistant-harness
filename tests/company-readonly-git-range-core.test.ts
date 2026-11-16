import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { CompanyGitRangeBudget } from '../src/policy/company-git-range-budget.js';
import { parseCompanyGitRangeIndex, validateCompanyGitRangePackHeader } from '../src/policy/company-git-range-index.js';
import { companyGitRangeCrc32, resolveCompanyGitPackedObjects } from '../src/policy/company-git-range-object-codec.js';
import { createCompanyGitRangeByteProof, parseCompanyGitRangeByteProof } from '../src/policy/company-git-range-proof.js';

const hash = (algorithm: string, bytes: Uint8Array): string => createHash(algorithm).update(bytes).digest('hex');

/** A complete tiny pack/index is constructed in memory; no repository or filesystem is consulted. */
const fixture = () => {
  const contents = [Buffer.from('chosen\n'), Buffer.from('unvisited\n')];
  let offset = 12;
  const records = contents.map(content => {
    const bytes = Buffer.concat([Buffer.from([0x30 | content.length]), deflateSync(content)]);
    const oid = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    const entry = { oid, offset, length: bytes.length, crc32: companyGitRangeCrc32(bytes) };
    offset += bytes.length; return { bytes, entry, content };
  });
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(records.length, 8);
  const body = Buffer.concat([header, ...records.map(record => record.bytes)]);
  const trailer = createHash('sha1').update(body).digest(), pack = Buffer.concat([body, trailer]);
  const index = Buffer.alloc(1072 + records.length * 28), sorted = [...records].sort((left, right) => left.entry.oid.localeCompare(right.entry.oid));
  index.writeUInt32BE(0xff744f63, 0); index.writeUInt32BE(2, 4);
  for (let prefix = 0; prefix < 256; prefix++) {
    index.writeUInt32BE(sorted.filter(record => parseInt(record.entry.oid.slice(0, 2), 16) <= prefix).length, 8 + prefix * 4);
  }
  sorted.forEach((record, position) => {
    Buffer.from(record.entry.oid, 'hex').copy(index, 1032 + position * 20);
    index.writeUInt32BE(record.entry.crc32, 1032 + records.length * 20 + position * 4);
    index.writeUInt32BE(record.entry.offset, 1032 + records.length * 24 + position * 4);
  });
  trailer.copy(index, index.length - 40);
  createHash('sha1').update(index.subarray(0, -20)).digest().copy(index, index.length - 20);
  return { records, pack, index };
};

test('index, selected object and metadata proof compose across two fresh content passes without claiming unvisited integrity', () => {
  const input = fixture(), chosen = input.records[0]!, unvisited = input.records[1]!;
  // The selected chain remains valid even when a different span corrupts the whole pack checksum.
  input.pack[unvisited.entry.offset + 1] = input.pack[unvisited.entry.offset + 1]! ^ 1;
  assert.notEqual(hash('sha1', input.pack.subarray(0, -20)), input.pack.subarray(-20).toString('hex'));
  const budget = new CompanyGitRangeBudget(0), proofs: string[] = [];
  for (const pass of ['inspect', 'verify'] as const) {
    budget.beginPass(pass, 0);
    const index = parseCompanyGitRangeIndex(input.index, input.pack.length, budget, 0);
    const pack = validateCompanyGitRangePackHeader(input.pack.subarray(0, 12), input.pack.subarray(-20), index, budget, 0);
    const entry = index.find(chosen.entry.oid, 0)!;
    const object = resolveCompanyGitPackedObjects([{ entry, bytes: input.pack.subarray(entry.offset, entry.offset + entry.length) }],
      entry.oid, index.summary.indexSha256, budget, 0);
    assert.deepEqual(object.bytes, chosen.content);
    const proof = createCompanyGitRangeByteProof(JSON.stringify({ pack, rootOids: [entry.oid], objects: [{ ...entry,
      type: object.type, encoding: 'full', spanSha256: object.encodedSha256, contentSha256: hash('sha256', object.bytes), baseOid: null }] }));
    assert.deepEqual(parseCompanyGitRangeByteProof(JSON.stringify(proof)), proof);
    assert.equal(proof.packChecksum, 'not_checked'); assert.equal(proof.unvisitedObjects, 'not_checked');
    assert.equal(proof.objects.length, 1); proofs.push(proof.proofHash);
    budget.releaseMemory(object.memoryLease); index.release(); budget.endPass(0);
  }
  assert.equal(proofs[0], proofs[1]);
  const counters = budget.snapshot();
  assert.equal(counters.phase, 'complete'); assert.equal(counters.inflations, 2);
  assert.equal(counters.inflationBytesActual, chosen.content.length * 2); assert.equal(counters.visitedObjects, 1);
  assert.equal(counters.passes.inspect.indexObjects, 2); assert.equal(counters.passes.verify.indexObjects, 2);
  assert.equal(counters.readCalls, 0); assert.equal(counters.metadataCalls, 0); assert.equal(counters.liveMemoryBytes, 0);
});
