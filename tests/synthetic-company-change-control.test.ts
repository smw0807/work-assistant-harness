import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { acquireSyntheticCompanyChangeControl } from '../src/adapters/synthetic-company-change-control.js';
import { SqliteSyntheticCompanyChangeStore } from '../src/adapters/sqlite-synthetic-company-change-store.js';
import { HarnessError } from '../src/domain/errors.js';
import { createSyntheticCompanyChangePlan, hashSyntheticCompanyChangeValue } from '../src/policy/synthetic-company-change.js';
import { createCompanyChangeDraft } from './company-change-fixture.js';

const setup = () => {
  const runtime = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'synthetic-company-change-control-'))); fs.chmodSync(runtime, 0o700);
  const control = join(runtime, 'control'); fs.mkdirSync(control, { mode: 0o700 });
  return { runtime, control, file: join(control, 'synthetic-company-change-control.sqlite'), close: () => fs.rmSync(runtime, { recursive: true, force: true }) };
};
const preserved = (path: string) => {
  const metadata = fs.lstatSync(path, { bigint: true });
  return { ino: metadata.ino, dev: metadata.dev, mode: metadata.mode, links: metadata.nlink,
    hash: hashSyntheticCompanyChangeValue(fs.readFileSync(path)) };
};
const controlModule = new URL('../src/adapters/synthetic-company-change-control.js', import.meta.url).href;
const storeModule = new URL('../src/adapters/sqlite-synthetic-company-change-store.js', import.meta.url).href;
const startedChild = async (runtime: string, extra = ''): Promise<{ child: ChildProcessWithoutNullStreams; exited: Promise<void> }> => {
  const program = `import {acquireSyntheticCompanyChangeControl} from ${JSON.stringify(controlModule)};
import {SqliteSyntheticCompanyChangeStore} from ${JSON.stringify(storeModule)};
const release=acquireSyntheticCompanyChangeControl(process.argv[1]);
process.once('SIGTERM',()=>{release();process.exit(0);});
${extra}
setInterval(()=>{},1000);
setImmediate(()=>{globalThis.gc();setImmediate(()=>{globalThis.gc();process.stdout.write('READY\\n');});});`;
  // The controller owns its release handle until shutdown, including across GC while other stores allocate.
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', program, runtime], {
    env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  const exited = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '', errors = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic control child did not become ready')); }, 10_000);
      const failure = (error: Error): void => { clearTimeout(timer); reject(error); };
      child.once('error', failure);
      child.stderr.on('data', chunk => { errors += String(chunk); });
      child.stdout.on('data', chunk => { output += String(chunk); if (output === 'READY\n') { clearTimeout(timer); resolve(); } });
      child.once('close', code => { if (output !== 'READY\n') failure(new Error(`Synthetic child closed (${code}): ${errors}`)); });
    });
    return { child, exited };
  } catch (error) { child.kill('SIGKILL'); await exited; throw error; }
};

test('control initialization is explicit, private, body-free and location/owner bound', () => {
  const h = setup();
  try {
    assert.throws(() => acquireSyntheticCompanyChangeControl(h.runtime), { code: 'SYNTHETIC_COMPANY_CHANGE_CONTROL_NOT_INITIALIZED' });
    assert.equal(fs.existsSync(h.file), false);
    const release = acquireSyntheticCompanyChangeControl(h.runtime, true);
    assert.equal(fs.lstatSync(h.file).mode & 0o7777, 0o600); assert.equal(fs.lstatSync(h.control).mode & 0o7777, 0o700);
    release(); release();
    const db = new DatabaseSync(h.file, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA application_id').get()!.application_id, 0x53434332);
      assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
      assert.equal(db.prepare('PRAGMA synchronous').get()!.synchronous, 2);
      assert.deepEqual(db.prepare('PRAGMA table_info(synthetic_company_change_control)').all().map(row => row.name),
        ['singleton', 'location_hash', 'owner_id', 'binding_hash']);
      const row = db.prepare('SELECT * FROM synthetic_company_change_control').get()!;
      assert.equal(row.owner_id, `os-user:${process.getuid!()}`); assert.equal(row.location_hash, hashSyntheticCompanyChangeValue(h.file));
    } finally { db.close(); }
    const before = preserved(h.file); acquireSyntheticCompanyChangeControl(h.runtime)(); assert.deepEqual(preserved(h.file), before);
  } finally { h.close(); }
});

