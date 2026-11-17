import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createCompanyGitRangeFiles } from '../src/adapters/company-git-range-files.js';
import { createCompanyGitRangeUnitFiles } from '../src/adapters/company-git-range-unit-files.js';
import type { CompanyGitRangeUnitKind } from '../src/domain/company-git-range-unit.js';
import { CompanyGitRangeBudget } from '../src/policy/company-git-range-budget.js';
import { CompanyGitRangeUnitBudget, extractCompanyGitRangeUnitFailure, getCompanyGitRangeUnitProfile,
  getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';

const limits = getCompanyGitRangeUnitProfile().limits;
const source = 'export const answer = 42;\n', stem = `pack-${'a'.repeat(40)}`;
const packPath = `.git/objects/pack/${stem}.pack`, indexPath = `.git/objects/pack/${stem}.idx`;
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const active = (): CompanyGitRangeUnitBudget => { const budget = new CompanyGitRangeUnitBudget(0); budget.beginPass('inspect', 0); return budget; };
const fixture = (context: TestContext) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-unit-files-'))); fs.chmodSync(root, 0o700);
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (path: string, bytes: string | Buffer): void => {
    fs.mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(root, path), bytes, { mode: 0o600 });
  };
  write('.git/HEAD', `${'0'.repeat(40)}\n`); write('src/main.ts', source);
  return { root, write };
};
const session = (context: TestContext, root: string, budget = active(), now = () => 0) => {
  const files = createCompanyGitRangeUnitFiles(root, ['src/main.ts'], budget, now);
  context.after(() => files.close()); return { files, budget };
};
const released = (budget: CompanyGitRangeUnitBudget, uncertainDescriptors = 0): void => {
  const value = budget.snapshot(); assert.equal(value.openDescriptors, uncertainDescriptors);
  for (const key of ['liveMemoryBytes', 'cacheMemoryBytes', 'pendingReads', 'pendingInflations', 'dependencyDepth'] as const) assert.equal(value[key], 0, key);
};
const changed = (operation: () => unknown): void => assert.throws(operation, { code: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' });

test('unit files refuse legacy, copied, forged, derived and proxy budgets before paths, clocks or filesystem access', context => {
  const { root } = fixture(context), valid = active(); let calls = 0, traps = 0;
  class Derived extends CompanyGitRangeUnitBudget {}
  const proxy = new Proxy(valid, { getPrototypeOf: () => { traps++; return CompanyGitRangeUnitBudget.prototype; },
    get: () => { traps++; throw new Error('UNEXPECTED_BUDGET_ACCESS'); } });
  const observed = context.mock.method(fs, 'lstatSync', () => { calls++; throw new Error('UNEXPECTED_METADATA'); });
  for (const budget of [new CompanyGitRangeBudget(0), {}, Object.create(CompanyGitRangeUnitBudget.prototype), new Derived(0), proxy]) {
    assert.throws(() => createCompanyGitRangeUnitFiles(root, ['src/main.ts'], budget as CompanyGitRangeUnitBudget,
      () => { calls++; throw new Error('UNEXPECTED_CLOCK'); }), { code: 'COMPANY_GIT_RANGE_INVALID_BUDGET' });
  }
  observed.mock.restore(); assert.equal(calls, 0); assert.equal(traps, 0);
});

test('pack units read only admitted header, trailer or bounded object spans using 64KiB chunks', context => {
  const { root, write } = fixture(context), size = 9 * 1024 * 1024, objectBytes = limits.readChunkBytes + 7;
  write(packPath, Buffer.alloc(32)); write(indexPath, 'synthetic-index');
  const descriptor = fs.openSync(join(root, packPath), 'r+'); fs.ftruncateSync(descriptor, size); fs.closeSync(descriptor);
  const { files, budget } = session(context, root), file = files.open(packPath, limits.packBytes)!;
  context.mock.method(fs, 'readFileSync', () => { throw new Error('UNEXPECTED_WHOLE_PACK_READ'); });
  assert.equal(Object.hasOwn(file, 'read'), false);
  for (const [kind, offset, length] of [['pack-header', 0, 12], ['pack-trailer', size - 20, 20],
    ['pack-object', 12, objectBytes], ['pack-header', 0, 12]] as const) {
    const unit = file.readUnit(kind, offset, length);
    assert.equal(unit.bytes.length, length); assert.equal(unit.bytes.buffer.byteLength, length);
    assert.ok(unit.bytes.every(byte => byte === 0)); budget.assertMemory(unit.memoryLease, length); budget.releaseMemory(unit.memoryLease);
  }
  file.close(); files.assertUnchanged();
  assert.equal(budget.snapshot().readCalls, 5); assert.equal(budget.snapshot().readBytesReturned, 12 + 20 + objectBytes + 12);
  assert.equal(budget.snapshot().peakMemoryBytes, objectBytes + limits.readChunkBytes);
  const reads = files.proof().files[0]!.reads;
  assert.deepEqual(reads.map(read => [read.offset, read.length]), [[0, 12], [12, limits.readChunkBytes], [12 + limits.readChunkBytes, 7], [size - 20, 20]]);
  assert.ok(reads.every(read => read.length <= limits.readChunkBytes)); released(budget);
});

test('whole-file units enforce complete index, Git and selected-file geometry including zero bytes', context => {
  const cases: [CompanyGitRangeUnitKind, string, number, number][] = [
    ['pack-index', indexPath, limits.indexBytes, limits.indexBytes], ['git-file', '.git/HEAD', limits.readChunkBytes + 9, limits.gitFileBytes],
    ['selected-file', 'src/main.ts', 65536, 65536], ['selected-file', 'src/main.ts', 0, 65536],
  ];
  for (const [kind, path, length, maximum] of cases) {
    const { root, write } = fixture(context), content = Buffer.alloc(length, 7); write(path, content);
    const { files, budget } = session(context, root), file = files.open(path, maximum)!;
    const unit = file.readUnit(kind, 0, file.size);
    assert.equal(hash(unit.bytes), hash(content)); assert.equal(budget.snapshot().readCalls, Math.max(1, Math.ceil(length / limits.readChunkBytes)));
    assert.equal(budget.snapshot().readBytesReserved, length); assert.equal(budget.snapshot().readBytesReturned, length);
    assert.equal(budget.snapshot().peakMemoryBytes, length + Math.min(length, limits.readChunkBytes));
    assert.equal(files.proof().files[0]!.reads.length, Math.max(1, Math.ceil(length / limits.readChunkBytes)));
    if (!length) assert.deepEqual(files.proof().files[0]!.reads, [{ offset: 0, length: 0, sha256: hash('') }]);
    budget.releaseMemory(unit.memoryLease); file.close(); files.assertUnchanged(); released(budget);
  }
});

test('wrong unit kinds, partial whole files and pack-boundary crossings reject before metadata or allocation', context => {
  const cases: [string, string, number, number][] = [
    ['pack-all', packPath, 0, 200], ['git-file', packPath, 0, 200], ['selected-file', indexPath, 0, 100],
    ['pack-index', indexPath, 1, 99], ['pack-index', indexPath, 0, 99], ['git-file', indexPath, 0, 100],
    ['pack-header', packPath, 1, 12], ['pack-header', packPath, 0, 13], ['pack-trailer', packPath, 179, 20],
    ['pack-object', packPath, 0, 1], ['pack-object', packPath, 12, 0], ['pack-object', packPath, 12, 169],
    ['pack-object', packPath, -1, 1], ['pack-object', packPath, 12.5, 1], ['selected-file', 'src/main.ts', 0, 1],
  ];
  for (const [kind, path, offset, length] of cases) {
    const { root, write } = fixture(context); write(packPath, Buffer.alloc(200)); write(indexPath, Buffer.alloc(100));
    const { files, budget } = session(context, root), maximum = path === packPath ? limits.packBytes : path === indexPath ? limits.indexBytes : 65536;
    const file = files.open(path, maximum)!, before = budget.snapshot().metadataCalls;
    assert.throws(() => file.readUnit(kind as CompanyGitRangeUnitKind, offset, length), { code: 'COMPANY_GIT_RANGE_INVALID_UNIT' });
    assert.equal(budget.snapshot().metadataCalls, before); assert.equal(budget.snapshot().readCalls, 0);
    assert.equal(files.proof().files[0]!.reads.length, 0); released(budget);
  }
  const { root, write } = fixture(context); write(packPath, Buffer.alloc(limits.encodedObjectBytes + 33));
  const { files, budget } = session(context, root), file = files.open(packPath, limits.packBytes)!, before = budget.snapshot().metadataCalls;
  assert.throws(() => file.readUnit('pack-object', 12, limits.encodedObjectBytes + 1), { code: 'COMPANY_GIT_RANGE_LIMIT' });
  assert.equal(budget.snapshot().metadataCalls, before); assert.equal(budget.snapshot().readCalls, 0); released(budget);
});

test('unit source path gates reject traversal, secrets, getters and proxies without metadata', context => {
  const { root } = fixture(context);
  for (const path of ['../outside.ts', '/outside.ts', '.env', '.git/config', '.codex/auth.json', 'auth.json', 'src/../main.ts']) {
    const budget = active(); assert.throws(() => createCompanyGitRangeUnitFiles(root, [path], budget, () => 0), { code: 'COMPANY_GIT_RANGE_INVALID_PATH' });
    assert.equal(budget.snapshot().metadataCalls, 0);
  }
  let calls = 0;
  const accessor = Object.defineProperty([], '0', { enumerable: true, get: () => { calls++; return 'src/main.ts'; } });
  const proxy = new Proxy(['src/main.ts'], { get: () => { calls++; throw new Error('UNEXPECTED_GETTER'); } });
  for (const paths of [accessor, proxy]) {
    const budget = active(); assert.throws(() => createCompanyGitRangeUnitFiles(root, paths, budget, () => 0), { code: 'COMPANY_GIT_RANGE_INVALID_PATH' });
    assert.equal(budget.snapshot().metadataCalls, 0);
  }
  assert.equal(calls, 0);
  for (const path of ['src/unselected.ts', '.git/config', '.git/refs/heads/main.lock', '.git/objects/info/alternates']) {
    const { files, budget } = session(context, root), before = budget.snapshot().metadataCalls;
    assert.throws(() => files.open(path, 8), { code: 'COMPANY_GIT_RANGE_INVALID_PATH' }); assert.equal(budget.snapshot().metadataCalls, before);
  }
});

test('persistent file replacement, symlink, hardlink and mode changes fail before returning unit bytes', context => {
  for (const kind of ['replacement', 'symlink', 'hardlink', 'mode', 'size'] as const) {
    const { root, write } = fixture(context), path = join(root, 'src/main.ts'), outside = join(root, 'synthetic-original.ts');
    const { files, budget } = session(context, root), file = files.open('src/main.ts', 65536)!;
    if (['replacement', 'symlink', 'hardlink'].includes(kind)) {
      fs.renameSync(path, outside);
      if (kind === 'replacement') write('src/main.ts', source);
      if (kind === 'symlink') fs.symlinkSync(outside, path);
      if (kind === 'hardlink') fs.linkSync(outside, path);
    } else if (kind === 'mode') fs.chmodSync(path, 0o700);
    else fs.appendFileSync(path, 'changed');
    changed(() => file.readUnit('selected-file', 0, file.size));
    assert.equal(budget.snapshot().readCalls, 0); assert.deepEqual(files.proof().files[0]!.reads, []); released(budget);
  }
});

test('leaf mode, size and FD ownership changes during a chunk reject without returning a unit or its proof', context => {
  for (const kind of ['mode', 'size', 'owner'] as const) {
    const { root, write } = fixture(context), length = limits.readChunkBytes * 2 + 7; write(indexPath, Buffer.alloc(length, 5));
    const { files, budget } = session(context, root), file = files.open(indexPath, limits.indexBytes)!;
    const read = fs.readSync, fstat = fs.fstatSync; let afterRead = false;
    const mockedRead = context.mock.method(fs, 'readSync', ((descriptor: number, bytes: Buffer, offset: number, count: number, position: number) => {
      const returned = read(descriptor, bytes, offset, count, position); afterRead = true;
      if (kind === 'mode') fs.chmodSync(join(root, indexPath), 0o700);
      if (kind === 'size') fs.appendFileSync(join(root, indexPath), 'changed');
      return returned;
    }) as typeof fs.readSync);
    // Synthetic metadata injection exercises the ownership comparison without privileged chown operations.
    const mockedFstat = context.mock.method(fs, 'fstatSync', ((descriptor: number) => {
      const stat = fstat(descriptor); if (kind === 'owner' && afterRead) stat.uid++;
      return stat;
    }) as typeof fs.fstatSync);
    try {
      changed(() => file.readUnit('pack-index', 0, length));
      assert.equal(budget.snapshot().readCalls, 1); assert.equal(budget.snapshot().readBytesReturned, limits.readChunkBytes);
      assert.deepEqual(files.proof().files[0]!.reads, []); released(budget);
    } finally { mockedRead.mock.restore(); mockedFstat.mock.restore(); }
  }
});

test('unit end guard rejects persistent ancestor changes and commits no partial chunk proof', context => {
  for (const kind of ['symlink', 'mode'] as const) {
    const { root, write } = fixture(context), length = limits.readChunkBytes * 2 + 7; write(indexPath, Buffer.alloc(length, 2));
    const parent = dirname(join(root, indexPath)), displaced = join(root, 'synthetic-displaced-pack');
    const { files, budget } = session(context, root), file = files.open(indexPath, limits.indexBytes)!;
    const original = fs.readSync; let reads = 0, changedParent = false;
    const mocked = context.mock.method(fs, 'readSync', ((descriptor: number, bytes: Buffer, offset: number, count: number, position: number) => {
      const returned = original(descriptor, bytes, offset, count, position);
      if (++reads === 1) {
        if (kind === 'symlink') { fs.renameSync(parent, displaced); fs.symlinkSync(displaced, parent); }
        else fs.chmodSync(parent, 0o710);
        changedParent = true;
      }
      return returned;
    }) as typeof fs.readSync);
    try {
      changed(() => file.readUnit('pack-index', 0, length));
      assert.equal(reads, 3); assert.equal(budget.snapshot().readBytesReturned, length);
      assert.deepEqual(files.proof().files[0]!.reads, []); released(budget);
    } finally {
      mocked.mock.restore();
      if (changedParent && kind === 'symlink') { fs.unlinkSync(parent); fs.renameSync(displaced, parent); }
      else if (changedParent) fs.chmodSync(parent, 0o700);
    }
  }
});

test('transient ancestor alias and permission restoration remain an explicit difference from v1', context => {
  for (const mode of ['unit', 'legacy'] as const) for (const kind of ['symlink', 'mode'] as const) {
    const { root, write } = fixture(context), length = limits.readChunkBytes * 2 + 7; write(indexPath, Buffer.alloc(length, 3));
    const parent = dirname(join(root, indexPath)), displaced = join(root, 'synthetic-displaced-pack');
    const unitBudget = active(), legacyBudget = new CompanyGitRangeBudget(0); legacyBudget.beginPass('inspect', 0);
    const unitFiles = mode === 'unit' ? createCompanyGitRangeUnitFiles(root, ['src/main.ts'], unitBudget, () => 0) : null;
    const legacyFiles = mode === 'legacy' ? createCompanyGitRangeFiles(root, ['src/main.ts'], legacyBudget, () => 0) : null;
    const file = unitFiles?.open(indexPath, limits.indexBytes), legacy = legacyFiles?.open(indexPath, limits.indexBytes);
    const original = fs.readSync; let reads = 0, modified = false;
    const restore = (): void => {
      if (!modified) return;
      if (kind === 'symlink') { fs.unlinkSync(parent); fs.renameSync(displaced, parent); } else fs.chmodSync(parent, 0o700);
      modified = false;
    };
    const mocked = context.mock.method(fs, 'readSync', ((descriptor: number, bytes: Buffer, offset: number, count: number, position: number) => {
      const returned = original(descriptor, bytes, offset, count, position); reads++;
      if (reads === 1) {
        if (kind === 'symlink') { fs.renameSync(parent, displaced); fs.symlinkSync(displaced, parent); } else fs.chmodSync(parent, 0o710);
        modified = true;
      } else if (reads === 2) restore();
      return returned;
    }) as typeof fs.readSync);
    try {
      if (file) {
        const unit = file.readUnit('pack-index', 0, length); assert.equal(unit.bytes.length, length); unitBudget.releaseMemory(unit.memoryLease);
        file.close(); unitFiles!.assertUnchanged(); assert.equal(reads, 3); released(unitBudget);
      } else { changed(() => legacy!.read(0, limits.readChunkBytes)); assert.equal(reads, 1); }
    } finally { mocked.mock.restore(); restore(); unitFiles?.close(); legacyFiles?.close(); }
  }
});

test('unit short reads and mid-unit deadlines retain reservations without returning buffers or chunk proof', context => {
  for (const kind of ['short', 'deadline'] as const) {
    const { root, write } = fixture(context), length = limits.readChunkBytes + 9; write(indexPath, Buffer.alloc(length));
    let now = 0;
    const { files, budget } = session(context, root, active(), () => now), file = files.open(indexPath, limits.indexBytes)!;
    const original = fs.readSync;
    const mocked = context.mock.method(fs, 'readSync', ((descriptor: number, bytes: Buffer, offset: number, count: number, position: number) => {
      const returned = original(descriptor, bytes, offset, count - (kind === 'short' ? 1 : 0), position);
      if (kind === 'deadline') now = limits.wallClockMs;
      return returned;
    }) as typeof fs.readSync);
    try {
      assert.throws(() => file.readUnit('pack-index', 0, length), { code: kind === 'short' ? 'COMPANY_GIT_RANGE_SOURCE_CHANGED' : 'COMPANY_GIT_RANGE_TIMEOUT' });
      assert.equal(budget.snapshot().readBytesReserved, limits.readChunkBytes);
      assert.equal(budget.snapshot().readBytesReturned, limits.readChunkBytes - (kind === 'short' ? 1 : 0));
      assert.deepEqual(files.proof().files[0]!.reads, []); released(budget);
    } finally { mocked.mock.restore(); }
  }
});

test('pack listing, missing paths, alternate-store probes and final guards remain active in unit sessions', context => {
  const { root, write } = fixture(context); write(packPath, 'pack'); write(indexPath, 'index');
  const { files } = session(context, root);
  assert.deepEqual(files.listPacks(), [`${stem}.idx`]);
  assert.equal(files.open('.git/objects/ab/' + 'c'.repeat(38), limits.gitFileBytes, true), undefined);
  assert.ok(files.proof().absentPaths.includes('.git/objects/ab/' + 'c'.repeat(38)));
  write('.git/objects/pack/added.keep', ''); changed(() => files.assertUnchanged());
  for (const path of ['.git/objects/ab/' + 'c'.repeat(38), '.git/objects/info/alternates', '.git/objects/info/http-alternates']) {
    const next = fixture(context), current = session(context, next.root);
    if (path.includes('/ab/')) current.files.open(path, limits.gitFileBytes, true);
    next.write(path, 'SYNTHETIC_APPEARED'); changed(() => current.files.assertUnchanged());
  }
  const alternate = fixture(context); alternate.write('.git/objects/info/alternates', 'SYNTHETIC_UNREAD');
  let opened = 0;
  const mocked = context.mock.method(fs, 'openSync', () => { opened++; throw new Error('UNEXPECTED_OPEN'); });
  changed(() => createCompanyGitRangeUnitFiles(alternate.root, ['src/main.ts'], active(), () => 0));
  mocked.mock.restore(); assert.equal(opened, 0);
  const final = fixture(context), current = session(context, final.root), handle = current.files.open('src/main.ts', 65536)!;
  const result = handle.readUnit('selected-file', 0, handle.size); current.budget.releaseMemory(result.memoryLease); handle.close();
  fs.renameSync(join(final.root, 'src'), join(final.root, 'old-src')); final.write('src/main.ts', source);
  changed(() => current.files.assertUnchanged()); released(current.budget);
});

test('pack inventory rejects orphans, excess candidates and directory entries without content reads', context => {
  for (const kind of ['orphan', 'pairs', 'entries'] as const) {
    const { root, write } = fixture(context);
    if (kind === 'entries') for (let index = 0; index <= limits.packDirectoryEntries; index++) write(`.git/objects/pack/item-${index}`, '');
    else for (let index = 0; index < (kind === 'pairs' ? limits.candidatePairs + 1 : 1); index++) {
      const name = `pack-${index.toString(16).padStart(40, '0')}`; write(`.git/objects/pack/${name}.idx`, '');
      if (kind !== 'orphan') write(`.git/objects/pack/${name}.pack`, '');
    }
    const { files, budget } = session(context, root);
    assert.throws(() => files.listPacks(), { code: kind === 'orphan' ? 'COMPANY_GIT_RANGE_SOURCE_CHANGED' : 'COMPANY_GIT_RANGE_LIMIT' });
    assert.equal(budget.snapshot().readCalls, 0); released(budget);
  }
});

test('actual metadata APIs and bounded chunk reads exactly match the new budget across two fresh passes', context => {
  const { root, write } = fixture(context), content = Buffer.alloc(limits.readChunkBytes * 2 + 7, 4);
  write(packPath, 'pack'); write(indexPath, content);
  let metadataCalls = 0, readCalls = 0, bytesRead = 0;
  const lstat = fs.lstatSync, fstat = fs.fstatSync, realpath = fs.realpathSync, open = fs.openSync, opendir = fs.opendirSync, read = fs.readSync;
  context.mock.method(fs, 'lstatSync', ((path: fs.PathLike) => { metadataCalls++; return lstat(path); }) as typeof fs.lstatSync);
  context.mock.method(fs, 'fstatSync', ((descriptor: number) => { metadataCalls++; return fstat(descriptor); }) as typeof fs.fstatSync);
  context.mock.method(fs, 'realpathSync', ((path: fs.PathLike) => { metadataCalls++; return realpath(path); }) as typeof fs.realpathSync);
  context.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: number, mode?: fs.Mode) => { metadataCalls++; return open(path, flags, mode); }) as typeof fs.openSync);
  context.mock.method(fs, 'opendirSync', ((path: fs.PathLike, options?: fs.OpenDirOptions) => {
    metadataCalls++; const directory = opendir(path, options), originalRead = directory.readSync.bind(directory);
    context.mock.method(directory, 'readSync', () => { metadataCalls++; return originalRead(); }); return directory;
  }) as typeof fs.opendirSync);
  context.mock.method(fs, 'readSync', ((descriptor: number, bytes: Buffer, offset: number, count: number, position: number) => {
    assert.ok(count <= limits.readChunkBytes); readCalls++; const returned = read(descriptor, bytes, offset, count, position); bytesRead += returned; return returned;
  }) as typeof fs.readSync);
  const budget = active(); let firstProof: unknown;
  for (const pass of ['inspect', 'verify'] as const) {
    if (pass === 'verify') budget.beginPass(pass, 0);
    const files = createCompanyGitRangeUnitFiles(root, ['src/main.ts'], budget, () => 0);
    const file = files.open(indexPath, limits.indexBytes)!, unit = file.readUnit('pack-index', 0, file.size);
    assert.equal(hash(unit.bytes), hash(content)); budget.releaseMemory(unit.memoryLease); file.close(); files.listPacks(); files.assertUnchanged();
    if (firstProof) assert.deepEqual(files.proof(), firstProof); else firstProof = files.proof();
    files.close(); budget.endPass(0);
  }
  assert.equal(budget.snapshot().metadataCalls, metadataCalls); assert.equal(budget.snapshot().readCalls, readCalls);
  assert.equal(readCalls, 6); assert.equal(budget.snapshot().readBytesReturned, bytesRead); assert.equal(bytesRead, content.length * 2);
  assert.equal(budget.snapshot().profileHash, getCompanyGitRangeUnitProfileHash()); released(budget);
});

