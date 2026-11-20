import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { CompanyChangeDraft } from '../src/domain/company-change.js';
import type { CompanyWriteRegistration } from '../src/domain/company-write.js';
import { CompanyWriteWorkspace, deriveCompanyWriteMutationPaths, inspectCompanyWriteSource } from '../src/adapters/company-write-workspace.js';
import { createSyntheticCompanyChangeWorkspace, SYNTHETIC_COMPANY_CHANGE_FILES } from '../src/adapters/synthetic-company-change-workspace.js';
import { hashCompanyWriteValue } from '../src/policy/company-write.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const fixture = async () => {
  const parent = fs.mkdtempSync('/private/tmp/harness-company-write-source-'), synthetic = await createSyntheticCompanyChangeWorkspace(parent);
  const root = synthetic.repositoryRoot;
  const draft: CompanyChangeDraft = { version: 'company-change-draft-v1', repoId: 'generic-synthetic', requestRevision: 1,
    objective: 'Apply declared synthetic source bytes', baseBranch: 'main', baseCommit: synthetic.baseCommit,
    baseIndexHash: synthetic.baseIndexHash, workType: 'feature', branch: 'feature/declared-source', changes: [
      { operation: 'replace', path: 'src/message.ts', beforeHash: hashCompanyWriteValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']!), content: "export const message = 'declared after';\n" },
      { operation: 'replace', path: 'src/options.ts', beforeHash: hashCompanyWriteValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']!), content: 'export const options = { enabled: true };\n' },
      { operation: 'create', path: 'src/created.ts', beforeHash: null, content: 'export const created = true;\n' },
    ] };
  const registration: CompanyWriteRegistration = { version: 'company-write-registration-v1', repoId: draft.repoId, sourceRoot: root,
    baseBranch: draft.baseBranch, baseCommit: draft.baseCommit, baseIndexHash: draft.baseIndexHash,
    writeAllowedFiles: draft.changes.map(change => change.path), enabled: true, localRead: 'allowed', localWrite: 'allowed' };
  const paths = deriveCompanyWriteMutationPaths(registration, draft, taskId);
  return { parent, root, registration, draft, paths,
    read: (path: string) => fs.readFileSync(join(root, path), 'utf8'),
    write: (path: string, value: string) => fs.writeFileSync(join(root, path), value, { mode: 0o600 }),
    close: () => fs.rmSync(parent, { recursive: true, force: true }) };
};
const prepared = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const source = await inspectCompanyWriteSource(f.registration, f.draft), workspace = new CompanyWriteWorkspace(f.registration, f.draft, taskId);
  await workspace.prepare(source); return { source, workspace };
};
const mainHead = 'ref: refs/heads/main\n';

test('exact source inspection reads selected files and the three declared Git files without scanning a repository', async t => {
  const f = await fixture();
  try {
    f.write('README.md', 'Unselected local work\n'); f.write('.env', 'synthetic canary never read\n');
    const allowed = new Set([f.paths.head, f.paths.index, f.paths.baseRef, ...f.paths.files.filter(file => file.path !== 'src/created.ts').map(file => file.target)]);
    const actualOpen = fs.openSync;
    const opened: string[] = [];
    const open = t.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (String(path).startsWith(`${f.root}/`)) { assert.ok(allowed.has(String(path))); opened.push(String(path)); }
      return actualOpen(path, flags, mode);
    }) as typeof fs.openSync);
    const readdir = t.mock.method(fs, 'readdirSync', (() => { throw new Error('repository enumeration forbidden'); }) as typeof fs.readdirSync);
    const opendir = t.mock.method(fs, 'opendirSync', (() => { throw new Error('repository enumeration forbidden'); }) as typeof fs.opendirSync);
    try {
      const source = await inspectCompanyWriteSource(f.registration, f.draft);
      assert.deepEqual(new Set(opened), allowed); assert.equal(source.indexHash, f.registration.baseIndexHash);
      assert.deepEqual(source.files.map(file => file.path), f.draft.changes.map(change => change.path));
      assert.deepEqual(source.files.at(-1), { path: 'src/created.ts', beforeHash: null, mode: null, identityHash: null,
        parentIdentityHash: source.files[0]!.parentIdentityHash });
      assert.equal(JSON.stringify(source).includes('Unselected local work'), false);
    } finally { open.mock.restore(); readdir.mock.restore(); opendir.mock.restore(); }
    assert.equal(f.read('.env'), 'synthetic canary never read\n'); assert.equal(f.read('.git/HEAD'), mainHead);
  } finally { f.close(); }
});

