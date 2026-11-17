import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { prepCompanyV2DiagnosticsDirectory, pruneCompanyV2Diagnostics, readCompanyV2Diagnostic,
  writeCompanyV2Diagnostic } from '../src/cli/company-readonly-v2-diagnostic-files.js';
import { companyV2RuntimeHash, prepareCompanyV2Directory, pruneCompanyV2Runs, writeCompanyV2Run,
  type CompanyV2Run } from '../src/cli/company-readonly-v2-files.js';
import { CompanyGitRangeBudget, extractCompanyGitRangeFailure, getCompanyGitRangeProfile,
  getCompanyGitRangeProfileHash } from '../src/policy/company-git-range-budget.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const unsafe = { code: 'COMPANY_READONLY_V2_UNSAFE_DIAGNOSTIC_FILE' };
const failedOutcome = { reason: 'worker_failed' as const, exitConfirmed: true };
const fixture = async (context: TestContext) => {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-v2-diagnostics-')));
  fs.chmodSync(parent, 0o700);
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const runtime = join(parent, 'runtime'), directory = join(parent, 'diagnostics'), taskId = randomUUID();
  const run: CompanyV2Run = { version: 'company-readonly-v2-run-v1', taskId, ownerId: `os-user:${process.getuid?.()}`,
    startedAt: '2026-01-01T00:00:00.000Z', auditExpiresAt: '2026-01-02T00:00:00.000Z',
    gitProfileHash: getCompanyGitRangeProfileHash(), registrationHash: '1'.repeat(64), policyHash: '2'.repeat(64),
    runtimeHash: companyV2RuntimeHash(runtime, `os-user:${process.getuid?.()}`) };
  await prepareCompanyV2Directory(runtime, true);
  await writeCompanyV2Run(runtime, run);
  await prepCompanyV2DiagnosticsDirectory(directory, runtime, true);
  const path = join(directory, `diagnostic-${taskId}.json`);
  return { parent, runtime, directory, run, path };
};
const failureFixture = () => {
  const budget = new CompanyGitRangeBudget(0), maximum = getCompanyGitRangeProfile().limits.packBytes;
  budget.beginPass('inspect', 0);
  budget.setStage('pack_index');
  try { budget.failLimit('packBytes', maximum, 1, maximum); }
  catch (error) {
    const failure = extractCompanyGitRangeFailure(error);
    assert.ok(failure);
    return failure;
  }
};
const resign = (value: Record<string, unknown>): string => {
  const content = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'diagnosticHash'));
  return `${JSON.stringify({ ...content, diagnosticHash: hashReadonlyValue(canonicalReadonlyJson(content)) })}\n`;
};

test('v2 diagnostics write a private bounded immutable record bound to run and both directories', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  const failure = failureFixture();
  assert.ok(failure);
  await writeCompanyV2Diagnostic(directory, runtime, run, failedOutcome, failure);
  const record = await readCompanyV2Diagnostic(directory, runtime, run.taskId);
  assert.deepEqual(Object.keys(record).sort(), ['version', 'taskId', 'ownerId', 'runtimeHash', 'diagnosticsDirectoryHash', 'createdAt',
    'auditExpiresAt', 'reason', 'exitConfirmed', 'failure', 'diagnosticHash'].sort());
  assert.equal(record.version, 'company-readonly-v2-diagnostic-record-v1');
  assert.equal(record.runtimeHash, run.runtimeHash);
  assert.equal(record.auditExpiresAt, run.auditExpiresAt);
  assert.equal(record.reason, 'worker_failed');
  assert.equal(record.exitConfirmed, true);
  assert.deepEqual(record.failure, failure);
  const { diagnosticHash, ...content } = record;
  assert.equal(diagnosticHash, hashReadonlyValue(canonicalReadonlyJson(content)));
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path).nlink, 1);
  assert.ok(fs.statSync(path).size <= 8192);
  assert.equal(fs.readFileSync(path, 'utf8').includes(directory), false);
  assert.equal(fs.readFileSync(path, 'utf8').includes(runtime), false);
  await prepareCompanyV2Directory(runtime, false);
});

test('v2 diagnostics permit null failure for a supervisor-only outcome', async context => {
  const { directory, runtime, run } = await fixture(context);
  await writeCompanyV2Diagnostic(directory, runtime, run, { reason: 'deadline', exitConfirmed: false }, null);
  const record = await readCompanyV2Diagnostic(directory, runtime, run.taskId);
  assert.equal(record.failure, null);
  assert.equal(record.reason, 'deadline');
  assert.equal(record.exitConfirmed, false);
});

test('v2 diagnostic writes refuse an existing record without changing its bytes', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV2Diagnostic(directory, runtime, run, failedOutcome, null);
  const before = fs.readFileSync(path);
  await assert.rejects(writeCompanyV2Diagnostic(directory, runtime, run, { reason: 'completed', exitConfirmed: true }, null), unsafe);
  assert.deepEqual(fs.readFileSync(path), before);
});

