import { HarnessError } from '../domain/errors.js';
import type { OfflinePostIntent, SlackPostConfig, SlackPostResult } from '../domain/slack-post.js';
import type { SlackPostContractPort, SlackPostHttpPort, SlackPostHttpRequest } from '../ports/slack-post.js';
import { assertOfflinePostIntent, hashPostThread, isPostTimestamp, normalizePostThread, offlinePostBody } from '../policy/slack-post-policy.js';

const syntheticAuthorization = 'Bearer SYNTHETIC_OFFLINE_TOKEN';
const identityUrl = 'https://slack.com/api/auth.test';
const threadUrl = 'https://slack.com/api/conversations.replies';
const messageUrl = 'https://slack.com/api/chat.postMessage';
const confirmedRejections = new Set([
  'missing_scope', 'not_authed', 'invalid_auth', 'account_inactive', 'token_revoked', 'no_permission',
  'channel_not_found', 'not_in_channel', 'is_archived', 'restricted_action', 'restricted_action_read_only_channel',
  'restricted_action_non_threadable_channel', 'restricted_action_thread_only_channel', 'restricted_action_thread_locked',
  'msg_too_long', 'no_text', 'invalid_arguments', 'invalid_arg_name', 'invalid_blocks', 'invalid_metadata',
  'thread_not_found', 'ratelimited', 'rate_limited',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const safeIntentHash = (intent: unknown): string => {
  return isRecord(intent) && typeof intent.intentHash === 'string' && /^[a-f0-9]{64}$/.test(intent.intentHash) ? intent.intentHash : '';
};

const cancelBody = (response: Response): void => {
  try { void response.body?.cancel().catch(() => {}); } catch { /* 잠긴 스트림의 정리는 reader가 담당한다. */ }
};

const readBoundedJson = async (response: Response, maximumBytes: number, signal: AbortSignal): Promise<Record<string, unknown>> => {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    cancelBody(response);
    throw new HarnessError('SLACK_POST_RESPONSE_TOO_LARGE');
  }
  if (response.body === null) throw new HarnessError('SLACK_POST_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new HarnessError('SLACK_POST_REQUEST_CANCELLED');
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new HarnessError('SLACK_POST_REQUEST_CANCELLED');
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        cancel();
        throw new HarnessError('SLACK_POST_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch {
    throw new HarnessError('SLACK_POST_INVALID_RESPONSE');
  }
  if (!isRecord(payload)) throw new HarnessError('SLACK_POST_INVALID_RESPONSE');
  return payload;
};

/** 실제 HTTP 구현을 제공하지 않으며 기본 구성에서는 요청을 항상 거부한다. */
export class DisabledSlackPostHttp implements SlackPostHttpPort {
  readonly mode = 'disabled' as const;

  async request(_request: SlackPostHttpRequest): Promise<Response> {
    throw new HarnessError('SLACK_POST_DISABLED');
  }
}

/** 고정 Slack wire 계약을 합성 HTTP로 검증한다. 진단 intent는 전송 승인이 아니다. */
export class SlackPostMessageAdapter implements SlackPostContractPort {
  readonly liveEnabled = false as const;
  private readonly attemptedOperations = new Set<string>();

  constructor(
    private readonly transport: SlackPostHttpPort = new DisabledSlackPostHttp(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async verify(intent: OfflinePostIntent, config: SlackPostConfig, signal?: AbortSignal): Promise<SlackPostResult> {
    const calls = { auth: 0, thread: 0, post: 0 };
    const result = (status: SlackPostResult['status'], code: string | null, receipt: SlackPostResult['receipt'] = null): SlackPostResult => ({
      status, code, receipt, intentHash: safeIntentHash(intent), calls: { ...calls },
    });
    if (this.transport.mode !== 'offline') return result('BLOCKED', 'SLACK_POST_DISABLED');
    const checkIntent = (): void => {
      if (signal?.aborted) throw new HarnessError('SLACK_POST_REQUEST_CANCELLED');
      try { assertOfflinePostIntent(intent, config, this.clock()); } catch {
        throw new HarnessError('SLACK_POST_INVALID_INTENT');
      }
    };
    try {
      checkIntent();
      if (this.attemptedOperations.has(intent.operationId)) return result('BLOCKED', 'SLACK_POST_ALREADY_ATTEMPTED');
      calls.auth += 1;
      const identity = await this.request(identityUrl, 'POST', null, config, signal);
      if (identity.status !== 200 || identity.payload.ok !== true
        || identity.payload.team_id !== config.workspaceId || identity.payload.bot_id !== config.botId
        || identity.payload.user_id !== config.botUserId) return result('BLOCKED', 'SLACK_POST_IDENTITY_MISMATCH');
      checkIntent();
      calls.thread += 1;
      const parameters = new URLSearchParams({ channel: intent.channelId, ts: intent.threadTs });
      const thread = await this.request(`${threadUrl}?${parameters.toString()}`, 'GET', null, config, signal);
      if (thread.status !== 200 || thread.payload.ok !== true) return result('BLOCKED', 'SLACK_POST_THREAD_UNAVAILABLE');
      let messages;
      try { messages = normalizePostThread(thread.payload, config); } catch {
        return result('BLOCKED', 'SLACK_POST_THREAD_INCOMPLETE');
      }
      const source = messages.find((message) => message.ts === intent.messageTs);
      if (messages[0]?.ts !== intent.threadTs || source?.revision !== intent.requestRevision
        || hashPostThread(messages) !== intent.contextHash) return result('BLOCKED', 'SLACK_POST_THREAD_CHANGED');
      checkIntent();
      // 같은 operationId의 동시 진단도 POST 직전의 동기 구간에서 한 번만 소비한다.
      if (this.attemptedOperations.has(intent.operationId)) return result('BLOCKED', 'SLACK_POST_ALREADY_ATTEMPTED');
      this.attemptedOperations.add(intent.operationId);
      calls.post += 1;
      const postBody = JSON.stringify({
        channel: intent.channelId, text: offlinePostBody, thread_ts: intent.threadTs,
        reply_broadcast: false, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
      });
      const posted = await this.request(messageUrl, 'POST', postBody, config, signal);
      if (posted.status === 429) return result('NOT_SENT', 'SLACK_POST_RATE_LIMITED');
      if (posted.status >= 500) return result('UNKNOWN', 'SLACK_POST_HTTP_UNCERTAIN');
      if (posted.payload.ok === false) {
        return !('ts' in posted.payload) && !('message' in posted.payload)
          && typeof posted.payload.error === 'string' && confirmedRejections.has(posted.payload.error)
          ? result('NOT_SENT', 'SLACK_POST_API_REJECTED')
          : result('UNKNOWN', 'SLACK_POST_API_UNCERTAIN');
      }
      if (posted.status !== 200) return result('UNKNOWN', 'SLACK_POST_HTTP_UNCERTAIN');
      const receiptMessage = posted.payload.message;
      if (posted.payload.ok !== true || posted.payload.channel !== intent.channelId
        || !isPostTimestamp(posted.payload.ts) || messages.some((message) => message.ts === posted.payload.ts)
        || !isRecord(receiptMessage) || receiptMessage.ts !== posted.payload.ts
        || receiptMessage.thread_ts !== intent.threadTs || receiptMessage.user !== config.botUserId
        || receiptMessage.bot_id !== config.botId || receiptMessage.text !== offlinePostBody) {
        return result('UNKNOWN', 'SLACK_POST_RECEIPT_MISMATCH');
      }
      return result('OFFLINE_CONFIRMED', null, { channelId: intent.channelId, messageTs: posted.payload.ts, threadTs: intent.threadTs });
    } catch (error: unknown) {
      const knownCodes = new Set([
        'SLACK_POST_INVALID_INTENT', 'SLACK_POST_REQUEST_CANCELLED', 'SLACK_POST_REQUEST_TIMEOUT',
        'SLACK_POST_RESPONSE_TOO_LARGE', 'SLACK_POST_INVALID_RESPONSE', 'SLACK_POST_REDIRECT',
      ]);
      const code = error instanceof HarnessError && knownCodes.has(error.code) ? error.code : 'SLACK_POST_REQUEST_FAILED';
      return result(calls.post === 0 ? 'BLOCKED' : 'UNKNOWN', code);
    }
  }

  private async request(
    url: string, method: 'GET' | 'POST', body: string | null, config: SlackPostConfig, signal?: AbortSignal,
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    if (signal?.aborted) throw new HarnessError('SLACK_POST_REQUEST_CANCELLED');
    const controller = new AbortController();
    const { requestTimeoutMs, maxResponseBytes } = config;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelled: ((reason: Error) => void) | undefined;
    const abort = (): void => {
      rejectCancelled?.(new HarnessError('SLACK_POST_REQUEST_CANCELLED'));
      controller.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        rejectCancelled = reject;
        timeout = setTimeout(() => {
          reject(new HarnessError('SLACK_POST_REQUEST_TIMEOUT'));
          controller.abort();
        }, requestTimeoutMs);
      });
      if (signal?.aborted) abort();
      const operation = (async () => {
        const response = await this.transport.request({
          url, method, body, redirect: 'error', signal: controller.signal,
          headers: { Authorization: syntheticAuthorization, 'Content-Type': 'application/json; charset=utf-8' },
        });
        if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
          || (response.url !== '' && response.url !== url)) {
          cancelBody(response);
          throw new HarnessError('SLACK_POST_REDIRECT');
        }
        // HTTP 429 자체가 미전송의 증거다. 오류 본문은 기록하거나 반영하지 않는다.
        if (response.status === 429 || response.status >= 500) {
          cancelBody(response);
          return { status: response.status, payload: {} };
        }
        return { status: response.status, payload: await readBoundedJson(response, maxResponseBytes, controller.signal) };
      })();
      return await Promise.race([operation, deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}
