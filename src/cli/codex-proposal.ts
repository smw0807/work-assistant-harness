import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexCliProposal } from '../adapters/codex-cli.js';
import { loadCodexCredential } from '../adapters/codex-credentials.js';
import { SqliteCodexProposalStore } from '../adapters/sqlite-codex-proposal-store.js';
import { CodexProposalService } from '../application/propose-codex.js';
import type { BranchWorkType } from '../domain/branch.js';
import type { CodexConfig } from '../domain/codex-config.js';
import type { CodexProposalContext, CodexProposalExport } from '../domain/codex-proposal.js';
import { HarnessError } from '../domain/errors.js';
import { hashCodexConfig, parseCodexConfig } from '../policy/codex-config.js';
import { getCodexProposalInput, isCodexProposalHash, isCodexProposalId } from '../policy/codex-proposal-policy.js';
import type { CodexProposalPort } from '../ports/codex-proposal.js';
import { acquireRuntimeLease, defaultDataDirectory, prepareDataDirectory } from './runtime.js';

export const codexProposalUsage = [
  'pnpm harness codex-proposal-plan --type feature|fix|chore|refactor --codex-config <local-json> [--data-dir <private-directory>]',
  'pnpm harness codex-proposal-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> --codex-config <local-json> [--data-dir <private-directory>]',
  'pnpm harness codex-proposal-run --task <uuid> --plan-hash <sha256> --codex-config <local-json> [--data-dir <private-directory>]',
  'pnpm harness codex-proposal-inspect --task <uuid> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
  'pnpm harness codex-proposal-cancel --task <uuid> [--data-dir <private-directory>]',
  'pnpm harness codex-proposal-recover --task <uuid> [--data-dir <private-directory>]',
].join('\n');

const deniedProposal: CodexProposalPort = {
  propose: async () => { throw new HarnessError('CODEX_PROPOSAL_CALL_NOT_ALLOWED'); },
};

const callBoundary = (config: CodexConfig) => ({
  model: config.model, authMode: config.authMode,
  endpoint: config.authMode === 'api-key' ? 'https://api.openai.com/v1/responses' : 'https://chatgpt.com/backend-api/codex/responses',
  maxCalls: 1, timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes,
});

@Module({})
class CodexProposalModule {
  static configure(store: SqliteCodexProposalStore, port: CodexProposalPort, configHash: string): DynamicModule {
    return {
      module: CodexProposalModule,
      providers: [{ provide: CodexProposalService, useFactory: () => new CodexProposalService(store, port, configHash) }],
    };
  }
}

const parseArguments = (arguments_: string[]): { command: string; options: Map<string, string> } => {
  const command = arguments_[0] ?? '';
  const allowed: Record<string, string[]> = {
    'codex-proposal-plan': ['--type', '--codex-config', '--data-dir'],
    'codex-proposal-approve': ['--task', '--plan-hash', '--expires-in-minutes', '--codex-config', '--data-dir'],
    'codex-proposal-run': ['--task', '--plan-hash', '--codex-config', '--data-dir'],
    'codex-proposal-inspect': ['--task', '--approval-offset', '--data-dir'],
    'codex-proposal-cancel': ['--task', '--data-dir'],
    'codex-proposal-recover': ['--task', '--data-dir'],
  };
  if (!Object.hasOwn(allowed, command)) throw new HarnessError('UNKNOWN_COMMAND');
  const options = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const name = arguments_[index] ?? ''; const value = arguments_[index + 1];
    if (!allowed[command]!.includes(name) || !value || value.startsWith('--') || options.has(name)) throw new HarnessError('INVALID_ARGUMENTS');
    options.set(name, value);
  }
  const required = command === 'codex-proposal-plan' ? ['--type', '--codex-config']
    : command === 'codex-proposal-approve' ? ['--task', '--plan-hash', '--expires-in-minutes', '--codex-config']
      : command === 'codex-proposal-run' ? ['--task', '--plan-hash', '--codex-config'] : ['--task'];
  if (required.some((name) => !options.has(name))
    || (options.has('--task') && !isCodexProposalId(options.get('--task')))
    || (options.has('--plan-hash') && !isCodexProposalHash(options.get('--plan-hash')))
    || (options.has('--type') && !['feature', 'fix', 'chore', 'refactor'].includes(options.get('--type')!))
    || (options.has('--expires-in-minutes') && !/^(?:[1-9]|[1-5]\d|60)$/.test(options.get('--expires-in-minutes')!))
    || (options.has('--approval-offset') && (!/^(?:0|[1-9]\d{0,9})$/.test(options.get('--approval-offset')!)
      || Number(options.get('--approval-offset')) > 1_000_000_000))) throw new HarnessError('INVALID_ARGUMENTS');
  return { command, options };
};

