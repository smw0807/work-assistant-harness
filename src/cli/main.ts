import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDemoRepository, hashRepository } from '../adapters/demo-repository.js';
import { HarnessError } from '../domain/errors.js';
import type { IngestionPolicy } from '../domain/types.js';
import type { ApprovalRequest } from '../domain/approval.js';
import type { WorkerOptions } from './harness.module.js';
import { acquireRuntimeLease, assertSafeEventFile, defaultDataDirectory, isInside, prepareDataDirectory, safeReadFlag } from './runtime.js';
import { runSlackCommand, slackUsage } from './slack.js';

const scenarios = new Set([
  'inquiry', 'change', 'unclear', 'invalid-json', 'invalid-summary', 'hallucinated-file',
  'path-escape', 'symlink', 'secret', 'large', 'binary', 'malicious', 'forbidden-command', 'timeout',
  'duplicate', 'no-mention', 'other-user', 'disallowed-channel', 'other-workspace', 'edited', 'deleted',
  'bot', 'self', 'redaction',
]);

const usage = [
  'pnpm harness replay --fixture <name> [--events <json>] [--data-dir <private-directory>]',
  'pnpm harness list [--data-dir <private-directory>]',
  'pnpm harness inspect <task-id> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
  'pnpm harness approve <task-id> --plan-hash <sha256> --base-commit <sha1> --expires-in-minutes <1..1440> [--data-dir <private-directory>]',
  'pnpm harness cancel <task-id> [--data-dir <private-directory>]',
].join('\n');

interface CliArguments {
  command: WorkerOptions['command'];
  taskId: string;
  scenario: string;
  events: string;
  dataDirectory: string;
  approvalRequest: ApprovalRequest | null;
  approvalOffset: number;
}

const parseApprovalRequest = (taskId: string, options: Map<string, string>): ApprovalRequest => {
  const planHash = options.get('--plan-hash') ?? '';
  const baseCommit = options.get('--base-commit') ?? '';
  const minutes = options.get('--expires-in-minutes') ?? '';
  if (!/^[a-f0-9]{64}$/.test(planHash) || !/^[a-f0-9]{40}$/.test(baseCommit)
    || !/^[1-9]\d{0,3}$/.test(minutes) || Number(minutes) > 1440) {
    throw new HarnessError('INVALID_APPROVAL_REQUEST');
  }
  return { taskId, planHash, baseCommit, expiresInMinutes: Number(minutes) };
};

const parseArguments = (): CliArguments => {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (command !== 'replay' && command !== 'inspect' && command !== 'list' && command !== 'approve' && command !== 'cancel') {
    throw new HarnessError('UNKNOWN_COMMAND');
  }
  const needsTask = command === 'inspect' || command === 'approve' || command === 'cancel';
  const taskId = needsTask ? args.shift() ?? '' : '';
  if (needsTask && !/^[a-f0-9-]{36}$/.test(taskId)) throw new HarnessError('INVALID_TASK_ID');
  const allowedOptions = new Set(['--data-dir']);
  if (command === 'replay') {
    allowedOptions.add('--fixture');
    allowedOptions.add('--events');
  } else if (command === 'approve') {
    allowedOptions.add('--plan-hash');
    allowedOptions.add('--base-commit');
    allowedOptions.add('--expires-in-minutes');
  } else if (command === 'inspect') {
    allowedOptions.add('--approval-offset');
  }
  const options = new Map<string, string>();
  while (args.length > 0) {
    const key = args.shift() ?? '';
    const value = args.shift();
    if (!allowedOptions.has(key) || !value || value.startsWith('--') || options.has(key)) {
      throw new HarnessError('INVALID_ARGUMENTS');
    }
    options.set(key, value);
  }
  const scenario = options.get('--fixture') ?? 'inquiry';
  if (!scenarios.has(scenario)) throw new HarnessError('UNKNOWN_FIXTURE');
  const approvalRequest = command === 'approve' ? parseApprovalRequest(taskId, options) : null;
  const offsetText = options.get('--approval-offset') ?? '0';
  if (!/^(0|[1-9]\d{0,9})$/.test(offsetText) || Number(offsetText) > 1_000_000_000) {
    throw new HarnessError('INVALID_APPROVAL_OFFSET');
  }
  return {
    command, taskId, scenario, events: options.get('--events') ?? '',
    dataDirectory: options.get('--data-dir') ?? defaultDataDirectory(), approvalRequest, approvalOffset: Number(offsetText),
  };
};

