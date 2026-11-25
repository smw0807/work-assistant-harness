import { setTimeout as delay } from 'node:timers/promises';
import { HarnessError, SlackListApiError } from '../domain/errors.js';
import type { SlackListAnalysisThread } from '../domain/slack.js';
import { isSlackTimestamp } from '../policy/slack-timestamp.js';
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
  readListAnalysisThread?(listId: string, itemId: string, threadTs: string, signal: AbortSignal): Promise<SlackListAnalysisThread>;
}

interface ListInbox {
  applyListSnapshot(listId: string, comments: readonly SlackListComment[], now: number, threads: readonly SlackListThread[], captureAnalysis: boolean): {
    baseline: boolean;
    mentions: Mention[];
  };
  getListThreadCursor(listId: string, itemId: string, threadTs: string): string | null;
  applyListThreadReplies(listId: string, itemId: string, threadTs: string, oldest: string, comments: readonly SlackListComment[], now: number,
    captureAnalysis: boolean): Mention[];
  listAnalysisThreads(listId: string, now: number): SlackListThread[];
  refreshListAnalysisThread(listId: string, itemId: string, threadTs: string, snapshot: SlackListAnalysisThread, now: number): void;
  invalidateListAnalysis(listId: string, reason: string, now: number, itemId?: string): void;
  recoverListAnalysis(listId: string, now: number): void;
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

type ThreadReadErrors = { deniedLists: Map<string, string>; rateLimited: boolean };

const recordThreadReadError = (errors: ThreadReadErrors, listId: string, reason: string): void => {
  if (listAccessErrors.has(reason)) errors.deniedLists.set(listId, reason);
  if (reason === 'SLACK_RATE_LIMITED') errors.rateLimited = true;
};

/** 새 요청이나 보관 중인 분석이 있는 항목만 전체 스레드를 조회한다. */
const refreshAnalysisThreads = async (listId: string, reader: ListReader, inbox: ListInbox, signal: AbortSignal,
  notify: (notice: ListNotice) => void, errors: ThreadReadErrors, selectedItemId?: string, bindings?: readonly SlackListThread[]): Promise<void> => {
  if (!reader.readListAnalysisThread) return;
  const previousError = errors.rateLimited ? 'SLACK_RATE_LIMITED' : errors.deniedLists.get(listId);
  if (previousError) {
    inbox.invalidateListAnalysis(listId, previousError, Date.now());
    return;
  }
  const confirmed = bindings && new Map(bindings.map(binding => [binding.itemId, binding.threadTs]));
  for (const { itemId, threadTs } of inbox.listAnalysisThreads(listId, Date.now())) {
    if (signal.aborted) return;
    if (selectedItemId !== undefined && itemId !== selectedItemId) continue;
    if (confirmed && confirmed.get(itemId) !== threadTs) {
      inbox.invalidateListAnalysis(listId, 'SLACK_LIST_THREAD_UNCONFIRMED', Date.now(), itemId);
      continue;
    }
    let snapshot: SlackListAnalysisThread;
    try {
      snapshot = await reader.readListAnalysisThread(listId, itemId, threadTs, signal);
    } catch (error) {
      const reason = error instanceof HarnessError ? error.code : 'SLACK_LIST_THREAD_READ_FAILED';
      snapshot = { thread: { complete: false, reason, messages: [] }, mentionTs: [] };
    }
    if (signal.aborted) return;
    if (!snapshot.thread.complete) {
      const reason = snapshot.thread.reason ?? 'SLACK_ANALYSIS_INCOMPLETE_THREAD';
      recordThreadReadError(errors, listId, reason);
      const stopList = errors.deniedLists.has(listId) || errors.rateLimited;
      inbox.invalidateListAnalysis(listId, reason, Date.now(), stopList ? undefined : itemId);
      notify({ status: 'error', listId, itemId, method: 'conversations.replies', reason });
      if (stopList) return;
      continue;
    }
    inbox.refreshListAnalysisThread(listId, itemId, threadTs, snapshot, Date.now());
  }
};

/** 긴 스레드의 다음 페이지를 뒤에 두어 다른 항목도 조회하고, 호출 제한 시 다음 순회에서 이어간다. */
const pollThreadReplies = async (
  threads: readonly RegisteredThread[], resumeAt: RegisteredThread | undefined, targetUserId: string,
  reader: ListReader, inbox: ListInbox, signal: AbortSignal, notify: (notice: ListNotice) => void, deadline: number, errors: ThreadReadErrors,
): Promise<RegisteredThread | undefined> => {
  const start = resumeAt ? threads.findIndex(thread => thread.listId === resumeAt.listId && thread.itemId === resumeAt.itemId) : 0;
  const pending = start > 0 ? [...threads.slice(start), ...threads.slice(0, start)] : [...threads];
  for (const thread of pending) {
    if (signal.aborted || errors.rateLimited || performance.now() >= deadline) return thread;
    const { listId, itemId, threadTs } = thread;
    if (errors.deniedLists.has(listId)) continue;
    try {
      const oldest = inbox.getListThreadCursor(listId, itemId, threadTs);
      if (oldest === null) continue;
      const page = await reader.readListThreadPage(listId, threadTs, oldest, signal);
      if (signal.aborted) return thread;
      const comments = parseSlackListReplyPage(page.messages, itemId, targetUserId);
      if (!comments.length) continue;
      const mentions = inbox.applyListThreadReplies(listId, itemId, threadTs, oldest, comments, Date.now(), !!reader.readListAnalysisThread);
      for (const mention of mentions) notify({ status: 'mention', listId, itemId, commentId: mention.commentId, source: 'thread' });
      if (mentions.length) await refreshAnalysisThreads(listId, reader, inbox, signal, notify, errors, itemId);
      if (page.hasMore) pending.push(thread);
    } catch (error) {
      if (signal.aborted) return thread;
      const reason = error instanceof HarnessError ? error.code : 'SLACK_LIST_THREAD_READ_FAILED';
      recordThreadReadError(errors, listId, reason);
      if (reader.readListAnalysisThread) inbox.invalidateListAnalysis(listId, reason, Date.now(),
        errors.deniedLists.has(listId) || errors.rateLimited ? undefined : itemId);
      notify({ status: 'error', listId, itemId, method: 'conversations.replies', reason });
      if (reason === 'SLACK_RATE_LIMITED') return thread;
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
  if (reader.readListAnalysisThread) for (const listId of listIds) inbox.recoverListAnalysis(listId, Date.now());
  while (!signal.aborted) {
    const threads: RegisteredThread[] = [];
    const errors: ThreadReadErrors = { deniedLists: new Map(), rateLimited: false };
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
        if (reader.readListAnalysisThread) inbox.invalidateListAnalysis(listId, identityError, Date.now());
        notify({ status: 'error', listId, reason: identityError, method: 'auth.test' });
        continue;
      }
      let fallbackBindings: SlackListThread[] | undefined;
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
            fallbackBindings = parseSlackListThreadBindings(data, listId);
            for (const binding of fallbackBindings) threads.push({ listId, ...binding });
          }
          throw error;
        }
        const { comments } = snapshot;
        const { baseline, mentions } = inbox.applyListSnapshot(listId, comments, snapshotStartedAt, snapshot.threads, !!reader.readListAnalysisThread);
        for (const thread of snapshot.threads) threads.push({ listId, ...thread });
        notify({ status: baseline ? 'baseline' : 'checked', listId, commentCount: comments.length, mentionCount: mentions.length });
        const boundItems = new Set(snapshot.threads.map(thread => thread.itemId));
        for (const { itemId, commentId } of mentions) {
          notify({ status: 'mention', listId, itemId, commentId });
          if (reader.readListAnalysisThread && (!isSlackTimestamp(commentId) || !boundItems.has(itemId))) {
            notify({ status: 'error', listId, itemId, reason: !isSlackTimestamp(commentId) ? 'SLACK_LIST_COMMENT_TS_MISSING' : 'SLACK_LIST_THREAD_UNBOUND' });
          }
        }
        await refreshAnalysisThreads(listId, reader, inbox, signal, notify, errors);
      } catch (error) {
        if (signal.aborted) return;
        const notice: ListNotice = { status: 'error', listId, reason: error instanceof HarnessError ? error.code : 'SLACK_LIST_POLL_FAILED' };
        if (error instanceof SlackListApiError) {
          notice.method = error.method;
          if (error.httpStatus !== undefined) notice.httpStatus = error.httpStatus;
        }
        notify(notice);
        if (fallbackBindings) await refreshAnalysisThreads(listId, reader, inbox, signal, notify, errors, undefined, fallbackBindings);
        else if (reader.readListAnalysisThread) inbox.invalidateListAnalysis(listId, notice.reason, Date.now());
      }
    }
    if (signal.aborted) return;
    const deadline = performance.now() + pollIntervalMs;
    resumeAt = await pollThreadReplies(threads, resumeAt, targetUserId, reader, inbox, signal, notify, deadline, errors);
    if (signal.aborted) return;
    try { await waitForNext(signal, Math.max(0, deadline - performance.now())); }
    catch { if (!signal.aborted) throw new HarnessError('SLACK_LIST_WAIT_FAILED'); }
  }
};
