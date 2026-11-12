import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RestrictedReadonlyModelPreflightFakeTransport } from '../adapters/readonly-model-preflight-fake-transport.js';
import { readonlyModelPreflightCleanupConfirmed } from '../adapters/readonly-model-preflight-lifecycle.js';
import { SqliteReadonlyModelPreflightStore } from '../adapters/sqlite-readonly-model-preflight-store.js';
import { ReadonlyModelPreflightService } from '../application/investigate-model-preflight.js';
import { HarnessError } from '../domain/errors.js';
import { getReadonlySelectionPreset } from '../policy/readonly-investigation-policy.js';
import type { ReadonlyModelPreflightPort } from '../ports/readonly-model-preflight.js';
import { acquireRuntimeLease, defaultDataDirectory, prepareDataDirectory } from './runtime.js';

const prefix = 'readonly-model-preflight-';
export const readonlyModelPreflightUsage = [
  'pnpm harness readonly-model-preflight-plan --fixture flow [--selection all|controller|service] [--transfer all|controller|service] [--request flow-question|change-request] [--profile json|sse] [--data-dir <private-directory>]',
  'pnpm harness readonly-model-preflight-inspect --task <uuid> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
  'pnpm harness readonly-model-preflight-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> [--data-dir <private-directory>]',
  'pnpm harness readonly-model-preflight-run --task <uuid> --plan-hash <sha256> [--data-dir <private-directory>]',
  'pnpm harness readonly-model-preflight-cancel|readonly-model-preflight-invalidate|readonly-model-preflight-recover --task <uuid> [--data-dir <private-directory>]',
  'pnpm harness readonly-model-preflight-prune [--data-dir <private-directory>]',
].join('\n');

const deniedTransport: ReadonlyModelPreflightPort = {
  mode: 'offline', transport: 'in-memory-fake', transmit: async () => { throw new HarnessError('READONLY_MODEL_PREFLIGHT_NOT_ALLOWED'); },
};

@Module({})
class ReadonlyModelPreflightModule {
  static configure(store: SqliteReadonlyModelPreflightStore, transport: ReadonlyModelPreflightPort, dataDirectory: string): DynamicModule {
    return {
      module: ReadonlyModelPreflightModule,
      providers: [{ provide: ReadonlyModelPreflightService, useFactory: () => new ReadonlyModelPreflightService(store, transport, dataDirectory,
        (id, hashes) => readonlyModelPreflightCleanupConfirmed(dataDirectory, id, hashes)) }],
    };
  }
}

const parseArguments = (args: string[]) => {
  const command = args[0]?.slice(prefix.length) ?? '';
  const allowed: Record<string, string[]> = {
    plan: ['--fixture', '--selection', '--transfer', '--request', '--profile', '--data-dir'],
    inspect: ['--task', '--approval-offset', '--data-dir'],
    approve: ['--task', '--plan-hash', '--expires-in-minutes', '--data-dir'],
    run: ['--task', '--plan-hash', '--data-dir'],
    cancel: ['--task', '--data-dir'], invalidate: ['--task', '--data-dir'], recover: ['--task', '--data-dir'],
    prune: ['--data-dir'],
  };
  if (!args[0]?.startsWith(prefix) || !Object.hasOwn(allowed, command)) throw new HarnessError('UNKNOWN_COMMAND');
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index] ?? ''; const value = args[index + 1];
    if (!allowed[command]!.includes(name) || !value || value.startsWith('--') || options.has(name)) {
      throw new HarnessError('INVALID_ARGUMENTS');
    }
    options.set(name, value);
  }
  const required = command === 'plan' ? ['--fixture'] : command === 'prune' ? []
    : command === 'approve' ? ['--task', '--plan-hash', '--expires-in-minutes']
      : command === 'run' ? ['--task', '--plan-hash'] : ['--task'];
  if (required.some((name) => !options.has(name))
    || (options.has('--task') && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(options.get('--task')!))
    || (options.has('--plan-hash') && !/^[a-f0-9]{64}$/.test(options.get('--plan-hash')!))
    || (options.has('--expires-in-minutes') && !/^(?:[1-9]|[1-5]\d|60)$/.test(options.get('--expires-in-minutes')!))
    || (options.has('--fixture') && options.get('--fixture') !== 'flow')
    || (options.has('--selection') && !['all', 'controller', 'service'].includes(options.get('--selection')!))
    || (options.has('--transfer') && !['all', 'controller', 'service'].includes(options.get('--transfer')!))
    || (options.has('--profile') && !['json', 'sse'].includes(options.get('--profile')!))
    || (options.has('--request') && !['flow-question', 'change-request'].includes(options.get('--request')!))
    || (options.has('--approval-offset') && (!/^(?:0|[1-9]\d{0,9})$/.test(options.get('--approval-offset')!)
      || Number(options.get('--approval-offset')) > 1_000_000_000))) throw new HarnessError('INVALID_ARGUMENTS');
  return { command, options };
};

export const runReadonlyModelPreflightCommand = async (args: string[]): Promise<void> => {
  process.umask(0o077);
  const { command, options } = parseArguments(args);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const dataDirectory = await prepareDataDirectory(options.get('--data-dir') ?? defaultDataDirectory(), sourceRoot);
  const release = ['inspect', 'cancel', 'invalidate'].includes(command) ? () => undefined : acquireRuntimeLease(dataDirectory);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  let store: SqliteReadonlyModelPreflightStore | null = null;
  try {
    store = new SqliteReadonlyModelPreflightStore(join(dataDirectory, 'readonly-model-preflights.sqlite'));
    const transport = command === 'run' ? new RestrictedReadonlyModelPreflightFakeTransport(55_000, { dataDirectory, investigationId: options.get('--task')! }) : deniedTransport;
    const app = await NestFactory.createApplicationContext(ReadonlyModelPreflightModule.configure(store, transport, dataDirectory),
      { logger: false, abortOnError: false });
    try {
      const service = app.get(ReadonlyModelPreflightService);
      const context = { ownerId: process.getuid ? `os-user:${process.getuid()}` : '', now: new Date() };
      const id = options.get('--task') ?? '';
      const request = { investigationId: id, planHash: options.get('--plan-hash') ?? '' };
      let result: unknown;
      if (command === 'plan') {
        const selection = getReadonlySelectionPreset((options.get('--selection') ?? 'all') as 'all' | 'controller' | 'service',
          (options.get('--request') ?? 'flow-question') as 'flow-question' | 'change-request');
        result = await service.plan('flow', selection, context, (options.get('--transfer') ?? 'all') as 'all' | 'controller' | 'service',
          options.get('--profile') === 'sse' ? 'responses-candidate-sse-v1' : 'responses-candidate-json-v1');
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
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally { await app.close(); }
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    store?.close(); release();
  }
};
