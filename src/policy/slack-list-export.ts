import { HarnessError } from '../domain/errors.js';
import { containsSensitiveText, redactSlackText } from './redaction.js';
import { asSlackRecord } from './slack-ingestion.js';

export type SlackListComment = { itemId: string; commentId: string; mentionsTarget: boolean; text: string };

const maxItems = 5_000;
const maxComments = 20_000;
const maxMessageBytes = 65_536;
const userIdPattern = /^[UW][A-Z0-9_]{1,63}$/;
const invalid = (): never => { throw new HarnessError('SLACK_LIST_EXPORT_SCHEMA'); };
const record = (value: unknown): Record<string, unknown> => asSlackRecord(value) ?? invalid();
const boundedArray = (value: unknown, limit: number): unknown[] =>
  Array.isArray(value) && value.length <= limit ? value : invalid();
const complete = (value: Record<string, unknown>): boolean => value['ok'] !== false
  && value['has_more'] !== true && !value['next_cursor'] && !asSlackRecord(value['response_metadata'])?.['next_cursor'];
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value) || containsSensitiveText(value)) return invalid();
  return value;
};
const messageText = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > maxMessageBytes || Buffer.byteLength(value) > maxMessageBytes) return invalid();
  return value;
};

/** 인용, 코드와 링크 안의 표시는 댓글 작성자가 삽입한 직접 호출로 집계하지 않는다. */
const hasTextMention = (text: string, targetUserId: string): boolean => {
  const unquoted = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*(?:`|$)/gm, ' ')
    .replace(/^[ \t]*(?:>>>|&gt;&gt;&gt;)[\s\S]*/m, '').replace(/^[ \t]*(?:>|&gt;).*$/gm, '');
  for (const token of unquoted.matchAll(/<([^<>\n]*)>/g)) {
    if (token[1]!.split('|', 1)[0] === `@${targetUserId}`) return true;
  }
  return false;
};

/** Slack rich_text의 실제 user 요소만 판정한다. 인용 블록·코드·첨부·미리보기는 순회하지 않는다. */
const richComment = (blocks: unknown, targetUserId: string): { mentionsTarget: boolean; text: string } => {
  let mentionsTarget = false;
  const lines: string[] = [];
  let size = 0;
  let elementCount = 0;
  const appendSection = (raw: unknown): void => {
    const section = record(raw);
    if (section['type'] !== 'rich_text_section') return invalid();
    const elements = boundedArray(section['elements'], 1_024);
    elementCount += 1 + elements.length;
    if (elementCount > 4_096) return invalid();
    const parts: string[] = [];
    for (const node of elements) {
      const element = record(node);
      let fragment = '';
      if (element['type'] === 'user') {
        const userId = id(element['user_id']);
        if (userId === targetUserId && !asSlackRecord(element['style'])?.['code']) mentionsTarget = true;
        fragment = `<@${userId}>`;
      } else if (element['type'] === 'text') {
        fragment = messageText(element['text']);
      }
      size += Buffer.byteLength(fragment);
      if (size > maxMessageBytes) return invalid();
      parts.push(fragment);
    }
    lines.push(parts.join(''));
  };
  for (const raw of boundedArray(blocks, 50)) {
    const block = record(raw);
    if (block['type'] !== 'rich_text') continue;
    for (const rawSection of boundedArray(block['elements'], 256)) {
      const section = record(rawSection);
      if (section['type'] === 'rich_text_section') {
        appendSection(section);
      } else if (section['type'] === 'rich_text_list') {
        for (const listSection of boundedArray(section['elements'], 256)) appendSection(listSection);
      } else if (section['type'] !== 'rich_text_quote' && section['type'] !== 'rich_text_preformatted') return invalid();
    }
  }
  return { mentionsTarget, text: lines.join('\n') };
};

const excerpt = (text: string): string => {
  const bytes = Buffer.from(redactSlackText(text));
  if (bytes.length <= 2_048) return bytes.toString('utf8');
  let end = 2_048;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.toString('utf8', 0, end);
};

const parseComment = (raw: unknown, itemId: string, targetUserId: string): SlackListComment => {
  const value = record(raw);
  const ts = value['ts'];
  const commentId = ts === undefined ? id(value['id'])
    : typeof ts === 'string' && /^\d{1,20}\.\d{1,10}$/.test(ts) ? ts : invalid();
  const ignored = { itemId, commentId, mentionsTarget: false, text: '' };
  if (value['bot_id'] || value['bot_profile'] || value['subtype'] === 'bot_message'
    || value['subtype'] === 'message_deleted' || value['hidden'] === true) return ignored;
  const author = id(value['user'] ?? value['user_id']);
  if (!userIdPattern.test(author)) return invalid();
  if (author === targetUserId) return ignored;
  if (value['type'] !== undefined && value['type'] !== 'message') return invalid();
  if (value['subtype'] !== undefined && value['subtype'] !== 'file_share' && value['subtype'] !== 'thread_broadcast') return invalid();
  const text = value['text'] === undefined ? undefined : messageText(value['text']);
  if (value['blocks'] !== undefined && boundedArray(value['blocks'], 50).some(rawBlock => record(rawBlock)['type'] === 'rich_text')) {
    const rich = richComment(value['blocks'], targetUserId);
    return rich.mentionsTarget ? { itemId, commentId, mentionsTarget: true, text: excerpt(text || rich.text) } : ignored;
  }
  if (text === undefined) return invalid();
  return hasTextMention(text, targetUserId) ? { itemId, commentId, mentionsTarget: true, text: excerpt(text) } : ignored;
};

const threadMessages = (row: Record<string, unknown>): unknown[] | null => {
  if (!complete(row)) return invalid();
  if (row['thread'] != null && row['comments'] != null) return invalid();
  const thread = row['thread'] ?? row['comments'];
  if (thread == null) {
    if (['threads', 'replies', 'messages', 'thread_ts', 'discussion'].some(key => row[key] != null)) return invalid();
    const counts = [row['reply_count'], row['comment_count']].filter(count => count !== undefined);
    if (counts.some(count => count !== 0)) return invalid();
    return counts.length ? [] : null;
  }
  const checkCount = (messages: unknown[], owner: Record<string, unknown>): unknown[] => {
    for (const count of [owner['reply_count'], owner['comment_count']]) {
      if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > messages.length)) return invalid();
    }
    return messages;
  };
  if (Array.isArray(thread)) return checkCount(boundedArray(thread, maxComments), row);
  const wrapper = record(thread);
  if (!complete(wrapper)) return invalid();
  if (wrapper['replies'] === undefined) return checkCount(checkCount(boundedArray(wrapper['messages'], maxComments), wrapper), row);
  if (wrapper['messages'] !== undefined) return invalid();
  const replies = checkCount(boundedArray(wrapper['replies'], maxComments), wrapper);
  // replies만 들어 있는 봉투와 루트 댓글 자신의 replies 배열을 구분한다.
  const messages = wrapper['user'] !== undefined || wrapper['user_id'] !== undefined || wrapper['text'] !== undefined
    ? [wrapper, ...replies] : replies;
  return checkCount(messages, row);
};

/**
 * 항목 정보와 댓글 데이터의 경계에서만 읽는다. 모르는 구조를 빈 내보내기로 처리하면
 * 잘못된 최초 기준점이 저장되므로 전체 스냅샷을 거부한다.
 */
export const parseSlackListComments = (input: unknown, listId: string, targetUserId: string): SlackListComment[] => {
  const root = record(input);
  const list = asSlackRecord(root['list']);
  const listIds = [root['list_id'], root['id'], list?.['id'], list?.['list_id']].filter(value => value !== undefined);
  if (!/^F[A-Z0-9_]{1,63}$/.test(listId) || !userIdPattern.test(targetUserId)
    || listIds.some(value => value !== listId) || !complete(root) || (list && !complete(list))) return invalid();
  const tables = [root['items'], root['rows'], list?.['items'], list?.['rows']].filter(table => table !== undefined);
  if (tables.length !== 1 || root['threads'] !== undefined || list?.['threads'] !== undefined) return invalid();
  const items = boundedArray(tables[0], maxItems);
  if (!listIds.length && (!items.length || items.some(item => record(item)['list_id'] !== listId))) return invalid();
  const includeThreads = [root['include_threads'], asSlackRecord(root['options'])?.['include_threads'],
    asSlackRecord(root['metadata'])?.['include_threads']].filter(flag => flag !== undefined);
  if (includeThreads.some(flag => flag !== true)) return invalid();
  let sawThreadShape = includeThreads.length > 0;
  let hasRowsWithoutThread = false;
  const pending = [...items].reverse();
  const seenItems = new Set<string>();
  const comments: SlackListComment[] = [];
  while (pending.length) {
    const row = record(pending.pop());
    const itemId = id(row['id']);
    if (seenItems.has(itemId) || (row['list_id'] !== undefined && row['list_id'] !== listId)) return invalid();
    seenItems.add(itemId);
    const messages = threadMessages(row);
    if (messages === null) hasRowsWithoutThread = true;
    else if (row['thread'] != null || row['comments'] != null) sawThreadShape = true;
    if (comments.length + (messages?.length ?? 0) > maxComments) return invalid();
    const seenComments = new Set<string>();
    for (const raw of messages ?? []) {
      const comment = parseComment(raw, itemId, targetUserId);
      if (seenComments.has(comment.commentId)) return invalid();
      seenComments.add(comment.commentId);
      comments.push(comment);
    }
    if (row['subtasks'] !== undefined) {
      const children = boundedArray(row['subtasks'], maxItems - seenItems.size - pending.length);
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
    }
  }
  if (hasRowsWithoutThread && !sawThreadShape) return invalid();
  return comments;
};
