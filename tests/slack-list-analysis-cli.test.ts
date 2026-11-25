import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SlackReadClient } from '../src/adapters/slack-read-client.js';
import { SqliteSlackAnalysisSource } from '../src/adapters/slack-analysis-source.js';
import { SqliteSlackAnalysisStore } from '../src/adapters/sqlite-slack-analysis.js';
import { SqliteSlackInbox } from '../src/adapters/sqlite-slack-inbox.js';
import { SlackAnalysisService } from '../src/application/analyze-slack.js';
import { pollSlackLists } from '../src/application/poll-slack-list.js';
import { parseSlackEnvironment } from '../src/cli/slack-environment.js';
import type { ReadonlyRelayConfig } from '../src/domain/readonly-relay.js';
import { hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

test('리스트 단독 감지부터 전체 문맥 분석과 CLI 초안 조회까지 연결한다', async context => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-list-analysis-cli-')));
  await chmod(directory, 0o700);
  const listId = 'FSYNTHETIC', itemId = 'RecSynthetic';
  const targetUserId = 'UOWNER', workspaceId = 'TSYNTHETIC';
  const env = { SLACK_WORKSPACE_ID: workspaceId, SLACK_TARGET_USER_ID: targetUserId, SLACK_LIST_ID: listId,
    SLACK_LIVE_READ_ENABLED: 'false', SLACK_ANALYSIS_ENABLED: 'true', SLACK_LIST_ANALYSIS_ENABLED: 'true',
    SLACK_ANALYSIS_CODEX_CONFIG: '/synthetic/unused/codex.json' };
  const envPath = join(directory, 'synthetic.env');
  await writeFile(envPath, Object.entries(env).map(([key, value]) => key + '=' + value).join('\n'), { mode: 0o600 });
  const { config } = parseSlackEnvironment(env);
  const relay: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/unused/codex',
    codexSha256: '3'.repeat(64), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 };
  const startedAt = new Date(Date.now() - 1000);
  const rootTs = '1700000000.000001', priorTs = '1700000001.000002', commentTs = '1700000002.000003';
  const root = { type: 'message', user: 'UAUTHOR', ts: rootTs, text: '합성 항목의 질문', reply_count: 2 };
  const prior = { type: 'message', user: 'UOTHER', ts: priorTs, thread_ts: rootTs, text: '기존 논의에서 정한 일정입니다.' };
  const mention = { type: 'message', user: 'UAUTHOR', ts: commentTs, thread_ts: rootTs, text: '<@UOWNER> 위 일정을 확인해 주세요.' };
  const inbox = new SqliteSlackInbox(join(directory, 'tasks.sqlite'), config, request => service.acceptSnapshot(request));
  const source = new SqliteSlackAnalysisSource(join(directory, 'tasks.sqlite'), config);
  const store = new SqliteSlackAnalysisStore(join(directory, 'slack-analysis.sqlite'));
  let calls = 0;
  const answerDraft = '이전 논의를 바탕으로 일정을 확인하겠습니다.';
  const service = new SlackAnalysisService(source, store, config, relay, () => ({
    mode: 'live', transport: 'codex-cli-relay',
    async transmit(dispatch, _signal, beforeTransmission, beforeCredentialAccess) {
      beforeCredentialAccess(); beforeTransmission(); calls++;
      assert.ok(dispatch.requestEnvelope.body.includes(prior.text));
      assert.ok(dispatch.requestEnvelope.body.includes(root.text));
      assert.ok(dispatch.requestEnvelope.body.includes(mention.text));
      const text = JSON.stringify({ classification: 'question', summary: '일정 확인 요청입니다.',
        facts: [{ text: '기존 일정을 언급했습니다.', references: [{ evidenceId: 'slack-message-' + priorTs, startLine: 1, endLine: 1 }] }],
        hypotheses: [], answerDraft, questions: [], suggestions: [], limitations: ['합성 대화에서 확인한 내용입니다.'] });
      return { text, finalTextHash: hashReadonlyValue(text), responseHash: hashReadonlyValue('synthetic response'), verification: {
        transport: 'fake', upstreamCalls: 1, isolation: 'not_run', credentialAccess: 'not_run',
        responseValidation: 'codex-native-output-v1', relayCompleted: true, credentialReflection: 'passed' } };
    },
  }), startedAt);
  context.after(async () => {
    await service.close(); source.close(); store.close(); inbox.close(); await rm(directory, { recursive: true, force: true });
  });
  const client = new SlackReadClient({ webToken: 'synthetic', allowedListIds: [listId] }, {
    fetch: async url => {
      const args = new URL(String(url)).searchParams;
      assert.equal(args.get('ts'), rootTs);
      assert.equal(args.get('channel'), 'CSYNTHETIC');
      return Response.json({ ok: true, messages: args.has('oldest') ? [] : [root, prior, mention] });
    },
  });
  const scope = { listIds: [listId], targetUserId, workspaceId };
  let cycles = 0;
  const stop = new AbortController();
  await pollSlackLists(scope, {
    read: async () => ({ list_id: listId, items: [{ id: itemId, thread_ts: rootTs, thread: cycles ? [prior, mention] : [prior] }] }),
    readListThreadPage: client.readListThreadPage.bind(client),
    readListAnalysisThread: (list, item, ts, signal) => client.readListAnalysisThread(list, item, ts, targetUserId, config.thread, signal),
  }, inbox, stop.signal, () => {}, async () => { if (++cycles === 2) stop.abort(); });
  assert.equal(inbox.findListAnalysisRequest(listId, commentTs)?.status, 'RECORDED');
  service.tick(); await service.waitForIdle();
  assert.equal(calls, 1);
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
    ['--', resolve('dist/src/cli/main.js'), ...args, '--env-file', envPath, '--data-dir', directory],
    { encoding: 'utf8', timeout: 10_000, env: { LANG: 'C.UTF-8', TZ: 'UTC' } }));
  const listed = cli('slack-list');
  assert.equal(listed.analysis.results[0].status, 'REPORTED');
  assert.equal(listed.analysis.results[0].listId, listId);
  assert.equal(listed.analysis.results[0].itemId, itemId);
  assert.equal(listed.analysis.results[0].commentId, commentTs);
  assert.equal(listed.analysis.results[0].report, undefined);
  const inspected = cli('slack-inspect', listId, commentTs);
  assert.deepEqual(inspected.request.thread.messages, []);
  assert.equal(inspected.request.messageCount, 3);
  const persisted = await Promise.all(['tasks.sqlite', 'slack-analysis.sqlite'].map(name => readFile(join(directory, name))));
  for (const { text } of [root, prior, mention]) {
    assert.ok(!JSON.stringify([listed, inspected]).includes(text));
    assert.ok(persisted.every(database => !database.includes(Buffer.from(text))));
  }
  assert.equal(inspected.analysis.results[0].report.answerDraft, answerDraft);
});
