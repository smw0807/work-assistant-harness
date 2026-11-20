import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { companyApplyIsolationLimits, companyApplySandboxProfile, runIsolatedCompanyApplyWorker } from '../src/adapters/company-apply-isolation.js';

const supported = process.platform === 'darwin' ? false : 'Actual macOS SBPL verification requires macOS; no isolation claim on this host';
const fixture = () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'company-apply-isolation-')));
  fs.chmodSync(root, 0o700); const repositoryRoot = join(root, 'repository'); fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  return { root, repositoryRoot, close: () => fs.rmSync(root, { recursive: true, force: true }) };
};
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Synthetic isolation condition did not complete');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const runProbe = async (profile: string, script: string, cwd: string): Promise<void> => {
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, fs.realpathSync(process.execPath), '--no-addons',
    '--disable-proto=throw', '--max-old-space-size=128', '-e', script], {
    cwd, env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', error = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { error += String(chunk); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.equal(code, 0, `Actual sandbox probe failed: ${error.slice(0, 2000)}`); assert.equal(output, 'ISOLATION_PASSED\n');
  } finally { clearTimeout(timer); child.kill('SIGKILL'); }
};

test('company write profile grants exact literals and rejects malformed, escaping and linked paths', () => {
  const h = fixture();
  try {
    const selected = join(h.repositoryRoot, 'selected.ts'), created = join(h.repositoryRoot, 'new.ts');
    fs.writeFileSync(selected, 'SYNTHETIC', { mode: 0o600 });
    const profile = companyApplySandboxProfile({ repositoryRoot: h.repositoryRoot, readPaths: [selected], writePaths: [created] });
    assert.ok(profile.includes(`(allow file-read-data (literal ${JSON.stringify(selected)}))`));
    assert.ok(profile.includes(`(allow file-write* (literal ${JSON.stringify(created)}))`));
    assert.ok(!profile.includes(`(subpath ${JSON.stringify(h.repositoryRoot)})`));
    assert.ok(profile.includes('(deny process-fork)')); assert.ok(!profile.includes('(allow network'));
    for (const bad of ['relative', h.root + '/repository/../escape', h.root + '/bad\nrule']) {
      assert.throws(() => companyApplySandboxProfile({ repositoryRoot: h.repositoryRoot, readPaths: [bad], writePaths: [] }),
        { code: 'COMPANY_APPLY_INVALID_ISOLATION_PATH' });
    }
    fs.symlinkSync(selected, join(h.repositoryRoot, 'linked'));
    assert.throws(() => companyApplySandboxProfile({ repositoryRoot: h.repositoryRoot, readPaths: [join(h.repositoryRoot, 'linked')], writePaths: [] }),
      { code: 'COMPANY_APPLY_INVALID_ISOLATION_PATH' });
    assert.throws(() => companyApplySandboxProfile({ repositoryRoot: h.repositoryRoot, readPaths: Array(129).fill(selected), writePaths: [] }),
      { code: 'COMPANY_APPLY_INVALID_ISOLATION_PATH' });
  } finally { h.close(); }
});

