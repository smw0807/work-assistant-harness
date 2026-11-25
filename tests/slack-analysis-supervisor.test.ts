import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

const supervisorUrl = new URL('../src/cli/slack-analysis-supervisor.js', import.meta.url).href;
interface Result { outcome: string; code?: string; sigintListeners: number; sigtermListeners: number }
interface Fixture { directory: string; driver: (receiver: string, analysis: string, executable?: string) => string }
const fixture = async (context: TestContext): Promise<Fixture> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-slack-supervisor-')));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const worker = join(directory, 'synthetic-worker.mjs');
  await writeFile(worker, `import { writeFileSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    const directory = ${JSON.stringify(directory)};
    const role = process.argv[2], behavior = process.argv[3];
    const mark = (name, value = String(Date.now())) => writeFileSync(join(directory, role + '.' + name), value, {mode:0o600});
    mark('pid', String(process.pid));
    mark('env', JSON.stringify(Object.fromEntries(['LANG','TZ','PATH','HOME','NODE_OPTIONS','UNRELATED_SECRET','SLACK_APP_TOKEN','SLACK_WEB_TOKEN','SLACK_LIST_USER_TOKEN']
      .map(key => [key, process.env[key] ?? null]))));
    let ending = false;
    const active = setInterval(() => {}, 20);
    const stop = () => {
      mark('term');
      if (behavior === 'stubborn' || ending) return;
      ending = true;
      setTimeout(() => { mark('closed'); clearInterval(active); process.exit(0); }, role === 'analysis' ? 150 : 20);
    };
    process.on('SIGTERM', stop);
    process.on('disconnect', stop);
    mark('started');
    if (role === 'analysis') {
      process.on('message', snapshot => {
        if (snapshot.type === 'slack-analysis-snapshot' && snapshot.request.thread.messages[0].text === 'SYNTHETIC_IPC_BODY') mark('received');
      });
      if (behavior === 'no-ready-exit') setTimeout(() => process.exit(0), 50);
      else if (behavior !== 'no-ready') setTimeout(() => {
        mark('ready'); process.send(behavior === 'invalid-ready' ? {ready:true, extra:true} : {ready:true});
      }, behavior === 'delayed-ready' ? 200 : 0);
      if (behavior === 'exit-failure') {
        const wait = setInterval(() => {
          if (existsSync(join(directory, 'receiver.started'))) { clearInterval(wait); process.exit(19); }
        }, 20);
      }
    } else if (behavior === 'snapshot' || behavior === 'invalid-snapshot') {
      process.on('message', ack => {
        if (ack.type === 'slack-analysis-forwarded') mark('ack');
      });
      process.send(behavior === 'invalid-snapshot' ? {type:'wrong'} : {type:'slack-analysis-snapshot',
        request:{status:'RECORDED', thread:{complete:true, reason:null, messages:[{user:'UA',ts:'1.0',text:'SYNTHETIC_IPC_BODY'}]}}});
      const wait = setInterval(() => {
        if (existsSync(join(directory, 'analysis.received')) && existsSync(join(directory, 'receiver.ack'))) {
          clearInterval(wait); process.exit(0);
        }
      }, 10);
    } else if (behavior === 'exit-normal' || behavior === 'exit-failure') {
      setTimeout(() => process.exit(behavior === 'exit-normal' ? 0 : 17), 80);
    }
  `, { mode: 0o600 });
  return { directory, driver: (receiver, analysis, executable = process.execPath) => `
    import { runSlackAnalysisPair } from ${JSON.stringify(supervisorUrl)};
    process.env.HOME = '/synthetic-ambient-home';
    process.env.NODE_OPTIONS = '--require=/synthetic-missing-injection.js';
    process.env.UNRELATED_SECRET = 'synthetic-ambient-secret';
    process.env.SLACK_APP_TOKEN = 'synthetic-ambient-app';
    process.env.SLACK_WEB_TOKEN = 'synthetic-ambient-web';
    process.env.SLACK_LIST_USER_TOKEN = 'synthetic-ambient-list';
    const result = (outcome, code) => process.stdout.write(JSON.stringify({outcome, ...(code ? {code} : {}),
      sigintListeners:process.listenerCount('SIGINT'), sigtermListeners:process.listenerCount('SIGTERM')}));
    await runSlackAnalysisPair(${JSON.stringify(executable)}, ${JSON.stringify([worker, 'receiver', receiver])},
      ${JSON.stringify([worker, 'analysis', analysis])}, ${JSON.stringify(directory)}, {
        SLACK_APP_TOKEN:'synthetic-receiver-app', SLACK_WEB_TOKEN:'synthetic-receiver-web', SLACK_LIST_USER_TOKEN:'synthetic-receiver-list',
        HOME:'/synthetic-accidental-home', NODE_OPTIONS:'--require=/synthetic-accidental-injection.js', UNRELATED_SECRET:'synthetic-accidental-secret'
      }).then(() => result('resolved'), error => result('rejected', error.code));
  ` };
};
const invoke = (setup: Fixture, receiver: string, analysis: string, executable?: string): Result => JSON.parse(execFileSync(
  process.execPath, ['--input-type=module', '-e', setup.driver(receiver, analysis, executable)],
  { encoding: 'utf8', timeout: 25_000, env: { LANG: 'C.UTF-8', TZ: 'UTC' } },
)) as Result;
const mark = (setup: Fixture, role: string, name: string): Promise<string> => readFile(join(setup.directory, `${role}.${name}`), 'utf8');
const waitForMark = async (setup: Fixture, role: string, name: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await mark(setup, role, name); return; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 10)); }
  }
  throw new Error('synthetic child did not start');
};
const noListeners = (result: Result): void => {
  assert.equal(result.sigintListeners, 0);
  assert.equal(result.sigtermListeners, 0);
};

