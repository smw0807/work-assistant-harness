import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';

export const isInside = (root: string, path: string): boolean => {
  const difference = relative(root, path);
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
};

export const defaultDataDirectory = (): string => {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'work-assistant-harness');
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Local', 'work-assistant-harness');
  return join(homedir(), '.local', 'share', 'work-assistant-harness');
};

export const prepareDataDirectory = async (requested: string, sourceRoot: string): Promise<string> => {
  const absolute = resolve(requested);
  if (isInside(sourceRoot, absolute) || isInside(absolute, sourceRoot)) {
    throw new HarnessError('DATA_DIRECTORY_OVERLAPS_SOURCE');
  }
  // 기존 디렉터리 권한은 바꾸지 않는다. 이 앱이 쓸 비공개 폴더를 별도로 선택해야 한다.
  if (runtimePathMetadata(absolute)?.isSymbolicLink()) throw new HarnessError('UNSAFE_DATA_DIRECTORY');
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const canonical = await realpath(absolute);
  if (isInside(sourceRoot, canonical) || isInside(canonical, sourceRoot)) {
    throw new HarnessError('DATA_DIRECTORY_OVERLAPS_SOURCE');
  }
  const directoryStat = await stat(canonical);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0
    || (process.getuid && directoryStat.uid !== process.getuid())) {
    throw new HarnessError('DATA_DIRECTORY_NOT_PRIVATE');
  }
  // SQLite의 저널과 보고서가 symlink를 통해 쓰기 허용 경로를 벗어나지 않게 한다.
  for (const name of ['tasks.sqlite', 'harness-lock.sqlite']) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) assertRuntimeFile(join(canonical, `${name}${suffix}`));
  }
  for (const name of ['reports', 'runs']) {
    const candidate = join(canonical, name);
    const metadata = runtimePathMetadata(candidate);
    if (metadata) {
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new HarnessError('UNSAFE_DATA_DIRECTORY');
      }
    }
  }
  return canonical;
};

export const acquireRuntimeLease = (directory: string): (() => void) => {
  const filePath = join(directory, 'harness-lock.sqlite');
  for (const suffix of ['', '-journal', '-wal', '-shm']) assertRuntimeFile(`${filePath}${suffix}`);
  const database = new DatabaseSync(filePath);
  try {
    database.exec('PRAGMA busy_timeout = 100; BEGIN EXCLUSIVE');
  } catch {
    database.close();
    throw new HarnessError('HARNESS_ALREADY_RUNNING');
  }
  return () => database.close();
};

export const assertWorkerPermissions = (sourceRoot: string, dataDirectory: string, repositoryRoot: string): void => {
  const permissions = process.permission;
  if (!permissions || permissions.has('fs.write', sourceRoot)
    || permissions.has('fs.write', repositoryRoot)
    || !permissions.has('fs.write', dataDirectory)
    || permissions.has('child') || permissions.has('worker') || permissions.has('net')
    || permissions.has('addons') || permissions.has('wasi') || permissions.has('inspector')) {
    throw new HarnessError('UNSAFE_WORKER_PERMISSIONS');
  }
};

export const assertSlackReceiverPermissions = (sourceRoot: string, dataDirectory: string, live: boolean): void => {
  const permissions = process.permission;
  if (!permissions || permissions.has('fs.write', sourceRoot)
    || !permissions.has('fs.write', dataDirectory) || permissions.has('child') || permissions.has('worker')
    || permissions.has('addons') || permissions.has('wasi') || permissions.has('inspector')
    || permissions.has('net') !== live) {
    throw new HarnessError('SLACK_UNSAFE_RECEIVER_PERMISSIONS');
  }
};

export const assertSafeEventFile = async (requested: string): Promise<string> => {
  const absolute = resolve(requested);
  const canonical = await realpath(absolute);
  const eventStat = await stat(canonical);
  if (!eventStat.isFile() || eventStat.size > 64_000) throw new HarnessError('INVALID_EVENT_FILE');
  return canonical;
};

// Node permission 플래그에는 정규화한 절대 경로만 전달한다.
export const safeReadFlag = (filePath: string): string => {
  if (!isAbsolute(filePath) || filePath.includes('*') || filePath.includes(',')) {
    throw new HarnessError('UNSUPPORTED_RUNTIME_PATH');
  }
  return `--allow-fs-read=${filePath}`;
};
