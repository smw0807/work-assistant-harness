import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { assertReadonlyRelayNativeVersion, readonlyRelayCodexArguments } from '../src/adapters/readonly-relay-codex.js';
import { RestrictedSlackAnalysisCodex } from '../src/adapters/slack-analysis-codex.js';
import { readonlyRelayCleanupConfirmed } from '../src/adapters/readonly-relay-lifecycle.js';
import { codexProposalArguments } from '../src/adapters/codex-cli-contract.js';
import { codexSandboxProfile, runSandboxedCodex } from '../src/adapters/codex-isolation.js';
import { runReadonlyRelayProcess } from '../src/adapters/readonly-relay-runner.js';
import { HarnessError } from '../src/domain/errors.js';
import type { CodexConfig } from '../src/domain/codex-config.js';
import type { ReadonlyRelayConfig, ReadonlyRelayDispatch } from '../src/domain/readonly-relay.js';
import type { ReadonlyReport } from '../src/domain/readonly-investigation.js';
import { SLACK_ANALYSIS_POLICY } from '../src/domain/slack-analysis.js';
import type { SlackCollectedRequest, SlackReceiverConfig } from '../src/domain/slack.js';
import { getReadonlyRelayExecutionBudget, getReadonlyRelayExecutionBudgetHash } from '../src/policy/readonly-relay-budget-policy.js';
import { hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';
import { buildSlackAnalysisPayload, parseSlackAnalysisResponse } from '../src/policy/slack-analysis.js';
import { parseReadonlyRelayCodexOutput } from '../src/policy/readonly-relay-protocol.js';

const binaryHash = '97bc82fd46f117cf10efb95e6ff0c81dc4784f5797bcdc2cb75093ba09e4def0';
const config: ReadonlyRelayConfig = {
  enabled: true, policyVersion: 'readonly-relay-codex-v3',
  codexPath: '/opt/homebrew/Caskroom/codex/0.167.2/bin/codex', codexSha256: binaryHash,
  model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384,
};
const receiver: SlackReceiverConfig = { workspaceId: 'W_SYNTHETIC', channelIds: ['C_SYNTHETIC'], targetUserId: 'U_OWNER',
  retentionHours: 24, maxPending: 100, thread: { maxMessages: 30, maxPages: 3, maxBytes: 16384 }, liveReadEnabled: false };
const request = (): SlackCollectedRequest => ({ workspaceId: receiver.workspaceId, channelId: receiver.channelIds[0]!,
  messageTs: '1795000000.000002', threadTs: '1795000000.000001', requesterId: 'U_REQUESTER', revision: '1795000000.000003',
  eventId: 'Ev_SYNTHETIC', status: 'RECORDED', text: '<@U_OWNER> 합성 요청의 일정을 알려 주세요.',
  thread: { complete: true, reason: null, messages: [
    { ts: '1795000000.000001', user: 'U_COLLEAGUE', text: '합성 작업은 금요일까지 확인할 예정입니다.' },
    { ts: '1795000000.000002', user: 'U_REQUESTER', text: '<@U_OWNER> 합성 요청의 일정을 알려 주세요.' },
  ] }, updatedAt: '2026-11-20T00:00:00.000Z', failureCode: null });
const report = (): ReadonlyReport => ({ classification: 'question', summary: '일정 확인 요청입니다.',
  facts: [{ text: '스레드에서 금요일까지 확인할 예정이라고 말했습니다.', references: [
    { evidenceId: 'slack-message-1795000000.000001', startLine: 1, endLine: 1 },
  ] }], hypotheses: [], answerDraft: '금요일까지 확인할 예정이라고 합니다.', questions: [], suggestions: [],
  limitations: ['실제 일정은 확인하지 않은 합성 응답입니다.'] });

test('current native version is restricted to the exact Slack v3 binary while legacy versions stay available', () => {
  assert.doesNotThrow(() => assertReadonlyRelayNativeVersion('codex-cli 0.167.2\n', config, SLACK_ANALYSIS_POLICY));
  for (const policy of [undefined, 'company-relay-plan-v1', 'personal-readonly-investigation-v1',
    'personal-readonly-investigation-v2', 'personal-readonly-investigation-v3', 'synthetic-readonly-relay-v1']) {
    assert.throws(() => assertReadonlyRelayNativeVersion('codex-cli 0.167.2', config, policy),
      { code: 'READONLY_RELAY_BINARY_UNSUPPORTED' });
    assert.doesNotThrow(() => assertReadonlyRelayNativeVersion('codex-cli 0.154.0\n', config, policy));
  }
  for (const output of ['codex-cli 0.167.1', 'codex-cli 0.168.0', 'codex-cli 0.167.2-preview',
    'codex-cli 0.167.2\nextra', 'Codex 0.167.2', '']) {
    assert.throws(() => assertReadonlyRelayNativeVersion(output, config, SLACK_ANALYSIS_POLICY),
      { code: 'READONLY_RELAY_BINARY_UNSUPPORTED' });
  }
  for (const changed of [{ ...config, codexSha256: 'a'.repeat(64) },
    { ...config, policyVersion: 'readonly-relay-codex-v1' as const, timeoutMs: 60000 as const },
    { ...config, policyVersion: 'readonly-relay-codex-v2' as const, timeoutMs: 60000 as const }]) {
    assert.throws(() => assertReadonlyRelayNativeVersion('codex-cli 0.167.2', changed, SLACK_ANALYSIS_POLICY),
      { code: 'READONLY_RELAY_BINARY_UNSUPPORTED' });
  }
});

test('native compatibility retains legacy argv, isolated configuration and the registered v3 budget', () => {
  const legacy: CodexConfig = { ...config, policyVersion: 'codex-cli-proposal-v1', timeoutMs: 60000 };
  const workspace = '/private/tmp/synthetic-slack-native', port = 12345;
  const previous = codexProposalArguments(legacy, workspace, port);
  assert.deepEqual(readonlyRelayCodexArguments(legacy, workspace, port), previous.map(argument =>
    argument === 'model_providers.harness.stream_idle_timeout_ms=30000'
      ? 'model_providers.harness.stream_idle_timeout_ms=55000' : argument));
  const budget = getReadonlyRelayExecutionBudget(config);
  assert.deepEqual(readonlyRelayCodexArguments(legacy, workspace, port, budget, '0.154.0'),
    readonlyRelayCodexArguments(legacy, workspace, port, budget));
  const current = readonlyRelayCodexArguments(legacy, workspace, port, budget, '0.167.2');
  for (const required of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config',
    '--sandbox', 'read-only', '--model', 'gpt-6.1-sol', '--output-schema', '--json',
    'model_providers.harness.request_max_retries=0', 'model_providers.harness.stream_max_retries=0',
    'model_providers.harness.stream_idle_timeout_ms=120000', 'model_providers.harness.supports_websockets=false',
    'shell_environment_policy.inherit="none"', 'cli_auth_credentials_store="ephemeral"']) assert.ok(current.includes(required), required);
  const disabled = current.flatMap((argument, index) => argument === '--disable' ? [current[index + 1]] : []);
  for (const feature of ['shell_tool', 'hooks', 'multi_agent', 'apps', 'plugins']) assert.ok(disabled.includes(feature), feature);
  assert.equal(current[current.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(current[current.indexOf('-a') + 1], 'never');
  assert.equal(current.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(current.includes('workspace-write'), false);
  assert.equal(budget.workTimeoutMs, 120000); assert.equal(budget.cleanupTimeoutMs, 5000);
  assert.equal(budget.totalTimeoutMs, 125000); assert.equal(budget.outputBytes, 16384);
  const payload = buildSlackAnalysisPayload(request(), receiver, config);
  assert.deepEqual(JSON.parse(payload.dispatch.requestEnvelope.body).tools, []);
  assert.equal(new Map(payload.dispatch.requestEnvelope.headers).get('user-agent'), 'codex_cli_rs/0.154.0');
});

test('current native admits its exact disabled-host startup warning while rejecting tool events and other errors', () => {
  const notice = { type: 'item.completed', item: { id: 'item_0', type: 'error',
    message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.' } };
  const started = { type: 'thread.started', thread_id: 'synthetic' }, turn = { type: 'turn.started' };
  const final = [{ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '{}' } }, { type: 'turn.completed' }];
  const output = (events: unknown[]): string => events.map(event => JSON.stringify(event)).join('\n');
  const valid = output([started, notice, turn, ...final]);
  assert.equal(parseReadonlyRelayCodexOutput(valid, 16384, '0.167.2'), '{}');
  assert.throws(() => parseReadonlyRelayCodexOutput(valid), { code: 'READONLY_RELAY_INVALID_CLI_OUTPUT' });
  for (const events of [[started, notice, notice, turn, ...final], [started, turn, notice, ...final],
    [started, { ...notice, item: { ...notice.item, message: `${notice.item.message} extra` } }, turn, ...final],
    [started, { ...notice, item: { ...notice.item, message: 'arbitrary startup failure' } }, turn, ...final],
    [started, notice, turn, { type: 'item.completed', item: { type: 'command_execution', command: 'synthetic' } }, ...final]]) {
    assert.throws(() => parseReadonlyRelayCodexOutput(output(events), 16384, '0.167.2'),
      { code: 'READONLY_RELAY_INVALID_CLI_OUTPUT' });
  }
});

test('managed preference access keeps legacy isolation and permits only the approved Codex read domain', () => {
  const executable = '/private/tmp/synthetic-codex', workspace = '/private/tmp/synthetic-sandbox';
  const legacy = codexSandboxProfile(executable, workspace, 12345);
  assert.equal(codexSandboxProfile(executable, workspace, 12345, false), legacy);
  assert.doesNotMatch(legacy, /user-preference|cfprefsd/);
  const current = codexSandboxProfile(executable, workspace, 12345, true);
  assert.equal(current.slice(0, legacy.length), legacy);
  assert.match(current, /\(allow user-preference-read \(preference-domain "com\.openai\.codex"\)\)/);
  assert.doesNotMatch(current, /user-preference-write|allow user-preference\*|GlobalPreferences|ipc-posix-shm-write|ipc-posix-name-prefix|allow mach-lookup\)/);
  assert.ok(current.includes(`(allow ipc-posix-shm-read* (ipc-posix-name "apple.cfprefs.${process.getuid?.()}v1") (ipc-posix-name "apple.cfprefs.daemonv1"))`));
  assert.throws(() => codexSandboxProfile(executable, workspace, 12345, 'true' as unknown as boolean),
    { code: 'INVALID_CODEX_PREFERENCES' });
});

test('invalid sandbox options fail before either guardian starts', async context => {
  const spawn = context.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected process start'); });
  syncBuiltinESMExports();
  try {
    const workspace = '/private/tmp/synthetic-sandbox', signal = new AbortController().signal;
    for (const [port, preferences, code] of [[0, false, 'INVALID_CODEX_BROKER'],
      [12345, 'true', 'INVALID_CODEX_PREFERENCES']] as const) {
      await assert.rejects(runSandboxedCodex('/synthetic/codex', [], workspace, port, {}, '', signal, 4096,
        preferences as boolean), { code });
      await assert.rejects(runReadonlyRelayProcess('/synthetic/codex', [], workspace, port, {}, '', signal,
        { dataDirectory: workspace, investigationId: randomUUID() }, undefined, preferences as boolean), { code });
    }
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    spawn.mock.restore(); syncBuiltinESMExports();
  }
});

const skip = process.platform === 'darwin' && process.arch === 'arm64' && process.env.HARNESS_SLACK_NATIVE_PROBE === '1'
  ? false : 'Slack native macOS ARM64 probe opt-in required';
const credential = { kind: 'chatgpt' as const, accessToken: 'synthetic.slack.test.only', accountId: 'synthetic-slack-account' };
const sse = (item: Record<string, unknown>): string => {
  const response = { id: 'resp_slack_synthetic', object: 'response', model: config.model, status: 'completed', output: [item],
    access_programs: { cyber: 'standard' } };
  return [{ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item },
    { type: 'response.completed', sequence_number: 2, response }]
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
};
const prepare = (context: TestContext) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-slack-native-'))), taskId = randomUUID();
  chmodSync(directory, 0o700);
  let cleanupConfirmed = false;
  context.after(() => { if (cleanupConfirmed) rmSync(directory, { recursive: true }); });
  const verifyCleanup = (dispatch: ReadonlyRelayDispatch) => {
    assert.equal(readonlyRelayCleanupConfirmed(directory, taskId, { requestBodyHash: dispatch.requestBodyHash,
      requestEnvelopeHash: dispatch.requestEnvelopeHash, connectionProfileHash: dispatch.requestEnvelope.connectionProfileHash }), true);
    const run = join(directory, 'readonly-relay-runs', taskId);
    const auditPath = join(run, 'call-report.json'), audit = JSON.parse(readFileSync(auditPath, 'utf8'));
    assert.equal(lstatSync(auditPath).mode & 0o777, 0o600);
    assert.equal(audit.cleanupConfirmed, true); assert.equal(audit.policy, SLACK_ANALYSIS_POLICY);
    assert.equal(audit.transport, 'fake'); assert.equal(audit.credentialAccess, 'not_run'); assert.equal(audit.upstreamCalls, 1);
    assert.equal(audit.binaryHash, binaryHash); assert.equal(audit.executionBudgetHash, getReadonlyRelayExecutionBudgetHash());
    const child = JSON.parse(readFileSync(join(run, 'child.json'), 'utf8'));
    assert.equal(child.state, 'closed');
    for (const pid of [child.guardianPid, child.childPid, -child.childPid]) {
      assert.ok(Number.isSafeInteger(pid) && Math.abs(pid) > 1);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
    assert.equal(existsSync(join(run, 'sandbox')), false);
    assert.doesNotMatch(JSON.stringify(audit), /synthetic\.slack\.test\.only|synthetic-slack-account/);
    cleanupConfirmed = true;
    return audit;
  };
  return { directory, taskId, verifyCleanup };
};

test('native Slack 0.167.2 completes one synthetic analysis without real credentials and closes its sandbox',
  { skip, timeout: 45000 }, async context => {
    const fixture = prepare(context), payload = buildSlackAnalysisPayload(request(), receiver, config);
    const expected = report(), text = JSON.stringify(expected);
    const raw = sse({ id: 'msg_slack_synthetic', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }] });
    let calls = 0; const order: string[] = [];
    const adapter = new RestrictedSlackAnalysisCodex(config, fixture.directory, fixture.taskId, { credential,
      transport: async (approved, authentication) => {
        calls++; order.push('transport'); assert.equal(approved.requestEnvelope.body, payload.dispatch.requestEnvelope.body);
        assert.deepEqual(authentication, credential); return new Response(Buffer.from(raw));
      } });
    await adapter.verifyReady(); assert.equal(calls, 0);
    const result = await adapter.transmit(payload.dispatch, context.signal, () => order.push('transmission'), () => order.push('credential'));
    assert.equal(calls, 1); assert.deepEqual(order, ['credential', 'transmission', 'transport']);
    assert.deepEqual(parseSlackAnalysisResponse(result.text, payload), expected);
    assert.equal(result.responseHash, hashReadonlyValue(raw)); assert.equal(result.finalTextHash, hashReadonlyValue(text));
    assert.equal(result.verification.transport, 'fake'); assert.equal(result.verification.credentialAccess, 'not_run');
    assert.equal(result.verification.isolation, 'passed'); assert.equal(result.verification.upstreamCalls, 1);
    assert.equal(fixture.verifyCleanup(payload.dispatch).failureCode, null);
  });

test('native Slack 0.167.2 rejects a synthetic tool request without execution, retransmission or residual child',
  { skip, timeout: 45000 }, async context => {
    const fixture = prepare(context), payload = buildSlackAnalysisPayload(request(), receiver, config);
    const marker = join(fixture.directory, 'forbidden-tool-marker');
    const raw = sse({ id: 'fc_slack_synthetic', type: 'function_call', status: 'completed', call_id: 'call_slack_synthetic',
      name: 'exec_command', arguments: JSON.stringify({ cmd: `/usr/bin/touch ${marker}` }) });
    let calls = 0;
    const adapter = new RestrictedSlackAnalysisCodex(config, fixture.directory, fixture.taskId, { credential,
      transport: async () => { calls++; return new Response(Buffer.from(raw)); } });
    await assert.rejects(adapter.transmit(payload.dispatch, context.signal, () => {}, () => {}), error => {
      assert.ok(error instanceof HarnessError); assert.match(error.code, /^READONLY_RELAY_[A-Z_]+$/u); return true;
    });
    assert.equal(calls, 1); assert.equal(existsSync(marker), false);
    assert.notEqual(fixture.verifyCleanup(payload.dispatch).failureCode, null);
  });
