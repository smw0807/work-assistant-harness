import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { CompanyChangeDraft } from '../src/domain/company-change.js';
import { createSyntheticCompanyChangeWorkspace, SYNTHETIC_COMPANY_CHANGE_FILES } from '../src/adapters/synthetic-company-change-workspace.js';
import { createCompanyChangePlan, hashCompanyChangeValue } from '../src/policy/company-change.js';
import { createSyntheticCompanyChangePlan, getSyntheticCompanyChangeLimits } from '../src/policy/synthetic-company-change.js';

const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date('2026-11-20T00:00:00.000Z') };
const fixture = async () => {
  const parent = fs.mkdtempSync('/private/tmp/harness-synthetic-workspace-');
  const workspace = await createSyntheticCompanyChangeWorkspace(parent);
  const repository = workspace.repositoryRoot;
  const draft: CompanyChangeDraft = { version: 'company-change-draft-v1', repoId: 'synthetic-company-change',
    requestRevision: 1, objective: 'Change only synthetic fixture files', baseCommit: workspace.baseCommit,
    baseBranch: 'main', baseIndexHash: workspace.baseIndexHash, workType: 'feature', branch: 'feature/synthetic-change',
    changes: [
      { operation: 'replace', path: 'src/message.ts', beforeHash: hashCompanyChangeValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']!), content: "export const message = 'after';\n" },
      { operation: 'replace', path: 'src/options.ts', beforeHash: hashCompanyChangeValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']!), content: 'export const options = { enabled: true };\n' },
      { operation: 'create', path: 'src/added.ts', beforeHash: null, content: 'export const added = true;\n' },
    ] };
  return { parent, workspace, repository, draft,
    close: () => fs.rmSync(parent, { recursive: true, force: true }),
    read: (path: string) => fs.readFileSync(join(repository, path), 'utf8'),
    write: (path: string, body: string) => fs.writeFileSync(join(repository, path), body, { mode: 0o600 }),
  };
};
const prepare = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const lease = await f.workspace.acquire();
  try {
    const source = await f.workspace.observe(f.draft);
    return { lease, plan: createSyntheticCompanyChangePlan(f.draft, source, context).plan };
  } catch (error) { await lease.release(); throw error; }
};

test('factory creates only a new private synthetic repository and rejects unsuitable existing parent paths', async () => {
  const f = await fixture();
  try {
    assert.equal(fs.statSync(f.repository).mode & 0o777, 0o700);
    assert.equal(f.read('.git/HEAD'), 'ref: refs/heads/main\n');
    assert.equal(f.read('.git/refs/heads/main'), `${f.workspace.baseCommit}\n`);
    assert.equal(hashCompanyChangeValue(fs.readFileSync(join(f.repository, '.git/index'))), f.workspace.baseIndexHash);
    assert.deepEqual(fs.readdirSync(f.repository).sort(), ['.git', 'README.md', 'src']);
    assert.equal(fs.existsSync(join(f.parent, '.git')), false);
    const link = join(f.parent, 'linked-parent'); fs.symlinkSync(dirname(f.repository), link);
    await assert.rejects(createSyntheticCompanyChangeWorkspace(link));
    await assert.rejects(createSyntheticCompanyChangeWorkspace(`${f.parent}/../${f.parent.split('/').at(-1)}`));
    const publicParent = join(f.parent, 'public'); fs.mkdirSync(publicParent, { mode: 0o755 });
    await assert.rejects(createSyntheticCompanyChangeWorkspace(publicParent));
    assert.deepEqual(fs.readdirSync(publicParent), []);
    await assert.rejects(createSyntheticCompanyChangeWorkspace(process.cwd()), { code: 'SYNTHETIC_COMPANY_CHANGE_UNSAFE_PARENT' });
  } finally { f.close(); }
});

test('multi-file replacement and creation switch HEAD first and preserve original branch, index, dirt and modes', async () => {
  const f = await fixture();
  try {
    f.write('README.md', 'Unselected local work remains\n');
    fs.chmodSync(join(f.repository, 'src/message.ts'), 0o640);
    const index = fs.readFileSync(join(f.repository, '.git/index')), main = f.read('.git/refs/heads/main');
    const { lease, plan } = await prepare(f);
    try {
      assert.equal(f.read('.git/HEAD'), 'ref: refs/heads/main\n');
      await f.workspace.createBranch(plan, f.draft);
      assert.equal(f.read('.git/HEAD'), `ref: refs/heads/${f.draft.branch}\n`);
      assert.equal(f.read('src/message.ts'), SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']);
      for (let index = 0; index < f.draft.changes.length; index++) await f.workspace.writeFile(plan, f.draft, index);
      await f.workspace.verifyApplied(plan, f.draft);
      for (const change of f.draft.changes) assert.equal(f.read(change.path), change.content);
      assert.equal(fs.statSync(join(f.repository, 'src/message.ts')).mode & 0o777, 0o640);
      assert.equal(fs.statSync(join(f.repository, 'src/added.ts')).mode & 0o777, 0o600);
      assert.equal(f.read('README.md'), 'Unselected local work remains\n');
      assert.deepEqual(fs.readFileSync(join(f.repository, '.git/index')), index);
      assert.equal(f.read('.git/refs/heads/main'), main);
      await assert.rejects(f.workspace.writeFile(plan, f.draft, 0), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_WRITE_ORDER' });
      await assert.rejects(f.workspace.createBranch(plan, f.draft), { code: 'SYNTHETIC_COMPANY_CHANGE_ALREADY_APPLIED' });
    } finally { await lease.release(); }
  } finally { f.close(); }
});

test('workspace lease is exclusive and stale foreign locks are never adopted or deleted', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.workspace.observe(f.draft), { code: 'SYNTHETIC_COMPANY_CHANGE_LEASE_REQUIRED' });
    const lease = await f.workspace.acquire(), lock = join(dirname(f.repository), 'workspace.lock');
    await assert.rejects(f.workspace.acquire(), { code: 'SYNTHETIC_COMPANY_CHANGE_WORKSPACE_BUSY' });
    await lease.release(); await lease.release();
    fs.writeFileSync(lock, 'foreign lock', { mode: 0o600 });
    await assert.rejects(f.workspace.acquire(), { code: 'SYNTHETIC_COMPANY_CHANGE_WORKSPACE_BUSY' });
    assert.equal(fs.readFileSync(lock, 'utf8'), 'foreign lock');
  } finally { f.close(); }
});

