import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { hashRepository } from '../src/adapters/demo-repository.js';
import { SqliteCodexProposalStore } from '../src/adapters/sqlite-codex-proposal-store.js';
import { CodexProposalService } from '../src/application/propose-codex.js';
import { acquireRuntimeLease } from '../src/cli/runtime.js';
import type { BranchWorkType } from '../src/domain/branch.js';
import type { CodexConfig } from '../src/domain/codex-config.js';
import type { CodexProposalApproval, CodexProposalSnapshot, CodexProposalTask } from '../src/domain/codex-proposal.js';
import { CODEX_EXECUTION_POLICY_VERSION, type ExecutionApproval, type ExecutionSnapshot, type ExecutionTask } from '../src/domain/execution.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import { hashCodexConfig } from '../src/policy/codex-config.js';
import { getCodexProposalInput } from '../src/policy/codex-proposal-policy.js';

const config: CodexConfig = {
  enabled: true, policyVersion: 'codex-cli-proposal-v1', codexPath: '/synthetic/nonexistent/codex',
  codexSha256: 'a'.repeat(64), model: 'synthetic-model', authMode: 'api-key', timeoutMs: 60000, maxResponseBytes: 16384,
};
const sandbox: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/private/tmp/synthetic-codex-proposal.sock', serverVersion: '28.3.3', nodeVersion: '24.22.2',
  imageId: `sha256:${'b'.repeat(64)}`,
};
const syntheticCredential = 'SYNTHETIC_CREDENTIAL_MUST_NOT_APPEAR';
const proposedContent = "export const message = 'approved';\n";
const context = () => ({ ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
const request = (task: CodexProposalTask): string[] => ['--task', task.proposalId, '--plan-hash', task.plan.planHash];
const executionRequest = (task: ExecutionTask): string[] => [
  '--task', task.taskId, '--plan-hash', task.plan.planHash, '--base-commit', task.baseCommit,
];
const removeFixture = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await removeFixture(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
};
const fileHash = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex');

const prepare = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-codex-proposal-cli-')));
  await chmod(root, 0o700); t.after(() => removeFixture(root));
  const data = join(root, 'data');
  const configPath = join(root, 'codex.json');
  const sandboxPath = join(root, 'sandbox.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await writeFile(sandboxPath, JSON.stringify(sandbox), { mode: 0o600 });
  const execute = (args: string[], credential?: string) => {
    const result = spawnSync(process.execPath, [resolve('dist/src/cli/main.js'), ...args, '--data-dir', data], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 512_000,
      env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', TZ: 'UTC', ...(credential ? { CODEX_PROPOSAL_API_KEY: credential } : {}) },
    });
    assert.equal(result.error, undefined);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(syntheticCredential));
    return result;
  };
  const run = <T>(args: string[]): T => {
    const result = execute(args, syntheticCredential);
    assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stderr, '');
    return JSON.parse(result.stdout) as T;
  };
  const reject = (args: string[], code: string, credential?: string): void => {
    const result = execute(args, credential);
    assert.equal(result.status, 1, result.stdout); assert.equal(result.stdout, '');
    assert.equal(result.stderr.split('\n')[0], code);
  };
  const plan = (type: BranchWorkType = 'fix'): CodexProposalTask => run<CodexProposalSnapshot>([
    'codex-proposal-plan', '--type', type, '--codex-config', configPath,
  ]).task;
  const approve = (task: CodexProposalTask): CodexProposalApproval => run<{ approval: CodexProposalApproval }>([
    'codex-proposal-approve', ...request(task), '--expires-in-minutes', '30', '--codex-config', configPath,
  ]).approval;
  const inspect = (task: CodexProposalTask): CodexProposalSnapshot => run(['codex-proposal-inspect', '--task', task.proposalId]);
  const ready = async (type: BranchWorkType = 'fix'): Promise<CodexProposalTask> => {
    const task = plan(type); approve(task);
    const store = new SqliteCodexProposalStore(join(data, 'codex-proposals.sqlite'));
    try {
      const service = new CodexProposalService(store, { propose: async (input) => {
        assert.equal(input, getCodexProposalInput().inputText);
        return JSON.stringify({ path: 'src/message.mjs', content: proposedContent });
      } }, hashCodexConfig(config));
      const snapshot = await service.run(task.proposalId, task.plan.planHash, context());
      assert.equal(snapshot.task.status, 'READY'); return snapshot.task;
    } finally { store.close(); }
  };
  const exportArguments = (task: CodexProposalTask) => ['codex-execution-plan', '--proposal', task.proposalId,
    '--codex-config', configPath, '--config', sandboxPath];
  return { root, data, configPath, sandboxPath, execute, run, reject, plan, approve, inspect, ready, exportArguments };
};

