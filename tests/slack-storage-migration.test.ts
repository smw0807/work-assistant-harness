import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteSlackInbox } from '../src/adapters/sqlite-slack-inbox.js';
import { SqliteSlackAnalysisStore } from '../src/adapters/sqlite-slack-analysis.js';
import { appendSlackAnalysisResults } from '../src/cli/slack-analysis-results.js';
import { runSlackCommand } from '../src/cli/slack.js';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import { parseSlackEnvironment } from '../src/cli/slack-environment.js';
import type { SlackCollectedRequest, SlackMessageChange } from '../src/domain/slack.js';
import { hashSlackAnalysisSource } from '../src/policy/slack-analysis.js';

test('기존 수신함 전체의 본문을 제거하고 이전 한도로 생성한 초안과 중복 기록을 보존한다', async context => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'slack-metadata-migration-')));
  chmodSync(directory, 0o700);
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tasks.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  const { config } = parseSlackEnvironment({ SLACK_WORKSPACE_ID: 'TSYNTHETIC', SLACK_TARGET_USER_ID: 'UOWNER',
    SLACK_CHANNEL_IDS: 'CONE', SLACK_LIST_ID: 'FLIST', SLACK_LIVE_READ_ENABLED: 'false' });
  const now = new Date(), expires = new Date(now.getTime() + 3_600_000).toISOString();
  const ts = '1700000000.000001', text = '<@UOWNER> SYNTHETIC_OLD_THREAD_BODY';
  const request: SlackCollectedRequest = { workspaceId: config.workspaceId, channelId: 'CONE', requesterId: 'UAUTHOR', messageTs: ts,
    threadTs: ts, revision: ts, eventId: 'ESYNTHETIC', status: 'RECORDED', updatedAt: now.toISOString(), text, failureCode: null,
    thread: { complete: true, reason: null, messages: [{ ts, user: 'UAUTHOR', text }] } };
  const event: SlackMessageChange = { kind: 'created', eventId: 'EPENDING', workspaceId: config.workspaceId, channelId: 'CONE',
    messageTs: ts, threadTs: ts, requesterId: 'UAUTHOR', revision: ts, mentionsTarget: true, text: 'SYNTHETIC_PENDING_BODY' };
  db.exec(`
    CREATE TABLE slack_inbox (workspace_id TEXT, event_id TEXT, channel_id TEXT, message_ts TEXT, state TEXT,
      payload TEXT, received_at TEXT, expires_at TEXT, failure_code TEXT, PRIMARY KEY(workspace_id,event_id));
    CREATE TABLE slack_requests (workspace_id TEXT, channel_id TEXT, message_ts TEXT, revision TEXT, deleted INTEGER,
      payload TEXT, expires_at TEXT, PRIMARY KEY(workspace_id,channel_id,message_ts));
    CREATE TABLE slack_list_comments (workspace_id TEXT, list_id TEXT, target_id TEXT, item_id TEXT, comment_id TEXT,
      text TEXT, detected_at INTEGER, expires_at INTEGER, pending_export INTEGER DEFAULT 0, PRIMARY KEY(workspace_id,list_id,target_id,item_id,comment_id));
    CREATE TABLE slack_list_analysis_requests (workspace_id TEXT, list_id TEXT, target_id TEXT, item_id TEXT, message_ts TEXT,
      thread_ts TEXT, received_at TEXT, expires_at TEXT, payload TEXT, PRIMARY KEY(workspace_id,list_id,target_id,item_id,message_ts));
  `);
  const addInbox = db.prepare('INSERT INTO slack_inbox VALUES (?,?,?,?,?,?,?,?,NULL)');
  addInbox.run(config.workspaceId, request.eventId, 'CONE', ts, 'done', null, now.toISOString(), expires);
  addInbox.run(config.workspaceId, event.eventId, 'CONE', ts, 'pending', JSON.stringify(event), now.toISOString(), expires);
  db.prepare('INSERT INTO slack_requests VALUES (?,?,?,?,0,?,?)')
    .run(config.workspaceId, 'CONE', ts, ts, JSON.stringify(request), expires);
  db.prepare('INSERT INTO slack_list_comments VALUES (?,?,?,?,?,?,?,?,0)')
    .run('TOTHER', 'FOTHER', 'UOTHER', 'I1', ts, 'SYNTHETIC_OLD_LIST_EXCERPT', now.getTime(), Date.parse(expires));
  const listRequest = { ...request, channelId: 'FLIST', listItemId: 'I1' };
  db.prepare('INSERT INTO slack_list_analysis_requests VALUES (?,?,?,?,?,?,?,?,?)')
    .run(config.workspaceId, 'FLIST', config.targetUserId, 'I1', ts, ts, now.toISOString(), expires, JSON.stringify(listRequest));
  db.close();
  const release = acquireRuntimeLease(directory);
  try {
    await assert.rejects(runSlackCommand(['slack-list', '--data-dir', directory]), { code: 'HARNESS_ALREADY_RUNNING' });
    assert.ok(readFileSync(path).includes(Buffer.from('SYNTHETIC_OLD_THREAD_BODY')));
  } finally { release(); }

  const previous = { ...config, thread: { maxMessages: 30, maxPages: 3, maxBytes: 16_384 } };
  const ledger = new SqliteSlackAnalysisStore(join(directory, 'slack-analysis.sqlite'));
  const draft = '합성 요청에 대한 기존 답변 초안입니다.';
  for (const full of [request, listRequest]) {
    const sourceHash = hashSlackAnalysisSource(full, { ...previous, listAnalysisEnabled: true });
    const run = ledger.begin({ workspaceId: config.workspaceId, channelId: full.channelId, messageTs: ts, revision: ts, sourceHash,
      scopeHash: 'b'.repeat(64), policyHash: 'c'.repeat(64), expiresAt: expires }, now);
    assert.equal(run.kind, 'started');
    ledger.finish(run.record!.runId, { status: 'REPORTED', responseHash: 'd'.repeat(64), report: {
      classification: 'question', summary: '합성 요청', facts: [{ text: '담당자를 멘션했습니다.',
        references: [{ evidenceId: 'slack-message-' + ts, startLine: 1, endLine: 1 }] }], hypotheses: [], answerDraft: draft,
      questions: [], suggestions: [], limitations: ['합성 자료만 확인했습니다.'] } }, now);
  }
  ledger.close();
  let forwarded = 0;
  const open = () => new SqliteSlackInbox(path, config, () => { forwarded++; });
  const inbox = open();
  try {
    assert.equal(inbox.find(config.workspaceId, 'CONE', ts)?.messageCount, 1);
    assert.equal(inbox.pending()[0]?.event.text, '');
    assert.equal(inbox.receive(event, now), 'duplicate');
  } finally { inbox.close(); }
  open().close();
  assert.equal(forwarded, 0);
  const bytes = readFileSync(path);
  for (const marker of ['SYNTHETIC_OLD_THREAD_BODY', 'SYNTHETIC_PENDING_BODY', 'SYNTHETIC_OLD_LIST_EXCERPT']) {
    assert.equal(bytes.includes(Buffer.from(marker)), false, marker);
  }
  for (const channelId of ['CONE', 'FLIST']) {
    const output = appendSlackAnalysisResults('{}', { command: 'slack-inspect', sourceRoot: directory, eventsPath: '',
      dataDirectory: directory, channelId, messageTs: ts, config }, now);
    const [result] = JSON.parse(output).analysis.results;
    assert.equal(result.status, 'REPORTED');
    assert.equal(result.report.answerDraft, draft);
  }
});
