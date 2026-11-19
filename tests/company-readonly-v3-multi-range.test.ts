import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import git from 'isomorphic-git';
import { createCompanyGitRangeUnitCollectionSource } from '../src/adapters/company-git-range-unit-source.js';
import { SqliteCompanyReadonlyV3Store } from '../src/adapters/sqlite-company-readonly-v3-store.js';
import { CompanyReadonlyPreparationServiceV3 } from '../src/application/prepare-company-readonly-v3.js';
import type { CompanyReadonlyRegistrationV3, CompanyReadonlySourceV3 } from '../src/domain/company-readonly-v3.js';
import { getCompanyGitRangeUnitProfile } from '../src/policy/company-git-range-unit-budget.js';
import { extractCompanyGitRangeSourceFailureReason } from '../src/policy/company-git-range-source-failure.js';
import { parseCompanyReadonlyRegistrationV3 } from '../src/policy/company-readonly-v3.js';
import { getPersonalCollectionProfile } from '../src/policy/personal-readonly-collection.js';
import { createCompanyReadonlyV3Fixture } from './company-readonly-v3-fixture.js';

const author = { name: 'Synthetic Range Fixture', email: 'range-fixture@example.invalid', timestamp: 1704067200, timezoneOffset: 0 };
const layouts = [
  { path: 'src/units/alpha/sequence.ts', lines: 1079, bytesPerLine: 32, marker: 'a' },
  { path: 'src/units/beta/summary.ts', lines: 181, bytesPerLine: 30, marker: 'b' },
  { path: 'src/units/delta/notes.ts', lines: 27, bytesPerLine: 38, marker: 'd' },
  { path: 'src/units/gamma/catalog.ts', lines: 156, bytesPerLine: 40, marker: 'g' },
] as const;
const linesFor = (layout: typeof layouts[number]): string[] => Array.from({ length: layout.lines }, (_, index) =>
  `// fixture ${layout.marker} row ${String(index + 1).padStart(4, '0')}`.padEnd(layout.bytesPerLine - 1, '.'));
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Extend only a fresh synthetic fixture; no existing repository path or source contents are accepted. */
const createMultiRangeFixture = async (context: TestContext) => {
  const fixture = await createCompanyReadonlyV3Fixture(context);
  const selectedFiles = Object.fromEntries(layouts.map(layout => [layout.path, `${linesFor(layout).join('\n')}\n`]));
  for (const [path, contents] of Object.entries(selectedFiles)) {
    fs.mkdirSync(dirname(join(fixture.root, path)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(fixture.root, path), contents, { mode: 0o600 });
    await git.add({ fs, dir: fixture.root, filepath: path });
  }
  const baseCommit = await git.commit({ fs, dir: fixture.root, author, committer: author, message: 'Synthetic multi-range evidence' });
  const selectedPaths = layouts.map(layout => layout.path);
  const readRanges = layouts.flatMap(layout => Array.from({ length: Math.ceil(layout.lines / 200) }, (_, index) =>
    ({ path: layout.path, startLine: index * 200 + 1, endLine: Math.min((index + 1) * 200, layout.lines) })));
  const registration = parseCompanyReadonlyRegistrationV3({ ...fixture.registration, baseCommit, readRanges,
    reviewPaths: selectedPaths, question: 'Inspect only the selected independent synthetic line ranges.' });
  const collection = getPersonalCollectionProfile().limits;
  assert.equal(selectedPaths.length, 4); assert.equal(registration.readRanges.length, 9);
  assert.equal(Buffer.byteLength(selectedFiles[layouts[0].path]!), 34_528);
  assert.equal(Object.values(selectedFiles).reduce((total, contents) => total + Buffer.byteLength(contents), 0), 47_224);
  assert.ok(Object.values(selectedFiles).every(contents => Buffer.byteLength(contents) <= collection.sourceFileBytes));
  assert.ok(registration.readRanges.every(range => range.endLine - range.startLine + 1 <= collection.linesPerRange));
  return { ...fixture, baseCommit, selectedFiles, selectedPaths, registration };
};

const openCollection = (registration: CompanyReadonlyRegistrationV3) => createCompanyGitRangeUnitCollectionSource({
  version: 'company-git-range-source-v2', profileHash: registration.gitProfileHash, guardPolicyHash: registration.guardPolicyHash,
  sourceRoot: registration.sourceRoot, baseCommit: registration.baseCommit,
  selectedPaths: [...new Set(registration.readRanges.map(range => range.path))].sort(),
}, { repoId: registration.repoId, readRanges: registration.readRanges }, () => 0);

test('four synthetic files with nine ranges retain every requested line across two bounded passes', async context => {
  const fixture = await createMultiRangeFixture(context), before = fixture.snapshot(), source = openCollection(fixture.registration);
  try {
    const inspected = source.inspect(), verified = source.verify();
    assert.equal(inspected.collected.evidence.length, 9); assert.equal(inspected.collected.sourceViews.length, 4);
    assert.deepEqual(inspected.observation, verified.observation);
    assert.equal(verified.budget.phase, 'complete'); assert.equal(verified.budget.completedPasses, 2);
    for (const key of ['liveMemoryBytes', 'cacheMemoryBytes', 'openDescriptors', 'pendingReads', 'pendingInflations', 'dependencyDepth'] as const) {
      assert.equal(verified.budget[key], 0, key);
    }
    assert.ok(verified.budget.metadataCalls <= getCompanyGitRangeUnitProfile().limits.metadataCalls);
    for (const [index, item] of inspected.collected.evidence.entries()) {
      const range = fixture.registration.readRanges[index]!;
      const original = fixture.selectedFiles[range.path]!;
      const expected = original.slice(0, -1).split('\n').slice(range.startLine - 1, range.endLine).join('\n');
      assert.equal(item.path, range.path); assert.equal(item.startLine, range.startLine); assert.equal(item.endLine, range.endLine);
      assert.equal(item.excerpt, expected); assert.equal(item.excerptHash, hash(expected)); assert.equal(item.fileHash, hash(original));
      assert.ok(Buffer.byteLength(item.excerpt) <= getPersonalCollectionProfile().limits.excerptBytes);
    }
    const sequence = inspected.collected.evidence.filter(item => item.path === layouts[0].path);
    assert.equal(sequence.length, 6);
    assert.equal(sequence.map(item => item.excerpt).join('\n'), fixture.selectedFiles[layouts[0].path]!.trimEnd());
    assert.equal(sequence.at(-1)!.endLine, 1079);
    assert.equal(fixture.snapshot(), before);
  } finally { source.close(); }
});

test('four-file multi-range preparation persists all nine excerpts without granting execution or changing its source', async context => {
  const fixture = await createMultiRangeFixture(context), before = fixture.snapshot();
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v3-multi-range-store-'))); fs.chmodSync(directory, 0o700);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteCompanyReadonlyV3Store(join(directory, 'company-readonly-v3.sqlite'));
  let opened = 0, closed = 0;
  const source: CompanyReadonlySourceV3 = { open: registration => {
    opened++; const session = fixture.source.open(registration);
    return { inspect: session.inspect, verify: session.verify, close: () => { closed++; session.close(); } };
  } };
  const service = new CompanyReadonlyPreparationServiceV3(store, source);
  try {
    const prepared = service.prepare(fixture.registration, fixture.policy, fixture.context, fixture.id);
    assert.equal(prepared.status, 'AWAITING_APPROVAL'); assert.ok(prepared.payload);
    assert.equal(prepared.plan.id, fixture.id); assert.equal(prepared.payload.collected.evidence.length, 9);
    assert.equal(prepared.payload.collected.sourceViews.length, 4); assert.equal(prepared.payload.budget.completedPasses, 2);
    assert.equal(prepared.payload.budget.phase, 'complete'); assert.equal(prepared.payload.budget.openDescriptors, 0);
    assert.equal(prepared.payload.budget.liveMemoryBytes, 0);
    assert.deepEqual([prepared.approvalCreated, prepared.transmissionAllowed, prepared.executionAllowed, prepared.companyPolicyVerified],
      [false, false, false, false]);
    assert.ok(Buffer.byteLength(prepared.payload.reviewInput) <= getPersonalCollectionProfile().limits.inputBytes);
    const input = JSON.parse(prepared.payload.reviewInput) as { evidence: unknown[] };
    assert.deepEqual(input.evidence, prepared.payload.collected.evidence);
    assert.deepEqual(service.inspect(fixture.id, fixture.context), prepared);
    assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(fixture.snapshot(), before);
  } finally { store.close(); }
});

test('one line beyond a multi-range file is rejected without persisting partial preparation', async context => {
  const fixture = await createMultiRangeFixture(context);
  const registration = parseCompanyReadonlyRegistrationV3({ ...fixture.registration,
    readRanges: fixture.registration.readRanges.map(range => range.path === layouts[0].path && range.endLine === 1079
      ? { ...range, endLine: 1080 } : range) });
  const before = fixture.snapshot();
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v3-multi-range-rejected-'))); fs.chmodSync(directory, 0o700);
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteCompanyReadonlyV3Store(join(directory, 'company-readonly-v3.sqlite'));
  const service = new CompanyReadonlyPreparationServiceV3(store, fixture.source);
  try {
    assert.throws(() => service.prepare(registration, fixture.policy, fixture.context, fixture.id), error => {
      assert.equal((error as { code?: unknown }).code, 'COMPANY_GIT_RANGE_INVALID_SOURCE');
      assert.equal(extractCompanyGitRangeSourceFailureReason(error), 'excerpt');
      return true;
    });
    assert.throws(() => service.inspect(fixture.id, fixture.context), { code: 'COMPANY_READONLY_V3_NOT_FOUND' });
    assert.equal(fixture.snapshot(), before);
  } finally { store.close(); }
});
