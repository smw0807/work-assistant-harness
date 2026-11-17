import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test, type TestContext } from 'node:test';
import { createCompanyGitRangeFiles } from '../src/adapters/company-git-range-files.js';
import type { CompanyGitRangeDescriptorLease, CompanyGitRangePass } from '../src/domain/company-git-range.js';
import { HarnessError } from '../src/domain/errors.js';
import { CompanyGitRangeBudget, extractCompanyGitRangeFailure, getCompanyGitRangeProfile,
  getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';

/**
 * UNAPPROVED TEST-ONLY CONTRACT. Nothing in this file is exported or selected by the production reader/CLI.
 * The existing budget is an allocator/counter only: its profileHash does not approve this different guard schedule.
 * These index-shaped bytes are not parsed Git indexes. No object/OID validation, preparation or approval is claimed.
 */
const experiment = 'unapproved-test-only-read-unit-guard-v0';
const limits = getCompanyGitRangeProfile().limits;
const sizes = [1324, 1324, 45956, 2543864];
const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
const expectedReads = sizes.reduce((sum, size) => sum + Math.ceil(size / limits.readChunkBytes), 0);
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
type Rejection = 'unsafe_path' | 'changed' | 'short_read' | 'cleanup';
class UnitGuardFailure extends Error {
  constructor(readonly reason: Rejection) { super('TEST_ONLY_UNIT_GUARD_REJECTED'); }
}
const reject = (reason: Rejection = 'changed'): never => { throw new UnitGuardFailure(reason); };
interface ChunkPoint { pass: CompanyGitRangePass; unit: number; chunk: number }
type AfterChunk = (point: ChunkPoint) => void;
interface UnitHash { bytes: number; sha256: string }
interface Fixture { parent: string; root: string; paths: string[]; expected: UnitHash[]; packDirectory: string }
const fixture = (context: TestContext, depth = 0): Fixture => {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'unit-guard-experiment-'))); fs.chmodSync(parent, 0o700);
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'repository', ...Array.from({ length: depth }, (_, position) => `depth-${position}`));
  const packDirectory = join(root, '.git/objects/pack'); fs.mkdirSync(packDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(root, '.git/objects/info'), { mode: 0o700 });
  fs.writeFileSync(join(root, 'synthetic.ts'), '', { mode: 0o600 });
  const paths = sizes.map((_, position) => `.git/objects/pack/pack-${String(position + 1).padStart(40, '0')}.idx`);
  const expected = paths.map((path, position) => {
    const bytes = Buffer.alloc(sizes[position]!, position + 1);
    bytes.writeUInt32BE(0xff744f63, 0); bytes.writeUInt32BE(2, 4);
    fs.writeFileSync(join(root, path), bytes, { mode: 0o600 });
    return { bytes: bytes.length, sha256: hash(bytes) };
  });
  return { parent, root, packDirectory, paths, expected };
};
const freshBudget = (): CompanyGitRangeBudget => new CompanyGitRangeBudget(performance.now());
const released = (budget: CompanyGitRangeBudget, uncertainDescriptors = 0): void => {
  const snapshot = budget.snapshot();
  assert.equal(snapshot.openDescriptors, uncertainDescriptors);
  for (const key of ['liveMemoryBytes', 'cacheMemoryBytes', 'pendingReads', 'pendingInflations', 'dependencyDepth'] as const) {
    assert.equal(snapshot[key], 0, key);
  }
};
const sameParent = (left: fs.Stats, right: fs.Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
const sameFile = (left: fs.Stats, right: fs.Stats): boolean => sameParent(left, right) && left.nlink === right.nlink
  && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
interface OpenUnit { path: string; descriptor: number | null; metadata: fs.Stats; lease: CompanyGitRangeDescriptorLease }
type MetadataStage = 'initialization' | 'open' | 'unit' | 'final';
const stageCounts = new WeakMap<CompanyGitRangeBudget, Record<MetadataStage, number>>();
const measure = <T>(budget: CompanyGitRangeBudget, stage: MetadataStage, operation: () => T): T => {
  const before = budget.snapshot().metadataCalls;
  try { return operation(); }
  finally {
    const counts = stageCounts.get(budget) ?? { initialization: 0, open: 0, unit: 0, final: 0 };
    counts[stage] += budget.snapshot().metadataCalls - before; stageCounts.set(budget, counts);
  }
};

/**
 * Candidate observation schedule: full ancestry at open/unit boundaries/final; leaf+FD before and after each read.
 * All body reads use an already opened FD. A transient ancestor alias to that same FD's file can evade this schedule.
 */
const candidatePass = (value: Fixture, paths: readonly string[], pass: CompanyGitRangePass,
  budget: CompanyGitRangeBudget, afterChunk?: AfterChunk): UnitHash[] => {
  if (!paths.length || paths.some(path => !/^\.git\/objects\/pack\/pack-[a-f0-9]{40}\.idx$/u.test(path))) return reject('unsafe_path');
  budget.beginPass(pass, performance.now());
  const parents = new Map<string, fs.Stats>(), opened: OpenUnit[] = [], results: UnitHash[] = [];
  const metadata = <T>(operation: 'lstat' | 'realpath' | 'fstat' | 'open', action: () => T): T => {
    budget.checkActive(performance.now()); budget.chargeMetadata(operation); return action();
  };
  const observeParents = (path: string): void => {
    let current: string = sep;
    for (const part of ['', ...path.split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      const stat = metadata('lstat', () => fs.lstatSync(current));
      if (!stat.isDirectory() || stat.isSymbolicLink() || metadata('realpath', () => fs.realpathSync(current)) !== current) reject();
      const previous = parents.get(current);
      if (previous && !sameParent(previous, stat)) reject();
      parents.set(current, stat);
    }
  };
  const regular = (stat: fs.Stats): void => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limits.indexBytes) reject();
  };
  const leafAndDescriptor = (file: OpenUnit): void => {
    if (file.descriptor === null) return reject();
    const leaf = metadata('lstat', () => fs.lstatSync(file.path));
    const descriptor = metadata('fstat', () => fs.fstatSync(file.descriptor!));
    regular(leaf); regular(descriptor);
    if (!sameFile(file.metadata, leaf) || !sameFile(file.metadata, descriptor)) reject();
  };
  const fullGuard = (file: OpenUnit): void => { observeParents(dirname(file.path)); leafAndDescriptor(file); };
  let failed = false, firstError: unknown;
  try {
    for (const [unit, path] of paths.entries()) {
      const file = measure(budget, 'open', () => {
        const absolute = join(value.root, path);
        observeParents(dirname(absolute));
        const observed = metadata('lstat', () => fs.lstatSync(absolute)); regular(observed);
        const lease = budget.reserveDescriptor();
        let descriptor: number;
        try {
          descriptor = metadata('open', () => fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
        } catch (error) { budget.releaseDescriptor(lease); throw error; }
        const file: OpenUnit = { path: absolute, metadata: observed, descriptor, lease }; opened.push(file);
        fullGuard(file); return file;
      });
      measure(budget, 'unit', () => {
        fullGuard(file); // The complete file, at most eight MiB, is one candidate read unit.
        const unitLease = budget.reserveMemory(file.metadata.size);
        try {
          const bytes = Buffer.allocUnsafeSlow(file.metadata.size);
          let offset = 0, chunk = 0;
          do {
            const length = Math.min(limits.readChunkBytes, file.metadata.size - offset);
            leafAndDescriptor(file);
            const chunkLease = budget.reserveMemory(length);
            let receipt: ReturnType<CompanyGitRangeBudget['reserveRead']> | undefined;
            try {
              const content = Buffer.allocUnsafeSlow(length); receipt = budget.reserveRead(length);
              budget.checkActive(performance.now());
              const returned = fs.readSync(file.descriptor!, content, 0, length, offset);
              budget.completeRead(receipt, returned); receipt = undefined;
              if (returned !== length) reject('short_read');
              leafAndDescriptor(file); content.copy(bytes, offset); offset += returned;
            } catch (error) {
              if (receipt) budget.failRead(receipt);
              throw error;
            } finally { budget.releaseMemory(chunkLease); }
            afterChunk?.({ pass, unit, chunk: chunk++ });
          } while (offset < file.metadata.size);
          fullGuard(file);
          results.push({ bytes: bytes.length, sha256: hash(bytes) });
        } finally { budget.releaseMemory(unitLease); }
      });
    }
    // Descriptors remain live for the complete pass, including this final full guard.
    measure(budget, 'final', () => { for (const file of opened) fullGuard(file); });
  } catch (error) {
    failed = true; firstError = error instanceof UnitGuardFailure || error instanceof HarnessError ? error : new UnitGuardFailure('changed');
    budget.abort();
  }
  for (const file of opened) {
    try {
      fs.closeSync(file.descriptor!); file.descriptor = null; budget.releaseDescriptor(file.lease);
    } catch {
      // Never retry an uncertain descriptor number or release its charge without a confirmed close.
      if (!failed) firstError = new UnitGuardFailure('cleanup');
      failed = true; budget.abort();
    }
  }
  if (failed) throw firstError;
  budget.endPass(performance.now());
  return results;
};
const candidate = (value: Fixture, budget: CompanyGitRangeBudget, paths = value.paths, afterChunk?: AfterChunk): UnitHash[][] =>
  (['inspect', 'verify'] as const).map(pass => candidatePass(value, paths, pass, budget, afterChunk));

/** Actual v1 file-reader calls, including fresh reads, its unchanged guards and final observation. */
const baseline = (value: Fixture, budget: CompanyGitRangeBudget, paths = value.paths, afterChunk?: AfterChunk): UnitHash[][] => {
  const passes: UnitHash[][] = [];
  for (const pass of ['inspect', 'verify'] as const) {
    budget.beginPass(pass, performance.now());
    const files = measure(budget, 'initialization', () => createCompanyGitRangeFiles(value.root, ['synthetic.ts'], budget, () => performance.now()));
    const results: UnitHash[] = [];
    try {
      for (const [unit, path] of paths.entries()) {
        const file = measure(budget, 'open', () => files.open(path, limits.indexBytes)!);
        measure(budget, 'unit', () => {
          const lease = budget.reserveMemory(file.size);
          try {
            const bytes = Buffer.allocUnsafeSlow(file.size);
            let offset = 0, chunk = 0;
            do {
              const content = file.read(offset, Math.min(limits.readChunkBytes, file.size - offset));
              try { content.bytes.copy(bytes, offset); offset += content.bytes.length; }
              finally { budget.releaseMemory(content.memoryLease); }
              afterChunk?.({ pass, unit, chunk: chunk++ });
            } while (offset < file.size);
            results.push({ bytes: bytes.length, sha256: hash(bytes) });
          } finally { budget.releaseMemory(lease); }
        });
      }
      measure(budget, 'final', () => files.assertUnchanged());
    } finally { files.close(); }
    budget.endPass(performance.now()); passes.push(results);
  }
  return passes;
};
const metrics = (budget: CompanyGitRangeBudget) => {
  const snapshot = budget.snapshot();
  const metadataByStage = stageCounts.get(budget)!;
  assert.equal(Object.values(metadataByStage).reduce((sum, count) => sum + count, 0), snapshot.metadataCalls);
  return { allocatorProfileHash: snapshot.profileHash, completedPasses: snapshot.completedPasses,
    metadataCalls: snapshot.metadataCalls, readCalls: snapshot.readCalls, reservedBytes: snapshot.readBytesReserved,
    returnedBytes: snapshot.readBytesReturned, peakManagedBytes: snapshot.peakMemoryBytes, peakDescriptors: snapshot.peakOpenDescriptors,
    metadataByStage };
};
const observeFsApis = <T>(context: TestContext, operation: () => T) => {
  const metadata = { lstatSync: 0, realpathSync: 0, fstatSync: 0, openSync: 0, readdirSync: 0 };
  const reads = { calls: 0, requestedBytes: 0, returnedBytes: 0 };
  const lstat = fs.lstatSync, realpath = fs.realpathSync, fstat = fs.fstatSync, open = fs.openSync, readdir = fs.readdirSync, read = fs.readSync;
  const mocks = [
    context.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof fs.lstatSync>) => {
      metadata.lstatSync++; return Reflect.apply(lstat, fs, args);
    }) as typeof fs.lstatSync),
    context.mock.method(fs, 'realpathSync', ((...args: Parameters<typeof fs.realpathSync>) => {
      metadata.realpathSync++; return Reflect.apply(realpath, fs, args);
    }) as typeof fs.realpathSync),
    context.mock.method(fs, 'fstatSync', ((...args: Parameters<typeof fs.fstatSync>) => {
      metadata.fstatSync++; return Reflect.apply(fstat, fs, args);
    }) as typeof fs.fstatSync),
    context.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
      metadata.openSync++; return Reflect.apply(open, fs, args);
    }) as typeof fs.openSync),
    context.mock.method(fs, 'readdirSync', ((...args: Parameters<typeof fs.readdirSync>) => {
      metadata.readdirSync++; return Reflect.apply(readdir, fs, args);
    }) as typeof fs.readdirSync),
    context.mock.method(fs, 'readSync', ((descriptor: number, bytes: Buffer, offset: number, length: number, position: number) => {
      assert.ok(length <= limits.readChunkBytes); reads.calls++; reads.requestedBytes += length;
      const returned = read(descriptor, bytes, offset, length, position); reads.returnedBytes += returned; return returned;
    }) as typeof fs.readSync),
  ];
  try { return { result: operation(), metadata, reads }; }
  finally { for (const mock of mocks) mock.mock.restore(); }
};

