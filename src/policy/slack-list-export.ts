import { HarnessError } from '../domain/errors.js';
import { containsSensitiveText, redactSlackText } from './redaction.js';
import { asSlackRecord } from './slack-ingestion.js';
import { isSlackTimestamp, slackTimestampTicks } from './slack-timestamp.js';

export type SlackListComment = { itemId: string; commentId: string; mentionsTarget: boolean; text: string };
export type SlackListThread = { itemId: string; threadTs: string };
export type SlackListSnapshot = { comments: SlackListComment[]; threads: SlackListThread[] };

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

/** 인용과 코드의 user 요소는 직접 멘션에서 제외한다. 분석 입력은 표시된 rich_text의 문맥도 보존한다. */
const richComment = (blocks: unknown, targetUserId: string, source: 'blocks' | 'rich_text', fullText: boolean): { mentionsTarget: boolean; text: string } | null => {
  let hasRichText = false;
  let mentionsTarget = false;
  const lines: string[] = [];
  let size = 0;
  let elementCount = 0;
  const appendSection = (raw: unknown, quoted = false): void => {
    const section = record(raw);
    if (!quoted && section['type'] !== 'rich_text_section') return invalid();
    const elements = boundedArray(section['elements'], 1_024);
    elementCount += 1 + elements.length;
    if (elementCount > 4_096) return invalid();
    const parts: string[] = [];
    for (const node of elements) {
      const element = record(node);
      let fragment = '';
      if (element['type'] === 'user') {
        const userId = id(element['user_id']);
        if (!quoted && userId === targetUserId && !asSlackRecord(element['style'])?.['code']) mentionsTarget = true;
        fragment = `<@${userId}>`;
      } else if (element['type'] === 'text') {
        fragment = messageText(element['text']);
      } else if (fullText) {
        switch (element['type']) {
          case 'link': {
            const url = messageText(element['url']);
            fragment = element['text'] === undefined ? url : `<${url}|${messageText(element['text'])}>`;
            break;
          }
          case 'emoji': {
            const name = element['name'];
            if (typeof name !== 'string' || !/^[a-zA-Z0-9_+-]{1,128}$/.test(name)) return invalid();
            fragment = `:${name}:`;
            break;
          }
          case 'channel': fragment = `<#${id(element['channel_id'])}>`; break;
          case 'usergroup': fragment = `<!subteam^${id(element['usergroup_id'])}>`; break;
          case 'broadcast': fragment = `<!${id(element['range'])}>`; break;
          default: return invalid();
        }
      }
      if (fullText && asSlackRecord(element['style'])?.['code']) fragment = '`' + fragment + '`';
      size += Buffer.byteLength(fragment);
      if (size > maxMessageBytes) return invalid();
      parts.push(fragment);
    }
    const body = parts.join('');
    lines.push(section['type'] === 'rich_text_quote' ? body.split('\n').map(line => `> ${line}`).join('\n')
      : section['type'] === 'rich_text_preformatted' ? ['```', body, '```'].join('\n') : body);
  };
  for (const raw of boundedArray(blocks, 50)) {
    const block = record(raw);
    if (block['type'] !== 'rich_text') {
      if (source === 'rich_text' || fullText) return invalid();
      continue;
    }
    hasRichText = true;
    for (const rawSection of boundedArray(block['elements'], 256)) {
      const section = record(rawSection);
      if (section['type'] === 'rich_text_section') {
        appendSection(section);
      } else if (section['type'] === 'rich_text_list') {
        for (const listSection of boundedArray(section['elements'], 256)) appendSection(listSection);
      } else if (section['type'] === 'rich_text_quote' || section['type'] === 'rich_text_preformatted') {
        if (fullText) appendSection(section, true);
      } else return invalid();
    }
  }
  return hasRichText ? { mentionsTarget, text: lines.join('\n') } : null;
};