test('control refuses a simultaneous live holder and releases normally without deleting or replacing its database', () => {
  const h = setup();
  try {
    const release = acquireSyntheticCompanyChangeControl(h.runtime, true), before = preserved(h.file);
    assert.throws(() => acquireSyntheticCompanyChangeControl(h.runtime), { code: 'SYNTHETIC_COMPANY_CHANGE_CONTROL_BUSY' });
    assert.deepEqual(preserved(h.file), before); release(); acquireSyntheticCompanyChangeControl(h.runtime)();
    assert.deepEqual(preserved(h.file), before);
  } finally { h.close(); }
});

test('control blocks another process while held and becomes available after SIGKILL without PID guessing or lock theft', async () => {
  const h = setup(); let child: Awaited<ReturnType<typeof startedChild>> | undefined;
  try {
    acquireSyntheticCompanyChangeControl(h.runtime, true)(); const before = preserved(h.file);
    child = await startedChild(h.runtime);
    assert.throws(() => acquireSyntheticCompanyChangeControl(h.runtime), { code: 'SYNTHETIC_COMPANY_CHANGE_CONTROL_BUSY' });
    assert.deepEqual(preserved(h.file), before); child.child.kill('SIGKILL'); await child.exited;
    acquireSyntheticCompanyChangeControl(h.runtime)(); assert.deepEqual(preserved(h.file), before);
    assert.deepEqual(fs.readdirSync(h.control), ['synthetic-company-change-control.sqlite']);
  } finally { if (child) { child.child.kill('SIGKILL'); await child.exited; } h.close(); }
});

test('a live applying controller excludes recovery; process-death recovery keeps its exact used approval and journal', async () => {
  const h = setup(); let child: Awaited<ReturnType<typeof startedChild>> | undefined;
  try {
    acquireSyntheticCompanyChangeControl(h.runtime, true)();
    fs.mkdirSync(join(h.runtime, 'store'), { mode: 0o700 }); const file = join(h.runtime, 'store', 'synthetic-company-change.sqlite');
    const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date('2026-11-20T00:00:00.000Z') };
    const draft = { ...createCompanyChangeDraft(), repoId: 'synthetic-company-change' };
    const { plan } = createSyntheticCompanyChangePlan(draft, { repositoryId: 'synthetic-company-change', rootHash: '3'.repeat(64),
      baseCommit: draft.baseCommit, baseBranch: draft.baseBranch, indexHash: draft.baseIndexHash, sourceHash: '4'.repeat(64) }, context);
    const request = { taskId: plan.id, planHash: plan.planHash }, store = new SqliteSyntheticCompanyChangeStore(file);
    try { store.create(plan, context); store.approve({ ...request, expiresInMinutes: 1 }, context); } finally { store.close(); }
    child = await startedChild(h.runtime, `const store=new SqliteSyntheticCompanyChangeStore(${JSON.stringify(file)});
const context={ownerId:${JSON.stringify(context.ownerId)},now:new Date(${JSON.stringify(context.now.toISOString())})};
store.claim(${JSON.stringify(request)},context);store.record(${JSON.stringify(plan.id)},{kind:'branch',path:null,state:'INTENT'},context);`);
    const before = preserved(file);
    assert.throws(() => acquireSyntheticCompanyChangeControl(h.runtime), { code: 'SYNTHETIC_COMPANY_CHANGE_CONTROL_BUSY' });
    assert.deepEqual(preserved(file), before); child.child.kill('SIGKILL'); await child.exited;
    const release = acquireSyntheticCompanyChangeControl(h.runtime), reopened = new SqliteSyntheticCompanyChangeStore(file);
    try {
      const pending = reopened.inspect(plan.id, context), recovered = reopened.recover(request, context);
      assert.equal(pending.status, 'APPLYING'); assert.equal(recovered.status, 'FAILED');
      assert.equal(recovered.failureCode, 'SYNTHETIC_COMPANY_CHANGE_INTERRUPTED');
      assert.deepEqual(recovered.approval, pending.approval); assert.deepEqual(recovered.journal, pending.journal);
      assert.equal(recovered.journal.length, 1); assert.ok(recovered.approval!.usedAt);
      assert.throws(() => reopened.claim(request, context), { code: 'SYNTHETIC_COMPANY_CHANGE_APPROVAL_UNAVAILABLE' });
    } finally { reopened.close(); release(); }
  } finally { if (child) { child.child.kill('SIGKILL'); await child.exited; } h.close(); }
});

