import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RestrictedReadonlyRelayCodex } from '../adapters/readonly-relay-codex.js';
import { readonlyRelayCleanupConfirmed } from '../adapters/readonly-relay-lifecycle.js';
import { SqliteReadonlyRelayStore } from '../adapters/sqlite-readonly-relay-store.js';
import { ReadonlyRelayService } from '../application/investigate-relay.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyRelayConfig } from '../domain/readonly-relay.js';
import { getReadonlySelectionPreset } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyRelayConfig } from '../policy/readonly-relay-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import type { ReadonlyRelayPort } from '../ports/readonly-relay.js';
import { acquireRuntimeLease, defaultDataDirectory, prepareDataDirectory } from './runtime.js';

const prefix = 'readonly-relay-';
export const readonlyRelayUsage = [
  'pnpm harness readonly-relay-plan --fixture flow --config <private-json> [--selection all|controller|service] [--transfer all|controller|service] [--request flow-question|change-request] [--data-dir <private-directory>]',
  'pnpm harness readonly-relay-inspect --task <uuid> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
  'pnpm harness readonly-relay-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> --config <private-json> [--data-dir <private-directory>]',
  'pnpm harness readonly-relay-run --task <uuid> --plan-hash <sha256> --config <private-json> [--data-dir <private-directory>]',
  'pnpm harness readonly-relay-cancel --task <uuid> [--data-dir <private-directory>]',
  'pnpm harness readonly-relay-invalidate --task <uuid> [--data-dir <private-directory>]',
  'pnpm harness readonly-relay-recover --task <uuid> [--data-dir <private-directory>]',
  'pnpm harness readonly-relay-prune [--data-dir <private-directory>]',
].join('\n');

const deniedTransport: ReadonlyRelayPort = {
  mode: 'live', transport: 'codex-cli-relay', transmit: async () => { throw new HarnessError('READONLY_RELAY_NOT_ALLOWED'); },
};

@Module({})
class ReadonlyRelayModule {
  static configure(store: SqliteReadonlyRelayStore, port: ReadonlyRelayPort, dataDirectory: string, config?: ReadonlyRelayConfig): DynamicModule {
    return {
      module: ReadonlyRelayModule,
      providers: [{ provide: ReadonlyRelayService, useFactory: () => new ReadonlyRelayService(store, port, dataDirectory, config,
        (id, hashes) => readonlyRelayCleanupConfirmed(dataDirectory, id, hashes)) }],
    };
  }
}

const parseArguments = (args: string[]) => {
  const command = args[0]?.slice(prefix.length) ?? '';
  const allowed: Record<string, string[]> = {
    plan: ['--fixture', '--selection', '--transfer', '--request', '--config', '--data-dir'],
    inspect: ['--task', '--approval-offset', '--data-dir'],
    approve: ['--task', '--plan-hash', '--expires-in-minutes', '--config', '--data-dir'],
    run: ['--task', '--plan-hash', '--config', '--data-dir'],
    cancel: ['--task', '--data-dir'], invalidate: ['--task', '--data-dir'], recover: ['--task', '--data-dir'],
    prune: ['--data-dir'],
  };
  if (!args[0]?.startsWith(prefix) || !Object.hasOwn(allowed, command)) throw new HarnessError('UNKNOWN_COMMAND');
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index] ?? ''; const value = args[index + 1];
    if (!allowed[command]!.includes(name) || !value || value.startsWith('--') || options.has(name)) throw new HarnessError('INVALID_ARGUMENTS');
    options.set(name, value);
  }
  const required = command === 'plan' ? ['--fixture', '--config'] : command === 'prune' ? []
    : command === 'approve' ? ['--task', '--plan-hash', '--expires-in-minutes', '--config']
      : command === 'run' ? ['--task', '--plan-hash', '--config'] : ['--task'];
  if (required.some((name) => !options.has(name))
    || (options.has('--task') && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(options.get('--task')!))
    || (options.has('--plan-hash') && !/^[a-f0-9]{64}$/.test(options.get('--plan-hash')!))
    || (options.has('--expires-in-minutes') && !/^(?:[1-9]|[1-5]\d|60)$/.test(options.get('--expires-in-minutes')!))
    || (options.has('--fixture') && options.get('--fixture') !== 'flow')
    || (options.has('--selection') && !['all', 'controller', 'service'].includes(options.get('--selection')!))
    || (options.has('--transfer') && !['all', 'controller', 'service'].includes(options.get('--transfer')!))
    || (options.has('--request') && !['flow-question', 'change-request'].includes(options.get('--request')!))
    || (options.has('--approval-offset') && (!/^(?:0|[1-9]\d{0,9})$/.test(options.get('--approval-offset')!)
      || Number(options.get('--approval-offset')) > 1_000_000_000))) throw new HarnessError('INVALID_ARGUMENTS');
  return { command, options };
};