const excerpt = (text: string): string => {
  const bytes = Buffer.from(redactSlackText(text));
  if (bytes.length <= 2_048) return bytes.toString('utf8');
  let end = 2_048;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.toString('utf8', 0, end);
};

type CommentSource = 'export' | 'thread';

const isUserReply = (subtype: unknown, origin: CommentSource): boolean =>
  subtype === undefined || subtype === 'file_share' || subtype === 'thread_broadcast'
  || (origin === 'thread' && subtype === 'me_message');

const readCommentBody = (value: Record<string, unknown>, targetUserId: string, analysis = false) => {
  const text = value['text'] === undefined ? undefined : messageText(value['text']);
  const source = value['rich_text'] === undefined ? 'blocks' : 'rich_text';
  if (source === 'rich_text' && value['blocks'] !== undefined) return invalid();
  const rich = value[source] === undefined ? null : richComment(value[source], targetUserId, source, analysis);
  if (rich) {
    // Slack text는 접근성·알림용으로 축약될 수 있다. 분석에 표시된 본문 전체가 필요하다.
    if (analysis) return rich.text || !text ? rich : invalid();
    return { mentionsTarget: rich.mentionsTarget, text: text || rich.text };
  }
  if (text === undefined) return invalid();
  return { mentionsTarget: hasTextMention(text, targetUserId), text };
};

/** 스레드 원본은 멘션 이외의 답글도 보존한다. 첨부나 리스트 필드는 분석 근거로 펼치지 않는다. */
export const parseSlackListAnalysisMessage = (value: Record<string, unknown>, targetUserId: string, root: boolean) => {
  const ts = value['ts'];
  const subtype = value['subtype'];
  if (!isSlackTimestamp(ts) || !userIdPattern.test(targetUserId)
    || (value['type'] !== undefined && value['type'] !== 'message')
    || (subtype !== undefined && typeof subtype !== 'string') || value['hidden'] === true
    || subtype === 'tombstone' || subtype === 'message_deleted' || subtype === 'message_changed') return invalid();
  const user = id(value['user'] ?? value['user_id'] ?? asSlackRecord(value['bot_profile'])?.['user_id'] ?? value['bot_id']);
  const body = readCommentBody(value, targetUserId, true);
  const mentionsTarget = !root && body.mentionsTarget && userIdPattern.test(user) && user !== targetUserId
    && !value['bot_id'] && !value['bot_profile'] && isUserReply(subtype, 'thread');
  const text = mentionsTarget
    ? body.text.replace(new RegExp(`<@${targetUserId}\\|[^<>\\n]*>`, 'g'), `<@${targetUserId}>`)
    : body.text;
  return { message: { ts, user, text: redactSlackText(text) }, mentionsTarget };
};

const parseComment = (raw: unknown, itemId: string, targetUserId: string, origin: CommentSource): SlackListComment => {
  const value = record(raw);
  const ts = value['ts'];
  const commentId = ts === undefined && origin === 'export' ? id(value['id'])
    : isSlackTimestamp(ts) ? ts : invalid();
  const ignored = { itemId, commentId, mentionsTarget: false, text: '' };
  const subtype = value['subtype'];
  if (value['bot_id'] || value['bot_profile'] || subtype === 'bot_message'
    || subtype === 'message_deleted' || value['hidden'] === true) return ignored;
  const userReply = isUserReply(subtype, origin);
  // replies에 섞인 시스템 메시지는 본문을 읽지 않아도 다음 답글의 조회 위치에 포함된다.
  if (origin === 'thread' && typeof subtype === 'string' && !userReply) return ignored;
  const author = id(value['user'] ?? value['user_id']);
  if (!userIdPattern.test(author)) return invalid();
  if (author === targetUserId) return ignored;
  if (value['type'] !== undefined && value['type'] !== 'message') return invalid();
  if (!userReply) return invalid();
  const body = readCommentBody(value, targetUserId);
  return body.mentionsTarget ? { itemId, commentId, mentionsTarget: true, text: excerpt(body.text) } : ignored;
};

