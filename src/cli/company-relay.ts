import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';
import { getCompanyGitRangeUnitProfile } from '../policy/company-git-range-unit-budget.js';
import { isReadonlyId } from '../policy/readonly-investigation-policy.js';
import { getDefaultReadonlyRelayExecutionBudget } from '../policy/readonly-relay-budget-policy.js';
import { prepareCompanyRelayDirectory } from './company-relay-files.js';
import { type CompanyRelayCommand, type CompanyRelayWorkerOptions } from './company-relay-protocol.js';
import { superviseCompanyRelayWorker, type CompanyRelayOutcome } from './company-relay-supervisor.js';
import { createCompanyRelayIpcDirectory } from './company-relay-ipc.js';
import { companyPath, companyPathsOverlap } from './company-readonly-files.js';

export const companyRelayUsage = [
  'pnpm harness company-relay-plan --mode live --preparation-task <uuid> --authorization <private-company-relay-authorization.json> --preparation-data-dir <private-v3-runtime> --data-dir <private-relay-runtime>',
  'pnpm harness company-relay-approve --mode live --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> --authorization <private-company-relay-authorization.json> --preparation-data-dir <private-v3-runtime> --data-dir <private-relay-runtime>',
  'pnpm harness company-relay-run --mode live --task <uuid> --plan-hash <sha256> --authorization <private-company-relay-authorization.json> --preparation-data-dir <private-v3-runtime> --data-dir <private-relay-runtime>',
  'pnpm harness company-relay-review|company-relay-inspect|company-relay-cancel|company-relay-recover --task <uuid> --data-dir <private-relay-runtime>',
  'pnpm harness company-relay-prune --data-dir <private-relay-runtime>',
].join('\n');
const parseArguments = (args: string[]) => {
  const command = args[0]?.replace(/^company-relay-/, '') as CompanyRelayCommand;
  const names: Record<CompanyRelayCommand, string[]> = {
    plan: ['--authorization', '--mode', '--preparation-task', '--preparation-data-dir', '--data-dir'],
    approve: ['--authorization', '--mode', '--task', '--plan-hash', '--expires-in-minutes', '--preparation-data-dir', '--data-dir'],
    run: ['--authorization', '--mode', '--task', '--plan-hash', '--preparation-data-dir', '--data-dir'],
    review: ['--task', '--data-dir'], inspect: ['--task', '--data-dir'], cancel: ['--task', '--data-dir'], recover: ['--task', '--data-dir'], prune: ['--data-dir'],
  };
  if (!args[0]?.startsWith('company-relay-') || !Object.hasOwn(names, command)) throw new HarnessError('UNKNOWN_COMMAND');
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (!names[command].includes(name) || !value || value.startsWith('--') || options.has(name)) throw new HarnessError('INVALID_ARGUMENTS');
    options.set(name, value);
  }
  if (names[command].some(name => !options.has(name)) || options.has('--mode') && options.get('--mode') !== 'live'
    || ['--task', '--preparation-task'].some(name => options.has(name) && !isReadonlyId(options.get(name)!))
    || options.has('--plan-hash') && !/^[a-f0-9]{64}$/.test(options.get('--plan-hash')!)
    || options.has('--expires-in-minutes') && !/^(?:[1-9]|[1-5]\d|60)$/.test(options.get('--expires-in-minutes')!)) throw new HarnessError('INVALID_ARGUMENTS');
  return { command, options };
};

