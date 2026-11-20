import fs, { constants, type Stats } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { CompanyChangeDraft } from '../domain/company-change.js';
import type { CompanyWriteRegistration, CompanyWriteSource } from '../domain/company-write.js';
import { HarnessError } from '../domain/errors.js';
import { canonicalReadonlyJson, isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { assertCompanyWriteSource, getCompanyWriteLimits, hashCompanyWriteValue, parseCompanyWriteDraft,
  parseCompanyWriteRegistration } from '../policy/company-write.js';

const fail: (suffix: string) => never = suffix => { throw new HarnessError(`COMPANY_WRITE_${suffix}`); };
const digest = (value: unknown): string => hashCompanyWriteValue(canonicalReadonlyJson(value));
const equal = (left: unknown, right: unknown): boolean => canonicalReadonlyJson(left) === canonicalReadonlyJson(right);
const identity = (value: Stats) => ({ dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mode: value.mode });
const metadata = (value: Stats) => ({ ...identity(value), nlink: value.nlink, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs });
type Identity = ReturnType<typeof identity>;
type Metadata = ReturnType<typeof metadata>;
interface FileSnapshot { hash: string; metadata: Metadata }
interface Snapshot { source: CompanyWriteSource; directories: Map<string, Identity>; head: FileSnapshot;
  index: FileSnapshot; base: FileSnapshot; files: Array<FileSnapshot | null>; targetRef: FileSnapshot | null }
interface OwnedFile { path: string; descriptor: number; metadata: Metadata; active: boolean; closed: boolean }

export interface CompanyWriteMutationPaths {
  root: string;
  head: string;
  headLock: string;
  index: string;
  indexLock: string;
  baseRef: string;
  baseRefLock: string;
  packedRefsLock: string;
  branchDirectory: string;
  branchRef: string;
  branchLock: string;
  branchTemporary: string;
  files: Array<{ path: string; target: string; temporary: string; parent: string }>;
  readPaths: string[];
  writePaths: string[];
  readDirectories: string[];
  metadataPaths: string[];
}

const ancestors = (path: string): string[] => {
  const result = [path]; let current = path;
  while (dirname(current) !== current) { current = dirname(current); result.unshift(current); }
  return result;
};
const unique = (values: string[]): string[] => [...new Set(values)].sort();
const exists = (path: string): boolean => {
  try { fs.lstatSync(path); return true; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
};
const rejectedGitPaths = (root: string): string[] => ['packed-refs', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
  'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'commondir', 'gitdir', 'worktrees'].map(path => join(root, '.git', path));
const lockPaths = (paths: CompanyWriteMutationPaths): string[] => unique([paths.headLock, paths.indexLock,
  paths.baseRefLock, paths.packedRefsLock, paths.branchLock]);
const nestedGitPaths = (root: string, parents: string[]): string[] => unique(parents.flatMap(parent => ancestors(parent)
  .filter(path => path.startsWith(`${root}/`)).map(path => join(path, '.git'))));

/** Only exact paths are returned; the isolation profile must never expand these into a repository subtree grant. */
export const deriveCompanyWriteMutationPaths = (registrationInput: unknown, draftInput: unknown, taskId: string): CompanyWriteMutationPaths => {
  const registration = parseCompanyWriteRegistration(registrationInput), draft = parseCompanyWriteDraft(draftInput, registration);
  if (!isReadonlyId(taskId)) fail('INVALID_ID');
  const root = registration.sourceRoot, git = join(root, '.git'), head = join(git, 'HEAD'), index = join(git, 'index');
  const baseRef = join(git, 'refs', 'heads', registration.baseBranch), branchRef = join(git, 'refs', 'heads', draft.branch);
  const branchDirectory = dirname(branchRef), headLock = `${head}.lock`, indexLock = `${index}.lock`, baseRefLock = `${baseRef}.lock`;
  const packedRefsLock = join(git, 'packed-refs.lock'), branchLock = `${branchRef}.lock`;
  const branchTemporary = join(branchDirectory, `.company-write-${taskId}-ref.tmp`);
  const files = draft.changes.map((change, index) => {
    const target = join(root, change.path), parent = dirname(target);
    return { path: change.path, target, parent, temporary: join(parent, `.company-write-${taskId}-${index}.tmp`) };
  });
  const readDirectories = unique([git, dirname(baseRef), dirname(branchDirectory), branchDirectory, ...files.map(file => file.parent)]);
  const readPaths = unique([head, index, baseRef, branchRef, branchTemporary, ...files.flatMap(file => [file.target, file.temporary])]);
  const writePaths = unique([head, headLock, indexLock, baseRefLock, packedRefsLock, branchDirectory, branchRef, branchLock,
    branchTemporary, ...files.flatMap(file => [file.target, file.temporary])]);
  const metadataPaths = unique([...readPaths, ...writePaths, ...readDirectories.flatMap(ancestors),
    ...rejectedGitPaths(root), join(root, '.gitmodules'), ...nestedGitPaths(root, files.map(file => file.parent))]);
  return { root, head, headLock, index, indexLock, baseRef, baseRefLock, packedRefsLock, branchDirectory, branchRef,
    branchLock, branchTemporary, files, readPaths, writePaths, readDirectories, metadataPaths };
};

const directory = (path: string, root: string): Identity => {
  const value = fs.lstatSync(path);
  if (!value.isDirectory() || value.isSymbolicLink() || resolve(path) !== path || fs.realpathSync(path) !== path
    || (path === root || path.startsWith(`${root}/`)) && (value.uid !== process.getuid?.() || (value.mode & 0o7000) !== 0)) fail('UNSAFE_SOURCE');
  return identity(value);
};
const validateDirectories = (root: string, paths: string[]): Map<string, Identity> => {
  const result = new Map<string, Identity>();
  for (const path of unique(paths.flatMap(ancestors))) result.set(path, directory(path, root));
  return result;
};
const assertDirectories = (root: string, values: Map<string, Identity>): void => {
  for (const [path, expected] of values) if (!equal(expected, directory(path, root))) fail('SOURCE_CHANGED');
};
const readBounded = (path: string, maximum: number): FileSnapshot => {
  const value = fs.lstatSync(path);
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid?.() || value.nlink !== 1
    || (value.mode & 0o7111) !== 0 || value.size > maximum || fs.realpathSync(path) !== path) fail('UNSAFE_SOURCE');
  const expected = metadata(value), descriptor = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!equal(expected, metadata(fs.fstatSync(descriptor)))) fail('SOURCE_CHANGED');
    const buffer = Buffer.alloc(value.size + 1); let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
      if (count === 0) break; length += count;
    }
    if (length !== value.size || !equal(expected, metadata(fs.fstatSync(descriptor)))
      || !equal(expected, metadata(fs.lstatSync(path))) || fs.realpathSync(path) !== path) fail('SOURCE_CHANGED');
    return { hash: hashCompanyWriteValue(buffer.subarray(0, length)), metadata: expected };
  } finally { fs.closeSync(descriptor); }
};
const assertFileMetadata = (path: string, expected: FileSnapshot | null): void => {
  if (expected ? !exists(path) || !equal(expected.metadata, metadata(fs.lstatSync(path))) : exists(path)) fail('SOURCE_CHANGED');
};
const assertOwned = (file: OwnedFile): void => {
  if (!file.active || file.closed || !exists(file.path)) fail('OWNERSHIP_CHANGED');
  const path = fs.lstatSync(file.path), descriptor = fs.fstatSync(file.descriptor);
  if (!path.isFile() || path.isSymbolicLink() || path.nlink !== 1 || !equal(file.metadata, metadata(path))
    || !equal(file.metadata, metadata(descriptor))) fail('OWNERSHIP_CHANGED');
};
const inspect = (registration: CompanyWriteRegistration, draft: CompanyChangeDraft, paths: CompanyWriteMutationPaths,
  held = new Map<string, OwnedFile>(), branched = false): Snapshot => {
  const limits = getCompanyWriteLimits(), requiredDirectories = [paths.root, dirname(paths.head), dirname(paths.baseRef), ...paths.files.map(file => file.parent)];
  const directories = validateDirectories(paths.root, requiredDirectories);
  if (exists(paths.branchDirectory)) {
    for (const [path, value] of validateDirectories(paths.root, [paths.branchDirectory])) directories.set(path, value);
  }
  for (const path of [...rejectedGitPaths(paths.root), join(paths.root, '.gitmodules'), ...nestedGitPaths(paths.root, paths.files.map(file => file.parent))]) {
    if (exists(path)) fail('UNSUPPORTED_GIT_STATE');
  }
  for (const path of lockPaths(paths)) {
    const owned = held.get(path);
    if (owned) assertOwned(owned); else if (exists(path)) fail('GIT_BUSY');
  }
  const head = readBounded(paths.head, limits.maxGitTextBytes), index = readBounded(paths.index, limits.maxIndexBytes);
  const base = readBounded(paths.baseRef, limits.maxGitTextBytes);
  if (head.hash !== hashCompanyWriteValue(`ref: refs/heads/${branched ? draft.branch : registration.baseBranch}\n`)
    || index.hash !== registration.baseIndexHash || base.hash !== hashCompanyWriteValue(`${registration.baseCommit}\n`)) fail('BASE_MISMATCH');
  if (!branched && exists(paths.branchRef)) fail('BRANCH_CONFLICT');
  const targetRef = branched && exists(paths.branchRef) ? readBounded(paths.branchRef, limits.maxGitTextBytes) : null;
  if (branched && targetRef?.hash !== hashCompanyWriteValue(`${registration.baseCommit}\n`)) fail('BRANCH_CONFLICT');
  const files: Array<FileSnapshot | null> = [], sourceFiles: CompanyWriteSource['files'] = []; let total = 0;
  for (const file of paths.files) {
    const current = exists(file.target) ? readBounded(file.target, limits.maxContentBytes) : null;
    total += current?.metadata.size ?? 0; if (total > limits.maxTotalContentBytes) fail('SOURCE_LIMIT');
    const parents = ancestors(file.parent).filter(path => path === paths.root || path.startsWith(`${paths.root}/`));
    sourceFiles.push({ path: file.path, beforeHash: current?.hash ?? null, mode: current ? current.metadata.mode & 0o777 : null,
      identityHash: current ? digest(current.metadata) : null,
      parentIdentityHash: digest(parents.map(path => ({ path: relative(paths.root, path), identity: directories.get(path) }))) });
    files.push(current);
  }
  assertDirectories(paths.root, directories);
  for (const path of [...rejectedGitPaths(paths.root), join(paths.root, '.gitmodules'), ...nestedGitPaths(paths.root, paths.files.map(file => file.parent))]) {
    if (exists(path)) fail('UNSUPPORTED_GIT_STATE');
  }
  for (const path of lockPaths(paths)) {
    const owned = held.get(path);
    if (owned) assertOwned(owned); else if (exists(path)) fail('GIT_BUSY');
  }
  for (const [path, value] of [[paths.head, head], [paths.index, index], [paths.baseRef, base], [paths.branchRef, targetRef]] as const) assertFileMetadata(path, value);
  paths.files.forEach((file, index) => assertFileMetadata(file.target, files[index]!));
  const source: CompanyWriteSource = { rootIdentityHash: digest({ root: paths.root,
    ancestors: ancestors(paths.root).map(path => ({ path, identity: directories.get(path) })) }),
  headHash: head.hash, indexHash: index.hash, baseRefHash: base.hash, files: sourceFiles };
  assertCompanyWriteSource(source);
  return { source, directories, head, index, base, files, targetRef };
};
const unchanged = (before: Snapshot, after: Snapshot, changedFile = -1, changedBranch = false): void => {
  for (const [path, expected] of before.directories) if (!equal(expected, after.directories.get(path))) fail('SOURCE_CHANGED');
  if (!changedBranch && !equal([...before.directories], [...after.directories])) fail('SOURCE_CHANGED');
  if (!equal(before.index, after.index) || !equal(before.base, after.base)) fail('SOURCE_CHANGED');
  if (!changedBranch && (!equal(before.head, after.head) || !equal(before.targetRef, after.targetRef))) fail('SOURCE_CHANGED');
  for (let index = 0; index < before.files.length; index++) if (index !== changedFile && !equal(before.files[index], after.files[index])) fail('SOURCE_CHANGED');
};
const assertBefore = (snapshot: Snapshot, draft: CompanyChangeDraft): void => {
  let bytes = snapshot.files.reduce((total, file) => total + (file?.metadata.size ?? 0), 0);
  for (let index = 0; index < draft.changes.length; index++) {
    const change = draft.changes[index]!, file = snapshot.files[index];
    if (file?.hash !== (change.beforeHash ?? undefined)) fail('BEFORE_MISMATCH');
    bytes += Buffer.byteLength(change.content) - (file?.metadata.size ?? 0);
    if (bytes > getCompanyWriteLimits().maxTotalContentBytes) fail('SOURCE_LIMIT');
  }
};

