import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { CompanyChangeDraft } from '../src/domain/company-change.js';
import { createSyntheticCompanyChangeWorkspace, openSyntheticCompanyChangeWorkspace, SYNTHETIC_COMPANY_CHANGE_FILES } from '../src/adapters/synthetic-company-change-workspace.js';
import { hashCompanyChangeValue } from '../src/policy/company-change.js';
import { canonicalReadonlyJson } from '../src/policy/readonly-investigation-policy.js';
import { createSyntheticCompanyChangePlan } from '../src/policy/synthetic-company-change.js';

const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date('2026-11-20T00:00:00.000Z') };
const fixture = async () => {
  const parent = fs.mkdtempSync('/private/tmp/harness-synthetic-registration-');
  const workspace = await createSyntheticCompanyChangeWorkspace(parent), registration = join(parent, 'synthetic-workspace.json');
  const repository = workspace.repositoryRoot;
  const draft: CompanyChangeDraft = { version: 'company-change-draft-v1', repoId: 'synthetic-company-change', requestRevision: 1,
    objective: 'Observe only a registered synthetic change', baseCommit: workspace.baseCommit, baseIndexHash: workspace.baseIndexHash,
    baseBranch: 'main', workType: 'feature', branch: 'feature/registered-change', changes: [
      { operation: 'replace', path: 'src/message.ts', beforeHash: hashCompanyChangeValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']!), content: "export const message = 'registered after';\n" },
      { operation: 'create', path: 'src/created.ts', beforeHash: null, content: 'export const created = true;\n' },
    ] };
  return { parent, workspace, registration, repository, draft,
    close: () => fs.rmSync(parent, { recursive: true, force: true }) };
};
const prepare = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const lease = await f.workspace.acquire();
  try { return createSyntheticCompanyChangePlan(f.draft, await f.workspace.observe(f.draft), context).plan; }
  finally { await lease.release(); }
};
const capture = (root: string): unknown => {
  const rows: unknown[] = [];
  const visit = (path: string): void => {
    const stat = fs.lstatSync(path), relative = path.slice(root.length);
    rows.push({ path: relative, dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink,
      size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      hash: stat.isFile() ? hashCompanyChangeValue(fs.readFileSync(path)) : null });
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root); return rows;
};
const rewriteReceipt = (path: string, edit: (value: Record<string, unknown>) => void): void => {
  const value = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(value); const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'receiptHash'));
  value.receiptHash = hashCompanyChangeValue(canonicalReadonlyJson(body));
  fs.writeFileSync(path, canonicalReadonlyJson(value));
};

test('registration is bounded private metadata and preserves exact source identity when reopened', async () => {
  const f = await fixture();
  try {
    f.workspace.register(f.registration);
    const receipt = fs.readFileSync(f.registration, 'utf8');
    assert.ok(Buffer.byteLength(receipt) <= 131_072); assert.equal(fs.statSync(f.registration).mode & 0o777, 0o600);
    for (const content of Object.values(SYNTHETIC_COMPANY_CHANGE_FILES)) assert.equal(receipt.includes(content), false);
    assert.equal(receipt.includes(f.repository), false); assert.equal(receipt.includes(f.parent), false);
    const before = capture(f.repository), plan = await prepare(f), reopened = await openSyntheticCompanyChangeWorkspace(f.registration);
    assert.equal(reopened.repositoryRoot, f.repository); assert.equal(reopened.baseCommit, f.workspace.baseCommit);
    const lease = await reopened.acquire();
    try { assert.deepEqual(await reopened.observe(f.draft), plan.source); }
    finally { await lease.release(); }
    // Lease creation changes only its enclosing directory timestamps, never source or receipt data.
    assert.deepEqual(capture(f.repository), before);
    assert.equal(fs.readFileSync(f.registration, 'utf8'), receipt);
  } finally { f.close(); }
});

test('reopened normal workspace can bind, branch and apply a plan prepared by another instance', async () => {
  const f = await fixture();
  try {
    f.workspace.register(f.registration); const plan = await prepare(f);
    const reopened = await openSyntheticCompanyChangeWorkspace(f.registration), lease = await reopened.acquire();
    try {
      assert.deepEqual(await reopened.observe(f.draft), plan.source);
      await reopened.createBranch(plan, f.draft);
      for (let index = 0; index < f.draft.changes.length; index++) await reopened.writeFile(plan, f.draft, index);
      await reopened.verifyApplied(plan, f.draft);
    } finally { await lease.release(); }
    const observer = await openSyntheticCompanyChangeWorkspace(f.registration), before = capture(f.parent);
    const report = await observer.observeRecovery(plan);
    assert.equal(report.complete, true); assert.equal(report.branch, 'target');
    assert.deepEqual(report.files.map(file => file.state), ['after', 'after']);
    assert.equal(report.indexPreserved, true); assert.equal(report.basePreserved, true); assert.equal(report.residuals, 0);
    assert.deepEqual(capture(f.parent), before);
  } finally { f.close(); }
});