test('v2 diagnostic writes reject a run different from its immutable startup record', async context => {
  const { directory, runtime, run } = await fixture(context);
  await assert.rejects(writeCompanyV2Diagnostic(directory, runtime, { ...run, auditExpiresAt: '2027-01-01T00:00:00.000Z' }, failedOutcome, null), unsafe);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('v2 diagnostic preparation neither prunes expired records nor creates a missing directory for read-only use', async context => {
  const { parent, directory, runtime, run, path } = await fixture(context);
  await writeCompanyV2Diagnostic(directory, runtime, run, failedOutcome, null);
  await prepCompanyV2DiagnosticsDirectory(directory, runtime, true);
  assert.ok(fs.existsSync(path));
  const absent = join(parent, 'absent');
  await assert.rejects(prepCompanyV2DiagnosticsDirectory(absent, runtime, false), unsafe);
  assert.equal(fs.existsSync(absent), false);
});

test('v2 diagnostics prune exactly at the run audit expiry, including after run pruning', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV2Diagnostic(directory, runtime, run, failedOutcome, null);
  assert.equal(await pruneCompanyV2Diagnostics(directory, runtime, new Date(Date.parse(run.auditExpiresAt) - 1)), 0);
  assert.ok(fs.existsSync(path));
  assert.equal(await pruneCompanyV2Runs(runtime, new Date(run.auditExpiresAt)), 1);
  assert.equal((await readCompanyV2Diagnostic(directory, runtime, run.taskId)).taskId, run.taskId);
  assert.equal(await pruneCompanyV2Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), 1);
  assert.equal(fs.existsSync(path), false);
  assert.equal(await pruneCompanyV2Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), 0);
});

test('v2 diagnostics reject invalid pruning time without deleting records', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV2Diagnostic(directory, runtime, run, failedOutcome, null);
  await assert.rejects(pruneCompanyV2Diagnostics(directory, runtime, new Date(Number.NaN)), unsafe);
  assert.ok(fs.existsSync(path));
});

test('v2 diagnostics reject tampering before pruning any expired record', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV2Diagnostic(directory, runtime, run, failedOutcome, null);
  const otherRun = { ...run, taskId: randomUUID() };
  await writeCompanyV2Run(runtime, otherRun);
  await writeCompanyV2Diagnostic(directory, runtime, otherRun, failedOutcome, null);
  const otherPath = join(directory, `diagnostic-${otherRun.taskId}.json`);
  const value = JSON.parse(fs.readFileSync(otherPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(otherPath, JSON.stringify({ ...value, reason: 'deadline' }));
  await assert.rejects(pruneCompanyV2Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), unsafe);
  assert.ok(fs.existsSync(path));
  assert.ok(fs.existsSync(otherPath));
});

for (const change of [
  { name: 'additional raw error field', edit: (value: Record<string, unknown>) => { value.error = '/private/company/source.ts'; } },
  { name: 'different owner', edit: (value: Record<string, unknown>) => { value.ownerId = 'os-user:999999999'; } },
  { name: 'wrong task', edit: (value: Record<string, unknown>) => { value.taskId = randomUUID(); } },
  { name: 'unrecognized reason', edit: (value: Record<string, unknown>) => { value.reason = 'raw worker error'; } },
  { name: 'noncanonical expiry', edit: (value: Record<string, unknown>) => { value.auditExpiresAt = '2026-01-02'; } },
  { name: 'invalid numeric failure', edit: (value: Record<string, unknown>) => { value.failure = { ...failureFixture(), stack: 'raw stack' }; } },
]) {
  test(`v2 diagnostics reject ${change.name} even with a recomputed content hash`, async context => {
    const { directory, runtime, run, path } = await fixture(context);
    await writeCompanyV2Diagnostic(directory, runtime, run, failedOutcome, null);
    const value = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
    change.edit(value);
    fs.writeFileSync(path, resign(value));
    await assert.rejects(readCompanyV2Diagnostic(directory, runtime, run.taskId), unsafe);
  });
}

test('v2 diagnostics reject duplicate JSON keys and oversized files', async context => {
  const { directory, runtime, run, path } = await fixture(context);
  await writeCompanyV2Diagnostic(directory, runtime, run, failedOutcome, null);
  const text = fs.readFileSync(path, 'utf8');
  fs.writeFileSync(path, text.replace('"reason":', '"reason":"completed","reason":'));
  await assert.rejects(readCompanyV2Diagnostic(directory, runtime, run.taskId), unsafe);
  fs.writeFileSync(path, `${text}${' '.repeat(8192)}`);
  await assert.rejects(readCompanyV2Diagnostic(directory, runtime, run.taskId), unsafe);
});

