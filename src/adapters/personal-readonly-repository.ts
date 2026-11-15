import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import git from 'isomorphic-git';
import { HarnessError } from '../domain/errors.js';
import type { PersonalReadonlyRegistration, PersonalReadonlyRepository } from '../domain/personal-readonly.js';
import type { ReadonlyEntryIdentity, ReadonlyEvidence, ReadonlyParentIdentity, ReadonlyRange } from '../domain/readonly-investigation.js';
import { assertReadonlyEvidenceBudget, canonicalReadonlyJson, createReadonlyEvidence, hashReadonlyValue,
  isReadonlyId, normalizeReadonlyRanges, READONLY_LIMITS } from '../policy/readonly-investigation-policy.js';
import { containsSensitiveText } from '../policy/redaction.js';
import { parsePersonalReadonlyRegistration } from '../policy/personal-readonly-policy.js';

const unsafe = (): HarnessError => new HarnessError('PERSONAL_READONLY_UNSAFE_REPOSITORY');
const gitFileBytes = 8 * 1024 * 1024;
const gitTotalBytes = 64 * 1024 * 1024;
const objectBytes = 1024 * 1024;
const comparePaths = (left: { path: string }, right: { path: string }): number => left.path.localeCompare(right.path, 'en');
const sameMetadata = (left: fs.Stats, right: fs.Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.size === right.size && left.nlink === right.nlink && left.uid === right.uid
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
const identity = (path: string, value: fs.Stats, hash: string): ReadonlyEntryIdentity => ({ path, kind: 'file', hash,
  size: value.size, mode: value.mode, device: value.dev, inode: value.ino, links: value.nlink, uid: value.uid,
  modified: String(value.mtimeMs), changed: String(value.ctimeMs) });
const plain = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw unsafe();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !descriptors[key]?.enumerable || !('value' in descriptors[key]!))) throw unsafe();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
};
const array = (value: unknown, maximum: number): unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !value.length || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) throw unsafe();
  return Array.from({ length: value.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry?.enumerable || !('value' in entry)) throw unsafe();
    return entry.value;
  });
};
const repositoryCopy = <T>(value: T): T => {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 16384 || depth > 16) throw unsafe();
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && item.length <= 8192) return item;
    if (!item || typeof item !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) throw unsafe();
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 4096 || Reflect.ownKeys(item).length !== item.length + 1) throw unsafe();
      return Array.from({ length: item.length }, (_, index) => {
        const entry = Object.getOwnPropertyDescriptor(item, String(index));
        if (!entry?.enumerable || !('value' in entry)) throw unsafe();
        return visit(entry.value, depth + 1);
      });
    }
    return Object.fromEntries(Reflect.ownKeys(item).map((key) => {
      const entry = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !entry?.enumerable || !('value' in entry)) throw unsafe();
      return [key, visit(entry.value, depth + 1)];
    }));
  };
  return visit(value, 0) as T;
};
const allowedPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 512
  && value.split('/').length <= 16 && !value.split('/').some((part) => /^(?:config(?:uration)?(?:\.|$)|\.gitmodules$)/iu.test(part));