const run = async (): Promise<void> => {
  process.umask(0o077);
  const args = parseArguments();
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = await prepareDataDirectory(args.dataDirectory, sourceRoot);
  const releaseLease = acquireRuntimeLease(dataDirectory);
  try {
    const repository = await prepareDemoRepository();
    if (isInside(dataDirectory, repository.root) || isInside(repository.root, dataDirectory)) {
      throw new HarnessError('DATA_DIRECTORY_OVERLAPS_REPOSITORY');
    }
    const beforeHash = await hashRepository(repository.root);
    const fixturePath = await assertSafeEventFile(args.events || join(sourceRoot, 'fixtures', 'events', `${args.scenario}.json`));
    const ingestion = JSON.parse(await readFile(join(sourceRoot, 'config', 'local.example.json'), 'utf8')) as IngestionPolicy;
    const options: WorkerOptions = { ...args, sourceRoot, dataDirectory, fixturePath, repository, ingestion };
    const executable = await realpath(process.execPath);
    const permissionArguments = [
      '--permission', safeReadFlag(sourceRoot), safeReadFlag(repository.root),
      safeReadFlag(dataDirectory), safeReadFlag(fixturePath), `--allow-fs-write=${dataDirectory}`,
      join(sourceRoot, 'dist', 'src', 'cli', 'worker.js'), JSON.stringify(options),
    ];
    let workerOutput = '';
    let workerFailureCode = '';
    try {
      workerOutput = execFileSync(executable, permissionArguments, {
        cwd: sourceRoot,
        // 원래 프로세스의 토큰과 Node/Git 옵션을 조사 프로세스에 넘기지 않는다.
        env: { LANG: 'C.UTF-8', TZ: 'UTC' }, encoding: 'utf8', timeout: 30_000,
        // task와 승인 및 승인 이력 1페이지는 각각 256KB 이하로 읽는다.
        maxBuffer: 1_048_576, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
      workerFailureCode = /^[A-Z][A-Z0-9_]{1,80}$/.test(stderr) ? stderr : 'RESTRICTED_WORKER_FAILED';
    }
    if (await hashRepository(repository.root) !== beforeHash) throw new HarnessError('TARGET_REPOSITORY_CHANGED');
    if (workerFailureCode) throw new HarnessError(workerFailureCode);
    const result: unknown = JSON.parse(workerOutput);
    const receipt = {
      runId: randomUUID(), createdAt: new Date().toISOString(), command: args.command,
      repository: { repoId: repository.repoId, root: repository.root, baseCommit: repository.baseCommit },
      checks: [{ name: 'target_repository_unchanged', status: 'passed', beforeHash, afterHash: beforeHash }],
      result,
    };
    const runsDirectory = join(dataDirectory, 'runs');
    await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
    const receiptPath = join(runsDirectory, `${receipt.runId}.json`);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath, dataDirectory }, null, 2)}\n`);
  } finally {
    releaseLease();
  }
};

if (process.argv.includes('--help')) process.stdout.write(`${usage}\n${slackUsage}\n`);
else (process.argv[2]?.startsWith('slack-') ? runSlackCommand(process.argv.slice(2)) : run()).catch((error: unknown) => {
  process.stderr.write(`${error instanceof HarnessError ? error.code : 'HARNESS_FAILED'}\n${usage}\n${slackUsage}\n`);
  process.exitCode = 1;
});