test('mutation paths are exact declared files, deterministic temporary files, cooperative locks and needed directory metadata', async () => {
  const f = await fixture();
  try {
    assert.ok(f.paths.writePaths.includes(f.paths.headLock)); assert.ok(f.paths.writePaths.includes(f.paths.indexLock));
    assert.ok(f.paths.writePaths.includes(f.paths.baseRefLock)); assert.ok(f.paths.writePaths.includes(f.paths.packedRefsLock));
    assert.equal(f.paths.branchTemporary, join(dirname(f.paths.branchRef), `.company-write-${taskId}-ref.tmp`));
    assert.equal(f.paths.files[0]!.temporary, join(f.root, 'src', `.company-write-${taskId}-0.tmp`));
    for (const path of [f.paths.index, f.paths.baseRef, join(f.root, 'README.md'), join(f.root, '.git/config')]) assert.equal(f.paths.writePaths.includes(path), false);
    for (const path of [join(f.root, 'README.md'), join(f.root, '.git/config'), join(f.root, '.env')]) assert.equal(f.paths.readPaths.includes(path), false);
    assert.ok(f.paths.metadataPaths.includes('/')); assert.ok(f.paths.metadataPaths.includes(join(f.root, '.git/packed-refs')));
    assert.equal(f.paths.readPaths.includes(f.root), false); assert.equal(f.paths.writePaths.includes(f.root), false);
    assert.throws(() => deriveCompanyWriteMutationPaths(f.registration, f.draft, '../bad'));
  } finally { f.close(); }
});

test('branch precedes every selected write while index, base ref, unselected bytes and file modes remain intact', async () => {
  const f = await fixture();
  try {
    fs.chmodSync(join(f.root, 'src/message.ts'), 0o640); f.write('README.md', 'Preserved unselected work\n');
    const beforeIndex = fs.readFileSync(f.paths.index), beforeBase = fs.readFileSync(f.paths.baseRef);
    const { workspace, source } = await prepared(f);
    try {
      assert.equal(source.files[0]!.mode, 0o640); assert.equal(f.read('.git/HEAD'), mainHead);
      assert.equal(fs.existsSync(f.paths.headLock), false);
      await assert.rejects(workspace.writeFile(0), { code: 'COMPANY_WRITE_INVALID_WRITE_ORDER' });
      await workspace.createBranch();
      assert.equal(f.read('.git/HEAD'), `ref: refs/heads/${f.draft.branch}\n`);
      assert.equal(f.read('src/message.ts'), SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']);
      for (const path of [f.paths.headLock, f.paths.indexLock, f.paths.baseRefLock, f.paths.packedRefsLock, f.paths.branchLock]) assert.equal(fs.existsSync(path), true);
      for (let index = 0; index < f.draft.changes.length; index++) await workspace.writeFile(index);
      await workspace.verifyApplied();
      for (const change of f.draft.changes) assert.equal(f.read(change.path), change.content);
      assert.equal(fs.statSync(join(f.root, 'src/message.ts')).mode & 0o777, 0o640);
      assert.equal(fs.statSync(join(f.root, 'src/created.ts')).mode & 0o777, 0o600);
      assert.equal(f.read('README.md'), 'Preserved unselected work\n');
      assert.deepEqual(fs.readFileSync(f.paths.index), beforeIndex); assert.deepEqual(fs.readFileSync(f.paths.baseRef), beforeBase);
    } finally { await workspace.close(); }
    for (const path of [f.paths.headLock, f.paths.indexLock, f.paths.baseRefLock, f.paths.packedRefsLock, f.paths.branchLock, f.paths.branchTemporary, ...f.paths.files.map(file => file.temporary)]) assert.equal(fs.existsSync(path), false);
    assert.equal(fs.existsSync(f.paths.branchRef), true); await workspace.close();
  } finally { f.close(); }
});

test('disabled registration, wrong allowlist and changed declarations fail before any source file opens', async t => {
  const f = await fixture();
  try {
    const actual = fs.openSync; let opens = 0;
    const mock = t.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => { opens++; return actual(path, flags, mode); }) as typeof fs.openSync);
    try {
      for (const registration of [{ ...f.registration, enabled: false }, { ...f.registration, localWrite: 'unconfirmed' },
        { ...f.registration, localRead: 'unconfirmed' }, { ...f.registration, writeAllowedFiles: ['README.md'] },
        { ...f.registration, baseCommit: '0'.repeat(40) }]) await assert.rejects(inspectCompanyWriteSource(registration, f.draft));
      assert.equal(opens, 0);
    } finally { mock.mock.restore(); }
  } finally { f.close(); }
});

