import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { DEFAULT_READONLY_RANGES } from '../src/policy/readonly-investigation-policy.js';

const runNode = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
  const child = spawn(process.execPath, args, {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.once('error', reject); child.once('close', code => done({ code, stdout, stderr }));
});
const run = (args: string[]) => runNode([resolve('dist/src/cli/main.js'), ...args]);
const remove = (directory: string): void => {
  const unlock = (path: string): void => {
    if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); }
  };
  unlock(directory); rmSync(directory, { recursive: true, force: true });
};
const snapshot = (path: string): unknown => lstatSync(path).isDirectory()
  ? Object.fromEntries(readdirSync(path).sort().map(name => [name, snapshot(join(path, name))]))
  : { hash: createHash('sha256').update(readFileSync(path)).digest('hex'), mode: lstatSync(path).mode & 0o777 };
const policy = { version: 'company-readonly-policy-v1', enabled: false, readPermission: 'confirmed', storagePermission: 'confirmed',
  policyReference: 'synthetic-review', payloadRetentionHours: 1, auditRetentionDays: 1 };
const privateRoot = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'company-readonly-cli-'))); chmodSync(root, 0o700); return root;
};

test('company CLI prepares a private draft in a restricted worker and preserves the complete synthetic target', { timeout: 30000 }, async () => {
  const root = privateRoot();
  try {
    const target = join(root, 'target'); mkdirSync(target, { mode: 0o700 });
    const source = await prepareReadonlyRepository(target, randomUUID());
    const before = snapshot(source.sourceRoot);
    const registration = { version: 'company-readonly-registration-v1', repoId: 'company-test', sourceRoot: source.sourceRoot,
      baseCommit: source.baseCommit, question: 'Explain the selected synthetic service flow.', readRanges: DEFAULT_READONLY_RANGES,
      reviewPaths: ['src/service.ts'] };
    const policyFile = join(root, 'company-readonly-policy.json'), registrationFile = join(root, 'company-readonly-registration.json');
    writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
    writeFileSync(registrationFile, JSON.stringify(registration), { mode: 0o600 });
    const data = join(root, 'runtime');
    const args = ['company-readonly-plan', '--policy', policyFile, '--registration', registrationFile, '--data-dir', data];
    const prepared = await run(args); assert.equal(prepared.code, 0, prepared.stderr);
    const result = JSON.parse(prepared.stdout);
    assert.equal(result.status, 'AWAITING_APPROVAL'); assert.equal(result.reviewAvailable, true);
    for (const field of ['approvalCreated', 'transmissionAllowed', 'executionAllowed', 'companyPolicyVerified']) assert.equal(result[field], false);
    assert.equal(result.realModel, 'not_run');
    for (const value of [source.sourceRoot, registration.question, 'src/service.ts', policy.policyReference]) assert.equal(prepared.stdout.includes(value), false);
    assert.deepEqual(readdirSync(data), ['company-readonly.sqlite']);
    assert.equal(lstatSync(data).mode & 0o777, 0o700); assert.equal(lstatSync(join(data, 'company-readonly.sqlite')).mode & 0o777, 0o600);
    const repeat = await run(args); assert.equal(repeat.code, 0, repeat.stderr); assert.equal(JSON.parse(repeat.stdout).taskId, result.taskId);
    const inspected = await run(['company-readonly-inspect', '--task', result.taskId, '--data-dir', data]);
    assert.equal(inspected.code, 0, inspected.stderr); assert.deepEqual(JSON.parse(inspected.stdout), result);
    for (const command of ['company-readonly-approve', 'company-readonly-run']) {
      const rejected = await run([command, '--task', result.taskId, '--data-dir', data]);
      assert.equal(rejected.code, 1); assert.match(rejected.stderr, /UNKNOWN_COMMAND/);
    }
    const cancelled = await run(['company-readonly-cancel', '--task', result.taskId, '--data-dir', data]);
    assert.equal(cancelled.code, 0, cancelled.stderr); assert.equal(JSON.parse(cancelled.stdout).status, 'CANCELLED');
    assert.equal(JSON.parse(cancelled.stdout).reviewAvailable, false);
    const again = await run(args); assert.equal(again.code, 0, again.stderr); assert.equal(JSON.parse(again.stdout).status, 'CANCELLED');
    const pruned = await run(['company-readonly-prune', '--data-dir', data]); assert.equal(pruned.code, 0, pruned.stderr);
    assert.deepEqual(snapshot(source.sourceRoot), before);
  } finally { remove(root); }
});

