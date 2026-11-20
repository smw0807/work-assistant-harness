import fs, { constants, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import git from 'isomorphic-git';
import type { CompanyChangeDraft } from '../domain/company-change.js';
import type { SyntheticCompanyChangePlan, SyntheticCompanyChangeSource } from '../domain/synthetic-company-change.js';
import { HarnessError } from '../domain/errors.js';
import type { SyntheticCompanyChangeWorkspacePort } from '../ports/synthetic-company-change.js';
import { hashCompanyChangeValue, parseCompanyChangeDraft } from '../policy/company-change.js';
import { canonicalReadonlyJson } from '../policy/readonly-investigation-policy.js';
import { assertSyntheticCompanyChangeDraftForPlan, getSyntheticCompanyChangeLimits } from '../policy/synthetic-company-change.js';

export const SYNTHETIC_COMPANY_CHANGE_FILES: Readonly<Record<string, string>> = Object.freeze({
  'README.md': '# Synthetic company change repository\n\nNo company data, credentials or executable checks.\n',
  'src/message.ts': "export const message = 'before';\n",
  'src/options.ts': 'export const options = { enabled: false };\n',
});
const author = { name: 'Synthetic Company Change', email: 'change@example.invalid', timestamp: 1704067200, timezoneOffset: 0 };
const factoryToken = Symbol('synthetic-company-change-factory');
const fail: (suffix?: string) => never = (suffix = 'UNSAFE_WORKSPACE') => { throw new HarnessError(`SYNTHETIC_COMPANY_CHANGE_${suffix}`); };
const digest = (value: unknown): string => hashCompanyChangeValue(canonicalReadonlyJson(value));
const identity = (value: Pick<Stats, 'dev' | 'ino' | 'uid' | 'gid' | 'mode'>) => ({ dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mode: value.mode });
const metadata = (value: Stats) => ({ ...identity(value), nlink: value.nlink, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs });
type Identity = ReturnType<typeof identity>;
type Metadata = ReturnType<typeof metadata>;
const same = (left: unknown, right: unknown): boolean => canonicalReadonlyJson(left) === canonicalReadonlyJson(right);
const owned = (left: Identity, right: Stats): boolean => same(left, identity(right));
const exists = (path: string): boolean => {
  try { fs.lstatSync(path); return true; }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
};
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);
const directory = (path: string): Stats => {
  const value = fs.lstatSync(path);
  if (resolve(path) !== path || fs.realpathSync(path) !== path || !value.isDirectory() || value.isSymbolicLink()
    || value.uid !== process.getuid?.() || (value.mode & 0o7777) !== 0o700) fail();
  return value;
};
const syncDirectory = (path: string): void => {
  const descriptor = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!fs.fstatSync(descriptor).isDirectory()) fail(); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
};
const readFile = (path: string, expected: Stats, maximum: number): Buffer => {
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 || expected.uid !== process.getuid?.()
    || (expected.mode & 0o7000) !== 0 || expected.size > maximum || !same(metadata(expected), metadata(fs.lstatSync(path)))) fail();
  const descriptor = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(metadata(expected), metadata(fs.fstatSync(descriptor)))) fail();
    const bytes = Buffer.alloc(expected.size + 1); let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, length);
      if (count === 0) break; length += count;
    }
    if (length !== expected.size || !same(metadata(expected), metadata(fs.fstatSync(descriptor)))
      || !same(metadata(expected), metadata(fs.lstatSync(path))) || fs.realpathSync(path) !== path) fail();
    return bytes.subarray(0, length);
  } finally { fs.closeSync(descriptor); }
};
interface Entry { kind: 'directory' | 'file'; metadata: Metadata; hash: string | null }
interface Tree { entries: Map<string, Entry>; hash: string; bytes: number }
const scan = (root: string, ignored = new Set<string>()): Tree => {
  const limits = getSyntheticCompanyChangeLimits(), entries = new Map<string, Entry>(); let bytes = 0, observed = 0;
  const collect = (path: string): void => {
    if (++observed > limits.maxSourceEntries + ignored.size) fail('SOURCE_LIMIT');
    const full = path ? join(root, path) : root, value = fs.lstatSync(full);
    if (value.isSymbolicLink() || value.uid !== process.getuid?.() || fs.realpathSync(full) !== full) fail();
    if (ignored.has(path)) return;
    if (path.startsWith('.git/') && (path.endsWith('.lock') || /(?:^|\/)(?:MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|rebase-merge|rebase-apply|BISECT_LOG|commondir|gitdir)$/u.test(path))) fail('GIT_BUSY');
    if (value.isDirectory()) {
      if ((value.mode & 0o7777) !== 0o700) fail();
      entries.set(path, { kind: 'directory', metadata: metadata(value), hash: null });
      const handle = fs.opendirSync(full), names: string[] = [];
      try {
        let item: fs.Dirent | null;
        while ((item = handle.readSync()) !== null) {
          if (names.length >= limits.maxSourceEntries + ignored.size) fail('SOURCE_LIMIT');
          names.push(item.name);
        }
      } finally { handle.closeSync(); }
      if (new Set(names.map(name => name.toLowerCase())).size !== names.length) fail();
      for (const name of names.sort()) collect(path ? `${path}/${name}` : name);
    } else {
      if (!value.isFile() || value.nlink !== 1 || (value.mode & 0o7000) !== 0) fail();
      bytes += value.size;
      if (bytes > limits.maxSourceBytes) fail('SOURCE_LIMIT');
      const content = readFile(full, value, limits.maxSourceBytes);
      entries.set(path, { kind: 'file', metadata: metadata(value), hash: hashCompanyChangeValue(content) });
    }
  };
  collect('');
  if (entries.size > limits.maxSourceEntries) fail('SOURCE_LIMIT');
  for (const [path, entry] of entries) if (!same(entry.metadata, metadata(fs.lstatSync(path ? join(root, path) : root)))) fail('SOURCE_CHANGED');
  return { entries, hash: digest([...entries].sort(([left], [right]) => left.localeCompare(right, 'en'))), bytes };
};
const sameTree = (before: Tree, after: Tree, changed = new Set<string>(), mutableDirectories = new Set<string>()): void => {
  for (const path of new Set([...before.entries.keys(), ...after.entries.keys()])) {
    if (changed.has(path)) continue;
    const first = before.entries.get(path), next = after.entries.get(path);
    if (!first || !next || first.kind !== next.kind) fail('SOURCE_CHANGED');
    if (mutableDirectories.has(path) && first.kind === 'directory') {
      if (!same(identity(first.metadata), identity(next.metadata))) fail('SOURCE_CHANGED');
    } else if (!same(first, next)) fail('SOURCE_CHANGED');
  }
};
const writeAll = (descriptor: number, body: Buffer): void => {
  let offset = 0;
  while (offset < body.length) {
    const written = fs.writeSync(descriptor, body, offset, body.length - offset, offset);
    if (written === 0) fail('WRITE_FAILED'); offset += written;
  }
};
interface OwnedFile { path: string; descriptor: number; identity: Identity }
const exclusiveFile = (path: string): OwnedFile => {
  const descriptor = fs.openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const value = fs.fstatSync(descriptor);
  if (!value.isFile() || value.nlink !== 1 || value.uid !== process.getuid?.() || (value.mode & 0o7777) !== 0o600) {
    fs.closeSync(descriptor); fail();
  }
  return { path, descriptor, identity: identity(value) };
};
const removeOwn = (file: OwnedFile): void => {
  if (exists(file.path)) {
    const current = fs.lstatSync(file.path);
    if (!current.isFile() || !owned(file.identity, current) || current.nlink !== 1) fail('OWNERSHIP_CHANGED');
    fs.unlinkSync(file.path); syncDirectory(dirname(file.path));
  }
};

