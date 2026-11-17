import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';
import { getCompanyGitRangeProfile, getCompanyGitRangeProfileHash } from '../policy/company-git-range-budget.js';
import { assertCompanyReadonlyPolicyAllowed, parseCompanyReadonlyPolicy } from '../policy/company-readonly.js';
import { parseCompanyReadonlyRegistrationV2 } from '../policy/company-readonly-v2.js';
import { canonicalReadonlyJson, hashReadonlyValue, isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { companyPath, companyPathsOverlap, readCompanyPrivateJson } from './company-readonly-files.js';
import { companyV2RuntimeHash, prepareCompanyV2Directory, pruneCompanyV2Runs, readCompanyV2Registration, readCompanyV2RunResult,
  writeCompanyV2Run, writeCompanyV2RunResult, type CompanyV2Run } from './company-readonly-v2-files.js';
import { companyV2Disabled, type CompanyV2WorkerOptions } from './company-readonly-v2-protocol.js';
import { superviseCompanyV2Worker, type CompanyV2WorkerOutcome } from './company-readonly-v2-supervisor.js';

export const companyReadonlyV2Usage = [
  'pnpm harness company-readonly-v2-plan --policy <private-json> --registration <private-v2-json> --data-dir <private-runtime>',
  'pnpm harness company-readonly-v2-inspect --task <uuid> --data-dir <private-runtime>',
  'pnpm harness company-readonly-v2-cancel --task <uuid> --data-dir <private-runtime>',
  'pnpm harness company-readonly-v2-prune --data-dir <private-runtime>',
].join('\n');
const parseArguments = (args: string[]) => {
  const command = args[0]?.replace(/^company-readonly-v2-/, '');
  if (!args[0]?.startsWith('company-readonly-v2-') || !['plan', 'inspect', 'cancel', 'prune'].includes(command ?? '')) throw new HarnessError('UNKNOWN_COMMAND');
  const names = command === 'plan' ? ['--policy', '--registration', '--data-dir'] : command === 'prune' ? ['--data-dir'] : ['--task', '--data-dir'];
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (!names.includes(name) || !value || value.startsWith('--') || options.has(name)) throw new HarnessError('INVALID_ARGUMENTS');
    options.set(name, value);
  }
  if (options.size !== names.length || options.has('--task') && !isReadonlyId(options.get('--task')!)) throw new HarnessError('INVALID_ARGUMENTS');
  return { command: command as CompanyV2WorkerOptions['command'], options };
};

