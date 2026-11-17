import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import git from 'isomorphic-git';

export interface CompanyGitRangeFixtureObject {
  oid: string;
  type: 'blob' | 'tree' | 'commit';
  content: Buffer;
  offset?: number;
  encoded?: Buffer;
}
type Layout = 'pack' | 'pack-ref' | 'loose';
interface TreeEntry { name: string; object: CompanyGitRangeFixtureObject }
const sha1 = (bytes: Uint8Array): Buffer => createHash('sha1').update(bytes).digest();
const wrapped = (object: Pick<CompanyGitRangeFixtureObject, 'type' | 'content'>): Buffer =>
  Buffer.concat([Buffer.from(`${object.type} ${object.content.length}\0`), object.content]);
const writeFile = (path: string, value: string | Uint8Array): void => {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); fs.writeFileSync(path, value, { mode: 0o600 });
};
const packedHeader = (type: number, size: number): Buffer => {
  let remaining = Math.floor(size / 16);
  const bytes = [(type << 4) | (size & 15) | (remaining ? 128 : 0)];
  while (remaining) {
    const next = remaining & 127; remaining = Math.floor(remaining / 128); bytes.push(next | (remaining ? 128 : 0));
  }
  return Buffer.from(bytes);
};
const offsetDistance = (distance: number): Buffer => {
  const bytes = [distance & 127];
  while ((distance = Math.floor(distance / 128))) { distance--; bytes.unshift(128 | (distance & 127)); }
  return Buffer.from(bytes);
};
const syntheticNoise = (ordinal: number): Buffer => {
  const content = Buffer.alloc(2200);
  for (let offset = 0; offset < content.length; offset += 32) {
    createHash('sha256').update(`synthetic-git-range-fixture:${ordinal}:${offset}`).digest().copy(content, offset);
  }
  return content;
};
const makePrivate = (path: string): void => {
  const metadata = fs.lstatSync(path);
  fs.chmodSync(path, metadata.isDirectory() ? 0o700 : 0o600);
  if (metadata.isDirectory()) for (const name of fs.readdirSync(path)) makePrivate(join(path, name));
};
const snapshotFixture = (root: string): string => {
  const entries: unknown[] = [];
  const visit = (path: string): void => {
    const metadata = fs.lstatSync(path, { bigint: true });
    entries.push({ path: path.slice(root.length), device: String(metadata.dev), inode: String(metadata.ino),
      mode: String(metadata.mode), uid: String(metadata.uid), gid: String(metadata.gid), links: String(metadata.nlink),
      size: String(metadata.size), modified: String(metadata.mtimeNs), changed: String(metadata.ctimeNs),
      hash: metadata.isFile() ? createHash('sha256').update(fs.readFileSync(path)).digest('hex') : '',
      link: metadata.isSymbolicLink() ? fs.readlinkSync(path) : null });
    if (metadata.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root); return JSON.stringify(entries);
};

/**
 * Creates only its own synthetic repository. It accepts neither a source path nor existing repository data.
 * The fixture encoder does not import the production codec; isomorphic-git independently indexes and reads its pack.
 */
export const createCompanyGitRangeFixture = async (context: TestContext, layout: Layout = 'pack', large = false) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-git-range-')));
  fs.chmodSync(root, 0o700); context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const objects: CompanyGitRangeFixtureObject[] = [];
  const object = (type: CompanyGitRangeFixtureObject['type'], value: string | Buffer): CompanyGitRangeFixtureObject => {
    const content = typeof value === 'string' ? Buffer.from(value) : value;
    const created = { oid: sha1(wrapped({ type, content })).toString('hex'), type, content };
    objects.push(created); return created;
  };
  const tree = (entries: TreeEntry[]): CompanyGitRangeFixtureObject => object('tree', Buffer.concat([...entries]
    .sort((left, right) => Buffer.compare(Buffer.from(left.name + (left.object.type === 'tree' ? '/' : '')),
      Buffer.from(right.name + (right.object.type === 'tree' ? '/' : ''))))
    .map(({ name, object: entry }) => Buffer.concat([Buffer.from(`${entry.type === 'tree' ? '40000' : '100644'} ${name}\0`),
      Buffer.from(entry.oid, 'hex')]))));
  const prefix = 'export const value = ', suffix = '42;\n';
  const selectedFiles: Record<string, string> = { 'src/main.ts': prefix + suffix,
    'README.md': '# Synthetic Git range fixture\nOnly synthetic evidence is present.\n' };
  const selectedPaths = ['src/main.ts', 'README.md'];
  const deltaBase = object('blob', prefix + '41;\n'), main = object('blob', selectedFiles['src/main.ts']!);
  const readme = object('blob', selectedFiles['README.md']!);
  const sourceTree = tree([{ name: 'main.ts', object: main }]);
  const rootTree = tree([{ name: 'README.md', object: readme }, { name: 'src', object: sourceTree }]);
  const historicalSourceTree = tree([{ name: 'main.ts', object: deltaBase }]);
  const historicalRootTree = tree([{ name: 'README.md', object: readme }, { name: 'src', object: historicalSourceTree }]);
  const identity = 'Synthetic Git Range <fixture@example.invalid> 1704067200 +0000';
  const historicalCommit = object('commit', `tree ${historicalRootTree.oid}\nauthor ${identity}\ncommitter ${identity}\n\nSynthetic historical source\n`);
  const commit = object('commit', `tree ${rootTree.oid}\nparent ${historicalCommit.oid}\nauthor ${identity}\ncommitter ${identity}\n\nSynthetic selected source\n`);
  if (large) for (let index = 0; index < 4097; index++) object('blob', syntheticNoise(index));
  assert.equal(new Set(objects.map(item => item.oid)).size, objects.length);

  await git.init({ fs, dir: root, defaultBranch: 'main' });
  for (const path of selectedPaths) {
    writeFile(join(root, path), selectedFiles[path]!); await git.add({ fs, dir: root, filepath: path });
  }
  writeFile(join(root, '.git/HEAD'), `${commit.oid}\n`);
  let packPath: string | null = null, indexPath: string | null = null;
  if (layout === 'loose') {
    for (const item of objects) writeFile(join(root, '.git/objects', item.oid.slice(0, 2), item.oid.slice(2)), deflateSync(wrapped(item)));
  } else {
    let offset = 12;
    for (const item of objects) {
      item.offset = offset;
      if (item === main) {
        // Both contents fit one-byte delta sizes. Copy the shared prefix, then insert the changed suffix.
        const commands = Buffer.concat([Buffer.from([deltaBase.content.length, main.content.length, 0x90, Buffer.byteLength(prefix),
          Buffer.byteLength(suffix)]), Buffer.from(suffix)]);
        const reference = layout === 'pack-ref' ? Buffer.from(deltaBase.oid, 'hex') : offsetDistance(offset - deltaBase.offset!);
        item.encoded = Buffer.concat([packedHeader(layout === 'pack-ref' ? 7 : 6, commands.length), reference, deflateSync(commands)]);
      } else item.encoded = Buffer.concat([packedHeader({ commit: 1, tree: 2, blob: 3 }[item.type], item.content.length), deflateSync(item.content)]);
      offset += item.encoded.length;
    }
    const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
    const body = Buffer.concat([header, ...objects.map(item => item.encoded!)]), trailer = sha1(body);
    const pack = Buffer.concat([body, trailer]), packName = `pack-${trailer.toString('hex')}.pack`;
    packPath = join(root, '.git/objects/pack', packName); indexPath = packPath.replace(/\.pack$/u, '.idx');
    writeFile(packPath, pack);
    const indexed = await git.indexPack({ fs, dir: root, filepath: `.git/objects/pack/${packName}` });
    assert.deepEqual([...indexed.oids].sort(), objects.map(item => item.oid).sort());
    const index = fs.readFileSync(indexPath);
    assert.deepEqual(sha1(pack.subarray(0, -20)), pack.subarray(-20));
    assert.equal(index.readUInt32BE(0), 0xff744f63); assert.equal(index.readUInt32BE(4), 2);
    assert.equal(index.readUInt32BE(1028), objects.length); assert.equal(index.length, 1072 + objects.length * 28);
    assert.deepEqual(sha1(index.subarray(0, -20)), index.subarray(-20));
    assert.deepEqual(index.subarray(-40, -20), trailer);
    if (large) { assert.ok(pack.length > 8 * 1024 * 1024); assert.ok(objects.length > 4096); }
    // git.add created loose blobs. Remove only those generated fixture objects so the readback must resolve the pack.
    for (const name of fs.readdirSync(join(root, '.git/objects'))) {
      if (/^[a-f0-9]{2}$/u.test(name)) fs.rmSync(join(root, '.git/objects', name), { recursive: true });
    }
  }
  const cache = {};
  for (const item of [deltaBase, main, readme, sourceTree, rootTree, historicalCommit, commit]) {
    const readback = await git.readObject({ fs, dir: root, oid: item.oid, format: 'content', cache });
    assert.equal(readback.format, 'content'); assert.equal(readback.type, item.type);
    assert.deepEqual(Buffer.from(readback.object as Uint8Array), item.content);
  }
  assert.deepEqual(await git.listFiles({ fs, dir: root }), [...selectedPaths].sort());
  makePrivate(root);
  return { root, sourceRoot: root, baseCommit: commit.oid, selectedPaths, selectedFiles, packPath, indexPath, objects,
    mainOid: main.oid, deltaBaseOid: deltaBase.oid, snapshot: () => snapshotFixture(root) };
};