export const readCodexConfig = async (requested: string): Promise<CodexConfig> => {
  try {
    const path = resolve(requested);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64_000
      || await realpath(path) !== path) throw new HarnessError('INVALID_CODEX_CONFIG');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || opened.size > 64_000) {
        throw new HarnessError('INVALID_CODEX_CONFIG');
      }
      const contents = await handle.readFile('utf8');
      if (Buffer.byteLength(contents) > 64_000) throw new HarnessError('INVALID_CODEX_CONFIG');
      return parseCodexConfig(JSON.parse(contents));
    } finally { await handle.close(); }
  } catch { throw new HarnessError('INVALID_CODEX_CONFIG'); }
};

const privateCallDirectory = async (dataDirectory: string, proposalId: string): Promise<string> => {
  const root = join(dataDirectory, 'codex-calls');
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || metadata.uid !== process.getuid?.() || await realpath(root) !== root) throw new HarnessError('UNSAFE_CODEX_CALL_DIRECTORY');
  const directory = join(root, proposalId);
  await mkdir(directory, { mode: 0o700 });
  return directory;
};

/** 제안 소비와 실행 DB는 별개다. export 이후 실패한 제안을 READY로 되돌리지 않는다. */
export const consumeCodexProposal = (
  dataDirectory: string, proposalId: string, config: CodexConfig, context: CodexProposalContext,
): CodexProposalExport => {
  if (!config.enabled) throw new HarnessError('CODEX_PROPOSAL_DISABLED');
  const store = new SqliteCodexProposalStore(join(dataDirectory, 'codex-proposals.sqlite'));
  try { return new CodexProposalService(store, deniedProposal, hashCodexConfig(config)).consumeForExecution(proposalId, context); }
  finally { store.close(); }
};

export const runCodexProposalCommand = async (arguments_: string[]): Promise<void> => {
  process.umask(0o077);
  const { command, options } = parseArguments(arguments_);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = await prepareDataDirectory(options.get('--data-dir') ?? defaultDataDirectory(), sourceRoot);
  const release = ['codex-proposal-inspect', 'codex-proposal-cancel'].includes(command)
    ? () => undefined : acquireRuntimeLease(dataDirectory);
  let store: SqliteCodexProposalStore | null = null;
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  try {
    store = new SqliteCodexProposalStore(join(dataDirectory, 'codex-proposals.sqlite'));
    const context = { ownerId: process.getuid ? `os-user:${process.getuid()}` : '', now: new Date() };
    const proposalId = options.get('--task') ?? '';
    if (['codex-proposal-inspect', 'codex-proposal-cancel', 'codex-proposal-recover'].includes(command)) {
      const snapshot = command === 'codex-proposal-inspect' ? store.inspect(proposalId, context, Number(options.get('--approval-offset') ?? 0))
        : command === 'codex-proposal-cancel' ? store.cancel(proposalId, context) : store.recover(proposalId, context);
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`); return;
    }
    const config = await readCodexConfig(options.get('--codex-config')!);
    if (command !== 'codex-proposal-plan' && !config.enabled) throw new HarnessError('CODEX_PROPOSAL_DISABLED');
    let port = deniedProposal;
    if (command === 'codex-proposal-run') {
      // 실제 credential은 실행 호출에만 전달하며 계획·Nest 설정·CLI 출력에 넣지 않는다.
      const credential = await loadCodexCredential(config);
      port = { propose: async (input, signal) => {
        const directory = await privateCallDirectory(dataDirectory, proposalId);
        return new CodexCliProposal(config, directory, credential).propose(input, signal);
      } };
    }
    const application = await NestFactory.createApplicationContext(CodexProposalModule.configure(store, port, hashCodexConfig(config)),
      { logger: false, abortOnError: false });
    try {
      const service = application.get(CodexProposalService);
      if (command === 'codex-proposal-plan') {
        const plannedId = randomUUID();
        await service.plan(options.get('--type') as BranchWorkType, context, plannedId);
        process.stdout.write(`${JSON.stringify({ ...store.inspect(plannedId, context), input: getCodexProposalInput(), call: callBoundary(config),
          nextApproval: '합성 전송 입력·설정·계획 해시를 검토한 뒤 codex-proposal-approve로 호출을 승인하세요.' }, null, 2)}\n`);
      } else if (command === 'codex-proposal-approve') {
        const approval = await service.approve({ proposalId, planHash: options.get('--plan-hash')!,
          expiresInMinutes: Number(options.get('--expires-in-minutes')) }, context);
        process.stdout.write(`${JSON.stringify({ ...store.inspect(proposalId, context), approval, call: callBoundary(config) }, null, 2)}\n`);
      } else {
        const snapshot = await service.run(proposalId, options.get('--plan-hash')!, context, controller.signal);
        process.stdout.write(`${JSON.stringify({ ...snapshot, call: callBoundary(config) }, null, 2)}\n`);
        if (snapshot.task.status !== 'READY') process.exitCode = 1;
      }
    } finally { await application.close(); }
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    store?.close(); release();
  }
};
