import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import git from 'isomorphic-git';
import { PersonalReadonlyService } from '../src/application/investigate-personal-readonly.js';
import { SqlitePersonalReadonlyStore } from '../src/adapters/sqlite-personal-readonly-store.js';
import { RestrictedPersonalReadonlyCodex } from '../src/adapters/personal-readonly-codex.js';
import { readonlyRelayCleanupConfirmed } from '../src/adapters/readonly-relay-lifecycle.js';
import type { PersonalCollectionRegistration } from '../src/domain/personal-readonly-collection.js';
import type { ReadonlyRelayConfig } from '../src/domain/readonly-relay.js';
import { hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const sourceValue = 'synthetic-sensitive-value-for-derived-view-only';
const credential = { kind: 'chatgpt' as const, accessToken: 'synthetic.test.only', accountId: 'synthetic-account' };
const config: ReadonlyRelayConfig = { enabled: true, policyVersion: 'readonly-relay-codex-v2', codexPath: '/synthetic/codex',
  codexSha256: '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc',
  model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
const skip = process.platform === 'darwin' && process.env.HARNESS_NATIVE_CODEX_PROBE === '1' ? false : 'native macOS probe opt-in required';
const fixture = async (context: TestContext) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'personal-collection-adapter-'))); chmodSync(directory, 0o700);
  context.after(() => {
    const unlock = (path: string): void => { if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); } };
    unlock(directory); rmSync(directory, { recursive: true, force: true });
  });
  const source = join(directory, 'source'), runtime = join(directory, 'runtime'); mkdirSync(source, { mode: 0o700 }); mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(join(source, 'src'), { mode: 0o700 });
  const text = `export const submit = () => {\n  const accessToken = "${sourceValue}";\n  return true;\n};\n` + '// bounded synthetic padding only\n'.repeat(1050);
  assert.ok(Buffer.byteLength(text) > 32768 && Buffer.byteLength(text) < 65536);
  writeFileSync(join(source, 'src/service.ts'), text);
  await git.init({ fs, dir: source, defaultBranch: 'main' }); await git.add({ fs, dir: source, filepath: 'src/service.ts' });
  const commit = await git.commit({ fs, dir: source, message: 'synthetic collection fixture', author: { name: 'Synthetic', email: 'fixture@example.invalid', timestamp: 1700000000, timezoneOffset: 0 } });
  const registration: PersonalCollectionRegistration = { version: 'personal-readonly-registration-v2', collectionPolicy: 'personal-readonly-collection-v2',
    repoId: 'collection-test', sourceRoot: source, baseCommit: commit, question: 'Explain only the supplied derived evidence and identify redaction limits.',
    readRanges: [{ path: 'src/service.ts', startLine: 1, endLine: 4 }], transferPaths: ['src/service.ts'] };
  return { directory, source, runtime, registration };
};
const cli = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
  const child = spawn(process.execPath, [resolve('dist/src/cli/main.js'), ...args], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' } });
  let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += String(x); }); child.stderr.on('data', x => { stderr += String(x); }); child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
});

test('collection CLI persists only safe excerpts and explicit local limits while remaining unapproved', { timeout: 30000 }, async context => {
  const h = await fixture(context); const registrationPath = join(h.directory, 'registration.json'), configPath = join(h.directory, 'config.json');
  writeFileSync(registrationPath, JSON.stringify(h.registration), { mode: 0o600 }); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const plan = await cli(['personal-readonly-plan', '--registration', registrationPath, '--config', configPath, '--data-dir', h.runtime]);
  assert.equal(plan.code, 0, plan.stderr.split('\n')[0] ?? 'CLI failed'); const snapshot = JSON.parse(plan.stdout);
  assert.equal(snapshot.task.status, 'AWAITING_APPROVAL'); assert.equal(snapshot.task.plan.policy, 'personal-readonly-investigation-v2');
  assert.equal(snapshot.task.plan.limits.fileBytes, 32768); assert.equal(snapshot.task.plan.collectionProfile.limits.sourceFileBytes, 65536);
  assert.equal(snapshot.payload.sourceViews[0].rawSensitiveCheck, 'rejected'); assert.equal(snapshot.payload.sourceViews[0].viewSensitiveCheck, 'passed');
  assert.equal(snapshot.approvalPage.total, 0); assert.equal(snapshot.attempt, null);
  assert.equal(plan.stdout.includes(sourceValue), false); assert.equal(readFileSync(join(h.runtime, 'personal-readonly.sqlite')).includes(Buffer.from(sourceValue)), false);
  assert.equal(snapshot.payload.inputText.includes(h.source), false); assert.equal(snapshot.payload.context.evidence[0].fileHash, snapshot.payload.sourceViews[0].viewHash);
  const attempted = await cli(['personal-readonly-run', '--task', snapshot.task.investigationId, '--plan-hash', snapshot.task.plan.planHash, '--config', configPath, '--data-dir', h.runtime]);
  assert.equal(attempted.code, 1); assert.equal(attempted.stderr.split('\n')[0], 'PERSONAL_READONLY_APPROVAL_REQUIRED');
  assert.equal(existsSync(join(h.runtime, 'readonly-relay-runs')), false);
  const inspected = await cli(['personal-readonly-inspect', '--task', snapshot.task.investigationId, '--data-dir', h.runtime]);
  assert.equal(JSON.parse(inspected.stdout).approvalPage.total, 0); assert.equal(JSON.parse(inspected.stdout).attempt, null);
});

