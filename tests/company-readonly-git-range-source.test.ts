import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { createCompanyGitRangeSource } from '../src/adapters/company-git-range-source.js';
import { HarnessError } from '../src/domain/errors.js';
import { getCompanyGitRangeProfile, getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { companyGitRangeCrc32 } from '../src/policy/company-git-range-object-codec.js';
import { createCompanyGitRangeFixture } from './company-readonly-git-range-fixture.js';

type Fixture = Awaited<ReturnType<typeof createCompanyGitRangeFixture>>;
type Source = ReturnType<typeof createCompanyGitRangeSource>;
type Observation = ReturnType<Source['inspect']>;
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const input = (fixture: Fixture) => ({ version: 'company-git-range-source-v1', profileHash: getCompanyGitRangeProfileHash(),
  sourceRoot: fixture.root, baseCommit: fixture.baseCommit, selectedPaths: fixture.selectedPaths });
const resourcesReleased = (source: Source): void => {
  const state = source.snapshot();
  assert.equal(state.openDescriptors, 0); assert.equal(state.liveMemoryBytes, 0); assert.equal(state.cacheMemoryBytes, 0);
  assert.equal(state.pendingReads, 0); assert.equal(state.pendingInflations, 0); assert.equal(state.dependencyDepth, 0);
};
const noRawBodies = (observation: Observation, fixture: Fixture): void => {
  const serialized = JSON.stringify(observation);
  for (const text of Object.values(fixture.selectedFiles)) {
    for (const line of text.trim().split('\n')) assert.equal(serialized.includes(line), false);
  }
  assert.equal(serialized.includes('export const value'), false);
  assert.equal(serialized.includes('Synthetic historical source'), false);
  assert.equal(serialized.includes('"type":"Buffer"'), false);
};
const sourceFailure = (action: () => unknown, source: Source, fixture: Fixture, code?: string): void => {
  assert.throws(action, error => {
    assert.ok(error instanceof HarnessError); assert.match(error.code, /^COMPANY_GIT_RANGE_[A-Z_]+$/u);
    if (code) assert.equal(error.code, code);
    assert.equal(error.message, error.code); assert.equal(String(error).includes(fixture.root), false);
    assert.equal(String(error).includes('export const value'), false); return true;
  });
  assert.equal(source.snapshot().phase, 'failed'); resourcesReleased(source);
};

test('source sessions inspect and freshly verify OFS, REF and loose objects without returning raw source bodies', async context => {
  for (const layout of ['pack', 'pack-ref', 'loose'] as const) {
    const fixture = await createCompanyGitRangeFixture(context, layout), before = fixture.snapshot();
    const source = createCompanyGitRangeSource(input(fixture), () => 0);
    try {
      const inspected = source.inspect(), first = source.snapshot();
      assert.equal(inspected.version, 'company-git-range-source-observation-v1');
      assert.equal(inspected.profileHash, getCompanyGitRangeProfileHash()); assert.equal(inspected.baseCommit, fixture.baseCommit);
      assert.equal(inspected.integrityScope, 'selected-object-chain'); assert.equal(inspected.packChecksum, 'not_checked');
      assert.equal(inspected.unvisitedObjects, 'not_checked');
      assert.deepEqual(inspected.selectedFiles.map(file => file.path).sort(), [...fixture.selectedPaths].sort());
      for (const file of inspected.selectedFiles) {
        const content = fixture.selectedFiles[file.path]!;
        assert.equal(file.bytes, Buffer.byteLength(content)); assert.equal(file.sha256, hash(content)); assert.equal(file.mode, '100644');
        const expected = fixture.objects.find(object => object.type === 'blob' && object.content.equals(Buffer.from(content)))!;
        assert.equal(file.oid, expected.oid);
      }
      if (layout === 'loose') {
        assert.equal(inspected.packs.length, 0); assert.ok(inspected.looseObjects.some(object => object.oid === fixture.mainOid));
      } else {
        assert.equal(inspected.packs.length, 1); assert.equal(inspected.looseObjects.length, 0);
        const proof = inspected.packs[0]!.byteProof;
        assert.ok(proof); assert.equal(proof.packChecksum, 'not_checked');
        assert.ok(proof.objects.some(object => object.oid === fixture.deltaBaseOid));
        assert.equal(proof.objects.find(object => object.oid === fixture.mainOid)?.encoding, layout === 'pack' ? 'ofs-delta' : 'ref-delta');
      }
      noRawBodies(inspected, fixture); assert.equal(first.phase, 'between'); resourcesReleased(source);
      const verified = source.verify(), second = source.snapshot();
      assert.deepEqual(verified, inspected); assert.equal(verified.proofHash, inspected.proofHash);
      assert.equal(second.phase, 'complete'); assert.equal(second.completedPasses, 2);
      assert.ok(second.readCalls > first.readCalls); assert.ok(second.readBytesReserved > first.readBytesReserved);
      assert.ok(second.inflations > first.inflations); assert.equal(second.visitedObjects, first.visitedObjects);
      assert.equal(second.readBytesReturned, second.readBytesReserved);
      resourcesReleased(source); assert.equal(fixture.snapshot(), before);
    } finally { source.close(); }
  }
});

test('a valid 4106-object pack larger than eight MiB is read in small selected spans under one two-pass budget', async context => {
  const fixture = await createCompanyGitRangeFixture(context, 'pack', true), before = fixture.snapshot();
  const packPath = fixture.packPath!, packBytes = fs.statSync(packPath).size, indexBytes = fs.statSync(fixture.indexPath!).size;
  assert.equal(fixture.objects.length, 4106); assert.ok(packBytes > 8 * 1024 * 1024);
  const source = createCompanyGitRangeSource(input(fixture));
  try {
    const inspect = source.inspect(), first = source.snapshot(), verify = source.verify(), second = source.snapshot();
    assert.equal(inspect.proofHash, verify.proofHash);
    assert.equal(inspect.packs[0]!.metadata.objectCount, fixture.objects.length);
    assert.ok(inspect.packs[0]!.byteProof!.objects.length < 16);
    for (const observation of [inspect, verify]) {
      const pack = observation.fileSystem.files.find(file => file.path === relative(fixture.root, packPath));
      assert.ok(pack); assert.equal(pack.size, packBytes);
      const observedBytes = pack.reads.reduce((sum, read) => sum + read.length, 0);
      assert.ok(observedBytes > 32); assert.ok(observedBytes < packBytes / 32);
      assert.ok(pack.reads.every(read => read.length <= getCompanyGitRangeProfile().limits.readChunkBytes));
      assert.ok(pack.reads.some(read => read.offset === 0 && read.length === 12));
      assert.ok(pack.reads.some(read => read.offset === packBytes - 20 && read.length === 20));
      assert.equal(pack.reads.some(read => read.offset === 0 && read.length === packBytes), false);
      noRawBodies(observation, fixture);
    }
    assert.ok(first.readBytesReserved >= indexBytes); assert.ok(second.readBytesReserved >= 2 * indexBytes);
    assert.ok(second.readBytesReserved < packBytes / 4); assert.ok(second.readBytesReserved > first.readBytesReserved);
    assert.equal(second.readBytesReturned, second.readBytesReserved);
    assert.equal(second.passes.inspect.indexObjects, 4106); assert.equal(second.passes.verify.indexObjects, 4106);
    assert.equal(second.visitedObjects, first.visitedObjects); assert.ok(second.inflations > first.inflations);
    assert.ok(second.lastNowMs > second.startedAtMs);
    context.diagnostic(JSON.stringify({ case: 'large-pack-positioned-read', packBytes, indexBytes,
      packSpanBytesPerPass: inspect.fileSystem.files.find(file => file.path === relative(fixture.root, packPath))!.reads.reduce((sum, read) => sum + read.length, 0),
      requestReadBytes: second.readBytesReserved, readCalls: second.readCalls, metadataCalls: second.metadataCalls,
      visitedObjects: second.visitedObjects, inflations: second.inflations, peakManagedBytes: second.peakMemoryBytes,
      elapsedMs: second.lastNowMs - second.startedAtMs }));
    resourcesReleased(source); assert.equal(fixture.snapshot(), before);
  } finally { source.close(); }
});

test('symbolic HEAD resolves only its exact local or packed branch ref and is rechecked on verification', async context => {
  for (const packed of [false, true]) {
    const fixture = await createCompanyGitRangeFixture(context);
    const ref = 'refs/heads/synthetic-topic';
    fs.mkdirSync(join(fixture.root, '.git/refs/heads'), { recursive: true });
    fs.writeFileSync(join(fixture.root, '.git/HEAD'), `ref: ${ref}\n`);
    const refPath = join(fixture.root, '.git', packed ? 'packed-refs' : ref);
    const content = packed ? `# pack-refs with: peeled fully-peeled sorted\n${fixture.baseCommit} ${ref}\n` : `${fixture.baseCommit}\n`;
    fs.writeFileSync(refPath, content);
    const before = fixture.snapshot(), source = createCompanyGitRangeSource(input(fixture), () => 0);
    try { assert.equal(source.inspect().proofHash, source.verify().proofHash); resourcesReleased(source); }
    finally { source.close(); }
    assert.equal(fixture.snapshot(), before);
    const changing = createCompanyGitRangeSource(input(fixture), () => 0);
    try {
      changing.inspect(); fs.writeFileSync(refPath, content.replace(fixture.baseCommit, 'f'.repeat(40)));
      sourceFailure(() => changing.verify(), changing, fixture);
    } finally { changing.close(); }
  }
});

test('final verification rejects HEAD, working index, selected bytes and executable-mode changes without writing source files', async context => {
  for (const kind of ['HEAD', 'index', 'selected', 'mode'] as const) {
    const fixture = await createCompanyGitRangeFixture(context), source = createCompanyGitRangeSource(input(fixture), () => 0);
    try {
      source.inspect();
      if (kind === 'HEAD') fs.writeFileSync(join(fixture.root, '.git/HEAD'), `${'0'.repeat(40)}\n`);
      if (kind === 'index') fs.appendFileSync(join(fixture.root, '.git/index'), 'SYNTHETIC_INDEX_CHANGE');
      if (kind === 'selected') fs.writeFileSync(join(fixture.root, 'src/main.ts'), fixture.selectedFiles['src/main.ts']!.replace('42', '43'));
      if (kind === 'mode') fs.chmodSync(join(fixture.root, 'src/main.ts'), 0o700);
      const changed = fixture.snapshot(); sourceFailure(() => source.verify(), source, fixture);
      assert.equal(fixture.snapshot(), changed);
    } finally { source.close(); }
  }
});

test('final verification rejects pack inode replacement, hardlinks and symlinks even when selected content is unchanged', async context => {
  for (const kind of ['replacement', 'hardlink', 'symlink'] as const) {
    const fixture = await createCompanyGitRangeFixture(context), source = createCompanyGitRangeSource(input(fixture), () => 0);
    try {
      source.inspect(); const pack = fixture.packPath!, displaced = join(fixture.root, 'synthetic-displaced-pack');
      if (kind === 'hardlink') fs.linkSync(pack, displaced);
      else {
        fs.renameSync(pack, displaced);
        if (kind === 'replacement') fs.copyFileSync(displaced, pack); else fs.symlinkSync(displaced, pack);
      }
      const changed = fixture.snapshot(); sourceFailure(() => source.verify(), source, fixture);
      assert.equal(fixture.snapshot(), changed);
    } finally { source.close(); }
  }
});

/** Keep checksums and the selected span CRC consistent while making its REF base absent from this pack. */
const removeReferencedBase = (fixture: Fixture): void => {
  const pack = fs.readFileSync(fixture.packPath!), index = fs.readFileSync(fixture.indexPath!);
  const main = fixture.objects.find(object => object.oid === fixture.mainOid)!, offset = main.offset!;
  let reference = offset + 1;
  while (pack[reference - 1]! & 128) reference++;
  assert.equal(pack[offset]! >>> 4 & 7, 7);
  Buffer.from('f'.repeat(40), 'hex').copy(pack, reference);
  const count = index.readUInt32BE(1028);
  let position = 0;
  while (position < count && index.subarray(1032 + position * 20, 1052 + position * 20).toString('hex') !== fixture.mainOid) position++;
  assert.ok(position < count);
  index.writeUInt32BE(companyGitRangeCrc32(pack.subarray(offset, offset + main.encoded!.length)), 1032 + count * 20 + position * 4);
  createHash('sha1').update(pack.subarray(0, -20)).digest().copy(pack, pack.length - 20);
  pack.subarray(-20).copy(index, index.length - 40);
  createHash('sha1').update(index.subarray(0, -20)).digest().copy(index, index.length - 20);
  fs.writeFileSync(fixture.packPath!, pack); fs.writeFileSync(fixture.indexPath!, index);
};

test('a selected REF delta with a missing same-pack base fails before observation and during final verification', async context => {
  for (const afterInspect of [false, true]) {
    const fixture = await createCompanyGitRangeFixture(context, 'pack-ref'), source = createCompanyGitRangeSource(input(fixture), () => 0);
    try {
      if (afterInspect) source.inspect();
      removeReferencedBase(fixture); const changed = fixture.snapshot();
      sourceFailure(() => afterInspect ? source.verify() : source.inspect(), source, fixture);
      assert.equal(fixture.snapshot(), changed);
    } finally { source.close(); }
  }
});

test('version, profile, shape, accessor and prohibited-path gates reject before any filesystem metadata or open', () => {
  const valid = { version: 'company-git-range-source-v1', profileHash: getCompanyGitRangeProfileHash(),
    sourceRoot: '/synthetic/nonexistent-git-range-source', baseCommit: '1'.repeat(40), selectedPaths: ['src/main.ts'] };
  let calls = 0, getters = 0;
  const open = fs.openSync, lstat = fs.lstatSync, realpath = fs.realpathSync, readdir = fs.readdirSync;
  fs.openSync = ((...args) => { calls++; return Reflect.apply(open, fs, args); }) as typeof fs.openSync;
  fs.lstatSync = ((...args) => { calls++; return Reflect.apply(lstat, fs, args); }) as typeof fs.lstatSync;
  fs.realpathSync = ((...args) => { calls++; return Reflect.apply(realpath, fs, args); }) as typeof fs.realpathSync;
  fs.readdirSync = ((...args) => { calls++; return Reflect.apply(readdir, fs, args); }) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try {
    const accessor = Object.defineProperty({ ...valid }, 'sourceRoot', { enumerable: true, get() { getters++; return valid.sourceRoot; } });
    const invalid = [{ ...valid, version: 'company-readonly-registration-v1' }, { ...valid, profileHash: '0'.repeat(64) },
      { ...valid, enabled: true }, { ...valid, selectedPaths: [] }, { ...valid, selectedPaths: ['src/main.ts', 'src/main.ts'] }, accessor,
      ...['../outside.ts', '/synthetic/outside.ts', '.env', '.git/config', 'auth.json', '.codex/auth.json', 'src/../main.ts']
        .map(path => ({ ...valid, selectedPaths: [path] }))];
    for (const value of invalid) assert.throws(() => createCompanyGitRangeSource(value, () => 0).inspect(), { code: 'COMPANY_GIT_RANGE_INVALID_SOURCE_INPUT' });
    assert.equal(calls, 0); assert.equal(getters, 0);
  } finally {
    fs.openSync = open; fs.lstatSync = lstat; fs.realpathSync = realpath; fs.readdirSync = readdir; syncBuiltinESMExports();
  }
});

test('source sessions reject repeated or reversed passes and share the original deadline', async context => {
  for (const kind of ['repeat-inspect', 'verify-first', 'deadline'] as const) {
    const fixture = await createCompanyGitRangeFixture(context); let now = 0;
    const source = createCompanyGitRangeSource(input(fixture), () => now);
    try {
      if (kind !== 'verify-first') source.inspect();
      if (kind === 'deadline') now = getCompanyGitRangeProfile().limits.wallClockMs;
      const before = fixture.snapshot();
      sourceFailure(() => kind === 'repeat-inspect' ? source.inspect() : source.verify(), source, fixture,
        kind === 'deadline' ? 'COMPANY_GIT_RANGE_TIMEOUT' : undefined);
      assert.equal(fixture.snapshot(), before);
    } finally { source.close(); }
  }
});

test('read failures during final verification remain fixed errors and release descriptors, receipts and buffers', async context => {
  const fixture = await createCompanyGitRangeFixture(context), source = createCompanyGitRangeSource(input(fixture), () => 0);
  const original = fs.readSync;
  try {
    source.inspect(); const before = fixture.snapshot(); let reads = 0;
    fs.readSync = (() => { reads++; throw new Error(`SYNTHETIC_PRIVATE_READ_FAILURE ${fixture.root} export const value`); }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try { sourceFailure(() => source.verify(), source, fixture); }
    finally { fs.readSync = original; syncBuiltinESMExports(); }
    assert.equal(reads, 1); assert.equal(fixture.snapshot(), before);
  } finally { fs.readSync = original; syncBuiltinESMExports(); source.close(); }
});

test('an unexpected trusted-clock exception is mapped without exposing raw details or leaving source state live', async context => {
  const fixture = await createCompanyGitRangeFixture(context); let failClock = false;
  const source = createCompanyGitRangeSource(input(fixture), () => {
    if (failClock) throw new Error(`SYNTHETIC_PRIVATE_CLOCK_FAILURE ${fixture.root} export const value`); return 0;
  });
  try {
    source.inspect(); const before = fixture.snapshot(); failClock = true;
    sourceFailure(() => source.verify(), source, fixture, 'COMPANY_GIT_RANGE_INVALID_SOURCE');
    assert.equal(fixture.snapshot(), before);
  } finally { source.close(); }
});

test('clock failures at construction and final pass completion cannot expose raw errors', async context => {
  const fixture = await createCompanyGitRangeFixture(context);
  assert.throws(() => createCompanyGitRangeSource(input(fixture), () => { throw new Error(fixture.root); }),
    { code: 'COMPANY_GIT_RANGE_INVALID_SOURCE' });
  let measuredCalls = 0;
  const measured = createCompanyGitRangeSource(input(fixture), () => { measuredCalls++; return 0; });
  measured.inspect(); measured.close();
  let calls = 0;
  const source = createCompanyGitRangeSource(input(fixture), () => {
    if (++calls === measuredCalls) throw new Error(fixture.root); return 0;
  });
  try { sourceFailure(() => source.inspect(), source, fixture, 'COMPANY_GIT_RANGE_INVALID_SOURCE'); }
  finally { source.close(); }
});