const parseItemComments = (messages: readonly unknown[], itemId: string, targetUserId: string, origin: CommentSource): SlackListComment[] => {
  const seen = new Set<string>();
  const comments: SlackListComment[] = [];
  for (const raw of messages) {
    const comment = parseComment(raw, itemId, targetUserId, origin);
    if (seen.has(comment.commentId)) return invalid();
    seen.add(comment.commentId);
    comments.push(comment);
  }
  return comments;
};

/** 직접 조회한 답글의 ts는 다음 조회의 시작점이므로 내보내기의 대체 ID를 허용하지 않는다. */
export const parseSlackListReplyPage = (messages: readonly unknown[], itemId: string, targetUserId: string): SlackListComment[] => {
  if (!userIdPattern.test(targetUserId)) return invalid();
  return parseItemComments(boundedArray(messages, maxComments), id(itemId), targetUserId, 'thread');
};

const checkCount = (messages: unknown[], owner: Record<string, unknown>): unknown[] => {
  for (const count of [owner['reply_count'], owner['comment_count']]) {
    if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > messages.length)) return invalid();
  }
  return messages;
};

const threadMessages = (row: Record<string, unknown>): unknown[] | null => {
  if (!complete(row)) return invalid();
  if (row['thread'] != null && row['comments'] != null) return invalid();
  const thread = row['thread'] ?? row['comments'];
  if (thread == null) {
    if (['threads', 'replies', 'messages', 'discussion'].some(key => row[key] != null)) return invalid();
    const counts = [row['reply_count'], row['comment_count']].filter(count => count !== undefined);
    if (counts.some(count => count !== 0)) return invalid();
    return counts.length ? [] : null;
  }
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

const alternateRecordFields = ['comments', 'threads', 'replies', 'messages', 'discussion', 'subtasks'];

/** Slack 내보내기는 레코드와 그 댓글·자식 목록을 같은 객체의 별도 필드에 담는다. */
const unwrapExportRecord = (node: Record<string, unknown>, listId: string, withComments: boolean): Record<string, unknown> => {
  const item = record(node['record']);
  if (item['list_id'] !== listId || !Array.isArray(node['children']) || item['children'] !== undefined
    || (node['list_id'] !== undefined && node['list_id'] !== listId)
    || (node['id'] !== undefined && node['id'] !== item['id'])
    || (node['thread_ts'] !== undefined && node['thread_ts'] !== item['thread_ts'])
    || item['thread'] !== undefined
    || alternateRecordFields.some(key => node[key] !== undefined || item[key] !== undefined)) return invalid();
  const row = { id: item['id'], thread_ts: item['thread_ts'], subtasks: node['children'] };
  if (!withComments) return row;
  if (!complete(node) || !complete(item)) return invalid();
  // 댓글이 없는 레코드도 thread_ts를 가질 수 있다. 댓글 포함 여부는 스냅샷 전체에서 확인한다.
  const thread = node['thread'] == null ? null : boundedArray(node['thread'], maxComments);
  checkCount(thread ?? [], node);
  checkCount(thread ?? [], item);
  return { ...row, thread };
};

const truncationFlags = ['records_truncated', 'threads_truncated', 'thread_replies_truncated',
  'message_threads_truncated', 'attachments_truncated', 'max_subtask_depth_exceeded'] as const;

/** include_threads로 요청한 records 내보내기는 빈 스레드를 생략한다. 일부만 반환되면 기준점을 갱신할 수 없다. */
const hasCompleteRecordExport = (meta: unknown): boolean => {
  if (meta === undefined) return false;
  const value = record(meta);
  if (value['complete'] !== true || !complete(value) || truncationFlags.some(flag => value[flag] !== undefined && value[flag] !== false)) return invalid();
  return truncationFlags.every(flag => value[flag] === false);
};

/**
 * 항목 정보와 댓글 데이터의 경계에서만 읽는다. 모르는 구조를 빈 내보내기로 처리하면
 * 잘못된 최초 기준점이 저장되므로 전체 스냅샷을 거부한다.
 */
const parseList = (input: unknown, listId: string, targetUserId: string | null): SlackListSnapshot => {
  const root = record(input);
  const list = asSlackRecord(root['list']);
  const withComments = targetUserId !== null;
  const listIds = [root['list_id'], root['id'], list?.['id'], list?.['list_id']].filter(value => value !== undefined);
  if (!/^F[A-Z0-9_]{1,63}$/.test(listId)
    || listIds.some(value => value !== listId) || !complete(root) || (list && !complete(list))) return invalid();
  const hasRecords = root['records'] !== undefined;
  const tables = [root['items'], root['rows'], root['records'], list?.['items'], list?.['rows']].filter(table => table !== undefined);
  if (tables.length !== 1 || (hasRecords && list?.['id'] !== listId)
    || root['threads'] !== undefined || list?.['threads'] !== undefined || list?.['records'] !== undefined) return invalid();
  const items = boundedArray(tables[0], maxItems);
  if (!listIds.length && (!items.length || items.some(item => record(item)['list_id'] !== listId))) return invalid();
  const includeThreads = [root['include_threads'], asSlackRecord(root['options'])?.['include_threads'],
    asSlackRecord(root['metadata'])?.['include_threads']].filter(flag => flag !== undefined);
  if (withComments && includeThreads.some(flag => flag !== true)) return invalid();
  const completeRecords = withComments && hasRecords && hasCompleteRecordExport(root['meta']);
  let sawThreadShape = includeThreads.length > 0 || completeRecords;
  let hasRowsWithoutThread = false;
  const pending = [...items].reverse();
  const seenItems = new Set<string>();
  const seenThreads = new Set<bigint>();
  const comments: SlackListComment[] = [];
  const threads: SlackListThread[] = [];
  while (pending.length) {
    const node = record(pending.pop());
    const row = hasRecords ? unwrapExportRecord(node, listId, withComments) : node;
    const itemId = id(row['id']);
    if (seenItems.has(itemId) || (row['list_id'] !== undefined && row['list_id'] !== listId)) return invalid();
    seenItems.add(itemId);
    const threadTs = row['thread_ts'];
    if (threadTs != null) {
      if (!isSlackTimestamp(threadTs)) return invalid();
      const ticks = slackTimestampTicks(threadTs);
      if (seenThreads.has(ticks)) return invalid();
      seenThreads.add(ticks);
      threads.push({ itemId, threadTs });
    }
    if (withComments) {
      const messages = threadMessages(row);
      if (messages === null) hasRowsWithoutThread = true;
      else if (row['thread'] != null || row['comments'] != null) sawThreadShape = true;
      if (comments.length + (messages?.length ?? 0) > maxComments) return invalid();
      if (messages) comments.push(...parseItemComments(messages, itemId, targetUserId, 'export'));
    }
    if (row['subtasks'] !== undefined) {
      const children = boundedArray(row['subtasks'], maxItems - seenItems.size - pending.length);
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
    }
  }
  if (hasRowsWithoutThread && !sawThreadShape) return invalid();
  return { comments, threads };
};

export const parseSlackListSnapshot = (input: unknown, listId: string, targetUserId: string): SlackListSnapshot =>
  userIdPattern.test(targetUserId) ? parseList(input, listId, targetUserId) : invalid();

/** 댓글이 잘려도 현재 내보내기에서 다시 확인된 항목·스레드 연결만 복구한다. */
export const parseSlackListThreadBindings = (input: unknown, listId: string): SlackListThread[] =>
  parseList(input, listId, null).threads;

export const parseSlackListComments = (input: unknown, listId: string, targetUserId: string): SlackListComment[] =>
  parseSlackListSnapshot(input, listId, targetUserId).comments;