test('Codex 제안 CLI는 네 유형의 합성 입력과 설정을 고정하고 새 프로세스에서 호출 승인만 조회한다', async (t) => {
  const cli = await prepare(t);
  for (const type of ['feature', 'fix', 'chore', 'refactor'] as const) {
    const snapshot = cli.run<CodexProposalSnapshot & { input: ReturnType<typeof getCodexProposalInput>; call: object }>([
      'codex-proposal-plan', '--type', type, '--codex-config', cli.configPath,
    ]);
    const task = snapshot.task;
    assert.equal(task.status, 'AWAITING_APPROVAL'); assert.equal(task.plan.workType, type);
    assert.equal(task.plan.configHash, hashCodexConfig(config)); assert.deepEqual(snapshot.input, getCodexProposalInput());
    assert.equal(task.plan.inputHash, snapshot.input.inputHash);
    assert.deepEqual(snapshot.call, { model: config.model, authMode: 'api-key', endpoint: 'https://api.openai.com/v1/responses',
      maxCalls: 1, timeoutMs: 60000, maxResponseBytes: 16384 });
    assert.equal(Date.parse(task.plan.expiresAt) - Date.parse(task.plan.createdAt), 86_400_000);
    cli.reject(['codex-proposal-run', ...request(task), '--codex-config', cli.configPath], 'CODEX_PROPOSAL_APPROVAL_REQUIRED', syntheticCredential);
    const approval = cli.approve(task);
    assert.deepEqual(approval.planSnapshot, task.plan); assert.equal(approval.usedAt, null);
    const inspected = cli.inspect(task);
    assert.equal(inspected.task.status, 'APPROVED'); assert.equal(inspected.attempt, null);
    assert.equal(inspected.approvals[0]?.approvalId, approval.approvalId);
  }
  assert.equal((await lstat(join(cli.data, 'codex-proposals.sqlite'))).mode & 0o077, 0);
  for (const name of ['codex-calls', 'codex-executions', 'codex-execution.sqlite', 'branch-execution.sqlite']) {
    await assert.rejects(lstat(join(cli.data, name)), { code: 'ENOENT' });
  }
});

