import { execFileSync, spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';
import type { SlackReceiverConfig } from '../domain/slack.js';
import { parseSlackReceiverConfig } from '../policy/slack-ingestion.js';
import { acquireRuntimeLease, assertSafeEventFile, defaultDataDirectory, prepareDataDirectory, safeReadFlag } from './runtime.js';

export interface SlackWorkerOptions {
  command: 'slack-replay' | 'slack-list' | 'slack-inspect' | 'slack-listen';
  sourceRoot: string;
  dataDirectory: string;
  eventsPath: string;
  channelId: string;
  messageTs: string;
  config: SlackReceiverConfig;
}

export const slackUsage = 'pnpm harness slack-replay [--events <synthetic-json>] [--config <json>] [--data-dir <private-directory>]\npnpm harness slack-list [--config <json>] [--data-dir <private-directory>]\npnpm harness slack-inspect <channel-id> <message-ts> [--config <json>] [--data-dir <private-directory>]\npnpm harness slack-listen --config <json> [--data-dir <private-directory>]';

const parseArguments = async (args: string[], sourceRoot: string): Promise<SlackWorkerOptions> => {
  const command = args.shift();
  if (command !== 'slack-replay' && command !== 'slack-list' && command !== 'slack-inspect' && command !== 'slack-listen') {
    throw new HarnessError('UNKNOWN_COMMAND');
  }
  const channelId = command === 'slack-inspect' ? args.shift() ?? '' : '';
  const messageTs = command === 'slack-inspect' ? args.shift() ?? '' : '';
  if (command === 'slack-inspect' && (!/^[A-Za-z0-9_-]{1,128}$/.test(channelId) || !/^\d{1,20}\.\d{1,10}$/.test(messageTs))) {
    throw new HarnessError('SLACK_INVALID_MESSAGE_ID');
  }
  const flags = new Map<string, string>();
  while (args.length > 0) {
    const flag = args.shift() ?? '';
    const value = args.shift();
    if (!['--events', '--config', '--data-dir'].includes(flag) || !value || value.startsWith('--') || flags.has(flag)) {
      throw new HarnessError('INVALID_ARGUMENTS');
    }
    flags.set(flag, value);
  }
  if (command !== 'slack-replay' && flags.has('--events')) throw new HarnessError('INVALID_ARGUMENTS');
  if (command === 'slack-listen' && !flags.has('--config')) throw new HarnessError('SLACK_EXPLICIT_CONFIG_REQUIRED');
  const configPath = await assertSafeEventFile(flags.get('--config') ?? join(sourceRoot, 'config', 'slack.example.json'));
  const config = parseSlackReceiverConfig(JSON.parse(await readFile(configPath, 'utf8')));
  if (command === 'slack-listen' && !config.liveReadEnabled) throw new HarnessError('SLACK_LIVE_READ_DISABLED');
  const eventsPath = command === 'slack-replay'
    ? await assertSafeEventFile(flags.get('--events') ?? join(sourceRoot, 'fixtures', 'slack', 'receive.json')) : '';
  const dataDirectory = await prepareDataDirectory(flags.get('--data-dir') ?? defaultDataDirectory(), sourceRoot);
  return { command, sourceRoot, dataDirectory, config, eventsPath, channelId, messageTs };
};

export const runSlackCommand = async (args: string[]): Promise<void> => {
  process.umask(0o077);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const options = await parseArguments(args, sourceRoot);
  const live = options.command === 'slack-listen';
  const receiverEnvironment: Record<string, string> = { LANG: 'C.UTF-8', TZ: 'UTC' };
  if (live) {
    if (!process.env['SLACK_APP_TOKEN'] || !process.env['SLACK_WEB_TOKEN']) throw new HarnessError('SLACK_TOKENS_REQUIRED');
    receiverEnvironment['SLACK_APP_TOKEN'] = process.env['SLACK_APP_TOKEN'];
    receiverEnvironment['SLACK_WEB_TOKEN'] = process.env['SLACK_WEB_TOKEN'];
  }
  const readOnly = options.command === 'slack-list' || options.command === 'slack-inspect';
  const releaseLease = readOnly ? () => {} : acquireRuntimeLease(options.dataDirectory);
  try {
    const executable = await realpath(process.execPath);
    const permissions = ['--permission', safeReadFlag(sourceRoot), safeReadFlag(options.dataDirectory), `--allow-fs-write=${options.dataDirectory}`];
    if (options.eventsPath) permissions.push(safeReadFlag(options.eventsPath));
    if (live) permissions.push('--allow-net');
    const workerArgs = [...permissions, join(sourceRoot, 'dist', 'src', 'cli', 'slack-worker.js'), JSON.stringify(options)];
    if (!live) {
      const output = execFileSync(executable, workerArgs, {
        cwd: sourceRoot, env: receiverEnvironment, encoding: 'utf8', timeout: 30_000,
        maxBuffer: 512_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      process.stdout.write(output);
      return;
    }
    await new Promise<void>((resolveRun, reject) => {
      const child = spawn(executable, workerArgs, { cwd: sourceRoot, env: receiverEnvironment, stdio: ['ignore', 'inherit', 'inherit'] });
      const stop = (): void => { child.kill('SIGTERM'); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      child.once('error', () => reject(new HarnessError('SLACK_RECEIVER_START_FAILED')));
      child.once('exit', (code, signal) => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        if (code === 0 || signal === 'SIGTERM') resolveRun();
        else reject(new HarnessError('SLACK_RECEIVER_FAILED'));
      });
    });
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new HarnessError(/^[A-Z][A-Z0-9_]{1,80}$/.test(stderr) ? stderr : 'SLACK_RECEIVER_FAILED');
  } finally {
    releaseLease();
  }
};
