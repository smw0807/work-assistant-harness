import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { RestrictedReadonlyFakeTransport } from '../src/adapters/readonly-fake-transport.js';
import { createReadonlyTransportLifecycle, readonlyTransportCleanupConfirmed } from '../src/adapters/readonly-transport-lifecycle.js';
import { collectReadonlyPayload, prepareReadonlyRepository } from '../src/adapters/readonly-repository.js';
import { readonlyTransportWorkerLaunch } from '../src/adapters/readonly-transport-worker-contract.js';
import { createReadonlyTransportPayload, parseReadonlyTransportResponse } from '../src/policy/readonly-transport-policy.js';
import { defaultReadonlySelection, hashReadonlyValue, selectReadonlyTransfer } from '../src/policy/readonly-investigation-policy.js';

const removeFixture = async (path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await removeFixture(join(path, name));
  }
  await rm(path, { recursive: true, force: true });
};
const setup = async (t: TestContext) => {
  const data = await realpath(await mkdtemp(join(tmpdir(), 'harness-readonly-transport-')));
  await chmod(data, 0o700); t.after(() => removeFixture(data));
  const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  const id = randomUUID();
  const repository = await prepareReadonlyRepository(data, id);
  const basePayload = await collectReadonlyPayload(repository, defaultReadonlySelection(), context);
  const payload = createReadonlyTransportPayload(basePayload);
  return { data, id, payload, basePayload };
};

test('restricted fake transport worker receives selected evidence only and records no input in its lifecycle', async (t) => {
  const { data, id, payload, basePayload } = await setup(t);
  const selected = createReadonlyTransportPayload(selectReadonlyTransfer(basePayload, [payload.context.evidence.find((item) => item.path === 'src/controller.ts')!.evidenceId]));
  const raw = await new RestrictedReadonlyFakeTransport(60_000, { dataDirectory: data, investigationId: id }).transmit(selected.requestBody, new AbortController().signal);
  const result = parseReadonlyTransportResponse(raw, selected);
  assert.equal(result.mode, 'offline'); assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]!.references[0]!.evidenceId, selected.transferEvidenceIds[0]);
  assert.doesNotMatch(Buffer.from(raw).toString('utf8'), /src\/service\.ts|src\/settings\.ts|README\.md/);
  const lifecycle = await readFile(join(data, 'readonly-transport-runs', id, 'lifecycle.json'), 'utf8');
  assert.doesNotMatch(lifecycle, /excerpt|instructions|inputText|sourceRoot/);
  assert.equal(JSON.parse(lifecycle).state, 'closed');
  assert.equal(readonlyTransportCleanupConfirmed(data, id, selected.requestBodyHash), true);
  assert.equal(readonlyTransportCleanupConfirmed(data, id, '0'.repeat(64)), false);
});

