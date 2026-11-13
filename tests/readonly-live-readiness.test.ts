import assert from 'node:assert/strict';
import { chmodSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ReadonlyLiveService } from '../src/application/investigate-live.js';
import { RestrictedReadonlyLiveCodex } from '../src/adapters/readonly-live-codex.js';
import { SqliteReadonlyLiveStore } from '../src/adapters/sqlite-readonly-live-store.js';
import { HarnessError } from '../src/domain/errors.js';
import type { ReadonlyLiveConfig, ReadonlyLiveDispatch } from '../src/domain/readonly-live.js';
import type { ReadonlyLivePort, ReadonlyLiveSnapshot, ReadonlyLiveTransmissionResult } from '../src/ports/readonly-live.js';
import { buildReadonlyMockResponse, hashReadonlyValue } from '../src/policy/readonly-investigation-policy.js';

const ownerId = `os-user:${process.getuid!()}`;
const fakeResult = (request: ReadonlyLiveDispatch): ReadonlyLiveTransmissionResult => {
  const body = JSON.parse(request.requestEnvelope.body) as { input: { content: { text: string }[] }[] };
  const text = buildReadonlyMockResponse(body.input[0]!.content[0]!.text);
  return { text, responseHash: hashReadonlyValue(text), verification: { transport: 'fake', upstreamCalls: 1,
    isolation: 'not_run', credentialAccess: 'not_run' } };
};
const fakePort: ReadonlyLivePort = { mode: 'live', transport: 'codex-cli-broker', transmit: async (request, _signal, before) => {
  before(); return fakeResult(request);
} };
const requestFor = (snapshot: ReadonlyLiveSnapshot) => ({ investigationId: snapshot.task.investigationId, planHash: snapshot.task.plan.planHash });
const remove = async (directory: string): Promise<void> => {
  chmodSync(directory, 0o700);
  for (const item of await readdir(directory, { withFileTypes: true })) if (item.isDirectory()) await remove(join(directory, item.name));
  await rm(directory, { recursive: true, force: true });
};
const setup = async () => {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), 'readonly-live-readiness-'))); chmodSync(directory, 0o700);
  const binary = join(directory, 'PRIVATE_SYNTHETIC_BINARY'); const bytes = Buffer.from('synthetic executable bytes; never executed');
  await writeFile(binary, bytes, { mode: 0o700 });
  const config: ReadonlyLiveConfig = { enabled: true, policyVersion: 'readonly-live-codex-v4', codexPath: binary,
    codexSha256: hashReadonlyValue(bytes), model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 60000, maxResponseBytes: 16384 };
  const store = new SqliteReadonlyLiveStore(join(directory, 'readonly-live.sqlite'));
  const context = { ownerId, now: new Date(Date.now() + 10_000) };
  const service = (port: ReadonlyLivePort = fakePort) => new ReadonlyLiveService(store, port, directory, config);
  const planned = await service().plan('flow', undefined, context);
  service().approve({ ...requestFor(planned), expiresInMinutes: 1 }, context);
  return { directory, binary, bytes, config, context, store, planned, service,
    close: async () => { store.close(); await remove(directory); } };
};
const unconsumed = (snapshot: ReadonlyLiveSnapshot): void => {
  assert.equal(snapshot.attempt, null); assert.equal(snapshot.approvals.length, 1); assert.equal(snapshot.approvals[0]!.usedAt, null);
};
const gate = () => {
  let started!: () => void; let finish!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  return { entered, finish, verifyReady: async () => { started(); await waiting; } };
};

test('missing, changed or unsafe pinned binaries fail before approval consumption or any credential/transport access', async (context) => {
  // Exercise filesystem verification portably, without running a native binary or isolation process.
  context.mock.property(process, 'platform', 'darwin'); context.mock.property(process, 'arch', 'arm64');
  const cases = ['missing', 'changed', 'symlink', ...(process.getuid!() === 0 ? [] : ['unreadable'])];
  for (const mutation of cases) {
    const h = await setup(); let credentials = 0; let upstream = 0;
    const adapter = new RestrictedReadonlyLiveCodex(h.config, h.directory, h.planned.task.investigationId, {
      get credential() { credentials++; return { kind: 'chatgpt' as const, accessToken: 'synthetic.only', accountId: 'synthetic' }; },
      transport: async () => { upstream++; throw new Error('UNEXPECTED_SYNTHETIC_TRANSPORT'); },
    });
    try {
      await adapter.verifyReady();
      if (mutation === 'missing') await rm(h.binary);
      if (mutation === 'changed') await writeFile(h.binary, 'different synthetic bytes');
      if (mutation === 'symlink') {
        const replacement = join(h.directory, 'replacement'); await writeFile(replacement, h.bytes, { mode: 0o700 });
        await rm(h.binary); await symlink(replacement, h.binary);
      }
      if (mutation === 'unreadable') await chmod(h.binary, 0);
      const expected = mutation === 'changed' ? 'CODEX_BINARY_CHANGED' : mutation === 'symlink' ? 'UNSAFE_CODEX_BINARY' : 'READONLY_LIVE_BINARY_UNAVAILABLE';
      await assert.rejects(h.service(adapter).run(requestFor(h.planned), h.context), (error: unknown) => {
        assert.ok(error instanceof HarnessError); assert.equal(error.code, expected);
        assert.doesNotMatch(String(error), /PRIVATE_SYNTHETIC_BINARY|ENOENT|EACCES|readonly-live-readiness/); return true;
      });
      const after = h.store.inspect(h.planned.task.investigationId, h.context);
      unconsumed(after); assert.equal(after.task.status, 'APPROVED'); assert.equal(after.task.plan.planHash, h.planned.task.plan.planHash);
      assert.deepEqual(after.task.plan.configSnapshot, h.config); assert.equal(credentials, 0); assert.equal(upstream, 0);
      await assert.rejects(lstat(join(h.directory, 'readonly-live-runs')), { code: 'ENOENT' });
    } finally { await h.close(); }
  }
});

