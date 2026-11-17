import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import git from 'isomorphic-git';
import { createCompanyGitRangeSource, type CompanyGitRangeSourceObservation } from '../src/adapters/company-git-range-source.js';
import { createCompanyGitRangeUnitCollectionSource, createCompanyGitRangeUnitSource,
  type CompanyGitRangeUnitSourceObservation } from '../src/adapters/company-git-range-unit-source.js';
import type { CompanyGitRangeBudgetSnapshot } from '../src/domain/company-git-range.js';
import { HarnessError } from '../src/domain/errors.js';
import type { PersonalCollectionEvidence } from '../src/domain/personal-readonly-collection.js';
import { extractCompanyGitRangeFailure, getCompanyGitRangeProfile, getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { extractCompanyGitRangeUnitFailure, getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfile,
  getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';

const objectCount = 90_000;
const selectedPath = 'src/main.ts';
const selectedBody = 'export const answer = 42;\n';
const limits = getCompanyGitRangeProfile().limits;
const sha1 = (bytes: Uint8Array): Buffer => createHash('sha1').update(bytes).digest();
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
interface PackEntry { oid: Buffer; offset: number; crc32: number }
interface ObjectSample { oid: string; type: 'blob' | 'tree' | 'commit'; content: Buffer }

// Independent fixture encoding: no production parser, object codec or CRC helper constructs these bytes.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
};
const packedHeader = (type: number, size: number): Buffer => {
  let remaining = Math.floor(size / 16);
  const bytes = [(type << 4) | size & 15 | (remaining ? 128 : 0)];
  while (remaining) {
    const next = remaining & 127; remaining = Math.floor(remaining / 128);
    bytes.push(next | (remaining ? 128 : 0));
  }
  return Buffer.from(bytes);
};
const workingIndex = (oid: Buffer): Buffer => {
  const name = Buffer.from(selectedPath), entry = Buffer.alloc(Math.ceil((62 + name.length + 1) / 8) * 8);
  entry.writeUInt32BE(0o100644, 24); entry.writeUInt32BE(Buffer.byteLength(selectedBody), 36);
  oid.copy(entry, 40); entry.writeUInt16BE(name.length, 60); name.copy(entry, 62);
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(1, 8);
  const body = Buffer.concat([header, entry]);
  return Buffer.concat([body, sha1(body)]);
};
const packIndex = (entries: PackEntry[], checksum: Buffer): Buffer => {
  const sorted = [...entries].sort((left, right) => Buffer.compare(left.oid, right.oid));
  const index = Buffer.alloc(1072 + entries.length * 28), fanout = new Uint32Array(256);
  index.writeUInt32BE(0xff744f63, 0); index.writeUInt32BE(2, 4);
  for (const entry of sorted) fanout[entry.oid[0]!] = fanout[entry.oid[0]!]! + 1;
  let cumulative = 0;
  for (let prefix = 0; prefix < 256; prefix++) {
    cumulative += fanout[prefix]!; index.writeUInt32BE(cumulative, 8 + prefix * 4);
  }
  sorted.forEach((entry, position) => {
    if (position) assert.ok(Buffer.compare(sorted[position - 1]!.oid, entry.oid) < 0);
    entry.oid.copy(index, 1032 + position * 20);
    index.writeUInt32BE(entry.crc32, 1032 + entries.length * 20 + position * 4);
    index.writeUInt32BE(entry.offset, 1032 + entries.length * 24 + position * 4);
  });
  checksum.copy(index, index.length - 40); sha1(index.subarray(0, -20)).copy(index, index.length - 20);
  return index;
};
const snapshot = (root: string): string => {
  const entries: unknown[] = [];
  const visit = (path: string): void => {
    const metadata = fs.lstatSync(path, { bigint: true });
    entries.push({ path: relative(root, path), device: String(metadata.dev), inode: String(metadata.ino), mode: String(metadata.mode),
      uid: String(metadata.uid), gid: String(metadata.gid), links: String(metadata.nlink), size: String(metadata.size),
      modified: String(metadata.mtimeNs), changed: String(metadata.ctimeNs),
      sha256: metadata.isFile() ? sha256(fs.readFileSync(path)) : null });
    if (metadata.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root); return JSON.stringify(entries);
};

/** Build once, then move only this owned synthetic fixture to exercise another fixed path depth. */
const largeFixture = async (context: TestContext) => {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-unit-large-index-')));
  fs.chmodSync(parent, 0o700); context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'repository'), directory = join(root, '.git/objects/pack');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(root, '.git/objects/info'), { mode: 0o700 });
  fs.mkdirSync(join(root, 'src'), { mode: 0o700 });
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const temporary = join(directory, 'synthetic.pack.tmp');
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  const digest = createHash('sha1'), entries: PackEntry[] = [], samples: ObjectSample[] = [];
  const append = (bytes: Buffer): void => {
    assert.equal(fs.writeSync(descriptor, bytes), bytes.length); digest.update(bytes);
  };
  let offset = 12;
  let baseCommit: string, selectedOid: Buffer, checksum: Buffer;
  const add = (type: ObjectSample['type'], content: Buffer, sampled: boolean): Buffer => {
    const oid = createHash('sha1').update(`${type} ${content.length}\0`).update(content).digest();
    const encoded = Buffer.concat([packedHeader({ commit: 1, tree: 2, blob: 3 }[type], content.length), deflateSync(content)]);
    entries.push({ oid, offset, crc32: crc32(encoded) }); append(encoded); offset += encoded.length;
    if (sampled) samples.push({ oid: oid.toString('hex'), type, content });
    return oid;
  };
  try {
    const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objectCount, 8); append(header);
    selectedOid = add('blob', Buffer.from(selectedBody), true);
    const sourceTree = add('tree', Buffer.concat([Buffer.from('100644 main.ts\0'), selectedOid]), true);
    const rootTree = add('tree', Buffer.concat([Buffer.from('40000 src\0'), sourceTree]), true);
    const identity = 'Synthetic Unit Reader <fixture@example.invalid> 1704067200 +0000';
    baseCommit = add('commit', Buffer.from(`tree ${rootTree.toString('hex')}\nauthor ${identity}\ncommitter ${identity}\n\nSynthetic unit integration\n`), true).toString('hex');
    for (let ordinal = entries.length; ordinal < objectCount; ordinal++) {
      const content = Buffer.from(`synthetic unvisited object ${String(ordinal).padStart(6, '0')}\n`);
      add('blob', content, [4, Math.floor(objectCount / 2), objectCount - 1].includes(ordinal));
    }
    checksum = digest.digest(); assert.equal(fs.writeSync(descriptor, checksum), checksum.length);
  } finally { fs.closeSync(descriptor); }
  assert.equal(entries.length, objectCount);
  const packRelative = `.git/objects/pack/pack-${checksum.toString('hex')}.pack`, indexRelative = packRelative.replace(/\.pack$/u, '.idx');
  fs.renameSync(temporary, join(root, packRelative));
  const index = packIndex(entries, checksum);
  fs.writeFileSync(join(root, indexRelative), index, { mode: 0o600 });
  fs.writeFileSync(join(root, '.git/HEAD'), `${baseCommit}\n`, { mode: 0o600 });
  fs.writeFileSync(join(root, '.git/index'), workingIndex(selectedOid), { mode: 0o600 });
  fs.writeFileSync(join(root, selectedPath), selectedBody, { mode: 0o600 });
  const pack = fs.readFileSync(join(root, packRelative));
  assert.deepEqual(sha1(pack.subarray(0, -20)), checksum);
  assert.deepEqual(sha1(index.subarray(0, -20)), index.subarray(-20));
  assert.equal(index.length, 1072 + objectCount * 28);
  assert.ok(index.length > 2 * 1024 * 1024 && index.length < limits.indexBytes);
  // Independent readback samples the chosen chain and distant padding entries; it is not a full-pack audit.
  const cache = {};
  for (const sample of samples) {
    const readback = await git.readObject({ fs, dir: root, oid: sample.oid, format: 'content', cache });
    assert.equal(readback.format, 'content'); assert.equal(readback.type, sample.type);
    assert.deepEqual(Buffer.from(readback.object as Uint8Array), sample.content);
  }
  assert.deepEqual(await git.listFiles({ fs, dir: root }), [selectedPath]);
  return { parent, root, baseCommit, selectedOid: selectedOid.toString('hex'), packRelative, indexRelative,
    packBytes: pack.length, indexBytes: index.length, independentReadbackSamples: samples.length };
};
type Fixture = Awaited<ReturnType<typeof largeFixture>>;
type Observation = CompanyGitRangeSourceObservation | CompanyGitRangeUnitSourceObservation;
interface Reader {
  inspect(): Observation;
  verify(): Observation;
  snapshot(): CompanyGitRangeBudgetSnapshot;
  close(): void;
}
type Run = { status: 'completed'; inspected: Observation; verified: Observation; first: CompanyGitRangeBudgetSnapshot;
  final: CompanyGitRangeBudgetSnapshot } | { status: 'metadata_limit'; final: CompanyGitRangeBudgetSnapshot };