test('registration never overwrites an existing file and rejects other parent or basename requests', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(f.registration, 'existing user file', { mode: 0o600 });
    assert.throws(() => f.workspace.register(f.registration)); assert.equal(fs.readFileSync(f.registration, 'utf8'), 'existing user file');
    assert.throws(() => f.workspace.register(join(f.parent, 'another.json')), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_REGISTRATION' });
    const child = join(f.parent, 'another-parent'); fs.mkdirSync(child, { mode: 0o700 });
    assert.throws(() => f.workspace.register(join(child, 'synthetic-workspace.json')), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_REGISTRATION' });
    assert.deepEqual(fs.readdirSync(child), []);
  } finally { f.close(); }
});

test('registration requires the unmodified factory tree before any observed or applied work', async () => {
  for (const change of ['content', 'observed'] as const) {
    const f = await fixture();
    try {
      if (change === 'content') fs.writeFileSync(join(f.repository, 'README.md'), 'Unregistered local edits\n');
      else await prepare(f);
      assert.throws(() => f.workspace.register(f.registration)); assert.equal(fs.existsSync(f.registration), false);
    } finally { f.close(); }
  }
});

test('corrupt, spoofed, oversized and altered fixed-baseline receipts fail before any repository file opens', async t => {
  for (const mutation of ['hash', 'root', 'unknown', 'owner', 'commit', 'baseline', 'oversize', 'duplicate'] as const) {
    const f = await fixture();
    try {
      f.workspace.register(f.registration);
      if (mutation === 'hash') fs.appendFileSync(f.registration, 'corrupt');
      if (mutation === 'root') rewriteReceipt(f.registration, value => { value.rootName = '../outside'; });
      if (mutation === 'unknown') rewriteReceipt(f.registration, value => { value.repositoryRoot = f.repository; });
      if (mutation === 'owner') rewriteReceipt(f.registration, value => { value.ownerId = 'os-user:999999'; });
      if (mutation === 'commit') rewriteReceipt(f.registration, value => { value.baseCommit = '0'.repeat(40); });
      if (mutation === 'baseline') rewriteReceipt(f.registration, value => {
        const baseline = value.baseline as { entries: Array<[string, { hash: string }]>; hash: string };
        baseline.entries.find(([path]) => path === 'README.md')![1].hash = '0'.repeat(64);
        baseline.hash = hashCompanyChangeValue(canonicalReadonlyJson([...baseline.entries].sort(([left], [right]) => left.localeCompare(right, 'en'))));
      });
      if (mutation === 'oversize') fs.writeFileSync(f.registration, ' '.repeat(131_073));
      if (mutation === 'duplicate') fs.writeFileSync(f.registration, '{"version":1,"version":2}');
      const actual = fs.openSync; let sourceOpens = 0;
      const mock = t.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        if (String(path).startsWith(`${f.repository}/`)) sourceOpens++;
        return actual(path, flags, mode);
      }) as typeof fs.openSync);
      try { await assert.rejects(openSyntheticCompanyChangeWorkspace(f.registration)); assert.equal(sourceOpens, 0); }
      finally { mock.mock.restore(); }
    } finally { f.close(); }
  }
});

test('receipt and repository link swaps do not follow an external canary', async t => {
  for (const swap of ['receipt', 'repository'] as const) {
    const f = await fixture();
    try {
      f.workspace.register(f.registration);
      const canary = join(f.parent, 'external-canary');
      if (swap === 'receipt') { fs.writeFileSync(canary, 'external synthetic canary', { mode: 0o600 }); fs.renameSync(f.registration, `${f.registration}.old`); fs.symlinkSync(canary, f.registration); }
      else { fs.mkdirSync(canary, { mode: 0o700 }); fs.renameSync(f.repository, `${f.repository}.old`); fs.symlinkSync(canary, f.repository); }
      const actual = fs.openSync; let canaryOpens = 0;
      const mock = t.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        if (String(path) === canary || String(path).startsWith(`${canary}/`)) canaryOpens++;
        return actual(path, flags, mode);
      }) as typeof fs.openSync);
      try { await assert.rejects(openSyntheticCompanyChangeWorkspace(f.registration)); assert.equal(canaryOpens, 0); }
      finally { mock.mock.restore(); }
    } finally { f.close(); }
  }
});