test('v2 diagnostic copies into another directory are rejected before writing or pruning', async context => {
  const { parent, directory, runtime, run, path } = await fixture(context);
  await writeCompanyV2Diagnostic(directory, runtime, run, failedOutcome, null);
  const moved = join(parent, 'moved-diagnostics');
  fs.mkdirSync(moved, { mode: 0o700 });
  const movedPath = join(moved, `diagnostic-${run.taskId}.json`);
  fs.copyFileSync(path, movedPath);
  fs.chmodSync(movedPath, 0o600);
  const otherRun = { ...run, taskId: randomUUID() };
  await writeCompanyV2Run(runtime, otherRun);
  const before = fs.readFileSync(movedPath);
  await assert.rejects(prepCompanyV2DiagnosticsDirectory(moved, runtime, true), unsafe);
  await assert.rejects(writeCompanyV2Diagnostic(moved, runtime, otherRun, failedOutcome, null), unsafe);
  await assert.rejects(pruneCompanyV2Diagnostics(moved, runtime, new Date(run.auditExpiresAt)), unsafe);
  assert.deepEqual(fs.readdirSync(moved), [`diagnostic-${run.taskId}.json`]);
  assert.deepEqual(fs.readFileSync(movedPath), before);
});

test('v2 diagnostics reject a renamed directory and a different runtime location', async context => {
  const { parent, directory, runtime, run } = await fixture(context);
  await writeCompanyV2Diagnostic(directory, runtime, run, failedOutcome, null);
  await assert.rejects(prepCompanyV2DiagnosticsDirectory(directory, join(parent, 'other-runtime'), false), unsafe);
  const moved = join(parent, 'renamed-diagnostics');
  fs.renameSync(directory, moved);
  await assert.rejects(prepCompanyV2DiagnosticsDirectory(moved, runtime, true), unsafe);
  assert.equal(fs.readdirSync(moved).length, 1);
});

test('v2 diagnostics reject runtime overlap before creating anything', async context => {
  const { parent, runtime } = await fixture(context);
  const nested = join(runtime, 'diagnostics');
  await assert.rejects(prepCompanyV2DiagnosticsDirectory(nested, runtime, true), unsafe);
  await assert.rejects(prepCompanyV2DiagnosticsDirectory(runtime, runtime, true), unsafe);
  await assert.rejects(prepCompanyV2DiagnosticsDirectory(parent, runtime, true), unsafe);
  assert.equal(fs.existsSync(nested), false);
  assert.deepEqual(fs.readdirSync(runtime).sort(), ['runs', 'store']);
});

for (const kind of ['file-symlink', 'file-hardlink', 'public-file', 'public-directory', 'foreign-file', 'foreign-directory'] as const) {
  test(`v2 diagnostics reject ${kind} without changing the directory`, async context => {
    const { parent, directory, runtime, run, path } = await fixture(context);
    await writeCompanyV2Diagnostic(directory, runtime, run, failedOutcome, null);
    if (kind === 'file-symlink') {
      const outside = join(parent, 'outside.json');
      fs.renameSync(path, outside); fs.symlinkSync(outside, path);
    } else if (kind === 'file-hardlink') fs.linkSync(path, join(parent, 'linked.json'));
    else if (kind === 'public-file') fs.chmodSync(path, 0o644);
    else if (kind === 'public-directory') fs.chmodSync(directory, 0o755);
    else if (kind === 'foreign-file') fs.writeFileSync(join(directory, 'foreign.json'), '{}', { mode: 0o600 });
    else fs.mkdirSync(join(directory, 'foreign-directory'), { mode: 0o700 });
    const names = fs.readdirSync(directory);
    await assert.rejects(prepCompanyV2DiagnosticsDirectory(directory, runtime, true), unsafe);
    await assert.rejects(pruneCompanyV2Diagnostics(directory, runtime, new Date(run.auditExpiresAt)), unsafe);
    assert.deepEqual(fs.readdirSync(directory), names);
  });
}

test('v2 diagnostics reject symlink ancestors and public parents before directory creation', async context => {
  const { parent, runtime } = await fixture(context);
  const privateParent = join(parent, 'private-parent'), linked = join(parent, 'linked-parent');
  fs.mkdirSync(privateParent, { mode: 0o700 }); fs.symlinkSync(privateParent, linked);
  await assert.rejects(prepCompanyV2DiagnosticsDirectory(join(linked, 'diagnostics'), runtime, true), unsafe);
  assert.deepEqual(fs.readdirSync(privateParent), []);
  fs.chmodSync(privateParent, 0o755);
  await assert.rejects(prepCompanyV2DiagnosticsDirectory(join(privateParent, 'diagnostics'), runtime, true), unsafe);
  assert.deepEqual(fs.readdirSync(privateParent), []);
});

test('v2 diagnostics stop at the file count cap without deleting oversized collections', async context => {
  const { directory, runtime } = await fixture(context);
  for (let index = 0; index < 8193; index += 1) {
    fs.writeFileSync(join(directory, `diagnostic-${randomUUID()}.json`), '{}', { mode: 0o600 });
  }
  await assert.rejects(prepCompanyV2DiagnosticsDirectory(directory, runtime, false), unsafe);
  await assert.rejects(pruneCompanyV2Diagnostics(directory, runtime, new Date()), unsafe);
  assert.equal(fs.readdirSync(directory).length, 8193);
});