const sameConfigurationFile = (left: Stats, right: Stats): boolean => right.isFile()
  && left.ino === right.ino && left.dev === right.dev && left.mode === right.mode
  && left.uid === right.uid && left.nlink === right.nlink && left.size === right.size
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

const readConfiguration = async (requested: string): Promise<ReadonlyRelayConfig> => {
  try {
    const path = resolve(requested);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64_000
      || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || await realpath(path) !== path) throw new Error();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!sameConfigurationFile(before, opened)) throw new Error();
      const bytes = Buffer.alloc(64_001);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 64_000 || bytesRead !== opened.size || !sameConfigurationFile(opened, await handle.stat())
        || !sameConfigurationFile(opened, await lstat(path)) || await realpath(path) !== path) throw new Error();
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytesRead));
      return parseReadonlyRelayConfig(parseReadonlyTransportJson(raw, 64_000));
    } finally { await handle.close(); }
  } catch { throw new HarnessError('INVALID_READONLY_RELAY_CONFIG'); }
};

export const runReadonlyRelayCommand = async (args: string[]): Promise<void> => {
  process.umask(0o077);
  const { command, options } = parseArguments(args);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = await prepareDataDirectory(options.get('--data-dir') ?? defaultDataDirectory(), sourceRoot);
  const release = ['inspect', 'cancel', 'invalidate'].includes(command) ? () => undefined : acquireRuntimeLease(dataDirectory);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  let store: SqliteReadonlyRelayStore | null = null;
  try {
    const config = options.has('--config') ? await readConfiguration(options.get('--config')!) : undefined;
    store = new SqliteReadonlyRelayStore(join(dataDirectory, 'readonly-relay.sqlite'));
    // 생성자에서는 인증을 읽지 않는다. 승인·dispatch 후 adapter.transmit만 실제 연결을 열 수 있다.
    const port = command === 'run' ? new RestrictedReadonlyRelayCodex(config!, dataDirectory, options.get('--task')!) : deniedTransport;
    const app = await NestFactory.createApplicationContext(ReadonlyRelayModule.configure(store, port, dataDirectory, config),
      { logger: false, abortOnError: false });
    try {
      const service = app.get(ReadonlyRelayService);
      const context = { ownerId: process.getuid ? `os-user:${process.getuid()}` : '', now: new Date() };
      const id = options.get('--task') ?? '';
      const request = { investigationId: id, planHash: options.get('--plan-hash') ?? '' };
      let result: object;
      if (command === 'plan') {
        const selection = getReadonlySelectionPreset((options.get('--selection') ?? 'all') as 'all' | 'controller' | 'service',
          (options.get('--request') ?? 'flow-question') as 'flow-question' | 'change-request');
        result = await service.plan('flow', selection, context, (options.get('--transfer') ?? 'all') as 'all' | 'controller' | 'service');
      } else if (command === 'approve') {
        result = { approval: await service.approve({ ...request, expiresInMinutes: Number(options.get('--expires-in-minutes')) }, context),
          ...await service.inspect(id, context) };
      } else if (command === 'run') {
        const snapshot = await service.run(request, context, controller.signal);
        result = snapshot;
        if (snapshot.task.status !== 'REPORTED') process.exitCode = 1;
      } else if (command === 'inspect') result = await service.inspect(id, context, Number(options.get('--approval-offset') ?? 0));
      else if (command === 'cancel') result = await service.cancel(id, context);
      else if (command === 'invalidate') result = await service.invalidate(id, context);
      else if (command === 'recover') result = await service.recover(id, context);
      else result = await service.prune(context);
      process.stdout.write(`${JSON.stringify(config ? { ...result, configuration: config } : result, null, 2)}\n`);
    } finally { await app.close(); }
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    store?.close(); release();
  }
};