test('actual macOS isolation permits selected writes but denies credentials, siblings, TCP, Unix sockets and every child executable', { skip: supported }, async () => {
  const h = fixture(), tcp = createServer(socket => socket.end()), unix = createServer(socket => socket.end());
  const socketDirectory = fs.mkdtempSync('/private/tmp/cwi-'), socket = join(socketDirectory, 'probe.sock');
  try {
    const selected = join(h.repositoryRoot, 'selected.ts'), sibling = join(h.repositoryRoot, 'unselected.ts');
    const created = join(h.repositoryRoot, 'new.ts'), escaped = join(h.root, 'outside-write');
    const credential = join(h.root, 'fake-credential');
    fs.writeFileSync(selected, 'BEFORE', { mode: 0o600 }); fs.writeFileSync(sibling, 'SIBLING', { mode: 0o600 });
    fs.writeFileSync(credential, 'SYNTHETIC_CREDENTIAL_CANARY', { mode: 0o600 });
    await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => { unix.once('error', reject); unix.listen(socket, resolve); });
    const address = tcp.address(); assert.ok(address && typeof address === 'object');
    const profile = companyApplySandboxProfile({ repositoryRoot: h.repositoryRoot, readPaths: [selected, h.repositoryRoot], writePaths: [selected, created] });
    const script = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),assert=require('node:assert/strict');
const denied=fn=>assert.throws(fn,e=>['EPERM','EACCES'].includes(e.code));
assert.deepEqual(Object.keys(process.env).sort(),['LANG','NODE_NO_WARNINGS','TZ']);
assert.ok(process.execArgv.includes('--no-addons'));assert.ok(process.execArgv.includes('--disable-proto=throw'));
assert.equal(fs.readFileSync(${JSON.stringify(selected)},'utf8'),'BEFORE');
fs.writeFileSync(${JSON.stringify(selected)},'AFTER');fs.writeFileSync(${JSON.stringify(created)},'CREATED');
const dir=fs.openSync(${JSON.stringify(h.repositoryRoot)},'r');fs.fsyncSync(dir);fs.closeSync(dir);
denied(()=>fs.readFileSync(${JSON.stringify(sibling)}));denied(()=>fs.writeFileSync(${JSON.stringify(sibling)},'BAD'));
denied(()=>fs.readFileSync(${JSON.stringify(credential)}));denied(()=>fs.writeFileSync(${JSON.stringify(escaped)},'BAD'));
for(const executable of ['/usr/bin/true',process.execPath]){const result=cp.spawnSync(executable,executable===process.execPath?['-e','process.exit(0)']:[]);assert.ok(result.error&&['EPERM','EACCES'].includes(result.error.code));}
const connect=options=>new Promise((resolve,reject)=>{const socket=net.connect(options);socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();reject(Error('connection allowed'));});socket.once('timeout',()=>{socket.destroy();reject(Error('connection timed out instead of denial'));});socket.once('error',error=>['EPERM','EACCES'].includes(error.code)?resolve():reject(error));});
(async()=>{await connect({host:'127.0.0.1',port:${address.port}});await connect({path:${JSON.stringify(socket)}});console.log('ISOLATION_PASSED');})().catch(error=>{console.error(error);process.exitCode=1;});`;
    await runProbe(profile, script, h.repositoryRoot);
    assert.equal(fs.readFileSync(selected, 'utf8'), 'AFTER'); assert.equal(fs.readFileSync(created, 'utf8'), 'CREATED');
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'SIBLING'); assert.equal(fs.readFileSync(credential, 'utf8'), 'SYNTHETIC_CREDENTIAL_CANARY');
    assert.equal(fs.existsSync(escaped), false);
  } finally {
    await Promise.all([new Promise<void>(resolve => tcp.close(() => resolve())), new Promise<void>(resolve => unix.close(() => resolve()))]);
    fs.rmSync(socketDirectory, { recursive: true, force: true }); h.close();
  }
});

test('isolation rejects invalid inputs and already cancelled requests before spawning', async () => {
  if (supported) return;
  const h = fixture();
  try {
    for (const input of ['{}\n{}', 'x'.repeat(327_681)]) {
      await assert.rejects(runIsolatedCompanyApplyWorker({ repositoryRoot: h.repositoryRoot, readPaths: [], writePaths: [], input }),
        { code: 'COMPANY_APPLY_INVALID_WORKER_INPUT' });
    }
    await assert.rejects(runIsolatedCompanyApplyWorker({ repositoryRoot: h.repositoryRoot, readPaths: [], writePaths: [], input: '{}',
      signal: AbortSignal.abort() }), { code: 'COMPANY_APPLY_WORKER_ABORTED' });
  } finally { h.close(); }
});

const testBundle = async (root: string, worker: string) => {
  const bundle = join(root, 'bundle'), source = join(bundle, 'dist/src');
  for (const directory of ['adapters', 'cli', 'domain']) fs.mkdirSync(join(source, directory), { recursive: true, mode: 0o700 });
  for (const path of ['adapters/company-apply-isolation.js', 'cli/company-apply-process.js', 'domain/errors.js']) {
    const original = new URL('../src/' + path, import.meta.url);
    fs.copyFileSync(fileURLToPath(original), join(source, path));
  }
  fs.writeFileSync(join(bundle, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  fs.writeFileSync(join(source, 'cli/company-apply-worker.js'), worker, { mode: 0o600 });
  const url = pathToFileURL(join(source, 'adapters/company-apply-isolation.js')).href;
  return { url, runner: (await import(url) as typeof import('../src/adapters/company-apply-isolation.js')).runIsolatedCompanyApplyWorker };
};

test('guardian enforces combined output budget and preserves partial writes on cancellation with TERM-resistant worker', { skip: supported }, async () => {
  for (const kind of ['output', 'cancel'] as const) {
    const h = fixture(), marker = join(h.repositoryRoot, 'partial');
    try {
      const bundle = await testBundle(h.root, `import fs from 'node:fs';
