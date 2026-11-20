import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { CompanyChangeDraft } from '../src/domain/company-change.js';
import { SyntheticCompanyChangeService } from '../src/application/apply-synthetic-company-change.js';
import { recoverSyntheticCompanyChange } from '../src/application/recover-synthetic-company-change.js';
import { SqliteSyntheticCompanyChangeStore } from '../src/adapters/sqlite-synthetic-company-change-store.js';
import { acquireSyntheticCompanyChangeControl } from '../src/adapters/synthetic-company-change-control.js';
import { createSyntheticCompanyChangeWorkspace, openSyntheticCompanyChangeWorkspace,
  SYNTHETIC_COMPANY_CHANGE_FILES } from '../src/adapters/synthetic-company-change-workspace.js';
import { hashCompanyChangeValue } from '../src/policy/company-change.js';

const context = () => ({ ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
const moduleUrl = (name: string): string => JSON.stringify(pathToFileURL(resolve(`dist/src/${name}.js`)).href);
const environment = { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' };

const childSource = () => `
import fs from 'node:fs';
import { join } from 'node:path';
import { SyntheticCompanyChangeService } from ${moduleUrl('application/apply-synthetic-company-change')};
import { SqliteSyntheticCompanyChangeStore } from ${moduleUrl('adapters/sqlite-synthetic-company-change-store')};
import { openSyntheticCompanyChangeWorkspace } from ${moduleUrl('adapters/synthetic-company-change-workspace')};
import { acquireSyntheticCompanyChangeControl } from ${moduleUrl('adapters/synthetic-company-change-control')};
const [runtime, point, inputFile] = process.argv.slice(2);
const release = acquireSyntheticCompanyChangeControl(runtime);
const workspace = await openSyntheticCompanyChangeWorkspace(join(runtime, 'synthetic-workspace.json'));
const store = new SqliteSyntheticCompanyChangeStore(join(runtime, 'store', 'synthetic-company-change.sqlite'));
const { request, draft } = JSON.parse(fs.readFileSync(inputFile ?? join(runtime, 'driver.json'), 'utf8'));
const stop = () => process.kill(process.pid, 'SIGKILL');
const originalRecord = store.record.bind(store);
store.record = (...args) => {
  const result = originalRecord(...args);
  if (point === 'claimed' && args[1].kind === 'branch' && args[1].state === 'INTENT') stop();
  return result;
};
const originalBranch = workspace.createBranch.bind(workspace);
workspace.createBranch = async (...args) => {
  await originalBranch(...args); if (point === 'branch') stop();
};
const originalWrite = workspace.writeFile.bind(workspace);
workspace.writeFile = async (...args) => {
  await originalWrite(...args);
  if (point === 'first-file' && args[2] === 0 || point === 'last-file' && args[2] === draft.changes.length - 1) stop();
};
const originalFinish = store.finish.bind(store);
store.finish = (...args) => {
  const result = originalFinish(...args); if (point === 'after-finish') stop(); return result;
};
try { await new SyntheticCompanyChangeService(store, workspace).apply(request, draft); }
finally { store.close(); release(); }
throw new Error('Expected synthetic kill point was not reached');
`;

const runChild = (file: string, args: string[]) => new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    output += String(chunk); if (Buffer.byteLength(output) > 16_384) child.kill('SIGKILL');
  });
  child.once('error', reject);
  child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, output }); });
});

