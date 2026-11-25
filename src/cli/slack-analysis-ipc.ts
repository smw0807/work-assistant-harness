import type { SlackCollectedRequest } from '../domain/slack.js';
import { SLACK_THREAD_LIMITS } from '../policy/slack-ingestion.js';

export interface SlackSnapshotMessage {
  type: 'slack-analysis-snapshot';
  request: SlackCollectedRequest;
}

/** 부모는 수신 본문을 로그에 쓰거나 해석하지 않고, 정해진 IPC 메시지만 분석기로 전달한다. */
export const isSlackSnapshotMessage = (value: unknown): value is SlackSnapshotMessage => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !('type' in value) || value.type !== 'slack-analysis-snapshot' || !('request' in value)) return false;
  const request = value.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || !('status' in request) || request.status !== 'RECORDED' || !('thread' in request)) return false;
  const thread = request.thread;
  return !!thread && typeof thread === 'object' && 'complete' in thread && thread.complete === true
    && 'reason' in thread && thread.reason === null && 'messages' in thread && Array.isArray(thread.messages)
    && thread.messages.length > 0 && thread.messages.length <= SLACK_THREAD_LIMITS.maxMessages
    && Buffer.byteLength(JSON.stringify(value)) <= 144 * 1024;
};
