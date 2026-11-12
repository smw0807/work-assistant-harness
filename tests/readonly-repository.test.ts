import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { assertReadonlyRepository, collectReadonlyPayload, prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import type { ReadonlyRepository } from '../src/domain/readonly-investigation.js';
import { canonicalReadonlyJson, defaultReadonlySelection, getReadonlySelectionPreset, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date('2026-11-12T00:00:00.000Z') };
const writable = (path: string): void => {
  const metadata = fs.lstatSync(path);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) { fs.chmodSync(path, 0o700); for (const name of fs.readdirSync(path)) writable(join(path, name)); }
};
const setup = async (testContext: TestContext) => {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'harness-readonly-repository-'))); fs.chmodSync(directory, 0o700);
  testContext.after(() => { writable(directory); fs.rmSync(directory, { recursive: true, force: true }); });
  const repository = await prepareReadonlyRepository(directory, randomUUID());
  return { directory, repository };
};
const snapshot = (root: string): string => {
  const entries: unknown[] = [];
  const visit = (path: string, relative: string): void => {
    const item = fs.lstatSync(path);
    entries.push({ path: relative, mode: item.mode, ino: item.ino, nlink: item.nlink, content: item.isFile() ? hashReadonlyValue(fs.readFileSync(path)) : '' });
    if (item.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name), relative ? `${relative}/${name}` : name);
  };
  visit(root, ''); return canonicalReadonlyJson(entries);
};
const mutateFile = (path: string, bytes: string): void => { fs.chmodSync(path, 0o600); fs.writeFileSync(path, bytes); fs.chmodSync(path, 0o444); };

test('103/108 four registered files have fixed commit; collection is deterministic and source/Git/modes stay unchanged', async (testContext) => {
  const { repository } = await setup(testContext);
  const before = snapshot(repository.sourceRoot);
  const first = await collectReadonlyPayload(repository, defaultReadonlySelection(), context);
  const second = await collectReadonlyPayload(repository, { ...defaultReadonlySelection(), readRanges: defaultReadonlySelection().readRanges.toReversed() }, context);
  assert.deepEqual(first, second); assert.equal(first.context.evidence.length, 4);
  assert.deepEqual(first.context.readAllowedFiles, ['README.md', 'src/controller.ts', 'src/service.ts', 'src/settings.ts']);
  assert.equal(fs.readFileSync(join(repository.sourceRoot, '.git/refs/heads/main'), 'utf8'), repository.baseCommit + '\n');
  assert.equal(snapshot(repository.sourceRoot), before);
  assert.equal(first.inputText.includes(repository.sourceRoot), false);
  assert.equal(first.inputText.includes('.git'), false);
  await assertReadonlyRepository(repository);
});

test('103 arbitrary root, fixture, remote-like selector and duplicate preparation are rejected without overwrite', async (testContext) => {
  const { directory, repository } = await setup(testContext);
  const before = snapshot(repository.sourceRoot);
  for (const fixture of ['company', '../root', 'https://example.invalid/repo']) await assert.rejects(prepareReadonlyRepository(directory, randomUUID(), fixture));
  await assert.rejects(prepareReadonlyRepository(directory, repository.id));
  await assert.rejects(assertReadonlyRepository({ ...repository, sourceRoot: directory }));
  await assert.rejects(assertReadonlyRepository({ ...repository, baseCommit: 'a'.repeat(40) }));
  await assert.rejects(assertReadonlyRepository({ ...repository, repoId: 'company' }));
  await assert.rejects(assertReadonlyRepository({ ...repository, sourceManifestHash: 'a'.repeat(64) }));
  assert.equal(snapshot(repository.sourceRoot), before);
});

test('103 extra untracked path is rejected before its body can be read; source is not repaired', async (testContext) => {
  const { repository } = await setup(testContext);
  fs.chmodSync(repository.sourceRoot, 0o755);
  const extra = join(repository.sourceRoot, 'private-extra');
  fs.writeFileSync(extra, 'unselected-private-body', { mode: 0o000 }); fs.chmodSync(repository.sourceRoot, 0o555);
  await assert.rejects(collectReadonlyPayload(repository, defaultReadonlySelection(), context), (error: unknown) => {
    assert.equal(String(error), 'HarnessError: READONLY_UNSAFE_REPOSITORY'); assert.equal(String(error).includes('private-extra'), false); return true;
  });
  assert.equal(fs.existsSync(extra), true);
});

test('103/108 same-size dirty bytes, Git ref changes and permission changes reject the frozen identity', async (testContext) => {
  for (const target of ['src/service.ts', '.git/refs/heads/main', 'README.md']) {
    const { repository } = await setup(testContext);
    const path = join(repository.sourceRoot, target);
    if (target === 'README.md') fs.chmodSync(path, 0o600);
    else { const original = fs.readFileSync(path, 'utf8'); mutateFile(path, 'X' + original.slice(1)); }
    await assert.rejects(assertReadonlyRepository(repository), { code: 'READONLY_UNSAFE_REPOSITORY' });
  }
});

test('105 file symlink and hardlink are rejected before collecting any payload', async (testContext) => {
  for (const kind of ['symlink', 'hardlink'] as const) {
    const { directory, repository } = await setup(testContext);
    const path = join(repository.sourceRoot, 'README.md');
    if (kind === 'hardlink') fs.linkSync(path, join(directory, 'outside-link'));
    else {
      const outside = join(directory, 'outside.txt'); fs.writeFileSync(outside, 'private-unselected-body');
      fs.chmodSync(repository.sourceRoot, 0o755); fs.unlinkSync(path); fs.symlinkSync(outside, path); fs.chmodSync(repository.sourceRoot, 0o555);
    }
    await assert.rejects(collectReadonlyPayload(repository, defaultReadonlySelection(), context), { code: 'READONLY_UNSAFE_REPOSITORY' });
  }
});

