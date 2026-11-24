import { setTimeout as delay } from 'node:timers/promises';
import { HarnessError, SlackListApiError } from '../domain/errors.js';
import { parseSlackListComments, type SlackListComment } from '../policy/slack-list-export.js';

interface ListReader {
  read(workspaceId: string, listId: string, signal: AbortSignal): Promise<unknown>;
}

interface ListInbox {
  applyListSnapshot(listId: string, comments: readonly SlackListComment[], now: number): {
    baseline: boolean;
    mentions: { itemId: string; commentId: string }[];
  };
}

type ListNotice =
  | { status: 'baseline' | 'checked'; listId: string; commentCount: number; mentionCount: number }
  | { status: 'mention'; listId: string; itemId: string; commentId: string }
  | { status: 'error'; listId: string; reason: string; method?: SlackListApiError['method'] };

/** 한 리스트의 오류가 다음 리스트의 조회나 기준점에 영향을 주지 않게 순서대로 처리한다. */
export const pollSlackLists = async (
  scope: { workspaceId: string; listIds: readonly string[]; targetUserId: string },
  reader: ListReader, inbox: ListInbox,
  signal: AbortSignal, notify: (notice: ListNotice) => void,
  waitForNext: (stop: AbortSignal) => Promise<void> = stop => delay(300_000, undefined, { signal: stop }),
): Promise<void> => {
  const { workspaceId, listIds, targetUserId } = scope;
  while (!signal.aborted) {
    for (const listId of listIds) {
      if (signal.aborted) return;
      try {
        const data = await reader.read(workspaceId, listId, signal);
        if (signal.aborted) return;
        const comments = parseSlackListComments(data, listId, targetUserId);
        const { baseline, mentions } = inbox.applyListSnapshot(listId, comments, Date.now());
        notify({ status: baseline ? 'baseline' : 'checked', listId, commentCount: comments.length, mentionCount: mentions.length });
        for (const { itemId, commentId } of mentions) notify({ status: 'mention', listId, itemId, commentId });
      } catch (error) {
        if (signal.aborted) return;
        notify({ status: 'error', listId, reason: error instanceof HarnessError ? error.code : 'SLACK_LIST_POLL_FAILED',
          ...(error instanceof SlackListApiError ? { method: error.method } : {}) });
      }
    }
    if (signal.aborted) return;
    try { await waitForNext(signal); }
    catch { if (!signal.aborted) throw new HarnessError('SLACK_LIST_WAIT_FAILED'); }
  }
};