test('selected current bytes are bound exactly and are not represented as a proof of Git cleanliness', async () => {
  const f = await fixture();
  try {
    f.write('src/message.ts', 'Explicitly selected existing local work\n');
    await assert.rejects(inspectCompanyWriteSource(f.registration, f.draft), { code: 'COMPANY_WRITE_BEFORE_MISMATCH' });
    f.draft.changes[0]!.beforeHash = hashCompanyWriteValue('Explicitly selected existing local work\n');
    const source = await inspectCompanyWriteSource(f.registration, f.draft);
    assert.equal(source.files[0]!.beforeHash, f.draft.changes[0]!.beforeHash);
    assert.equal(source.indexHash, f.registration.baseIndexHash);
  } finally { f.close(); }
});

test('symlink ancestors, selected symlinks, hardlinks, executable modes and missing parents are rejected without canary reads', async t => {
  for (const variant of ['root', 'file-link', 'hardlink', 'executable', 'missing-parent'] as const) {
    const f = await fixture();
    try {
      const canary = join(f.parent, 'canary'); fs.writeFileSync(canary, 'Synthetic outside canary', { mode: 0o600 });
      if (variant === 'root') { const root = f.root; fs.renameSync(root, `${root}.real`); fs.symlinkSync(`${root}.real`, root); }
      if (variant === 'file-link' || variant === 'hardlink') {
        fs.unlinkSync(join(f.root, 'src/message.ts'));
        if (variant === 'file-link') fs.symlinkSync(canary, join(f.root, 'src/message.ts')); else fs.linkSync(canary, join(f.root, 'src/message.ts'));
      }
      if (variant === 'executable') fs.chmodSync(join(f.root, 'src/message.ts'), 0o700);
      if (variant === 'missing-parent') { f.draft.changes[2]!.path = 'missing/created.ts'; f.registration.writeAllowedFiles[2] = 'missing/created.ts'; }
      const actual = fs.openSync; let canaryReads = 0;
      const mock = t.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        if (String(path) === canary || ['file-link', 'hardlink'].includes(variant) && String(path) === join(f.root, 'src/message.ts')) canaryReads++;
        return actual(path, flags, mode);
      }) as typeof fs.openSync);
      try { await assert.rejects(inspectCompanyWriteSource(f.registration, f.draft)); assert.equal(canaryReads, 0); }
      finally { mock.mock.restore(); }
    } finally { f.close(); }
  }
});

