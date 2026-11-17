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
import { prepareCompanyInvestigationDirectory } from './company-investigation-files.js';
import { companyInvestigationDisabled, type CompanyInvestigationCommand, type CompanyInvestigationWorkerOptions } from './company-investigation-protocol.js';
import { superviseCompanyInvestigationWorker, type CompanyInvestigationOutcome } from './company-investigation-supervisor.js';
import { companyPath, companyPathsOverlap } from './company-readonly-files.js';

export const companyInvestigationUsage = [
  'pnpm harness company-investigation-plan --mode mock --preparation-task <uuid> --preparation-data-dir <private-v3-runtime> --data-dir <private-investigation-runtime>',
  'pnpm harness company-investigation-approve --mode mock --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> --preparation-data-dir <private-v3-runtime> --data-dir <private-investigation-runtime>',
  'pnpm harness company-investigation-run --mode mock --task <uuid> --plan-hash <sha256> --preparation-data-dir <private-v3-runtime> --data-dir <private-investigation-runtime>',
  'pnpm harness company-investigation-inspect|company-investigation-cancel|company-investigation-recover --task <uuid> --data-dir <private-investigation-runtime>',
  'pnpm harness company-investigation-prune --data-dir <private-investigation-runtime>',
].join('\n');
const parseArguments = (args: string[]) => {
  const command = args[0]?.replace(/^company-investigation-/, '') as CompanyInvestigationCommand;
  const names: Record<CompanyInvestigationCommand, string[]> = {
    plan: ['--mode', '--preparation-task', '--preparation-data-dir', '--data-dir'],
    approve: ['--mode', '--task', '--plan-hash', '--expires-in-minutes', '--preparation-data-dir', '--data-dir'],
    run: ['--mode', '--task', '--plan-hash', '--preparation-data-dir', '--data-dir'],
    inspect: ['--task', '--data-dir'], cancel: ['--task', '--data-dir'], recover: ['--task', '--data-dir'], prune: ['--data-dir'],
  };
  if (!args[0]?.startsWith('company-investigation-') || !Object.hasOwn(names, command)) throw new HarnessError('UNKNOWN_COMMAND');
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (!names[command].includes(name) || !value || value.startsWith('--') || options.has(name)) throw new HarnessError('INVALID_ARGUMENTS');
    options.set(name, value);
  }
  if (names[command].some(name => !options.has(name)) || options.has('--mode') && options.get('--mode') !== 'mock'
    || ['--task', '--preparation-task'].some(name => options.has(name) && !isReadonlyId(options.get(name)!))
    || options.has('--plan-hash') && !/^[a-f0-9]{64}$/.test(options.get('--plan-hash')!)
    || options.has('--expires-in-minutes') && !/^(?:[1-9]|[1-5]\d|60)$/.test(options.get('--expires-in-minutes')!)) throw new HarnessError('INVALID_ARGUMENTS');
  return { command, options };
};

export const runCompanyInvestigationCommand = async (args: string[]): Promise<void> => {
  process.umask(0o077);
  const startedAtMs = performance.now();
  const { command, options } = parseArguments(args);
  const sourceDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const runtime = companyPath(options.get('--data-dir'));
  const preparationDirectory = options.has('--preparation-data-dir') ? companyPath(options.get('--preparation-data-dir')) : null;
  if (companyPathsOverlap(runtime, sourceDirectory) || preparationDirectory && [runtime, sourceDirectory].some(path => companyPathsOverlap(path, preparationDirectory))) {
    throw new HarnessError('COMPANY_INVESTIGATION_UNSAFE_DIRECTORY');
  }
  const worker: CompanyInvestigationWorkerOptions = { version: 'company-investigation-worker-v1', command, sourceDirectory, runtimeDirectory: runtime,
    preparationDirectory, preparationId: command === 'plan' ? options.get('--preparation-task')! : null,
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
        join(sourceDirectory, 'dist/src/cli/company-investigation-preflight.js'), JSON.stringify(worker)],
      { cwd: sourceDirectory, env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
        timeout: preparationDeadlineMs, killSignal: 'SIGKILL', maxBuffer: 8192, windowsHide: true });
      if (output !== '{"version":"company-investigation-preflight-v1","passed":true}\n') throw new Error('invalid preflight output');
    } catch { throw new HarnessError('COMPANY_INVESTIGATION_PREFLIGHT_FAILED'); }
  }
  if (performance.now() - startedAtMs >= deadlineMs) throw new HarnessError('COMPANY_INVESTIGATION_DEADLINE');
  await prepareCompanyInvestigationDirectory(runtime, command === 'plan');
  if (performance.now() - startedAtMs >= deadlineMs) throw new HarnessError('COMPANY_INVESTIGATION_DEADLINE');
  let outcome: CompanyInvestigationOutcome;
  try {
    const child = spawn(executable, ['--max-old-space-size=128', '--permission', '--allow-fs-read=*',
      `--allow-fs-write=${join(runtime, 'store')}`, ...(preparationDirectory ? [`--allow-fs-write=${join(preparationDirectory, 'store')}`] : []),
      join(sourceDirectory, 'dist/src/cli/company-investigation-worker.js'), JSON.stringify(worker)],
    { cwd: sourceDirectory, env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdin.on('error', () => {}); child.stdin.end();
    outcome = await superviseCompanyInvestigationWorker(child, command, worker.taskId, startedAtMs);
  } catch { outcome = { summary: null, reason: 'worker_failed', exitConfirmed: false }; }
  if (!outcome.summary) {
    process.stdout.write(`${JSON.stringify({ version: 'company-investigation-result-v1', command, taskId: worker.taskId,
      runStatus: 'unknown', reason: outcome.reason, exitConfirmed: outcome.exitConfirmed, automaticRetry: false, ...companyInvestigationDisabled })}\n`);
    process.exitCode = 1; return;
  }
  process.stdout.write(`${JSON.stringify({ ...outcome.summary, runStatus: 'succeeded', exitConfirmed: true, automaticRetry: false })}\n`);
  if (command === 'run' && outcome.summary.status !== 'REPORTED') process.exitCode = 1;
};
