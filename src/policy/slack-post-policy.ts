import { createHash, randomUUID } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import type { OfflinePostIntent, PostThreadMessage, SlackPostConfig } from '../domain/slack-post.js';

export const defaultSlackPostConfig: Readonly<SlackPostConfig> = {
  policy: 'slack-post-contract-v1', liveEnabled: false, workspaceId: 'T_LOCAL', channelId: 'C_ALLOWED',
  botId: 'B_LOCAL', botUserId: 'U_BOT', requestTimeoutMs: 250, maxResponseBytes: 16_384,
};
export const offlinePostBody = '오프라인 HTTP 계약 검증용 합성 메시지입니다.';
export const offlineThreadMessages: readonly PostThreadMessage[] = [
  { ts: '1700000000.000001', user: 'U_REQUESTER', text: '합성 스레드입니다.', revision: '1700000000.000001' },
  { ts: '1700000000.000002', user: 'U_REQUESTER', text: '합성 요청을 확인해 주세요.', revision: '1700000000.000002' },
];

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactKeys = (value: object, keys: string[]): boolean => Object.keys(value).length === keys.length
  && Object.keys(value).every((key) => keys.includes(key));
const validDate = (value: string): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
export const isPostTimestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{1,20}\.\d{1,20}$/.test(value);

export const assertSlackPostConfig = (config: SlackPostConfig): void => {
  if (!record(config) || !exactKeys(config, Object.keys(defaultSlackPostConfig))
    || Object.entries(defaultSlackPostConfig).some(([key, value]) => config[key] !== value)) {
    throw new HarnessError('SLACK_POST_INVALID_CONFIG');
  }
};

export const hashPostConfig = (config: SlackPostConfig): string => hash(JSON.stringify({
  policy: config.policy, liveEnabled: config.liveEnabled, workspaceId: config.workspaceId, channelId: config.channelId,
  botId: config.botId, botUserId: config.botUserId, requestTimeoutMs: config.requestTimeoutMs, maxResponseBytes: config.maxResponseBytes,
}));

// Slack timestamp는 숫자로 변환하지 않고 소수부의 정밀도를 유지해 비교한다.
const compareTimestamp = (left: string, right: string): number => {
  const [leftSeconds = '', leftFraction = ''] = left.split('.');
  const [rightSeconds = '', rightFraction = ''] = right.split('.');
  if (BigInt(leftSeconds) !== BigInt(rightSeconds)) return BigInt(leftSeconds) < BigInt(rightSeconds) ? -1 : 1;
  const length = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(length, '0').localeCompare(rightFraction.padEnd(length, '0'));
};

export const hashPostThread = (messages: readonly PostThreadMessage[]): string => hash(JSON.stringify(
  [...messages].sort((left, right) => compareTimestamp(left.ts, right.ts))
    .map((message) => ({ ts: message.ts, user: message.user, text: message.text, revision: message.revision })),
));

/** 부분 응답과 잘못된 timestamp·편집 revision을 완전한 문맥으로 처리하지 않는다. */
export const normalizePostThread = (payload: unknown, config: SlackPostConfig): PostThreadMessage[] => {
  assertSlackPostConfig(config);
  if (!record(payload) || payload['ok'] !== true || payload['has_more'] === true
    || (payload['has_more'] !== undefined && payload['has_more'] !== false)
    || !Array.isArray(payload['messages']) || payload['messages'].length === 0 || payload['messages'].length > 20) {
    throw new HarnessError('SLACK_POST_INCOMPLETE_THREAD');
  }
  const metadata = payload['response_metadata'];
  if (metadata !== undefined && (!record(metadata)
    || (metadata['next_cursor'] !== undefined && metadata['next_cursor'] !== ''))) {
    throw new HarnessError('SLACK_POST_INCOMPLETE_THREAD');
  }
  const messages = payload['messages'].map((message: unknown): PostThreadMessage => {
    if (!record(message) || !isPostTimestamp(message['ts']) || typeof message['user'] !== 'string'
      || !/^[A-Z][A-Za-z0-9_]{1,127}$/.test(message['user']) || typeof message['text'] !== 'string'
      || Buffer.byteLength(message['text']) > 4096
      || (message['thread_ts'] !== undefined && message['thread_ts'] !== offlineThreadMessages[0]!.ts)
      || message['subtype'] !== undefined) throw new HarnessError('SLACK_POST_INVALID_THREAD');
    const edited = message['edited'];
    if (edited !== undefined && (!record(edited) || !isPostTimestamp(edited['ts']))) throw new HarnessError('SLACK_POST_INVALID_THREAD');
    return { ts: message['ts'], user: message['user'], text: message['text'], revision: record(edited) ? String(edited['ts']) : message['ts'] };
  });
  const sorted = [...messages].sort((left, right) => compareTimestamp(left.ts, right.ts));
  if (sorted.some((message, index) => index > 0 && compareTimestamp(message.ts, sorted[index - 1]!.ts) === 0)
    || Buffer.byteLength(JSON.stringify(messages)) > config.maxResponseBytes) throw new HarnessError('SLACK_POST_INVALID_THREAD');
  return sorted;
};