test('unapproved unit guards preserve chunk reads, byte totals and hashes while using a different metadata schedule', context => {
  const value = fixture(context), originalBudget = freshBudget(), candidateBudget = freshBudget();
  const original = observeFsApis(context, () => baseline(value, originalBudget));
  const changed = observeFsApis(context, () => candidate(value, candidateBudget));
  assert.deepEqual(original.result, [value.expected, value.expected]); assert.deepEqual(changed.result, original.result);
  for (const [budget, observed] of [[originalBudget, original], [candidateBudget, changed]] as const) {
    assert.equal(budget.snapshot().completedPasses, 2); assert.equal(budget.snapshot().readCalls, expectedReads * 2);
    assert.equal(budget.snapshot().readBytesReserved, totalBytes * 2); assert.equal(budget.snapshot().readBytesReturned, totalBytes * 2);
    assert.equal(budget.snapshot().peakMemoryBytes, Math.max(...sizes) + limits.readChunkBytes);
    assert.equal(budget.snapshot().peakOpenDescriptors, 4); released(budget);
    assert.equal(Object.values(observed.metadata).reduce((sum, count) => sum + count, 0), budget.snapshot().metadataCalls);
    assert.equal(observed.reads.calls, budget.snapshot().readCalls);
    assert.equal(observed.reads.requestedBytes, budget.snapshot().readBytesReserved);
    assert.equal(observed.reads.returnedBytes, budget.snapshot().readBytesReturned);
  }
  assert.ok(candidateBudget.snapshot().metadataCalls < originalBudget.snapshot().metadataCalls);
  assert.equal(getCompanyGitRangeProfileHash(), '8fc98736b72781db4567c808f6dca086b8b9ec1a4f97eb5e551d8ee0c3f210b6');
  context.diagnostic(JSON.stringify({ experiment, productionCompatible: false, scope: 'unparsed-synthetic-index-file-guards-only',
    totalFileBytes: totalBytes, files: sizes.length, measurement: 'javascript-fs-api-calls-not-system-calls',
    baseline: { ...metrics(originalBudget), metadataApis: original.metadata }, candidate: { ...metrics(candidateBudget), metadataApis: changed.metadata },
    contentHashesMatch: true, speedClaim: false, missingIntegration: ['index-parser', 'pack-listing', 'absence-guards', 'source-final-proof'] }));
});

