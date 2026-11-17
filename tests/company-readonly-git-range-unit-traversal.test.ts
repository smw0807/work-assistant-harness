import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import git from 'isomorphic-git';
import { createCompanyGitRangeUnitSource, type CompanyGitRangeUnitSource } from '../src/adapters/company-git-range-unit-source.js';
import { getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from '../src/policy/company-git-range-unit-budget.js';
import { createCompanyGitRangeFixture } from './company-readonly-git-range-fixture.js';

const author = { name: 'Synthetic Prefix Traversal', email: 'traversal@example.invalid', timestamp: 1704067200, timezoneOffset: 0 };
const createFixture = async (context: TestContext, selectedFiles: Record<string, string>) => {
  const fixture = await createCompanyGitRangeFixture(context, 'loose');
  for (const [path, body] of Object.entries(selectedFiles)) {
    fs.mkdirSync(dirname(join(fixture.root, path)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(fixture.root, path), body, { mode: 0o600 });
    await git.add({ fs, dir: fixture.root, filepath: path });
  }
  const baseCommit = await git.commit({ fs, dir: fixture.root, author, committer: author, message: 'Synthetic prefix traversal' });
  const commit = await git.readCommit({ fs, dir: fixture.root, oid: baseCommit });
  return { ...fixture, baseCommit, selectedFiles, selectedPaths: Object.keys(selectedFiles).sort(), rootTree: commit.commit.tree };
};
type Fixture = Awaited<ReturnType<typeof createFixture>>;
const input = (fixture: Fixture, selectedPaths = fixture.selectedPaths) => ({ version: 'company-git-range-source-v2',
  profileHash: getCompanyGitRangeUnitProfileHash(), guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(),
  sourceRoot: fixture.root, baseCommit: fixture.baseCommit, selectedPaths });
const objectPath = (fixture: Fixture, oid: string): string => join(fixture.root, '.git/objects', oid.slice(0, 2), oid.slice(2));
const released = (source: CompanyGitRangeUnitSource): void => {
  const state = source.snapshot();
  for (const key of ['liveMemoryBytes', 'cacheMemoryBytes', 'openDescriptors', 'pendingReads', 'pendingInflations', 'dependencyDepth'] as const) {
    assert.equal(state[key], 0, key);
  }
};
const failed = (source: CompanyGitRangeUnitSource, action = () => source.inspect()): void => {
  assert.throws(action, error => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.match(String(error.code), /^COMPANY_GIT_RANGE_[A-Z_]+$/u);
    assert.equal(error.message, error.code); return true;
  });
  assert.equal(source.snapshot().phase, 'failed'); released(source);
};
const treeAt = async (fixture: Fixture, parts: string[]): Promise<string> => {
  let oid = fixture.rootTree;
  for (const part of parts) {
    const tree = await git.readTree({ fs, dir: fixture.root, oid });
    const entry = tree.tree.find(item => item.path === part);
    assert.ok(entry); assert.equal(entry.type, 'tree'); oid = entry.oid;
  }
  return oid;
};
/** Encode only owned synthetic objects, including deliberately malformed payloads for rejection tests. */
const writeObject = (fixture: Fixture, type: 'tree' | 'commit', body: Buffer): string => {
  const wrapped = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
  const oid = createHash('sha1').update(wrapped).digest('hex'), path = objectPath(fixture, oid);
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path, deflateSync(wrapped), { mode: 0o600 }); return oid;
};
const replaceRoot = (fixture: Fixture, body: Buffer): Fixture => {
  const tree = writeObject(fixture, 'tree', body);
  const identity = 'Synthetic Prefix Traversal <traversal@example.invalid> 1704067200 +0000';
  const commit = writeObject(fixture, 'commit', Buffer.from(`tree ${tree}\nauthor ${identity}\ncommitter ${identity}\n\nSynthetic changed tree\n`));
  fs.writeFileSync(join(fixture.root, '.git/HEAD'), `${commit}\n`);
  return { ...fixture, baseCommit: commit, rootTree: tree };
};