test('company policy gate refuses registration access and runtime creation before local permissions are confirmed', async () => {
  const root = privateRoot();
  try {
    const policyFile = join(root, 'company-readonly-policy.json');
    for (const patch of [{ readPermission: 'unconfirmed' }, { storagePermission: 'unconfirmed' },
      { policyReference: null }, { payloadRetentionHours: null }, { auditRetentionDays: null }]) {
      writeFileSync(policyFile, JSON.stringify({ ...policy, ...patch }), { mode: 0o600 });
      const data = join(root, 'not-created');
      const result = await run(['company-readonly-plan', '--policy', policyFile, '--registration', '/unreadable/registration.json', '--data-dir', data]);
      assert.equal(result.code, 1); assert.match(result.stderr, /COMPANY_READONLY_POLICY_UNCONFIRMED/);
      assert.equal(result.stdout, ''); assert.equal(existsSync(data), false);
    }
  } finally { remove(root); }
});

test('company CLI rejects arbitrary commands, version mixing, duplicate JSON, public files, aliases and target overlap before writes', { timeout: 30000 }, async () => {
  const root = privateRoot();
  try {
    const target = join(root, 'target'); mkdirSync(target, { mode: 0o700 });
    const source = await prepareReadonlyRepository(target, randomUUID());
    const registration = { version: 'company-readonly-registration-v1', repoId: 'company-test', sourceRoot: source.sourceRoot,
      baseCommit: source.baseCommit, question: 'Explain the synthetic flow.', readRanges: DEFAULT_READONLY_RANGES, reviewPaths: ['src/service.ts'] };
    const policyFile = join(root, 'company-readonly-policy.json'), registrationFile = join(root, 'company-readonly-registration.json');
    writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 }); writeFileSync(registrationFile, JSON.stringify(registration), { mode: 0o600 });
    const alias = join(root, 'alias'); symlinkSync(source.sourceRoot, alias);
    for (const data of [join(source.sourceRoot, 'runtime'), join(alias, 'runtime')]) {
      const result = await run(['company-readonly-plan', '--policy', policyFile, '--registration', registrationFile, '--data-dir', data]);
      assert.equal(result.code, 1); assert.equal(existsSync(join(source.sourceRoot, 'runtime')), false);
    }
    rmSync(alias);
    const data = join(root, 'not-created');
    const args = ['company-readonly-plan', '--policy', policyFile, '--registration', registrationFile, '--data-dir', data];
    for (const extra of [['--config', '/unreadable'], ['--command', 'shell'], ['--url', 'https://example.invalid']]) {
      assert.equal((await run([...args, ...extra])).code, 1); assert.equal(existsSync(data), false);
    }
    for (const text of [JSON.stringify({ ...registration, version: 'personal-readonly-registration-v1' }),
      JSON.stringify(registration).replace('{', '{"version":"wrong",')]) {
      writeFileSync(registrationFile, text, { mode: 0o600 }); assert.equal((await run(args)).code, 1); assert.equal(existsSync(data), false);
    }
    writeFileSync(registrationFile, JSON.stringify(registration)); chmodSync(registrationFile, 0o644);
    assert.equal((await run(args)).code, 1); assert.equal(existsSync(data), false);
    chmodSync(registrationFile, 0o600);
    const inspect = await run(['company-readonly-inspect', '--task', randomUUID(), '--data-dir', data]);
    assert.equal(inspect.code, 1); assert.equal(existsSync(data), false);
  } finally { remove(root); }
});

test('company worker rejects direct forged harness paths, unsafe capabilities and execution commands before creating data', async () => {
  const root = privateRoot();
  try {
    const data = join(root, 'not-created');
    const base = { command: 'prune', sourceDirectory: realpathSync(process.cwd()), dataDirectory: data };
    const workerFile = resolve('dist/src/cli/company-readonly-worker.js');
    for (const options of [{ ...base, sourceDirectory: root }, { ...base, command: 'run' }, { ...base, approval: true }]) {
      const result = await runNode(['--permission', '--allow-fs-read=*', `--allow-fs-write=${data}`, workerFile, JSON.stringify(options)]);
      assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(existsSync(data), false);
    }
    const unsafe = await runNode([workerFile, JSON.stringify(base)]);
    assert.equal(unsafe.code, 1); assert.match(unsafe.stderr, /COMPANY_READONLY_UNSAFE_WORKER/); assert.equal(existsSync(data), false);
  } finally { remove(root); }
});