export const inspectCompanyWriteSource = async (registrationInput: unknown, draftInput: unknown): Promise<CompanyWriteSource> => {
  const registration = parseCompanyWriteRegistration(registrationInput), draft = parseCompanyWriteDraft(draftInput, registration);
  const paths = deriveCompanyWriteMutationPaths(registration, draft, '00000000-0000-4000-8000-000000000000');
  const result = inspect(registration, draft, paths);
  assertBefore(result, draft);
  return result.source;
};

const syncDirectory = (path: string): void => {
  const descriptor = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!fs.fstatSync(descriptor).isDirectory()) fail('UNSAFE_SOURCE'); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
};

/** Trusted mutation mechanics. The calling isolated worker owns approval, journal and one-shot consumption. */
export class CompanyWriteWorkspace {
  readonly #registration: CompanyWriteRegistration;
  readonly #draft: CompanyChangeDraft;
  readonly #paths: CompanyWriteMutationPaths;
  readonly #owned: OwnedFile[] = [];
  readonly #held = new Map<string, OwnedFile>();
  #expected: Snapshot | null = null;
  #branched = false;
  #next = 0;
  #failed = false;
  #closed = false;

  constructor(registration: unknown, draft: unknown, taskId: string) {
    this.#registration = parseCompanyWriteRegistration(registration); this.#draft = parseCompanyWriteDraft(draft, this.#registration);
    this.#paths = deriveCompanyWriteMutationPaths(this.#registration, this.#draft, taskId);
  }

