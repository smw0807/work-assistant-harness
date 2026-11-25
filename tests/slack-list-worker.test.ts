import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { SlackWorkerOptions } from '../src/cli/slack.js';
import { pollSlackLists } from '../src/application/poll-slack-list.js';

const unexpectedThreadCall = (): never => assert.fail('이 fixture에는 등록된 스레드가 없습니다.');
const emptyThreadInbox = { getListThreadCursor: unexpectedThreadCall, applyListThreadReplies: unexpectedThreadCall,
  listAnalysisThreads: unexpectedThreadCall, refreshListAnalysisThread: unexpectedThreadCall,
  invalidateListAnalysis: unexpectedThreadCall, recoverListAnalysis: unexpectedThreadCall };

const runSyntheticWorker = async (options: SlackWorkerOptions, preload: string, env: Record<string, string>,
  finished: (output: string) => boolean): Promise<string> => {
  const { dataDirectory, sourceRoot } = options;
  const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${sourceRoot}`, `--allow-fs-read=${dataDirectory}`,
    `--allow-fs-write=${dataDirectory}`, '--allow-net', '--import', pathToFileURL(preload).href,
    join(sourceRoot, 'dist/src/cli/slack-worker.js'), JSON.stringify(options)], {
    env, timeout: 15_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', stopping = false;
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    stdout += chunk;
    if (!stopping && stdout.endsWith('\n') && finished(stdout)) {
      stopping = true;
      child.kill('SIGTERM');
    }
  });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  assert.equal(code, 0, stderr);
  for (const token of Object.values(env)) assert.ok(!stdout.includes(token) && !stderr.includes(token));
  return stdout;
};

test('리스트 하나가 실패해도 다음 리스트를 처리하고 다음 주기에 재시도하며 취소된 조회는 반영하지 않는다', async () => {
  const scope = { workspaceId: 'TTEST', listIds: ['FMISSING', 'FTEST'], targetUserId: 'UOWNER' };
  const controller = new AbortController();
  const events: string[] = [];
  let calls = 0;
  await pollSlackLists(scope, { readListThreadPage: unexpectedThreadCall, async read(_workspaceId, listId) {
    events.push(`read ${listId}`);
    calls++;
    if (calls === 1) throw new Error('private-response');
    if (calls === 5) controller.abort();
    return { list_id: listId, items: [] };
  } }, { ...emptyThreadInbox, applyListSnapshot(listId) {
    events.push(`commit ${listId}`);
    return { baseline: true, mentions: [] };
  } }, controller.signal, notice => { events.push(`${notice.status} ${notice.listId}`); },
  async () => { events.push('wait'); });
  assert.deepEqual(events, [
    'read FMISSING', 'error FMISSING', 'read FTEST', 'commit FTEST', 'baseline FTEST', 'wait',
    'read FMISSING', 'commit FMISSING', 'baseline FMISSING', 'read FTEST', 'commit FTEST', 'baseline FTEST', 'wait',
    'read FMISSING',
  ]);
});

test('사용자 인증이 실패하면 리스트를 읽지 않고 다음 순회에서 재시도하며 성공한 인증을 재사용한다', async () => {
  const scope = { workspaceId: 'TTEST', listIds: ['FFIRST', 'FSECOND'], targetUserId: 'UOWNER' };
  const controller = new AbortController();
  let cycle = 1;
  const verifiedAt: number[] = [];
  const reads: [number, string][] = [];
  const notices: string[] = [];
  await pollSlackLists(scope, {
    readListThreadPage: unexpectedThreadCall,
    async verifyIdentity() {
      verifiedAt.push(cycle);
      if (cycle === 1) throw new Error('synthetic private response');
    },
    async read(_workspace, listId) {
      reads.push([cycle, listId]);
      return { list_id: listId, items: [] };
    },
  }, { ...emptyThreadInbox, applyListSnapshot: () => ({ baseline: cycle === 2, mentions: [] }) }, controller.signal, notice => {
    notices.push(notice.status === 'error' ? notice.reason : notice.status);
  }, async () => { if (++cycle > 3) controller.abort(); });
  assert.deepEqual(verifiedAt, [1, 2]);
  assert.deepEqual(reads, [[2, 'FFIRST'], [2, 'FSECOND'], [3, 'FFIRST'], [3, 'FSECOND']]);
  assert.deepEqual(notices, ['SLACK_LIST_IDENTITY_FAILED', 'SLACK_LIST_IDENTITY_FAILED', 'baseline', 'baseline', 'checked', 'checked']);
});

test('리스트 단독 수신 worker의 첫 조회·재시작·실패 복구와 CLI 조회를 합성 HTTP로 검증한다', async context => {
  const sourceRoot = await realpath(resolve('.'));
  const dataDirectory = await realpath(await mkdtemp(join(tmpdir(), 'harness-list-worker-')));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const config = { workspaceId: 'TTEST', listIds: ['FMISSING', 'FTEST'], targetUserId: 'UOWNER', channelIds: [],
    retentionHours: 24, maxPending: 10, thread: { maxMessages: 10, maxPages: 2, maxBytes: 16_384 }, liveReadEnabled: true };
  const options: SlackWorkerOptions = { command: 'slack-listen', config, dataDirectory, sourceRoot,
    eventsPath: '', channelId: '', messageTs: '' };
  const fixturePath = join(dataDirectory, 'synthetic-export.json');
  const repliesPath = join(dataDirectory, 'synthetic-replies.json');
  const preload = join(dataDirectory, 'synthetic-fetch.mjs');
  const urls = { identity: 'https://slack.com/api/auth.test', start: 'https://slack.com/api/slackLists.download.start',
    get: 'https://slack.com/api/slackLists.download.get', file: 'https://files.slack.com/files-pri/TTEST-FTEST/json/list',
    replies: 'https://slack.com/api/conversations.replies' };
  await writeFile(preload, `
    import { readFile } from 'node:fs/promises';
    const urls = ${JSON.stringify(urls)};
    const listToken = process.env.SLACK_LIST_USER_TOKEN;
    globalThis.fetch = async (url, init) => {
      if (url === urls.identity) return Response.json({ok:true, team_id:'TTEST', user_id:'UOWNER'});
      if (url === urls.start) {
        const { list_id } = JSON.parse(init.body);
        if (list_id === 'FMISSING') return Response.json({ok:false, error:'list_not_found'});
        if (list_id === 'FTEST') return Response.json({ok:true, job_id:'LeTest'});
        throw new Error('Unexpected list in offline test');
      }
      if (url === urls.get) return Response.json({ok:true, status:'COMPLETED', download_url:urls.file});
      if (url === urls.file) return new Response(await readFile(${JSON.stringify(fixturePath)}));
      const requestUrl = new URL(url);
      if (requestUrl.origin + requestUrl.pathname === urls.replies) {
        const page = JSON.parse(await readFile(${JSON.stringify(repliesPath)}, 'utf8'));
        const query = requestUrl.searchParams;
        if (init.method !== 'GET' || new Headers(init.headers).get('authorization') !== 'Bearer ' + listToken
          || query.get('channel') !== 'CTEST' || query.get('ts') !== page.threadTs
          || query.get('oldest') !== page.oldest || query.get('inclusive') !== 'false') {
          return Response.json({ok:false,error:'invalid_arguments'});
        }
        return Response.json({ok:true,messages:page.messages,has_more:false});
      }
      throw new Error('Unexpected URL in offline test');
    };
  `);
  const noticePrefix = '{"event":"slack-list-poll"';
  const run = async (exported: unknown, finalStatus: string, env: Record<string, string> = { SLACK_WEB_TOKEN: 'synthetic-test-value' }) => {
    await writeFile(fixturePath, JSON.stringify(exported));
    const stdout = await runSyntheticWorker(options, preload, env, output => {
      const lastLine = output.trimEnd().split('\n').at(-1);
      if (!lastLine?.startsWith(noticePrefix)) return false;
      const lastNotice = JSON.parse(lastLine);
      if (finalStatus === 'thread-mention') return lastNotice.listId === 'FTEST'
        && (lastNotice.status === 'error' || lastNotice.source === 'thread');
      return lastNotice.listId === 'FTEST' && lastNotice.status === finalStatus;
    });
    assert.ok(!stdout.includes('private@example.test'));
    const start = JSON.parse(stdout.slice(0, stdout.indexOf(noticePrefix)));
    assert.equal(start.status, 'starting');
    assert.deepEqual(start.listIds, config.listIds);
    const [missing, ...notices] = stdout.split('\n').filter(line => line.startsWith(noticePrefix)).map(line => JSON.parse(line));
    assert.equal(missing.listId, 'FMISSING');
    assert.equal(missing.status, 'error');
    assert.equal(missing.reason, 'SLACK_LIST_API_LIST_NOT_FOUND');
    assert.equal(missing.method, 'slackLists.download.start');
    assert.ok(notices.every(notice => notice.listId === 'FTEST'));
    if (finalStatus === 'thread-mention') assert.equal(notices.at(-1)?.status, 'mention', JSON.stringify(notices));
    return notices;
  };
  const row = (text: string, ts: string) => ({ text, ts, user_id: 'UAUTHOR' });
  const snapshot = (thread: unknown[], threadTs?: string) => ({ list: { id: 'FTEST' }, records: [
    { record: { id: 'RecTEST', list_id: 'FTEST', thread_ts: threadTs, fields: [{ user: ['UOWNER'] }] }, children: [], thread },
  ] });
  const old = row('<@UOWNER> 과거 멘션', '1700000000.000001');
  const normal = row('일반 댓글', '1700000000.000002');
  const fresh = { ...row('<@UOWNER> 확인 private@example.test', '1700000000.000003'),
    rich_text: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'UOWNER' }] }] }] };
  assert.equal((await run(snapshot([old, normal]), 'baseline', { SLACK_LIST_USER_TOKEN: 'synthetic-user-only' }))[0].status, 'baseline');
  assert.equal((await run({ error: 'wrong shape' }, 'error'))[0].reason, 'SLACK_LIST_EXPORT_SCHEMA');
  const current = snapshot([fresh, old, normal]);
  assert.deepEqual((await run(current, 'mention')).map(n => n.status), ['checked', 'mention']);
  assert.equal((await run(current, 'checked'))[0].mentionCount, 0);
  assert.equal((await run({ list_id: 'FTEST', items: [{ id: 'RecTEST', reply_count: 3, thread: [] }] }, 'error'))[0].status, 'error');

  const output = execFileSync(process.execPath, ['--', join(sourceRoot, 'dist/src/cli/main.js'), 'slack-list', '--env',
    '--data-dir', dataDirectory], { encoding: 'utf8', env: { SLACK_WORKSPACE_ID: 'TTEST', SLACK_LIST_ID: 'FMISSING,FTEST',
      SLACK_TARGET_USER_ID: 'UOWNER', SLACK_LIVE_READ_ENABLED: 'false' } });
  const { requests, listMentions } = JSON.parse(output);
  assert.deepEqual(requests, []);
  assert.equal(listMentions.length, 1);
  assert.equal(listMentions[0].listId, 'FTEST');
  assert.equal(listMentions[0].commentId, fresh.ts);
  assert.equal('text' in listMentions[0], false);

  // 저장된 댓글 이후의 직접 조회에 누락 답글과 내보내기의 최신 답글이 함께 들어온다.
  const threadTs = '1699999999.000001';
  const missing = { ...row('<@UOWNER> 누락된 답글 private@example.test', '1700000000.000004'), thread_ts: threadTs, subtype: 'file_share' };
  const overlap = { ...row('<@UOWNER> 내보내기에도 있는 답글', '1700000000.000005'), thread_ts: threadTs };
  const newest = { ...row('<@UOWNER> 재시작 후 새 답글', '1700000000.000006'), thread_ts: threadTs };
  const tokens = { SLACK_LIST_USER_TOKEN: 'synthetic-list-user', SLACK_WEB_TOKEN: 'synthetic-other-web' };
  const root = { ts: threadTs, text: '합성 루트' };
  await writeFile(repliesPath, JSON.stringify({ oldest: fresh.ts, threadTs, messages: [root, missing, overlap] }));
  const first = await run(snapshot([old, normal, fresh, overlap], threadTs), 'thread-mention', tokens);
  assert.deepEqual(first.filter(n => n.status === 'mention').map(n => [n.commentId, n.source]), [[overlap.ts, undefined], [missing.ts, 'thread']]);
  await writeFile(repliesPath, JSON.stringify({ oldest: overlap.ts, threadTs, messages: [root, newest] }));
  const restarted = await run(snapshot([old, normal, fresh, missing, overlap], threadTs), 'thread-mention', tokens);
  assert.deepEqual(restarted.filter(n => n.status === 'mention').map(n => [n.commentId, n.source]), [[newest.ts, 'thread']]);
});

test('채널과 리스트를 함께 수신하면 토큰이 용도별로 분리되고 잘못된 사용자도 채널 수신을 막지 않는다', async context => {
  const sourceRoot = await realpath(resolve('.'));
  const dataDirectory = await realpath(await mkdtemp(join(tmpdir(), 'harness-list-identity-')));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const options: SlackWorkerOptions = { command: 'slack-listen', sourceRoot, dataDirectory, eventsPath: '', channelId: '', messageTs: '',
    config: { workspaceId: 'TTEST', targetUserId: 'UOWNER', channelIds: ['CTEST'], listIds: ['FTEST'], retentionHours: 24, maxPending: 10,
      thread: { maxMessages: 10, maxPages: 2, maxBytes: 16_384 }, liveReadEnabled: true } };
  const env = { SLACK_APP_TOKEN: 'synthetic-channel-app', SLACK_WEB_TOKEN: 'synthetic-channel-web', SLACK_LIST_USER_TOKEN: 'synthetic-list-user' };
  const preload = join(dataDirectory, 'synthetic-slack.mjs');
  const tracePath = join(dataDirectory, 'api-calls.json');
  for (const scenario of ['wrong-user', 'file-redirect', 'success']) {
    const userId = scenario === 'wrong-user' ? 'UOTHER' : 'UOWNER';
    await writeFile(preload, `
      import { writeFileSync } from 'node:fs';
      const roles = new Map([
        ['Bearer ' + process.env.SLACK_APP_TOKEN, 'app'],
        ['Bearer ' + process.env.SLACK_WEB_TOKEN, 'web'],
        ['Bearer ' + process.env.SLACK_LIST_USER_TOKEN, 'user'],
      ]);
      const calls = [];
      process.on('exit', () => writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(calls)));
      const api = 'https://slack.com/api/';
      const file = 'https://files.slack.com/files-pri/TTEST-FTEST/json/list';
      const workspaceRoot = 'https://synthetic-workspace.slack.com/';
      globalThis.fetch = async (url, init) => {
        const role = roles.get(new Headers(init.headers).get('authorization')) ?? 'unknown';
        const method = url === file ? 'file' : url === workspaceRoot ? 'workspace-root' : String(url).slice(api.length);
        calls.push(method + ':' + role);
        if (url === api + 'auth.test') return Response.json(role === 'user'
          ? {ok: true, team_id: 'TTEST', user_id: ${JSON.stringify(userId)}} : {ok: true, team_id: 'TTEST', bot_id: 'BTEST'});
        if (url === api + 'apps.connections.open') return Response.json({ok: true, url: 'wss://wss.slack.com/link'});
        if (url === api + 'slackLists.download.start') return Response.json({ok: true, job_id: 'LeTest'});
        if (url === api + 'slackLists.download.get') return Response.json({ok: true, status: 'COMPLETED', download_url: file});
        if (url === file) {
          if (init.method !== 'GET' || init.redirect !== 'manual') throw new Error('Unexpected download options');
          if (${scenario === 'file-redirect'}) return Response.redirect(workspaceRoot, 302);
          return Response.json({list_id: 'FTEST', items: []});
        }
        throw new Error('Unexpected URL in offline test');
      };
      globalThis.WebSocket = class extends EventTarget { readyState = 1; close() {} };
    `);
    const output = await runSyntheticWorker(options, preload, env, stdout =>
      stdout.includes('"reason":"SLACK_SOCKET_CONNECTED"') && stdout.includes('{"event":"slack-list-poll"'));
    const notices = output.split('\n').filter(line => line.startsWith('{"event":"slack-list-poll"')).map(line => JSON.parse(line));
    const expectedCalls = ['auth.test:web', 'auth.test:user', 'apps.connections.open:app'];
    if (scenario === 'wrong-user') {
      assert.deepEqual(notices, [{ event: 'slack-list-poll', status: 'error', listId: 'FTEST', reason: 'SLACK_LIST_USER_MISMATCH', method: 'auth.test' }]);
    } else {
      expectedCalls.push('slackLists.download.start:user', 'slackLists.download.get:user', 'file:user');
      if (scenario === 'file-redirect') {
        assert.deepEqual(notices, [{ event: 'slack-list-poll', status: 'error', listId: 'FTEST',
          reason: 'SLACK_LIST_REDIRECT_DENIED', method: 'file.download', httpStatus: 302 }]);
      } else {
        assert.deepEqual(notices, [{ event: 'slack-list-poll', status: 'baseline', listId: 'FTEST', commentCount: 0, mentionCount: 0 }]);
      }
    }
    const calls: string[] = JSON.parse(await readFile(tracePath, 'utf8'));
    assert.deepEqual(calls.sort(), expectedCalls.sort());
  }
});
