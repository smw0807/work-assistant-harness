import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createReadonlyRelayLifecycle, readonlyRelayCleanupConfirmed, readonlyRelayScratchIdentity, removeReadonlyRelayScratch } from '../src/adapters/readonly-relay-lifecycle.js';
import { runReadonlyRelayProcess } from '../src/adapters/readonly-relay-runner.js';

const hashes = { requestBodyHash: 'a'.repeat(64), requestEnvelopeHash: 'b'.repeat(64), connectionProfileHash: 'c'.repeat(64) };
const prepare = (context: TestContext): string => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-relay-process-'))); chmodSync(directory, 0o700);
  context.after(() => rmSync(directory, { recursive: true, force: true })); return directory;
};
const native = process.platform === 'darwin' && process.env.HARNESS_NATIVE_CODEX_PROBE === '1';
const skip = native ? false : 'native macOS probe opt-in required';
interface Child { state: string; guardianPid: number; childPid: number }
const childRecord = (directory: string, id: string): Child => JSON.parse(readFileSync(join(directory, 'readonly-relay-runs', id, 'child.json'), 'utf8'));
const awaitSpawn = async (directory: string, id: string): Promise<Child> => {
  for (let attempt = 0; attempt < 500; attempt++) {
    const child = childRecord(directory, id); if (child.state === 'spawned') return child; await delay(10);
  }
  throw new Error('relay child was not observed');
};
const absent = (child: Child): void => {
  for (const pid of [child.guardianPid, child.childPid, -child.childPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
};

test('relay closure is bound to the new namespace and approved hashes and supports an unstarted private intent', (context) => {
  const directory = prepare(context); const id = randomUUID(); const where = { dataDirectory: directory, investigationId: id };
  assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), false);
  const lifecycle = createReadonlyRelayLifecycle(where, hashes);
  assert.match(lifecycle.directory, /\/readonly-relay-runs\//u);
  assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), false);
  lifecycle.closed(); assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), true);
  assert.equal(readonlyRelayCleanupConfirmed(directory, id, { ...hashes, requestBodyHash: 'd'.repeat(64) }), false);
  assert.throws(() => createReadonlyRelayLifecycle(where, hashes));
  const path = join(lifecycle.directory, 'lifecycle.json'); const record = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...record, version: 'readonly-live-process-v1' }));
  assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), false);
  assert.throws(() => lstatSync(join(directory, 'readonly-live-runs')), { code: 'ENOENT' });
});

test('a closed lifecycle never hides a live guardian, spawned child, ambiguous intent or invalid child record', (context) => {
  const directory = prepare(context); const id = randomUUID();
  const lifecycle = createReadonlyRelayLifecycle({ dataDirectory: directory, investigationId: id }, hashes); lifecycle.closed();
  const path = join(lifecycle.directory, 'child.json');
  const initial = JSON.parse(readFileSync(path, 'utf8'));
  for (const child of [
    { ...initial, state: 'intent', guardianPid: process.pid },
    { ...initial, state: 'spawned', guardianPid: process.pid, childPid: process.pid },
    { ...initial, state: 'closed', guardianPid: process.pid, childPid: null },
    { ...initial, state: 'closed', guardianPid: null },
    { ...initial, version: 'readonly-live-child-v1' },
    { ...initial, raw: 'PRIVATE_RELAY_RECORD' },
  ]) {
    writeFileSync(path, JSON.stringify(child)); assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), false);
  }
  writeFileSync(path, JSON.stringify(initial)); assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), true);
  writeFileSync(path, '{partial'); assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), false);
});

test('relay scratch cleanup rejects replaced roots and preserves symlink destinations outside its owned scratch', (context) => {
  const directory = prepare(context); const id = randomUUID(); const where = { dataDirectory: directory, investigationId: id };
  const lifecycle = createReadonlyRelayLifecycle(where, hashes); const scratch = join(lifecycle.directory, 'sandbox');
  const outside = join(directory, 'outside'); mkdirSync(outside, { mode: 0o700 });
  const canary = join(outside, 'canary.txt'); writeFileSync(canary, 'preserve synthetic canary', { mode: 0o600 });
  mkdirSync(scratch, { mode: 0o700 }); const identity = readonlyRelayScratchIdentity(where);
  const saved = join(lifecycle.directory, 'preserved-scratch'); renameSync(scratch, saved); symlinkSync(outside, scratch);
  assert.throws(() => removeReadonlyRelayScratch(where, identity), /READONLY_RELAY_LIFECYCLE_UNSAFE/);
  assert.equal(readFileSync(canary, 'utf8'), 'preserve synthetic canary'); rmSync(scratch); mkdirSync(scratch, { mode: 0o700 });
  assert.throws(() => removeReadonlyRelayScratch(where, identity), /READONLY_RELAY_LIFECYCLE_UNSAFE/);
  rmdirSync(scratch); renameSync(saved, scratch); symlinkSync(outside, join(scratch, 'outside-link'));
  removeReadonlyRelayScratch(where, identity); lifecycle.closed();
  assert.equal(readFileSync(canary, 'utf8'), 'preserve synthetic canary'); assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), true);
});

