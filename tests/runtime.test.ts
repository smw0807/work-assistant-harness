import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { LocalReportSink } from '../src/adapters/local-report-sink.js';
import { SqliteTaskStore } from '../src/adapters/sqlite-task-store.js';
import { acquireRuntimeLease, prepareDataDirectory, safeReadFlag } from '../src/cli/runtime.js';
import type { Task } from '../src/domain/types.js';

const sourceRoot = resolve('.');
const runtimeModule = new URL('../src/cli/runtime.js', import.meta.url).href;
const reportsModule = new URL('../src/adapters/local-report-sink.js', import.meta.url).href;

const temporaryDirectory = async (context: TestContext): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'harness-runtime-test-')));
  await chmod(directory, 0o700);
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const reportedTask = (): Task => {
  const now = new Date().toISOString();
  return {
    taskId: randomUUID(), eventId: 'Ev_runtime', workspaceId: 'W_LOCAL', channelId: 'C_ALLOWED',
    threadTs: '1700000000.000001', requesterId: 'U_REQUESTER', requestRevision: '1700000000.000001',
    classification: 'inquiry', status: 'REPORTED', repoId: 'sample', baseCommit: 'a'.repeat(40),
    createdAt: now, updatedAt: now, history: ['RECEIVED', 'TRIAGED', 'ANALYZED', 'REPORTED'],
    plan: null, failureCode: null,
    report: {
      summary: '합성 보고서', facts: [], hypotheses: [], evidence: [], answerDraft: '합성 답변',
      questions: [], risks: [], checks: [], nextApproval: '외부 전송은 비활성화되어 있습니다.',
    },
  };
};

test('런타임 데이터는 소스 밖의 비공개 디렉터리에만 둔다', async (context) => {
  const directory = await temporaryDirectory(context);
  const privateDirectory = join(directory, 'private');
  assert.equal(await prepareDataDirectory(privateDirectory, sourceRoot), privateDirectory);
  assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
  await assert.rejects(prepareDataDirectory(sourceRoot, sourceRoot), { code: 'DATA_DIRECTORY_OVERLAPS_SOURCE' });
  await assert.rejects(prepareDataDirectory(join(sourceRoot, 'runtime-test-data'), sourceRoot), { code: 'DATA_DIRECTORY_OVERLAPS_SOURCE' });
  const sharedDirectory = join(directory, 'shared');
  await mkdir(sharedDirectory);
  await chmod(sharedDirectory, 0o755);
  await assert.rejects(prepareDataDirectory(sharedDirectory, sourceRoot), { code: 'DATA_DIRECTORY_NOT_PRIVATE' });
  assert.equal((await stat(sharedDirectory)).mode & 0o777, 0o755, '기존 폴더의 권한을 자동으로 바꾸지 않습니다.');
  const linkedDirectory = join(directory, 'linked');
  await symlink(privateDirectory, linkedDirectory);
  await assert.rejects(prepareDataDirectory(linkedDirectory, sourceRoot), { code: 'UNSAFE_DATA_DIRECTORY' });
  const danglingDirectory = join(directory, 'dangling');
  await symlink(join(directory, 'absent'), danglingDirectory);
  await assert.rejects(prepareDataDirectory(danglingDirectory, sourceRoot), { code: 'UNSAFE_DATA_DIRECTORY' });
});