test('deep synthetic paths can exhaust v1 metadata while the unapproved unit candidate completes under the unchanged allocator limit', context => {
  const value = fixture(context, 14), originalBudget = freshBudget(), candidateBudget = freshBudget();
  let failure: ReturnType<typeof extractCompanyGitRangeFailure> = null;
  assert.throws(() => baseline(value, originalBudget), error => {
    assert.ok(error instanceof HarnessError); assert.equal(error.code, 'COMPANY_GIT_RANGE_LIMIT');
    failure = extractCompanyGitRangeFailure(error); assert.ok(failure); assert.equal(failure.limit.name, 'metadataCalls'); return true;
  });
  const result = candidate(value, candidateBudget);
  assert.deepEqual(result, [value.expected, value.expected]); assert.equal(candidateBudget.snapshot().completedPasses, 2);
  assert.equal(originalBudget.snapshot().metadataCalls, limits.metadataCalls);
  assert.ok(candidateBudget.snapshot().metadataCalls < limits.metadataCalls);
  assert.equal(candidateBudget.snapshot().readCalls, expectedReads * 2); assert.equal(candidateBudget.snapshot().readBytesReturned, totalBytes * 2);
  released(originalBudget); released(candidateBudget);
  context.diagnostic(JSON.stringify({ experiment, productionCompatible: false, addedDepth: 14, baselineFailure: failure,
    baseline: metrics(originalBudget), candidate: metrics(candidateBudget), baselineIsPartial: true, speedClaim: false,
    missingIntegration: ['index-parser', 'pack-listing', 'absence-guards', 'source-final-proof'] }));
});