test('분석 ready 이후에만 수신기를 시작하고 각 child에 필요한 환경만 전달한다', async context => {
  const setup = await fixture(context);
  const result = invoke(setup, 'exit-normal', 'delayed-ready');
  assert.equal(result.outcome, 'resolved');
  noListeners(result);
  assert.ok(Number(await mark(setup, 'receiver', 'started')) >= Number(await mark(setup, 'analysis', 'ready')));
  assert.deepEqual(JSON.parse(await mark(setup, 'analysis', 'env')), {
    LANG: 'C.UTF-8', TZ: 'UTC', PATH: '/usr/bin:/bin', HOME: null, NODE_OPTIONS: null, UNRELATED_SECRET: null, SLACK_APP_TOKEN: null, SLACK_WEB_TOKEN: null,
    SLACK_LIST_USER_TOKEN: null,
  });
  assert.deepEqual(JSON.parse(await mark(setup, 'receiver', 'env')), {
    LANG: 'C.UTF-8', TZ: 'UTC', PATH: null, HOME: null, NODE_OPTIONS: null, UNRELATED_SECRET: null, SLACK_APP_TOKEN: 'synthetic-receiver-app', SLACK_WEB_TOKEN: 'synthetic-receiver-web',
    SLACK_LIST_USER_TOKEN: 'synthetic-receiver-list',
  });
  const terminated = Number(await mark(setup, 'analysis', 'term'));
  assert.ok(Number(await mark(setup, 'analysis', 'closed')) - terminated >= 100);
});

test('준비된 분석기로 메모리 스냅샷을 보내고 수신기에 전달 완료를 알린다', async context => {
  const setup = await fixture(context);
  assert.equal(invoke(setup, 'snapshot', 'wait').outcome, 'resolved');
  await mark(setup, 'analysis', 'received');
  await mark(setup, 'receiver', 'ack');
  const invalid = await fixture(context);
  assert.equal(invoke(invalid, 'invalid-snapshot', 'wait').code, 'SLACK_ANALYSIS_PAIR_FAILED');
  await assert.rejects(mark(invalid, 'analysis', 'received'), { code: 'ENOENT' });
});

test('수신기 비정상 종료는 분석기도 멈추고 close를 기다린 뒤 고정 실패를 반환한다', async context => {
  const setup = await fixture(context);
  const result = invoke(setup, 'exit-failure', 'wait');
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.code, 'SLACK_ANALYSIS_PAIR_FAILED');
  await mark(setup, 'analysis', 'closed');
  noListeners(result);
});

test('분석기 비정상 종료도 수신기를 멈추고 close를 기다린다', async context => {
  const setup = await fixture(context);
  const result = invoke(setup, 'wait', 'exit-failure');
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.code, 'SLACK_ANALYSIS_PAIR_FAILED');
  await mark(setup, 'receiver', 'closed');
  noListeners(result);
});

test('사용자 SIGTERM은 양쪽 종료와 close 관찰 뒤 정상 완료한다', async context => {
  const setup = await fixture(context);
  const child = spawn(process.execPath, ['--input-type=module', '-e', setup.driver('wait', 'wait')], {
    env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const closed = new Promise<number | null>((resolveClose, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveClose(code));
  });
  context.after(() => { child.kill('SIGTERM'); });
  await waitForMark(setup, 'receiver', 'started');
  child.kill('SIGTERM');
  assert.equal(await closed, 0, errors);
  const result = JSON.parse(output) as Result;
  assert.equal(result.outcome, 'resolved');
  await mark(setup, 'receiver', 'closed');
  await mark(setup, 'analysis', 'closed');
  noListeners(result);
});

test('잘못된 ready·ready 전 종료는 수신기를 시작하지 않고 실패한다', async context => {
  for (const behavior of ['invalid-ready', 'no-ready-exit']) {
    const setup = await fixture(context);
    const result = invoke(setup, 'wait', behavior);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.code, 'SLACK_ANALYSIS_PAIR_FAILED');
    await assert.rejects(mark(setup, 'receiver', 'started'), { code: 'ENOENT' });
    noListeners(result);
  }
});

test('spawn 오류와 동기 인자 오류는 미처리 error나 signal listener를 남기지 않는다', async context => {
  for (const executable of ['/synthetic-not-created/node', '']) {
    const setup = await fixture(context);
    const result = invoke(setup, 'wait', 'wait', executable);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.code, 'SLACK_ANALYSIS_PAIR_FAILED');
    noListeners(result);
  }
});

test('TERM을 무시한 peer는 grace 뒤 KILL하고 실제 close 이후 실패를 반환한다', async context => {
  const setup = await fixture(context);
  const started = Date.now();
  const result = invoke(setup, 'exit-normal', 'stubborn');
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.code, 'SLACK_ANALYSIS_PAIR_FAILED');
  assert.ok(Date.now() - started >= 6500);
  await mark(setup, 'analysis', 'term');
  await assert.rejects(mark(setup, 'analysis', 'closed'), { code: 'ENOENT' });
  const pid = Number(await mark(setup, 'analysis', 'pid'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  noListeners(result);
});

test('ready 대기는 15초로 제한하고 준비되지 않은 분석기의 close도 기다린다', async context => {
  const setup = await fixture(context);
  const started = Date.now();
  const result = invoke(setup, 'wait', 'no-ready');
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.code, 'SLACK_ANALYSIS_PAIR_FAILED');
  assert.ok(Date.now() - started >= 15_000);
  await mark(setup, 'analysis', 'closed');
  await assert.rejects(mark(setup, 'receiver', 'started'), { code: 'ENOENT' });
  noListeners(result);
});