test('DB·lock와 모든 SQLite 부속 경로의 dangling symlink·hardlink를 차단한다', async (context) => {
  const directory = await temporaryDirectory(context);
  const outside = join(directory, 'outside.txt');
  await writeFile(outside, 'SYNTHETIC_UNCHANGED', { mode: 0o640 });
  const before = await readFile(outside);
  const beforeMode = (await stat(outside)).mode;
  let index = 0;
  for (const filename of ['tasks.sqlite', 'harness-lock.sqlite']) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      for (const kind of ['dangling-symlink', 'hardlink']) {
        const data = join(directory, `data-${index++}`);
        await mkdir(data, { mode: 0o700 });
        const candidate = join(data, `${filename}${suffix}`);
        const missingTarget = join(directory, `absent-${index}`);
        if (kind === 'hardlink') await link(outside, candidate);
        else await symlink(missingTarget, candidate);
        await assert.rejects(prepareDataDirectory(data, sourceRoot), { code: 'UNSAFE_RUNTIME_FILE' }, `${filename}${suffix}: ${kind}`);
        if (kind === 'dangling-symlink') await assert.rejects(lstat(missingTarget), { code: 'ENOENT' });
      }
    }
  }
  assert.deepEqual(await readFile(outside), before);
  assert.equal((await stat(outside)).mode, beforeMode);
});

test('직접 생성하는 SQLite store도 외부 inode·부속 경로를 수정하지 않는다', async (context) => {
  const directory = await temporaryDirectory(context);
  const outside = join(directory, 'outside.sqlite');
  const database = new DatabaseSync(outside);
  database.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'synthetic\')');
  database.close();
  await chmod(outside, 0o640);
  const before = await readFile(outside);
  const beforeMode = (await stat(outside)).mode;
  let index = 0;
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    for (const kind of ['dangling-symlink', 'hardlink']) {
      const data = join(directory, `store-${index++}`);
      await mkdir(data, { mode: 0o700 });
      const databasePath = join(data, 'tasks.sqlite');
      const missingTarget = join(directory, `absent-store-${index}`);
      if (kind === 'hardlink') await link(outside, `${databasePath}${suffix}`);
      else await symlink(missingTarget, `${databasePath}${suffix}`);
      assert.throws(() => new SqliteTaskStore(databasePath), { code: 'UNSAFE_RUNTIME_FILE' });
      if (kind === 'dangling-symlink') await assert.rejects(lstat(missingTarget), { code: 'ENOENT' });
    }
  }
  assert.deepEqual(await readFile(outside), before);
  assert.equal((await stat(outside)).mode, beforeMode);
});

test('런타임 lease는 동시 실행을 거부하고 종료 후 다시 얻을 수 있다', async (context) => {
  const directory = await temporaryDirectory(context);
  const release = acquireRuntimeLease(directory);
  try {
    assert.throws(() => acquireRuntimeLease(directory), { code: 'HARNESS_ALREADY_RUNNING' });
  } finally {
    release();
  }
  acquireRuntimeLease(directory)();
  const unsafeDirectory = join(directory, 'unsafe');
  await mkdir(unsafeDirectory, { mode: 0o700 });
  const outside = join(directory, 'never-create.sqlite');
  await symlink(outside, join(unsafeDirectory, 'harness-lock.sqlite'));
  assert.throws(() => acquireRuntimeLease(unsafeDirectory), { code: 'UNSAFE_RUNTIME_FILE' });
  await assert.rejects(lstat(outside), { code: 'ENOENT' });
});

test('보고서의 stale 임시 파일은 SQLite 원본에서의 재생성을 막지 않는다', async (context) => {
  const directory = await temporaryDirectory(context);
  const reports = join(directory, 'reports');
  await mkdir(reports, { mode: 0o700 });
  const task = reportedTask();
  const store = new SqliteTaskStore(join(directory, 'tasks.sqlite'));
  assert.equal(store.create(task), true);
  store.close();
  const staleNames = [`${task.taskId}.json.tmp`, `${task.taskId}.json.${randomUUID()}.tmp`];
  for (const name of staleNames) await writeFile(join(reports, name), 'interrupted synthetic output');
  const reopened = new SqliteTaskStore(join(directory, 'tasks.sqlite'));
  try {
    const sink = new LocalReportSink(reports);
    for (const stored of reopened.list()) if (stored.report) await sink.write(stored);
    const path = join(reports, `${task.taskId}.json`);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), task);
    const before = await stat(path, { bigint: true });
    await sink.write(task);
    assert.equal((await stat(path, { bigint: true })).mtimeNs, before.mtimeNs);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(reports)).filter((name) => name.endsWith('.tmp')).sort(), staleNames.sort());
  } finally {
    reopened.close();
  }
});

