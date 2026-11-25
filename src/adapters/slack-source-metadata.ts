import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SlackCollectedRequest, SlackReceiverConfig, SlackMessageChange, SlackThreadSnapshot } from '../domain/slack.js';
import { hashSlackAnalysisReceiver, hashSlackAnalysisSource } from '../policy/slack-analysis.js';
import { isSlackTimestamp } from '../policy/slack-timestamp.js';

export const slackTextHash = (text: string): string => createHash('sha256').update(text).digest('hex');
export const slackThreadHash = (thread: SlackThreadSnapshot): string => slackTextHash(JSON.stringify(thread.messages.map(
  message => [message.ts, message.user, message.text])));
export const slackThreadTimestamps = (thread: SlackThreadSnapshot | null): string =>
  JSON.stringify(thread?.messages.map(message => message.ts).filter(isSlackTimestamp) ?? []);

export const slackEventMetadata = (event: SlackMessageChange): SlackMessageChange => {
  const { kind, eventId, workspaceId, channelId, messageTs, threadTs, requesterId, revision, mentionsTarget } = event;
  return { kind, eventId, workspaceId, channelId, messageTs, threadTs, requesterId, revision, mentionsTarget, text: '' };
};

const analysisHash = (request: SlackCollectedRequest, config: SlackReceiverConfig): string | undefined => {
  try { return hashSlackAnalysisSource(request, config); } catch { return undefined; }
};

/** Slack 본문을 영속화하지 않고, 분석 입력 검증을 통과한 문맥만 결과 대조에 사용한다. */
export const slackRequestMetadata = (full: SlackCollectedRequest, config: SlackReceiverConfig,
  allowSourceHash = true, legacy = false): SlackCollectedRequest => {
  const { workspaceId, channelId, listItemId, messageTs, threadTs, requesterId, revision, eventId,
    status, updatedAt, failureCode, thread } = full;
  const metadata: SlackCollectedRequest = { workspaceId, channelId, ...(listItemId === undefined ? {} : { listItemId }),
    messageTs, threadTs, requesterId, revision, eventId, status, updatedAt, failureCode,
    text: '', thread: thread ? { messages: [], complete: thread.complete, reason: thread.reason } : null,
    ...(thread ? { messageCount: thread.messages.length } : {}) };
  if (allowSourceHash && status === 'RECORDED' && thread?.complete && thread.reason === null) {
    const current = analysisHash(full, config);
    if (current) {
      metadata.sourceHash = current;
      metadata.receiverHash = hashSlackAnalysisReceiver(config, full.listItemId);
    }
    if (legacy) {
      const previous = analysisHash(full, { ...config, thread: { maxMessages: 30, maxPages: 3, maxBytes: 16_384 } });
      if (previous && previous !== current) metadata.legacySourceHash = previous;
    }
  }
  return metadata;
};

export const hasSlackSourceMigration = (db: DatabaseSync): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'slack_storage_migrations'").get()
  && !!db.prepare('SELECT 1 FROM slack_storage_migrations WHERE version = 1').get();

/** 호출자는 쓰기 트랜잭션을 소유한다. 이전 수신 설정의 행도 본문 제거 대상이다. */
export const migrateSlackSourceStorage = (db: DatabaseSync, config: SlackReceiverConfig): void => {
  db.exec('CREATE TABLE IF NOT EXISTS slack_storage_migrations (version INTEGER PRIMARY KEY) STRICT');
  if (db.prepare('SELECT 1 FROM slack_storage_migrations WHERE version = 1').get()) return;
  db.exec(`
    ALTER TABLE slack_inbox ADD COLUMN text_hash TEXT;
    ALTER TABLE slack_inbox ADD COLUMN receiver_session TEXT;
    ALTER TABLE slack_requests ADD COLUMN thread_timestamps TEXT;
    ALTER TABLE slack_list_analysis_requests ADD COLUMN thread_timestamps TEXT;
    ALTER TABLE slack_list_analysis_requests ADD COLUMN thread_hash TEXT;
    ALTER TABLE slack_list_analysis_requests ADD COLUMN receiver_session TEXT;
    UPDATE slack_list_comments SET detected_at = NULL, expires_at = NULL, pending_export = 0 WHERE text IS NULL;
    UPDATE slack_list_comments SET text = NULL WHERE text IS NOT NULL;
    DROP INDEX IF EXISTS slack_list_mentions_expiry;
    DROP INDEX IF EXISTS slack_list_mentions_scope;
    CREATE INDEX slack_list_mentions_expiry ON slack_list_comments(expires_at) WHERE expires_at IS NOT NULL;
    CREATE INDEX slack_list_mentions_scope ON slack_list_comments(workspace_id,list_id,target_id,detected_at DESC) WHERE expires_at IS NOT NULL;
  `);
  const updateEvent = db.prepare('UPDATE slack_inbox SET payload = ?, text_hash = ? WHERE rowid = ?');
  for (const row of db.prepare('SELECT rowid, payload FROM slack_inbox WHERE payload IS NOT NULL').iterate()) {
    let payload: string | null = null, digest: string | null = null;
    try {
      const event = JSON.parse(String(row.payload)) as SlackMessageChange;
      digest = slackTextHash(event.text);
      payload = JSON.stringify(slackEventMetadata(event));
    } catch { /* 손상된 대기 이벤트는 후속 수집을 차단한다. */ }
    updateEvent.run(payload, digest, row.rowid!);
    if (payload === null) {
      db.prepare("UPDATE slack_inbox SET state = 'blocked', failure_code = 'INVALID_SLACK_STORAGE' WHERE rowid = ?").run(row.rowid!);
    }
  }
  for (const table of ['slack_requests', 'slack_list_analysis_requests'] as const) {
    const isList = table === 'slack_list_analysis_requests';
    const select = db.prepare(`SELECT rowid, payload${isList ? ', target_id' : ''} FROM ${table} WHERE payload IS NOT NULL`);
    const update = db.prepare(`UPDATE ${table} SET payload = ?, thread_timestamps = ?${isList ? ', thread_hash = ?' : ''} WHERE rowid = ?`);
    for (const row of select.iterate()) {
      let body: string | null = null, timestamps: string | null = null, digest: string | null = null;
      try {
        const request = JSON.parse(String(row.payload)) as SlackCollectedRequest;
        const migrationConfig = isList ? { ...config, listAnalysisEnabled: true as const } : config;
        const metadata = slackRequestMetadata(request, migrationConfig, !isList || row.target_id === config.targetUserId, true);
        timestamps = slackThreadTimestamps(request.thread);
        if (isList && request.thread) digest = slackThreadHash(request.thread);
        body = JSON.stringify(metadata);
      } catch { /* 손상된 이전 payload도 새 저장소에 보존하지 않는다. */ }
      if (isList) update.run(body, timestamps, digest, row.rowid!);
      else update.run(body, timestamps, row.rowid!);
    }
  }
  db.prepare('INSERT INTO slack_storage_migrations(version) VALUES (1)').run();
};