test('relay native runner records closure and removes its scratch before confirming successful cleanup', { skip, timeout: 15_000 }, async (context) => {
  const directory = prepare(context); const id = randomUUID(); const where = { dataDirectory: directory, investigationId: id };
  const lifecycle = createReadonlyRelayLifecycle(where, hashes); const workspace = join(lifecycle.directory, 'sandbox'); mkdirSync(workspace, { mode: 0o700 }); lifecycle.running();
  const text = await runReadonlyRelayProcess(realpathSync(process.execPath), ['--no-addons', '-e', "console.log('RELAY_SYNTHETIC')"], workspace, 12345,
    { HOME: workspace, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, '', new AbortController().signal, where);
  assert.equal(text.trim(), 'RELAY_SYNTHETIC'); assert.equal(childRecord(directory, id).state, 'closed');
  lifecycle.closed(); absent(childRecord(directory, id)); assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), true);
  assert.throws(() => lstatSync(join(lifecycle.directory, 'sandbox')), { code: 'ENOENT' });
});

test('relay native cancellation waits for guardian, child and group closure before cleanup is accepted', { skip, timeout: 15_000 }, async (context) => {
  const directory = prepare(context); const id = randomUUID(); const where = { dataDirectory: directory, investigationId: id };
  const lifecycle = createReadonlyRelayLifecycle(where, hashes); const workspace = join(lifecycle.directory, 'sandbox'); mkdirSync(workspace, { mode: 0o700 }); lifecycle.running();
  const controller = new AbortController();
  const pending = runReadonlyRelayProcess(realpathSync(process.execPath), ['--no-addons', '-e', 'setInterval(()=>{},1000)'], workspace, 12345,
    { HOME: workspace, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, '', controller.signal, where);
  void pending.catch(() => {}); const child = await awaitSpawn(directory, id);
  assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), false); controller.abort();
  await assert.rejects(pending, /READONLY_RELAY_CANCELLED/); lifecycle.closed(); absent(child);
  assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), true);
});

const controllerScript = String.raw`
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const [directory,id,runnerUrl,lifecycleUrl,nodePath,hashesJson] = process.argv.slice(1);
const { createReadonlyRelayLifecycle } = await import(lifecycleUrl);
const { runReadonlyRelayProcess } = await import(runnerUrl);
const where={dataDirectory:directory,investigationId:id};
const lifecycle=createReadonlyRelayLifecycle(where,JSON.parse(hashesJson));
const workspace=join(lifecycle.directory,'sandbox'); mkdirSync(workspace,{mode:0o700}); lifecycle.running();
const pending=runReadonlyRelayProcess(nodePath,['--no-addons','-e','setInterval(()=>{},1000)'],workspace,12345,
 {HOME:workspace,PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},'',new AbortController().signal,where);
void pending.catch(()=>{});
for(let attempt=0;attempt<500;attempt++){ const child=JSON.parse(readFileSync(join(lifecycle.directory,'child.json'),'utf8'));
 if(child.state==='spawned'){process.stdout.write(JSON.stringify(child)+'\n');break;} await delay(10); }
await pending;
`;
test('relay guardian survives controller SIGKILL long enough to close its child and a fresh process verifies recovery', { skip, timeout: 15_000 }, async (context) => {
  const directory = prepare(context); const id = randomUUID();
  const child = spawn(process.execPath, ['--input-type=module', '-e', controllerScript, directory, id,
    new URL('../src/adapters/readonly-relay-runner.js', import.meta.url).href,
    new URL('../src/adapters/readonly-relay-lifecycle.js', import.meta.url).href, realpathSync(process.execPath), JSON.stringify(hashes)],
  { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let record: Child | null = null;
  context.after(() => {
    try { child.kill('SIGKILL'); } catch { /* already closed */ }
    if (record) for (const pid of [record.guardianPid, -record.childPid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already closed */ } }
  });
  record = await new Promise<Child>((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('relay child readiness timeout')), 6000);
    child.stdout.on('data', (part: Buffer) => { output += part.toString(); if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]!)); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('relay controller exited before readiness')); });
  });
  assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), false);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
  for (let attempt = 0; attempt < 200 && !readonlyRelayCleanupConfirmed(directory, id, hashes); attempt++) await delay(10);
  assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), true); absent(record);
  const verifier = spawn(process.execPath, ['--input-type=module', '-e',
    `const {readonlyRelayCleanupConfirmed}=await import(${JSON.stringify(new URL('../src/adapters/readonly-relay-lifecycle.js', import.meta.url).href)}); if(!readonlyRelayCleanupConfirmed(process.argv[1],process.argv[2],JSON.parse(process.argv[3])))process.exit(1);`,
    directory, id, JSON.stringify(hashes)], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve) => verifier.once('exit', resolve)); assert.equal(code, 0);
});

test('relay guardian bounds discarded stderr without persisting raw child output', { skip, timeout: 15_000 }, async (context) => {
  const directory = prepare(context); const id = randomUUID(); const where = { dataDirectory: directory, investigationId: id };
  const lifecycle = createReadonlyRelayLifecycle(where, hashes); const workspace = join(lifecycle.directory, 'sandbox'); mkdirSync(workspace, { mode: 0o700 }); lifecycle.running();
  await assert.rejects(runReadonlyRelayProcess(realpathSync(process.execPath), ['--no-addons', '-e', "process.stderr.write('PRIVATE_RELAY_STDERR'.repeat(2000));setInterval(()=>{},1000)"],
    workspace, 12345, { HOME: workspace, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, '', new AbortController().signal, where), (error: unknown) => {
    assert.doesNotMatch(String(error), /PRIVATE_RELAY_STDERR/); return true;
  });
  lifecycle.closed(); absent(childRecord(directory, id)); assert.equal(readonlyRelayCleanupConfirmed(directory, id, hashes), true);
  for (const name of ['child.json', 'lifecycle.json']) assert.doesNotMatch(readFileSync(join(lifecycle.directory, name), 'utf8'), /PRIVATE_RELAY_STDERR/);
});