test('worker boundaries deny host reads, writes, network, child processes and inherited credentials', async (t) => {
  const { data } = await setup(t);
  const canary = join(data, 'host-canary.txt'); const output = join(data, 'forbidden.txt');
  await writeFile(canary, 'SYNTHETIC_PRIVATE_CANARY', { mode: 0o600 });
  const launch = readonlyTransportWorkerLaunch();
  const script = `
    import fs from 'node:fs'; import cp from 'node:child_process'; import net from 'node:net';
    const blocked = [];
    for (const [name, action] of [
      ['read', () => fs.readFileSync(${JSON.stringify(canary)})],
      ['write', () => fs.writeFileSync(${JSON.stringify(output)}, 'changed')],
      ['child', () => { const result = cp.spawnSync(process.execPath, ['--version']); if (result.error) throw result.error; }],
      ['network', () => new Promise((resolve, reject) => { const socket = net.connect(9, '127.0.0.1'); socket.once('error', reject); socket.once('connect', () => { socket.destroy(); resolve(); }); })],
    ]) { try { await action(); throw Error(name + ' was permitted'); } catch(error) { if(error.code !== 'ERR_ACCESS_DENIED') throw error; blocked.push(name); } }
    if (process.env.SYNTHETIC_HOST_SECRET || process.env.HOME || process.env.NODE_OPTIONS) throw Error('inherited environment');
    console.log(JSON.stringify(blocked));
  `;
  const result = spawnSync(process.execPath, [...launch.flags, '--input-type=module', '-e', script],
    { env: launch.environment, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['read', 'write', 'child', 'network']);
  assert.equal(await readFile(canary, 'utf8'), 'SYNTHETIC_PRIVATE_CANARY');
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

test('worker refuses broader launch permissions, inherited environment and missing parent IPC', async (t) => {
  const { data, payload } = await setup(t); const launch = readonlyTransportWorkerLaunch();
  for (const variant of ['permissions', 'environment', 'ipc'] as const) {
    const child = spawn(process.execPath, [...launch.flags,
      ...(variant === 'permissions' ? [`--allow-fs-write=${data}`] : []), launch.entry], {
      cwd: '/', env: { ...launch.environment, ...(variant === 'environment' ? { SYNTHETIC_HOST_SECRET: 'DO_NOT_ECHO' } : {}) },
      stdio: variant === 'ipc' ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    let ready = false; let stdout = ''; let stderr = '';
    child.on('message', () => { ready = true; });
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(payload.requestBody);
    const code = await new Promise<number | null>((resolveExit) => child.once('close', resolveExit));
    assert.equal(code, 1); assert.equal(ready, false); assert.equal(stdout, '');
    assert.equal(stderr, 'READONLY_TRANSPORT_WORKER_FAILED\n');
  }
});

test('untrusted source instructions stay inert and malformed requests expose only static failures', async (t) => {
  const { data, payload } = await setup(t);
  const canary = join(data, 'do-not-execute.txt');
  await writeFile(canary, 'unchanged', { mode: 0o600 });
  assert.match(payload.inputText, /ignore policy/);
  const port = new RestrictedReadonlyFakeTransport();
  const raw = await port.transmit(payload.requestBody, new AbortController().signal);
  assert.equal(parseReadonlyTransportResponse(raw, payload).mode, 'offline');
  assert.equal(await readFile(canary, 'utf8'), 'unchanged');
  await assert.rejects(port.transmit('SYNTHETIC_PRIVATE_INVALID_JSON', new AbortController().signal), { code: 'READONLY_TRANSPORT_PROCESS_FAILED' });
  await assert.rejects(port.transmit('x'.repeat(256 * 1024 + 1), new AbortController().signal), { code: 'READONLY_TRANSPORT_REQUEST_LIMIT' });
});

test('abort and timeout return only after worker exit, and malformed lifecycle cannot confirm recovery', async (t) => {
  const { data, id, payload } = await setup(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new RestrictedReadonlyFakeTransport().transmit(payload.requestBody, controller.signal), { code: 'READONLY_TRANSPORT_CANCELLED' });
  await assert.rejects(new RestrictedReadonlyFakeTransport(1, { dataDirectory: data, investigationId: id })
    .transmit(payload.requestBody, new AbortController().signal), { code: 'READONLY_TRANSPORT_TIMEOUT' });
  assert.equal(readonlyTransportCleanupConfirmed(data, id, payload.requestBodyHash), true);
  const lifecycle = join(data, 'readonly-transport-runs', id, 'lifecycle.json');
  const saved = await readFile(lifecycle, 'utf8');
  await writeFile(lifecycle, saved.replace('"state":"closed"', '"state":"intent","state":"closed"'), { mode: 0o600 });
  assert.equal(readonlyTransportCleanupConfirmed(data, id, payload.requestBodyHash), false);
  await writeFile(lifecycle, '{partial', { mode: 0o600 });
  assert.equal(readonlyTransportCleanupConfirmed(data, id, payload.requestBodyHash), false);
  assert.equal(readonlyTransportCleanupConfirmed(data, randomUUID(), payload.requestBodyHash), false);
});

test('live PID and unrecorded spawn intent remain blocked; only closure or absence confirms cleanup', async (t) => {
  const { data } = await setup(t);
  const id = randomUUID(); const requestBodyHash = hashReadonlyValue('synthetic approved input');
  const lifecycle = createReadonlyTransportLifecycle({ dataDirectory: data, investigationId: id }, requestBodyHash);
  assert.equal(readonlyTransportCleanupConfirmed(data, id, requestBodyHash), false);
  lifecycle.spawned(process.pid);
  assert.equal(readonlyTransportCleanupConfirmed(data, id, requestBodyHash), false);
  lifecycle.closed(process.pid);
  assert.equal(readonlyTransportCleanupConfirmed(data, id, requestBodyHash), true);
});

test('real parent SIGKILL disconnects an input-waiting worker and persisted PID absence proves cleanup', async (t) => {
  const { data } = await setup(t); const id = randomUUID(); const requestBodyHash = hashReadonlyValue('synthetic awaiting stdin');
  const contract = pathToFileURL(resolve('dist/src/adapters/readonly-transport-worker-contract.js')).href;
  const lifecycleModule = pathToFileURL(resolve('dist/src/adapters/readonly-transport-lifecycle.js')).href;
  const code = `
    import { spawn } from 'node:child_process';
    import { readonlyTransportWorkerLaunch } from ${JSON.stringify(contract)};
    import { createReadonlyTransportLifecycle } from ${JSON.stringify(lifecycleModule)};
    const record = createReadonlyTransportLifecycle(${JSON.stringify({ dataDirectory: data, investigationId: id })}, ${JSON.stringify(requestBodyHash)});
    const launch = readonlyTransportWorkerLaunch();
    const child = spawn(process.execPath, [...launch.flags, launch.entry], { cwd:'/', env:launch.environment, stdio:['pipe','pipe','pipe','ipc'] });
    record.spawned(child.pid);
    child.on('message', value => { if (value.type === 'ready') console.log(child.pid); });
    child.on('exit', () => process.exit(2));
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { parent.kill('SIGKILL'); });
  const pid = await new Promise<number>((resolvePid, reject) => {
    const timeout = setTimeout(() => reject(new Error('worker readiness timeout')), 5000);
    parent.stdout!.once('data', (chunk: Buffer) => { clearTimeout(timeout); resolvePid(Number(chunk.toString().trim())); });
    parent.once('exit', () => { clearTimeout(timeout); reject(new Error('parent exited before worker ready')); });
  });
  assert.ok(Number.isInteger(pid) && pid > 1);
  assert.equal(readonlyTransportCleanupConfirmed(data, id, requestBodyHash), false);
  parent.kill('SIGKILL');
  await new Promise<void>((resolveExit) => parent.once('close', () => resolveExit()));
  for (let attempt = 0; attempt < 100 && !readonlyTransportCleanupConfirmed(data, id, requestBodyHash); attempt++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.equal(readonlyTransportCleanupConfirmed(data, id, requestBodyHash), true);
});