/** Instances can only refer to a fresh harness-created fixture, never an arbitrary existing repository. */
export class SyntheticCompanyChangeWorkspace implements SyntheticCompanyChangeWorkspacePort {
  readonly #root: string;
  readonly #repository: string;
  readonly #parent: string;
  readonly #parentIdentity: Identity;
  readonly #rootIdentity: Identity;
  readonly #repositoryIdentity: Identity;
  readonly #gitBaseline: Tree;
  readonly #baseCommit: string;
  readonly #baseIndexHash: string;
  readonly #rootHash: string;
  #lease: OwnedFile | null = null;
  #observed: Tree | null = null;
  #expected: Tree | null = null;
  #draftHash: string | null = null;
  #planHash: string | null = null;
  #branchCreated = false;
  #nextIndex = 0;

  private constructor(token: symbol, parent: string, root: string, repository: string, baseCommit: string, baseline: Tree) {
    if (token !== factoryToken) fail();
    this.#root = root; this.#repository = repository; this.#parent = parent;
    this.#parentIdentity = identity(directory(parent)); this.#rootIdentity = identity(directory(root));
    this.#repositoryIdentity = identity(directory(repository)); this.#baseCommit = baseCommit;
    this.#baseIndexHash = baseline.entries.get('.git/index')?.hash ?? fail();
    this.#gitBaseline = baseline;
    this.#rootHash = digest({ root: repository, identity: this.#repositoryIdentity, owner: `os-user:${process.getuid?.()}` });
  }