test('기존 보고서의 symlink·hardlink를 거부하고 외부 파일을 보존한다', async (context) => {
  const directory = await temporaryDirectory(context);
  const outside = join(directory, 'outside-report.txt');
  await writeFile(outside, 'SYNTHETIC_UNCHANGED');
  for (const kind of ['hardlink', 'dangling-symlink', 'symlink']) {
    const reports = join(directory, kind);
    await mkdir(reports);
    const task = reportedTask();
    const finalPath = join(reports, `${task.taskId}.json`);
    if (kind === 'hardlink') await link(outside, finalPath);
    else await symlink(kind === 'symlink' ? outside : join(directory, 'absent-report'), finalPath);
    await assert.rejects(new LocalReportSink(reports).write(task), { code: 'UNSAFE_REPORT_PATH' });
  }
  assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC_UNCHANGED');
  await assert.rejects(lstat(join(directory, 'absent-report')), { code: 'ENOENT' });
});

test('Node permission worker는 대상 쓰기·chmod·child·worker·네트워크를 차단한다', async (context) => {
  const directory = await temporaryDirectory(context);
  const data = join(directory, 'data');
  const target = join(directory, 'synthetic-target');
  await mkdir(data, { mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  const targetFile = join(target, 'source.ts');
  await writeFile(targetFile, 'export const synthetic = true;');
  await chmod(targetFile, 0o444);
  const code = `
    import { writeFileSync, chmodSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { Worker } from 'node:worker_threads';
    import net from 'node:net';
    import { assertWorkerPermissions } from ${JSON.stringify(runtimeModule)};
    import { LocalReportSink } from ${JSON.stringify(reportsModule)};
    const sourceRoot = ${JSON.stringify(sourceRoot)};
    const data = ${JSON.stringify(data)};
    const target = ${JSON.stringify(target)};
    const targetFile = ${JSON.stringify(targetFile)};
    assertWorkerPermissions(sourceRoot, data, target);
    const results = {};
    for (const [name, operation] of [
      ['write', () => writeFileSync(targetFile, 'unauthorized')],
      ['chmod', () => chmodSync(targetFile, 0o600)],
      ['child', () => spawnSync(process.execPath, ['--version'])],
      ['worker', () => new Worker('', {eval:true})],
    ]) { try { operation(); results[name] = 'ALLOWED'; } catch (error) { results[name] = error.code; } }
    await new Promise(resolve => {
      try {
        const socket = net.createConnection({host:'127.0.0.1',port:9});
        socket.once('error', error => { results.net = error.code; resolve(); });
        socket.once('connect', () => { results.net = 'ALLOWED'; socket.destroy(); resolve(); });
      } catch (error) { results.net = error.code; resolve(); }
    });
    await new LocalReportSink(data + '/reports').write(${JSON.stringify(reportedTask())});
    results.report = 'written';
    process.stdout.write(JSON.stringify(results));
  `;
  const output = execFileSync(process.execPath, [
    '--permission', safeReadFlag(sourceRoot), safeReadFlag(data), safeReadFlag(target),
    `--allow-fs-write=${data}`, '--input-type=module', '-e', code,
  ], { encoding: 'utf8', timeout: 5_000, env: { LANG: 'C.UTF-8', TZ: 'UTC' } });
  assert.deepEqual(JSON.parse(output), {
    write: 'ERR_ACCESS_DENIED', chmod: 'ERR_ACCESS_DENIED', child: 'ERR_ACCESS_DENIED',
    worker: 'ERR_ACCESS_DENIED', net: 'ERR_ACCESS_DENIED', report: 'written',
  });
  assert.equal(await readFile(targetFile, 'utf8'), 'export const synthetic = true;');
  assert.equal((await stat(targetFile)).mode & 0o777, 0o444);
});