test('shared tree prefixes are read once per fresh pass and release their bodies before descending', async context => {
  const selected = Object.fromEntries(Array.from({ length: 8 }, (_, index) =>
    [`src/batch/common/item-${index}.ts`, `export const item${index} = ${index};\n`]));
  const fixture = await createFixture(context, selected), before = fixture.snapshot();
  const trees = [fixture.rootTree, await treeAt(fixture, ['src']), await treeAt(fixture, ['src', 'batch']),
    await treeAt(fixture, ['src', 'batch', 'common'])];
  assert.equal(new Set(trees).size, 4);
  const paths = new Set(trees.map(oid => objectPath(fixture, oid))), opened = new Map<string, number>(), liveBeforeTree: number[] = [];
  const source = createCompanyGitRangeUnitSource(input(fixture), () => 0), original = fs.openSync;
  const mock = context.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: number, mode?: fs.Mode) => {
    if (typeof path === 'string' && paths.has(path)) {
      opened.set(path, (opened.get(path) ?? 0) + 1); liveBeforeTree.push(source.snapshot().liveMemoryBytes);
    }
    return original(path, flags, mode);
  }) as typeof fs.openSync);
  try {
    const first = source.inspect(), inspected = source.snapshot(); released(source);
    assert.deepEqual(first.selectedFiles.map(file => file.path), fixture.selectedPaths);
    for (const path of paths) assert.equal(opened.get(path), 1);
    assert.deepEqual(liveBeforeTree, [0, 0, 0, 0]);
    assert.equal(inspected.inflations, 13); // One commit, four prefix trees and eight independent selected blobs.
    assert.equal(inspected.peakCacheMemoryBytes, 0);
    const verified = source.verify(), completed = source.snapshot(); released(source);
    assert.deepEqual(verified, first); assert.equal(completed.completedPasses, 2);
    for (const path of paths) assert.equal(opened.get(path), 2);
    assert.deepEqual(liveBeforeTree, Array.from({ length: 8 }, () => 0));
    assert.equal(completed.inflations, 2 * inspected.inflations);
    assert.equal(completed.readCalls, 2 * inspected.readCalls);
    assert.equal(completed.readBytesReturned, 2 * inspected.readBytesReturned);
    assert.equal(completed.peakCacheMemoryBytes, 0);
    for (const body of Object.values(selected)) assert.equal(JSON.stringify(verified).includes(body.trim()), false);
  } finally { mock.mock.restore(); source.close(); }
  assert.equal(fixture.snapshot(), before);
});

test('prefix traversal preserves selected-file order when slash and dot names interleave', async context => {
  const fixture = await createFixture(context, { 'folder/a/one.ts': 'export const nested = 1;\n',
    'folder/a.ts': 'export const dotted = 2;\n', 'folder/a0.ts': 'export const numbered = 3;\n',
    'folder/z.ts': 'export const last = 4;\n' });
  const before = fixture.snapshot(), source = createCompanyGitRangeUnitSource(input(fixture, [...fixture.selectedPaths].reverse()), () => 0);
  try {
    const inspected = source.inspect(), verified = source.verify();
    assert.deepEqual(inspected.selectedFiles.map(file => file.path), fixture.selectedPaths);
    assert.deepEqual(verified, inspected); released(source);
  } finally { source.close(); }
  assert.equal(fixture.snapshot(), before);
});

test('different directory prefixes sharing one tree OID are independently read rather than cached by OID', async context => {
  const body = 'export const identical = 7;\n';
  const fixture = await createFixture(context, { 'left/item.ts': body, 'right/item.ts': body });
  const shared = await treeAt(fixture, ['left']); assert.equal(await treeAt(fixture, ['right']), shared);
  const path = objectPath(fixture, shared), source = createCompanyGitRangeUnitSource(input(fixture), () => 0);
  const original = fs.openSync; let reads = 0;
  const mock = context.mock.method(fs, 'openSync', ((opened: fs.PathLike, flags: number, mode?: fs.Mode) => {
    if (opened === path) reads++; return original(opened, flags, mode);
  }) as typeof fs.openSync);
  try {
    const first = source.inspect(); assert.equal(reads, 2);
    assert.equal(first.looseObjects.filter(object => object.oid === shared).length, 1);
    assert.deepEqual(source.verify(), first); assert.equal(reads, 4); released(source);
    assert.equal(source.snapshot().peakCacheMemoryBytes, 0);
  } finally { mock.mock.restore(); source.close(); }
});

