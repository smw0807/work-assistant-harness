import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';
import { getCompanyChangeLimits } from '../policy/company-change.js';
import { isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { companyDirectoryChain, companyPath, companyPathsOverlap } from './company-readonly-files.js';
import { assertCompanyChangeDirectory, assertCompanyChangeFile, prepareCompanyChangeRuntime, validateCompanyChangeRuntime } from './company-change-files.js';
import { companyChangeCommands, companyChangeDisabled, parseCompanyChangeSummary,
  type CompanyChangeCommand, type CompanyChangeSummary, type CompanyChangeWorkerOptions } from './company-change-protocol.js';

export const companyChangeUsage = [
  'pnpm harness company-change-plan --draft <private-json> --data-dir <private-runtime>',
  'pnpm harness company-change-review --task <uuid> --data-dir <private-runtime>',
  'pnpm harness company-change-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> --data-dir <private-runtime>',
  'pnpm harness company-change-inspect --task <uuid> --data-dir <private-runtime>',
  'pnpm harness company-change-cancel --task <uuid> --data-dir <private-runtime>',
  'pnpm harness company-change-prune --data-dir <private-runtime>',
].join('\n');

const parseArguments = (args: string[]) => {
  const command = args[0]?.replace(/^company-change-/u, '') as CompanyChangeCommand;
  if (!args[0]?.startsWith('company-change-') || !companyChangeCommands.includes(command)) throw new HarnessError('UNKNOWN_COMMAND');
  const required = command === 'plan' ? ['--draft', '--data-dir'] : command === 'prune' ? ['--data-dir']
    : command === 'approve' ? ['--task', '--plan-hash', '--expires-in-minutes', '--data-dir'] : ['--task', '--data-dir'];
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (!required.includes(name) || !value || value.startsWith('--') || values.has(name)) throw new HarnessError('INVALID_ARGUMENTS');
    values.set(name, value);
  }
  if (required.some(name => !values.has(name)) || values.has('--task') && !isReadonlyId(values.get('--task'))
    || command === 'approve' && (!/^[a-f0-9]{64}$/u.test(values.get('--plan-hash')!)
      || !/^(?:[1-9]|[1-5][0-9]|60)$/u.test(values.get('--expires-in-minutes')!))) throw new HarnessError('INVALID_ARGUMENTS');
  return { command, values };
};

export interface CompanyChangeWorkerOutcome {
  summary: CompanyChangeSummary | null;
  reason: 'completed' | 'deadline' | 'output_limit' | 'worker_failed' | 'invalid_output';
  failureCode: string | null;
  exitConfirmed: boolean;
}
/** A reply is accepted only after bounded output and the worker's close event are both confirmed. */
export const superviseCompanyChangeWorker = (child: ChildProcessWithoutNullStreams, options: CompanyChangeWorkerOptions,
  startedAt: number): Promise<CompanyChangeWorkerOutcome> => new Promise(resolve => {
  let output = Buffer.alloc(0), errors = Buffer.alloc(0), bytes = 0;
  let reason: CompanyChangeWorkerOutcome['reason'] | null = null, grace: ReturnType<typeof setTimeout> | undefined;
  const terminate = (cause: CompanyChangeWorkerOutcome['reason']): void => {
    if (reason !== null) return;
    reason = cause; child.kill('SIGTERM'); grace = setTimeout(() => { child.kill('SIGKILL'); }, 250);
  };
  const deadline = setTimeout(() => terminate('deadline'), Math.max(0, 30_000 - (performance.now() - startedAt)));
  const append = (chunk: Buffer, stderr: boolean): void => {
    if (reason !== null) return;
    bytes += chunk.length;
    if (bytes > 16_384) { terminate('output_limit'); return; }
    if (stderr) errors = Buffer.concat([errors, chunk]); else output = Buffer.concat([output, chunk]);
  };
  child.stdout.on('data', (chunk: Buffer) => append(chunk, false));
  child.stderr.on('data', (chunk: Buffer) => append(chunk, true));
  child.stdout.on('error', () => terminate('worker_failed')); child.stderr.on('error', () => terminate('worker_failed'));
  child.once('error', () => terminate('worker_failed'));
  child.once('close', (code, signal) => {
    clearTimeout(deadline); if (grace) clearTimeout(grace);
    if (reason === null && performance.now() - startedAt >= 30_000) reason = 'deadline';
    if (reason !== null || code !== 0 || signal !== null) {
      const errorText = errors.toString('utf8');
      const failureCode = reason === null && code === 1 && signal === null && /^COMPANY_CHANGE_[A-Z_]+\n$/u.test(errorText) ? errorText.trim() : null;
      resolve({ summary: null, reason: reason ?? 'worker_failed', failureCode, exitConfirmed: true }); return;
    }
    try {
      if (errors.length !== 0) throw new Error('Conflicting worker output');
      resolve({ summary: parseCompanyChangeSummary(new TextDecoder('utf-8', { fatal: true }).decode(output), options),
        reason: 'completed', failureCode: null, exitConfirmed: true });
    } catch { resolve({ summary: null, reason: 'invalid_output', failureCode: null, exitConfirmed: true }); }
  });
});