test('Codex CLI는 임의 입력·경로·인증·Git 명령과 누락·중복·잘못된 TTL을 거부한다', async (t) => {
  const cli = await prepare(t); const task = cli.plan();
  for (const args of [
    ['codex-proposal-plan', '--codex-config', cli.configPath],
    ['codex-proposal-plan', '--type', 'docs', '--codex-config', cli.configPath],
    ['codex-proposal-plan', '--type', 'fix', '--type', 'feature', '--codex-config', cli.configPath],
    ['codex-proposal-inspect', '--task', '../escape'],
    ['codex-proposal-inspect', '--task', task.proposalId, '--approval-offset', '1000000001'],
    ['codex-proposal-inspect', '--task', task.proposalId, '--codex-config', cli.configPath],
    ...['--fixture', '--path', '--remote', '--body', '--command', '--token', '--auth', '--live', '--pr', '--mr', '--commit', '--push'].map((flag) => [
      'codex-proposal-plan', '--type', 'fix', '--codex-config', cli.configPath, flag, 'SYNTHETIC_FORBIDDEN',
    ]),
    ...[undefined, '0', '61', '1440', '01', '1.5'].map((ttl) => [
      'codex-proposal-approve', ...request(task), '--codex-config', cli.configPath,
      ...(ttl === undefined ? [] : ['--expires-in-minutes', ttl]),
    ]),
    ['codex-execution-plan', '--proposal', task.proposalId, '--codex-config', cli.configPath],
    ['codex-execution-plan', '--proposal', task.proposalId, '--config', cli.sandboxPath],
    ...['--type', '--fixture', '--path', '--command', '--token', '--pr', '--mr', '--commit', '--push'].map((flag) => [
      ...cli.exportArguments(task), flag, 'SYNTHETIC_FORBIDDEN',
    ]),
  ]) cli.reject(args, 'INVALID_ARGUMENTS');
  for (const suffix of ['invalidate', 'commit', 'push', 'pr', 'mr']) cli.reject([`codex-proposal-${suffix}`], 'UNKNOWN_COMMAND');
  assert.deepEqual(cli.inspect(task).approvals, []);
});

test('Codex 키 누락과 설정 변경은 호출 승인·시도·작업 디렉터리를 소비하지 않는다', async (t) => {
  const cli = await prepare(t); const task = cli.plan(); cli.approve(task);
  cli.reject(['codex-proposal-run', ...request(task), '--codex-config', cli.configPath], 'API_KEY_REQUIRED');
  let snapshot = cli.inspect(task);
  assert.equal(snapshot.task.status, 'APPROVED'); assert.equal(snapshot.attempt, null); assert.equal(snapshot.approvals[0]?.usedAt, null);
  await writeFile(cli.configPath, JSON.stringify({ ...config, model: 'another-synthetic-model' }));
  cli.reject(['codex-proposal-run', ...request(task), '--codex-config', cli.configPath], 'CODEX_PROPOSAL_CONFIG_MISMATCH', syntheticCredential);
  cli.reject(cli.exportArguments(task), 'CODEX_PROPOSAL_CONFIG_MISMATCH');
  snapshot = cli.inspect(task); assert.equal(snapshot.task.status, 'APPROVED'); assert.equal(snapshot.attempt, null);
  await assert.rejects(lstat(join(cli.data, 'codex-calls')), { code: 'ENOENT' });
  await writeFile(cli.configPath, JSON.stringify({ ...config, enabled: false }));
  const disabled = cli.plan();
  cli.reject(['codex-proposal-approve', ...request(disabled), '--expires-in-minutes', '30', '--codex-config', cli.configPath], 'CODEX_PROPOSAL_DISABLED');
  cli.reject(['codex-proposal-run', ...request(task), '--codex-config', cli.configPath], 'CODEX_PROPOSAL_DISABLED');
});

test('ChatGPT 인증 계획·승인은 로그인을 읽지 않고 run만 비어 있는 테스트 HOME의 로그인을 요구한다', async (t) => {
  const cli = await prepare(t);
  await writeFile(cli.configPath, JSON.stringify({ ...config, authMode: 'chatgpt' }));
  const snapshot = cli.run<CodexProposalSnapshot & { call: { authMode: string; endpoint: string } }>([
    'codex-proposal-plan', '--type', 'fix', '--codex-config', cli.configPath,
  ]);
  assert.equal(snapshot.call.authMode, 'chatgpt');
  assert.equal(snapshot.call.endpoint, 'https://chatgpt.com/backend-api/codex/responses');
  cli.approve(snapshot.task);
  cli.reject(['codex-proposal-run', ...request(snapshot.task), '--codex-config', cli.configPath], 'CODEX_LOGIN_REQUIRED');
  const inspected = cli.inspect(snapshot.task);
  assert.equal(inspected.task.status, 'APPROVED'); assert.equal(inspected.attempt, null);
  assert.equal(inspected.approvals[0]?.usedAt, null);
  await assert.rejects(lstat(join(cli.data, 'codex-calls')), { code: 'ENOENT' });
});

