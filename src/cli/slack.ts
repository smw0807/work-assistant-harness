import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';
import { getSlackListIds, type SlackReceiverConfig } from '../domain/slack.js';
import { parseSlackReceiverConfig } from '../policy/slack-ingestion.js';
import { acquireRuntimeLease, assertSafeEventFile, defaultDataDirectory, prepareDataDirectory, safeReadFlag } from './runtime.js';
import { parseSlackEnvironment, readSlackEnvironmentFile, type SlackEnvironmentSettings } from './slack-environment.js';
import { runSlackAnalysisPair } from './slack-analysis-supervisor.js';
import { appendSlackAnalysisResults } from './slack-analysis-results.js';
import { hasSlackSourceMigration } from '../adapters/slack-source-metadata.js';

export interface SlackWorkerOptions {
  command: 'slack-replay' | 'slack-list' | 'slack-inspect' | 'slack-listen';
  sourceRoot: string;
  dataDirectory: string;
  eventsPath: string;
  channelId: string;
  messageTs: string;
  config: SlackReceiverConfig;
  analysisConfigPath?: string;
  analysisHandoff?: true;
}

export const slackUsage = 'pnpm harness slack-replay [--events <synthetic-json>] [--config <json> | --env | --env-file <private-env>] [--data-dir <private-directory>]\npnpm harness slack-list [--config <json> | --env | --env-file <private-env>] [--data-dir <private-directory>]\npnpm harness slack-inspect <channel-or-list-id> <message-ts> [--config <json> | --env | --env-file <private-env>] [--data-dir <private-directory>]\npnpm harness slack-listen (--config <json> | --env | --env-file <private-env>) [--data-dir <private-directory>]';

interface ParsedArguments { options: SlackWorkerOptions; environment: SlackEnvironmentSettings | null }
const parseArguments = async (args: string[], sourceRoot: string): Promise<ParsedArguments> => {
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
    if (flag === '--env') {
      if (flags.has(flag)) throw new HarnessError('INVALID_ARGUMENTS');
      flags.set(flag, ''); continue;
    }
    const value = args.shift();
    if (!['--events', '--config', '--env-file', '--data-dir'].includes(flag) || !value || value.startsWith('--') || flags.has(flag)) {
      throw new HarnessError('INVALID_ARGUMENTS');
    }
    flags.set(flag, value);
  }
  if (['--config', '--env', '--env-file'].filter(flag => flags.has(flag)).length > 1) throw new HarnessError('INVALID_ARGUMENTS');
  if (command !== 'slack-replay' && flags.has('--events')) throw new HarnessError('INVALID_ARGUMENTS');
  if (command === 'slack-listen' && !['--config', '--env', '--env-file'].some(flag => flags.has(flag))) throw new HarnessError('SLACK_EXPLICIT_CONFIG_REQUIRED');
  const environment = flags.has('--env') ? parseSlackEnvironment(process.env)
    : flags.has('--env-file') ? await readSlackEnvironmentFile(flags.get('--env-file')!) : null;
  const config = environment ? environment.config : parseSlackReceiverConfig(JSON.parse(await readFile(await assertSafeEventFile(
    flags.get('--config') ?? join(sourceRoot, 'config', 'slack.example.json')), 'utf8')));
  if (command === 'slack-listen' && !config.liveReadEnabled) throw new HarnessError('SLACK_LIVE_READ_DISABLED');
  if (command === 'slack-listen' && config.listAnalysisEnabled && !environment?.analysisConfigPath) {
    throw new HarnessError('SLACK_ANALYSIS_CONFIG_REQUIRED');
  }
  const eventsPath = command === 'slack-replay'
    ? await assertSafeEventFile(flags.get('--events') ?? join(sourceRoot, 'fixtures', 'slack', 'receive.json')) : '';
  const dataDirectory = await prepareDataDirectory(flags.get('--data-dir') ?? defaultDataDirectory(), sourceRoot);
  return { options: { command, sourceRoot, dataDirectory, config, eventsPath, channelId, messageTs,
    ...(environment?.analysisConfigPath ? { analysisConfigPath: environment.analysisConfigPath } : {}) }, environment };
};

export const runSlackCommand = async (args: string[]): Promise<void> => {
  process.umask(0o077);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const { options, environment } = await parseArguments(args, sourceRoot);
  const live = options.command === 'slack-listen';
  const receiverEnvironment: Record<string, string> = { LANG: 'C.UTF-8', TZ: 'UTC' };
  if (live) {
    const appToken = environment ? environment.appToken : process.env['SLACK_APP_TOKEN'];
    const webToken = environment ? environment.webToken : process.env['SLACK_WEB_TOKEN'];
    const listUserToken = environment ? environment.listUserToken : process.env['SLACK_LIST_USER_TOKEN'];
    if (options.config.channelIds.length > 0) {
      if (!appToken || !webToken) throw new HarnessError('SLACK_TOKENS_REQUIRED');
      receiverEnvironment['SLACK_APP_TOKEN'] = appToken;
      receiverEnvironment['SLACK_WEB_TOKEN'] = webToken;
    }
    if (getSlackListIds(options.config).length > 0) {
      if (listUserToken) receiverEnvironment['SLACK_LIST_USER_TOKEN'] = listUserToken;
      else if (webToken) receiverEnvironment['SLACK_WEB_TOKEN'] = webToken;
      else throw new HarnessError('SLACK_TOKENS_REQUIRED');
    }
  }
  const readOnly = options.command === 'slack-list' || options.command === 'slack-inspect';
  // 기존 수신기가 본문을 쓰는 도중 조회 CLI가 스키마를 교체하지 않도록 이관 때만 실행 잠금을 공유한다.
  let requiresLease = !readOnly;
  if (readOnly) {
    const file = join(options.dataDirectory, 'tasks.sqlite');
    if (existsSync(file)) {
      const database = new DatabaseSync(file, { readOnly: true });
      try { requiresLease = !hasSlackSourceMigration(database); } finally { database.close(); }
    } else requiresLease = true;
  }
  const releaseLease = requiresLease ? acquireRuntimeLease(options.dataDirectory) : () => {};
  try {
    const executable = await realpath(process.execPath);
    const permissions = ['--permission', safeReadFlag(sourceRoot), safeReadFlag(options.dataDirectory), `--allow-fs-write=${options.dataDirectory}`];
    if (options.eventsPath) permissions.push(safeReadFlag(options.eventsPath));
    if (live) permissions.push('--allow-net');
    const { analysisConfigPath, ...receiverOptions } = options;
    if (live && analysisConfigPath) receiverOptions.analysisHandoff = true;
    const workerArgs = [...permissions, join(sourceRoot, 'dist', 'src', 'cli', 'slack-worker.js'), JSON.stringify(receiverOptions)];
    if (!live) {
      const output = execFileSync(executable, workerArgs, {
        cwd: sourceRoot, env: receiverEnvironment, encoding: 'utf8', timeout: 30_000,
        maxBuffer: options.command === 'slack-list' && getSlackListIds(options.config).length > 0 ? 2_000_000 : 512_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      process.stdout.write(appendSlackAnalysisResults(output, options));
      return;
    }
    if (analysisConfigPath) {
      await runSlackAnalysisPair(executable, workerArgs,
        [join(sourceRoot, 'dist', 'src', 'cli', 'slack-analysis-worker.js'), JSON.stringify(options)], sourceRoot, receiverEnvironment);
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
