import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveSlackAdapter } from '../adapters/live-slack.js';
import { SqliteLiveSlackStore } from '../adapters/sqlite-live-slack-store.js';
import { LiveSlackService } from '../application/live-slack.js';
import { HarnessError } from '../domain/errors.js';
import type { LiveSnapshot } from '../domain/live-slack.js';
import type { LiveSlackPort } from '../ports/live-slack.js';
import {
  assertPrivateLiveSlackFiles, isSlackSendToken, liveSlackCommands, parseLiveSlackArguments,
  requiresLiveSlackNetwork, type LiveSlackCommand, type LiveSlackWorkerOptions,
} from './live-slack.js';
import { safeReadFlag } from './runtime.js';

const STORE = Symbol('LiveSlackStore');

@Module({})
class LiveSlackModule {}

const parseOptions = (): LiveSlackWorkerOptions => {
  let options: unknown;
  try { options = JSON.parse(process.argv[2] ?? '{}'); } catch { throw new HarnessError('INVALID_ARGUMENTS'); }
  if (typeof options !== 'object' || !options || Array.isArray(options)) throw new HarnessError('INVALID_ARGUMENTS');
  const value = options as Record<string, unknown>;
  const keys = ['command', 'sourceRoot', 'dataDirectory', 'taskId', 'planHash', 'workspaceId', 'channelId', 'threadTs', 'liveEnabled', 'expiresInMinutes'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))
    || typeof value['command'] !== 'string' || !liveSlackCommands.some((command) => command === value['command'])
    || keys.filter((key) => key !== 'liveEnabled' && key !== 'expiresInMinutes').some((key) => typeof value[key] !== 'string')
    || typeof value['liveEnabled'] !== 'boolean' || !Number.isSafeInteger(value['expiresInMinutes'])) {
    throw new HarnessError('INVALID_ARGUMENTS');
  }
  const command = value['command'] as LiveSlackCommand;
  const args: string[] = [command];
  if (!['slack-live-plan', 'slack-live-list', 'slack-live-prune'].includes(command)) args.push(value['taskId'] as string);
  if (command === 'slack-live-plan') {
    args.push('--workspace-id', value['workspaceId'] as string, '--channel-id', value['channelId'] as string, '--thread-ts', value['threadTs'] as string);
  }
  if (requiresLiveSlackNetwork(command)) args.push('--live-enabled', String(value['liveEnabled']));
  if (command === 'slack-live-approve' || command === 'slack-live-send') args.push('--plan-hash', value['planHash'] as string);
  if (command === 'slack-live-approve') args.push('--expires-in-minutes', String(value['expiresInMinutes']));
  args.push('--data-dir', value['dataDirectory'] as string);
  const parsed = parseLiveSlackArguments(args);
  if (Object.entries(parsed).some(([key, entry]) => value[key] !== entry)) throw new HarnessError('INVALID_ARGUMENTS');
  return options as LiveSlackWorkerOptions;
};

const assertRestrictedWorker = async (options: LiveSlackWorkerOptions): Promise<void> => {
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const permissions = process.permission;
  const network = requiresLiveSlackNetwork(options.command) && options.liveEnabled;
  const requiredFlags = ['--permission', safeReadFlag(sourceRoot), safeReadFlag(options.dataDirectory), `--allow-fs-write=${options.dataDirectory}`,
    ...(network ? ['--allow-net'] : [])];
  const allowedFlags = [...requiredFlags, '--disable-warning=ExperimentalWarning'];
  if (options.sourceRoot !== sourceRoot || !permissions || permissions.has('fs.write', sourceRoot)
    || !permissions.has('fs.write', options.dataDirectory) || permissions.has('child') || permissions.has('worker')
    || permissions.has('net') !== network || permissions.has('addons') || permissions.has('wasi') || permissions.has('inspector')
    || permissions.has('ffi') || permissions.has('fs-vfs')
    || requiredFlags.some((flag) => !process.execArgv.includes(flag))
    || process.execArgv.some((flag) => !allowedFlags.includes(flag)) || new Set(process.execArgv).size !== process.execArgv.length) {
    throw new HarnessError('SLACK_LIVE_UNSAFE_WORKER_PERMISSIONS');
  }
  if (!process.getuid) throw new HarnessError('LOCAL_OWNER_UNAVAILABLE');
  const environmentKeys = ['LANG', 'TZ', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []), ...(network ? ['SLACK_SEND_TOKEN'] : [])];
  if (Object.keys(process.env).some((key) => !environmentKeys.includes(key))) {
    throw new HarnessError('SLACK_LIVE_UNSAFE_WORKER_ENVIRONMENT');
  }
  if (network && !isSlackSendToken(process.env['SLACK_SEND_TOKEN'])) throw new HarnessError('SLACK_LIVE_TOKEN_FORMAT_INVALID');
  const directory = await lstat(options.dataDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
    || directory.uid !== process.getuid() || await realpath(options.dataDirectory) !== options.dataDirectory) {
    throw new HarnessError('DATA_DIRECTORY_NOT_PRIVATE');
  }
  assertPrivateLiveSlackFiles(options.dataDirectory);
};