const ancestorMutation = (value: Fixture, kind: 'replacement' | 'symlink') => {
  const displaced = join(value.parent, 'displaced-pack'); let active = false;
  return {
    apply: (): void => {
      fs.renameSync(value.packDirectory, displaced); active = true;
      if (kind === 'symlink') fs.symlinkSync(displaced, value.packDirectory);
      else {
        fs.mkdirSync(value.packDirectory, { mode: 0o700 });
        for (const path of value.paths) {
          const name = path.split('/').at(-1)!;
          fs.copyFileSync(join(displaced, name), join(value.packDirectory, name));
        }
      }
    },
    restore: (): void => {
      if (!active) return;
      if (kind === 'symlink') fs.unlinkSync(value.packDirectory); else fs.rmSync(value.packDirectory, { recursive: true });
      fs.renameSync(displaced, value.packDirectory); active = false;
    },
  };
};

test('persistent ancestor replacement or symlink rejects before a candidate pass result is returned', context => {
  for (const kind of ['replacement', 'symlink'] as const) {
    const value = fixture(context), budget = freshBudget(), mutation = ancestorMutation(value, kind);
    let returned = false;
    try {
      assert.throws(() => {
        candidate(value, budget, [value.paths[3]!], point => {
          if (point.pass === 'inspect' && point.chunk === 0) mutation.apply();
        });
        returned = true;
      }, error => error instanceof UnitGuardFailure && error.reason === 'changed');
      assert.equal(returned, false); assert.equal(budget.snapshot().completedPasses, 0); released(budget);
      // An alias to the same old parent passes all chunk leaf/FD checks, then fails at the unit boundary.
      assert.equal(budget.snapshot().readCalls, kind === 'symlink' ? Math.ceil(sizes[3]! / limits.readChunkBytes) : 1);
    } finally { mutation.restore(); }
  }
});