/** Snapshot own data properties before any filesystem access or await. */
const registrationCopy = (value: PersonalReadonlyRegistration): PersonalReadonlyRegistration => {
  value = parsePersonalReadonlyRegistration(repositoryCopy(value));
  const record = plain(value, ['version', 'repoId', 'sourceRoot', 'baseCommit', 'question', 'readRanges', 'transferPaths']);
  if (record.version !== 'personal-readonly-registration-v1' || typeof record.repoId !== 'string'
    || !/^[a-z][a-z0-9-]{0,63}$/u.test(record.repoId) || typeof record.sourceRoot !== 'string'
    || record.sourceRoot.length > 4096 || record.sourceRoot.includes('\0') || resolve(record.sourceRoot) !== record.sourceRoot
    || typeof record.baseCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(record.baseCommit)
    || typeof record.question !== 'string' || !record.question.trim() || Buffer.byteLength(record.question) > 4096
    || containsSensitiveText(record.question)) throw unsafe();
  const ranges = array(record.readRanges, READONLY_LIMITS.ranges).map((value) => {
    const item = plain(value, ['path', 'startLine', 'endLine']);
    if (!allowedPath(item.path)) throw unsafe();
    return { path: item.path, startLine: item.startLine as number, endLine: item.endLine as number };
  });
  const paths = [...new Set(ranges.map((item) => item.path))].sort();
  const normalized = normalizeReadonlyRanges(ranges, paths);
  const transferPaths = array(record.transferPaths, READONLY_LIMITS.files);
  if (transferPaths.some((path) => typeof path !== 'string' || !paths.includes(path))
    || new Set(transferPaths).size !== transferPaths.length) throw unsafe();
  return { version: record.version, repoId: record.repoId, sourceRoot: record.sourceRoot, baseCommit: record.baseCommit,
    question: record.question, readRanges: normalized, transferPaths: (transferPaths as string[]).sort() };
};
const observeParents = (path: string, parents: Map<string, ReadonlyParentIdentity>): void => {
  if (resolve(path) !== path) throw unsafe();
  let current: string = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) throw unsafe();
    const item = { path: current, device: stat.dev, inode: stat.ino, mode: stat.mode, uid: stat.uid };
    if (parents.has(current) && canonicalReadonlyJson(parents.get(current)) !== canonicalReadonlyJson(item)) throw unsafe();
    parents.set(current, item);
  }
};
const readBounded = (path: string, maximum: number, parents: Map<string, ReadonlyParentIdentity>): { bytes: Buffer; stat: fs.Stats } => {
  observeParents(dirname(path), parents);
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > maximum) throw unsafe();
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!sameMetadata(stat, fs.fstatSync(descriptor))) throw unsafe();
    const buffer = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < buffer.length) { const amount = fs.readSync(descriptor, buffer, count, buffer.length - count, count); if (!amount) break; count += amount; }
    if (count !== stat.size || !sameMetadata(stat, fs.fstatSync(descriptor)) || !sameMetadata(stat, fs.lstatSync(path))) throw unsafe();
    observeParents(dirname(path), parents);
    return { bytes: buffer.subarray(0, count), stat };
  } finally { fs.closeSync(descriptor); }
};
const sourceHash = (manifest: ReadonlyEntryIdentity[]): string => hashReadonlyValue(canonicalReadonlyJson(manifest.map(({ path, hash, size, mode }) => ({ path, hash, size, mode }))));
const repositoryHash = (repository: Omit<PersonalReadonlyRepository, 'identityHash'>): string => {
  const { id, kind, repoId, sourceRoot, baseCommit, sourceManifestHash, manifest, parents, readAllowedFiles, gitEntries, headRef } = repository;
  return hashReadonlyValue(canonicalReadonlyJson({ id, kind, repoId, sourceRoot, baseCommit, sourceManifestHash, manifest, parents, readAllowedFiles, gitEntries, headRef }));
};
const gitPath = (path: string): boolean => /^\.git\/(?:HEAD|index|packed-refs|refs\/heads\/[a-zA-Z0-9_./-]+|objects\/[a-f0-9]{2}\/[a-f0-9]{38}|objects\/pack\/pack-[a-f0-9]{40}\.(?:idx|pack))$/u.test(path)
  && !path.split('/').some((part) => part === '.' || part === '..');