export const hashOfflinePostIntent = (intent: Omit<OfflinePostIntent, 'intentHash'>): string => hash(JSON.stringify({
  policy: intent.policy, mode: intent.mode, operationId: intent.operationId, ownerId: intent.ownerId,
  configHash: intent.configHash, workspaceId: intent.workspaceId, channelId: intent.channelId,
  threadTs: intent.threadTs, messageTs: intent.messageTs, requestRevision: intent.requestRevision,
  contextHash: intent.contextHash, bodyHash: intent.bodyHash, createdAt: intent.createdAt, expiresAt: intent.expiresAt,
}));

export const assertOfflinePostIntent = (intent: OfflinePostIntent, config: SlackPostConfig, now: Date): void => {
  assertSlackPostConfig(config);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new HarnessError('SLACK_POST_INVALID_TIME');
  if (!record(intent) || !exactKeys(intent, ['policy', 'mode', 'operationId', 'ownerId', 'configHash', 'workspaceId',
    'channelId', 'threadTs', 'messageTs', 'requestRevision', 'contextHash', 'bodyHash', 'createdAt', 'expiresAt', 'intentHash'])
    || intent.policy !== config.policy || intent.mode !== 'offline-http'
    || typeof intent.operationId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(intent.operationId)
    || typeof intent.ownerId !== 'string' || !/^os-user:(0|[1-9]\d{0,15})$/.test(intent.ownerId)
    || intent.configHash !== hashPostConfig(config) || intent.workspaceId !== config.workspaceId || intent.channelId !== config.channelId
    || intent.threadTs !== offlineThreadMessages[0]!.ts || intent.messageTs !== offlineThreadMessages[1]!.ts
    || intent.requestRevision !== offlineThreadMessages[1]!.revision || intent.contextHash !== hashPostThread(offlineThreadMessages)
    || intent.bodyHash !== hash(offlinePostBody) || !validDate(intent.createdAt) || !validDate(intent.expiresAt)
    || Date.parse(intent.expiresAt) - Date.parse(intent.createdAt) !== 60_000
    || intent.intentHash !== hashOfflinePostIntent(intent)) throw new HarnessError('SLACK_POST_INVALID_INTENT');
  if (now.getTime() < Date.parse(intent.createdAt) || now.getTime() >= Date.parse(intent.expiresAt)) {
    throw new HarnessError('SLACK_POST_INTENT_EXPIRED');
  }
};

export const createOfflinePostIntent = (
  ownerId: string, now: Date, config: SlackPostConfig = defaultSlackPostConfig,
): OfflinePostIntent => {
  assertSlackPostConfig(config);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new HarnessError('SLACK_POST_INVALID_TIME');
  const value: Omit<OfflinePostIntent, 'intentHash'> = {
    policy: 'slack-post-contract-v1', mode: 'offline-http', operationId: randomUUID(), ownerId,
    configHash: hashPostConfig(config), workspaceId: config.workspaceId, channelId: config.channelId,
    threadTs: offlineThreadMessages[0]!.ts, messageTs: offlineThreadMessages[1]!.ts,
    requestRevision: offlineThreadMessages[1]!.revision, contextHash: hashPostThread(offlineThreadMessages),
    bodyHash: hash(offlinePostBody), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  const intent = { ...value, intentHash: hashOfflinePostIntent(value) };
  assertOfflinePostIntent(intent, config, now);
  return intent;
};
