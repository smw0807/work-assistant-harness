import { setTimeout as delay } from 'node:timers/promises';
import { HarnessError } from '../domain/errors.js';
import type { SlackListAnalysisThread } from '../domain/slack.js';
import { parseSlackListAnalysisMessage } from '../policy/slack-list-export.js';
import { SLACK_THREAD_LIMITS } from '../policy/slack-ingestion.js';
import { compareSlackTimestamps, isSlackTimestamp } from '../policy/slack-timestamp.js';
import { validateSlackSocketUrl } from './slack-socket-transport.js';

const maxResponseBytes = 262_144;
const maxRetryDelayMs = 60_000;
const listReplyPageSize = 15;
const maxListReplyCursorPages = 5;
const identifierPattern = /^[A-Za-z0-9_]{1,128}$/;
type SlackApiOperation = 'socket' | 'thread' | 'identity';
const knownApiErrors = new Set([
  'invalid_auth', 'not_authed', 'missing_scope', 'not_allowed_token_type', 'token_expired', 'token_revoked',
  'account_inactive', 'access_denied', 'accesslimited', 'forbidden_team', 'missing_args',
]);
const threadApiErrors = new Set(['channel_not_found', 'not_in_channel', 'thread_not_found', 'no_permission']);

/** Only fixed API error categories can enter logs; response text and metadata stay private. */
const apiRejectionCode = (operation: SlackApiOperation, response: Record<string, unknown>): string => {
  if (response.ok !== false || typeof response.error !== 'string'
    || !(knownApiErrors.has(response.error) || (operation === 'thread' && threadApiErrors.has(response.error)))) {
    return 'SLACK_API_REJECTED';
  }
  return `SLACK_${operation.toUpperCase()}_API_${response.error.toUpperCase()}`;
};

export interface SlackThreadLimits {
  maxMessages: number;
  maxPages: number;
  maxBytes: number;
}

export interface SlackThreadResult {
  messages: { ts: string; user: string; text: string }[];
  complete: boolean;
  reason: string | null;
}

interface SlackReadOptions {
  appToken?: string;
  webToken: string;
  allowedListIds?: readonly string[];
  requestTimeoutMs?: number;
  maxRetries?: number;
}

interface SlackReadDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const parseChannelThreadMessage = (raw: Record<string, unknown>) => {
  if (!isSlackTimestamp(raw.ts) || typeof raw.user !== 'string' || !identifierPattern.test(raw.user) || typeof raw.text !== 'string') {
    throw new HarnessError('SLACK_THREAD_UNSUPPORTED_MESSAGE');
  }
  return { message: { ts: raw.ts, user: raw.user, text: raw.text }, mentionsTarget: false };
};

const matchesListItem = (message: Record<string, unknown>, listId: string, itemId: string): boolean => {
  if ((message.list_id !== undefined && message.list_id !== listId)
    || [message.item_id, message.record_id, message.list_record_id].some(id => id !== undefined && id !== itemId)) return false;
  if (message.list_record === undefined) return true;
  if (!isRecord(message.list_record)) return false;
  const row = message.list_record.record ?? message.list_record;
  return isRecord(row) && (row.list_id === undefined || row.list_id === listId)
    && [row.record_id, row.id].every(id => id === undefined || id === itemId);
};

const threadPageCursor = (response: Record<string, unknown>): string => {
  if ((response.has_more !== undefined && typeof response.has_more !== 'boolean')
    || (response.response_metadata !== undefined && !isRecord(response.response_metadata))) throw new HarnessError('SLACK_INVALID_RESPONSE');
  const raw = response.response_metadata?.next_cursor;
  if (raw != null && (typeof raw !== 'string' || raw.length > 2048)) throw new HarnessError('SLACK_INVALID_RESPONSE');
  return raw?.trim() ?? '';
};

const parseListReplyPage = (response: Record<string, unknown>, channel: string, threadTs: string, oldest: string) => {
  if (!Array.isArray(response.messages) || response.messages.length > listReplyPageSize + 1) {
    throw new HarnessError('SLACK_INVALID_RESPONSE');
  }
  const nextCursor = threadPageCursor(response);
  const messages: unknown[] = [];
  let lastTs = oldest;
  for (const [index, message] of response.messages.entries()) {
    if (!isRecord(message) || !isSlackTimestamp(message.ts)
      || (message.channel !== undefined && message.channel !== channel)) throw new HarnessError('SLACK_INVALID_RESPONSE');
    // 범위 밖의 부모도 응답 첫 항목에 포함될 수 있다. 부모 본문은 알림 또는 진행 기준으로 쓰지 않는다.
    if (index === 0 && message.ts === threadTs && (message.thread_ts === undefined || message.thread_ts === threadTs)) continue;
    if (message.thread_ts !== threadTs || compareSlackTimestamps(message.ts, lastTs) <= 0) throw new HarnessError('SLACK_INVALID_RESPONSE');
    messages.push(message);
    lastTs = message.ts;
  }
  if (messages.length > listReplyPageSize) throw new HarnessError('SLACK_INVALID_RESPONSE');
  return { messages, hasMore: response.has_more === true || nextCursor !== '', nextCursor };
};

