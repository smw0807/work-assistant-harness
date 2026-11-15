import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { DEFAULT_READONLY_RANGES } from '../src/policy/readonly-investigation-policy.js';
const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
  const child = spawn(process.execPath, [resolve('dist/src/cli/main.js'), ...args], { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' } });
  let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
});
const remove = (directory: string): void => {
  const unlock = (path: string): void => { if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); } };
  unlock(directory); rmSync(directory, { recursive: true, force: true });
};
test('personal CLI creates an isolated review plan, persists zero attempts and refuses unapproved run without authentication', { timeout: 30000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'personal-readonly-cli-'))); chmodSync(directory, 0o700);
  try {
    const target = join(directory, 'target'); mkdirSync(target, { mode: 0o700 });
    const source = await prepareReadonlyRepository(target, randomUUID());
    const registration = { version: 'personal-readonly-registration-v1', repoId: 'personal-test', sourceRoot: source.sourceRoot, baseCommit: source.baseCommit,
      question: 'Explain the selected service flow.', readRanges: DEFAULT_READONLY_RANGES, transferPaths: ['src/service.ts'] };
    const config = { enabled: true, policyVersion: 'readonly-relay-codex-v2', codexPath: '/synthetic/unavailable/codex', codexSha256: 'a'.repeat(64),
      model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
    const regFile = join(directory, 'registration.json'); const configFile = join(directory, 'config.json'); const data = join(directory, 'runtime');
    writeFileSync(regFile, JSON.stringify(registration), { mode: 0o600 }); writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    const prepared = await run(['personal-readonly-plan', '--registration', regFile, '--config', configFile, '--data-dir', data]); assert.equal(prepared.code, 0, prepared.stderr);
    const snapshot = JSON.parse(prepared.stdout); const id = snapshot.task.investigationId;
    assert.equal(snapshot.task.status, 'AWAITING_APPROVAL'); assert.equal(snapshot.approvalPage.total, 0); assert.equal(snapshot.attempt, null);
    assert.equal(JSON.stringify(snapshot.task.plan).includes(source.sourceRoot), false); assert.equal(snapshot.payload.requestEnvelope.body.includes(source.sourceRoot), false);
    assert.equal(existsSync(join(data, 'readonly-relay.sqlite')), false); assert.equal(lstatSync(join(data, 'personal-readonly.sqlite')).mode & 0o777, 0o600);
    const before = readFileSync(join(source.sourceRoot, '.git/index'));
    const attempted = await run(['personal-readonly-run', '--task', id, '--plan-hash', snapshot.task.plan.planHash, '--config', configFile, '--data-dir', data]);
    assert.equal(attempted.code, 1); assert.match(attempted.stderr, /PERSONAL_READONLY_APPROVAL_REQUIRED/);
    const inspection = await run(['personal-readonly-inspect', '--task', id, '--data-dir', data]); const inspected = JSON.parse(inspection.stdout);
    assert.equal(inspected.task.status, 'AWAITING_APPROVAL'); assert.equal(inspected.attempt, null); assert.equal(inspected.approvalPage.total, 0);
    assert.deepEqual(readFileSync(join(source.sourceRoot, '.git/index')), before); assert.equal(existsSync(join(data, 'readonly-relay-runs')), false);
    const overlap = await run(['personal-readonly-plan', '--registration', regFile, '--config', configFile, '--data-dir', join(source.sourceRoot, 'runtime')]);
    assert.equal(overlap.code, 1); assert.match(overlap.stderr, /PERSONAL_READONLY_UNSAFE_DATA_DIRECTORY/); assert.equal(existsSync(join(source.sourceRoot, 'runtime')), false);
    const alias = join(directory, 'target-alias'); symlinkSync(source.sourceRoot, alias, 'dir');
    const aliased = await run(['personal-readonly-plan', '--registration', regFile, '--config', configFile, '--data-dir', join(alias, 'aliased-runtime')]);
    assert.equal(aliased.code, 1); assert.match(aliased.stderr, /PERSONAL_READONLY_UNSAFE_DATA_DIRECTORY/);
    assert.equal(existsSync(join(source.sourceRoot, 'aliased-runtime')), false); rmSync(alias);
    const sourceAlias = join(directory, 'source-alias'); symlinkSync(source.sourceRoot, sourceAlias, 'dir');
    writeFileSync(regFile, JSON.stringify({ ...registration, sourceRoot: sourceAlias }), { mode: 0o600 });
    const aliasedSource = await run(['personal-readonly-plan', '--registration', regFile, '--config', configFile, '--data-dir', join(directory, 'source-alias-runtime')]);
    assert.equal(aliasedSource.code, 1); assert.match(aliasedSource.stderr, /PERSONAL_READONLY_UNSAFE_DATA_DIRECTORY/);
    assert.equal(existsSync(join(directory, 'source-alias-runtime')), false); rmSync(sourceAlias);
    writeFileSync(regFile, JSON.stringify(registration), { mode: 0o600 });
    chmodSync(regFile, 0o644);
    const unsafe = await run(['personal-readonly-plan', '--registration', regFile, '--config', configFile, '--data-dir', join(directory, 'unsafe')]);
    assert.equal(unsafe.code, 1); assert.match(unsafe.stderr, /PERSONAL_READONLY_INVALID_PRIVATE_FILE/); assert.equal(existsSync(join(directory, 'unsafe')), false);
  } finally { remove(directory); }
});
test('personal CLI rejects arbitrary transport, shell and approval options before creating local state', async () => {
  const directory = join(tmpdir(), `personal-readonly-rejected-${randomUUID()}`);
  for (const args of [[], ['--registration', '/unreadable', '--config', '/unreadable', '--url', 'https://other.invalid'],
    ['--registration', '/unreadable', '--config', '/unreadable', '--command', 'shell']]) {
    const result = await run(['personal-readonly-plan', ...args, '--data-dir', directory]); assert.equal(result.code, 1); assert.match(result.stderr, /INVALID_ARGUMENTS/);
    assert.equal(existsSync(directory), false);
  }
});