export const runCompanyReadonlyV2Command = async (args: string[]): Promise<void> => {
  process.umask(0o077);
  const { command, options } = parseArguments(args);
  const sourceDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const runtime = companyPath(options.get('--data-dir'));
  if (companyPathsOverlap(runtime, sourceDirectory)) throw new HarnessError('COMPANY_READONLY_V2_UNSAFE_PATH');
  const worker: CompanyV2WorkerOptions = { command, sourceDirectory, runtimeDirectory: runtime };
  let run: CompanyV2Run | undefined;
  if (command === 'plan') {
    const policyFile = companyPath(options.get('--policy')), registrationFile = companyPath(options.get('--registration'));
    for (const path of [policyFile, registrationFile]) {
      if (companyPathsOverlap(path, sourceDirectory) || companyPathsOverlap(path, runtime)) throw new HarnessError('COMPANY_READONLY_V2_UNSAFE_PATH');
    }
    const policy = parseCompanyReadonlyPolicy(await readCompanyPrivateJson(policyFile, 'policy'));
    // Do not read registration or source metadata before both read and storage policy are declared.
    assertCompanyReadonlyPolicyAllowed(policy);
    const registration = parseCompanyReadonlyRegistrationV2(await readCompanyV2Registration(registrationFile));
    companyPath(registration.sourceRoot);
    if ([runtime, sourceDirectory, policyFile, registrationFile].some(path => companyPathsOverlap(registration.sourceRoot, path))) {
      throw new HarnessError('COMPANY_READONLY_V2_UNSAFE_PATH');
    }
    const startedAt = new Date().toISOString(), taskId = randomUUID();
    run = { version: 'company-readonly-v2-run-v1', taskId, ownerId: `os-user:${process.getuid?.()}`, startedAt,
      auditExpiresAt: new Date(Date.parse(startedAt) + policy.auditRetentionDays! * 86_400_000).toISOString(),
      gitProfileHash: getCompanyGitRangeProfileHash(), policyHash: hashReadonlyValue(canonicalReadonlyJson(policy)),
      registrationHash: hashReadonlyValue(canonicalReadonlyJson(registration)), runtimeHash: companyV2RuntimeHash(runtime, `os-user:${process.getuid?.()}`) };
    Object.assign(worker, { taskId, startedAt, policyFile, registrationFile, policyHash: run.policyHash, registrationHash: run.registrationHash });
  } else if (command !== 'prune') worker.taskId = options.get('--task')!;
  const startedAtMs = performance.now();
  await prepareCompanyV2Directory(runtime, command === 'plan');
  if (run) await writeCompanyV2Run(runtime, run);
  let outcome: CompanyV2WorkerOutcome;
  try {
    const executable = await realpath(process.execPath);
    if (performance.now() - startedAtMs >= getCompanyGitRangeProfile().limits.wallClockMs) {
      outcome = { summary: null, reason: 'deadline', exitConfirmed: true };
    } else {
      // Node metadata guards require broad read permission. Bounded source access is enforced by the fixed reader.
      const child = spawn(executable, ['--max-old-space-size=128', '--permission', '--allow-fs-read=*',
        `--allow-fs-write=${join(runtime, 'store')}`, join(sourceDirectory, 'dist/src/cli/company-readonly-v2-worker.js'), JSON.stringify(worker)],
      { cwd: sourceDirectory, env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child.stdin.on('error', () => { /* No input is sent; worker outcome is decided by its exit and bounded output. */ });
      child.stdin.end();
      outcome = await superviseCompanyV2Worker(child, command, worker.taskId ?? null, startedAtMs);
    }
  } catch { outcome = { summary: null, reason: 'worker_failed', exitConfirmed: false }; }
  if (run) {
    try {
      await writeCompanyV2RunResult(runtime, { version: 'company-readonly-v2-run-result-v1', taskId: run.taskId,
        status: outcome.summary ? 'succeeded' : 'unknown', planHash: outcome.summary?.planHash ?? null,
        endedAt: new Date().toISOString(), exitConfirmed: outcome.exitConfirmed });
    } catch { outcome = { ...outcome, summary: null, reason: 'worker_failed' }; }
  }
  if (!outcome.summary) {
    if (!run) throw new HarnessError('COMPANY_READONLY_V2_WORKER_FAILED');
    process.stdout.write(`${JSON.stringify({ version: 'company-readonly-v2-result-v1', command, taskId: run.taskId,
      runStatus: 'unknown', reason: outcome.reason, exitConfirmed: outcome.exitConfirmed, automaticRetry: false, ...companyV2Disabled })}\n`);
    process.exitCode = 1; return;
  }
  const priorRun = command === 'inspect' ? await readCompanyV2RunResult(runtime, worker.taskId!) : null;
  if (priorRun?.status === 'succeeded' && outcome.summary.planHash !== null && priorRun.planHash !== outcome.summary.planHash) {
    throw new HarnessError('COMPANY_READONLY_V2_RUN_RECORD_CHANGED');
  }
  const runsRemoved = command === 'prune' ? await pruneCompanyV2Runs(runtime, new Date()) : 0;
  process.stdout.write(`${JSON.stringify({ ...outcome.summary, runStatus: 'succeeded', exitConfirmed: outcome.exitConfirmed,
    ...(command === 'inspect' ? { preparationRunStatus: priorRun?.status ?? 'unknown' } : {}),
    ...(command === 'prune' ? { runsRemoved } : {}) })}\n`);
};