test('file-directory prefix conflicts and missing children fail before any selected working-file read', async context => {
  for (const selected of [['src', 'src/main.ts'], ['src/main.ts', 'src/missing.ts']]) {
    const fixture = await createFixture(context, { 'other.ts': 'export const other = 1;\n' });
    const source = createCompanyGitRangeUnitSource(input(fixture, selected), () => 0), original = fs.openSync;
    let workingOpens = 0;
    const mock = context.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: number, mode?: fs.Mode) => {
      if (typeof path === 'string' && selected.some(item => path === join(fixture.root, item))) workingOpens++;
      return original(path, flags, mode);
    }) as typeof fs.openSync);
    try { failed(source); assert.equal(workingOpens, 0); }
    finally { mock.mock.restore(); source.close(); }
  }
});

test('selected symlink, gitlink and directory tree modes remain invalid leaves in a batch', async context => {
  for (const mode of ['120000', '160000', '40000']) {
    const fixture = await createFixture(context, { 'leaf.ts': 'export const leaf = 1;\n', 'other.ts': 'export const other = 2;\n' });
    const tree = await git.readTree({ fs, dir: fixture.root, oid: fixture.rootTree });
    const body = Buffer.concat(tree.tree.map(entry => Buffer.concat([
      Buffer.from(`${entry.path === 'leaf.ts' ? mode : entry.mode === '040000' ? '40000' : entry.mode} ${entry.path}\0`), Buffer.from(entry.oid, 'hex'),
    ])));
    const changed = replaceRoot(fixture, body), before = changed.snapshot();
    const source = createCompanyGitRangeUnitSource(input(changed), () => 0);
    try { failed(source); } finally { source.close(); }
    assert.equal(changed.snapshot(), before);
  }
});

test('a malformed unselected entry after requested names is still rejected by the complete tree parser', async context => {
  const fixture = await createFixture(context, { 'a.ts': 'export const first = 1;\n', 'b.ts': 'export const second = 2;\n' });
  const object = await git.readObject({ fs, dir: fixture.root, oid: fixture.rootTree, format: 'content' });
  const changed = replaceRoot(fixture, Buffer.concat([Buffer.from(object.object as Uint8Array), Buffer.from('100644 z-malformed\0')]));
  const before = changed.snapshot(), source = createCompanyGitRangeUnitSource(input(changed), () => 0);
  try { failed(source); } finally { source.close(); }
  assert.equal(changed.snapshot(), before);
});

test('a resolved ancestor changed before selected blob processing is rejected by the retained final guard', async context => {
  const fixture = await createFixture(context, { 'batch/a.ts': 'export const first = 1;\n', 'batch/b.ts': 'export const second = 2;\n' });
  const blob = await git.hashBlob({ object: fixture.selectedFiles['batch/a.ts']! });
  const treePath = objectPath(fixture, fixture.rootTree), blobPath = objectPath(fixture, blob.oid);
  const source = createCompanyGitRangeUnitSource(input(fixture), () => 0), original = fs.openSync;
  let changed = false, treeOpens = 0;
  const mock = context.mock.method(fs, 'openSync', ((path: fs.PathLike, flags: number, mode?: fs.Mode) => {
    if (path === treePath && typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) treeOpens++;
    if (path === blobPath && !changed) { changed = true; fs.appendFileSync(treePath, Buffer.from([0])); }
    return original(path, flags, mode);
  }) as typeof fs.openSync);
  try {
    failed(source); assert.equal(changed, true); assert.equal(treeOpens, 1);
    assert.equal(source.snapshot().completedPasses, 0);
  } finally { mock.mock.restore(); source.close(); }
});