test('receipt location and directory identities cannot be transplanted to another private runtime', async () => {
  const f = await fixture(), other = await fixture();
  try {
    f.workspace.register(f.registration);
    fs.copyFileSync(f.registration, other.registration); fs.chmodSync(other.registration, 0o600);
    await assert.rejects(openSyntheticCompanyChangeWorkspace(other.registration));
    const root = dirname(f.repository); fs.renameSync(root, `${root}.old`); fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(join(root, 'repository'), { mode: 0o700 });
    await assert.rejects(openSyntheticCompanyChangeWorkspace(f.registration), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_REGISTRATION' });
  } finally { f.close(); other.close(); }
});

test('a changed Git baseline can reopen only for read-only recovery and cannot become a fresh normal source', async () => {
  const f = await fixture();
  try {
    f.workspace.register(f.registration); const plan = await prepare(f);
    fs.appendFileSync(join(f.repository, '.git/index'), 'synthetic index drift');
    const reopened = await openSyntheticCompanyChangeWorkspace(f.registration), lease = await reopened.acquire();
    try { await assert.rejects(reopened.observe(f.draft), { code: 'SYNTHETIC_COMPANY_CHANGE_GIT_CHANGED' }); }
    finally { await lease.release(); }
    const before = capture(f.parent), report = await reopened.observeRecovery(plan);
    assert.equal(report.complete, true); assert.equal(report.indexPreserved, false); assert.equal(report.basePreserved, true);
    assert.equal(report.branch, 'base'); assert.deepEqual(report.files.map(file => file.state), ['before', 'absent']);
    assert.deepEqual(capture(f.parent), before);
  } finally { f.close(); }
});

test('recovery reports partial writes and residual locks without acquiring, removing, resuming or overwriting them', async () => {
  const f = await fixture();
  try {
    f.workspace.register(f.registration); const plan = await prepare(f), lease = await f.workspace.acquire();
    try {
      await f.workspace.observe(f.draft); await f.workspace.createBranch(plan, f.draft); await f.workspace.writeFile(plan, f.draft, 0);
    } finally { await lease.release(); }
    const lock = join(dirname(f.repository), 'workspace.lock'); fs.writeFileSync(lock, 'stale synthetic lock', { mode: 0o600 });
    fs.writeFileSync(join(f.repository, '.git/HEAD.lock'), 'unfinished symbolic ref', { mode: 0o600 });
    fs.writeFileSync(join(f.repository, `src/.company-change-${plan.id}-1-dead.tmp`), 'unfinished bytes', { mode: 0o600 });
    const observer = await openSyntheticCompanyChangeWorkspace(f.registration), before = capture(f.parent);
    const report = await observer.observeRecovery(plan);
    assert.equal(report.complete, true); assert.equal(report.branch, 'target'); assert.equal(report.residuals, 3);
    assert.deepEqual(report.files.map(file => file.state), ['after', 'absent']);
    assert.equal(report.indexPreserved, true); assert.equal(report.basePreserved, true);
    assert.equal(JSON.stringify(report).includes('unfinished'), false); assert.equal(JSON.stringify(report).includes('registered after'), false);
    assert.deepEqual(capture(f.parent), before);
    await assert.rejects(observer.acquire(), { code: 'SYNTHETIC_COMPANY_CHANGE_WORKSPACE_BUSY' });
    assert.deepEqual(capture(f.parent), before);
  } finally { f.close(); }
});

test('unsafe trees, bound exhaustion and receipt changes return only an incomplete body-free observation', async t => {
  for (const mutation of ['link', 'large', 'receipt'] as const) {
    const f = await fixture();
    try {
      f.workspace.register(f.registration); const plan = await prepare(f), observer = await openSyntheticCompanyChangeWorkspace(f.registration);
      const outside = join(f.parent, 'canary'); fs.writeFileSync(outside, 'Unopened synthetic canary', { mode: 0o600 });
      if (mutation === 'link') fs.symlinkSync(outside, join(f.repository, 'src/link.ts'));
      if (mutation === 'large') fs.writeFileSync(join(f.repository, 'large.txt'), Buffer.alloc(1_048_577), { mode: 0o600 });
      if (mutation === 'receipt') fs.appendFileSync(f.registration, ' ');
      const actual = fs.openSync; let canaryOpens = 0;
      const mock = t.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        if (String(path) === outside || String(path) === join(f.repository, 'src/link.ts')) canaryOpens++;
        return actual(path, flags, mode);
      }) as typeof fs.openSync);
      try {
        const report = await observer.observeRecovery(plan);
        assert.deepEqual(report, { version: 'synthetic-company-change-observation-v1', taskId: plan.id, planHash: plan.planHash,
          branch: 'unknown', files: plan.changes.map(change => ({ path: change.path, state: 'unsafe', hash: null })),
          indexPreserved: null, basePreserved: null, residuals: null, complete: false });
        assert.equal(canaryOpens, 0);
      } finally { mock.mock.restore(); }
    } finally { f.close(); }
  }
});

test('a foreign workspace plan is rejected without reading target file contents', async t => {
  const f = await fixture(), other = await fixture();
  try {
    f.workspace.register(f.registration); const plan = await prepare(other);
    const observer = await openSyntheticCompanyChangeWorkspace(f.registration), actual = fs.openSync; let reads = 0;
    const mock = t.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (String(path).startsWith(`${f.repository}/`)) reads++;
      return actual(path, flags, mode);
    }) as typeof fs.openSync);
    try { await assert.rejects(observer.observeRecovery(plan), { code: 'SYNTHETIC_COMPANY_CHANGE_SOURCE_CHANGED' }); assert.equal(reads, 0); }
    finally { mock.mock.restore(); }
  } finally { f.close(); other.close(); }
});
