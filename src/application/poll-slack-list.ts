import { setTimeout as delay } from 'node:timers/promises';
import { HarnessError, SlackListApiError } from '../domain/errors.js';
import {
  parseSlackListReplyPage, parseSlackListSnapshot, parseSlackListThreadBindings,
  type SlackListComment, type SlackListSnapshot, type SlackListThread,
} from '../policy/slack-list-export.js';

const pollIntervalMs = 300_000;
type RegisteredThread = SlackListThread & { listId: string };
type Mention = { itemId: string; commentId: string };

interface ListReader {
  verifyIdentity?(signal: AbortSignal): Promise<void>;
  read(workspaceId: string, listId: string, signal: AbortSignal): Promise<unknown>;
  readListThreadPage(listId: string, threadTs: string, oldest: string, signal: AbortSignal): Promise<{ messages: unknown[]; hasMore: boolean }>;
}

interface ListInbox {
  applyListSnapshot(listId: string, comments: readonly SlackListComment[], now: number, threads: readonly SlackListThread[]): {
    baseline: boolean;
    mentions: Mention[];
  };
  getListThreadCursor(listId: string, itemId: string, threadTs: string): string | null;
  applyListThreadReplies(listId: string, itemId: string, threadTs: string, oldest: string, comments: readonly SlackListComment[], now: number): Mention[];
}

type ListNotice =
  | { status: 'baseline' | 'checked'; listId: string; commentCount: number; mentionCount: number }
  | { status: 'mention'; listId: string; itemId: string; commentId: string; source?: 'thread' }
  | { status: 'error'; listId: string; itemId?: string; reason: string; method?: 'auth.test' | 'conversations.replies' | SlackListApiError['method']; httpStatus?: number };

const listAccessErrors = new Set([
  'SLACK_THREAD_API_MISSING_SCOPE', 'SLACK_THREAD_API_CHANNEL_NOT_FOUND', 'SLACK_THREAD_API_NOT_IN_CHANNEL',
  'SLACK_THREAD_API_ACCESS_DENIED', 'SLACK_THREAD_API_NO_PERMISSION', 'SLACK_THREAD_API_NOT_ALLOWED_TOKEN_TYPE',
  'SLACK_THREAD_API_INVALID_AUTH', 'SLACK_THREAD_API_NOT_AUTHED', 'SLACK_THREAD_API_TOKEN_REVOKED',
  'SLACK_THREAD_API_TOKEN_EXPIRED', 'SLACK_THREAD_API_ACCOUNT_INACTIVE', 'SLACK_THREAD_API_ACCESSLIMITED', 'SLACK_THREAD_API_FORBIDDEN_TEAM',
]);

/** 긴 스레드의 다음 페이지를 뒤에 두어 다른 항목도 조회하고, 호출 제한 시 다음 순회에서 이어간다. */
const pollThreadReplies = async (
  threads: readonly RegisteredThread[], resumeAt: RegisteredThread | undefined, targetUserId: string,
  reader: ListReader, inbox: ListInbox, signal: AbortSignal, notify: (notice: ListNotice) => void, deadline: number,
): Promise<RegisteredThread | undefined> => {
  const start = resumeAt ? threads.findIndex(thread => thread.listId === resumeAt.listId && thread.itemId === resumeAt.itemId) : 0;
  const pending = start > 0 ? [...threads.slice(start), ...threads.slice(0, start)] : [...threads];
  const deniedLists = new Set<string>();
  for (const thread of pending) {
    if (signal.aborted || performance.now() >= deadline) return thread;
    const { listId, itemId, threadTs } = thread;
    if (deniedLists.has(listId)) continue;
    try {
      const oldest = inbox.getListThreadCursor(listId, itemId, threadTs);
      if (oldest === null) continue;
      const page = await reader.readListThreadPage(listId, threadTs, oldest, signal);
      if (signal.aborted) return thread;
      const comments = parseSlackListReplyPage(page.messages, itemId, targetUserId);
      if (!comments.length) continue;
      const mentions = inbox.applyListThreadReplies(listId, itemId, threadTs, oldest, comments, Date.now());
      for (const mention of mentions) notify({ status: 'mention', listId, itemId, commentId: mention.commentId, source: 'thread' });
      if (page.hasMore) pending.push(thread);
    } catch (error) {
      if (signal.aborted) return thread;
      const reason = error instanceof HarnessError ? error.code : 'SLACK_LIST_THREAD_READ_FAILED';
      notify({ status: 'error', listId, itemId, method: 'conversations.replies', reason });
      if (reason === 'SLACK_RATE_LIMITED') return thread;
      if (listAccessErrors.has(reason)) deniedLists.add(listId);
    }
  }
  return undefined;
};

