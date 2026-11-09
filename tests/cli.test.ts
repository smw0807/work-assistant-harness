import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Task, TaskStatus } from '../src/domain/types.js';

interface CliReceipt {
  repository: { root: string; baseCommit: string };
  checks: { name: string; status: string; beforeHash: string; afterHash: string }[];
  receiptPath: string;
  result: { created: number; ignored: number; duplicates: number; tasks: { taskId: string; status: TaskStatus }[]; task?: Task; recovered: number };
}

const removeSyntheticRepository = async (root: string): Promise<void> => {
  const thaw = async (path: string): Promise<void> => {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return;
    await chmod(path, metadata.isDirectory() ? 0o700 : 0o600);
    if (metadata.isDirectory()) for (const name of await readdir(path)) await thaw(join(path, name));
  };
  await thaw(root);
  await rm(root, { recursive: true });
};

const createCli = async (context: TestContext) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'harness-cli-test-'));
  const repositories = new Set<string>();
  context.after(async () => {
    for (const root of repositories) await removeSyntheticRepository(root);
    await rm(directory, { recursive: true, force: true });
  });
  const run = (args: string[]): CliReceipt => {
    const output = execFileSync(process.execPath, [resolve('dist/src/cli/main.js'), ...args, '--data-dir', directory], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 256_000,
      env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const receipt = JSON.parse(output) as CliReceipt;
    repositories.add(receipt.repository.root);
    assert.match(receipt.repository.baseCommit, /^[a-f0-9]{40}$/);
    assert.equal(receipt.checks[0]?.status, 'passed');
    assert.equal(receipt.checks[0]?.beforeHash, receipt.checks[0]?.afterHash);
    return receipt;
  };
  return { directory, run };
};

test('실제 제한 프로세스 CLI로 문의·변경 계획·확인 질문을 저장하고 재시작 후 조회한다', async (context) => {
  const cli = await createCli(context);
  const inquiry = cli.run(['replay', '--fixture', 'inquiry']);
  assert.equal(inquiry.result.created, 1);
  assert.equal(inquiry.result.tasks[0]?.status, 'REPORTED');
  const change = cli.run(['replay', '--fixture', 'change']);
  const changeTaskId = change.result.tasks[0]?.taskId;
  assert.ok(changeTaskId);
  assert.equal(change.result.tasks[0]?.status, 'AWAITING_APPROVAL');
  const unclear = cli.run(['replay', '--fixture', 'unclear']);
  assert.equal(unclear.result.tasks[0]?.status, 'NEEDS_CLARIFICATION');
  const inspection = cli.run(['inspect', changeTaskId]);
  assert.equal(inspection.result.task?.status, 'AWAITING_APPROVAL');
  assert.equal(inspection.result.task?.plan?.baseCommit, change.repository.baseCommit);
  assert.ok(inspection.result.task?.plan?.planHash);
  const reportPath = join(cli.directory, 'reports', `${changeTaskId}.json`);
  const reportBefore = await readFile(reportPath, 'utf8');
  const replay = cli.run(['replay', '--fixture', 'change']);
  assert.equal(replay.result.created, 0);
  assert.equal(replay.result.duplicates, 1);
  assert.equal(await readFile(reportPath, 'utf8'), reportBefore);
  assert.equal(cli.run(['list']).result.tasks.length, 3);
  assert.equal(JSON.parse(await readFile(change.receiptPath, 'utf8')).result.created, 1);
});

for (const scenario of ['no-mention', 'other-user', 'disallowed-channel', 'other-workspace', 'edited', 'deleted', 'bot', 'self']) {
  test(`CLI ${scenario} 입력은 작업을 생성하지 않는다`, async (context) => {
    const cli = await createCli(context);
    const receipt = cli.run(['replay', '--fixture', scenario]);
    assert.equal(receipt.result.created, 0);
    assert.equal(receipt.result.ignored, 1);
    assert.equal(cli.run(['list']).result.tasks.length, 0);
  });
}

for (const scenario of ['invalid-json', 'invalid-summary', 'forbidden-command', 'timeout', 'hallucinated-file', 'path-escape', 'symlink', 'secret', 'large', 'binary']) {
  test(`CLI ${scenario} 오류는 실패 또는 차단으로 기록하고 대상 상태를 보존한다`, async (context) => {
    const cli = await createCli(context);
    const receipt = cli.run(['replay', '--fixture', scenario]);
    assert.equal(receipt.result.created, 1);
    const status = receipt.result.tasks[0]?.status;
    assert.ok(status === 'FAILED' || status === 'BLOCKED');
    const taskId = receipt.result.tasks[0]?.taskId;
    assert.ok(taskId);
    const task = cli.run(['inspect', taskId]).result.task;
    assert.equal(task?.plan, null);
    assert.ok(task?.report?.checks.some((check) => check.status === 'failed'));
    assert.ok(task?.report?.checks.some((check) => check.status === 'not_run'));
  });
}

test('CLI는 악성 본문을 실행하지 않고 비밀 입력을 보고서와 DB에 보관하지 않는다', async (context) => {
  const cli = await createCli(context);
  const malicious = cli.run(['replay', '--fixture', 'malicious']);
  assert.equal(malicious.result.tasks[0]?.status, 'REPORTED');
  const redacted = cli.run(['replay', '--fixture', 'redaction']);
  assert.equal(redacted.result.tasks[0]?.status, 'REPORTED');
  assert.ok(!(await readFile(join(cli.directory, 'tasks.sqlite'))).includes(Buffer.from('SYNTHETIC_NOT_A_REAL_CREDENTIAL')));
  for (const reportName of await readdir(join(cli.directory, 'reports'))) {
    assert.ok(!(await readFile(join(cli.directory, 'reports', reportName), 'utf8')).includes('SYNTHETIC_NOT_A_REAL_CREDENTIAL'));
  }
});

test('CLI는 로컬 이벤트 파일의 중복과 역순 시각을 안전하게 처리한다', async (context) => {
  const cli = await createCli(context);
  const fixture = JSON.parse(await readFile('fixtures/events/inquiry.json', 'utf8')) as Record<string, unknown>[];
  const event = fixture[0];
  assert.ok(event);
  const older = structuredClone(event);
  older.event_id = 'Ev_older';
  (older.event as Record<string, unknown>).ts = '1600000000.000001';
  const eventPath = join(cli.directory, 'local-events.json');
  await writeFile(eventPath, JSON.stringify([event, older, event]), { mode: 0o600 });
  const receipt = cli.run(['replay', '--events', eventPath]);
  assert.equal(receipt.result.created, 2);
  assert.equal(receipt.result.duplicates, 1);
});

test('미구현 승인·실행 명령과 소스에 겹치는 출력 경로를 거부한다', () => {
  for (const args of [['approve', 'unused'], ['run', 'unused'], ['list', '--data-dir', process.cwd()]]) {
    assert.throws(() => execFileSync(process.execPath, [resolve('dist/src/cli/main.js'), ...args], {
      encoding: 'utf8', env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
    }), (error: unknown) => error instanceof Error && 'stderr' in error
      && typeof error.stderr === 'string' && /UNKNOWN_COMMAND|DATA_DIRECTORY_OVERLAPS_SOURCE/.test(error.stderr));
  }
});
