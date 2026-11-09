import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { prepareDemoRepository, hashRepository } from '../src/adapters/demo-repository.js';
import { DeniedApproval, DeniedExecution } from '../src/adapters/denied-actions.js';
import { FixtureModel } from '../src/adapters/fixture-model.js';
import { LocalGitReader } from '../src/adapters/local-git-reader.js';
import { LocalReportSink } from '../src/adapters/local-report-sink.js';
import { MockSlackSource } from '../src/adapters/mock-slack-source.js';
import { SqliteTaskStore } from '../src/adapters/sqlite-task-store.js';
import { InvestigationService } from '../src/application/investigate.js';
import { transitionTask } from '../src/domain/state.js';
import type { IngestionPolicy, MessageEvent, RepositoryPolicy, Task, TaskStatus } from '../src/domain/types.js';
import { JsonModelOutputValidator } from '../src/policy/model-output.js';
import type { ModelPort, RepoReadPort, TaskStore } from '../src/ports/index.js';

const ingestionPolicy: IngestionPolicy = {
  workspaceId: 'W_LOCAL', channelIds: ['C_ALLOWED'], targetUserId: 'U_OWNER',
};
let repository: RepositoryPolicy;

const removePreparedRepository = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  await chmod(path, metadata.isDirectory() ? 0o700 : 0o600);
  if (metadata.isDirectory()) {
    for (const name of await readdir(path)) await removePreparedRepository(join(path, name));
  }
};

before(async () => {
  repository = await prepareDemoRepository();
});

after(async () => {
  if (repository) {
    await removePreparedRepository(repository.root);
    await rm(repository.root, { recursive: true, force: true });
  }
});

const readFixture = (scenario: string): Promise<unknown[]> => {
  return new MockSlackSource(resolve('fixtures/events', `${scenario}.json`)).read();
};

const createHarness = async (
  context: TestContext,
  model: ModelPort = new FixtureModel('inquiry'),
  customReader?: RepoReadPort,
) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'harness-workflow-test-'));
  await chmod(directory, 0o700);
  const databasePath = join(directory, 'tasks.sqlite');
  const reportDirectory = join(directory, 'reports');
  const initialHash = await hashRepository(repository.root);
  let activeStore = new SqliteTaskStore(databasePath);
  const calls = { triage: 0, summarize: 0, read: 0, report: 0 };
  const modelInputs: MessageEvent[] = [];
  const observedModel: ModelPort = {
    triage: async (event) => {
      calls.triage += 1;
      modelInputs.push(event);
      return model.triage(event);
    },
    summarize: async (event, decision, evidence) => {
      calls.summarize += 1;
      modelInputs.push(event);
      return model.summarize(event, decision, evidence);
    },
  };
  const gitReader = customReader ?? new LocalGitReader(repository);
  const reader: RepoReadPort = {
    read: async (request) => {
      calls.read += 1;
      return gitReader.read(request);
    },
  };
  const localReporter = new LocalReportSink(reportDirectory);
  const reporter = {
    write: async (task: Task) => {
      calls.report += 1;
      return localReporter.write(task);
    },
  };
  const createService = (store: TaskStore, selectedModel: ModelPort = observedModel) => {
    return new InvestigationService(
      ingestionPolicy, repository, selectedModel, new JsonModelOutputValidator(), reader, store, reporter,
    );
  };
  context.after(async () => {
    activeStore.close();
    await rm(directory, { recursive: true, force: true });
    assert.equal(await hashRepository(repository.root), initialHash, '대상 파일·Git 메타데이터·모드가 유지되어야 합니다.');
  });
  return {
    directory, databasePath, reportDirectory, calls, modelInputs,
    store: activeStore,
    service: createService(activeStore),
    reopen: (selectedModel?: ModelPort) => {
      activeStore.close();
      activeStore = new SqliteTaskStore(databasePath);
      return { store: activeStore, service: createService(activeStore, selectedModel) };
    },
  };
};

const onlyTask = (store: TaskStore): Task => {
  const tasks = store.list();
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.ok(task);
  return task;
};