test('Codex 제안 조회·취소는 실행 lease 중 가능하고 호출·승인·복구는 충돌을 거부한다', async (t) => {
  const cli = await prepare(t); const task = cli.plan(); cli.approve(task);
  const release = acquireRuntimeLease(cli.data);
  try {
    assert.equal(cli.inspect(task).task.status, 'APPROVED');
    for (const args of [
      ['codex-proposal-plan', '--type', 'fix', '--codex-config', cli.configPath],
      ['codex-proposal-approve', ...request(task), '--expires-in-minutes', '30', '--codex-config', cli.configPath],
      ['codex-proposal-run', ...request(task), '--codex-config', cli.configPath],
      ['codex-proposal-recover', '--task', task.proposalId],
    ]) cli.reject(args, 'HARNESS_ALREADY_RUNNING');
    const cancelled = cli.run<CodexProposalSnapshot>(['codex-proposal-cancel', '--task', task.proposalId]);
    assert.equal(cancelled.task.status, 'CANCELLED'); assert.ok(cancelled.approvals[0]?.revokedAt);
  } finally { release(); }
  assert.equal(cli.run<CodexProposalSnapshot>(['codex-proposal-recover', '--task', task.proposalId]).task.status, 'CANCELLED');
  cli.reject(['codex-proposal-run', ...request(task), '--codex-config', cli.configPath], 'CODEX_PROPOSAL_APPROVAL_REQUIRED', syntheticCredential);
});

test('Codex 제안 만료·중단 복구는 승인 소비를 복원하지 않고 모델 호출을 재시도하지 않는다', async (t) => {
  const cli = await prepare(t); const task = cli.plan(); cli.approve(task);
  const store = new SqliteCodexProposalStore(join(cli.data, 'codex-proposals.sqlite'));
  let expired: CodexProposalTask;
  try {
    store.claim(task.proposalId, task.plan.planHash, context());
    const old = { ...context(), now: new Date(Date.now() - 120_000) };
    const service = new CodexProposalService(store, { propose: async () => { assert.fail('모델 호출 금지'); } }, hashCodexConfig(config));
    expired = service.plan('chore', old);
    service.approve({ proposalId: expired.proposalId, planHash: expired.plan.planHash, expiresInMinutes: 1 }, old);
  } finally { store.close(); }
  const recovered = cli.run<CodexProposalSnapshot>(['codex-proposal-recover', '--task', task.proposalId]);
  assert.equal(recovered.task.status, 'INTERRUPTED'); assert.equal(recovered.attempt?.status, 'INTERRUPTED');
  assert.ok(recovered.approvals[0]?.usedAt);
  cli.reject(['codex-proposal-run', ...request(task), '--codex-config', cli.configPath], 'CODEX_PROPOSAL_APPROVAL_REQUIRED', syntheticCredential);
  const expiredSnapshot = cli.inspect(expired);
  assert.equal(expiredSnapshot.task.status, 'AWAITING_APPROVAL'); assert.ok(expiredSnapshot.approvals[0]?.revokedAt);
  assert.equal(expiredSnapshot.attempt, null);
  await assert.rejects(lstat(join(cli.data, 'codex-calls')), { code: 'ENOENT' });
});

