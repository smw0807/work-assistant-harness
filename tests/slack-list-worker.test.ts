import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { SlackWorkerOptions } from '../src/cli/slack.js';
import { pollSlackLists } from '../src/application/poll-slack-list.js';

test('리스트 하나가 실패해도 다음 리스트를 처리하고 다음 주기에 재시도하며 취소된 조회는 반영하지 않는다', async () => {
  const scope = { workspaceId: 'TTEST', listIds: ['FMISSING', 'FTEST'], targetUserId: 'UOWNER' };
  const controller = new AbortController();
  const events: string[] = [];
  let calls = 0;
  await pollSlackLists(scope, { async read(_workspaceId, listId) {
    events.push(`read ${listId}`);
    calls++;
    if (calls === 1) throw new Error('private-response');
    if (calls === 5) controller.abort();
    return { list_id: listId, items: [] };
  } }, { applyListSnapshot(listId) {
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

test('리스트 단독 수신 worker의 첫 조회·재시작·실패 복구와 CLI 조회를 합성 HTTP로 검증한다', async context => {
  const sourceRoot = await realpath(resolve('.'));
  const dataDirectory = await realpath(await mkdtemp(join(tmpdir(), 'harness-list-worker-')));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const config = { workspaceId: 'TTEST', listIds: ['FMISSING', 'FTEST'], targetUserId: 'UOWNER', channelIds: [],
    retentionHours: 24, maxPending: 10, thread: { maxMessages: 10, maxPages: 2, maxBytes: 16_384 }, liveReadEnabled: true };
  const options: SlackWorkerOptions = { command: 'slack-listen', config, dataDirectory, sourceRoot,
    eventsPath: '', channelId: '', messageTs: '' };
  const fixturePath = join(dataDirectory, 'synthetic-export.json');
  const preload = join(dataDirectory, 'synthetic-fetch.mjs');
  const urls = { identity: 'https://slack.com/api/auth.test', start: 'https://slack.com/api/slackLists.download.start',
    get: 'https://slack.com/api/slackLists.download.get', file: 'https://files.slack.com/files-pri/TTEST-FTEST/json/list' };
  await writeFile(preload, `
    import { readFile } from 'node:fs/promises';
    const urls = ${JSON.stringify(urls)};
    globalThis.fetch = async (url, init) => {
      if (url === urls.identity) return Response.json({ok:true, team_id:'TTEST'});
      if (url === urls.start) {
        const { list_id } = JSON.parse(init.body);
        if (list_id === 'FMISSING') return Response.json({ok:false, error:'list_not_found'});
        if (list_id === 'FTEST') return Response.json({ok:true, job_id:'LeTest'});
        throw new Error('Unexpected list in offline test');
      }
      if (url === urls.get) return Response.json({ok:true, status:'COMPLETED', download_url:urls.file});
      if (url === urls.file) return new Response(await readFile(${JSON.stringify(fixturePath)}));
      throw new Error('Unexpected URL in offline test');
    };
  `);
  const noticePrefix = '{"event":"slack-list-poll"';
  const run = async (exported: unknown, finalStatus: string) => {
    await writeFile(fixturePath, JSON.stringify(exported));
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${sourceRoot}`, `--allow-fs-read=${dataDirectory}`,
      `--allow-fs-write=${dataDirectory}`, '--allow-net', '--import', pathToFileURL(preload).href,
      join(sourceRoot, 'dist/src/cli/slack-worker.js'), JSON.stringify(options)], {
      env: { SLACK_WEB_TOKEN: 'synthetic-test-value' }, timeout: 15_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', stopping = false;
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      if (stopping || !stdout.endsWith('\n')) return;
      const lastLine = stdout.trimEnd().split('\n').at(-1);
      if (!lastLine?.startsWith(noticePrefix)) return;
      const lastNotice = JSON.parse(lastLine);
      if (lastNotice.listId === 'FTEST' && lastNotice.status === finalStatus) {
        stopping = true;
        child.kill('SIGTERM');
      }
    });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    assert.equal(code, 0, stderr);
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
    return notices;
  };
  const row = (text: string, ts: string) => ({ text, ts, user: 'UAUTHOR' });
  const snapshot = (thread: unknown[]) => ({ list_id: 'FTEST', items: [{ id: 'RecTEST', thread, fields: [{ user: ['UOWNER'] }] }] });
  const old = row('<@UOWNER> 과거 멘션', '1700000000.000001');
  const normal = row('일반 댓글', '1700000000.000002');
  const fresh = row('<@UOWNER> 확인 private@example.test', '1700000000.000003');
  assert.equal((await run(snapshot([old, normal]), 'baseline'))[0].status, 'baseline');
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
  assert.equal(listMentions[0].text, '<@UOWNER> 확인 [REDACTED_EMAIL]');
});