test('lease release closes its descriptor but preserves a replaced foreign lock', async () => {
  const f = await fixture();
  try {
    const lease = await f.workspace.acquire(), lock = join(dirname(f.repository), 'workspace.lock');
    fs.renameSync(lock, `${lock}.old`); fs.writeFileSync(lock, 'foreign replacement', { mode: 0o600 });
    await assert.rejects(lease.release(), { code: 'SYNTHETIC_COMPANY_CHANGE_OWNERSHIP_CHANGED' });
    assert.equal(fs.readFileSync(lock, 'utf8'), 'foreign replacement');
    await lease.release();
    await assert.rejects(f.workspace.acquire(), { code: 'SYNTHETIC_COMPANY_CHANGE_WORKSPACE_BUSY' });
  } finally { f.close(); }
});

test('selected dirty files, false before hashes, existing create targets and missing parents fail before a branch exists', async () => {
  for (const change of ['dirty', 'hash', 'existing', 'parent', 'case', 'mode'] as const) {
    const f = await fixture();
    try {
      if (change === 'dirty') f.write('src/message.ts', 'User selected work\n');
      if (change === 'hash') f.draft.changes[0]!.beforeHash = '0'.repeat(64);
      if (change === 'existing') f.write('src/added.ts', 'Already exists\n');
      if (change === 'parent') f.draft.changes[2]!.path = 'missing/added.ts';
      if (change === 'case') f.draft.changes[2]!.path = 'readme.md';
      if (change === 'mode') fs.chmodSync(join(f.repository, 'src/message.ts'), 0o700);
      const lease = await f.workspace.acquire();
      try { await assert.rejects(f.workspace.observe(f.draft)); }
      finally { await lease.release(); }
      assert.equal(f.read('.git/HEAD'), 'ref: refs/heads/main\n');
      assert.equal(fs.existsSync(join(f.repository, '.git/refs/heads/feature')), false);
    } finally { f.close(); }
  }
});

