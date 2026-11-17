import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createCompanyGitRangeSource } from '../src/adapters/company-git-range-source.js';
import type { CompanyGitRangeFailure } from '../src/domain/company-git-range-diagnostic.js';
import { HarnessError } from '../src/domain/errors.js';
import { CompanyGitRangeBudget, extractCompanyGitRangeFailure, getCompanyGitRangeProfile,
  getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { companyGitRangeCrc32, decodeCompanyGitPackedObject } from '../src/policy/company-git-range-object-codec.js';
import { createCompanyGitRangeFixture } from './company-readonly-git-range-fixture.js';

type Fixture = Awaited<ReturnType<typeof createCompanyGitRangeFixture>>;
const limits = getCompanyGitRangeProfile().limits;
const input = (fixture: Fixture, sourceRoot = fixture.root) => ({ version: 'company-git-range-source-v1',
  profileHash: getCompanyGitRangeProfileHash(), sourceRoot, baseCommit: fixture.baseCommit, selectedPaths: fixture.selectedPaths });
const limitFailure = (operation: () => unknown): CompanyGitRangeFailure => {
  let captured: unknown;
  assert.throws(operation, error => {
    captured = error;
    assert.ok(error instanceof HarnessError);
    assert.equal(error.code, 'COMPANY_GIT_RANGE_LIMIT'); assert.equal(error.message, error.code);
    return true;
  });
  const failure = extractCompanyGitRangeFailure(captured);
  assert.ok(failure); assert.equal(failure.errorCode, 'COMPANY_GIT_RANGE_LIMIT');
  assert.equal(failure.profileHash, getCompanyGitRangeProfileHash());
  assert.ok(Object.isFrozen(failure)); assert.ok(Object.isFrozen(failure.counters));
  return failure;
};
const assertPrivateFieldsAbsent = (failure: CompanyGitRangeFailure, fixture: Fixture): void => {
  const serialized = JSON.stringify(failure);
  for (const value of [fixture.root, fixture.baseCommit, fixture.mainOid, 'src/main.ts', 'README.md',
    'Synthetic historical source', ...Object.values(fixture.selectedFiles)]) assert.equal(serialized.includes(value), false);
  assert.equal(serialized.includes('"stack"'), false); assert.equal(serialized.includes('"type":"Buffer"'), false);
};
const assertReleased = (budget: ReturnType<ReturnType<typeof createCompanyGitRangeSource>['snapshot']>): void => {
  for (const key of ['openDescriptors', 'liveMemoryBytes', 'cacheMemoryBytes', 'pendingReads', 'pendingInflations', 'dependencyDepth'] as const) {
    assert.equal(budget[key], 0, key);
  }
};

test('real guarded reads exhaust metadata calls with an admissible synthetic working index', async context => {
  const fixture = await createCompanyGitRangeFixture(context);
  // Depth makes this exercise the same cumulative guard limit on both shallow and deeply nested temp roots.
  const sourceRoot = join(fixture.root, ...Array.from({ length: 14 }, (_, index) => `level-${index}`));
  const originalNames = fs.readdirSync(fixture.root);
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  for (const name of originalNames) fs.renameSync(join(fixture.root, name), join(sourceRoot, name));
  const indexPath = join(sourceRoot, '.git/index'), original = fs.readFileSync(indexPath);
  // Uppercase optional extensions are inert hints accepted by the existing working-index parser.
  const extension = Buffer.alloc(8 + 7 * 1024 * 1024); extension.write('TEST'); extension.writeUInt32BE(extension.length - 8, 4);
  const body = Buffer.concat([original.subarray(0, -20), extension]);
  fs.writeFileSync(indexPath, Buffer.concat([body, createHash('sha1').update(body).digest()]));
  assert.ok(fs.statSync(indexPath).size < limits.gitFileBytes);
  const before = fixture.snapshot(), source = createCompanyGitRangeSource(input(fixture, sourceRoot), () => 0);
  try {
    const failure = limitFailure(() => source.inspect());
    assert.equal(failure.phase, 'inspect'); assert.equal(failure.stage, 'working_index');
    assert.deepEqual(failure.limit, { name: 'metadataCalls', current: limits.metadataCalls, requested: 1, maximum: limits.metadataCalls });
    assert.equal(failure.counters.metadataCalls, limits.metadataCalls);
    assert.ok(failure.counters.readCalls > 20); assert.ok(failure.counters.readBytesReturned > limits.readChunkBytes);
    assert.ok(failure.counters.liveMemoryBytes > 0); assert.ok(failure.counters.openDescriptors > 0);
    assert.equal(source.snapshot().phase, 'failed'); assertReleased(source.snapshot());
    assertPrivateFieldsAbsent(failure, fixture); assert.equal(fixture.snapshot(), before);
  } finally { source.close(); }
});

test('pack and index size rejection identify the existing bound before reading an oversized file', async context => {
  for (const kind of ['pack', 'index'] as const) {
    const fixture = await createCompanyGitRangeFixture(context), path = kind === 'pack' ? fixture.packPath! : fixture.indexPath!;
    const name = kind === 'pack' ? 'packBytes' : 'indexBytes', maximum = limits[name];
    // Sparse synthetic files avoid allocating or hashing a 512 MiB buffer merely to test a metadata gate.
    fs.truncateSync(path, maximum + 1);
    const before = fs.statSync(path, { bigint: true }), source = createCompanyGitRangeSource(input(fixture), () => 0);
    try {
      const failure = limitFailure(() => source.inspect());
      assert.deepEqual(failure.limit, { name, current: 0, requested: maximum + 1, maximum });
      assert.equal(failure.phase, 'inspect'); assert.equal(failure.stage, kind === 'pack' ? 'pack_inventory' : 'pack_index');
      assert.equal(failure.counters.readCalls, 1); assert.equal(failure.counters.readBytesReturned, 41);
      assertReleased(source.snapshot()); assertPrivateFieldsAbsent(failure, fixture);
      const after = fs.statSync(path, { bigint: true });
      for (const field of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[field], before[field]);
    } finally { source.close(); }
  }
});

test('candidate and directory bounds retain the first diagnostic through uncertain directory cleanup', async context => {
  for (const kind of ['pairs', 'entries', 'entries-close-error'] as const) {
    const fixture = await createCompanyGitRangeFixture(context), directory = dirname(fixture.packPath!);
    if (kind === 'pairs') {
      for (let index = 0; index < limits.candidatePairs; index++) {
        const name = `pack-${index.toString(16).padStart(40, '0')}`;
        fs.copyFileSync(fixture.packPath!, join(directory, `${name}.pack`));
        fs.copyFileSync(fixture.indexPath!, join(directory, `${name}.idx`));
      }
    } else {
      for (let index = 0; index < limits.packDirectoryEntries - 1; index++) {
        fs.writeFileSync(join(directory, `synthetic-${index}`), '', { mode: 0o600 });
      }
    }
    const before = fixture.snapshot(), source = createCompanyGitRangeSource(input(fixture), () => 0);
    const originalOpen = fs.opendirSync;
    let closed = 0;
    if (kind === 'entries-close-error') {
      fs.opendirSync = (...args: Parameters<typeof fs.opendirSync>) => {
        const handle = originalOpen(...args), originalClose = handle.closeSync.bind(handle);
        handle.closeSync = () => { originalClose(); closed++; throw new Error('SYNTHETIC_CLOSE_FAILURE'); };
        return handle;
      };
    }
    try {
      const failure = limitFailure(() => source.inspect());
      assert.equal(failure.stage, 'pack_inventory'); assert.equal(failure.phase, 'inspect');
      assert.deepEqual(failure.limit, kind === 'pairs'
        ? { name: 'candidatePairs', current: 0, requested: limits.candidatePairs + 1, maximum: limits.candidatePairs }
        : { name: 'packDirectoryEntries', current: limits.packDirectoryEntries, requested: 1, maximum: limits.packDirectoryEntries });
      assert.equal(failure.counters.openDescriptors, kind === 'pairs' ? 0 : 1);
      assertPrivateFieldsAbsent(failure, fixture);
      if (kind === 'entries-close-error') {
        assert.equal(closed, 1); assert.equal(source.snapshot().openDescriptors, 1);
        assert.equal(source.snapshot().failureCode, 'COMPANY_GIT_RANGE_LIMIT');
      } else assertReleased(source.snapshot());
    } finally { fs.opendirSync = originalOpen; source.close(); }
    assert.equal(fixture.snapshot(), before);
  }
});

test('object decoding reports cumulative inflation exhaustion without changing invalid-object classification', async context => {
  const fixture = await createCompanyGitRangeFixture(context);
  const object = fixture.objects.find(item => item.oid === fixture.deltaBaseOid)!, bytes = object.encoded!;
  const entry = { oid: object.oid, offset: object.offset!, length: bytes.length, crc32: companyGitRangeCrc32(bytes) };
  const budget = new CompanyGitRangeBudget(0); budget.beginPass('inspect', 0);
  for (let index = 0; index < limits.inflations; index++) {
    const decoded = decodeCompanyGitPackedObject(bytes, entry, 'a'.repeat(64), budget, 0);
    budget.releaseMemory(decoded.memoryLease);
  }
  const failure = limitFailure(() => decodeCompanyGitPackedObject(bytes, entry, 'a'.repeat(64), budget, 0));
  assert.equal(failure.stage, 'git_object'); assert.equal(failure.phase, 'inspect');
  assert.deepEqual(failure.limit, { name: 'inflations', current: limits.inflations, requested: 1, maximum: limits.inflations });
  assert.equal(failure.counters.inflations, limits.inflations); assert.ok(failure.counters.liveMemoryBytes > 0);
  assertReleased(budget.snapshot()); assertPrivateFieldsAbsent(failure, fixture);

  const invalidBudget = new CompanyGitRangeBudget(0); invalidBudget.beginPass('inspect', 0);
  assert.throws(() => decodeCompanyGitPackedObject(bytes, { ...entry, length: limits.encodedObjectBytes + 1 },
    'a'.repeat(64), invalidBudget, 0), error => {
    assert.ok(error instanceof HarnessError); assert.equal(error.code, 'COMPANY_GIT_RANGE_INVALID_OBJECT');
    assert.equal(extractCompanyGitRangeFailure(error), null); return true;
  });
  assertReleased(invalidBudget.snapshot());
});