process.on('SIGTERM',()=>{});process.stdin.once('data',()=>{fs.writeFileSync(${JSON.stringify(marker)},'PARTIAL');
${kind === 'output' ? "process.stderr.write('X'.repeat(16385));" : ''}setInterval(()=>{},1000);});`);
      const controller = new AbortController(), result = bundle.runner({ repositoryRoot: h.repositoryRoot, readPaths: [], writePaths: [marker],
        input: '{}', signal: controller.signal });
      const assertion = assert.rejects(result, { code: kind === 'output' ? 'COMPANY_APPLY_WORKER_OUTPUT_LIMIT' : 'COMPANY_APPLY_WORKER_ABORTED' });
      if (kind === 'cancel') { await waitFor(() => { try { return fs.readFileSync(marker, 'utf8') === 'PARTIAL'; } catch { return false; } }); controller.abort(); }
      await assertion; assert.equal(fs.readFileSync(marker, 'utf8'), 'PARTIAL');
    } finally { h.close(); }
  }
});

test('parent SIGKILL disconnects guardian and kills a TERM-resistant worker while preserving its partial file', { skip: supported }, async () => {
  const h = fixture(), marker = join(h.repositoryRoot, 'partial');
  let parent: ReturnType<typeof spawn> | null = null, exited: Promise<unknown> | null = null;
  try {
    const bundle = await testBundle(h.root, `import fs from 'node:fs';process.on('SIGTERM',()=>{});
process.stdin.once('data',()=>{fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,ready:true}));setInterval(()=>{},1000);});`);
    const script = `import {runIsolatedCompanyApplyWorker as run} from ${JSON.stringify(bundle.url)};
await run(${JSON.stringify({ repositoryRoot: h.repositoryRoot, readPaths: [], writePaths: [marker], input: '{}' })});`;
    parent = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: dirname(h.repositoryRoot),
      env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: 'ignore' });
    exited = new Promise(resolve => parent!.once('close', resolve));
    let pid = 0;
    await waitFor(() => {
      try { const ready = JSON.parse(fs.readFileSync(marker, 'utf8')) as { pid: number; ready: boolean };
        if (ready.ready !== true || !Number.isSafeInteger(ready.pid) || ready.pid <= 1) return false;
        pid = ready.pid; return true; } catch { return false; }
    });
    assert.ok(Number.isSafeInteger(pid) && pid > 1); parent.kill('SIGKILL'); await exited;
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } });
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { pid, ready: true });
  } finally { parent?.kill('SIGKILL'); if (exited) await exited; h.close(); }
});

test('the fixed 30-second watchdog kills a TERM-resistant worker and confirms close without removing partial writes',
  { skip: supported, timeout: 40_000 }, async () => {
    const h = fixture(), marker = join(h.repositoryRoot, 'partial');
    try {
      const bundle = await testBundle(h.root, `import fs from 'node:fs';process.on('SIGTERM',()=>{});
process.stdin.once('data',()=>{fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,ready:true}));setInterval(()=>{},1000);});`);
      const start = performance.now();
      await assert.rejects(bundle.runner({ repositoryRoot: h.repositoryRoot, readPaths: [], writePaths: [marker], input: '{}' }),
        { code: 'COMPANY_APPLY_WORKER_TIMEOUT' });
      const elapsed = performance.now() - start, pid = (JSON.parse(fs.readFileSync(marker, 'utf8')) as { pid: number }).pid;
      assert.ok(elapsed >= companyApplyIsolationLimits.timeoutMs - 100 && elapsed < companyApplyIsolationLimits.timeoutMs + 5000);
      assert.ok(Number.isSafeInteger(pid) && pid > 1);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { pid, ready: true });
    } finally { h.close(); }
  });