test('Git metadata changes, branch collisions and merge or foreign lock state cannot enter an observed source', async () => {
  for (const change of ['index', 'head', 'ref', 'branch', 'merge', 'lock', 'linked'] as const) {
    const f = await fixture();
    try {
      if (change === 'index') fs.appendFileSync(join(f.repository, '.git/index'), 'drift');
      if (change === 'head') f.write('.git/HEAD', `${f.workspace.baseCommit}\n`);
      if (change === 'ref') f.write('.git/refs/heads/main', `${'0'.repeat(40)}\n`);
      if (change === 'branch') { fs.mkdirSync(join(f.repository, '.git/refs/heads/feature'), { mode: 0o700 }); f.write(`.git/refs/heads/${f.draft.branch}`, `${f.workspace.baseCommit}\n`); }
      if (change === 'merge') f.write('.git/MERGE_HEAD', `${f.workspace.baseCommit}\n`);
      if (change === 'lock') f.write('.git/index.lock', 'foreign index lock');
      if (change === 'linked') f.write('.git/commondir', '../outside');
      const lease = await f.workspace.acquire();
      try { await assert.rejects(f.workspace.observe(f.draft)); }
      finally { await lease.release(); }
      assert.equal(f.read('src/message.ts'), SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']);
      if (change === 'lock') assert.equal(f.read('.git/index.lock'), 'foreign index lock');
    } finally { f.close(); }
  }
});

test('symlinks and hardlinks in a synthetic tree are rejected before reading their contents', async t => {
  for (const type of ['symlink', 'hardlink'] as const) {
    const f = await fixture();
    try {
      const outside = join(f.parent, 'synthetic-canary.txt'); fs.writeFileSync(outside, 'Do not read canary\n', { mode: 0o600 });
      const linked = join(f.repository, 'src/link.ts');
      if (type === 'symlink') fs.symlinkSync(outside, linked); else fs.linkSync(outside, linked);
      const actualOpen = fs.openSync; let canaryOpens = 0;
      const mock = t.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        if (String(path) === outside || String(path) === linked) canaryOpens++;
        return actualOpen(path, flags, mode);
      }) as typeof fs.openSync);
      const lease = await f.workspace.acquire();
      try { await assert.rejects(f.workspace.observe(f.draft)); assert.equal(canaryOpens, 0); }
      finally { await lease.release(); mock.mock.restore(); }
    } finally { f.close(); }
  }
});