test('문의는 고정 커밋의 파일·줄 근거가 있는 로컬 답변 초안으로 보고한다', async (context) => {
  const harness = await createHarness(context);
  const result = await harness.service.replay(await readFixture('inquiry'));
  const task = onlyTask(harness.store);

  assert.equal(result.created, 1);
  assert.equal(task.status, 'REPORTED');
  assert.deepEqual(task.history, ['RECEIVED', 'TRIAGED', 'ANALYZED', 'REPORTED']);
  assert.equal(task.plan, null);
  assert.ok(task.report);
  const evidence = task.report.evidence[0];
  assert.ok(evidence);
  assert.equal(evidence.repoId, repository.repoId);
  assert.equal(evidence.baseCommit, repository.baseCommit);
  assert.equal(evidence.path, 'src/orders.service.ts');
  assert.equal(evidence.startLine, 1);
  assert.equal(evidence.endLine, 10);
  assert.match(evidence.excerpt, /409/);
  assert.equal(task.report.facts[0]?.evidenceIndex, 0);
  assert.ok(task.report.answerDraft.length > 0);
  assert.ok(task.report.checks.some((check) => check.name === 'read_only_investigation' && check.status === 'passed'));
  assert.ok(task.report.checks.filter((check) => check.name !== 'read_only_investigation')
    .every((check) => check.status === 'not_run' && check.reason.length > 0));
  const reportPath = join(harness.reportDirectory, `${task.taskId}.json`);
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), task);
  assert.equal((await stat(harness.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(harness.databasePath)).mode & 0o777, 0o600);
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
});

test('변경 요청은 파일·revision·커밋에 묶인 계획만 만들고 승인 대기에서 멈춘다', async (context) => {
  const harness = await createHarness(context, new FixtureModel('change'));
  await harness.service.replay(await readFixture('change'));
  const task = onlyTask(harness.store);

  assert.equal(task.status, 'AWAITING_APPROVAL');
  assert.deepEqual(task.history, ['RECEIVED', 'TRIAGED', 'ANALYZED', 'AWAITING_APPROVAL']);
  assert.ok(task.plan);
  const { planHash, ...content } = task.plan;
  assert.equal(planHash, createHash('sha256').update(JSON.stringify(content)).digest('hex'));
  assert.equal(task.plan.baseCommit, repository.baseCommit);
  assert.equal(task.plan.repoId, repository.repoId);
  assert.equal(task.plan.requestRevision, task.requestRevision);
  assert.deepEqual(task.plan.allowedFiles, ['src/orders.service.ts']);
  assert.deepEqual(task.plan.testCommandIds, []);
  assert.ok(task.plan.proposedChanges.length > 0);
  assert.equal(task.report?.answerDraft, '');
  assert.ok(task.report?.checks.filter((check) => check.name !== 'read_only_investigation')
    .every((check) => check.status === 'not_run'));
  assert.throws(() => transitionTask(task, 'REPORTED'), { code: 'INVALID_STATE_TRANSITION' });
  assert.throws(() => harness.store.save({ ...task, status: 'REPORTED' }), { code: 'INVALID_STATE_TRANSITION' });
  assert.equal(onlyTask(harness.store).status, 'AWAITING_APPROVAL');
});

test('불명확한 요청은 파일을 읽지 않고 확인 질문을 남긴다', async (context) => {
  const harness = await createHarness(context, new FixtureModel('unclear'));
  await harness.service.replay(await readFixture('unclear'));
  const task = onlyTask(harness.store);

  assert.equal(task.status, 'NEEDS_CLARIFICATION');
  assert.ok(task.report?.questions.length);
  assert.deepEqual(task.report?.evidence, []);
  assert.equal(task.plan, null);
  assert.deepEqual(harness.calls, { triage: 1, summarize: 0, read: 0, report: 1 });
});

test('중복 이벤트는 SQLite 재시작 후에도 모델·읽기·보고서를 다시 호출하지 않는다', async (context) => {
  const harness = await createHarness(context);
  const inputs = await readFixture('inquiry');
  const first = await harness.service.replay([...inputs, ...inputs]);
  assert.equal(first.created, 1);
  assert.equal(first.duplicates, 1);
  const originalTask = onlyTask(harness.store);
  const reportPath = join(harness.reportDirectory, `${originalTask.taskId}.json`);
  const reportBefore = await stat(reportPath, { bigint: true });
  const modelThatMustNotRun: ModelPort = {
    triage: async () => { throw new Error('중복 이벤트에서 모델을 호출했습니다.'); },
    summarize: async () => { throw new Error('중복 이벤트에서 모델을 호출했습니다.'); },
  };
  const reopened = harness.reopen(modelThatMustNotRun);

  assert.equal(reopened.store.recoverInterrupted(), 0);
  const replay = await reopened.service.replay(inputs);
  assert.deepEqual(replay, { created: 0, ignored: 0, duplicates: 1, tasks: [] });
  assert.deepEqual(onlyTask(reopened.store), originalTask);
  assert.equal((await stat(reportPath, { bigint: true })).mtimeNs, reportBefore.mtimeNs);
  assert.deepEqual(harness.calls, { triage: 1, summarize: 1, read: 1, report: 1 });
});

