import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CompanyChangeDraft } from '../src/domain/company-change.js';
import type { CompanyWriteRegistration } from '../src/domain/company-write.js';
import { createSyntheticCompanyChangeWorkspace, SYNTHETIC_COMPANY_CHANGE_FILES } from '../src/adapters/synthetic-company-change-workspace.js';
import { acquireCompanyApplyControl, prepareCompanyApplyRuntime, readCompanyApplyPrivateJson } from '../src/cli/company-apply-files.js';
import { companyApplyUsage, runCompanyApplyCommand } from '../src/cli/company-apply.js';
import { hashCompanyWriteValue } from '../src/policy/company-write.js';

const privateRoot = () => { const path = fs.mkdtempSync('/private/tmp/harness-company-apply-cli-'); fs.chmodSync(path, 0o700); return path; };
const writeJson = (path: string, value: unknown): void => fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const cli = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((resolveResult, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli/main.js', import.meta.url)), ...args], {
    cwd: resolve(fileURLToPath(new URL('..', import.meta.url)), '..'),
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); resolveResult({ code, stdout, stderr }); });
});
const fixture = async (packed = false) => {
  const parent = privateRoot(), sourceParent = join(parent, 'source'), inputs = join(parent, 'inputs'), runtime = join(parent, 'runtime');
  fs.mkdirSync(sourceParent, { mode: 0o700 }); fs.mkdirSync(inputs, { mode: 0o700 });
  const synthetic = await createSyntheticCompanyChangeWorkspace(sourceParent), root = synthetic.repositoryRoot;
  const draft: CompanyChangeDraft = { version: 'company-change-draft-v1', repoId: 'company-cli-fixture', requestRevision: 1,
    objective: 'Apply exactly the supplied synthetic files', baseBranch: 'main', baseCommit: synthetic.baseCommit,
    baseIndexHash: synthetic.baseIndexHash, workType: 'feature', branch: 'feature/company-cli-fixture', changes: [
      { operation: 'replace', path: 'src/message.ts', beforeHash: hashCompanyWriteValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']!),
        content: "export const message = 'CLI_PROPOSAL_SYNTHETIC';\n" },
      { operation: 'create', path: 'src/created.ts', beforeHash: null, content: 'export const created = true;\n' },
    ] };
  const registration: CompanyWriteRegistration = { version: 'company-write-registration-v1', repoId: draft.repoId, sourceRoot: root,
    baseBranch: draft.baseBranch, baseCommit: draft.baseCommit, baseIndexHash: draft.baseIndexHash,
    writeAllowedFiles: draft.changes.map(change => change.path), enabled: true, localRead: 'allowed', localWrite: 'allowed' };
  if (packed) {
    fs.writeFileSync(join(root, '.git/packed-refs'), `# pack-refs with: peeled fully-peeled sorted \n${draft.baseCommit} refs/heads/main\n`, { mode: 0o600 });
    fs.unlinkSync(join(root, '.git/refs/heads/main'));
  }
  const registrationPath = join(inputs, 'registration.json'), draftPath = join(inputs, 'draft.json');
  writeJson(registrationPath, registration); writeJson(draftPath, draft);
  const inputArgs = ['--registration', registrationPath, '--draft', draftPath, '--data-dir', runtime];
  return { parent, root, runtime, registration, draft, registrationPath, draftPath, inputArgs,
    close: () => fs.rmSync(parent, { recursive: true, force: true }) };
};
const planned = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const result = await cli(['company-apply-plan', ...f.inputArgs]); assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout) as { taskId: string; planHash: string; status: string; approvalConsumed: boolean; changeCount: number };
  assert.equal(plan.status, 'AWAITING_APPROVAL'); assert.equal(plan.approvalConsumed, false); assert.equal(plan.changeCount, 2);
  return { ...plan, requestArgs: ['--task', plan.taskId, '--plan-hash', plan.planHash] };
};