test('foreign Git locks and unsupported packed, merging, linked and submodule states are preserved and rejected', async () => {
  for (const path of ['.git/HEAD.lock', '.git/index.lock', '.git/refs/heads/main.lock', '.git/packed-refs.lock', '.git/packed-refs',
    '.git/MERGE_HEAD', '.git/commondir', '.git/worktrees', '.gitmodules', 'src/.git']) {
    const f = await fixture();
    try {
      f.write(path, 'Existing foreign state\n');
      await assert.rejects(inspectCompanyWriteSource(f.registration, f.draft));
      assert.equal(f.read(path), 'Existing foreign state\n'); assert.equal(f.read('.git/HEAD'), mainHead);
    } finally { f.close(); }
  }
});

test('HEAD, index and base-ref drift invalidate the source while an existing target branch is never overwritten', async () => {
  for (const variant of ['head', 'index', 'base', 'branch'] as const) {
    const f = await fixture();
    try {
      if (variant === 'head') f.write('.git/HEAD', `${f.registration.baseCommit}\n`);
      if (variant === 'index') fs.appendFileSync(f.paths.index, 'changed index');
      if (variant === 'base') f.write('.git/refs/heads/main', `${'0'.repeat(40)}\n`);
      if (variant === 'branch') { fs.mkdirSync(f.paths.branchDirectory, { mode: 0o700 }); fs.writeFileSync(f.paths.branchRef, 'existing branch', { mode: 0o600 }); }
      await assert.rejects(inspectCompanyWriteSource(f.registration, f.draft));
      if (variant === 'branch') assert.equal(fs.readFileSync(f.paths.branchRef, 'utf8'), 'existing branch');
      assert.equal(f.read('src/message.ts'), SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']);
    } finally { f.close(); }
  }
});

test('same-byte replacement and parent identity swaps after observation are rejected before branch mutation', async () => {
  for (const variant of ['file', 'parent'] as const) {
    const f = await fixture();
    try {
      const source = await inspectCompanyWriteSource(f.registration, f.draft);
      if (variant === 'file') { const path = join(f.root, 'src/message.ts'); fs.renameSync(path, `${path}.old`); f.write('src/message.ts', SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']!); }
      else { fs.renameSync(join(f.root, 'src'), join(f.root, 'src.old')); fs.mkdirSync(join(f.root, 'src'), { mode: 0o700 }); for (const path of ['src/message.ts', 'src/options.ts']) f.write(path, SYNTHETIC_COMPANY_CHANGE_FILES[path]!); }
      const workspace = new CompanyWriteWorkspace(f.registration, f.draft, taskId);
      try { await assert.rejects(workspace.prepare(source), { code: 'COMPANY_WRITE_SOURCE_CHANGED' }); }
      finally { await workspace.close(); }
      assert.equal(f.read('.git/HEAD'), mainHead); assert.equal(fs.existsSync(f.paths.headLock), false);
    } finally { f.close(); }
  }
});

test('drift after prepare and between file writes halts the sequence and preserves already applied work', async () => {
  const f = await fixture();
  try {
    const { workspace } = await prepared(f);
    try {
      await workspace.createBranch(); await workspace.writeFile(0);
      f.write('src/options.ts', 'Changed after first write\n');
      await assert.rejects(workspace.writeFile(1), { code: 'COMPANY_WRITE_SOURCE_CHANGED' });
      assert.equal(f.read('src/message.ts'), f.draft.changes[0]!.content); assert.equal(f.read('src/options.ts'), 'Changed after first write\n');
      assert.equal(f.read('.git/HEAD'), `ref: refs/heads/${f.draft.branch}\n`);
      await assert.rejects(workspace.writeFile(1), { code: 'COMPANY_WRITE_INVALID_STATE' });
    } finally { await workspace.close(); }
  } finally { f.close(); }
});

test('temporary collisions are rejected before writes and injected second-file failures never roll back the first file', async t => {
  const f = await fixture();
  try {
    const source = await inspectCompanyWriteSource(f.registration, f.draft);
    fs.writeFileSync(f.paths.files[0]!.temporary, 'Existing user temporary file', { mode: 0o600 });
    const rejected = new CompanyWriteWorkspace(f.registration, f.draft, taskId);
    await assert.rejects(rejected.prepare(source), { code: 'COMPANY_WRITE_TEMPORARY_CONFLICT' }); await rejected.close();
    assert.equal(fs.readFileSync(f.paths.files[0]!.temporary, 'utf8'), 'Existing user temporary file');
    fs.unlinkSync(f.paths.files[0]!.temporary);
    const { workspace } = await prepared(f);
    try {
      await workspace.createBranch(); await workspace.writeFile(0);
      const actual = fs.renameSync;
      const mock = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === f.paths.files[1]!.target) throw new Error('synthetic publication failure'); actual(from, to);
      });
      try { await assert.rejects(workspace.writeFile(1)); } finally { mock.mock.restore(); }
      assert.equal(f.read('src/message.ts'), f.draft.changes[0]!.content); assert.equal(f.read('src/options.ts'), SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']);
      assert.equal(fs.existsSync(f.paths.branchRef), true); assert.equal(f.read('.git/refs/heads/main'), `${f.registration.baseCommit}\n`);
    } finally { await workspace.close(); }
    assert.equal(fs.existsSync(f.paths.files[1]!.temporary), false);
  } finally { f.close(); }
});

test('close preserves a replaced foreign lock and still releases independently owned locks', async () => {
  const f = await fixture();
  try {
    const { workspace } = await prepared(f); await workspace.createBranch();
    fs.renameSync(f.paths.branchLock, `${f.paths.branchLock}.old`); fs.writeFileSync(f.paths.branchLock, 'Foreign replacement lock', { mode: 0o600 });
    await assert.rejects(workspace.close(), { code: 'COMPANY_WRITE_CLEANUP_FAILED' });
    assert.equal(fs.readFileSync(f.paths.branchLock, 'utf8'), 'Foreign replacement lock');
    for (const path of [f.paths.headLock, f.paths.indexLock, f.paths.baseRefLock, f.paths.packedRefsLock]) assert.equal(fs.existsSync(path), false);
    assert.equal(f.read('.git/HEAD'), `ref: refs/heads/${f.draft.branch}\n`); assert.equal(fs.existsSync(f.paths.branchRef), true);
  } finally { f.close(); }
});

test('cooperating mutation instances cannot acquire a second branch lifecycle while the first holds its Git locks', async () => {
  const f = await fixture();
  try {
    const source = await inspectCompanyWriteSource(f.registration, f.draft);
    const first = new CompanyWriteWorkspace(f.registration, f.draft, taskId);
    const second = new CompanyWriteWorkspace(f.registration, f.draft, '22222222-2222-4222-8222-222222222222');
    await first.prepare(source); await second.prepare(source);
    try {
      await first.createBranch();
      await assert.rejects(second.createBranch(), { code: 'COMPANY_WRITE_GIT_BUSY' });
      await second.close();
      for (let index = 0; index < f.draft.changes.length; index++) await first.writeFile(index);
      await first.verifyApplied();
    } finally { await second.close(); await first.close(); }
  } finally { f.close(); }
});

test('selected bytes and index size are bounded before a source or mutation is accepted', async () => {
  for (const variant of ['selected', 'index', 'total'] as const) {
    const f = await fixture();
    try {
      if (variant === 'selected') f.write('src/message.ts', 'x'.repeat(65_537));
      if (variant === 'index') fs.writeFileSync(f.paths.index, Buffer.alloc(1_048_577));
      if (variant === 'total') {
        for (const path of ['src/message.ts', 'src/options.ts', 'src/created.ts']) f.write(path, 'x'.repeat(50_000));
        f.draft.changes[2]!.operation = 'replace'; f.draft.changes[2]!.beforeHash = hashCompanyWriteValue('x'.repeat(50_000));
      }
      await assert.rejects(inspectCompanyWriteSource(f.registration, f.draft));
      assert.equal(fs.existsSync(f.paths.headLock), false); assert.equal(f.read('.git/HEAD'), mainHead);
    } finally { f.close(); }
  }
});
