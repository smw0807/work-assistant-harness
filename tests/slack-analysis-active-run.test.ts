import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertSlackAnalysisIdle, withSlackAnalysisNativeRun } from '../src/adapters/slack-analysis-active-run.js';
import { HarnessError } from '../src/domain/errors.js';

const runId = '11111111-1111-4111-8111-111111111111';
const setup = () => {
  const directory = fs.mkdtempSync('/private/tmp/harness-slack-analysis-active-'); fs.chmodSync(directory, 0o700);
  return { directory, marker: join(directory, 'slack-analysis-active.json'), close: () => fs.rmSync(directory, { recursive: true, force: true }) };
};

test('the durable active marker contains only its version and run ID and is removed after confirmed success', async () => {
  const h = setup();
  try {
    assertSlackAnalysisIdle(h.directory);
    const result = await withSlackAnalysisNativeRun(h.directory, runId, async () => {
      assert.equal(fs.statSync(h.marker).mode & 0o7777, 0o600);
      assert.deepEqual(JSON.parse(fs.readFileSync(h.marker, 'utf8')), { version: 'slack-analysis-active-v1', runId });
      assert.throws(() => assertSlackAnalysisIdle(h.directory), { code: 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED' });
      return 'SYNTHETIC_CONFIRMED_RESULT';
    });
    assert.equal(result, 'SYNTHETIC_CONFIRMED_RESULT'); assert.equal(fs.existsSync(h.marker), false); assertSlackAnalysisIdle(h.directory);
  } finally { h.close(); }
});

test('a confirmed fixed failure removes its own marker but lifecycle-unsafe and unknown errors preserve it', async () => {
  for (const error of [new HarnessError('READONLY_RELAY_FAILED'), new HarnessError('READONLY_RELAY_LIFECYCLE_UNSAFE'), new Error('Synthetic unknown outcome')]) {
    const h = setup();
    try {
      await assert.rejects(withSlackAnalysisNativeRun(h.directory, runId, async () => { throw error; }), actual => actual === error);
      const retained = !(error instanceof HarnessError) || error.code === 'READONLY_RELAY_LIFECYCLE_UNSAFE';
      assert.equal(fs.existsSync(h.marker), retained);
      if (retained) assert.throws(() => assertSlackAnalysisIdle(h.directory), { code: 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED' });
      else assertSlackAnalysisIdle(h.directory);
    } finally { h.close(); }
  }
});

test('another running callback cannot enter or remove the first callback marker', async () => {
  const h = setup(); let resolveFirst!: () => void, invoked = 0;
  try {
    const first = withSlackAnalysisNativeRun(h.directory, runId, () => { invoked++; return new Promise<void>(resolve => { resolveFirst = resolve; }); });
    const before = fs.readFileSync(h.marker), inode = fs.statSync(h.marker).ino;
    await assert.rejects(withSlackAnalysisNativeRun(h.directory, '22222222-2222-4222-8222-222222222222', async () => { invoked++; }),
      { code: 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED' });
    assert.equal(invoked, 1); assert.deepEqual(fs.readFileSync(h.marker), before); assert.equal(fs.statSync(h.marker).ino, inode);
    resolveFirst(); await first; assertSlackAnalysisIdle(h.directory);
  } finally { resolveFirst?.(); h.close(); }
});

test('existing, foreign, symlink and hardlink markers are never opened, replaced or cleaned', async () => {
  for (const kind of ['foreign', 'symlink', 'hardlink'] as const) {
    const h = setup(), target = join(h.directory, 'preserved'); let invoked = 0;
    try {
      fs.writeFileSync(target, 'SYNTHETIC_FOREIGN_MARKER', { mode: 0o600 });
      if (kind === 'foreign') fs.copyFileSync(target, h.marker);
      if (kind === 'symlink') fs.symlinkSync(target, h.marker);
      if (kind === 'hardlink') fs.linkSync(target, h.marker);
      assert.throws(() => assertSlackAnalysisIdle(h.directory), { code: 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED' });
      await assert.rejects(withSlackAnalysisNativeRun(h.directory, runId, async () => { invoked++; }), { code: 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED' });
      assert.equal(invoked, 0); assert.equal(fs.readFileSync(target, 'utf8'), 'SYNTHETIC_FOREIGN_MARKER'); assert.ok(fs.lstatSync(h.marker));
    } finally { h.close(); }
  }
});

test('callback replacement, same-inode modification or a foreign hardlink prevents cleanup', async () => {
  for (const kind of ['replacement', 'modified', 'hardlink'] as const) {
    const h = setup();
    try {
      await assert.rejects(withSlackAnalysisNativeRun(h.directory, runId, async () => {
        if (kind === 'replacement') { fs.renameSync(h.marker, h.marker + '.original'); fs.writeFileSync(h.marker, 'FOREIGN', { mode: 0o600 }); }
        if (kind === 'modified') fs.appendFileSync(h.marker, 'FOREIGN');
        if (kind === 'hardlink') fs.linkSync(h.marker, h.marker + '.linked');
      }), { code: 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED' });
      assert.equal(fs.existsSync(h.marker), true); assert.throws(() => assertSlackAnalysisIdle(h.directory));
    } finally { h.close(); }
  }
});

test('unsafe private directories and invalid run IDs stop before a callback or marker is created', async () => {
  const h = setup(); let invoked = 0;
  try {
    await assert.rejects(withSlackAnalysisNativeRun(h.directory, '../escape', async () => { invoked++; }), { code: 'SLACK_ANALYSIS_INVALID_INPUT' });
    fs.chmodSync(h.directory, 0o755);
    assert.throws(() => assertSlackAnalysisIdle(h.directory), { code: 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED' });
    await assert.rejects(withSlackAnalysisNativeRun(h.directory, runId, async () => { invoked++; }), { code: 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED' });
    assert.equal(invoked, 0); assert.equal(fs.existsSync(h.marker), false); assert.equal(fs.statSync(h.directory).mode & 0o777, 0o755);
  } finally { fs.chmodSync(h.directory, 0o700); h.close(); }
});

test('actual controller SIGKILL leaves its durable marker and a fresh caller cannot start another native callback', async () => {
  const h = setup();
  const module = new URL('../src/adapters/slack-analysis-active-run.js', import.meta.url).href;
  const script = `import {withSlackAnalysisNativeRun as run} from ${JSON.stringify(module)};
await run(process.argv[1],${JSON.stringify(runId)},()=>{process.stdout.write('READY\\n');return new Promise(()=>{setInterval(()=>{},1000);});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, h.directory], {
    env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic active controller did not become ready')), 5000);
      child.stdout.once('data', chunk => { clearTimeout(timer); assert.equal(String(chunk), 'READY\n'); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const before = fs.readFileSync(h.marker); child.kill('SIGKILL'); await exited;
    assert.deepEqual(fs.readFileSync(h.marker), before);
    assert.throws(() => assertSlackAnalysisIdle(h.directory), { code: 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED' });
    let invoked = false;
    await assert.rejects(withSlackAnalysisNativeRun(h.directory, runId, async () => { invoked = true; }), { code: 'SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED' });
    assert.equal(invoked, false); assert.deepEqual(fs.readFileSync(h.marker), before);
  } finally { child.kill('SIGKILL'); await exited; h.close(); }
});