test('Codex CLI는 설정·DB 링크와 공개 데이터 디렉터리를 거부하고 외부 파일을 보존한다', async (t) => {
  const cli = await prepare(t); const task = cli.plan();
  const alias = join(cli.root, 'config-alias.json');
  await symlink(cli.configPath, alias);
  cli.reject(['codex-proposal-plan', '--type', 'fix', '--codex-config', alias], 'INVALID_CODEX_CONFIG');
  await unlink(alias); await link(cli.configPath, alias);
  cli.reject(['codex-proposal-plan', '--type', 'fix', '--codex-config', alias], 'INVALID_CODEX_CONFIG');
  await unlink(alias);
  await writeFile(alias, '{bad-json', { mode: 0o600 });
  cli.reject(['codex-proposal-plan', '--type', 'fix', '--codex-config', alias], 'INVALID_CODEX_CONFIG');
  const database = join(cli.data, 'codex-proposals.sqlite'); const backup = await readFile(database);
  const outside = join(cli.root, 'outside'); await writeFile(outside, 'SYNTHETIC_UNCHANGED', { mode: 0o600 });
  const before = await fileHash(outside);
  await unlink(database); await symlink(outside, database);
  cli.reject(['codex-proposal-inspect', '--task', task.proposalId], 'UNSAFE_RUNTIME_FILE');
  await unlink(database); await link(outside, database);
  cli.reject(['codex-proposal-inspect', '--task', task.proposalId], 'UNSAFE_RUNTIME_FILE');
  await unlink(database); await writeFile(database, backup, { mode: 0o600 });
  assert.equal(await fileHash(outside), before);
  await chmod(cli.data, 0o755);
  cli.reject(['codex-proposal-inspect', '--task', task.proposalId], 'DATA_DIRECTORY_NOT_PRIVATE');
  await chmod(cli.data, 0o700); assert.equal(cli.inspect(task).task.status, 'AWAITING_APPROVAL');
});

test('READY 제안은 한 번만 별도 실행 계획으로 옮기고 새 승인 전 원본·브랜치를 보존한다', async (t) => {
  const cli = await prepare(t); const proposal = await cli.ready('refactor');
  const task = cli.run<{ task: ExecutionTask }>(cli.exportArguments(proposal)).task;
  assert.equal(cli.inspect(proposal).task.status, 'EXPORTED'); assert.equal(task.taskId, proposal.proposalId);
  assert.equal(task.status, 'AWAITING_APPROVAL'); assert.equal(task.plan.policy.version, CODEX_EXECUTION_POLICY_VERSION);
  assert.equal(task.plan.branch?.name, `refactor/task-${proposal.proposalId}`);
  assert.deepEqual(task.plan.proposal, { proposalId: proposal.proposalId, inputHash: proposal.plan.inputHash,
    configHash: proposal.plan.configHash, responseHash: proposal.result!.responseHash, validatorVersion: 'codex-proposal-v1' });
  assert.equal(task.sourceRoot, join(cli.data, 'codex-executions', proposal.proposalId, 'source'));
  assert.equal(await readFile(join(task.sourceRoot, 'src/message.mjs'), 'utf8'), "export const message = 'before';\n");
  assert.equal(task.plan.patches[0]?.content, proposedContent);
  const before = await hashRepository(task.sourceRoot);
  cli.reject(cli.exportArguments(proposal), 'CODEX_PROPOSAL_NOT_READY');
  cli.reject(['codex-execution-run', ...executionRequest(task), '--config', cli.sandboxPath], 'APPROVAL_REQUIRED');
  for (const ttl of ['0', '61', '1440']) cli.reject([
    'codex-execution-approve', ...executionRequest(task), '--expires-in-minutes', ttl, '--config', cli.sandboxPath,
  ], 'INVALID_ARGUMENTS');
  const approval = cli.run<{ approval: ExecutionApproval }>([
    'codex-execution-approve', ...executionRequest(task), '--expires-in-minutes', '60', '--config', cli.sandboxPath,
  ]).approval;
  assert.equal(approval.executionPolicy, CODEX_EXECUTION_POLICY_VERSION); assert.equal(approval.usedAt, null);
  const snapshot = cli.run<ExecutionSnapshot>(['codex-execution-inspect', '--task', task.taskId]);
  assert.equal(snapshot.task.status, 'APPROVED'); assert.deepEqual(snapshot.runs, []);
  assert.equal(await hashRepository(task.sourceRoot), before);
  await assert.rejects(lstat(join(task.sourceRoot, '.git', task.plan.branch!.headRef)), { code: 'ENOENT' });
  const release = acquireRuntimeLease(cli.data);
  try {
    assert.equal(cli.run<ExecutionSnapshot>(['codex-execution-inspect', '--task', task.taskId]).task.status, 'APPROVED');
    cli.run(['codex-execution-invalidate', '--task', task.taskId, '--event', 'edited', '--revision', '2', '--event-id', 'synthetic-edit']);
  } finally { release(); }
  assert.equal(cli.run<ExecutionSnapshot>(['codex-execution-inspect', '--task', task.taskId]).task.status, 'CANCELLED');
});