const input = (value: Fixture, unit: boolean) => ({ version: unit ? 'company-git-range-source-v2' : 'company-git-range-source-v1',
  profileHash: unit ? getCompanyGitRangeUnitProfileHash() : getCompanyGitRangeProfileHash(),
  ...(unit ? { guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash() } : {}),
  sourceRoot: value.root, baseCommit: value.baseCommit, selectedPaths: [selectedPath] });
const released = (state: CompanyGitRangeBudgetSnapshot): void => {
  for (const key of ['openDescriptors', 'liveMemoryBytes', 'cacheMemoryBytes', 'pendingReads', 'pendingInflations', 'dependencyDepth'] as const) {
    assert.equal(state[key], 0, key);
  }
};
const run = (reader: Reader): Run => {
  try {
    const inspected = reader.inspect(), first = reader.snapshot(); released(first);
    const verified = reader.verify(), final = reader.snapshot(); released(final);
    return { status: 'completed', inspected, verified, first, final };
  } catch (error) {
    assert.ok(error instanceof HarnessError); assert.equal(error.code, 'COMPANY_GIT_RANGE_LIMIT');
    const failure = extractCompanyGitRangeFailure(error) ?? extractCompanyGitRangeUnitFailure(error);
    assert.ok(failure); assert.equal(failure.limit.name, 'metadataCalls');
    const final = reader.snapshot(); assert.equal(final.metadataCalls, limits.metadataCalls); released(final);
    return { status: 'metadata_limit', final };
  } finally { reader.close(); }
};
const verifyCompleted = (result: Extract<Run, { status: 'completed' }>, value: Fixture): void => {
  assert.deepEqual(result.verified, result.inspected);
  assert.equal(result.first.phase, 'between'); assert.equal(result.final.phase, 'complete'); assert.equal(result.final.completedPasses, 2);
  assert.ok(result.final.readBytesReserved > result.first.readBytesReserved);
  assert.ok(result.final.inflations > result.first.inflations);
  assert.equal(result.final.visitedObjects, result.first.visitedObjects);
  assert.equal(result.final.readBytesReturned, result.final.readBytesReserved);
  assert.equal(result.final.passes.inspect.indexBytes, value.indexBytes);
  assert.equal(result.final.passes.verify.indexBytes, value.indexBytes);
  assert.equal(result.final.passes.inspect.indexObjects, objectCount);
  assert.equal(result.final.passes.verify.indexObjects, objectCount);
  assert.ok(result.final.peakMemoryBytes <= limits.managedBytes && result.final.peakOpenDescriptors <= limits.openDescriptors);
  const observation = result.inspected;
  assert.deepEqual(observation.selectedFiles, [{ path: selectedPath, oid: value.selectedOid, mode: '100644',
    sha256: sha256(selectedBody), bytes: Buffer.byteLength(selectedBody) }]);
  assert.equal(observation.packs.length, 1); assert.equal(observation.looseObjects.length, 0);
  assert.equal(observation.packs[0]!.metadata.objectCount, objectCount);
  assert.equal(observation.packChecksum, 'not_checked'); assert.equal(observation.unvisitedObjects, 'not_checked');
  assert.equal(observation.packs[0]!.byteProof!.objects.length, 4);
  const selectedPack = observation.fileSystem.files.find(file => file.path === value.packRelative)!;
  assert.ok(selectedPack.reads.reduce((sum, read) => sum + read.length, 0) < value.packBytes / 100);
  assert.ok(selectedPack.reads.every(read => read.length <= limits.readChunkBytes));
  assert.ok(selectedPack.reads.some(read => read.offset === 0 && read.length === 12));
  assert.ok(selectedPack.reads.some(read => read.offset === value.packBytes - 20 && read.length === 20));
  assert.equal(JSON.stringify(observation).includes(selectedBody.trim()), false);
  assert.equal(JSON.stringify(observation).includes('"type":"Buffer"'), false);
};
const compareCompleted = (baseline: Extract<Run, { status: 'completed' }>, unit: Extract<Run, { status: 'completed' }>): void => {
  assert.deepEqual(unit.inspected.selectedFiles, baseline.inspected.selectedFiles);
  assert.deepEqual(unit.inspected.fileSystem, baseline.inspected.fileSystem);
  assert.deepEqual(unit.inspected.packs[0]!.metadata, baseline.inspected.packs[0]!.metadata);
  assert.deepEqual(unit.inspected.packs[0]!.byteProof!.objects, baseline.inspected.packs[0]!.byteProof!.objects);
  assert.notEqual(unit.inspected.proofHash, baseline.inspected.proofHash);
  for (const key of ['readCalls', 'readBytesReserved', 'readBytesReturned', 'inflations', 'outputBytesCharged',
    'inflationBytesActual', 'reconstructionBytes', 'visitedObjects', 'peakDependencyDepth', 'passes'] as const) {
    assert.deepEqual(unit.final[key], baseline.final[key], key);
  }
  assert.ok(unit.final.metadataCalls < baseline.final.metadataCalls);
};
const metrics = (result: Run) => ({ status: result.status, completedPasses: result.final.completedPasses,
  metadataCalls: result.final.metadataCalls, readCalls: result.final.readCalls, returnedBytes: result.final.readBytesReturned,
  inflations: result.final.inflations, visitedObjects: result.final.visitedObjects, peakManagedBytes: result.final.peakMemoryBytes,
  peakDescriptors: result.final.peakOpenDescriptors });

