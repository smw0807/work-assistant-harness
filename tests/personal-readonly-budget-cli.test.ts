import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { DEFAULT_READONLY_RANGES } from '../src/policy/readonly-investigation-policy.js';

const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
  const child = spawn(process.execPath, [resolve('dist/src/cli/main.js'), ...args], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
});
const remove = (directory: string): void => {
  const unlock = (path: string): void => { if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); } };
  unlock(directory); rmSync(directory, { recursive: true, force: true });
};

test('budget-v3 uses the existing CLI commands and remains approval-free without native or model access', { timeout: 30000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'personal-budget-cli-'))); chmodSync(directory, 0o700);
  try {
    const target = join(directory, 'target'); mkdirSync(target, { mode: 0o700 });
    const source = await prepareReadonlyRepository(target, randomUUID());
    const registration = { version: 'personal-readonly-registration-v3', collectionPolicy: 'personal-readonly-collection-v2',
      executionBudgetPolicy: 'readonly-relay-execution-budget-v1', repoId: 'personal-test', sourceRoot: source.sourceRoot, baseCommit: source.baseCommit,
      question: 'Explain the visible selected calls.', readRanges: DEFAULT_READONLY_RANGES, transferPaths: ['src/service.ts'] };
    const config = { enabled: true, policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/unavailable/codex', codexSha256: 'a'.repeat(64),
      model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 };
    const registrationFile = join(directory, 'registration.json'), configFile = join(directory, 'config.json'), data = join(directory, 'runtime');
    writeFileSync(registrationFile, JSON.stringify(registration), { mode: 0o600 }); writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    const prepared = await run(['personal-readonly-plan', '--registration', registrationFile, '--config', configFile, '--data-dir', data]);
    assert.equal(prepared.code, 0, prepared.stderr); const snapshot = JSON.parse(prepared.stdout), plan = snapshot.task.plan;
    assert.equal(plan.policy, 'personal-readonly-investigation-v3'); assert.equal(plan.executionBudget.workTimeoutMs, 120000); assert.equal(plan.executionBudget.frames, 8192);
    assert.equal(snapshot.task.status, 'AWAITING_APPROVAL'); assert.equal(snapshot.approvalPage.total, 0); assert.equal(snapshot.attempt, null);
    assert.equal(plan.limits.fileBytes, 32768); assert.equal(plan.collectionProfile.limits.sourceFileBytes, 65536);
    assert.equal(JSON.stringify(plan).includes(source.sourceRoot), false); assert.equal(snapshot.payload.requestBody.includes(source.sourceRoot), false);
    const before = readFileSync(join(source.sourceRoot, '.git/index'));
    const attempted = await run(['personal-readonly-run', '--task', plan.id, '--plan-hash', plan.planHash, '--config', configFile, '--data-dir', data]);
    assert.equal(attempted.code, 1); assert.match(attempted.stderr, /PERSONAL_READONLY_APPROVAL_REQUIRED/);
    const inspected = await run(['personal-readonly-inspect', '--task', plan.id, '--data-dir', data]); assert.equal(inspected.code, 0, inspected.stderr);
    const current = JSON.parse(inspected.stdout); assert.equal(current.task.status, 'AWAITING_APPROVAL'); assert.equal(current.approvalPage.total, 0); assert.equal(current.attempt, null);
    assert.deepEqual(readFileSync(join(source.sourceRoot, '.git/index')), before); assert.equal(existsSync(join(data, 'readonly-relay-runs')), false);
    writeFileSync(configFile, JSON.stringify({ ...config, policyVersion: 'readonly-relay-codex-v2', timeoutMs: 60000 }));
    const mixedData = join(directory, 'mixed-runtime');
    const mixed = await run(['personal-readonly-plan', '--registration', registrationFile, '--config', configFile, '--data-dir', mixedData]);
    assert.equal(mixed.code, 1); assert.match(mixed.stderr, /PERSONAL_READONLY_INVALID_CONFIG/); assert.equal(existsSync(join(mixedData, 'personal-readonly.sqlite')), false);
  } finally { remove(directory); }
});