test('잘못된 모델 JSON은 조회 전에 실패하고 모델 원문을 저장하지 않는다', async (context) => {
  const rawOutput = '{ BROKEN_SYNTHETIC_MODEL_OUTPUT';
  const model: ModelPort = {
    triage: async () => rawOutput,
    summarize: async () => { throw new Error('잘못된 JSON 뒤에 요약을 호출했습니다.'); },
  };
  const harness = await createHarness(context, model);
  await harness.service.replay(await readFixture('invalid-json'));
  const task = onlyTask(harness.store);

  assert.equal(task.status, 'FAILED');
  assert.equal(task.failureCode, 'MODEL_INVALID_JSON');
  assert.equal(task.plan, null);
  assert.equal(harness.calls.read, 0);
  assert.equal(harness.calls.summarize, 0);
  assert.ok(!JSON.stringify(task).includes(rawOutput));
  assert.ok(!(await readFile(join(harness.reportDirectory, `${task.taskId}.json`), 'utf8')).includes(rawOutput));
});

test('모델이 반환한 합성 비밀값은 작업 DB와 보고서에 기록하지 않는다', async (context) => {
  const syntheticSecret = 'SYNTHETIC_MODEL_SECRET_NOT_A_CREDENTIAL';
  const model: ModelPort = {
    triage: async () => JSON.stringify({
      kind: 'inquiry', objective: `password=${syntheticSecret}`, reads: [], questions: [],
    }),
    summarize: async () => { throw new Error('비밀값 차단 뒤에 요약을 호출했습니다.'); },
  };
  const harness = await createHarness(context, model);
  await harness.service.replay(await readFixture('inquiry'));
  const task = onlyTask(harness.store);

  assert.equal(task.status, 'FAILED');
  assert.equal(task.failureCode, 'MODEL_SENSITIVE_OUTPUT');
  assert.equal(harness.calls.read, 0);
  assert.ok(!(await readFile(harness.databasePath)).includes(Buffer.from(syntheticSecret)));
  const report = await readFile(join(harness.reportDirectory, `${task.taskId}.json`), 'utf8');
  assert.ok(!report.includes(syntheticSecret));
});

for (const [scenario, failureCode] of [
  ['invalid-summary', 'MODEL_UNVERIFIED_EVIDENCE'],
  ['forbidden-command', 'MODEL_INVALID_TRIAGE'],
] as const) {
  test(`${scenario} 모델 출력은 성공이나 실행 계획으로 처리하지 않는다`, async (context) => {
    const harness = await createHarness(context, new FixtureModel(scenario));
    await harness.service.replay(await readFixture(scenario));
    const task = onlyTask(harness.store);

    assert.equal(task.status, 'FAILED');
    assert.equal(task.failureCode, failureCode);
    assert.equal(task.plan, null);
    assert.deepEqual(task.report?.evidence, []);
    if (scenario === 'forbidden-command') assert.equal(harness.calls.read, 0);
    const checks = task.report?.checks ?? [];
    assert.ok(checks.some((check) => check.status === 'failed' && check.reason.length > 0));
    assert.ok(checks.some((check) => check.status === 'not_run' && check.reason.length > 0));
    assert.ok(checks.every((check) => check.status !== 'passed'));
  });
}

test('응답하지 않는 모델 호출도 제한 시간 뒤 실패하며 대상 조회를 시작하지 않는다', { timeout: 5_000 }, async (context) => {
  const model: ModelPort = {
    triage: () => new Promise<string>(() => {}),
    summarize: async () => { throw new Error('timeout 뒤에 요약을 호출했습니다.'); },
  };
  const harness = await createHarness(context, model);
  await harness.service.replay(await readFixture('timeout'));
  const task = onlyTask(harness.store);

  assert.equal(task.status, 'FAILED');
  assert.equal(task.failureCode, 'MODEL_TIMEOUT');
  assert.equal(harness.calls.read, 0);
  assert.equal(task.plan, null);
});