const withoutBody = ({ body: _body, ...metadata }: LiveSnapshot): Omit<LiveSnapshot, 'body'> => metadata;

const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = parseOptions();
  await assertRestrictedWorker(options);
  const network = requiresLiveSlackNetwork(options.command);
  if (network && !options.liveEnabled) throw new HarnessError('SLACK_LIVE_SEND_DISABLED');
  const secret: Record<string, string | undefined> = { token: process.env['SLACK_SEND_TOKEN'] };
  delete process.env['SLACK_SEND_TOKEN'];
  const disabledPort: LiveSlackPort = {
    capture: async () => { throw new HarnessError('LIVE_DISABLED'); },
    post: async () => { throw new HarnessError('LIVE_DISABLED'); },
  };
  const slack = network ? new LiveSlackAdapter(secret['token']!) : disabledPort;
  delete secret['token'];
  const ownerId = `os-user:${process.getuid!()}`;
  const application = await NestFactory.createApplicationContext({
    module: LiveSlackModule,
    providers: [
      { provide: STORE, useFactory: () => new SqliteLiveSlackStore(join(options.dataDirectory, 'live-replies.sqlite')) },
      { provide: LiveSlackService, inject: [STORE], useFactory: (store: SqliteLiveSlackStore) => new LiveSlackService(store, slack) },
    ],
  }, { logger: false, abortOnError: false });
  const store = application.get<SqliteLiveSlackStore>(STORE);
  const service = application.get(LiveSlackService);
  const output = (result: object): void => { process.stdout.write(`${JSON.stringify({
    ...result, mode: 'live-test', liveEnabled: options.liveEnabled, dataDirectory: options.dataDirectory,
  }, null, 2)}\n`); };
  try {
    // 수동 recover 없이 SENDING을 재개하거나 승인 소비를 되돌리지 않는다.
    const maintenance = service.maintain();
    if (options.command === 'slack-live-plan') {
      const snapshot = await service.create({
        policy: 'slack-live-test-v1', liveEnabled: options.liveEnabled,
        workspaceId: options.workspaceId, channelId: options.channelId, threadTs: options.threadTs,
      }, ownerId);
      output({ ...snapshot, maintenance });
    } else if (options.command === 'slack-live-inspect') {
      output({ ...service.inspect(options.taskId, ownerId), maintenance });
    } else if (options.command === 'slack-live-approve') {
      const approval = await service.approve(options.taskId, options.planHash, options.expiresInMinutes, ownerId);
      output({ ...withoutBody(service.inspect(options.taskId, ownerId)), approval, maintenance });
    } else if (options.command === 'slack-live-send') {
      const attempt = await service.send(options.taskId, options.planHash, ownerId);
      output({ ...withoutBody(service.inspect(options.taskId, ownerId)), attempt, maintenance });
    } else if (options.command === 'slack-live-cancel') {
      output({ ...withoutBody(service.cancel(options.taskId, ownerId)), maintenance });
    } else if (options.command === 'slack-live-recover') {
      output({ ...withoutBody(service.recover(options.taskId, ownerId)), maintenance });
    } else if (options.command === 'slack-live-list') {
      output({ tasks: service.list(ownerId), maintenance });
    } else if (options.command === 'slack-live-prune') output({ maintenance });
    else throw new HarnessError('UNKNOWN_COMMAND');
  } finally {
    store.close();
    await application.close();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof HarnessError ? error.code : 'SLACK_LIVE_WORKER_FAILED'}\n`);
  process.exitCode = 1;
});