export const runCompanyChangeCommand = async (args: string[]): Promise<void> => {
  const { command, values } = parseArguments(args);
  process.umask(0o077);
  const harness = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const runtime = companyPath(values.get('--data-dir'));
  if (companyPathsOverlap(runtime, harness)) throw new HarnessError('COMPANY_CHANGE_UNSAFE_RUNTIME');
  const parentGuard = await companyDirectoryChain(dirname(runtime));
  await assertCompanyChangeDirectory(dirname(runtime));
  const options: CompanyChangeWorkerOptions = { version: 'company-change-worker-input-v1', command,
    harnessDirectory: harness, runtimeDirectory: runtime, taskId: command === 'plan' ? randomUUID() : values.get('--task') ?? null,
    draftFile: null, planHash: values.get('--plan-hash') ?? null,
    expiresInMinutes: values.has('--expires-in-minutes') ? Number(values.get('--expires-in-minutes')) : null };
  let draftGuard: (() => Promise<void>) | null = null;
  if (command === 'plan') {
    options.draftFile = companyPath(values.get('--draft'));
    if ([harness, runtime].some(path => companyPathsOverlap(path, options.draftFile!))) throw new HarnessError('COMPANY_CHANGE_UNSAFE_RUNTIME');
    draftGuard = await companyDirectoryChain(dirname(options.draftFile));
    await assertCompanyChangeDirectory(dirname(options.draftFile));
    await assertCompanyChangeFile(options.draftFile, getCompanyChangeLimits().maxDraftJsonBytes);
  }
  const startedAt = performance.now();
  await prepareCompanyChangeRuntime(runtime, command === 'plan');
  const runtimeGuard = await validateCompanyChangeRuntime(runtime);
  await parentGuard(); if (draftGuard) await draftGuard();
  let outcome: CompanyChangeWorkerOutcome;
  try {
    const executable = await realpath(process.execPath);
    const readPaths = [join(harness, 'dist'), join(harness, 'node_modules'), join(harness, 'package.json'), runtime,
      ...(options.draftFile ? [options.draftFile] : [])];
    const child = spawn(executable, ['--max-old-space-size=128', '--permission', ...readPaths.map(path => `--allow-fs-read=${path}`),
      `--allow-fs-write=${join(runtime, 'store')}`, `--allow-fs-write=${join(runtime, 'reviews')}`,
      join(harness, 'dist/src/cli/company-change-worker.js'), JSON.stringify(options)],
    { cwd: harness, env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdin.on('error', () => { /* No input is sent; bounded output and close determine the result. */ }); child.stdin.end();
    outcome = await superviseCompanyChangeWorker(child, options, startedAt);
  } catch { outcome = { summary: null, reason: 'worker_failed', failureCode: null, exitConfirmed: false }; }
  try { await parentGuard(); await runtimeGuard(); if (draftGuard) await draftGuard(); }
  catch { outcome = { ...outcome, summary: null, reason: 'worker_failed', failureCode: 'COMPANY_CHANGE_UNSAFE_RUNTIME' }; }
  if (outcome.summary) {
    process.stdout.write(`${JSON.stringify({ ...outcome.summary, runStatus: 'succeeded', exitConfirmed: true })}\n`); return;
  }
  process.stdout.write(`${JSON.stringify({ version: 'company-change-result-v1', command, taskId: options.taskId,
    runStatus: 'unknown', reason: outcome.reason, failureCode: outcome.failureCode,
    exitConfirmed: outcome.exitConfirmed, automaticRetry: false, ...companyChangeDisabled })}\n`);
  process.exitCode = 1;
};