test('first budget failure survives uncertain file cleanup without claiming its descriptor was released', context => {
  const { root } = fixture(context), budget = active(), files = createCompanyGitRangeUnitFiles(root, ['src/main.ts'], budget, () => 0);
  const file = files.open('src/main.ts', 65536)!, original = fs.closeSync; let closes = 0;
  while (budget.snapshot().metadataCalls < limits.metadataCalls) budget.chargeMetadata('lstat');
  const mocked = context.mock.method(fs, 'closeSync', (descriptor: number) => { original(descriptor); closes++; throw new Error('SYNTHETIC_UNCERTAIN_CLOSE'); });
  try {
    assert.throws(() => file.readUnit('selected-file', 0, file.size), error => {
      const failure = extractCompanyGitRangeUnitFailure(error); assert.ok(failure); assert.equal(failure.limit.name, 'metadataCalls');
      assert.equal(failure.profileHash, getCompanyGitRangeUnitProfileHash()); return true;
    });
    changed(() => files.close()); changed(() => file.close()); assert.equal(closes, 1); released(budget, 1);
    assert.deepEqual(files.proof().files[0]!.reads, []);
  } finally { mocked.mock.restore(); }
});

test('uncertain directory cleanup preserves the first inventory limit and its outstanding descriptor charge', context => {
  const { root, write } = fixture(context);
  for (let index = 0; index <= limits.packDirectoryEntries; index++) write(`.git/objects/pack/item-${index}`, '');
  const budget = active(), files = createCompanyGitRangeUnitFiles(root, ['src/main.ts'], budget, () => 0), original = fs.opendirSync;
  let closes = 0;
  const mocked = context.mock.method(fs, 'opendirSync', ((path: fs.PathLike, options?: fs.OpenDirOptions) => {
    const directory = original(path, options), close = directory.closeSync.bind(directory);
    context.mock.method(directory, 'closeSync', () => { close(); closes++; throw new Error('SYNTHETIC_DIRECTORY_CLOSE'); }); return directory;
  }) as typeof fs.opendirSync);
  try {
    assert.throws(() => files.listPacks(), error => {
      const failure = extractCompanyGitRangeUnitFailure(error); assert.ok(failure); assert.equal(failure.limit.name, 'packDirectoryEntries'); return true;
    });
    files.close(); assert.equal(closes, 1); released(budget, 1);
  } finally { mocked.mock.restore(); }
});
