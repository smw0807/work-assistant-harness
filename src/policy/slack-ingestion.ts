import { HarnessError } from '../domain/errors.js';
import type { SlackMessageChange, SlackReceiverConfig } from '../domain/slack.js';
import { containsSensitiveText, redactSlackText } from './redaction.js';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const timestampPattern = /^\d{1,20}\.\d{1,10}$/;
export const asSlackRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
};
const isId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value) && !containsSensitiveText(value);
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && timestampPattern.test(value);
const isBoundedInteger = (value: unknown, minimum: number, maximum: number): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
};

/** 설정은 권한을 넓히는 입력이므로 알 수 없는 키나 비밀값을 받지 않는다. */
export const parseSlackReceiverConfig = (input: unknown): SlackReceiverConfig => {
  const value = asSlackRecord(input);
  const keys = ['workspaceId', 'channelIds', 'targetUserId', 'retentionHours', 'maxPending', 'thread', 'liveReadEnabled'];
  const thread = asSlackRecord(value?.['thread']);
  if (!value || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))
    || !isId(value['workspaceId']) || !isId(value['targetUserId'])
    || !Array.isArray(value['channelIds']) || value['channelIds'].length < 1 || value['channelIds'].length > 10
    || !value['channelIds'].every(isId) || new Set(value['channelIds']).size !== value['channelIds'].length
    || !isBoundedInteger(value['retentionHours'], 1, 168) || !isBoundedInteger(value['maxPending'], 1, 1_000)
    || typeof value['liveReadEnabled'] !== 'boolean' || !thread
    || Object.keys(thread).length !== 3 || Object.keys(thread).some((key) => !['maxMessages', 'maxPages', 'maxBytes'].includes(key))
    || !isBoundedInteger(thread['maxMessages'], 1, 100) || !isBoundedInteger(thread['maxPages'], 1, 10)
    || !isBoundedInteger(thread['maxBytes'], 1_024, 65_536)) {
    throw new HarnessError('SLACK_INVALID_CONFIG');
  }
  return {
    workspaceId: value['workspaceId'], channelIds: [...value['channelIds']], targetUserId: value['targetUserId'],
    retentionHours: value['retentionHours'], maxPending: value['maxPending'], liveReadEnabled: value['liveReadEnabled'],
    thread: { maxMessages: thread['maxMessages'], maxPages: thread['maxPages'], maxBytes: thread['maxBytes'] },
  };
};

/** Transport envelope를 벗긴 Events API payload만 받는다. 변경 이벤트에는 현재 멘션을 요구하지 않는다. */
export const normalizeSlackChange = (input: unknown, policy: SlackReceiverConfig): SlackMessageChange | null => {
  const payload = asSlackRecord(input);
  const event = asSlackRecord(payload?.['event']);
  if (!payload || payload['type'] !== 'event_callback' || !event || event['type'] !== 'message'
    || payload['team_id'] !== policy.workspaceId || !isId(payload['event_id'])
    || !isId(event['channel']) || !policy.channelIds.includes(event['channel'])) return null;
  const subtype = event['subtype'];
  const kind = subtype === 'message_changed' ? 'edited' : subtype === 'message_deleted' ? 'deleted' : 'created';
  if (kind === 'created' && subtype !== undefined) return null;
  const message = kind === 'edited' ? asSlackRecord(event['message'])
    : kind === 'deleted' ? asSlackRecord(event['previous_message']) : event;
  if (kind !== 'deleted' && (!message || message['bot_id'] !== undefined || message['bot_profile'] !== undefined
    || message['subtype'] !== undefined || message['user'] === policy.targetUserId)) return null;
  const messageTs = kind === 'deleted' ? event['deleted_ts'] : message?.['ts'];
  const threadTs = message?.['thread_ts'] ?? messageTs;
  const edited = asSlackRecord(message?.['edited']);
  const revision = kind === 'created' ? messageTs
    : kind === 'edited' ? edited?.['ts'] ?? event['event_ts'] : event['event_ts'];
  const requesterId = message?.['user'];
  const text = kind === 'deleted' ? '' : message?.['text'];
  if (!isTimestamp(messageTs) || !isTimestamp(threadTs) || !isTimestamp(revision)
    || (kind !== 'deleted' && !isId(requesterId))
    || (requesterId !== undefined && !isId(requesterId))
    || typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 16_384) return null;
  const mentionsTarget = text.includes(`<@${policy.targetUserId}>`);
  if (kind === 'created' && !mentionsTarget) return null;
  return {
    kind, eventId: payload['event_id'], workspaceId: policy.workspaceId, channelId: event['channel'],
    messageTs, threadTs, requesterId: requesterId ?? '', revision,
    text: mentionsTarget ? redactSlackText(text) : '', mentionsTarget,
  };
};

export const parseSocketEnvelope = (input: unknown): { envelopeId: string; payload: unknown } | null => {
  const envelope = asSlackRecord(input);
  if (!envelope || envelope['type'] !== 'events_api' || !isId(envelope['envelope_id'])) return null;
  return { envelopeId: envelope['envelope_id'], payload: envelope['payload'] };
};