interface Observation { root: string; parents: Map<string, ReadonlyParentIdentity>; gitEntries: Map<string, ReadonlyEntryIdentity>; bytes: number; reads: number }
const readGit = (state: Observation, relative: string): Buffer => {
  if (++state.reads > 2048 || !gitPath(relative) || state.gitEntries.size >= 256 && !state.gitEntries.has(relative)) throw unsafe();
  const result = readBounded(join(state.root, relative), gitFileBytes, state.parents);
  state.bytes += result.bytes.length;
  if (state.bytes > gitTotalBytes) throw unsafe();
  const item = identity(relative, result.stat, hashReadonlyValue(result.bytes));
  if (state.gitEntries.has(relative) && canonicalReadonlyJson(state.gitEntries.get(relative)) !== canonicalReadonlyJson(item)) throw unsafe();
  state.gitEntries.set(relative, item);
  return result.bytes;
};
const readHead = (state: Observation, baseCommit: string): string | null => {
  const head = readGit(state, '.git/HEAD').toString('utf8');
  if (head === `${baseCommit}\n`) return null;
  const match = /^ref: (refs\/heads\/[a-zA-Z0-9_./-]+)\n$/u.exec(head);
  if (!match || !gitPath(`.git/${match[1]}`)) throw unsafe();
  const ref = `.git/${match[1]}`;
  try { if (readGit(state, ref).toString('utf8') !== `${baseCommit}\n`) throw unsafe(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const lines = readGit(state, '.git/packed-refs').toString('utf8').split('\n');
    if (lines.filter((line) => line === `${baseCommit} ${match[1]}`).length !== 1
      || lines.some((line) => line.endsWith(` ${match[1]}`) && line !== `${baseCommit} ${match[1]}`)) throw unsafe();
  }
  return match[1]!;
};
/** Check selected index entries only. Other staged/untracked files are not a clean-worktree claim. */
const selectedIndex = (bytes: Buffer, selected: Map<string, { oid: string; mode: string }>): void => {
  if (bytes.length < 32 || bytes.toString('ascii', 0, 4) !== 'DIRC' || ![2, 3].includes(bytes.readUInt32BE(4))
    || bytes.readUInt32BE(8) > 65536 || createHash('sha1').update(bytes.subarray(0, -20)).digest('hex') !== bytes.subarray(-20).toString('hex')) throw unsafe();
  let cursor = 12; const found = new Set<string>();
  for (let entry = 0; entry < bytes.readUInt32BE(8); entry++) {
    const begin = cursor;
    if (cursor + 62 >= bytes.length - 20) throw unsafe();
    const mode = bytes.readUInt32BE(cursor + 24).toString(8), oid = bytes.subarray(cursor + 40, cursor + 60).toString('hex');
    const flags = bytes.readUInt16BE(cursor + 60); cursor += 62;
    let extended = 0;
    if (flags & 0x4000) { if (bytes.readUInt32BE(4) !== 3 || cursor + 2 >= bytes.length - 20) throw unsafe(); extended = bytes.readUInt16BE(cursor); cursor += 2; }
    const end = bytes.indexOf(0, cursor);
    if (end < cursor || end >= bytes.length - 20) throw unsafe();
    const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor, end));
    cursor = begin + Math.ceil((end + 1 - begin) / 8) * 8;
    const expected = selected.get(path);
    if (expected) {
      if (found.has(path) || flags & 0x3000 || extended !== 0 || expected.oid !== oid || expected.mode !== mode) throw unsafe();
      found.add(path);
    }
  }
  while (cursor < bytes.length - 20) {
    if (cursor + 8 > bytes.length - 20) throw unsafe();
    const name = bytes.toString('ascii', cursor, cursor + 4), size = bytes.readUInt32BE(cursor + 4);
    if (!/^[A-Z][A-Za-z]{3}$/u.test(name)) throw unsafe();
    cursor += 8 + size;
  }
  if (cursor !== bytes.length - 20 || found.size !== selected.size) throw unsafe();
};
const varint = (bytes: Buffer, cursor: { value: number }): number => {
  let result = 0, factor = 1;
  for (let count = 0; count < 5; count++) {
    const byte = bytes[cursor.value++]; if (byte === undefined) throw unsafe();
    result += (byte & 127) * factor;
    if (!(byte & 128)) { if (result > objectBytes) throw unsafe(); return result; }
    factor *= 128;
  }
  throw unsafe();
};
/** Bound declared and actual delta output before the dependency may allocate it. */
const validateDelta = (delta: Buffer): void => {
  const cursor = { value: 0 }; const source = varint(delta, cursor), target = varint(delta, cursor); let output = 0;
  while (cursor.value < delta.length) {
    const opcode = delta[cursor.value++]!;
    if (opcode & 128) {
      let offset = 0, size = 0;
      for (let index = 0; index < 4; index++) if (opcode & 1 << index) { const byte = delta[cursor.value++]; if (byte === undefined) throw unsafe(); offset += byte * 2 ** (index * 8); }
      for (let index = 0; index < 3; index++) if (opcode & 1 << (index + 4)) { const byte = delta[cursor.value++]; if (byte === undefined) throw unsafe(); size += byte * 2 ** (index * 8); }
      if (!size) size = 65536;
      if (offset + size > source) throw unsafe(); output += size;
    } else { if (!opcode || cursor.value + opcode > delta.length) throw unsafe(); cursor.value += opcode; output += opcode; }
    if (output > target) throw unsafe();
  }
  if (output !== target) throw unsafe();
};
const validatePack = (bytes: Buffer, index: Buffer): void => {
  if (bytes.length < 32 || bytes.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(bytes.readUInt32BE(4))
    || bytes.readUInt32BE(8) > 4096 || createHash('sha1').update(bytes.subarray(0, -20)).digest('hex') !== bytes.subarray(-20).toString('hex')) throw unsafe();
  const offsets = new Map<string, number>(), count = index.readUInt32BE(1028);
  if (!bytes.subarray(-20).equals(index.subarray(-40, -20))) throw unsafe();
  for (let entry = 0; entry < count; entry++) {
    const offset = index.readUInt32BE(1032 + count * 24 + entry * 4);
    // The registered 8MiB pack bound needs no 64-bit offset representation.
    if (offset & 0x80000000) throw unsafe();
    offsets.set(index.subarray(1032 + entry * 20, 1052 + entry * 20).toString('hex'), offset);
  }
  const dependencies = new Map<number, number | null>();
  let cursor = 12, total = 0;
  for (let entry = 0; entry < bytes.readUInt32BE(8); entry++) {
    const begin = cursor; let dependency: number | null = null;
    const first = bytes[cursor++]; if (first === undefined) throw unsafe();
    const type = first >> 4 & 7; let size = first & 15, factor = 16, byte = first;
    for (let count = 0; byte & 128; count++) { byte = bytes[cursor++]!; if (byte === undefined || count > 3) throw unsafe(); size += (byte & 127) * factor; factor *= 128; }
    if (![1, 2, 3, 4, 6, 7].includes(type) || size > objectBytes) throw unsafe();
    if (type === 6) {
      let offsetByte = bytes[cursor++]!, distance = offsetByte & 127, count = 0;
      while (offsetByte & 128) { offsetByte = bytes[cursor++]!; if (offsetByte === undefined || count++ > 4) throw unsafe(); distance = (distance + 1) * 128 + (offsetByte & 127); }
      dependency = begin - distance;
      if (!dependencies.has(dependency)) throw unsafe();
    }
    if (type === 7) {
      dependency = offsets.get(bytes.subarray(cursor, cursor + 20).toString('hex')) ?? null;
      if (dependency === null) throw unsafe(); // Thin packs requiring another pack are outside this reader contract.
      cursor += 20;
    }
    if (cursor >= bytes.length - 20) throw unsafe();
    const result = inflateSync(bytes.subarray(cursor, -20), { maxOutputLength: objectBytes, info: true }) as unknown as {
      buffer: Buffer; engine: { bytesWritten: number };
    };
    if (result.buffer.length !== size || !result.engine.bytesWritten) throw unsafe();
    cursor += result.engine.bytesWritten; total += result.buffer.length;
    if (total > 16 * objectBytes) throw unsafe();
    if (type === 6 || type === 7) validateDelta(result.buffer);
    dependencies.set(begin, dependency);
  }
  if (cursor !== bytes.length - 20 || offsets.size !== dependencies.size || new Set(offsets.values()).size !== dependencies.size
    || [...offsets.values()].some((offset) => !dependencies.has(offset))) throw unsafe();
  for (const offset of dependencies.keys()) {
    let current: number | null = offset; const seen = new Set<number>();
    while (current !== null) {
      if (seen.has(current) || seen.size >= 32 || !dependencies.has(current)) throw unsafe();
      seen.add(current); current = dependencies.get(current)!;
    }
  }
};
const validatePackIndex = (bytes: Buffer): void => {
  if (bytes.length < 1072 || bytes.readUInt32BE(0) !== 0xff744f63 || bytes.readUInt32BE(4) !== 2) throw unsafe();
  const count = bytes.readUInt32BE(1028);
  if (count > 4096 || bytes.length < 1072 + count * 28 || createHash('sha1').update(bytes.subarray(0, -20)).digest('hex') !== bytes.subarray(-20).toString('hex')) throw unsafe();
  for (let index = 1; index < 256; index++) if (bytes.readUInt32BE(8 + index * 4) < bytes.readUInt32BE(8 + (index - 1) * 4)) throw unsafe();
  let large = 0;
  for (let index = 0; index < count; index++) if (bytes.readUInt32BE(1032 + count * 24 + index * 4) & 0x80000000) large++;
  if (bytes.length !== 1072 + count * 28 + large * 8) throw unsafe();
  for (let index = 0; index < count; index++) {
    const offset = bytes.readUInt32BE(1032 + count * 24 + index * 4);
    if (offset & 0x80000000 && (offset & 0x7fffffff) >= large) throw unsafe();
  }
};
/** No config, working file, hooks, alternate object directories, writes, or network ports exist here. */
const restrictedGitFs = (state: Observation) => {
  const indexes = new Map<string, Buffer>();
  const relative = (path: unknown): string => {
    if (typeof path !== 'string' || !path.startsWith(`${state.root}/.git`) || resolve(path) !== path) throw unsafe();
    return path.slice(state.root.length + 1);
  };
  const denied = async (): Promise<never> => { throw unsafe(); };
  const stat = async (path: string): Promise<fs.Stats> => {
    const name = relative(path);
    if (name !== '.git' && !gitPath(name)) throw unsafe();
    observeParents(name === '.git' ? path : dirname(path), state.parents);
    const value = fs.lstatSync(path); if (value.isSymbolicLink()) throw unsafe(); return value;
  };
  return { promises: {
    readFile: async (path: string): Promise<Buffer> => {
      const name = relative(path); const bytes = readGit(state, name);
      if (/\/objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/u.test(name)) {
        const inflated = inflateSync(bytes, { maxOutputLength: objectBytes + 128 });
        const header = /^(blob|tree|commit|tag) (0|[1-9]\d*)$/u.exec(inflated.subarray(0, inflated.indexOf(0)).toString('ascii'));
        if (!header || Number(header[2]) > objectBytes || inflated.indexOf(0) + 1 + Number(header[2]) !== inflated.length) throw unsafe();
      } else if (name.endsWith('.pack')) {
        const index = indexes.get(name.replace(/\.pack$/u, '.idx'));
        if (!index) throw unsafe(); validatePack(bytes, index);
      } else if (name.endsWith('.idx')) { validatePackIndex(bytes); indexes.set(name, bytes); }
      return bytes;
    }, stat, lstat: stat,
    readdir: async (path: string): Promise<string[]> => {
      if (relative(path) !== '.git/objects/pack') throw unsafe();
      observeParents(path, state.parents); const directory = fs.opendirSync(path); const names: string[] = [];
      try { let entry: fs.Dirent | null; while ((entry = directory.readSync())) { if (names.length >= 64) throw unsafe(); names.push(entry.name); } }
      finally { directory.closeSync(); }
      return names.filter((name) => /^pack-[a-f0-9]{40}\.idx$/u.test(name)).sort();
    }, writeFile: denied, mkdir: denied, rmdir: denied, unlink: denied, readlink: denied, symlink: denied,
  } };
};
type EvidenceDeriver = (repoId: string, baseCommit: string, range: ReadonlyRange, bytes: Uint8Array) => ReadonlyEvidence;
interface CollectionContract { fileBytes: 32768 | 65536; deriveEvidence: EvidenceDeriver }
const originalContract: CollectionContract = Object.freeze({ fileBytes: 32768, deriveEvidence: createReadonlyEvidence });
const inspectRepository = async (value: PersonalReadonlyRegistration, id: string, contract: CollectionContract): Promise<PersonalReadonlyRepository> => {
  try {
    const registration = registrationCopy(value);
    if (!isReadonlyId(id)) throw unsafe();
    const state: Observation = { root: registration.sourceRoot, parents: new Map(), gitEntries: new Map(), bytes: 0, reads: 0 };
    observeParents(join(state.root, '.git'), state.parents);
    const headRef = readHead(state, registration.baseCommit), index = readGit(state, '.git/index');
    const reader = restrictedGitFs(state), cache = {}, verified = new Set<string>();
    const verifyObject = async (oid: string, type: 'commit' | 'tree'): Promise<void> => {
      if (verified.has(oid)) return;
      const result = await git.readObject({ fs: reader, dir: state.root, oid, format: 'content', cache });
      if (result.format !== 'content' || result.type !== type || !(result.object instanceof Uint8Array)
        || result.object.byteLength > objectBytes || createHash('sha1').update(`${type} ${result.object.byteLength}\0`).update(result.object).digest('hex') !== oid) throw unsafe();
      verified.add(oid);
    };
    // Packed-object APIs verify pack checksums, so independently verify each selected content OID as well.
    await verifyObject(registration.baseCommit, 'commit');
    const commit = await git.readCommit({ fs: reader, dir: state.root, oid: registration.baseCommit, cache });
    if (commit.oid !== registration.baseCommit) throw unsafe();
    const manifest: ReadonlyEntryIdentity[] = [], selected = new Map<string, { oid: string; mode: string }>();
    const paths = [...new Set(registration.readRanges.map((range) => range.path))].sort();
    for (const path of paths) {
      let tree = commit.commit.tree, mode = '';
      for (const [index, part] of path.split('/').entries()) {
        await verifyObject(tree, 'tree');
        const entry = (await git.readTree({ fs: reader, dir: state.root, oid: tree, cache })).tree.find((item) => item.path === part);
        if (!entry || (index < path.split('/').length - 1 ? entry.type !== 'tree' || entry.mode !== '040000' : entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) throw unsafe();
        tree = entry.oid; mode = entry.mode;
      }
      const blob = await git.readBlob({ fs: reader, dir: state.root, oid: tree, cache });
      const result = readBounded(join(state.root, path), contract.fileBytes, state.parents);
      if (blob.oid !== tree || blob.blob.byteLength > contract.fileBytes || createHash('sha1').update(`blob ${blob.blob.byteLength}\0`).update(blob.blob).digest('hex') !== blob.oid
        || !result.bytes.equals(blob.blob)
        || Boolean(result.stat.mode & 0o111) !== (mode === '100755')) throw unsafe();
      for (const range of registration.readRanges.filter((range) => range.path === path)) contract.deriveEvidence(registration.repoId, registration.baseCommit, range, result.bytes);
      manifest.push(identity(path, result.stat, hashReadonlyValue(result.bytes))); selected.set(path, { oid: blob.oid, mode });
    }
    selectedIndex(index, selected);
    manifest.sort(comparePaths);
    const repository = { id, kind: 'personal-git' as const, repoId: registration.repoId, sourceRoot: state.root,
      baseCommit: registration.baseCommit, sourceManifestHash: sourceHash(manifest), manifest,
      parents: [...state.parents.values()].sort(comparePaths), readAllowedFiles: paths,
      gitEntries: [...state.gitEntries.values()].sort(comparePaths), headRef };
    const result = { ...repository, identityHash: repositoryHash(repository) };
    assertRepositoryNow(result, contract.fileBytes); return result;
  } catch { throw unsafe(); }
};
/** Synchronous final source guard: re-hash selected bytes and every Git file actually used by inspection. */
const assertRepositoryNow = (repository: PersonalReadonlyRepository, fileBytes: 32768 | 65536): void => {
  try {
    repository = repositoryCopy(repository);
    plain(repository, ['id', 'kind', 'repoId', 'sourceRoot', 'baseCommit', 'sourceManifestHash', 'identityHash', 'manifest', 'parents', 'readAllowedFiles', 'gitEntries', 'headRef']);
    if (!isReadonlyId(repository.id) || repository.kind !== 'personal-git' || repositoryHash(repository) !== repository.identityHash
      || !Array.isArray(repository.manifest) || repository.manifest.length < 1 || repository.manifest.length > READONLY_LIMITS.files
      || sourceHash(repository.manifest) !== repository.sourceManifestHash || repository.gitEntries.length > 256
      || canonicalReadonlyJson(repository.manifest.map((item) => item.path).sort()) !== canonicalReadonlyJson(repository.readAllowedFiles)) throw unsafe();
    normalizeReadonlyRanges(repository.readAllowedFiles.map((path) => ({ path, startLine: 1, endLine: 1 })), repository.readAllowedFiles);
    const state: Observation = { root: repository.sourceRoot, parents: new Map(repository.parents.map((item) => [item.path, { ...item }])), gitEntries: new Map(), bytes: 0, reads: 0 };
    if (readHead(state, repository.baseCommit) !== repository.headRef) throw unsafe();
    for (const item of state.gitEntries.values()) {
      if (canonicalReadonlyJson(repository.gitEntries.find((expected) => expected.path === item.path)) !== canonicalReadonlyJson(item)) throw unsafe();
    }
    for (const item of [...repository.manifest, ...repository.gitEntries]) {
      if (item.kind !== 'file' || (item.path.startsWith('.git/') ? !gitPath(item.path) : !allowedPath(item.path))) throw unsafe();
      const result = readBounded(join(state.root, item.path), item.path.startsWith('.git/') ? gitFileBytes : fileBytes, state.parents);
      state.bytes += result.bytes.length; if (state.bytes > gitTotalBytes) throw unsafe();
      if (canonicalReadonlyJson(identity(item.path, result.stat, hashReadonlyValue(result.bytes))) !== canonicalReadonlyJson(item)) throw unsafe();
    }
    for (const parent of repository.parents) observeParents(parent.path, state.parents);
    if (canonicalReadonlyJson([...state.parents.values()].sort(comparePaths)) !== canonicalReadonlyJson(repository.parents)) throw unsafe();
  } catch { throw unsafe(); }
};
const collectEvidenceNow = (repository: PersonalReadonlyRepository, value: PersonalReadonlyRegistration, contract: CollectionContract): ReadonlyEvidence[] => {
  try {
    repository = repositoryCopy(repository);
    const registration = registrationCopy(value); assertRepositoryNow(repository, contract.fileBytes);
    if (registration.repoId !== repository.repoId || registration.sourceRoot !== repository.sourceRoot || registration.baseCommit !== repository.baseCommit
      || canonicalReadonlyJson([...new Set(registration.readRanges.map((item) => item.path))].sort()) !== canonicalReadonlyJson(repository.readAllowedFiles)) throw unsafe();
    const parents = new Map(repository.parents.map((item) => [item.path, { ...item }]));
    const evidence = registration.readRanges.map((range) => {
      const bytes = readBounded(join(repository.sourceRoot, range.path), contract.fileBytes, parents).bytes;
      if (hashReadonlyValue(bytes) !== repository.manifest.find((item) => item.path === range.path)?.hash) throw unsafe();
      return contract.deriveEvidence(repository.repoId, repository.baseCommit, range, bytes);
    });
    assertReadonlyEvidenceBudget(evidence); assertRepositoryNow(repository, contract.fileBytes); return evidence;
  } catch { throw unsafe(); }
};
export const inspectPersonalReadonlyRepository = (registration: PersonalReadonlyRegistration, id: string): Promise<PersonalReadonlyRepository> =>
  inspectRepository(registration, id, originalContract);
export const assertPersonalReadonlyRepositoryNow = (repository: PersonalReadonlyRepository): void => assertRepositoryNow(repository, 32768);
export const assertPersonalReadonlyRepository = async (repository: PersonalReadonlyRepository): Promise<void> => { assertPersonalReadonlyRepositoryNow(repository); };
export const collectPersonalReadonlyEvidence = async (repository: PersonalReadonlyRepository, registration: PersonalReadonlyRegistration): Promise<ReadonlyEvidence[]> =>
  collectEvidenceNow(repository, registration, originalContract);

/** Harness code injects its fixed derivation function; no registration, CLI or payload may supply a callback or byte limit. */
export const createPersonalReadonlyCollectionReader = (deriveEvidence: EvidenceDeriver) => {
  if (typeof deriveEvidence !== 'function') throw unsafe();
  const contract: CollectionContract = Object.freeze({ fileBytes: 65536, deriveEvidence });
  return Object.freeze({
    inspect: (registration: PersonalReadonlyRegistration, id: string): Promise<PersonalReadonlyRepository> => inspectRepository(registration, id, contract),
    assertNow: (repository: PersonalReadonlyRepository): void => assertRepositoryNow(repository, 65536),
    collectNow: (repository: PersonalReadonlyRepository, registration: PersonalReadonlyRegistration): ReadonlyEvidence[] => collectEvidenceNow(repository, registration, contract),
  });
};
