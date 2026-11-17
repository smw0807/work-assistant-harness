import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import git from 'isomorphic-git';

const packCount = 4, objectsPerPack = 23_000, deltaDepth = 7;
type ObjectType = 'blob' | 'tree' | 'commit';
interface FixtureObject { oid: Buffer; type: ObjectType; content: Buffer; pack: number; base?: FixtureObject }
interface PackEntry { oid: Buffer; offset: number; crc: number }
interface TreeEntry { name: string; object: FixtureObject }
const sha1 = (bytes: Uint8Array): Buffer => createHash('sha1').update(bytes).digest();
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const writeFile = (path: string, bytes: string | Uint8Array): void => {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path, bytes, { mode: 0o600 });
};

// All fixture encoders are independent of the production Git index, object, delta and proof codecs.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
};
const packedHeader = (type: number, size: number): Buffer => {
  let remaining = Math.floor(size / 16);
  const bytes = [(type << 4) | (size & 15) | (remaining ? 128 : 0)];
  while (remaining) {
    const next = remaining & 127; remaining = Math.floor(remaining / 128);
    bytes.push(next | (remaining ? 128 : 0));
  }
  return Buffer.from(bytes);
};
const offsetDistance = (distance: number): Buffer => {
  assert.ok(Number.isSafeInteger(distance) && distance > 0);
  const bytes = [distance & 127];
  while ((distance = Math.floor(distance / 128))) { distance--; bytes.unshift(128 | (distance & 127)); }
  return Buffer.from(bytes);
};
const indexBytesFor = (entries: PackEntry[], checksum: Buffer): Buffer => {
  const sorted = [...entries].sort((left, right) => Buffer.compare(left.oid, right.oid));
  const bytes = Buffer.alloc(1072 + entries.length * 28), fanout = new Uint32Array(256);
  bytes.writeUInt32BE(0xff744f63, 0); bytes.writeUInt32BE(2, 4);
  for (const entry of sorted) fanout[entry.oid[0]!] = fanout[entry.oid[0]!]! + 1;
  let cumulative = 0;
  for (let prefix = 0; prefix < 256; prefix++) {
    cumulative += fanout[prefix]!; bytes.writeUInt32BE(cumulative, 8 + prefix * 4);
  }
  sorted.forEach((entry, position) => {
    if (position) assert.ok(Buffer.compare(sorted[position - 1]!.oid, entry.oid) < 0);
    entry.oid.copy(bytes, 1032 + position * 20);
    bytes.writeUInt32BE(entry.crc, 1032 + entries.length * 20 + position * 4);
    bytes.writeUInt32BE(entry.offset, 1032 + entries.length * 24 + position * 4);
  });
  checksum.copy(bytes, bytes.length - 40); sha1(bytes.subarray(0, -20)).copy(bytes, bytes.length - 20);
  return bytes;
};
const workingIndex = (selectedPaths: string[], selected: Record<string, FixtureObject>): Buffer => {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(selectedPaths.length, 8);
  const entries = selectedPaths.map(path => {
    const object = selected[path]!, name = Buffer.from(path), entry = Buffer.alloc(Math.ceil((62 + name.length + 1) / 8) * 8);
    entry.writeUInt32BE(0o100644, 24); entry.writeUInt32BE(object.content.length, 36);
    object.oid.copy(entry, 40); entry.writeUInt16BE(name.length, 60); name.copy(entry, 62);
    return entry;
  });
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, sha1(body)]);
};
const snapshotFixture = (root: string): string => {
  const entries: unknown[] = [];
  const visit = (path: string): void => {
    const value = fs.lstatSync(path, { bigint: true });
    entries.push({ path: relative(root, path), device: String(value.dev), inode: String(value.ino), mode: String(value.mode),
      uid: String(value.uid), gid: String(value.gid), links: String(value.nlink), size: String(value.size),
      modified: String(value.mtimeNs), changed: String(value.ctimeNs),
      sha256: value.isFile() ? sha256(fs.readFileSync(path)) : null });
    if (value.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root); return JSON.stringify(entries);
};

/**
 * Creates only independent synthetic bytes: four packs, eight selected leaves and seven tree nodes.
 * The selected delta chain contains seven objects including its full base. No source repository is accepted.
 */
export const createCompanyUnitMultifileFixture = async (context: TestContext, { depth = 0 }: { depth?: number } = {}) => {
  assert.ok(Number.isSafeInteger(depth) && depth >= 0 && depth <= 6);
  // A fixed POSIX temporary anchor makes metadata cost independent of the runner's nested TMPDIR.
  // Each fixture still owns a fresh private directory; depth explicitly controls additional ancestors.
  const parent = fs.realpathSync(fs.mkdtempSync(join(fs.realpathSync('/tmp'), 'company-unit-multifile-')));
  fs.chmodSync(parent, 0o700); context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, ...Array.from({ length: depth }, (_, index) => `depth-${index}`), 'repository');
  const directory = join(root, '.git/objects/pack');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(root, '.git/objects/info'), { mode: 0o700 });
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const objects: FixtureObject[] = [];
  const object = (type: ObjectType, content: Buffer, pack: number, base?: FixtureObject): FixtureObject => {
    const oid = createHash('sha1').update(`${type} ${content.length}\0`).update(content).digest();
    const result: FixtureObject = { oid, type, content, pack, ...(base ? { base } : {}) };
    objects.push(result); return result;
  };
  const tree = (entries: TreeEntry[], pack: number): FixtureObject => object('tree', Buffer.concat([...entries]
    .sort((left, right) => Buffer.compare(Buffer.from(left.name + (left.object.type === 'tree' ? '/' : '')),
      Buffer.from(right.name + (right.object.type === 'tree' ? '/' : ''))))
    .map(({ name, object: item }) => Buffer.concat([Buffer.from(`${item.type === 'tree' ? '40000' : '100644'} ${name}\0`), item.oid]))), pack);
  const deltaPrefix = 'export const fixtureValue = ';
  let delta: FixtureObject | undefined;
  for (let revision = 0; revision < deltaDepth; revision++) {
    delta = object('blob', Buffer.from(`${deltaPrefix}${revision};\n`), 0, delta);
  }
  assert.ok(delta);
  const selectedDelta = delta;
  const selected: Record<string, FixtureObject> = {};
  const groups = ['alpha', 'beta', 'delta', 'gamma'];
  const subtrees = groups.map((group, groupIndex) => {
    const entries = ['first.ts', 'second.ts'].map((name, fileIndex) => {
      const ordinal = groupIndex * 2 + fileIndex;
      const path = `src/features/${group}/${name}`;
      const item = ordinal === 0 ? selectedDelta : object('blob', Buffer.from(`export const synthetic${ordinal} = ${100 + ordinal};\n`), 1 + (ordinal - 1) % 3);
      selected[path] = item; return { name, object: item };
    });
    return { name: group, object: tree(entries, groupIndex % packCount) };
  });
  const features = tree(subtrees, 1), source = tree([{ name: 'features', object: features }], 2);
  const rootTree = tree([{ name: 'src', object: source }], 3);
  const identity = 'Synthetic Multifile Fixture <fixture@example.invalid> 1704067200 +0000';
  const commit = object('commit', Buffer.from(`tree ${rootTree.oid.toString('hex')}\nauthor ${identity}\ncommitter ${identity}\n\nSynthetic shared-tree traversal\n`), 3);
  assert.equal(objects.length, 22); assert.equal(new Set(objects.map(item => item.oid.toString('hex'))).size, objects.length);
  const samples = [...objects], packPaths: string[] = [], indexPaths: string[] = [];
  let indexBytes = 0, packBytes = 0;
  for (let pack = 0; pack < packCount; pack++) {
    const temporary = join(directory, `synthetic-${pack}.pack.tmp`), entries: PackEntry[] = [];
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const digest = createHash('sha1'), offsets = new Map<FixtureObject, number>();
    let offset = 12, checksum: Buffer;
    const append = (bytes: Buffer): void => { assert.equal(fs.writeSync(descriptor, bytes), bytes.length); digest.update(bytes); };
    const add = (item: FixtureObject): void => {
      let encoded: Buffer;
      if (item.base) {
        assert.equal(item.base.pack, pack); assert.ok(offsets.has(item.base));
        const suffix = item.content.subarray(Buffer.byteLength(deltaPrefix));
        assert.ok(item.base.content.length < 128 && item.content.length < 128 && suffix.length < 128);
        const commands = Buffer.concat([Buffer.from([item.base.content.length, item.content.length, 0x90,
          Buffer.byteLength(deltaPrefix), suffix.length]), suffix]);
        encoded = Buffer.concat([packedHeader(6, commands.length), offsetDistance(offset - offsets.get(item.base)!), deflateSync(commands)]);
      } else encoded = Buffer.concat([packedHeader({ commit: 1, tree: 2, blob: 3 }[item.type], item.content.length), deflateSync(item.content)]);
      offsets.set(item, offset); entries.push({ oid: item.oid, offset, crc: crc32(encoded) }); append(encoded); offset += encoded.length;
    };
    try {
      const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objectsPerPack, 8); append(header);
      for (const item of objects.filter(item => item.pack === pack)) add(item);
      const firstPadding = entries.length;
      for (let ordinal = firstPadding; ordinal < objectsPerPack; ordinal++) {
        const content = Buffer.from(`synthetic padding pack ${pack} object ${String(ordinal).padStart(5, '0')}\n`);
        const item: FixtureObject = { oid: createHash('sha1').update(`blob ${content.length}\0`).update(content).digest(), type: 'blob', content, pack };
        add(item);
        if (ordinal === firstPadding || ordinal === objectsPerPack - 1) samples.push(item);
      }
      checksum = digest.digest(); assert.equal(fs.writeSync(descriptor, checksum), checksum.length);
    } finally { fs.closeSync(descriptor); }
    assert.equal(entries.length, objectsPerPack);
    const packPath = join(directory, `pack-${checksum.toString('hex')}.pack`), indexPath = packPath.replace(/\.pack$/u, '.idx');
    fs.renameSync(temporary, packPath);
    const index = indexBytesFor(entries, checksum); writeFile(indexPath, index);
    const bytes = fs.readFileSync(packPath);
    assert.deepEqual(sha1(bytes.subarray(0, -20)), checksum); assert.deepEqual(sha1(index.subarray(0, -20)), index.subarray(-20));
    assert.equal(index.readUInt32BE(1028), objectsPerPack);
    packPaths.push(packPath); indexPaths.push(indexPath); indexBytes += index.length; packBytes += bytes.length;
  }
  const selectedPaths = Object.keys(selected).sort();
  const selectedFiles = Object.fromEntries(selectedPaths.map(path => [path, selected[path]!.content.toString('utf8')]));
  const selectedOids = Object.fromEntries(selectedPaths.map(path => [path, selected[path]!.oid.toString('hex')]));
  for (const path of selectedPaths) writeFile(join(root, path), selectedFiles[path]!);
  writeFile(join(root, '.git/HEAD'), `${commit.oid.toString('hex')}\n`);
  writeFile(join(root, '.git/index'), workingIndex(selectedPaths, selected));
  // The independent library verifies all selected chain/tree objects plus two distant entries in every pack.
  const cache = {};
  for (const sample of samples) {
    const readback = await git.readObject({ fs, dir: root, oid: sample.oid.toString('hex'), format: 'content', cache });
    assert.equal(readback.format, 'content'); assert.equal(readback.type, sample.type);
    assert.deepEqual(Buffer.from(readback.object as Uint8Array), sample.content);
  }
  assert.deepEqual(await git.listFiles({ fs, dir: root }), selectedPaths);
  return { parent, root, sourceRoot: root, baseCommit: commit.oid.toString('hex'), selectedPaths, selectedFiles, selectedOids,
    packCount, objectCount: packCount * objectsPerPack, indexBytes, packBytes, packPaths, indexPaths, deltaDepth, rootDepth: root.split('/').filter(Boolean).length,
    selectedObjectCount: objects.length, independentReadbackSamples: samples.length, snapshot: () => snapshotFixture(root) };
};