test('control rejects foreign schemas, ownership tampering and copied location bindings before writable access', () => {
  for (const kind of ['foreign', 'owner', 'binding', 'copy'] as const) {
    const h = setup(), other = setup();
    try {
      if (kind === 'foreign') {
        const db = new DatabaseSync(h.file); db.exec('CREATE TABLE foreign_control (value TEXT)'); db.close(); fs.chmodSync(h.file, 0o600);
      } else if (kind === 'copy') {
        acquireSyntheticCompanyChangeControl(other.runtime, true)(); fs.copyFileSync(other.file, h.file);
      } else {
        acquireSyntheticCompanyChangeControl(h.runtime, true)(); const db = new DatabaseSync(h.file);
        try {
          if (kind === 'owner') db.prepare('UPDATE synthetic_company_change_control SET owner_id = ?').run('os-user:999999999');
          if (kind === 'binding') db.prepare('UPDATE synthetic_company_change_control SET binding_hash = ?').run('0'.repeat(64));
        } finally { db.close(); }
      }
      const before = preserved(h.file);
      assert.throws(() => acquireSyntheticCompanyChangeControl(h.runtime), { code: 'SYNTHETIC_COMPANY_CHANGE_INVALID_CONTROL' });
      assert.deepEqual(preserved(h.file), before);
    } finally { h.close(); other.close(); }
  }
});

test('control guards private directories, file links, sidecars and unexpected names without creating or cleaning them', () => {
  for (const kind of ['runtime-mode', 'directory-mode', 'file-mode', 'link', 'hardlink', 'sidecar', 'unexpected', 'missing-control'] as const) {
    const h = setup();
    try {
      if (kind === 'runtime-mode') fs.chmodSync(h.runtime, 0o755);
      if (kind === 'directory-mode') fs.chmodSync(h.control, 0o755);
      if (kind === 'file-mode') { fs.writeFileSync(h.file, 'SYNTHETIC_INVALID', { mode: 0o600 }); fs.chmodSync(h.file, 0o644); }
      if (kind === 'link' || kind === 'hardlink') {
        const target = join(h.runtime, 'target'); fs.writeFileSync(target, 'SYNTHETIC_TARGET', { mode: 0o600 });
        if (kind === 'link') fs.symlinkSync(target, h.file); else fs.linkSync(target, h.file);
      }
      if (kind === 'sidecar') fs.symlinkSync(join(h.runtime, 'missing'), h.file + '-journal');
      if (kind === 'unexpected') fs.writeFileSync(join(h.control, 'unmanaged.txt'), 'SYNTHETIC_UNMANAGED', { mode: 0o600 });
      if (kind === 'missing-control') fs.rmdirSync(h.control);
      assert.throws(() => acquireSyntheticCompanyChangeControl(h.runtime, true), { code: 'SYNTHETIC_COMPANY_CHANGE_UNSAFE_CONTROL' });
      if (kind === 'runtime-mode') fs.chmodSync(h.runtime, 0o700);
      if (kind === 'directory-mode') fs.chmodSync(h.control, 0o700);
      if (kind === 'link' || kind === 'hardlink') assert.equal(fs.readFileSync(join(h.runtime, 'target'), 'utf8'), 'SYNTHETIC_TARGET');
      if (kind === 'unexpected') assert.equal(fs.readFileSync(join(h.control, 'unmanaged.txt'), 'utf8'), 'SYNTHETIC_UNMANAGED');
      if (kind === 'missing-control') assert.equal(fs.existsSync(h.control), false);
    } finally { h.close(); }
  }
});

test('release detects database or ancestor replacement and never deletes the replacement', () => {
  for (const kind of ['database', 'ancestor'] as const) {
    const h = setup(), release = acquireSyntheticCompanyChangeControl(h.runtime, true); let moved: string | null = null;
    try {
      if (kind === 'database') { fs.renameSync(h.file, h.file + '.old'); fs.copyFileSync(h.file + '.old', h.file); }
      else { moved = h.runtime + '-old'; fs.renameSync(h.runtime, moved); fs.mkdirSync(h.runtime, { mode: 0o700 }); fs.renameSync(join(moved, 'control'), h.control); }
      assert.throws(release, (error: unknown) => error instanceof HarnessError && error.code === 'SYNTHETIC_COMPANY_CHANGE_UNSAFE_CONTROL');
      assert.ok(fs.existsSync(h.file));
    } finally { release(); h.close(); if (moved) fs.rmSync(moved, { recursive: true, force: true }); }
  }
});