const validateInteger = (value: number, minimum: number, maximum: number): number => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new HarnessError('SLACK_INVALID_LIMIT');
  return value;
};

const cancellable = async <T>(operation: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> => {
  if (signal === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      onAbort?.();
      reject(new HarnessError('SLACK_REQUEST_CANCELLED'));
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort); });
    if (signal.aborted) abort();
  });
};

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maxResponseBytes) {
    await response.body?.cancel();
    throw new HarnessError('SLACK_RESPONSE_TOO_LARGE');
  }
  if (response.body === null) throw new HarnessError('SLACK_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw new HarnessError('SLACK_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HarnessError('SLACK_INVALID_RESPONSE');
  }
  if (!isRecord(parsed)) throw new HarnessError('SLACK_INVALID_RESPONSE');
  return parsed;
};

/** Only the three fixed metadata/read/intake operations below can reach the Slack Web API. */
export class SlackReadClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: SlackReadOptions, dependencies: SlackReadDependencies = {}) {
    const tokens = options.appToken === undefined ? [options.webToken] : [options.webToken, options.appToken];
    if (!tokens.every((token) => typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/\s/.test(token))) {
      throw new HarnessError('SLACK_INVALID_CREDENTIALS');
    }
    this.requestTimeoutMs = validateInteger(options.requestTimeoutMs ?? 10_000, 1, 60_000);
    this.maxRetries = validateInteger(options.maxRetries ?? 2, 0, 5);
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.sleep = dependencies.sleep ?? (async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); });
  }

  async openSocket(signal?: AbortSignal): Promise<string> {
    const response = await this.request('socket', new URLSearchParams(), signal);
    if (typeof response.url !== 'string') throw new HarnessError('SLACK_INVALID_SOCKET_URL');
    return validateSlackSocketUrl(response.url);
  }

  async verifyWorkspace(workspaceId: string, signal?: AbortSignal, expectedUserId?: string): Promise<void> {
    if (!identifierPattern.test(workspaceId)) throw new HarnessError('SLACK_INVALID_WORKSPACE');
    if (expectedUserId !== undefined && !identifierPattern.test(expectedUserId)) throw new HarnessError('SLACK_LIST_USER_MISMATCH');
    const response = await this.request('identity', new URLSearchParams(), signal);
    if (typeof response.team_id !== 'string' || !identifierPattern.test(response.team_id)) {
      throw new HarnessError('SLACK_INVALID_RESPONSE');
    }
    if (response.team_id !== workspaceId) throw new HarnessError('SLACK_WORKSPACE_MISMATCH');
    if (expectedUserId !== undefined && (response.user_id !== expectedUserId || Object.hasOwn(response, 'bot_id'))) {
      throw new HarnessError('SLACK_LIST_USER_MISMATCH');
    }
  }

  private listChannel(listId: string): string {
    if (!/^F[A-Z0-9]{1,63}$/.test(listId) || !this.options.allowedListIds?.includes(listId)) {
      throw new HarnessError('SLACK_LIST_DENIED');
    }
    return `C${listId.slice(1)}`;
  }

  /** 리스트 ID에서 파일 대화 ID를 정한다. 내보내기나 댓글이 임의의 조회 채널을 지정할 수 없다. */
  async readListThreadPage(listId: string, threadTs: string, oldest: string, signal: AbortSignal):
    Promise<{ messages: unknown[]; hasMore: boolean }> {
    const channel = this.listChannel(listId);
    if (!isSlackTimestamp(threadTs) || !isSlackTimestamp(oldest) || compareSlackTimestamps(oldest, threadTs) < 0) {
      throw new HarnessError('SLACK_INVALID_THREAD');
    }
    const parameters = new URLSearchParams({
      channel, ts: threadTs, oldest, inclusive: 'false', limit: String(listReplyPageSize),
    });
    const seenCursors = new Set<string>();
    for (let page = 0; page < maxListReplyCursorPages; page++) {
      const response = await this.request('thread', parameters, signal);
      const { messages, hasMore, nextCursor } = parseListReplyPage(response, channel, threadTs, oldest);
      if (messages.length || !hasMore) return { messages, hasMore };
      // 비어 있거나 부모만 있는 중간 페이지에는 저장할 답글 ts가 없다. 같은 시간 경계에서 Slack 커서로 이어간다.
      if (!nextCursor || seenCursors.has(nextCursor)) throw new HarnessError('SLACK_INVALID_RESPONSE');
      seenCursors.add(nextCursor);
      parameters.set('cursor', nextCursor);
    }
    throw new HarnessError('SLACK_THREAD_PAGE_LIMIT');
  }

  /** 현재 내보내기에 등록된 항목의 루트부터 다시 읽는다. 불완전한 응답은 분석 근거를 반환하지 않는다. */
  async readListAnalysisThread(listId: string, itemId: string, threadTs: string, targetUserId: string,
    limits: SlackThreadLimits, signal: AbortSignal): Promise<SlackListAnalysisThread> {
    const channel = this.listChannel(listId);
    if (!isSlackTimestamp(threadTs) || !/^[A-Za-z0-9_-]{1,128}$/.test(itemId) || !/^[UW][A-Z0-9_]{1,63}$/.test(targetUserId)) {
      throw new HarnessError('SLACK_INVALID_THREAD');
    }
    return this.collectThread(channel, threadTs, limits, signal, { listId, itemId, targetUserId });
  }

  async readThread(channelId: string, threadTs: string, limits: SlackThreadLimits = SLACK_THREAD_LIMITS, signal?: AbortSignal): Promise<SlackThreadResult> {
    if (!identifierPattern.test(channelId) || !isSlackTimestamp(threadTs)) throw new HarnessError('SLACK_INVALID_THREAD');
    return (await this.collectThread(channelId, threadTs, limits, signal)).thread;
  }

  private async collectThread(channel: string, threadTs: string, limits: SlackThreadLimits, signal?: AbortSignal,
    list?: { listId: string; itemId: string; targetUserId: string }): Promise<SlackListAnalysisThread> {
    validateInteger(limits.maxMessages, 1, SLACK_THREAD_LIMITS.maxMessages);
    validateInteger(limits.maxPages, 1, SLACK_THREAD_LIMITS.maxPages);
    validateInteger(limits.maxBytes, 1, SLACK_THREAD_LIMITS.maxBytes);
    const messages: SlackThreadResult['messages'] = [];
    const mentionTs: string[] = [];
    const incomplete = (reason: string): SlackListAnalysisThread => ({
      thread: { complete: false, reason, messages: list ? [] : messages }, mentionTs: [],
    });
    const seenCursors = new Set<string>();
    const pageSize = Math.min(list ? listReplyPageSize : 100, limits.maxMessages);
    const parameters = new URLSearchParams({ channel, ts: threadTs, limit: String(pageSize) });
    let replyCount: number | undefined;
    let latestReply: string | undefined;
    let totalBytes = 2;
    if (signal?.aborted) return incomplete('SLACK_REQUEST_CANCELLED');
    if (totalBytes > limits.maxBytes) return incomplete('SLACK_THREAD_BYTE_LIMIT');
    try {
      for (let page = 0; page < limits.maxPages; page++) {
        const response = await this.request('thread', parameters, signal);
        if (signal?.aborted) return incomplete('SLACK_REQUEST_CANCELLED');
        if (response.is_limited === true || !Array.isArray(response.messages) || response.messages.length > pageSize + 1) {
          return incomplete('SLACK_INVALID_RESPONSE');
        }
        const cursor = threadPageCursor(response);
        for (const [index, raw] of response.messages.entries()) {
          if (!isRecord(raw) || (raw.channel !== undefined && raw.channel !== channel)
            || (list && !matchesListItem(raw, list.listId, list.itemId))) return incomplete('SLACK_INVALID_RESPONSE');
          const root = raw.ts === threadTs;
          if (root ? index !== 0 || (raw.thread_ts !== undefined && raw.thread_ts !== threadTs)
            : !messages.length || raw.thread_ts !== threadTs) return incomplete('SLACK_INVALID_RESPONSE');
          const { message, mentionsTarget } = list ? parseSlackListAnalysisMessage(raw, list.targetUserId, root) : parseChannelThreadMessage(raw);
          if (root) {
            const count = raw.reply_count;
            if (list && count === undefined) return incomplete('SLACK_INVALID_RESPONSE');
            if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) return incomplete('SLACK_INVALID_RESPONSE');
            if (raw.latest_reply !== undefined && !isSlackTimestamp(raw.latest_reply)) return incomplete('SLACK_INVALID_RESPONSE');
            if (count !== undefined && count + 1 > limits.maxMessages) return incomplete('SLACK_THREAD_MESSAGE_LIMIT');
            if (messages.length > 0) {
              // 페이지 앞에 반복된 부모는 한 번만 센다. 페이지 사이에서 바뀐 스레드는 완전한 스냅샷이 아니다.
              if (replyCount !== count || latestReply !== raw.latest_reply || messages[0]!.user !== message.user
                || messages[0]!.text !== message.text) return incomplete('SLACK_INVALID_RESPONSE');
              continue;
            }
            replyCount = count;
            latestReply = raw.latest_reply;
          } else if (compareSlackTimestamps(message.ts, messages.at(-1)!.ts) <= 0) {
            return incomplete('SLACK_INVALID_RESPONSE');
          }
          if (messages.length >= limits.maxMessages) return incomplete('SLACK_THREAD_MESSAGE_LIMIT');
          totalBytes += Buffer.byteLength(JSON.stringify(message)) + (messages.length ? 1 : 0);
          if (totalBytes > limits.maxBytes) return incomplete('SLACK_THREAD_BYTE_LIMIT');
          messages.push(message);
          if (mentionsTarget) mentionTs.push(message.ts);
        }
        if (!cursor) {
          if (response.has_more === true) return incomplete('SLACK_THREAD_MISSING_CURSOR');
          if (!messages.length || (replyCount !== undefined && replyCount !== messages.length - 1)
            || (latestReply !== undefined && latestReply !== messages.at(-1)?.ts)) return incomplete('SLACK_INVALID_RESPONSE');
          return { thread: { messages, complete: true, reason: null }, mentionTs };
        }
        if (seenCursors.has(cursor)) return incomplete('SLACK_THREAD_REPEATED_CURSOR');
        seenCursors.add(cursor);
        parameters.set('cursor', cursor);
      }
      return incomplete('SLACK_THREAD_PAGE_LIMIT');
    } catch (error) {
      return incomplete(error instanceof HarnessError ? error.code : 'SLACK_THREAD_READ_FAILED');
    }
  }

  private async request(operation: SlackApiOperation, parameters = new URLSearchParams(), signal?: AbortSignal): Promise<Record<string, unknown>> {
    const apiUrl = {
      socket: 'https://slack.com/api/apps.connections.open',
      thread: 'https://slack.com/api/conversations.replies',
      identity: 'https://slack.com/api/auth.test',
    }[operation];
    const url = operation === 'thread' ? `${apiUrl}?${parameters.toString()}` : apiUrl;
    const token = operation === 'socket' ? this.options.appToken : this.options.webToken;
    if (!token) throw new HarnessError('SLACK_INVALID_CREDENTIALS');
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) throw new HarnessError('SLACK_REQUEST_CANCELLED');
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let retryDelayMs: number | undefined;
      try {
        const result = await cancellable(Promise.race([
          (async () => {
            const response = await this.fetch(url, {
              method: operation === 'thread' ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
              ...(operation === 'thread' ? {} : { body: '' }),
            });
            if (response.status === 429) {
              const header = response.headers.get('retry-after');
              await response.body?.cancel();
              const retryAfter = header !== null && /^\d+$/.test(header) ? Number(header) * 1000 : NaN;
              if (!Number.isSafeInteger(retryAfter) || retryAfter > maxRetryDelayMs || attempt === this.maxRetries) throw new HarnessError('SLACK_RATE_LIMITED');
              return { retryAfter: Math.max(1000, retryAfter) };
            }
            if (!response.ok) {
              await response.body?.cancel();
              throw new HarnessError('SLACK_HTTP_FAILED');
            }
            const parsed = await readJson(response);
            if (parsed.ok !== true) throw new HarnessError(apiRejectionCode(operation, parsed));
            return { parsed };
          })(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new HarnessError('SLACK_REQUEST_TIMEOUT'));
            }, this.requestTimeoutMs);
          }),
        ]), signal, () => { controller.abort(); });
        if ('parsed' in result && result.parsed !== undefined) return result.parsed;
        retryDelayMs = result.retryAfter;
      } catch (error: unknown) {
        if (error instanceof HarnessError) throw error;
        throw new HarnessError(controller.signal.aborted ? 'SLACK_REQUEST_TIMEOUT' : 'SLACK_REQUEST_FAILED');
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        controller.abort();
      }
      if (retryDelayMs !== undefined) {
        try { await cancellable(this.sleep(retryDelayMs, signal), signal); } catch {
          throw new HarnessError(signal?.aborted ? 'SLACK_REQUEST_CANCELLED' : 'SLACK_RETRY_FAILED');
        }
      }
    }
    throw new HarnessError('SLACK_RATE_LIMITED');
  }
}
