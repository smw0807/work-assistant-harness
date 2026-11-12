import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import git from 'isomorphic-git';
import type { BranchWorkType } from '../domain/branch.js';
import type { LocalBranchObservation, LocalBranchPlan, LocalBranchRepository } from '../domain/local-branch.js';
import { HarnessError } from '../domain/errors.js';
import type { LocalBranchWorkspacePort } from '../ports/local-branch.js';
import { assertLocalBranchPlan } from '../policy/local-branch-policy.js';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const workTypes = ['feature', 'fix', 'chore', 'refactor'];
const files = Object.freeze({
  'README.md': '# Synthetic branch repository\n\nNo company code, credentials, scripts or network configuration.\n',
  'src/message.mjs': "export const message = 'synthetic baseline';\n",
});
const author = { name: 'Synthetic Branch', email: 'branch@example.invalid', timestamp: 1704067200, timezoneOffset: 0 };
const commitMessage = 'Synthetic local branch fixture';
const maxEntries = 64;
const maxBytes = 65_536;
const unsafe = (): HarnessError => new HarnessError('LOCAL_BRANCH_UNSAFE_WORKSPACE');
const sameMetadata = (left: fs.Stats, right: fs.Stats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink && left.size === right.size
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
const objectId = (type: 'blob' | 'tree' | 'commit', bytes: Buffer): string => createHash('sha1')
  .update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
const readmeOid = objectId('blob', Buffer.from(files['README.md']));
const messageOid = objectId('blob', Buffer.from(files['src/message.mjs']));
const sourceTreeOid = objectId('tree', Buffer.concat([Buffer.from('100644 message.mjs\0'), Buffer.from(messageOid, 'hex')]));
const rootTreeOid = objectId('tree', Buffer.concat([
  Buffer.from('100644 README.md\0'), Buffer.from(readmeOid, 'hex'), Buffer.from('40000 src\0'), Buffer.from(sourceTreeOid, 'hex'),
]));
const authorText = `${author.name} <${author.email}> ${author.timestamp} +0000`;
const baseCommit = objectId('commit', Buffer.from(`tree ${rootTreeOid}\nauthor ${authorText}\ncommitter ${authorText}\n\n${commitMessage}\n`));
const directoryPaths = new Set(['', 'src', '.git', '.git/hooks', '.git/info', '.git/objects', '.git/objects/info',
  '.git/objects/pack', '.git/refs', '.git/refs/heads', '.git/refs/tags']);
const filePaths = new Set(['README.md', 'src/message.mjs', '.git/HEAD', '.git/config', '.git/index', '.git/refs/heads/main']);
for (const oid of [readmeOid, messageOid, sourceTreeOid, rootTreeOid, baseCommit]) {
  directoryPaths.add(`.git/objects/${oid.slice(0, 2)}`);
  filePaths.add(`.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
}

const canonicalDirectory = (path: string, mode: number): fs.Stats => {
  const metadata = fs.lstatSync(path);
  if (resolve(path) !== path || fs.realpathSync(path) !== path || !metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== mode) throw unsafe();
  return metadata;
};

/** 이름을 열거할 때 상한을 확인하며 예상 밖 파일의 본문은 읽지 않는다. */
const namesIn = (path: string, before: fs.Stats): string[] => {
  const names: string[] = [];
  const directory = fs.opendirSync(path);
  try {
    let entry: fs.Dirent | null;
    while ((entry = directory.readSync()) !== null) {
      names.push(entry.name);
      if (names.length > maxEntries) throw unsafe();
    }
  } finally { directory.closeSync(); }
  if (!sameMetadata(before, fs.lstatSync(path)) || fs.realpathSync(path) !== path) throw unsafe();
  return names.sort();
};

const readFile = (path: string, expected: fs.Stats, maximum: number): Buffer => {
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1 || expected.uid !== process.getuid?.()
    || expected.size > maximum || !sameMetadata(expected, fs.lstatSync(path))) throw unsafe();
  const descriptor = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameMetadata(expected, fs.fstatSync(descriptor))) throw unsafe();
    const output = Buffer.alloc(expected.size + 1);
    let count = 0;
    while (count < output.length) {
      const read = fs.readSync(descriptor, output, count, output.length - count, count);
      if (read === 0) break;
      count += read;
    }
    if (count !== expected.size || !sameMetadata(expected, fs.fstatSync(descriptor))
      || !sameMetadata(expected, fs.lstatSync(path))) throw unsafe();
    return output.subarray(0, count);
  } finally { fs.closeSync(descriptor); }
};

interface TreeObservation {
  hash: string;
  mainOid: string;
  branchOid: string | null;
}

/** 전체 경로·메타데이터를 먼저 확인한 뒤 승인한 파일만 제한된 크기로 읽는다. */
const observeTree = (root: string, frozen: boolean, branchName?: string): TreeObservation => {
  const entries = new Map<string, fs.Stats>();
  const typePath = branchName ? `.git/refs/heads/${branchName.split('/')[0]}` : null;
  const refPath = branchName ? `.git/refs/heads/${branchName}` : null;
  let totalBytes = 0;
  const collect = (relative: string): void => {
    if (entries.size >= maxEntries) throw unsafe();
    const isDirectory = directoryPaths.has(relative) || relative === typePath;
    const isFile = filePaths.has(relative) || relative === refPath;
    if (!isDirectory && !isFile) throw unsafe();
    const path = relative ? join(root, relative) : root;
    const metadata = fs.lstatSync(path);
    if (metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || fs.realpathSync(path) !== path) throw unsafe();
    entries.set(relative, metadata);
    if (isDirectory) {
      const mode = !frozen && (relative === '.git/refs/heads' || relative === typePath) ? 0o700 : 0o555;
      if (!metadata.isDirectory() || (metadata.mode & 0o7777) !== mode) throw unsafe();
      for (const name of namesIn(path, metadata)) collect(relative ? `${relative}/${name}` : name);
    } else {
      const mode = relative === refPath ? 0o600 : 0o444;
      totalBytes += metadata.size;
      if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o7777) !== mode || totalBytes > maxBytes) throw unsafe();
    }
  };
  collect('');
  for (const path of [...directoryPaths, ...filePaths]) if (!entries.has(path)) throw unsafe();
  const hash = createHash('sha256');
  let mainOid = '';
  let branchOid: string | null = null;
  for (const [relative, metadata] of [...entries].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    const path = relative ? join(root, relative) : root;
    if (!sameMetadata(metadata, fs.lstatSync(path))) throw unsafe();
    if (metadata.isDirectory()) {
      namesIn(path, metadata);
      if (relative !== typePath) hash.update(JSON.stringify(['directory', relative, metadata.mode & 0o7777]));
    } else {
      const bytes = readFile(path, metadata, maxBytes);
      if (relative === '.git/HEAD' && bytes.toString('utf8') !== 'ref: refs/heads/main\n') throw unsafe();
      if (relative === '.git/refs/heads/main') {
        if (bytes.toString('utf8') !== `${baseCommit}\n`) throw unsafe();
        mainOid = baseCommit;
      }
      if (relative === refPath) {
        if (bytes.toString('utf8') !== `${baseCommit}\n`) throw unsafe();
        branchOid = baseCommit;
      } else {
        hash.update(JSON.stringify(['file', relative, metadata.mode & 0o7777, bytes.length]));
        hash.update(bytes);
      }
    }
    if (relative !== typePath && relative !== refPath) hash.update('\0');
  }
  // 파일을 읽는 동안 경로 목록이 바뀐 경우도 성공 관찰로 남기지 않는다.
  for (const [relative, metadata] of entries) if (!sameMetadata(metadata, fs.lstatSync(relative ? join(root, relative) : root))) throw unsafe();
  return { hash: hash.digest('hex'), mainOid, branchOid };
};

const normalizeModes = (root: string, frozen: boolean): void => {
  const visit = (relative: string): void => {
    const path = relative ? join(root, relative) : root;
    const metadata = fs.lstatSync(path);
    if (metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw unsafe();
    if (directoryPaths.has(relative) && metadata.isDirectory()) {
      for (const name of namesIn(path, metadata)) visit(relative ? `${relative}/${name}` : name);
      fs.chmodSync(path, !frozen && relative === '.git/refs/heads' ? 0o700 : 0o555);
    } else if (filePaths.has(relative) && metadata.isFile() && metadata.nlink === 1 && metadata.size <= maxBytes) {
      fs.chmodSync(path, 0o444);
    } else throw unsafe();
  };
  visit('');
};

const initialize = async (root: string, frozen: boolean): Promise<void> => {
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(join(root, 'src'), { mode: 0o700 });
  for (const [path, content] of Object.entries(files)) fs.writeFileSync(join(root, path), content, { flag: 'wx', mode: 0o600 });
  await git.init({ fs, dir: root, defaultBranch: 'main' });
  for (const filepath of Object.keys(files).sort()) await git.add({ fs, dir: root, filepath });
  const commit = await git.commit({ fs, dir: root, message: commitMessage, author, committer: author });
  if (commit !== baseCommit) throw new HarnessError('LOCAL_BRANCH_FIXTURE_MISMATCH');
  normalizeModes(root, frozen);
};

export class SyntheticLocalBranchWorkspace implements LocalBranchWorkspacePort {
  readonly mode = 'local-synthetic' as const;

  constructor(private readonly dataDirectory: string) {}

  async prepare(taskId: string, workType: BranchWorkType): Promise<LocalBranchRepository> {
    try {
      if (typeof taskId !== 'string' || !uuid.test(taskId) || !workTypes.includes(workType)) throw new HarnessError('LOCAL_BRANCH_INVALID_PLAN');
      canonicalDirectory(this.dataDirectory, 0o700);
      const parent = join(this.dataDirectory, 'git-branches');
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
      canonicalDirectory(parent, 0o700);
      const root = join(parent, taskId);
      // 재시작이나 중복 계획 생성이 기존 작업 영역을 초기화하지 못하게 한다.
      fs.mkdirSync(root, { mode: 0o700 });
      canonicalDirectory(root, 0o700);
      const ownerToken = randomBytes(32).toString('hex');
      fs.writeFileSync(join(root, 'owner.json'), JSON.stringify({
        policy: 'local-synthetic-branch-v1', taskId, workType, ownerId: `os-user:${process.getuid?.()}`, ownerToken,
      }), { flag: 'wx', mode: 0o600 });
      await initialize(join(root, 'source'), true);
      await initialize(join(root, 'workspace'), false);
      const source = observeTree(join(root, 'source'), true);
      const workspace = observeTree(join(root, 'workspace'), false);
      return { root, ownerToken, baseBranch: 'main', baseCommit, sourceHash: source.hash, workspaceHash: workspace.hash };
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('LOCAL_BRANCH_PREPARE_FAILED');
    }
  }

  observe(plan: LocalBranchPlan): LocalBranchObservation {
    try {
      assertLocalBranchPlan(plan);
      this.assertOwner(plan);
      const source = observeTree(join(plan.repository.root, 'source'), true);
      const workspace = observeTree(join(plan.repository.root, 'workspace'), false, plan.branchName);
      if (source.hash !== plan.repository.sourceHash || workspace.hash !== plan.repository.workspaceHash
        || plan.repository.baseBranch !== 'main' || plan.repository.baseCommit !== baseCommit) throw unsafe();
      return { state: workspace.branchOid === null ? 'absent' : 'created', sourceHash: source.hash,
        workspaceHash: workspace.hash, baseOid: baseCommit, branchOid: workspace.branchOid, reason: null };
    } catch {
      return { state: 'unsafe', sourceHash: null, workspaceHash: null, baseOid: null, branchOid: null, reason: 'LOCAL_BRANCH_UNSAFE_WORKSPACE' };
    }
  }

  createRef(plan: LocalBranchPlan): void {
    const before = this.observe(plan);
    if (before.state === 'unsafe') throw unsafe();
    if (before.state !== 'absent') throw new HarnessError('LOCAL_BRANCH_REF_EXISTS');
    try {
      const parent = join(plan.repository.root, 'workspace', '.git', 'refs', 'heads', plan.workType);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
      canonicalDirectory(parent, 0o700);
      // mkdir 이후 다시 전체 경계를 검증한 뒤 정확한 ref 하나만 배타적으로 만든다.
      if (this.observe(plan).state !== 'absent') throw unsafe();
      const path = join(plan.repository.root, 'workspace', '.git', 'refs', 'heads', plan.branchName);
      // Node permission 모드는 fsync를 금지하므로 파일을 O_SYNC로 열어 동기 쓰기를 요청한다.
      const descriptor = fs.openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_SYNC, 0o600);
      try {
        const bytes = Buffer.from(`${baseCommit}\n`);
        let written = 0;
        while (written < bytes.length) {
          const count = fs.writeSync(descriptor, bytes, written, bytes.length - written);
          if (count === 0) throw unsafe();
          written += count;
        }
      } finally { fs.closeSync(descriptor); }
      if (this.observe(plan).state !== 'created') throw unsafe();
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('LOCAL_BRANCH_REF_WRITE_FAILED');
    }
  }

  private assertOwner(plan: LocalBranchPlan): void {
    canonicalDirectory(this.dataDirectory, 0o700);
    const parent = join(this.dataDirectory, 'git-branches');
    canonicalDirectory(parent, 0o700);
    const expectedRoot = join(parent, plan.taskId);
    if (plan.repository.root !== expectedRoot || plan.ownerId !== `os-user:${process.getuid?.()}`
      || plan.branchName !== `${plan.workType}/task-${plan.taskId}`) throw unsafe();
    const rootMetadata = canonicalDirectory(expectedRoot, 0o700);
    if (JSON.stringify(namesIn(expectedRoot, rootMetadata)) !== JSON.stringify(['owner.json', 'source', 'workspace'])) throw unsafe();
    const path = join(expectedRoot, 'owner.json');
    const metadata = fs.lstatSync(path);
    if ((metadata.mode & 0o7777) !== 0o600) throw unsafe();
    const expected = JSON.stringify({ policy: 'local-synthetic-branch-v1', taskId: plan.taskId, workType: plan.workType,
      ownerId: plan.ownerId, ownerToken: plan.repository.ownerToken });
    if (readFile(path, metadata, 1024).toString('utf8') !== expected) throw unsafe();
  }
}
