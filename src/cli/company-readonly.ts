import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HarnessError } from '../domain/errors.js';
import { assertCompanyReadonlyPolicyAllowed, parseCompanyReadonlyPolicy, parseCompanyReadonlyRegistration } from '../policy/company-readonly.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { companyDirectoryChain, companyPath, companyPathsOverlap, prepareCompanyDirectory, readCompanyPrivateJson } from './company-readonly-files.js';

export const companyReadonlyUsage = [
  'pnpm harness company-readonly-plan --policy <private-json> --registration <private-json> --data-dir <private-directory>',
  'pnpm harness company-readonly-inspect --task <uuid> --data-dir <private-directory>',
  'pnpm harness company-readonly-cancel --task <uuid> --data-dir <private-directory>',
  'pnpm harness company-readonly-prune --data-dir <private-directory>',
].join('\n');
export interface CompanyReadonlyWorkerOptions {
  command: 'plan' | 'inspect' | 'cancel' | 'prune';
  dataDirectory: string;
  sourceDirectory: string;
  policyFile?: string;
  registrationFile?: string;
  policyHash?: string;
  registrationHash?: string;
  taskId?: string;
}
const parseArguments = (args: string[]) => {
  const command = args[0]?.replace(/^company-readonly-/, '');
  if (!args[0]?.startsWith('company-readonly-') || !['plan', 'inspect', 'cancel', 'prune'].includes(command ?? '')) {
    throw new HarnessError('UNKNOWN_COMMAND');
  }
  const names = command === 'plan' ? ['--policy', '--registration', '--data-dir']
    : command === 'prune' ? ['--data-dir'] : ['--task', '--data-dir'];
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (!names.includes(name) || !value || value.startsWith('--') || options.has(name)) throw new HarnessError('INVALID_ARGUMENTS');
    options.set(name, value);
  }
  if (options.size !== names.length || options.has('--task') && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(options.get('--task')!)) {
    throw new HarnessError('INVALID_ARGUMENTS');
  }
  return { command: command as CompanyReadonlyWorkerOptions['command'], options };
};

export const runCompanyReadonlyCommand = async (args: string[]): Promise<void> => {
  process.umask(0o077);
  const { command, options } = parseArguments(args);
  const sourceDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = companyPath(options.get('--data-dir'));
  if (companyPathsOverlap(dataDirectory, sourceDirectory)) throw new HarnessError('COMPANY_READONLY_UNSAFE_PATH');
  const worker: CompanyReadonlyWorkerOptions = { command, dataDirectory, sourceDirectory };
  if (command === 'plan') {
    const policyFile = options.get('--policy')!;
    for (const path of [policyFile, options.get('--registration')!]) {
      companyPath(path);
      if (companyPathsOverlap(path, sourceDirectory) || companyPathsOverlap(path, dataDirectory)) {
        throw new HarnessError('COMPANY_READONLY_UNSAFE_PATH');
      }
    }
    const policy = parseCompanyReadonlyPolicy(await readCompanyPrivateJson(policyFile, 'policy'));
    // Company code and even its path metadata remain untouched until local read/storage policy is declared.
    assertCompanyReadonlyPolicyAllowed(policy);
    const registrationFile = options.get('--registration')!;
    const registration = parseCompanyReadonlyRegistration(await readCompanyPrivateJson(registrationFile, 'registration'));
    companyPath(registration.sourceRoot);
    for (const path of [sourceDirectory, dataDirectory, policyFile, registrationFile]) {
      if (companyPathsOverlap(registration.sourceRoot, path)) throw new HarnessError('COMPANY_READONLY_UNSAFE_PATH');
    }
    const assertSourceParents = await companyDirectoryChain(registration.sourceRoot);
    await assertSourceParents();
    Object.assign(worker, { policyFile, registrationFile, policyHash: hashReadonlyValue(canonicalReadonlyJson(policy)),
      registrationHash: hashReadonlyValue(canonicalReadonlyJson(registration)) });
  } else if (options.has('--task')) worker.taskId = options.get('--task')!;
  await prepareCompanyDirectory(dataDirectory, command === 'plan');
  const executable = await realpath(process.execPath);
  // The existing reader revalidates every ancestor. Node cannot grant metadata-only reads;
  // bounded file reads remain enforced by the source adapter, not by this permission flag.
  const workerArgs = ['--permission', '--allow-fs-read=*', `--allow-fs-write=${dataDirectory}`,
    join(sourceDirectory, 'dist/src/cli/company-readonly-worker.js'), JSON.stringify(worker)];
  try {
    const { stdout } = await promisify(execFile)(executable, workerArgs, {
      cwd: sourceDirectory, env: { LANG: 'C.UTF-8', TZ: 'UTC' }, encoding: 'utf8',
      timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    process.stdout.write(stdout);
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
    const code = stderr.split('\n').find(line => /^COMPANY_READONLY_[A-Z_]+$/.test(line));
    throw new HarnessError(code ?? 'COMPANY_READONLY_PREPARATION_FAILED');
  }
};
