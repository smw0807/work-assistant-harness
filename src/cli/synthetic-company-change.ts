import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';
import { isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { companyDirectoryChain, companyPathsOverlap } from './company-readonly-files.js';
import { prepareSyntheticChangeRuntime, syntheticChangePath, validateSyntheticChangeDraftPath,
  validateSyntheticChangeRuntime } from './synthetic-company-change-files.js';
import { parseSyntheticChangeSummary, syntheticChangeBoundary, syntheticChangeCommands,
  type SyntheticChangeCommand, type SyntheticChangeSummary, type SyntheticChangeWorkerOptions } from './synthetic-company-change-protocol.js';

export const syntheticCompanyChangeUsage = [
  'pnpm harness synthetic-change-init --data-dir <new-private-temporary-runtime>',
  'pnpm harness synthetic-change-plan --draft <private-synthetic-json> --data-dir <runtime>',
  'pnpm harness synthetic-change-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> --draft <private-synthetic-json> --data-dir <runtime>',
  'pnpm harness synthetic-change-apply --task <uuid> --plan-hash <sha256> --draft <private-synthetic-json> --data-dir <runtime>',
  'pnpm harness synthetic-change-inspect --task <uuid> --data-dir <runtime>',
  'pnpm harness synthetic-change-cancel --task <uuid> --data-dir <runtime>',
  'pnpm harness synthetic-change-recover --task <uuid> --plan-hash <sha256> --data-dir <runtime>',
].join('\n');

const parseArguments = (args: string[]) => {
  const command = args[0]?.replace(/^synthetic-change-/u, '') as SyntheticChangeCommand;
  if (!args[0]?.startsWith('synthetic-change-') || !syntheticChangeCommands.includes(command)) throw new HarnessError('UNKNOWN_COMMAND');
  const required = ['--data-dir', ...(command !== 'init' && command !== 'plan' ? ['--task'] : []),
    ...(['plan', 'approve', 'apply'].includes(command) ? ['--draft'] : []),
    ...(['approve', 'apply', 'recover'].includes(command) ? ['--plan-hash'] : []),
    ...(command === 'approve' ? ['--expires-in-minutes'] : [])];
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (!required.includes(name) || !value || value.startsWith('--') || values.has(name)) throw new HarnessError('INVALID_ARGUMENTS');
    values.set(name, value);
  }
  if (required.some(name => !values.has(name)) || values.has('--task') && !isReadonlyId(values.get('--task'))
    || values.has('--plan-hash') && !/^[a-f0-9]{64}$/u.test(values.get('--plan-hash')!)
    || values.has('--expires-in-minutes') && !/^(?:[1-9]|[1-5][0-9]|60)$/u.test(values.get('--expires-in-minutes')!)) throw new HarnessError('INVALID_ARGUMENTS');
  return { command, values };
};
export interface SyntheticChangeWorkerOutcome {
  summary: SyntheticChangeSummary | null;
  reason: 'completed' | 'deadline' | 'output_limit' | 'worker_failed' | 'invalid_output';
  failureCode: string | null;
  exitConfirmed: boolean;
}
export const superviseSyntheticChangeWorker = (child: ChildProcessWithoutNullStreams, options: SyntheticChangeWorkerOptions,
  startedAt: number): Promise<SyntheticChangeWorkerOutcome> => new Promise(resolve => {
  let output = Buffer.alloc(0), errors = Buffer.alloc(0), bytes = 0;
  let reason: SyntheticChangeWorkerOutcome['reason'] | null = null, grace: ReturnType<typeof setTimeout> | undefined;
  const terminate = (cause: SyntheticChangeWorkerOutcome['reason']): void => {
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
  child.stdout.on('data', (chunk: Buffer) => append(chunk, false)); child.stderr.on('data', (chunk: Buffer) => append(chunk, true));
  child.stdout.on('error', () => terminate('worker_failed')); child.stderr.on('error', () => terminate('worker_failed'));
  child.once('error', () => terminate('worker_failed'));
  child.once('close', (code, signal) => {
    clearTimeout(deadline); if (grace) clearTimeout(grace);
    if (reason === null && performance.now() - startedAt >= 30_000) reason = 'deadline';
    if (reason !== null || code !== 0 || signal !== null) {
      const errorText = errors.toString('utf8');
      const failureCode = reason === null && code === 1 && signal === null && /^SYNTHETIC_COMPANY_CHANGE_[A-Z_]{1,60}\n$/u.test(errorText) ? errorText.trim() : null;
      resolve({ summary: null, reason: reason ?? 'worker_failed', failureCode, exitConfirmed: true }); return;
    }
    try {
      if (errors.length) throw new Error('Conflicting worker output');
      resolve({ summary: parseSyntheticChangeSummary(new TextDecoder('utf-8', { fatal: true }).decode(output), options),
        reason: 'completed', failureCode: null, exitConfirmed: true });
    } catch { resolve({ summary: null, reason: 'invalid_output', failureCode: null, exitConfirmed: true }); }
  });
});

export const runSyntheticCompanyChangeCommand = async (args: string[]): Promise<void> => {
  const { command, values } = parseArguments(args);
  process.umask(0o077);
  const runtime = await syntheticChangePath(values.get('--data-dir'));
  const draftFile = values.has('--draft') ? await syntheticChangePath(values.get('--draft')) : null;
  const harness = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  if (companyPathsOverlap(runtime, harness) || draftFile && companyPathsOverlap(draftFile, harness)) {
    throw new HarnessError('SYNTHETIC_COMPANY_CHANGE_UNSAFE_RUNTIME');
  }
  const parentGuard = await companyDirectoryChain(dirname(runtime));
  const draftGuard = draftFile ? await validateSyntheticChangeDraftPath(runtime, draftFile) : null;
  const options: SyntheticChangeWorkerOptions = { version: 'synthetic-change-worker-input-v1', command,
    harnessDirectory: harness, runtimeDirectory: runtime, taskId: command === 'plan' ? randomUUID() : values.get('--task') ?? null,
    draftFile, planHash: values.get('--plan-hash') ?? null,
    expiresInMinutes: values.has('--expires-in-minutes') ? Number(values.get('--expires-in-minutes')) : null };
  await prepareSyntheticChangeRuntime(runtime, command === 'init');
  const guard = await validateSyntheticChangeRuntime(runtime, command === 'init');
  await parentGuard(); if (draftGuard) await draftGuard();
  const startedAt = performance.now(); let outcome: SyntheticChangeWorkerOutcome;
  try {
    const child = spawn(await realpath(process.execPath), ['--no-addons', '--disable-proto=throw', '--max-old-space-size=128',
      join(harness, 'dist/src/cli/synthetic-company-change-worker.js'), JSON.stringify(options)],
    { cwd: harness, env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdin.on('error', () => { /* The controller accepts no stdin payload. */ }); child.stdin.end();
    outcome = await superviseSyntheticChangeWorker(child, options, startedAt);
  } catch { outcome = { summary: null, reason: 'worker_failed', failureCode: null, exitConfirmed: false }; }
  try { await parentGuard(); await guard(); if (draftGuard) await draftGuard(); }
  catch { outcome = { ...outcome, summary: null, reason: 'worker_failed', failureCode: 'SYNTHETIC_COMPANY_CHANGE_UNSAFE_RUNTIME' }; }
  if (outcome.summary) {
    const failed = command === 'apply' && outcome.summary.status === 'FAILED';
    process.stdout.write(`${JSON.stringify({ ...outcome.summary, runStatus: failed ? 'failed' : 'succeeded', exitConfirmed: true })}\n`);
    if (failed) process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ version: 'synthetic-change-result-v1', command, taskId: options.taskId,
    runStatus: 'unknown', reason: outcome.reason, failureCode: outcome.failureCode,
    exitConfirmed: outcome.exitConfirmed, ...syntheticChangeBoundary })}\n`);
  process.exitCode = 1;
};