  static async create(parent: string): Promise<SyntheticCompanyChangeWorkspace> {
    if (typeof parent !== 'string' || resolve(parent) !== parent || !process.getuid) fail();
    const roots = [fs.realpathSync(tmpdir()), fs.realpathSync('/private/tmp')];
    if (!roots.some(root => inside(root, parent))) fail('UNSAFE_PARENT');
    const parentMetadata = directory(parent), root = fs.mkdtempSync(join(parent, 'company-change-synthetic-'));
    fs.chmodSync(root, 0o700);
    const repository = join(root, 'repository'); fs.mkdirSync(repository, { mode: 0o700 });
    fs.mkdirSync(join(repository, 'src'), { mode: 0o700 });
    for (const [path, body] of Object.entries(SYNTHETIC_COMPANY_CHANGE_FILES)) fs.writeFileSync(join(repository, path), body, { flag: 'wx', mode: 0o600 });
    await git.init({ fs, dir: repository, gitdir: join(repository, '.git'), defaultBranch: 'main' });
    for (const filepath of Object.keys(SYNTHETIC_COMPANY_CHANGE_FILES).sort()) await git.add({ fs, dir: repository, gitdir: join(repository, '.git'), filepath });
    const commit = await git.commit({ fs, dir: repository, gitdir: join(repository, '.git'), message: 'Synthetic company change baseline', author, committer: author });
    const normalize = (path: string): void => {
      const value = fs.lstatSync(path);
      if (value.isSymbolicLink() || value.uid !== process.getuid?.()) fail();
      if (value.isDirectory()) { fs.chmodSync(path, 0o700); for (const name of fs.readdirSync(path)) normalize(join(path, name)); }
      else if (value.isFile() && value.nlink === 1) fs.chmodSync(path, 0o600); else fail();
    };
    normalize(repository);
    if (!same(identity(parentMetadata), identity(directory(parent)))) fail('SOURCE_CHANGED');
    const baseline = scan(repository);
    if (baseline.entries.get('.git/HEAD')?.hash !== hashCompanyChangeValue('ref: refs/heads/main\n')
      || baseline.entries.get('.git/refs/heads/main')?.hash !== hashCompanyChangeValue(`${commit}\n`)) fail();
    return new SyntheticCompanyChangeWorkspace(factoryToken, parent, root, repository, commit, baseline);
  }