test('native collection adapter forwards only safe derived input and preserves v2 EOF, proof and cleanup boundaries', { skip, timeout: 60000 }, async context => {
  const h = await fixture(context); const selected = { ...config, codexPath: process.env.HARNESS_NATIVE_CODEX_PATH ?? '/opt/homebrew/Caskroom/codex/0.154.0/bin/codex' };
  const holder = { id: '' }; let calls = 0, text = '';
  const port = { mode: 'live' as const, transport: 'codex-cli-relay' as const,
    transmit: async (...args: Parameters<RestrictedPersonalReadonlyCodex['transmit']>) => new RestrictedPersonalReadonlyCodex(selected, h.runtime, holder.id,
      { credential, transport: async dispatch => {
        calls++; assert.equal(dispatch.requestEnvelope.body.includes(sourceValue), false); assert.equal(dispatch.requestEnvelope.body.includes(h.source), false);
        const input = JSON.parse(JSON.parse(dispatch.requestEnvelope.body).input[0].content[0].text); const evidence = input.evidence[0];
        assert.equal(input.inputPolicyVersion, 'personal-readonly-input-v2');
        text = JSON.stringify({ classification: 'question', summary: 'The supplied excerpt is a derived view.',
          facts: [{ text: 'The selected function returns true; redacted text remains unknown.', references: [{ evidenceId: evidence.evidenceId, startLine: 1, endLine: 4 }] }],
          hypotheses: [], answerDraft: 'Use only the supplied derived lines.', questions: [], suggestions: [], limitations: ['Synthetic upstream and masked evidence.'] });
        const item = { id: 'msg_collection_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        const response = { id: 'resp_collection_synthetic', object: 'response', model: config.model, status: 'completed', output: [item] };
        return new Response([{ type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item }, { type: 'response.completed', sequence_number: 2, response }]
          .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      } }).transmit(...args) };
  const store = new SqlitePersonalReadonlyStore(join(h.runtime, 'personal-readonly.sqlite'));
  try {
    const service = new PersonalReadonlyService(store, port, h.runtime, selected, (id, hashes) => readonlyRelayCleanupConfirmed(h.runtime, id, hashes));
    const now = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() }; const prepared = await service.plan(h.registration, now); holder.id = prepared.task.investigationId;
    const request = { investigationId: holder.id, planHash: prepared.task.plan.planHash }; service.approve({ ...request, expiresInMinutes: 5 }, now);
    const done = await service.run(request, now); assert.equal(done.task.status, 'REPORTED', done.task.failureCode ?? 'missing report'); assert.equal(calls, 1);
    assert.equal(done.report!.finalTextHash, hashReadonlyValue(text)); assert.equal(done.report!.checks.realModel, 'not_run');
    assert.ok('collection' in done.report!); assert.equal(done.report.collection.evidenceOrigin, 'line-preserving-derived-view');
    assert.equal(done.report.collection.profileHash, prepared.task.plan.policy === 'personal-readonly-investigation-v2' ? prepared.task.plan.collectionProfileHash : 'invalid');
    const run = join(h.runtime, 'readonly-relay-runs', holder.id), call = JSON.parse(readFileSync(join(run, 'call-report.json'), 'utf8'));
    assert.equal(call.policy, 'personal-readonly-investigation-v2'); assert.equal(call.reception.eof, true); assert.equal(call.cleanupConfirmed, true); assert.equal(call.failureCode, null);
    const child = JSON.parse(readFileSync(join(run, 'child.json'), 'utf8')); assert.equal(child.state, 'closed');
    for (const pid of [child.guardianPid, child.childPid, -child.childPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(join(run, 'sandbox')), false); await assert.rejects(service.run(request, now)); assert.equal(calls, 1);
  } finally { store.close(); }
});
