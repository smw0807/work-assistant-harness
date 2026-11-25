import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseEnv, types } from 'node:util';
import type { SlackReceiverConfig } from '../domain/slack.js';
import { HarnessError } from '../domain/errors.js';
import { parseSlackReceiverConfig, SLACK_THREAD_LIMITS } from '../policy/slack-ingestion.js';

export const SLACK_ENV_FILE_MAX_BYTES = 64_000;
export interface SlackEnvironmentSettings {
  config: SlackReceiverConfig;
  appToken: string | undefined;
  webToken: string | undefined;
  listUserToken?: string;
  analysisConfigPath?: string;
}
const keys = ['SLACK_WORKSPACE_ID', 'SLACK_TARGET_USER_ID', 'SLACK_CHANNEL_IDS', 'SLACK_LIST_ID', 'SLACK_LIST_IDS', 'SLACK_LIVE_READ_ENABLED',
  'SLACK_APP_TOKEN', 'SLACK_WEB_TOKEN', 'SLACK_LIST_USER_TOKEN', 'SLACK_ANALYSIS_ENABLED', 'SLACK_LIST_ANALYSIS_ENABLED', 'SLACK_ANALYSIS_CODEX_CONFIG'] as const;
const fail: (code: string) => never = code => { throw new HarnessError(code); };
const booleanValue = (value: string | undefined, optional = false): boolean => {
  if (optional && value === undefined) return false;
  if (value !== 'true' && value !== 'false') fail('SLACK_INVALID_ENV');
  return value === 'true';
};
const tokenValue = (value: string | undefined): string | undefined => {
  if (value === undefined || value === '') return undefined;
  if (value.length > 4096 || /\s/u.test(value) || value.includes('\0')) fail('SLACK_INVALID_ENV');
  return value;
};
const noControls = (value: string): boolean => [...value].every(character => {
  const code = character.codePointAt(0)!; return code >= 32 && code !== 127;
});

/** Select only declared Slack settings. Neither this parser nor the file loader modifies process.env. */
export const parseSlackEnvironment = (input: Record<string, string | undefined>): SlackEnvironmentSettings => {
  try {
    if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) fail('SLACK_INVALID_ENV');
    const values: Record<string, string | undefined> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor && (!Object.hasOwn(descriptor, 'value') || descriptor.value !== undefined && typeof descriptor.value !== 'string')) fail('SLACK_INVALID_ENV');
      const value: unknown = descriptor?.value;
      if (typeof value === 'string' && (value.length > 4096 || Buffer.from(value, 'utf8').toString('utf8') !== value)) fail('SLACK_INVALID_ENV');
      values[key] = value as string | undefined;
    }
    const channels = values['SLACK_CHANNEL_IDS'];
    if (values['SLACK_LIST_ID'] !== undefined && values['SLACK_LIST_IDS'] !== undefined) fail('SLACK_INVALID_ENV');
    const lists = values['SLACK_LIST_IDS'] ?? values['SLACK_LIST_ID'];
    const analysisEnabled = booleanValue(values['SLACK_ANALYSIS_ENABLED'], true);
    const listAnalysisEnabled = booleanValue(values['SLACK_LIST_ANALYSIS_ENABLED'], true);
    const config = parseSlackReceiverConfig({ workspaceId: values['SLACK_WORKSPACE_ID'], targetUserId: values['SLACK_TARGET_USER_ID'],
      channelIds: channels ? channels.split(',').map(value => value.trim()) : [],
      ...(lists !== undefined ? { listIds: lists.split(',').map(value => value.trim()) } : {}),
      ...(analysisEnabled && listAnalysisEnabled ? { listAnalysisEnabled: true } : {}),
      liveReadEnabled: booleanValue(values['SLACK_LIVE_READ_ENABLED']),
      retentionHours: 24, maxPending: 100, thread: SLACK_THREAD_LIMITS });
    const settings: SlackEnvironmentSettings = { config, appToken: tokenValue(values['SLACK_APP_TOKEN']), webToken: tokenValue(values['SLACK_WEB_TOKEN']) };
    const listUserToken = tokenValue(values['SLACK_LIST_USER_TOKEN']);
    if (listUserToken) settings.listUserToken = listUserToken;
    if (analysisEnabled && (config.channelIds.length > 0 || config.listAnalysisEnabled)) {
      const path = values['SLACK_ANALYSIS_CODEX_CONFIG'];
      if (!path || !isAbsolute(path) || resolve(path) !== path || !noControls(path)) fail('SLACK_INVALID_ENV');
      settings.analysisConfigPath = path;
    }
    return settings;
  } catch { return fail('SLACK_INVALID_ENV'); }
};

const metadata = (value: Stats) => ({ dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mode: value.mode,
  size: value.size, nlink: value.nlink, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs });
const equal = (left: Stats, right: Stats): boolean => JSON.stringify(metadata(left)) === JSON.stringify(metadata(right));
const assertPrivate = (value: Stats, maxBytes: number): void => {
  if (!process.getuid || !value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid() || value.nlink !== 1
    || (value.mode & 0o7777) !== 0o600 || value.size > maxBytes) fail('SLACK_PRIVATE_FILE_INVALID');
};

/** Read only an explicit owned 0600 file, bounded before allocation and verified before and after the read. */
export const readSlackPrivateFile = async (requested: string, maxBytes = 16_384): Promise<string> => {
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SLACK_ENV_FILE_MAX_BYTES
      || typeof requested !== 'string' || requested.length === 0 || requested.length > 4096 || !noControls(requested)) fail('SLACK_PRIVATE_FILE_INVALID');
    const path = resolve(requested), before = await lstat(path); assertPrivate(before, maxBytes);
    if (await realpath(path) !== path) fail('SLACK_PRIVATE_FILE_INVALID');
    // A replaced FIFO must not block before the opened descriptor can be checked as a regular file.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat(); assertPrivate(opened, maxBytes);
      if (!equal(before, opened)) fail('SLACK_PRIVATE_FILE_INVALID');
      const bytes = Buffer.alloc(before.size + 1); let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (read.bytesRead === 0) break; length += read.bytesRead;
      }
      const after = await handle.stat(), current = await lstat(path);
      assertPrivate(after, maxBytes); assertPrivate(current, maxBytes);
      if (length !== before.size || !equal(before, after) || !equal(before, current) || await realpath(path) !== path) fail('SLACK_PRIVATE_FILE_INVALID');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } finally { await handle.close(); }
  } catch { return fail('SLACK_PRIVATE_FILE_INVALID'); }
};

/** Missing file values never fall back to the ambient environment. No loaded key is assigned to process.env. */
export const readSlackEnvironmentFile = async (requested: string): Promise<SlackEnvironmentSettings> => {
  let parsed: Record<string, string | undefined>;
  try { parsed = parseEnv(await readSlackPrivateFile(requested, SLACK_ENV_FILE_MAX_BYTES)); }
  catch { return fail('SLACK_ENV_FILE_INVALID'); }
  return parseSlackEnvironment(parsed);
};