/** 한 리스트의 오류가 다음 리스트의 조회나 기준점에 영향을 주지 않게 순서대로 처리한다. */
export const pollSlackLists = async (
  scope: { workspaceId: string; listIds: readonly string[]; targetUserId: string },
  reader: ListReader, inbox: ListInbox,
  signal: AbortSignal, notify: (notice: ListNotice) => void,
  waitForNext: (stop: AbortSignal, milliseconds: number) => Promise<void> = (stop, ms) => delay(ms, undefined, { signal: stop }),
): Promise<void> => {
  const { workspaceId, listIds, targetUserId } = scope;
  let identityVerified = false;
  let resumeAt: RegisteredThread | undefined;
  while (!signal.aborted) {
    const threads: RegisteredThread[] = [];
    let identityError: string | undefined;
    if (reader.verifyIdentity && !identityVerified) {
      try {
        await reader.verifyIdentity(signal);
        identityVerified = true;
      } catch (error) {
        identityError = error instanceof HarnessError ? error.code : 'SLACK_LIST_IDENTITY_FAILED';
      }
    }
    for (const listId of listIds) {
      if (signal.aborted) return;
      if (identityError) {
        notify({ status: 'error', listId, reason: identityError, method: 'auth.test' });
        continue;
      }
      try {
        const snapshotStartedAt = Date.now();
        const data = await reader.read(workspaceId, listId, signal);
        if (signal.aborted) return;
        let snapshot: SlackListSnapshot;
        try {
          snapshot = parseSlackListSnapshot(data, listId, targetUserId);
        } catch (error) {
          // 댓글이 잘렸어도 현재 내보내기와 DB 양쪽에서 확인되는 항목은 기존 커서부터 읽는다.
          if (error instanceof HarnessError && error.code === 'SLACK_LIST_EXPORT_SCHEMA') {
            for (const binding of parseSlackListThreadBindings(data, listId)) threads.push({ listId, ...binding });
          }
          throw error;
        }
        const { comments } = snapshot;
        const { baseline, mentions } = inbox.applyListSnapshot(listId, comments, snapshotStartedAt, snapshot.threads);
        for (const thread of snapshot.threads) threads.push({ listId, ...thread });
        notify({ status: baseline ? 'baseline' : 'checked', listId, commentCount: comments.length, mentionCount: mentions.length });
        for (const { itemId, commentId } of mentions) notify({ status: 'mention', listId, itemId, commentId });
      } catch (error) {
        if (signal.aborted) return;
        const notice: ListNotice = { status: 'error', listId, reason: error instanceof HarnessError ? error.code : 'SLACK_LIST_POLL_FAILED' };
        if (error instanceof SlackListApiError) {
          notice.method = error.method;
          if (error.httpStatus !== undefined) notice.httpStatus = error.httpStatus;
        }
        notify(notice);
      }
    }
    if (signal.aborted) return;
    const deadline = performance.now() + pollIntervalMs;
    resumeAt = await pollThreadReplies(threads, resumeAt, targetUserId, reader, inbox, signal, notify, deadline);
    if (signal.aborted) return;
    try { await waitForNext(signal, Math.max(0, deadline - performance.now())); }
    catch { if (!signal.aborted) throw new HarnessError('SLACK_LIST_WAIT_FAILED'); }
  }
};