test('실행 계획 생성 실패 뒤 EXPORTED를 되돌리지 않고 기존 DB를 보존한다', async (t) => {
  const cli = await prepare(t); const proposal = await cli.ready();
  const files = ['branches.sqlite', 'git-branches.sqlite', 'branch-execution.sqlite', 'execution.sqlite'];
  for (const file of files) await writeFile(join(cli.data, file), `SYNTHETIC_${file}`, { mode: 0o600 });
  const before = await Promise.all(files.map((file) => fileHash(join(cli.data, file))));
  await mkdir(join(cli.data, 'codex-executions'), { mode: 0o755 });
  await chmod(join(cli.data, 'codex-executions'), 0o755);
  cli.reject(cli.exportArguments(proposal), 'UNSAFE_EXECUTION_DIRECTORY');
  assert.equal(cli.inspect(proposal).task.status, 'EXPORTED');
  await chmod(join(cli.data, 'codex-executions'), 0o700);
  cli.reject(cli.exportArguments(proposal), 'CODEX_PROPOSAL_NOT_READY');
  assert.deepEqual(await Promise.all(files.map((file) => fileHash(join(cli.data, file)))), before);
  await assert.rejects(lstat(join(cli.data, 'codex-execution.sqlite')), { code: 'ENOENT' });
  cli.reject(['codex-proposal-inspect', '--task', randomUUID()], 'CODEX_PROPOSAL_NOT_FOUND');
});

test('기존 브랜치 실행 승인과 새 Codex 제안·실행 승인은 서로 다른 저장소에서 분리된다', async (t) => {
  const cli = await prepare(t);
  const old = cli.run<{ task: ExecutionTask }>(['branch-execution-plan', '--type', 'fix', '--config', cli.sandboxPath]).task;
  cli.run(['branch-execution-approve', ...executionRequest(old), '--expires-in-minutes', '30', '--config', cli.sandboxPath]);
  const beforeDatabase = await fileHash(join(cli.data, 'branch-execution.sqlite'));
  const beforeSource = await hashRepository(old.sourceRoot);
  const proposal = cli.plan();
  cli.reject(['codex-proposal-approve', '--task', old.taskId, '--plan-hash', old.plan.planHash,
    '--expires-in-minutes', '30', '--codex-config', cli.configPath], 'CODEX_PROPOSAL_NOT_FOUND');
  cli.reject(['codex-execution-approve', ...executionRequest(old), '--expires-in-minutes', '30', '--config', cli.sandboxPath], 'EXECUTION_TASK_NOT_FOUND');
  cli.reject(['branch-execution-inspect', '--task', proposal.proposalId], 'EXECUTION_TASK_NOT_FOUND');
  assert.equal(await fileHash(join(cli.data, 'branch-execution.sqlite')), beforeDatabase);
  assert.equal(await hashRepository(old.sourceRoot), beforeSource);
  assert.equal(cli.inspect(proposal).task.status, 'AWAITING_APPROVAL');
});