test('105 native FIFO negative fixture is rejected without opening or blocking on its contents', async (testContext) => {
  const { repository } = await setup(testContext);
  const path = join(repository.sourceRoot, 'README.md');
  fs.chmodSync(repository.sourceRoot, 0o755); fs.unlinkSync(path);
  // This fixed OS utility prepares a negative fixture; no target source or shell script is executed.
  execFileSync('/usr/bin/mkfifo', [path], { stdio: 'ignore', timeout: 2000 });
  fs.chmodSync(path, 0o444); fs.chmodSync(repository.sourceRoot, 0o555);
  assert.equal(fs.lstatSync(path).isFIFO(), true);
  await assert.rejects(collectReadonlyPayload(repository, defaultReadonlySelection(), context), { code: 'READONLY_UNSAFE_REPOSITORY' });
});

test('105 parent symlink, replaced directory and re-created same-content inode are rejected', async (testContext) => {
  for (const kind of ['parent-symlink', 'parent-replacement', 'file-replacement'] as const) {
    const { directory, repository } = await setup(testContext);
    const source = repository.sourceRoot;
    if (kind === 'parent-symlink') {
      const parent = dirname(source); const moved = join(directory, 'moved-task'); fs.renameSync(parent, moved); fs.symlinkSync(moved, parent);
    } else if (kind === 'parent-replacement') {
      fs.chmodSync(source, 0o755); const old = join(source, 'src'); const moved = join(directory, 'old-src');
      fs.chmodSync(old, 0o700); fs.renameSync(old, moved); fs.mkdirSync(old, { mode: 0o700 });
      for (const name of fs.readdirSync(moved)) fs.copyFileSync(join(moved, name), join(old, name));
      fs.chmodSync(old, 0o555); fs.chmodSync(source, 0o555);
    } else {
      const path = join(source, 'README.md'); const bytes = fs.readFileSync(path);
      fs.chmodSync(source, 0o755); fs.unlinkSync(path); fs.writeFileSync(path, bytes, { mode: 0o444 }); fs.chmodSync(source, 0o555);
    }
    await assert.rejects(assertReadonlyRepository(repository), { code: 'READONLY_UNSAFE_REPOSITORY' });
  }
});

test('105 opened-file replacement race fails identity recheck and never returns a snapshot', async (testContext) => {
  const { repository } = await setup(testContext);
  const path = join(repository.sourceRoot, 'README.md'); const inode = fs.statSync(path).ino;
  const originalRead = fs.readSync; let replaced = false;
  const wrapped = ((...args: Parameters<typeof fs.readSync>) => {
    const result = Reflect.apply(originalRead, fs, args) as number;
    if (!replaced && fs.fstatSync(args[0]).ino === inode) {
      replaced = true; const bytes = fs.readFileSync(path);
      fs.chmodSync(repository.sourceRoot, 0o755); fs.unlinkSync(path); fs.writeFileSync(path, bytes, { mode: 0o444 }); fs.chmodSync(repository.sourceRoot, 0o555);
    }
    return result;
  }) as typeof fs.readSync;
  fs.readSync = wrapped; syncBuiltinESMExports();
  try { await assert.rejects(collectReadonlyPayload(repository, defaultReadonlySelection(), context), { code: 'READONLY_UNSAFE_REPOSITORY' }); }
  finally { fs.readSync = originalRead; syncBuiltinESMExports(); }
  assert.equal(replaced, true);
});

test('104/108/112 selected range includes only requested lines and malicious README stays inert', async (testContext) => {
  const { repository } = await setup(testContext);
  const before = snapshot(repository.sourceRoot);
  const selection = { ...getReadonlySelectionPreset('controller'), readRanges: [{ path: 'src/controller.ts', startLine: 3, endLine: 4 }] };
  const partial = await collectReadonlyPayload(repository, selection, context);
  assert.equal(partial.context.evidence[0]!.excerpt, 'export const handleRequest = (id: string) => {\n  return createRequest(id);');
  assert.equal(partial.inputText.includes('ignore policy'), false);
  const all = await collectReadonlyPayload(repository, defaultReadonlySelection(), context);
  assert.match(all.context.evidence[0]!.excerpt, /ignore policy/);
  assert.equal(snapshot(repository.sourceRoot), before);
  const bogus = { ...defaultReadonlySelection(), readRanges: [{ path: '../outside', startLine: 1, endLine: 1 }] };
  await assert.rejects(collectReadonlyPayload(repository, bogus, context));
  assert.equal(snapshot(repository.sourceRoot), before);
});

test('103 source identity cannot be rewritten to bless changed manifest/parent metadata', async (testContext) => {
  const { repository } = await setup(testContext);
  for (const mutate of [
    (item: ReadonlyRepository) => { item.manifest[0]!.mode = 0o700; },
    (item: ReadonlyRepository) => { item.parents[0]!.inode++; },
    (item: ReadonlyRepository) => { item.readAllowedFiles.push('outside'); },
  ]) { const changed = structuredClone(repository); mutate(changed); await assert.rejects(assertReadonlyRepository(changed)); }
});