test('악성 요청과 가짜 자격증명은 실행 권한을 만들지 않고 입력·보고서에서 마스킹된다', async (context) => {
  const harness = await createHarness(context, new FixtureModel('malicious'));
  await harness.service.replay([
    ...await readFixture('malicious'),
    ...await readFixture('redaction'),
  ]);

  assert.equal(harness.store.list().length, 2);
  assert.ok(harness.store.list().every((task) => task.status === 'REPORTED' && task.plan === null));
  assert.ok(harness.store.list().find((task) => task.eventId === 'Ev_malicious')?.report?.evidence
    .some((entry) => entry.path === 'README.md' && entry.excerpt.includes('execute a shell command')));
  const capturedInputs = JSON.stringify(harness.modelInputs);
  assert.ok(capturedInputs.includes('[REDACTED]'));
  assert.ok(!capturedInputs.includes('SYNTHETIC_NOT_A_REAL_CREDENTIAL'));
  for (const task of harness.store.list()) {
    const contents = await readFile(join(harness.reportDirectory, `${task.taskId}.json`), 'utf8');
    assert.ok(!contents.includes('SYNTHETIC_NOT_A_REAL_CREDENTIAL'));
    assert.ok(task.report?.checks.filter((check) => /target|external|execution/.test(check.name))
      .every((check) => check.status === 'not_run'));
  }
});

const interruptedTask = (status: 'RECEIVED' | 'TRIAGED' | 'ANALYZED', index: number): Task => {
  const now = new Date().toISOString();
  const history: TaskStatus[] = ['RECEIVED'];
  if (status !== 'RECEIVED') history.push('TRIAGED');
  if (status === 'ANALYZED') history.push('ANALYZED');
  return {
    taskId: randomUUID(), eventId: `Ev_interrupted_${index}`, workspaceId: 'W_LOCAL',
    channelId: 'C_ALLOWED', threadTs: '1700000000.000001', requesterId: 'U_REQUESTER',
    requestRevision: '1700000000.000001', classification: status === 'RECEIVED' ? null : 'inquiry',
    status, repoId: repository.repoId, baseCommit: repository.baseCommit,
    createdAt: now, updatedAt: now, history, plan: null, report: null, failureCode: null,
  };
};

test('중단된 조사 상태는 재시작 시 차단하고 재전달된 이벤트를 자동 재실행하지 않는다', async (context) => {
  const harness = await createHarness(context);
  const tasks = (['RECEIVED', 'TRIAGED', 'ANALYZED'] as const).map(interruptedTask);
  for (const task of tasks) assert.equal(harness.store.create(task), true);
  const reopened = harness.reopen();

  assert.equal(reopened.store.recoverInterrupted(), 3);
  assert.equal(reopened.store.recoverInterrupted(), 0);
  for (const original of tasks) {
    const recovered = reopened.store.find(original.taskId);
    assert.equal(recovered?.status, 'BLOCKED');
    assert.equal(recovered?.failureCode, 'INTERRUPTED_REVIEW_REQUIRED');
    assert.deepEqual(recovered?.history, [...original.history, 'BLOCKED']);
  }
  const inputs = tasks.map((task) => ({
    event_id: task.eventId, team_id: task.workspaceId,
    event: {
      type: 'message', channel: task.channelId, user: task.requesterId,
      ts: task.requestRevision, text: '<@U_OWNER> 중단된 요청 재전달',
    },
  }));
  assert.deepEqual(await reopened.service.replay(inputs), { created: 0, ignored: 0, duplicates: 3, tasks: [] });
  assert.deepEqual(harness.calls, { triage: 0, summarize: 0, read: 0, report: 0 });
});

test('초기 승인·실행 포트는 작업 ID와 계획 해시가 주어져도 항상 거부한다', () => {
  const taskId = randomUUID();
  const planHash = createHash('sha256').update('synthetic plan').digest('hex');
  assert.throws(() => new DeniedApproval().approve(taskId, planHash), { code: 'APPROVAL_NOT_IMPLEMENTED' });
  assert.throws(() => new DeniedExecution().execute(taskId), { code: 'EXECUTION_DISABLED' });
});