  async prepare(source: CompanyWriteSource): Promise<void> {
    if (this.#closed || this.#failed || this.#expected) fail('INVALID_STATE');
    assertCompanyWriteSource(source);
    const observed = inspect(this.#registration, this.#draft, this.#paths);
    if (!equal(observed.source, source)) fail('SOURCE_CHANGED');
    assertBefore(observed, this.#draft);
    for (const path of [this.#paths.branchTemporary, ...this.#paths.files.map(file => file.temporary)]) if (exists(path)) fail('TEMPORARY_CONFLICT');
    this.#expected = observed;
  }

  async createBranch(): Promise<void> {
    this.assertState(); if (this.#branched) fail('INVALID_STATE');
    try {
      const before = this.verifyCurrent();
      for (const path of [this.#paths.headLock, this.#paths.indexLock, this.#paths.baseRefLock, this.#paths.packedRefsLock]) this.lock(path);
      if (!exists(this.#paths.branchDirectory)) { assertDirectories(this.#paths.root, before.directories); fs.mkdirSync(this.#paths.branchDirectory, { mode: 0o700 }); syncDirectory(dirname(this.#paths.branchDirectory)); }
      directory(this.#paths.branchDirectory, this.#paths.root); this.lock(this.#paths.branchLock);
      const head = this.#held.get(this.#paths.headLock)!, reference = this.open(this.#paths.branchTemporary);
      this.write(reference, `${this.#registration.baseCommit}\n`, 0o600);
      this.write(head, `ref: refs/heads/${this.#draft.branch}\n`, before.head.metadata.mode & 0o777);
      const guarded = inspect(this.#registration, this.#draft, this.#paths, this.#held);
      unchanged(before, guarded, -1, true); assertFileMetadata(this.#paths.head, before.head);
      this.publishNew(reference, this.#paths.branchRef); syncDirectory(this.#paths.branchDirectory);
      assertOwned(head); assertFileMetadata(this.#paths.head, before.head); assertDirectories(this.#paths.root, guarded.directories);
      fs.renameSync(head.path, this.#paths.head); head.active = false; this.#held.delete(head.path); syncDirectory(dirname(this.#paths.head));
      this.#branched = true; this.lock(this.#paths.headLock);
      const after = inspect(this.#registration, this.#draft, this.#paths, this.#held, true);
      unchanged(before, after, -1, true); this.#expected = after;
    } catch (error) { this.#failed = true; throw error; }
  }

  async writeFile(index: number): Promise<void> {
    this.assertState();
    if (!this.#branched || index !== this.#next || !Number.isSafeInteger(index) || index < 0 || index >= this.#draft.changes.length) fail('INVALID_WRITE_ORDER');
    try {
      const before = this.verifyCurrent(), file = this.#paths.files[index]!, change = this.#draft.changes[index]!;
      const temporary = this.open(file.temporary), prior = before.files[index]!;
      this.write(temporary, change.content, prior ? prior.metadata.mode & 0o777 : 0o600);
      const candidate = readBounded(temporary.path, getCompanyWriteLimits().maxContentBytes);
      if (candidate.hash !== hashCompanyWriteValue(change.content)) fail('WRITE_FAILED');
      this.verifyCurrent(); assertOwned(temporary); assertFileMetadata(file.target, prior);
      if (change.operation === 'create') this.publishNew(temporary, file.target);
      else { fs.renameSync(temporary.path, file.target); temporary.active = false; }
      syncDirectory(file.parent);
      const after = inspect(this.#registration, this.#draft, this.#paths, this.#held, true); unchanged(before, after, index);
      const written = after.files[index];
      if (!written || written.hash !== hashCompanyWriteValue(change.content) || written.metadata.size !== Buffer.byteLength(change.content)
        || (written.metadata.mode & 0o777) !== (prior ? prior.metadata.mode & 0o777 : 0o600)) fail('WRITE_FAILED');
      this.#expected = after; this.#next++;
    } catch (error) { this.#failed = true; throw error; }
  }

  async verifyApplied(): Promise<void> {
    this.assertState();
    if (!this.#branched || this.#next !== this.#draft.changes.length) fail('INCOMPLETE_APPLICATION');
    const current = this.verifyCurrent();
    this.#draft.changes.forEach((change, index) => { if (current.files[index]?.hash !== hashCompanyWriteValue(change.content)) fail('SOURCE_CHANGED'); });
  }

  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; let failed = false;
    for (const file of [...this.#owned].reverse()) {
      try {
        if (file.active) {
          if (this.#expected) assertDirectories(this.#paths.root, this.#expected.directories);
          directory(dirname(file.path), this.#paths.root); assertOwned(file);
          fs.unlinkSync(file.path); file.active = false; syncDirectory(dirname(file.path));
        }
      } catch { failed = true; }
      try { if (!file.closed) { fs.closeSync(file.descriptor); file.closed = true; } } catch { failed = true; }
    }
    this.#held.clear(); if (failed) fail('CLEANUP_FAILED');
  }

  private assertState(): void {
    if (!this.#expected || this.#failed || this.#closed) fail('INVALID_STATE');
  }
  private verifyCurrent(): Snapshot {
    this.assertState();
    const current = inspect(this.#registration, this.#draft, this.#paths, this.#held, this.#branched);
    unchanged(this.#expected!, current); return current;
  }
  private open(path: string): OwnedFile {
    if (this.#expected) assertDirectories(this.#paths.root, this.#expected.directories);
    directory(dirname(path), this.#paths.root);
    const descriptor = fs.openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const value = fs.fstatSync(descriptor), file = { path, descriptor, metadata: metadata(value), active: true, closed: false };
    this.#owned.push(file);
    if (!value.isFile() || value.uid !== process.getuid?.() || value.nlink !== 1 || (value.mode & 0o7777) !== 0o600) fail('UNSAFE_SOURCE');
    if (this.#expected) assertDirectories(this.#paths.root, this.#expected.directories);
    if (fs.realpathSync(path) !== path) fail('UNSAFE_SOURCE');
    return file;
  }
  private lock(path: string): void {
    const file = this.open(path); fs.fsyncSync(file.descriptor); file.metadata = metadata(fs.fstatSync(file.descriptor));
    this.#held.set(path, file); syncDirectory(dirname(path));
  }
  private write(file: OwnedFile, text: string, mode: number): void {
    assertOwned(file); const bytes = Buffer.from(text, 'utf8'); let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(file.descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail('WRITE_FAILED'); offset += count;
    }
    fs.fchmodSync(file.descriptor, mode); fs.fsyncSync(file.descriptor); file.metadata = metadata(fs.fstatSync(file.descriptor));
    assertOwned(file);
  }
  private publishNew(file: OwnedFile, target: string): void {
    assertOwned(file); if (exists(target)) fail('CREATE_CONFLICT');
    fs.linkSync(file.path, target);
    const published = fs.lstatSync(target), pending = fs.lstatSync(file.path);
    if (!equal(identity(published), identity(pending)) || published.nlink !== 2 || pending.nlink !== 2) fail('OWNERSHIP_CHANGED');
    fs.unlinkSync(file.path); file.active = false;
  }
}