const setup = async () => {
  const root = await mkdtemp('/private/tmp/harness-synthetic-change-recovery-');
  await mkdir(join(root, 'store'), { mode: 0o700 }); await mkdir(join(root, 'control'), { mode: 0o700 });
  const release = acquireSyntheticCompanyChangeControl(root, true);
  const workspace = await createSyntheticCompanyChangeWorkspace(root);
  workspace.register(join(root, 'synthetic-workspace.json'));
  const database = join(root, 'store', 'synthetic-company-change.sqlite');
  const store = new SqliteSyntheticCompanyChangeStore(database);
  const draft: CompanyChangeDraft = { version: 'company-change-draft-v1', repoId: 'synthetic-company-change', requestRevision: 1,
    objective: 'Synthetic process interruption', baseCommit: workspace.baseCommit, baseBranch: 'main', baseIndexHash: workspace.baseIndexHash,
    workType: 'fix', branch: 'fix/recovery-demo', changes: [
      { operation: 'replace', path: 'src/message.ts', beforeHash: hashCompanyChangeValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']!), content: "export const message = 'after interruption';\n" },
      { operation: 'replace', path: 'src/options.ts', beforeHash: hashCompanyChangeValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']!), content: 'export const enabled = true;\n' },
      { operation: 'create', path: 'src/addition.ts', beforeHash: null, content: 'export const value = 1;\n' },
    ] };
  try {
    const service = new SyntheticCompanyChangeService(store, workspace);
    const plan = await service.prepare(draft), request = { taskId: plan.plan.id, planHash: plan.plan.planHash };
    await service.approve({ ...request, expiresInMinutes: 10 }, draft);
    await writeFile(join(root, 'driver.json'), JSON.stringify({ request, draft }), { mode: 0o600, flag: 'wx' });
    const driver = join(root, 'interrupt.mjs'); await writeFile(driver, childSource(), { mode: 0o600, flag: 'wx' });
    return { root, database, request, draft, driver, repository: workspace.repositoryRoot };
  } finally { store.close(); release(); }
};

const tree = async (root: string): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const visit = async (relative: string): Promise<void> => {
    const full = join(root, relative), metadata = await lstat(full);
    result[relative] = `${metadata.mode}:${metadata.ino}:${metadata.nlink}`;
    if (metadata.isDirectory()) for (const child of (await readdir(full)).sort()) await visit(relative ? `${relative}/${child}` : child);
    else if (metadata.isFile()) result[relative] += `:${hashCompanyChangeValue(await readFile(full))}`;
    else throw new Error('Unexpected synthetic tree entry');
  };
  await visit(''); return result;
};

for (const point of ['claimed', 'branch', 'first-file', 'last-file'] as const) {
  test(`SIGKILL at ${point} preserves consumed approval and recovers without touching remaining repository files`, async () => {
    const f = await setup();
    try {
      const child = await runChild(f.driver, [f.root, point]);
      assert.equal(child.signal, 'SIGKILL', child.output); assert.equal(child.code, null);
      const before = await tree(f.repository);
      const lock = join(dirname(f.repository), 'workspace.lock'), lockBytes = await readFile(lock);
      const release = acquireSyntheticCompanyChangeControl(f.root);
      const store = new SqliteSyntheticCompanyChangeStore(f.database);
      try {
        const workspace = await openSyntheticCompanyChangeWorkspace(join(f.root, 'synthetic-workspace.json'));
        const interrupted = store.inspect(f.request.taskId, context());
        assert.equal(interrupted.status, 'APPLYING'); assert.ok(interrupted.approval?.usedAt);
        const result = await recoverSyntheticCompanyChange(store, workspace, f.request);
        assert.equal(result.snapshot.status, 'FAILED'); assert.equal(result.snapshot.failureCode, 'SYNTHETIC_COMPANY_CHANGE_INTERRUPTED');
        assert.deepEqual(result.snapshot.journal, interrupted.journal);
        assert.equal(result.snapshot.approval?.usedAt, interrupted.approval?.usedAt);
        assert.equal(result.observation.complete, true);
        assert.equal(result.observation.branch, point === 'claimed' ? 'base' : 'target');
        assert.equal(result.observation.indexPreserved, true); assert.equal(result.observation.basePreserved, true);
        assert.ok(result.observation.residuals! >= 1);
        assert.equal(result.observation.files[0]!.state, ['first-file', 'last-file'].includes(point) ? 'after' : 'before');
        assert.equal(result.observation.files[2]!.state, point === 'last-file' ? 'after' : 'absent');
        await assert.rejects(new SyntheticCompanyChangeService(store, workspace).apply(f.request, f.draft));
        const again = await recoverSyntheticCompanyChange(store, workspace, f.request);
        assert.equal(again.snapshot.updatedAt, result.snapshot.updatedAt);
        assert.deepEqual(await tree(f.repository), before); assert.deepEqual(await readFile(lock), lockBytes);
      } finally { store.close(); release(); }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test('lost response after a durable APPLIED result remains APPLIED and is never recovered or reapplied', async () => {
  const f = await setup();
  try {
    const child = await runChild(f.driver, [f.root, 'after-finish']); assert.equal(child.signal, 'SIGKILL', child.output);
    const release = acquireSyntheticCompanyChangeControl(f.root), store = new SqliteSyntheticCompanyChangeStore(f.database);
    try {
      const workspace = await openSyntheticCompanyChangeWorkspace(join(f.root, 'synthetic-workspace.json'));
      const snapshot = store.inspect(f.request.taskId, context()); assert.equal(snapshot.status, 'APPLIED');
      await assert.rejects(recoverSyntheticCompanyChange(store, workspace, f.request), { code: 'SYNTHETIC_COMPANY_CHANGE_RECOVERY_UNAVAILABLE' });
      await assert.rejects(new SyntheticCompanyChangeService(store, workspace).apply(f.request, f.draft));
      assert.deepEqual(store.inspect(f.request.taskId, context()).journal, snapshot.journal);
    } finally { store.close(); release(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('recovery rejects observations with substituted task, plan, order or completion claims before changing state', async () => {
  const f = await setup();
  try {
    assert.equal((await runChild(f.driver, [f.root, 'first-file'])).signal, 'SIGKILL');
    const release = acquireSyntheticCompanyChangeControl(f.root), store = new SqliteSyntheticCompanyChangeStore(f.database);
    try {
      const workspace = await openSyntheticCompanyChangeWorkspace(join(f.root, 'synthetic-workspace.json'));
      const before = store.inspect(f.request.taskId, context()), valid = await workspace.observeRecovery(before.plan);
      for (const altered of [{ ...valid, taskId: '00000000-0000-0000-0000-000000000000' },
        { ...valid, planHash: '0'.repeat(64) }, { ...valid, files: [...valid.files].reverse() }, { ...valid, complete: false }]) {
        await assert.rejects(recoverSyntheticCompanyChange(store, { observeRecovery: async () => altered }, f.request), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_OBSERVATION' });
        assert.equal(store.inspect(f.request.taskId, context()).status, 'APPLYING');
      }
    } finally { store.close(); release(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('the actual CLI recovers a killed apply process, publishes a private observation and refuses replay', async () => {
  const parent = await mkdtemp('/private/tmp/harness-synthetic-change-cli-kill-'), runtime = join(parent, 'runtime');
  const cli = (command: string, args: string[] = []) => runChild(resolve('dist/src/cli/main.js'), [
    `synthetic-change-${command}`, '--data-dir', runtime, ...args,
  ]);
  const readSummary = (result: Awaited<ReturnType<typeof cli>>): Record<string, unknown> => {
    assert.equal(result.code, 0, result.output); assert.equal(result.signal, null);
    return JSON.parse(result.output) as Record<string, unknown>;
  };
  try {
    assert.equal(readSummary(await cli('init')).status, 'INITIALIZED');
    const draftPath = join(runtime, 'example-draft.json');
    const prepared = readSummary(await cli('plan', ['--draft', draftPath]));
    const request = { taskId: String(prepared.taskId), planHash: String(prepared.planHash) };
    const task = ['--task', request.taskId], hash = ['--plan-hash', request.planHash];
    assert.equal(readSummary(await cli('approve', [...task, ...hash, '--expires-in-minutes', '10', '--draft', draftPath])).status, 'APPROVED');
    const workspace = await openSyntheticCompanyChangeWorkspace(join(runtime, 'synthetic-workspace.json'));
    const driver = join(parent, 'interrupt.mjs'), input = join(parent, 'driver.json');
    await writeFile(driver, childSource(), { mode: 0o600, flag: 'wx' });
    await writeFile(input, JSON.stringify({ request, draft: JSON.parse(await readFile(draftPath, 'utf8')) }), { mode: 0o600, flag: 'wx' });
    assert.equal((await runChild(driver, [runtime, 'first-file', input])).signal, 'SIGKILL');
    const before = await tree(workspace.repositoryRoot);
    const summary = readSummary(await cli('recover', [...task, ...hash]));
    assert.equal(summary.status, 'FAILED'); assert.equal(summary.observationAvailable, true);
    assert.equal(summary.failureCode, 'SYNTHETIC_COMPANY_CHANGE_INTERRUPTED');
    const reportPath = join(runtime, 'reports', `${request.taskId}.json`);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal((await lstat(reportPath)).mode & 0o777, 0o600);
    assert.equal(report.observation.complete, true); assert.equal(report.observation.files[0].state, 'after');
    assert.equal(report.snapshot.plan.checks, 'not_run');
    assert.equal((await cli('apply', [...task, ...hash, '--draft', draftPath])).code, 1);
    assert.deepEqual(await tree(workspace.repositoryRoot), before);
    assert.equal(readSummary(await cli('inspect', task)).status, 'FAILED');
  } finally { await rm(parent, { recursive: true, force: true }); }
});