test('expected contract difference: a transient ancestor alias can evade the candidate while v1 rejects it', context => {
  for (const implementation of ['candidate', 'v1'] as const) {
    const value = fixture(context), budget = freshBudget(), mutation = ancestorMutation(value, 'symlink');
    const hook: AfterChunk = point => {
      if (point.pass !== 'inspect') return;
      if (point.chunk === 0) mutation.apply();
      if (point.chunk === 1) mutation.restore();
    };
    try {
      if (implementation === 'candidate') {
        const result = candidate(value, budget, [value.paths[3]!], hook);
        assert.deepEqual(result, [[value.expected[3]!], [value.expected[3]!]]); assert.equal(budget.snapshot().completedPasses, 2);
      } else {
        assert.throws(() => baseline(value, budget, [value.paths[3]!], hook), { code: 'COMPANY_GIT_RANGE_SOURCE_CHANGED' });
        assert.equal(budget.snapshot().completedPasses, 0); assert.equal(budget.snapshot().readCalls, 1);
      }
      released(budget);
    } finally { mutation.restore(); }
  }
  context.diagnostic(JSON.stringify({ experiment, productionCompatible: false, transientAncestorAlias: 'candidate-missed-v1-rejected',
    conclusion: 'fewer-ancestor-observation-points-are-not-v1-equivalent' }));
});