test('company apply command options are exact and never imply approval, recovery, shell or remote authority', async () => {
  for (const args of [[], ['company-apply-recover', '--task', '11111111-1111-4111-8111-111111111111', '--data-dir', '/private/tmp/absent'],
    ['company-apply-run', '--data-dir', '/private/tmp/absent'], ['company-apply-plan', '--shell', 'true'],
    ['company-apply-inspect', '--task', '../escape', '--data-dir', '/private/tmp/absent'],
    ['company-apply-cancel', '--task', '11111111-1111-4111-8111-111111111111', '--data-dir', '/private/tmp/a', '--data-dir', '/private/tmp/b']]) {
    await assert.rejects(runCompanyApplyCommand(args), { code: 'COMPANY_APPLY_INVALID_ARGUMENTS' });
  }
  for (const command of ['plan', 'approve', 'run', 'inspect', 'cancel']) assert.ok(companyApplyUsage.includes(`company-apply-${command}`));
  assert.equal(companyApplyUsage.includes('recover'), false);
});

test('private JSON rejects duplicate decoded keys, invalid UTF8, excess bytes and unsafe modes or links', async () => {
  for (const kind of ['duplicate', 'utf8', 'oversize', 'mode', 'parent-mode', 'symlink', 'hardlink'] as const) {
    const root = privateRoot(), file = join(root, 'registration.json'), target = join(root, 'target.json');
    try {
      fs.writeFileSync(file, kind === 'duplicate' ? '{"value":1,"\\u0076alue":2}' : '{}', { mode: 0o600 });
      if (kind === 'utf8') fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
      if (kind === 'oversize') fs.writeFileSync(file, 'x'.repeat(16_385));
      if (kind === 'mode') fs.chmodSync(file, 0o644);
      if (kind === 'parent-mode') fs.chmodSync(root, 0o755);
      if (kind === 'symlink' || kind === 'hardlink') {
        fs.renameSync(file, target); if (kind === 'symlink') fs.symlinkSync(target, file); else fs.linkSync(target, file);
      }
      await assert.rejects(readCompanyApplyPrivateJson(file, 'registration'), { code: 'COMPANY_APPLY_INVALID_PRIVATE_FILE' });
      if (kind === 'symlink' || kind === 'hardlink') assert.equal(fs.readFileSync(target, 'utf8'), '{}');
    } finally { fs.chmodSync(root, 0o700); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('private input bounds are separate and its retained guard detects file or parent replacement', async () => {
  const root = privateRoot(), file = join(root, 'input.json');
  try {
    for (const [kind, maximum] of [['registration', 16_384], ['draft', 262_144]] as const) {
      fs.writeFileSync(file, JSON.stringify('x'.repeat(maximum - 2)), { mode: 0o600 });
      const input = await readCompanyApplyPrivateJson(file, kind); assert.equal((input.value as string).length, maximum - 2);
      await input.guard(); fs.appendFileSync(file, ' '); await assert.rejects(input.guard());
      await assert.rejects(readCompanyApplyPrivateJson(file, kind), { code: 'COMPANY_APPLY_INVALID_PRIVATE_FILE' });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runtime initialization is plan-only and never repairs foreign entries, modes or a missing prior runtime', async () => {
  const root = privateRoot(), runtime = join(root, 'runtime');
  try {
    await assert.rejects(prepareCompanyApplyRuntime(runtime, false), { code: 'COMPANY_APPLY_UNSAFE_RUNTIME' });
    assert.equal(fs.existsSync(runtime), false);
    fs.mkdirSync(runtime, { mode: 0o700 }); fs.writeFileSync(join(runtime, 'foreign'), 'PRESERVED', { mode: 0o600 });
    await assert.rejects(prepareCompanyApplyRuntime(runtime, true), { code: 'COMPANY_APPLY_UNSAFE_RUNTIME' });
    assert.equal(fs.readFileSync(join(runtime, 'foreign'), 'utf8'), 'PRESERVED'); assert.equal(fs.existsSync(join(runtime, 'tasks')), false);
    fs.unlinkSync(join(runtime, 'foreign')); fs.chmodSync(runtime, 0o755);
    await assert.rejects(prepareCompanyApplyRuntime(runtime, true), { code: 'COMPANY_APPLY_UNSAFE_RUNTIME' });
    assert.equal(fs.statSync(runtime).mode & 0o777, 0o755);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the new control schema is private, location-bound and denies concurrent holders without touching a foreign database', async () => {
  const root = privateRoot(), runtime = join(root, 'runtime'), other = join(root, 'other');
  try {
    await prepareCompanyApplyRuntime(runtime, true); await prepareCompanyApplyRuntime(other, true);
    const release = acquireCompanyApplyControl(runtime, true);
    try { assert.throws(() => acquireCompanyApplyControl(runtime), { code: 'COMPANY_APPLY_CONTROL_BUSY' }); }
    finally { release(); }
    const file = join(runtime, 'company-apply-control.sqlite'); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const db = new DatabaseSync(file, { readOnly: true });
    try { assert.equal(db.prepare('PRAGMA application_id').get()!.application_id, 0x43415034); } finally { db.close(); }
    fs.copyFileSync(file, join(other, 'company-apply-control.sqlite'));
    const before = fs.readFileSync(join(other, 'company-apply-control.sqlite'));
    assert.throws(() => acquireCompanyApplyControl(other), { code: 'COMPANY_APPLY_INVALID_CONTROL' });
    assert.deepEqual(fs.readFileSync(join(other, 'company-apply-control.sqlite')), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('foreign control schemas and owner tampering fail during readonly preflight without changing stored bytes', async () => {
  for (const kind of ['foreign', 'owner'] as const) {
    const root = privateRoot(), runtime = join(root, 'runtime'), file = join(runtime, 'company-apply-control.sqlite');
    try {
      await prepareCompanyApplyRuntime(runtime, true);
      if (kind === 'foreign') {
        const db = new DatabaseSync(file); db.exec('CREATE TABLE unrelated (value TEXT)'); db.close(); fs.chmodSync(file, 0o600);
      } else {
        acquireCompanyApplyControl(runtime, true)(); const db = new DatabaseSync(file);
        try { db.prepare('UPDATE company_apply_control SET owner_id = ?').run('os-user:999999999'); } finally { db.close(); }
      }
      const before = fs.readFileSync(file), inode = fs.statSync(file).ino;
      assert.throws(() => acquireCompanyApplyControl(runtime), { code: 'COMPANY_APPLY_INVALID_CONTROL' });
      assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.statSync(file).ino, inode);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('CLI separates plan, approval and isolated one-use execution while preserving packed refs and unselected edits',
  { skip: process.platform !== 'darwin', timeout: 40_000 }, async () => {
    const f = await fixture(true);
    try {
      const selected = join(f.root, 'src/message.ts'), original = fs.readFileSync(selected), index = fs.readFileSync(join(f.root, '.git/index'));
      const packed = fs.readFileSync(join(f.root, '.git/packed-refs')); fs.writeFileSync(join(f.root, 'README.md'), 'PRESERVE_EXISTING_UNSELECTED_WORK\n');
      const task = await planned(f); assert.deepEqual(fs.readFileSync(selected), original);
      const denied = await cli(['company-apply-run', ...task.requestArgs, ...f.inputArgs]); assert.equal(denied.code, 1);
      assert.deepEqual(fs.readFileSync(selected), original);
      const approval = await cli(['company-apply-approve', ...task.requestArgs, '--expires-in-minutes', '5', ...f.inputArgs]);
      assert.equal(approval.code, 0, approval.stderr); assert.equal(JSON.parse(approval.stdout).status, 'APPROVED');
      assert.deepEqual(fs.readFileSync(selected), original);
      const run = await cli(['company-apply-run', ...task.requestArgs, ...f.inputArgs]); assert.equal(run.code, 0, run.stderr + run.stdout);
      const result = JSON.parse(run.stdout); assert.equal(result.status, 'APPLIED'); assert.equal(result.approvalConsumed, true);
      assert.equal(result.checks, 'not_run'); assert.equal(result.transmissionAllowed, false);
      assert.equal(fs.readFileSync(selected, 'utf8'), f.draft.changes[0]!.content);
      assert.deepEqual(fs.readFileSync(join(f.root, '.git/index')), index); assert.deepEqual(fs.readFileSync(join(f.root, '.git/packed-refs')), packed);
      assert.equal(fs.readFileSync(join(f.root, 'README.md'), 'utf8'), 'PRESERVE_EXISTING_UNSELECTED_WORK\n');
      assert.equal(fs.readFileSync(join(f.root, '.git/HEAD'), 'utf8'), `ref: refs/heads/${f.draft.branch}\n`);
      const repeated = await cli(['company-apply-run', ...task.requestArgs, ...f.inputArgs]); assert.equal(repeated.code, 1);
      fs.unlinkSync(f.registrationPath); fs.unlinkSync(f.draftPath);
      const inspect = await cli(['company-apply-inspect', '--task', task.taskId, '--data-dir', f.runtime]);
      assert.equal(inspect.code, 0, inspect.stderr); assert.equal(JSON.parse(inspect.stdout).status, 'APPLIED');
      for (const output of [approval.stdout, run.stdout, inspect.stdout]) {
        assert.equal(output.includes(f.root), false); assert.equal(output.includes('CLI_PROPOSAL_SYNTHETIC'), false);
        assert.equal(output.includes('src/message.ts'), false);
      }
    } finally { f.close(); }
  });

test('inspect and cancellation need no registration, draft or source and cancelled work never acquires an approval', async () => {
  const f = await fixture();
  try {
    const task = await planned(f); fs.unlinkSync(f.registrationPath); fs.unlinkSync(f.draftPath);
    fs.renameSync(f.root, f.root + '-unavailable');
    const inspect = await cli(['company-apply-inspect', '--task', task.taskId, '--data-dir', f.runtime]);
    assert.equal(inspect.code, 0, inspect.stderr); assert.equal(JSON.parse(inspect.stdout).status, 'AWAITING_APPROVAL');
    const cancel = await cli(['company-apply-cancel', '--task', task.taskId, '--data-dir', f.runtime]);
    assert.equal(cancel.code, 0, cancel.stderr); assert.equal(JSON.parse(cancel.stdout).status, 'CANCELLED');
    const again = await cli(['company-apply-cancel', '--task', task.taskId, '--data-dir', f.runtime]);
    assert.equal(again.code, 0, again.stderr); assert.equal(JSON.parse(again.stdout).approvalConsumed, false);
    assert.equal(fs.existsSync(join(f.runtime, 'tasks', task.taskId, 'approval.json')), false);
  } finally { f.close(); }
});

test('changed source or supplied proposal and wrong plan hashes fail before approval or source writes', async () => {
  for (const kind of ['source', 'draft', 'hash'] as const) {
    const f = await fixture();
    try {
      const task = await planned(f), selected = join(f.root, 'src/message.ts');
      if (kind === 'source') fs.writeFileSync(selected, 'NEW_LOCAL_EDIT_MUST_SURVIVE\n');
      if (kind === 'draft') { f.draft.changes[0]!.content += '// changed proposal\n'; writeJson(f.draftPath, f.draft); }
      const before = fs.readFileSync(selected), requestArgs = kind === 'hash' ? ['--task', task.taskId, '--plan-hash', '0'.repeat(64)] : task.requestArgs;
      const result = await cli(['company-apply-approve', ...requestArgs, '--expires-in-minutes', '5', ...f.inputArgs]);
      assert.equal(result.code, 1); assert.match(result.stderr.split('\n')[0]!, /^COMPANY_APPLY_[A-Z_]+$/u);
      assert.deepEqual(fs.readFileSync(selected), before); assert.equal(fs.existsSync(join(f.runtime, 'tasks', task.taskId, 'approval.json')), false);
    } finally { f.close(); }
  }
});

test('a live runtime lease rejects CLI state access and releases on actual process death without lock stealing', async () => {
  const f = await fixture(); let child: ReturnType<typeof spawn> | null = null, exited: Promise<unknown> | null = null;
  try {
    const task = await planned(f), module = new URL('../src/cli/company-apply-files.js', import.meta.url).href;
    const script = `import {acquireCompanyApplyControl as acquire} from ${JSON.stringify(module)};
const release=acquire(process.argv[1]);process.on('SIGTERM',()=>{release();process.exit(0)});process.stdout.write('READY\\n');setInterval(()=>{},1000);`;
    child = spawn(process.execPath, ['--input-type=module', '-e', script, f.runtime], { env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise(resolveResult => child!.once('close', resolveResult));
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Control child not ready')), 3000);
      child!.stdout!.once('data', chunk => { clearTimeout(timer); assert.equal(String(chunk), 'READY\n'); resolveReady(); });
      child!.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const busy = await cli(['company-apply-inspect', '--task', task.taskId, '--data-dir', f.runtime]);
    assert.equal(busy.code, 1); assert.match(busy.stderr, /^COMPANY_APPLY_CONTROL_BUSY\n/u);
    child.kill('SIGKILL'); await exited;
    const result = await cli(['company-apply-inspect', '--task', task.taskId, '--data-dir', f.runtime]);
    assert.equal(result.code, 0, result.stderr);
  } finally { child?.kill('SIGKILL'); if (exited) await exited; f.close(); }
});

test('CLI rejects source/input/runtime overlap before creating state and exposes only fixed errors', async () => {
  const f = await fixture();
  try {
    const nested = join(f.root, 'new-runtime');
    const result = await cli(['company-apply-plan', '--registration', f.registrationPath, '--draft', f.draftPath, '--data-dir', nested]);
    assert.equal(result.code, 1); assert.match(result.stderr, /^COMPANY_APPLY_UNSAFE_PATH\n/u);
    assert.equal(fs.existsSync(nested), false); assert.equal(result.stderr.includes(f.root), false);
    const missing = await cli(['company-apply-inspect', '--task', '11111111-1111-4111-8111-111111111111', '--data-dir', f.runtime]);
    assert.equal(missing.code, 1); assert.equal(fs.existsSync(f.runtime), false);
  } finally { f.close(); }
});

test('copying an unused task to another valid runtime cannot inspect, approve or run the original authorization', async () => {
  const f = await fixture();
  try {
    const task = await planned(f), other = join(f.parent, 'other-runtime'), originalTask = join(f.runtime, 'tasks', task.taskId);
    await prepareCompanyApplyRuntime(other, true); acquireCompanyApplyControl(other, true)();
    const copiedTask = join(other, 'tasks', task.taskId);
    fs.cpSync(originalTask, copiedTask, { recursive: true, force: false, errorOnExist: true });
    const sourceBefore = fs.readFileSync(join(f.root, 'src/message.ts'));
    const planBefore = fs.readFileSync(join(originalTask, 'plan.json')), bindingBefore = fs.readFileSync(join(originalTask, 'binding.json'));
    const inputs = f.inputArgs.map(value => value === f.runtime ? other : value);
    for (const args of [
      ['company-apply-inspect', '--task', task.taskId, '--data-dir', other],
      ['company-apply-approve', ...task.requestArgs, '--expires-in-minutes', '5', ...inputs],
      ['company-apply-run', ...task.requestArgs, ...inputs],
    ]) {
      const result = await cli(args); assert.equal(result.code, 1); assert.match(result.stderr, /^COMPANY_APPLY_STORAGE_CHANGED\n/u);
    }
    assert.deepEqual(fs.readFileSync(join(f.root, 'src/message.ts')), sourceBefore);
    assert.deepEqual(fs.readFileSync(join(originalTask, 'plan.json')), planBefore);
    assert.deepEqual(fs.readFileSync(join(originalTask, 'binding.json')), bindingBefore);
    assert.equal(fs.existsSync(join(originalTask, 'approval.json')), false);
    assert.equal(fs.existsSync(join(copiedTask, 'approval.json')), false);
    assert.deepEqual(fs.readdirSync(join(copiedTask, 'execution')), []);
    const original = await cli(['company-apply-inspect', '--task', task.taskId, '--data-dir', f.runtime]);
    assert.equal(original.code, 0, original.stderr); assert.equal(JSON.parse(original.stdout).status, 'AWAITING_APPROVAL');
  } finally { f.close(); }
});
