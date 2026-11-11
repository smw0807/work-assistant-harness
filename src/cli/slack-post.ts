import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';
import { slackPostFixtures, type SlackPostFixture } from '../domain/slack-post.js';
import { assertRuntimeFile, runtimePathMetadata } from '../policy/runtime-path.js';
import { acquireRuntimeLease, defaultDataDirectory, prepareDataDirectory, safeReadFlag } from './runtime.js';

export interface SlackPostWorkerOptions {
  command: 'slack-post-check';
  sourceRoot: string;
  dataDirectory: string;
  fixture: SlackPostFixture | 'all';
  verificationId: string;
}

export const slackPostUsage = `pnpm harness slack-post-check [--fixture all|${slackPostFixtures.join('|')}] [--data-dir <private-directory>]`;

const parseArguments = (arguments_: string[]): Omit<SlackPostWorkerOptions, 'sourceRoot' | 'verificationId'> => {
  if (arguments_[0] !== 'slack-post-check') throw new HarnessError('UNKNOWN_COMMAND');
  const flags = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const flag = arguments_[index] ?? '';
    const value = arguments_[index + 1];
    if (!['--fixture', '--data-dir'].includes(flag) || !value || value.startsWith('--') || flags.has(flag)) {
      throw new HarnessError('INVALID_ARGUMENTS');
    }
    flags.set(flag, value);
  }
  const fixture = flags.get('--fixture') ?? 'all';
  if (fixture !== 'all' && !slackPostFixtures.some((candidate) => candidate === fixture)) {
    throw new HarnessError('INVALID_ARGUMENTS');
  }
  return {
    command: 'slack-post-check', fixture: fixture as SlackPostFixture | 'all',
    dataDirectory: flags.get('--data-dir') ?? defaultDataDirectory(),
  };
};

export const assertPrivateSlackPostPaths = (dataDirectory: string, verificationId?: string): void => {
  if (!process.getuid) throw new HarnessError('LOCAL_OWNER_UNAVAILABLE');
  const uid = process.getuid();
  const directories = [dataDirectory, join(dataDirectory, 'slack-post-checks')];
  if (verificationId) directories.push(join(dataDirectory, 'slack-post-checks', verificationId));
  for (const directory of directories) {
    const metadata = runtimePathMetadata(directory);
    if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.uid !== uid)) {
      throw new HarnessError('SLACK_POST_REPORT_DIRECTORY_NOT_PRIVATE');
    }
  }
  const files = ['', '-journal', '-wal', '-shm'].map((suffix) => join(dataDirectory, `harness-lock.sqlite${suffix}`));
  if (verificationId) files.push(join(dataDirectory, 'slack-post-checks', verificationId, 'report.json'));
  for (const filePath of files) {
    assertRuntimeFile(filePath);
    const metadata = runtimePathMetadata(filePath);
    if (metadata && ((metadata.mode & 0o077) !== 0 || metadata.uid !== uid)) {
      throw new HarnessError('SLACK_POST_REPORT_FILE_NOT_PRIVATE');
    }
  }
};

export const runSlackPostCommand = async (arguments_: string[]): Promise<void> => {
  process.umask(0o077);
  const parsed = parseArguments(arguments_);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = await prepareDataDirectory(parsed.dataDirectory, sourceRoot);
  assertPrivateSlackPostPaths(dataDirectory);
  const release = acquireRuntimeLease(dataDirectory);
  try {
    const options: SlackPostWorkerOptions = { ...parsed, sourceRoot, dataDirectory, verificationId: randomUUID() };
    const executable = await realpath(process.execPath);
    const output = execFileSync(executable, [
      '--permission', safeReadFlag(sourceRoot), safeReadFlag(dataDirectory), `--allow-fs-write=${dataDirectory}`,
      join(sourceRoot, 'dist', 'src', 'cli', 'slack-post-worker.js'), JSON.stringify(options),
    ], {
      cwd: sourceRoot, env: { LANG: 'C.UTF-8', TZ: 'UTC' }, encoding: 'utf8', timeout: 30_000,
      maxBuffer: 128_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output) as { status?: string; liveEnabled?: unknown };
    if (!['passed', 'failed'].includes(result.status ?? '') || result.liveEnabled !== false) {
      throw new HarnessError('SLACK_POST_INVALID_WORKER_RESULT');
    }
    process.stdout.write(output);
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new HarnessError(/^[A-Z][A-Z0-9_]{1,80}$/.test(stderr) ? stderr : 'SLACK_POST_WORKER_FAILED');
  } finally {
    release();
  }
};