  get repositoryRoot(): string { return this.#repository; }
  get baseCommit(): string { return this.#baseCommit; }
  get baseIndexHash(): string { return this.#baseIndexHash; }

  async acquire(): Promise<{ release(): Promise<void> }> {
    this.assertRoots();
    if (this.#lease) fail('WORKSPACE_BUSY');
    const path = join(this.#root, 'workspace.lock');
    if (exists(path)) fail('WORKSPACE_BUSY');
    const file = exclusiveFile(path);
    try {
      writeAll(file.descriptor, Buffer.from(canonicalReadonlyJson({ version: 'synthetic-company-change-lease-v1', token: randomUUID(), rootHash: this.#rootHash })));
      fs.fsyncSync(file.descriptor); syncDirectory(this.#root); this.#lease = file;
    } catch (error) {
      try { removeOwn(file); } finally { fs.closeSync(file.descriptor); }
      throw error;
    }
    let released = false;
    return { release: async () => {
      if (released) return;
      try { this.assertLease(); removeOwn(file); }
      finally { fs.closeSync(file.descriptor); this.#lease = null; released = true; }
    } };
  }

  async observe(input: CompanyChangeDraft): Promise<SyntheticCompanyChangeSource> {
    this.assertLease();
    if (this.#branchCreated) fail('SOURCE_CHANGED');
    const draft = this.draft(input), tree = scan(this.#repository);
    this.assertInitialGit(tree);
    let growth = 0, maximumTemporaryBytes = 0;
    for (const change of draft.changes) {
      const entry = tree.entries.get(change.path), parent = dirname(change.path) === '.' ? '' : dirname(change.path);
      if (tree.entries.get(parent)?.kind !== 'directory') fail('MISSING_PARENT');
      if ([...tree.entries.keys()].some(path => path !== change.path && path.toLowerCase() === change.path.toLowerCase())) fail('CREATE_CONFLICT');
      if (change.operation === 'replace') {
        const original = SYNTHETIC_COMPANY_CHANGE_FILES[change.path];
        if (original === undefined || !entry || entry.kind !== 'file' || entry.metadata.size > getSyntheticCompanyChangeLimits().maxContentBytes
          || entry.hash !== change.beforeHash || entry.hash !== hashCompanyChangeValue(original) || (entry.metadata.mode & 0o111) !== 0) fail('BASE_MISMATCH');
      } else if (entry || Object.hasOwn(SYNTHETIC_COMPANY_CHANGE_FILES, change.path)) fail('CREATE_CONFLICT');
      const nextBytes = Buffer.byteLength(change.content); growth += Math.max(0, nextBytes - (entry?.metadata.size ?? 0));
      maximumTemporaryBytes = Math.max(maximumTemporaryBytes, nextBytes);
    }
    if (tree.bytes + growth + maximumTemporaryBytes > getSyntheticCompanyChangeLimits().maxSourceBytes
      || tree.entries.size + draft.changes.filter(change => change.operation === 'create').length + 4 > getSyntheticCompanyChangeLimits().maxSourceEntries) fail('SOURCE_LIMIT');
    this.#observed = tree; this.#expected = tree; this.#draftHash = digest(draft); this.#planHash = null; this.#nextIndex = 0;
    return this.source(tree);
  }

  async createBranch(plan: SyntheticCompanyChangePlan, input: CompanyChangeDraft): Promise<void> {
    const draft = this.assertPlan(plan, input);
    if (this.#branchCreated || this.#planHash) fail('ALREADY_APPLIED');
    this.verifyCurrent();
    const refRelative = `.git/refs/heads/${draft.branch}`, parentRelative = `.git/refs/heads/${draft.workType}`;
    const ref = join(this.#repository, refRelative), parent = join(this.#repository, parentRelative);
    if (exists(ref) || exists(`${ref}.lock`) || exists(join(this.#repository, '.git/HEAD.lock'))) fail('GIT_BUSY');
    const before = this.#expected!, directories = new Set(['.git', '.git/refs/heads', parentRelative]);
    const changed = new Set(['.git/HEAD', refRelative, ...(!before.entries.has(parentRelative) ? [parentRelative] : [])]);
    let headLock: OwnedFile | null = null, refLock: OwnedFile | null = null;
    try {
      headLock = exclusiveFile(join(this.#repository, '.git/HEAD.lock'));
      if (!exists(parent)) { fs.mkdirSync(parent, { mode: 0o700 }); syncDirectory(dirname(parent)); }
      directory(parent);
      refLock = exclusiveFile(`${ref}.lock`);
      writeAll(refLock.descriptor, Buffer.from(`${this.#baseCommit}\n`)); fs.fsyncSync(refLock.descriptor);
      writeAll(headLock.descriptor, Buffer.from(`ref: refs/heads/${draft.branch}\n`)); fs.fsyncSync(headLock.descriptor);
      const ignored = new Set(['.git/HEAD.lock', `${refRelative}.lock`]);
      sameTree(before, scan(this.#repository, ignored), new Set([...changed].filter(path => path !== '.git/HEAD')), directories);
      this.assertLease();
      if (exists(ref)) fail('GIT_BUSY');
      fs.linkSync(refLock.path, ref); fs.unlinkSync(refLock.path); syncDirectory(parent);
      const currentHead = fs.lstatSync(join(this.#repository, '.git/HEAD'));
      if (!same(metadata(currentHead), before.entries.get('.git/HEAD')!.metadata)) fail('SOURCE_CHANGED');
      fs.renameSync(headLock.path, join(this.#repository, '.git/HEAD')); syncDirectory(join(this.#repository, '.git'));
      const after = scan(this.#repository);
      sameTree(before, after, changed, directories);
      if (after.entries.get('.git/HEAD')?.hash !== hashCompanyChangeValue(`ref: refs/heads/${draft.branch}\n`)
        || after.entries.get(refRelative)?.hash !== hashCompanyChangeValue(`${this.#baseCommit}\n`)) fail('SOURCE_CHANGED');
      this.#expected = after; this.#branchCreated = true; this.#planHash = plan.planHash;
    } finally {
      let cleanupFailed = false;
      for (const file of [refLock, headLock]) if (file) {
        try { removeOwn(file); } catch { cleanupFailed = true; }
        try { fs.closeSync(file.descriptor); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) fail('LOCK_CLEANUP_FAILED');
    }
  }

  async writeFile(plan: SyntheticCompanyChangePlan, input: CompanyChangeDraft, index: number): Promise<void> {
    const draft = this.assertPlan(plan, input);
    if (!this.#branchCreated || this.#planHash !== plan.planHash || index !== this.#nextIndex || !Number.isSafeInteger(index)
      || index < 0 || index >= draft.changes.length) fail('INVALID_WRITE_ORDER');
    this.verifyCurrent();
    const change = draft.changes[index]!, before = this.#expected!, prior = before.entries.get(change.path);
    const destination = join(this.#repository, change.path), parent = dirname(destination);
    const parentRelative = relative(this.#repository, parent), temporaryRelative = `${parentRelative ? `${parentRelative}/` : ''}.company-change-${plan.id}-${index}-${randomUUID()}.tmp`;
    const temporary = exclusiveFile(join(this.#repository, temporaryRelative));
    try {
      writeAll(temporary.descriptor, Buffer.from(change.content, 'utf8'));
      fs.fchmodSync(temporary.descriptor, prior ? prior.metadata.mode & 0o777 : 0o600);
      temporary.identity = identity(fs.fstatSync(temporary.descriptor)); fs.fsyncSync(temporary.descriptor);
      const candidate = fs.fstatSync(temporary.descriptor);
      if (candidate.size !== Buffer.byteLength(change.content) || hashCompanyChangeValue(readFile(temporary.path, candidate, getSyntheticCompanyChangeLimits().maxContentBytes)) !== plan.changes[index]!.afterHash) fail('WRITE_FAILED');
      const current = scan(this.#repository, new Set([temporaryRelative]));
      sameTree(before, current, new Set(), new Set([parentRelative]));
      this.assertLease();
      if (change.operation === 'create') {
        if (exists(destination)) fail('CREATE_CONFLICT');
        fs.linkSync(temporary.path, destination); fs.unlinkSync(temporary.path);
      } else {
        if (!prior || !same(prior.metadata, metadata(fs.lstatSync(destination)))) fail('SOURCE_CHANGED');
        fs.renameSync(temporary.path, destination);
      }
      syncDirectory(parent);
      const after = scan(this.#repository);
      sameTree(before, after, new Set([change.path]), new Set([parentRelative]));
      const written = after.entries.get(change.path);
      if (!written || written.kind !== 'file' || written.hash !== plan.changes[index]!.afterHash
        || written.metadata.size !== plan.changes[index]!.bytes || (written.metadata.mode & 0o777) !== (prior ? prior.metadata.mode & 0o777 : 0o600)) fail('WRITE_FAILED');
      this.#expected = after; this.#nextIndex++;
    } finally {
      try { removeOwn(temporary); } finally { fs.closeSync(temporary.descriptor); }
    }
  }

  async verifyApplied(plan: SyntheticCompanyChangePlan, input: CompanyChangeDraft): Promise<void> {
    const draft = this.assertPlan(plan, input);
    if (!this.#branchCreated || this.#planHash !== plan.planHash || this.#nextIndex !== draft.changes.length) fail('INCOMPLETE_APPLICATION');
    this.verifyCurrent();
    for (const change of plan.changes) if (this.#expected!.entries.get(change.path)?.hash !== change.afterHash) fail('SOURCE_CHANGED');
    if (this.#expected!.entries.get('.git/index')?.hash !== this.#baseIndexHash
      || this.#expected!.entries.get('.git/refs/heads/main')?.hash !== hashCompanyChangeValue(`${this.#baseCommit}\n`)) fail('SOURCE_CHANGED');
  }

  private draft(input: CompanyChangeDraft): CompanyChangeDraft {
    const draft = parseCompanyChangeDraft(input);
    if (draft.repoId !== 'synthetic-company-change' || draft.baseCommit !== this.#baseCommit || draft.baseBranch !== 'main'
      || draft.baseIndexHash !== this.#baseIndexHash || draft.branch.split('/').length !== 2) fail('BASE_MISMATCH');
    return draft;
  }

  private source(tree: Tree): SyntheticCompanyChangeSource {
    return { repositoryId: 'synthetic-company-change', rootHash: this.#rootHash, baseCommit: this.#baseCommit,
      baseBranch: 'main', indexHash: this.#baseIndexHash, sourceHash: tree.hash };
  }

  private assertRoots(): void {
    if (!owned(this.#parentIdentity, directory(this.#parent)) || !owned(this.#rootIdentity, directory(this.#root))
      || !owned(this.#repositoryIdentity, directory(this.#repository))) fail('SOURCE_CHANGED');
  }

  private assertLease(): void {
    this.assertRoots();
    if (!this.#lease) fail('LEASE_REQUIRED');
    const path = fs.lstatSync(this.#lease.path), descriptor = fs.fstatSync(this.#lease.descriptor);
    if (!path.isFile() || path.nlink !== 1 || !owned(this.#lease.identity, path) || !owned(this.#lease.identity, descriptor)) fail('OWNERSHIP_CHANGED');
  }

  private assertInitialGit(tree: Tree): void {
    for (const path of new Set([...tree.entries.keys(), ...this.#gitBaseline.entries.keys()])) {
      if (path === '.git' || path.startsWith('.git/')) {
        if (!same(tree.entries.get(path) ?? null, this.#gitBaseline.entries.get(path) ?? null)) fail('GIT_CHANGED');
      }
    }
  }

  private assertPlan(plan: SyntheticCompanyChangePlan, input: CompanyChangeDraft): CompanyChangeDraft {
    this.assertLease(); assertSyntheticCompanyChangeDraftForPlan(plan, input);
    const draft = this.draft(input);
    if (!this.#observed || !this.#expected || this.#draftHash !== digest(draft) || !same(plan.source, this.source(this.#observed))) fail('SOURCE_CHANGED');
    return draft;
  }

  private verifyCurrent(): void {
    this.assertLease(); if (!this.#expected) fail('SOURCE_CHANGED');
    sameTree(this.#expected, scan(this.#repository));
  }
}

export const createSyntheticCompanyChangeWorkspace = (parent: string): Promise<SyntheticCompanyChangeWorkspace> =>
  SyntheticCompanyChangeWorkspace.create(parent);