test('observed source drift before branch creation and between writes stops without reverting prior work', async () => {
  const f = await fixture();
  try {
    const { lease, plan } = await prepare(f);
    try {
      f.write('README.md', 'After observation\n');
      await assert.rejects(f.workspace.createBranch(plan, f.draft), { code: 'SYNTHETIC_COMPANY_CHANGE_SOURCE_CHANGED' });
      assert.equal(f.read('.git/HEAD'), 'ref: refs/heads/main\n');
      const source = await f.workspace.observe(f.draft), refreshed = createSyntheticCompanyChangePlan(f.draft, source, context).plan;
      await f.workspace.createBranch(refreshed, f.draft); await f.workspace.writeFile(refreshed, f.draft, 0);
      f.write('README.md', 'After first write\n');
      await assert.rejects(f.workspace.writeFile(refreshed, f.draft, 1), { code: 'SYNTHETIC_COMPANY_CHANGE_SOURCE_CHANGED' });
      assert.equal(f.read('src/message.ts'), f.draft.changes[0]!.content);
      assert.equal(f.read('src/options.ts'), SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']);
      assert.equal(f.read('README.md'), 'After first write\n');
      assert.equal(f.read('.git/HEAD'), `ref: refs/heads/${f.draft.branch}\n`);
    } finally { await lease.release(); }
  } finally { f.close(); }
});

test('tree byte and entry limits reject oversized synthetic inputs without creating a ref', async () => {
  for (const limit of ['bytes', 'entries'] as const) {
    const f = await fixture();
    try {
      if (limit === 'bytes') f.write('large.txt', 'x'.repeat(getSyntheticCompanyChangeLimits().maxSourceBytes));
      else for (let index = 0; index < getSyntheticCompanyChangeLimits().maxSourceEntries; index++) f.write(`extra-${index}.txt`, '');
      const lease = await f.workspace.acquire();
      try { await assert.rejects(f.workspace.observe(f.draft), { code: 'SYNTHETIC_COMPANY_CHANGE_SOURCE_LIMIT' }); }
      finally { await lease.release(); }
      assert.equal(f.read('.git/HEAD'), 'ref: refs/heads/main\n');
    } finally { f.close(); }
  }
});

test('plans from another factory instance and review-only plans cannot start branch mutation', async () => {
  const f = await fixture(), other = await fixture();
  try {
    const { lease, plan } = await prepare(f), otherLease = await other.workspace.acquire();
    try {
      const otherDraft = { ...f.draft, baseCommit: other.workspace.baseCommit, baseIndexHash: other.workspace.baseIndexHash };
      await other.workspace.observe(otherDraft);
      await assert.rejects(other.workspace.createBranch(plan, otherDraft));
      const review = createCompanyChangePlan(f.draft, context).plan;
      await assert.rejects(f.workspace.createBranch(review as unknown as typeof plan, f.draft));
      assert.equal(f.read('.git/HEAD'), 'ref: refs/heads/main\n');
      assert.equal(other.read('.git/HEAD'), 'ref: refs/heads/main\n');
    } finally { await lease.release(); await otherLease.release(); }
  } finally { f.close(); other.close(); }
});

test('an injected publication failure leaves prior changes and branch intact without an automatic rollback', async t => {
  const f = await fixture();
  try {
    const { lease, plan } = await prepare(f);
    try {
      await f.workspace.createBranch(plan, f.draft); await f.workspace.writeFile(plan, f.draft, 0);
      const index = fs.readFileSync(join(f.repository, '.git/index')), actualRename = fs.renameSync;
      const mock = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === join(f.repository, 'src/options.ts')) throw new Error('synthetic injected publication failure');
        actualRename(from, to);
      });
      await assert.rejects(f.workspace.writeFile(plan, f.draft, 1)); mock.mock.restore();
      assert.equal(f.read('src/message.ts'), f.draft.changes[0]!.content);
      assert.equal(f.read('src/options.ts'), SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']);
      assert.equal(f.read('.git/HEAD'), `ref: refs/heads/${f.draft.branch}\n`);
      assert.equal(f.read('.git/refs/heads/main'), `${f.workspace.baseCommit}\n`);
      assert.deepEqual(fs.readFileSync(join(f.repository, '.git/index')), index);
      assert.deepEqual(fs.readdirSync(join(f.repository, 'src')).sort(), ['message.ts', 'options.ts']);
      await assert.rejects(f.workspace.verifyApplied(plan, f.draft), { code: 'SYNTHETIC_COMPANY_CHANGE_INCOMPLETE_APPLICATION' });
      await assert.rejects(f.workspace.writeFile(plan, f.draft, 1), { code: 'SYNTHETIC_COMPANY_CHANGE_SOURCE_CHANGED' });
    } finally { await lease.release(); }
  } finally { f.close(); }
});

test('ref cleanup preserves a foreign replacement and still releases the independent HEAD lock', async t => {
  const f = await fixture();
  try {
    const { lease, plan } = await prepare(f);
    try {
      const actualLink = fs.linkSync, foreign = join(f.repository, `.git/refs/heads/${f.draft.branch}.lock`);
      const mock = t.mock.method(fs, 'linkSync', (from: fs.PathLike, to: fs.PathLike) => {
        if (String(from) === foreign) {
          fs.renameSync(from, `${foreign}.old`); fs.writeFileSync(foreign, 'foreign ref lock', { mode: 0o600 });
          throw new Error('synthetic lock replacement');
        }
        actualLink(from, to);
      });
      await assert.rejects(f.workspace.createBranch(plan, f.draft), { code: 'SYNTHETIC_COMPANY_CHANGE_LOCK_CLEANUP_FAILED' });
      mock.mock.restore();
      assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign ref lock');
      assert.equal(fs.existsSync(join(f.repository, '.git/HEAD.lock')), false);
      assert.equal(f.read('.git/HEAD'), 'ref: refs/heads/main\n');
      assert.equal(f.read('src/message.ts'), SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']);
    } finally { await lease.release(); }
  } finally { f.close(); }
});