test('one large independent synthetic index exercises complete source pipelines and a separate fixed-depth limit observation', async context => {
  const value = await largeFixture(context), before = snapshot(value.root);
  assert.deepEqual(getCompanyGitRangeUnitProfile().limits, limits);
  assert.notEqual(getCompanyGitRangeUnitProfileHash(), getCompanyGitRangeProfileHash());
  const baseline = run(createCompanyGitRangeSource(input(value, false), () => 0));
  const unit = run(createCompanyGitRangeUnitSource(input(value, true), () => 0));
  context.diagnostic(JSON.stringify({ case: 'large-index-complete-pipeline', objectCount, indexBytes: value.indexBytes,
    packBytes: value.packBytes, independentReadbackSamples: value.independentReadbackSamples,
    baseline: metrics(baseline), unit: metrics(unit), baselineIsPartial: baseline.status !== 'completed',
    speedClaim: false, contractEquivalent: false, packChecksum: 'not_checked', unvisitedObjects: 'not_checked' }));
  assert.equal(unit.status, 'completed');
  if (unit.status !== 'completed') return assert.fail('the shallow unit source did not complete');
  verifyCompleted(unit, value);
  if (baseline.status === 'completed') { verifyCompleted(baseline, value); compareCompleted(baseline, unit); }
  assert.equal(snapshot(value.root), before);

  const addedDepth = 6;
  const deeperRoot = join(value.parent, ...Array.from({ length: addedDepth }, (_, position) => `depth-${position}`), 'repository');
  fs.mkdirSync(dirname(deeperRoot), { recursive: true, mode: 0o700 }); fs.renameSync(value.root, deeperRoot);
  const deeper = { ...value, root: deeperRoot }, deepBefore = snapshot(deeperRoot);
  const deepBaseline = run(createCompanyGitRangeSource(input(deeper, false), () => 0));
  const collection = createCompanyGitRangeUnitCollectionSource(input(deeper, true), {
    repoId: 'synthetic-unit-integration', readRanges: [{ path: selectedPath, startLine: 1, endLine: 1 }],
  }, () => 0);
  let collected: PersonalCollectionEvidence | undefined;
  const deepUnit = run({ inspect: () => { const result = collection.inspect(); collected = result.collected; return result.observation; },
    verify: () => collection.verify().observation, snapshot: collection.snapshot, close: collection.close });
  context.diagnostic(JSON.stringify({ case: 'large-index-fixed-depth-pipeline', addedDepth, objectCount,
    baseline: metrics(deepBaseline), unit: metrics(deepUnit), baselineIsPartial: deepBaseline.status !== 'completed',
    speedClaim: false, contractEquivalent: false, packChecksum: 'not_checked', unvisitedObjects: 'not_checked' }));
  assert.equal(deepUnit.status, 'completed');
  if (deepUnit.status !== 'completed') return assert.fail('the fixed-depth unit collection did not complete');
  verifyCompleted(deepUnit, deeper);
  assert.ok(collected); assert.equal(collected.evidence.length, 1); assert.equal(collected.sourceViews.length, 1);
  assert.equal(collected.evidence[0]!.excerpt.trim(), selectedBody.trim());
  if (deepBaseline.status === 'completed') {
    verifyCompleted(deepBaseline, deeper);
    assert.deepEqual(deepUnit.inspected.fileSystem, deepBaseline.inspected.fileSystem);
    assert.equal(deepUnit.final.readCalls, deepBaseline.final.readCalls);
    assert.equal(deepUnit.final.readBytesReturned, deepBaseline.final.readBytesReturned);
  }
  assert.equal(snapshot(deeperRoot), deepBefore);
});
