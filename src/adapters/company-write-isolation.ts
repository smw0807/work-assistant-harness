import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';

export interface CompanyWriteIsolationPaths {
  repositoryRoot: string;
  readPaths: readonly string[];
  writePaths: readonly string[];
  metadataPaths?: readonly string[];
}
export interface CompanyWriteIsolationInput extends CompanyWriteIsolationPaths {
  input: string;
  signal?: AbortSignal;
}

const fail = (suffix: string): never => { throw new HarnessError(`COMPANY_WRITE_${suffix}`); };
const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harnessRoot = resolve(codeRoot, '../..');
export const companyWriteIsolationLimits = Object.freeze({ timeoutMs: 30_000, killGraceMs: 250,
  maxOutputBytes: 16_384, maxInputBytes: 327_680, maxOldSpaceMb: 128 });

const assertPath: (value: unknown) => asserts value is string = value => {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.length > 4096
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) fail('INVALID_ISOLATION_PATH');
};
const canonicalParent = (path: string): void => {
  for (let current = path; ; current = dirname(current)) {
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || realpathSync(current) !== current) fail('INVALID_ISOLATION_PATH');
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (current === dirname(current)) fail('INVALID_ISOLATION_PATH');
  }
};

/** Exact paths come from the trusted source validator, never from repository text or a supplied SBPL profile. */
export const companyWriteSandboxProfile = (paths: CompanyWriteIsolationPaths): string => {
  try {
    assertPath(paths.repositoryRoot); canonicalParent(paths.repositoryRoot);
    if (!lstatSync(paths.repositoryRoot).isDirectory()) fail('INVALID_ISOLATION_PATH');
    const lists = [paths.readPaths, paths.writePaths, paths.metadataPaths ?? []];
    if (lists.some(list => !Array.isArray(list) || list.length > 128)) fail('INVALID_ISOLATION_PATH');
    const metadata = new Set<string>();
    const addMetadata = (path: string): void => {
      for (let current = path; ; current = dirname(current)) {
        metadata.add(current); if (current === dirname(current)) break;
      }
    };
    for (const list of lists) for (const path of list) { assertPath(path); canonicalParent(path); addMetadata(path); }
    const executable = realpathSync(process.execPath), packageJson = join(harnessRoot, 'package.json');
    for (const path of [paths.repositoryRoot, executable, codeRoot, packageJson]) addMetadata(path);
    const literal = (path: string): string => `(literal ${JSON.stringify(path)})`;
    const exact = (values: readonly string[]): string => [...new Set(values)].map(literal).join(' ');
    return [
      '(version 1)', '(deny default)', '(import "dyld-support.sb")',
      `(allow process-exec ${literal(executable)})`,
      '(deny process-fork)', '(allow sysctl-read)', '(allow mach-bootstrap)', '(allow syscall*)',
      `(allow file-map-executable (subpath "/System/Library") (subpath "/usr/lib") ${literal(executable)})`,
      `(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") ${literal(executable)} (literal "/dev/null") (literal "/dev/urandom"))`,
      `(allow file-read* (subpath ${JSON.stringify(codeRoot)}) ${literal(packageJson)})`,
      `(allow file-read-metadata ${exact([...metadata])})`,
      ...(paths.readPaths.length ? [`(allow file-read-data ${exact(paths.readPaths)})`] : []),
      ...(paths.writePaths.length ? [`(allow file-write* ${exact(paths.writePaths)})`] : []),
      '(allow file-write-data (literal "/dev/null"))',
    ].join('\n');
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError('COMPANY_WRITE_INVALID_ISOLATION_PATH');
  }
};

/** A trusted guardian keeps stdin open and kills its worker on parent death, cancellation, or a fixed budget. */
export const runIsolatedCompanyWriteWorker = (request: CompanyWriteIsolationInput): Promise<string> => {
  if (process.platform !== 'darwin') return Promise.reject(new HarnessError('COMPANY_WRITE_ISOLATION_UNSUPPORTED'));
  let profile: string;
  try {
    profile = companyWriteSandboxProfile(request);
    if (typeof request.input !== 'string' || /[\r\n]/u.test(request.input)
      || Buffer.byteLength(request.input) > companyWriteIsolationLimits.maxInputBytes) fail('INVALID_WORKER_INPUT');
  } catch (error) { return Promise.reject(error); }
  if (request.signal?.aborted) return Promise.reject(new HarnessError('COMPANY_WRITE_WORKER_ABORTED'));
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--no-addons', '--disable-proto=throw', '--max-old-space-size=128',
      join(codeRoot, 'cli/company-write-process.js')], {
      cwd: request.repositoryRoot, env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const output: Buffer[] = []; let bytes = 0, failure: string | null = null;
    const cancel = (code: string): void => {
      failure ??= code;
      if (child.connected) child.send({ cancel: true }, () => undefined);
    };
    const abort = (): void => cancel('WORKER_ABORTED');
    const timeout = setTimeout(() => cancel('WORKER_TIMEOUT'), companyWriteIsolationLimits.timeoutMs);
    request.signal?.addEventListener('abort', abort, { once: true });
    const consume = (chunk: Buffer, stdout: boolean): void => {
      bytes += chunk.length;
      if (bytes > companyWriteIsolationLimits.maxOutputBytes) cancel('WORKER_OUTPUT_LIMIT');
      else if (stdout && !failure) output.push(chunk);
    };
    child.stdout!.on('data', (chunk: Buffer) => consume(chunk, true));
    child.stderr!.on('data', (chunk: Buffer) => consume(chunk, false));
    child.on('message', message => {
      if (message && typeof message === 'object' && 'failure' in message
        && ['WORKER_TIMEOUT', 'WORKER_OUTPUT_LIMIT', 'WORKER_ABORTED'].includes(String(message.failure))) failure ??= String(message.failure);
    });
    child.on('error', () => { failure ??= 'WORKER_FAILED'; });
    child.on('close', code => {
      clearTimeout(timeout); request.signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) reject(new HarnessError(`COMPANY_WRITE_${failure ?? 'WORKER_FAILED'}`));
      else resolveResult(Buffer.concat(output).toString('utf8'));
    });
    child.send({ profile, repositoryRoot: request.repositoryRoot, input: request.input }, () => undefined);
  });
};
