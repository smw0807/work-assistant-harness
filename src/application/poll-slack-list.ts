import { setTimeout as delay } from 'node:timers/promises';
import { HarnessError } from '../domain/errors.js';
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
  | { status: 'error'; listId: string; reason: string };

/** 한 번의 export와 DB 반영이 끝난 뒤에만 다음 조회를 예약한다. */
export const pollSlackList = async (
  scope: { workspaceId: string; listId: string; targetUserId: string },
  reader: ListReader, inbox: ListInbox,
  signal: AbortSignal, notify: (notice: ListNotice) => void,
  waitForNext: (stop: AbortSignal) => Promise<void> = stop => delay(300_000, undefined, { signal: stop }),
): Promise<void> => {
  const { workspaceId, listId, targetUserId } = scope;
  while (!signal.aborted) {
    try {
      const data = await reader.read(workspaceId, listId, signal);
      if (signal.aborted) return;
      const comments = parseSlackListComments(data, listId, targetUserId);
      const { baseline, mentions } = inbox.applyListSnapshot(listId, comments, Date.now());
      notify({ status: baseline ? 'baseline' : 'checked', listId, commentCount: comments.length, mentionCount: mentions.length });
      for (const { itemId, commentId } of mentions) notify({ status: 'mention', listId, itemId, commentId });
    } catch (error) {
      if (signal.aborted) return;
      notify({ status: 'error', listId, reason: error instanceof HarnessError ? error.code : 'SLACK_LIST_POLL_FAILED' });
    }
    if (signal.aborted) return;
    try { await waitForNext(signal); }
    catch { if (!signal.aborted) throw new HarnessError('SLACK_LIST_WAIT_FAILED'); }
  }
};
