import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RestrictedPersonalReadonlyCodex } from '../adapters/personal-readonly-codex.js';
import { readonlyRelayCleanupConfirmed } from '../adapters/readonly-relay-lifecycle.js';
import { SqlitePersonalReadonlyStore } from '../adapters/sqlite-personal-readonly-store.js';
import { PersonalReadonlyService } from '../application/investigate-personal-readonly.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyRelayConfig } from '../domain/readonly-relay.js';
import { parsePersonalReadonlyRegistration } from '../policy/personal-readonly-policy.js';
import type { PersonalReadonlyRegistration } from '../domain/personal-readonly.js';
import { parseReadonlyRelayConfig } from '../policy/readonly-relay-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import type { ReadonlyRelayPort } from '../ports/readonly-relay.js';
import { acquireRuntimeLease, defaultDataDirectory, prepareDataDirectory } from './runtime.js';

const prefix = 'personal-readonly-';
export const personalReadonlyUsage = [
  'pnpm harness personal-readonly-plan --registration <private-json> --config <private-json> [--data-dir <private-directory>]',
  'pnpm harness personal-readonly-inspect --task <uuid> [--approval-offset <0..1000000000>] [--data-dir <private-directory>]',
  'pnpm harness personal-readonly-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes <1..60> --config <private-json> [--data-dir <private-directory>]',
  'pnpm harness personal-readonly-run --task <uuid> --plan-hash <sha256> --config <private-json> [--data-dir <private-directory>]',
  'pnpm harness personal-readonly-cancel --task <uuid> [--data-dir <private-directory>]',
  'pnpm harness personal-readonly-invalidate --task <uuid> [--data-dir <private-directory>]',
  'pnpm harness personal-readonly-recover --task <uuid> [--data-dir <private-directory>]',
  'pnpm harness personal-readonly-prune [--data-dir <private-directory>]',
].join('\n');

const deniedTransport: ReadonlyRelayPort = {
  mode: 'live', transport: 'codex-cli-relay', transmit: async () => { throw new HarnessError('PERSONAL_READONLY_NOT_ALLOWED'); },
};

@Module({})
class PersonalReadonlyModule {
  static configure(store: SqlitePersonalReadonlyStore, port: ReadonlyRelayPort, dataDirectory: string, config?: ReadonlyRelayConfig): DynamicModule {
    return {
      module: PersonalReadonlyModule,
      providers: [{ provide: PersonalReadonlyService, useFactory: () => new PersonalReadonlyService(store, port, dataDirectory, config,
        (id, hashes) => readonlyRelayCleanupConfirmed(dataDirectory, id, hashes)) }],
    };
  }
}

const parseArguments = (args: string[]) => {
  const command = args[0]?.slice(prefix.length) ?? '';
  const allowed: Record<string, string[]> = {
    plan: ['--registration', '--config', '--data-dir'],
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
  const required = command === 'plan' ? ['--registration', '--config'] : command === 'prune' ? []
    : command === 'approve' ? ['--task', '--plan-hash', '--expires-in-minutes', '--config']
      : command === 'run' ? ['--task', '--plan-hash', '--config'] : ['--task'];
  if (required.some((name) => !options.has(name))
    || (options.has('--task') && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(options.get('--task')!))
    || (options.has('--plan-hash') && !/^[a-f0-9]{64}$/.test(options.get('--plan-hash')!))
    || (options.has('--expires-in-minutes') && !/^(?:[1-9]|[1-5]\d|60)$/.test(options.get('--expires-in-minutes')!))
    || (options.has('--approval-offset') && (!/^(?:0|[1-9]\d{0,9})$/.test(options.get('--approval-offset')!)
      || Number(options.get('--approval-offset')) > 1_000_000_000))) throw new HarnessError('INVALID_ARGUMENTS');
  return { command, options };
};

const sameConfigurationFile = (left: Stats, right: Stats): boolean => right.isFile()
  && left.ino === right.ino && left.dev === right.dev && left.mode === right.mode
  && left.uid === right.uid && left.nlink === right.nlink && left.size === right.size
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

const readPrivateJson = async (requested: string): Promise<unknown> => {
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
      return parseReadonlyTransportJson(raw, 64_000);
    } finally { await handle.close(); }
  } catch { throw new HarnessError('PERSONAL_READONLY_INVALID_PRIVATE_FILE'); }
};

/** Reject aliased parents before any mkdir, lease or database write can touch a registered target. */
const assertCanonicalDirectoryParents = async (path: string, requireExisting: boolean): Promise<void> => {
  let current: string = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(current) !== current) {
        throw new HarnessError('PERSONAL_READONLY_UNSAFE_DATA_DIRECTORY');
      }
    } catch (error) {
      if (!requireExisting && error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw new HarnessError('PERSONAL_READONLY_UNSAFE_DATA_DIRECTORY');
    }
  }
};

export const runPersonalReadonlyCommand = async (args: string[]): Promise<void> => {
  process.umask(0o077);
  const { command, options } = parseArguments(args);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const registration = options.has('--registration') ? parsePersonalReadonlyRegistration(await readPrivateJson(options.get('--registration')!)) : undefined;
  const requestedData = resolve(options.get('--data-dir') ?? defaultDataDirectory());
  await assertCanonicalDirectoryParents(requestedData, false);
  if (registration) {
    await assertCanonicalDirectoryParents(registration.sourceRoot, true);
    const overlaps = (left: string, right: string): boolean => left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
    if (overlaps(registration.sourceRoot, requestedData) || overlaps(registration.sourceRoot, sourceRoot)) throw new HarnessError('PERSONAL_READONLY_UNSAFE_DATA_DIRECTORY');
  }
  const dataDirectory = await prepareDataDirectory(requestedData, sourceRoot);
  const release = ['inspect', 'cancel', 'invalidate'].includes(command) ? () => undefined : acquireRuntimeLease(dataDirectory);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  let store: SqlitePersonalReadonlyStore | null = null;
  try {
    const config = options.has('--config') ? parseReadonlyRelayConfig(await readPrivateJson(options.get('--config')!)) : undefined;
    if (config && config.policyVersion !== 'readonly-relay-codex-v2') throw new HarnessError('PERSONAL_READONLY_INVALID_CONFIG');
    store = new SqlitePersonalReadonlyStore(join(dataDirectory, 'personal-readonly.sqlite'));
    // 생성자에서는 인증을 읽지 않는다. 승인·dispatch 후 adapter.transmit만 실제 연결을 열 수 있다.
    const port = command === 'run' ? new RestrictedPersonalReadonlyCodex(config!, dataDirectory, options.get('--task')!) : deniedTransport;
    const app = await NestFactory.createApplicationContext(PersonalReadonlyModule.configure(store, port, dataDirectory, config),
      { logger: false, abortOnError: false });
    try {
      const service = app.get(PersonalReadonlyService);
      const context = { ownerId: process.getuid ? `os-user:${process.getuid()}` : '', now: new Date() };
      const id = options.get('--task') ?? '';
      const request = { investigationId: id, planHash: options.get('--plan-hash') ?? '' };
      let result: object;
      if (command === 'plan') {
        result = await service.plan(registration as PersonalReadonlyRegistration, context);
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
