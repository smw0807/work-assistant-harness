import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createCompanyGitRangeUnitCollectionSource } from '../src/adapters/company-git-range-unit-source.js';
import { SqliteCompanyReadonlyV3Store } from '../src/adapters/sqlite-company-readonly-v3-store.js';
import { readCompanyV3Diagnostic } from '../src/cli/company-readonly-v3-diagnostic-files.js';
import { extractCompanyGitRangeUnitFailure, getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfile, getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';
import { createCompanyUnitMultifileFixture } from './company-readonly-git-range-unit-multifile-fixture.js';

const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
  const child = spawn(process.execPath, [resolve('dist/src/cli/main.js'), ...args], { env: { LANG: 'C.UTF-8', TZ: 'UTC' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
});

test('four independent packs and eight selected paths finish two fresh passes and the v3 CLI within unchanged budgets', { timeout: 60_000 }, async context => {
  const fixture = await createCompanyUnitMultifileFixture(context), before = fixture.snapshot();
  const readRanges = fixture.selectedPaths.map(path => ({ path, startLine: 1, endLine: 1 }));
  const request = { version: 'company-git-range-source-v2', profileHash: getCompanyGitRangeUnitProfileHash(),
    guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(), sourceRoot: fixture.root,
    baseCommit: fixture.baseCommit, selectedPaths: fixture.selectedPaths };
  const source = createCompanyGitRangeUnitCollectionSource(request, { repoId: 'synthetic-multifile', readRanges });
  let final;
  try {
    const inspected = source.inspect(), first = source.snapshot(), verified = source.verify();
    final = source.snapshot();
    assert.deepEqual(verified.observation, inspected.observation);
    assert.equal(inspected.collected.evidence.length, 8); assert.equal(inspected.collected.sourceViews.length, 8);
    assert.deepEqual(inspected.observation.selectedFiles.map(file => file.path), fixture.selectedPaths);
    for (const evidence of inspected.collected.evidence) assert.equal(evidence.excerpt.trim(), fixture.selectedFiles[evidence.path]!.trim());
    assert.equal(inspected.observation.packs.length, fixture.packCount);
    assert.equal(final.phase, 'complete'); assert.equal(final.completedPasses, 2);
    assert.equal(final.visitedObjects, fixture.selectedObjectCount); assert.equal(final.peakDependencyDepth, fixture.deltaDepth);
    assert.equal(final.passes.inspect.indexes, 4); assert.equal(final.passes.verify.indexes, 4);
    assert.equal(final.passes.inspect.indexObjects, 92_000); assert.equal(final.passes.verify.indexObjects, 92_000);
    assert.equal(final.passes.inspect.indexBytes, fixture.indexBytes); assert.equal(final.passes.verify.indexBytes, fixture.indexBytes);
    assert.equal(final.readBytesReturned, final.readBytesReserved); assert.ok(final.readBytesReturned > first.readBytesReturned);
    assert.ok(final.inflations > first.inflations); assert.ok(final.metadataCalls <= getCompanyGitRangeUnitProfile().limits.metadataCalls);
    for (const key of ['liveMemoryBytes', 'cacheMemoryBytes', 'peakCacheMemoryBytes', 'openDescriptors', 'pendingReads',
      'pendingInflations', 'dependencyDepth'] as const) assert.equal(final[key], 0, key);
    assert.equal(inspected.observation.packChecksum, 'not_checked'); assert.equal(inspected.observation.unvisitedObjects, 'not_checked');
  } finally { source.close(); }
  assert.equal(fixture.snapshot(), before);

  const policyFile = join(fixture.parent, 'company-readonly-policy.json');
  const registrationFile = join(fixture.parent, 'company-readonly-registration-v3.json');
  const runtime = join(fixture.parent, 'runtime'), diagnostics = join(fixture.parent, 'diagnostics');
  const question = 'Explain only these selected synthetic constants.';
  fs.writeFileSync(policyFile, JSON.stringify({ version: 'company-readonly-policy-v1', enabled: false,
    readPermission: 'confirmed', storagePermission: 'confirmed', policyReference: 'synthetic-multifile-policy',
    payloadRetentionHours: 1, auditRetentionDays: 1 }), { mode: 0o600 });
  fs.writeFileSync(registrationFile, JSON.stringify({ version: 'company-readonly-registration-v3',
    gitProfileHash: request.profileHash, guardPolicyHash: request.guardPolicyHash, repoId: 'synthetic-multifile',
    sourceRoot: fixture.root, baseCommit: fixture.baseCommit, question, readRanges, reviewPaths: fixture.selectedPaths }), { mode: 0o600 });
  const prepared = await run(['company-readonly-v3-plan', '--policy', policyFile, '--registration', registrationFile,
    '--data-dir', runtime, '--diagnostics-dir', diagnostics]);
  assert.equal(prepared.code, 0, prepared.stderr);
  const summary = JSON.parse(prepared.stdout) as Record<string, unknown>, id = summary.taskId as string;
  assert.equal(summary.status, 'AWAITING_APPROVAL'); assert.equal(summary.runStatus, 'succeeded'); assert.equal(summary.exitConfirmed, true);
  assert.equal(summary.gitProfileHash, request.profileHash); assert.equal(summary.guardPolicyHash, request.guardPolicyHash);
  assert.equal(summary.nativeExecution, 'not_run'); assert.equal(summary.realModel, 'not_run');
  for (const text of [fixture.root, question, ...fixture.selectedPaths, ...Object.values(fixture.selectedFiles).map(body => body.trim())]) {
    assert.equal((prepared.stdout + prepared.stderr).includes(text), false);
  }
  const store = new SqliteCompanyReadonlyV3Store(join(runtime, 'store/company-readonly-v3.sqlite'));
  try {
    const stored = store.inspect(id, { ownerId: `os-user:${process.getuid!()}`, now: new Date() });
    assert.equal(stored.status, 'AWAITING_APPROVAL'); assert.equal(stored.plan.planHash, summary.planHash); assert.ok(stored.payload);
    assert.equal(stored.payload.budget.metadataCalls, final.metadataCalls);
    assert.equal(stored.payload.budget.readBytesReturned, final.readBytesReturned);
    assert.equal(stored.payload.budget.completedPasses, 2); assert.equal(stored.payload.collected.evidence.length, 8);
  } finally { store.close(); }
  const diagnostic = await readCompanyV3Diagnostic(diagnostics, runtime, id);
  assert.equal(diagnostic.reason, 'completed'); assert.equal(diagnostic.failure, null); assert.equal(diagnostic.exitConfirmed, true);
  const inspected = await run(['company-readonly-v3-inspect', '--task', id, '--data-dir', runtime]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const inspectedSummary = JSON.parse(inspected.stdout) as Record<string, unknown>;
  assert.equal(inspectedSummary.taskId, id); assert.equal(inspectedSummary.planHash, summary.planHash);
  assert.equal(inspectedSummary.status, 'AWAITING_APPROVAL'); assert.equal(inspectedSummary.preparationRunStatus, 'succeeded');
  assert.equal(fixture.snapshot(), before);
  context.diagnostic(JSON.stringify({ case: 'four-pack-eight-path-v3', rootDepth: fixture.rootDepth, packCount: fixture.packCount,
    indexObjects: fixture.objectCount, indexBytes: fixture.indexBytes, selectedFiles: fixture.selectedPaths.length,
    independentReadbackSamples: fixture.independentReadbackSamples, metadataCalls: final.metadataCalls,
    readCalls: final.readCalls, readBytes: final.readBytesReturned, inflations: final.inflations,
    visitedObjects: final.visitedObjects, peakDependencyDepth: final.peakDependencyDepth, completedPasses: final.completedPasses,
    peakManagedBytes: final.peakMemoryBytes, peakDescriptors: final.peakOpenDescriptors,
    peakRssBytes: summary.peakRssBytes, oldSpaceMiB: summary.oldSpaceMiB, status: summary.status, sourceUnchanged: true }));
});


test('a separate deeper multifile fixture still fails closed at the unchanged metadata ceiling', { timeout: 60_000 }, async context => {
  const fixture = await createCompanyUnitMultifileFixture(context, { depth: 3 }), before = fixture.snapshot();
  const source = createCompanyGitRangeUnitCollectionSource({ version: 'company-git-range-source-v2',
    profileHash: getCompanyGitRangeUnitProfileHash(), guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(),
    sourceRoot: fixture.root, baseCommit: fixture.baseCommit, selectedPaths: fixture.selectedPaths },
  { repoId: 'synthetic-deep-multifile', readRanges: fixture.selectedPaths.map(path => ({ path, startLine: 1, endLine: 1 })) });
  try {
    assert.throws(() => { source.inspect(); source.verify(); }, error => {
      const failure = extractCompanyGitRangeUnitFailure(error);
      assert.ok(failure); assert.equal(failure.errorCode, 'COMPANY_GIT_RANGE_LIMIT');
      assert.equal(failure.limit.name, 'metadataCalls'); assert.equal(failure.limit.maximum, 8192);
      assert.equal(failure.limit.current, 8192); assert.equal(failure.limit.requested, 1);
      return true;
    });
    const final = source.snapshot(); assert.equal(final.phase, 'failed'); assert.equal(final.metadataCalls, 8192);
    for (const key of ['liveMemoryBytes', 'openDescriptors', 'cacheMemoryBytes', 'pendingReads', 'pendingInflations', 'dependencyDepth'] as const) {
      assert.equal(final[key], 0, key);
    }
    context.diagnostic(JSON.stringify({ case: 'deeper-multifile-limit', rootDepth: fixture.rootDepth,
      metadataCalls: final.metadataCalls, completedPasses: final.completedPasses, status: 'rejected-without-retry' }));
  } finally { source.close(); }
  assert.equal(fixture.snapshot(), before);
});
