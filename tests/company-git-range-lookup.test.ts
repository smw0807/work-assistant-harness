import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import git from 'isomorphic-git';
import { createCompanyGitRangeUnitSource } from '../src/adapters/company-git-range-unit-source.js';
import { parseCompanyGitRangeIndex, type CompanyGitRangeIndexEntry } from '../src/policy/company-git-range-index.js';
import { CompanyGitRangeUnitBudget, getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfile,
  getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';
import { createCompanyGitRangeFixture, type CompanyGitRangeFixtureObject } from './company-readonly-git-range-fixture.js';

const sha1 = (bytes: Uint8Array): Buffer => createHash('sha1').update(bytes).digest();
const oidFor = (prefix: number, ordinal: number): string => prefix.toString(16).padStart(2, '0') + ordinal.toString(16).padStart(38, '0');
const lookupOids = [[0x00, 9], [0x7f, 4], [0xff, 11]].flatMap(([prefix, count]) =>
  Array.from({ length: count! }, (_, index) => oidFor(prefix!, (index + 1) * 2)));

/** Independent index-v2 bytes; reverse physical offsets ensure OID rank is not mistaken for pack position. */
const indexFixture = (oids = lookupOids) => {
  const length = 17, count = oids.length, bytes = Buffer.alloc(1072 + count * 28), entries: CompanyGitRangeIndexEntry[] = [];
  bytes.writeUInt32BE(0xff744f63, 0); bytes.writeUInt32BE(2, 4);
  for (let prefix = 0; prefix < 256; prefix++) {
    bytes.writeUInt32BE(oids.filter(oid => Number.parseInt(oid.slice(0, 2), 16) <= prefix).length, 8 + prefix * 4);
  }
  for (const [position, oid] of oids.entries()) {
    const offset = 12 + (count - position - 1) * length, crc32 = 0xa0000000 + position;
    Buffer.from(oid, 'hex').copy(bytes, 1032 + position * 20);
    bytes.writeUInt32BE(crc32, 1032 + count * 20 + position * 4);
    bytes.writeUInt32BE(offset, 1032 + count * 24 + position * 4);
    entries.push({ oid, offset, length, crc32 });
  }
  Buffer.from('ab'.repeat(20), 'hex').copy(bytes, bytes.length - 40);
  sha1(bytes.subarray(0, -20)).copy(bytes, bytes.length - 20);
  return { bytes, entries, packBytes: 12 + count * length + 20 };
};
const activeBudget = (): CompanyGitRangeUnitBudget => {
  const budget = new CompanyGitRangeUnitBudget(0); budget.beginPass('inspect', 0); return budget;
};

test('index lookup finds first, last and every interior OID in multi-entry 00 and ff fanout buckets', () => {
  const fixture = indexFixture(), budget = activeBudget();
  const index = parseCompanyGitRangeIndex(fixture.bytes, fixture.packBytes, budget, 0);
  try {
    assert.equal(fixture.entries[0]!.oid.slice(0, 2), '00'); assert.equal(fixture.entries.at(-1)!.oid.slice(0, 2), 'ff');
    for (const expected of [...fixture.entries].reverse()) {
      assert.deepEqual(index.find(expected.oid, 0), expected);
      assert.deepEqual(index.atOffset(expected.offset, 0), expected);
    }
    assert.deepEqual(index.find(fixture.entries[0]!.oid, 0), fixture.entries[0]);
    assert.deepEqual(index.find(fixture.entries.at(-1)!.oid, 0), fixture.entries.at(-1));
    assert.equal(budget.snapshot().phase, 'inspect'); assert.equal(budget.snapshot().readBytesReserved, 0);
  } finally { index.release(); }
  assert.equal(budget.snapshot().liveMemoryBytes, 0);
});

test('index lookup agrees with an independent map for empty buckets, same-bucket gaps and absent edge OIDs', () => {
  for (const oids of [lookupOids, []]) {
    const fixture = indexFixture(oids), budget = activeBudget();
    const expected = new Map(fixture.entries.map(entry => [entry.oid, entry]));
    const index = parseCompanyGitRangeIndex(fixture.bytes, fixture.packBytes, budget, 0);
    try {
      for (let prefix = 0; prefix < 256; prefix++) {
        for (const ordinal of [0, 1, 2, 3, 8, 9, 18, 19, 22, 23, 65535]) {
          const oid = oidFor(prefix, ordinal);
          assert.deepEqual(index.find(oid, 0), expected.get(oid), oid);
        }
      }
      assert.equal(index.find('ff'.repeat(20), 0), undefined);
      assert.equal(budget.snapshot().phase, 'inspect');
      assert.equal(index.summary.objectCount, fixture.entries.length);
    } finally { index.release(); }
    assert.equal(budget.snapshot().liveMemoryBytes, 0);
  }
});

const packedHeader = (type: number, size: number): Buffer => {
  let remaining = Math.floor(size / 16);
  const bytes = [(type << 4) | (size & 15) | (remaining ? 128 : 0)];
  while (remaining) {
    const next = remaining & 127; remaining = Math.floor(remaining / 128); bytes.push(next | (remaining ? 128 : 0));
  }
  return Buffer.from(bytes);
};

/** Repack only this newly generated fixture into two small full-object packs, independently indexed by isomorphic-git. */
const splitPacks = async (context: TestContext) => {
  const fixture = await createCompanyGitRangeFixture(context, 'pack');
  const groups = [fixture.objects.filter((_, index) => index % 2 === 0), fixture.objects.filter((_, index) => index % 2 !== 0)];
  const packs: { path: string; oids: Set<string> }[] = [];
  for (const objects of groups) {
    const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
    const encoded = objects.map((object: CompanyGitRangeFixtureObject) => Buffer.concat([
      packedHeader({ commit: 1, tree: 2, blob: 3 }[object.type], object.content.length), deflateSync(object.content),
    ]));
    const body = Buffer.concat([header, ...encoded]), trailer = sha1(body);
    const name = `pack-${trailer.toString('hex')}.pack`, path = join(fixture.root, '.git/objects/pack', name);
    fs.writeFileSync(path, Buffer.concat([body, trailer]), { flag: 'wx', mode: 0o600 });
    const indexed = await git.indexPack({ fs, dir: fixture.root, filepath: `.git/objects/pack/${name}` });
    fs.chmodSync(path.replace(/\.pack$/u, '.idx'), 0o600);
    assert.deepEqual([...indexed.oids].sort(), objects.map(object => object.oid).sort());
    packs.push({ path: relative(fixture.root, path), oids: new Set(objects.map(object => object.oid)) });
  }
  fs.unlinkSync(fixture.packPath!); fs.unlinkSync(fixture.indexPath!);
  const cache = {};
  for (const expected of fixture.objects) {
    const readback = await git.readObject({ fs, dir: fixture.root, oid: expected.oid, format: 'content', cache });
    assert.equal(readback.format, 'content'); assert.equal(readback.type, expected.type);
    assert.deepEqual(Buffer.from(readback.object as Uint8Array), expected.content);
    assert.equal(fs.existsSync(join(fixture.root, '.git/objects', expected.oid.slice(0, 2), expected.oid.slice(2))), false);
  }
  packs.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  assert.equal(packs.length, 2); assert.ok([...packs[0]!.oids].every(oid => !packs[1]!.oids.has(oid)));
  return { ...fixture, packs };
};

test('a missing OID in the first pack falls through to a later valid pack for both fresh source passes', async context => {
  const fixture = await splitPacks(context), before = fixture.snapshot();
  const source = createCompanyGitRangeUnitSource({ version: 'company-git-range-source-v2',
    profileHash: getCompanyGitRangeUnitProfileHash(), guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(),
    sourceRoot: fixture.root, baseCommit: fixture.baseCommit, selectedPaths: fixture.selectedPaths }, () => 0);
  try {
    const inspected = source.inspect(), verified = source.verify();
    assert.deepEqual(verified, inspected); assert.equal(inspected.looseObjects.length, 0);
    assert.deepEqual(inspected.packs.map(pack => pack.path), fixture.packs.map(pack => pack.path));
    const last = inspected.packs.at(-1)!; assert.ok(last.byteProof);
    assert.ok(last.byteProof.rootOids.length > 0);
    for (const oid of last.byteProof.rootOids) {
      assert.equal(fixture.packs[0]!.oids.has(oid), false);
      assert.equal(fixture.packs[1]!.oids.has(oid), true);
    }
    for (const file of inspected.selectedFiles) {
      assert.equal(file.sha256, createHash('sha256').update(fixture.selectedFiles[file.path]!).digest('hex'));
    }
    const budget = source.snapshot();
    assert.equal(budget.phase, 'complete'); assert.equal(budget.completedPasses, 2);
    assert.equal(budget.passes.inspect.indexes, 2); assert.equal(budget.passes.verify.indexes, 2);
    assert.ok(budget.metadataCalls <= getCompanyGitRangeUnitProfile().limits.metadataCalls);
    assert.equal(budget.openDescriptors, 0); assert.equal(budget.liveMemoryBytes, 0); assert.equal(budget.cacheMemoryBytes, 0);
    assert.equal(fixture.snapshot(), before);
  } finally { source.close(); }
});
