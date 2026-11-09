import { constants } from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import git from 'isomorphic-git';
import { HarnessError } from '../domain/errors.js';
import type { Evidence, ReadRequest, RepositoryPolicy } from '../domain/types.js';
import type { RepoReadPort } from '../ports/index.js';
import { inspectEvidenceText, validateReadRequest, validateRepositoryPolicy } from '../policy/read-policy.js';

const maximumGitObjectBytes = 2 * 1024 * 1024;

const isInside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};

/** 존재하는 각 구성 요소를 검사한다. 커밋에만 남은 파일은 작업 트리에 없어도 된다. */
const assertNoSymbolicLinks = async (root: string, candidate: string): Promise<void> => {
  if (!isInside(root, candidate)) throw new HarnessError('REPOSITORY_PATH_ESCAPE');
  const components = relative(root, candidate).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    try {
      const metadata = await fileSystem.lstat(current);
      if (metadata.isSymbolicLink()) throw new HarnessError('SYMLINK_BLOCKED');
      if (!isInside(root, await fileSystem.realpath(current))) {
        throw new HarnessError('REPOSITORY_PATH_ESCAPE');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
};

/** Git에는 읽기 전용 최소 클라이언트를 주고, 변경 API는 항상 거부한다. */
const createReadOnlyGitFileSystem = (root: string) => {
  const gitRoot = join(root, '.git');
  const guard = async (path: string): Promise<string> => {
    const candidate = resolve(path);
    if (!isInside(gitRoot, candidate)) throw new HarnessError('GIT_PATH_BLOCKED');
    await assertNoSymbolicLinks(root, candidate);
    return candidate;
  };
  const denyWrite = async (): Promise<never> => {
    throw new HarnessError('REPOSITORY_WRITE_BLOCKED');
  };
  const readFile = async (
    path: string,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): Promise<Buffer | string> => {
    const candidate = await guard(path);
    const objectPath = relative(gitRoot, candidate).split(sep).join('/');
    // 초기 버전은 직접 준비한 loose object만 읽어 pack의 무제한 압축 해제를 막는다.
    if (!/^objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/u.test(objectPath)) {
      throw new HarnessError('GIT_OBJECT_FORMAT_BLOCKED');
    }
    const handle = await fileSystem.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > maximumGitObjectBytes) {
        throw new HarnessError('GIT_OBJECT_TOO_LARGE');
      }
      const buffer = Buffer.alloc(maximumGitObjectBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > maximumGitObjectBytes) throw new HarnessError('GIT_OBJECT_TOO_LARGE');
      const bytes = buffer.subarray(0, length);
      try {
        inflateSync(bytes, { maxOutputLength: maximumGitObjectBytes });
      } catch {
        throw new HarnessError('INVALID_OR_OVERSIZED_GIT_OBJECT');
      }
      const encoding = typeof options === 'string' ? options : options?.encoding;
      return encoding ? bytes.toString(encoding) : bytes;
    } finally {
      await handle.close();
    }
  };
  return {
    promises: {
      readFile,
      stat: async (path: string) => fileSystem.stat(await guard(path)),
      lstat: async (path: string) => fileSystem.lstat(await guard(path)),
      readdir: async (path: string) => fileSystem.readdir(await guard(path)),
      readlink: async (path: string): Promise<string> => {
        await guard(path);
        throw new HarnessError('SYMLINK_BLOCKED');
      },
      writeFile: denyWrite,
      appendFile: denyWrite,
      unlink: denyWrite,
      mkdir: denyWrite,
      rmdir: denyWrite,
      rename: denyWrite,
      symlink: denyWrite,
      link: denyWrite,
      chmod: denyWrite,
      truncate: denyWrite,
      open: denyWrite,
    },
  };
};

export class LocalGitReader implements RepoReadPort {
  private readonly policy: RepositoryPolicy;

  constructor(policy: RepositoryPolicy) {
    validateRepositoryPolicy(policy);
    if (!isAbsolute(policy.root)) throw new HarnessError('INVALID_REPOSITORY_POLICY');
    this.policy = Object.freeze({ ...policy, allowedPaths: Object.freeze([...policy.allowedPaths]) }) as RepositoryPolicy;
  }

  async read(request: ReadRequest): Promise<Evidence> {
    try {
      validateReadRequest(this.policy, request);
      if ((await fileSystem.lstat(this.policy.root)).isSymbolicLink()) {
        throw new HarnessError('SYMLINK_BLOCKED');
      }
      const root = await fileSystem.realpath(this.policy.root);
      const gitRoot = join(root, '.git');
      await assertNoSymbolicLinks(root, gitRoot);
      if (!(await fileSystem.lstat(gitRoot)).isDirectory()) {
        throw new HarnessError('GIT_DIRECTORY_REQUIRED');
      }
      await assertNoSymbolicLinks(root, join(root, request.path));
      const fs = createReadOnlyGitFileSystem(root);
      const commit = await git.readCommit({ fs, dir: root, gitdir: gitRoot, oid: this.policy.baseCommit });
      let treeOid = commit.commit.tree;
      const pathComponents = request.path.split('/');
      for (let index = 0; index < pathComponents.length; index += 1) {
        const tree = await git.readTree({ fs, dir: root, gitdir: gitRoot, oid: treeOid });
        const entry = tree.tree.find((item) => item.path === pathComponents[index]);
        if (!entry) throw new HarnessError('COMMITTED_FILE_NOT_FOUND');
        if (entry.mode === '120000') throw new HarnessError('SYMLINK_BLOCKED');
        if (index < pathComponents.length - 1) {
          if (entry.type !== 'tree' || entry.mode !== '040000') {
            throw new HarnessError('INVALID_COMMITTED_PATH');
          }
          treeOid = entry.oid;
          continue;
        }
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
          throw new HarnessError('INVALID_COMMITTED_PATH');
        }
        const blob = await git.readBlob({ fs, dir: root, gitdir: gitRoot, oid: entry.oid });
        const excerpt = inspectEvidenceText(this.policy, request, blob.blob);
        return { ...request, baseCommit: this.policy.baseCommit, excerpt };
      }
      throw new HarnessError('COMMITTED_FILE_NOT_FOUND');
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      // Git/OS 오류에는 호스트 경로나 원문이 들어갈 수 있으므로 외부에 전달하지 않는다.
      throw new HarnessError('REPOSITORY_READ_FAILED');
    }
  }
}