test('approval expiration while local readiness waits is rechecked with the fresh clock before claim', async (context) => {
  const h = await setup(); const ready = gate(); let transmissions = 0; let now = h.context.now.getTime();
  context.mock.method(Date, 'now', () => now);
  const service = h.service({ ...fakePort, verifyReady: ready.verifyReady,
    transmit: async () => { transmissions++; throw new Error('UNEXPECTED_TRANSMISSION'); } });
  try {
    const running = service.run(requestFor(h.planned), h.context); await ready.entered;
    now += 60_000; ready.finish();
    await assert.rejects(running, { code: 'READONLY_LIVE_APPROVAL_REQUIRED' });
    const after = service.inspect(h.planned.task.investigationId, { ownerId, now: new Date(now) });
    unconsumed(after); assert.equal(after.task.status, 'AWAITING_APPROVAL'); assert.equal(transmissions, 0);
    assert.equal(after.approvals[0]!.revokedAt, new Date(now).toISOString());
  } finally { ready.finish(); await h.close(); }
});

test('store cancellation and AbortSignal during local readiness preserve an unused approval and no attempt', async () => {
  for (const mode of ['store', 'signal'] as const) {
    const h = await setup(); const ready = gate(); const controller = new AbortController(); let transmissions = 0;
    const service = h.service({ ...fakePort, verifyReady: ready.verifyReady,
      transmit: async () => { transmissions++; throw new Error('UNEXPECTED_TRANSMISSION'); } });
    try {
      const running = service.run(requestFor(h.planned), h.context, controller.signal); await ready.entered;
      if (mode === 'store') service.cancel(h.planned.task.investigationId, h.context); else controller.abort();
      ready.finish();
      if (mode === 'store') await assert.rejects(running); else assert.equal((await running).task.status, 'CANCELLED');
      const after = service.inspect(h.planned.task.investigationId, h.context);
      unconsumed(after); assert.equal(after.task.status, 'CANCELLED'); assert.equal(transmissions, 0);
    } finally { ready.finish(); await h.close(); }
  }
});

test('plan and approval remain independent of local readiness; optional in-memory ports retain their behavior', async () => {
  const h = await setup(); let checks = 0;
  const port = { ...fakePort, verifyReady: async () => { checks++; throw new HarnessError('READONLY_LIVE_BINARY_UNAVAILABLE'); } };
  try {
    await rm(h.binary);
    const service = h.service(port); const planned = await service.plan('flow', undefined, h.context);
    const approval = service.approve({ ...requestFor(planned), expiresInMinutes: 1 }, h.context);
    assert.equal(checks, 0); assert.equal(approval.usedAt, null);
    assert.equal(service.inspect(planned.task.investigationId, h.context).task.status, 'APPROVED');
    assert.equal(service.cancel(planned.task.investigationId, h.context).task.status, 'CANCELLED'); assert.equal(checks, 0);
    const reported = await h.service().run(requestFor(h.planned), h.context);
    assert.equal(reported.task.status, 'REPORTED'); assert.equal(reported.report!.verification.transport, 'fake');
    assert.equal(reported.report!.checks.credentialAccess, 'not_run');
    assert.throws(() => h.service({ ...fakePort, verifyReady: true } as unknown as ReadonlyLivePort), { code: 'READONLY_LIVE_INVALID_PORT' });
  } finally { await h.close(); }
});

test('readiness is awaited once before a valid run consumes its approval', async () => {
  const h = await setup(); const ready = gate(); let checks = 0; let transmissions = 0;
  const service = h.service({ ...fakePort, verifyReady: async () => { checks++; await ready.verifyReady(); },
    transmit: async (request, signal, before) => { transmissions++; return fakePort.transmit(request, signal, before); } });
  try {
    const running = service.run(requestFor(h.planned), h.context); await ready.entered;
    unconsumed(service.inspect(h.planned.task.investigationId, h.context)); assert.equal(transmissions, 0);
    ready.finish(); const reported = await running;
    assert.equal(reported.task.status, 'REPORTED'); assert.equal(checks, 1); assert.equal(transmissions, 1);
    assert.notEqual(reported.approvals[0]!.usedAt, null); assert.equal(reported.attempt!.status, 'REPORTED');
  } finally { ready.finish(); await h.close(); }
});