test('candidate final guards reject an earlier unit changed while a later unit is being read', context => {
  const value = fixture(context), budget = freshBudget();
  assert.throws(() => candidate(value, budget, value.paths, point => {
    if (point.pass === 'inspect' && point.unit === 3 && point.chunk === 0) fs.appendFileSync(join(value.root, value.paths[0]!), 'synthetic-change');
  }), error => error instanceof UnitGuardFailure && error.reason === 'changed');
  assert.equal(budget.snapshot().readCalls, expectedReads); assert.equal(budget.snapshot().completedPasses, 0);
  assert.ok(stageCounts.get(budget)!.final > 0); released(budget);
});

test('candidate short reads fail closed and retain actual partial byte accounting while releasing memory and descriptors', context => {
  const value = fixture(context), budget = freshBudget(), original = fs.readSync;
  context.mock.method(fs, 'readSync', ((descriptor: number, bytes: Buffer, offset: number, length: number, position: number) =>
    original(descriptor, bytes, offset, length - 1, position)) as typeof fs.readSync);
  assert.throws(() => candidate(value, budget, [value.paths[3]!]), error => error instanceof UnitGuardFailure && error.reason === 'short_read');
  assert.equal(budget.snapshot().readCalls, 1); assert.equal(budget.snapshot().readBytesReserved, limits.readChunkBytes);
  assert.equal(budget.snapshot().readBytesReturned, limits.readChunkBytes - 1); assert.equal(budget.snapshot().completedPasses, 0); released(budget);
});

test('candidate body reads use only live descriptors opened for its exact synthetic index paths', context => {
  const value = fixture(context), budget = freshBudget(), descriptors = new Set<number>();
  const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
  const allowed = new Set(value.paths.map(path => join(value.root, path))); let reads = 0, opens = 0;
  context.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: number, mode?: fs.Mode) => {
    assert.equal(typeof path, 'string'); assert.ok(allowed.has(path as string));
    const descriptor = open(path, flags, mode); descriptors.add(descriptor); opens++; return descriptor;
  }) as typeof fs.openSync);
  context.mock.method(fs, 'readSync', ((descriptor: number, bytes: Buffer, offset: number, length: number, position: number) => {
    assert.ok(descriptors.has(descriptor)); assert.ok(length <= limits.readChunkBytes); reads++;
    return read(descriptor, bytes, offset, length, position);
  }) as typeof fs.readSync);
  context.mock.method(fs, 'closeSync', (descriptor: number) => { close(descriptor); descriptors.delete(descriptor); });
  assert.deepEqual(candidate(value, budget), [value.expected, value.expected]);
  assert.equal(opens, 8); assert.equal(reads, expectedReads * 2); assert.equal(descriptors.size, 0); released(budget);
});

test('candidate rejects traversal before filesystem activity and never labels uncertain cleanup successful', context => {
  const value = fixture(context), unsafeBudget = freshBudget();
  assert.throws(() => candidate(value, unsafeBudget, ['../outside.idx']), error => error instanceof UnitGuardFailure && error.reason === 'unsafe_path');
  assert.equal(unsafeBudget.snapshot().metadataCalls, 0); assert.equal(unsafeBudget.snapshot().readCalls, 0); released(unsafeBudget);
  const budget = freshBudget(), original = fs.closeSync; let closes = 0;
  context.mock.method(fs, 'closeSync', (descriptor: number) => {
    original(descriptor); closes++;
    if (closes === 1) throw new Error('SYNTHETIC_UNCERTAIN_CLOSE');
  });
  assert.throws(() => candidate(value, budget), error => error instanceof UnitGuardFailure && error.reason === 'cleanup');
  assert.equal(closes, 4); assert.equal(budget.snapshot().completedPasses, 0);
  assert.equal(budget.snapshot().readCalls, expectedReads); assert.equal(budget.snapshot().readBytesReturned, totalBytes); released(budget, 1);
});
