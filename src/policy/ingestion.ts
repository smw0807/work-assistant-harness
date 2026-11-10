import type { IngestionPolicy, MessageEvent } from '../domain/types.js';
import { redactSensitiveText } from './redaction.js';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const timestampPattern = /^\d{1,20}\.\d{1,10}$/;
const maxMessageBytes = 16_384;

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
};

const isId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && timestampPattern.test(value);

export const normalizeMessage = (input: unknown, policy: IngestionPolicy): MessageEvent | null => {
  const envelope = asRecord(input);
  const event = asRecord(envelope?.['event']);
  if (!envelope || !event || event['type'] !== 'message') return null;
  // Edits, deletes, bot messages and every other subtype are deliberately unsupported.
  if (event['subtype'] !== undefined || event['bot_id'] !== undefined || event['bot_profile'] !== undefined) return null;
  if (!isId(policy.workspaceId) || !isId(policy.targetUserId) || !policy.channelIds.every(isId)) return null;

  const eventId = envelope['event_id'];
  const workspaceId = envelope['team_id'];
  const channelId = event['channel'];
  const requesterId = event['user'];
  const timestamp = event['ts'];
  const threadTimestamp = event['thread_ts'] ?? timestamp;
  const text = event['text'];
  if (!isId(eventId) || !isId(workspaceId) || !isId(channelId) || !isId(requesterId)) return null;
  if (!isTimestamp(timestamp) || !isTimestamp(threadTimestamp)) return null;
  if (workspaceId !== policy.workspaceId || !policy.channelIds.includes(channelId)) return null;
  if (requesterId === policy.targetUserId || typeof text !== 'string') return null;
  if (Buffer.byteLength(text, 'utf8') > maxMessageBytes || !text.includes(`<@${policy.targetUserId}>`)) return null;

  return {
    eventId, workspaceId, channelId, requesterId,
    threadTs: threadTimestamp,
    messageTs: timestamp,
    revision: timestamp,
    text: redactSensitiveText(text),
  };
};