export const runCompanyRelayCommand = async (args: string[]): Promise<void> => {
  process.umask(0o077);
  const startedAtMs = performance.now();
  const { command, options } = parseArguments(args);
  const sourceDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const runtime = companyPath(options.get('--data-dir'));
  const preparationDirectory = options.has('--preparation-data-dir') ? companyPath(options.get('--preparation-data-dir')) : null;
  if (companyPathsOverlap(runtime, sourceDirectory) || preparationDirectory && [runtime, sourceDirectory].some(path => companyPathsOverlap(path, preparationDirectory))) {
    throw new HarnessError('COMPANY_RELAY_UNSAFE_DIRECTORY');
  }
  let ipc: Awaited<ReturnType<typeof createCompanyRelayIpcDirectory>> | null = null;
  let workerStarted = false, workerClosed = false, ipcRemoved = false;
  try {
    const worker: CompanyRelayWorkerOptions = { version: 'company-relay-worker-v1', command, sourceDirectory, runtimeDirectory: runtime,
      preparationDirectory, ipcDirectory: command === 'run' ? '/private/tmp/hcri-000000' : null, authorizationFile: options.has('--authorization') ? companyPath(options.get('--authorization')) : null, preparationId: command === 'plan' ? options.get('--preparation-task')! : null,
      taskId: command === 'plan' ? randomUUID() : options.get('--task') ?? null,
      planHash: options.get('--plan-hash') ?? null, expiresInMinutes: options.has('--expires-in-minutes') ? Number(options.get('--expires-in-minutes')) : null };
    const executable = await realpath(process.execPath), preparationDeadlineMs = getCompanyGitRangeUnitProfile().limits.wallClockMs;
    const deadlineMs = command === 'run' ? getDefaultReadonlyRelayExecutionBudget().totalTimeoutMs : preparationDeadlineMs;
    // Validate persisted bodies in a bounded child before creating any new runtime inside a possible target.
    if (preparationDirectory) {
      try {
        const output = execFileSync(executable, ['--max-old-space-size=128', '--permission', '--allow-fs-read=*',
          `--allow-fs-write=${join(preparationDirectory, 'store')}`,
          ...(command === 'plan' ? [] : [`--allow-fs-write=${join(runtime, 'store')}`]),
          join(sourceDirectory, 'dist/src/cli/company-relay-preflight.js'), JSON.stringify(worker)],
        { cwd: sourceDirectory, env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
          timeout: preparationDeadlineMs, killSignal: 'SIGKILL', maxBuffer: 8192, windowsHide: true });
        if (output !== '{"version":"company-relay-preflight-v1","passed":true}\n') throw new Error('invalid preflight output');
      } catch { throw new HarnessError('COMPANY_RELAY_PREFLIGHT_FAILED'); }
    }
    if (performance.now() - startedAtMs >= deadlineMs) throw new HarnessError('COMPANY_RELAY_DEADLINE');
    if (command === 'run') { ipc = await createCompanyRelayIpcDirectory(); worker.ipcDirectory = ipc.path; }
    await prepareCompanyRelayDirectory(runtime, command === 'plan');
    if (performance.now() - startedAtMs >= deadlineMs) throw new HarnessError('COMPANY_RELAY_DEADLINE');
    let outcome: CompanyRelayOutcome;
    try {
      // Node permission mode disables fsync. The existing durable native controller is trusted;
      // preparation, approval, review and maintenance keep their restricted worker boundary.
      const permissions = command === 'run' ? [] : ['--permission', '--allow-fs-read=*',
        `--allow-fs-write=${join(runtime, 'store')}`, `--allow-fs-write=${join(runtime, 'reviews')}`, `--allow-fs-write=${join(runtime, 'readonly-relay-runs')}`,
        ...(preparationDirectory ? [`--allow-fs-write=${join(preparationDirectory, 'store')}`] : [])];
      const child = spawn(executable, ['--max-old-space-size=128', ...permissions,
        join(sourceDirectory, 'dist/src/cli/company-relay-worker.js'), JSON.stringify(worker)],
      { cwd: sourceDirectory, env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      workerStarted = true;
      child.stdin.on('error', () => {}); child.stdin.end();
      outcome = await superviseCompanyRelayWorker(child, command, worker.taskId, startedAtMs);
      workerClosed = outcome.exitConfirmed;
    } catch { outcome = { summary: null, reason: 'worker_failed', exitConfirmed: false }; }
    if (ipc && !(ipcRemoved = workerClosed && await ipc.cleanup())) outcome = { summary: null, reason: 'cleanup_uncertain', exitConfirmed: outcome.exitConfirmed };
    if (!outcome.summary) {
      process.stdout.write(`${JSON.stringify({ version: 'company-relay-result-v1', command, taskId: worker.taskId,
        runStatus: 'unknown', reason: outcome.reason, exitConfirmed: outcome.exitConfirmed, automaticRetry: false, mode: 'live', executionAllowed: false, verification: command === 'run' ? 'unknown' : 'not_run' })}\n`);
      process.exitCode = 1; return;
    }
    process.stdout.write(`${JSON.stringify({ ...outcome.summary, runStatus: 'succeeded', exitConfirmed: true, automaticRetry: false })}\n`);
    if (command === 'run' && outcome.summary.status !== 'REPORTED') process.exitCode = 1;
  } finally { if (ipc && !ipcRemoved && (!workerStarted || workerClosed)) await ipc.cleanup(); }
};
