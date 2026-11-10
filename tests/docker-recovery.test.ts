import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DockerIsolatedExecution, type DockerExecutionCommandRunner } from '../src/adapters/docker-execution.js';
import type { DockerSandboxFileSystem } from '../src/adapters/docker-sandbox.js';
import type { ExecutionContainerIntent } from '../src/domain/execution.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import { createExecutionPolicy } from '../src/policy/execution-policy.js';

type JsonObject = Record<string, unknown>;
const imageId = `sha256:${'b'.repeat(64)}`;
const containerId = 'a'.repeat(64);
const token = '23456789-1234-4234-8234-123456789abc';
const runId = '12345678-1234-4234-8234-123456789abc';
const intent: ExecutionContainerIntent = {
  runId, name: `harness-execution-${token}`, token, id: containerId, commandId: 'synthetic-check-v1',
};
const config: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker',
  socketPath: '/synthetic/docker.sock', serverVersion: '29.4.3', imageId, nodeVersion: '24.22.2',
};
const fileSystem: DockerSandboxFileSystem = {
  canonical: async (filePath) => filePath,
  entries: async () => [],
  metadata: async (filePath) => ({
    isSocket: () => filePath === config.socketPath, isDirectory: () => filePath === '/synthetic/control',
    mode: 0o700, uid: process.getuid?.() ?? 0,
  }),
};

interface RecoveryOptions {
  status?: 'running' | 'created' | 'exited';
  absent?: boolean;
  mutate?: (container: JsonObject) => void;
  replaceOnKill?: boolean;
  killFails?: boolean;
  removalFails?: boolean;
  inspectFails?: boolean;
  nameHidden?: boolean;
  daemonFails?: boolean;
}

const prepare = (options: RecoveryOptions = {}) => {
  const calls: string[][] = [];
  let container: JsonObject | null = options.absent ? null : {
    Id: containerId, Name: `/${intent.name}`,
    Config: { Labels: { 'work-assistant-harness.execution': token, 'work-assistant-harness.run': runId } },
    State: {
      Status: options.status ?? 'running', Running: (options.status ?? 'running') === 'running',
      Paused: false, Restarting: false, Dead: false, OOMKilled: false, ExitCode: options.status === 'exited' ? 3 : 0,
    },
  };
  if (container !== null) options.mutate?.(container);
  const runner: DockerExecutionCommandRunner = async (arguments_) => {
    const command = arguments_.slice(4);
    calls.push(command);
    const success = (stdout = '') => ({ termination: 'completed' as const, exitCode: 0, stdout });
    if (command[0] === 'info') {
      if (options.daemonFails) throw new Error('synthetic-private-daemon-error');
      return success(JSON.stringify({
        ServerVersion: '29.4.3', OSType: 'linux', Architecture: 'aarch64', CgroupVersion: '2', MemoryLimit: true,
        SwapLimit: true, PidsLimit: true, SecurityOptions: ['name=seccomp,profile=builtin'],
      }));
    }
    if (command[0] === 'image') return success(JSON.stringify([{
      Id: imageId, Os: 'linux', Architecture: 'arm64', Config: {
        Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NODE_VERSION=24.22.2'],
        Volumes: null, OnBuild: null,
      },
    }]));
    if (command[0] === 'container' && command[1] === 'inspect') {
      if (options.inspectFails) throw new Error('synthetic-private-inspection-error');
      if (options.nameHidden) return { ...success(), exitCode: 1 };
      return container === null ? { ...success(), exitCode: 1 } : success(JSON.stringify([container]));
    }
    if (command[0] === 'container' && command[1] === 'ls') {
      if (options.nameHidden && command.some((argument) => argument.startsWith('name='))) return success();
      return success(container === null ? '' : `${String(container.Id)}\n`);
    }
    if (command[0] === 'kill') {
      assert.ok(container);
      assert.deepEqual(command, ['kill', '--signal', 'KILL', containerId]);
      if (options.killFails) return { ...success(), exitCode: 1 };
      container.State = { Status: 'exited', Running: false, Paused: false, Restarting: false, OOMKilled: false, ExitCode: 137 };
      if (options.replaceOnKill) container.Id = 'c'.repeat(64);
      return success();
    }
    if (command[0] === 'rm') {
      assert.deepEqual(command, ['rm', '--force', containerId]);
      if (options.removalFails) return { ...success(), exitCode: 1 };
      container = null;
      return success();
    }
    throw new Error('recovery must not create or execute');
  };
  const executor = new DockerIsolatedExecution(config, '/synthetic/control', runner, fileSystem);
  const preflight = async () => { await executor.preflight(config, createExecutionPolicy(config)); };
  return { executor, calls, preflight };
};

test('복구는 매번 성공한 preflight를 요구하며 새 명령·patch·container를 실행하지 않는다', async () => {
  const fixture = prepare();
  const blocked = await fixture.executor.recover(intent);
  assert.equal(blocked.failureCode, 'EXECUTION_PREFLIGHT_REQUIRED');
  assert.deepEqual(fixture.calls, []);
  await fixture.preflight();
  assert.equal((await fixture.executor.recover(intent)).removed, true);
  assert.equal((await fixture.executor.recover(intent)).failureCode, 'EXECUTION_PREFLIGHT_REQUIRED');
  assert.equal(fixture.calls.some((command) => ['create', 'start', 'exec', 'run'].includes(command[0] ?? '')), false);
  const unavailable = prepare({ daemonFails: true });
  await assert.rejects(unavailable.preflight(), (error: unknown) => !String(error).includes('synthetic-private'));
  assert.equal((await unavailable.executor.recover(intent)).failureCode, 'EXECUTION_PREFLIGHT_REQUIRED');
  assert.equal(unavailable.calls.some((command) => ['kill', 'rm'].includes(command[0] ?? '')), false);
});

test('running·created·exited 소유 container는 full ID로 정지·제거하고 반복 복구는 멱등이다', async () => {
  for (const status of ['running', 'created', 'exited'] as const) {
    const fixture = prepare({ status });
    await fixture.preflight();
    const cleanup = await fixture.executor.recover(intent);
    assert.deepEqual(cleanup, {
      found: true, stopped: true, removed: true, exitCode: status === 'running' ? 137 : status === 'exited' ? 3 : 0,
      oomKilled: false, failureCode: null,
    });
    assert.equal(fixture.calls.some((command) => command[0] === 'kill'), status === 'running');
    await fixture.preflight();
    assert.deepEqual(await fixture.executor.recover(intent), {
      found: false, stopped: true, removed: true, exitCode: null, oomKilled: false, failureCode: null,
    });
    assert.equal(fixture.calls.filter((command) => command[0] === 'rm').length, 1);
  }
});

test('생성 응답을 잃은 intent는 label 소유권으로 발견해 정리하되 부재만으로 늦은 생성을 배제하지 않는다', async () => {
  const found = prepare();
  await found.preflight();
  assert.equal((await found.executor.recover({ ...intent, id: null })).removed, true);
  const absent = prepare({ absent: true });
  await absent.preflight();
  assert.deepEqual(await absent.executor.recover({ ...intent, id: null }), {
    found: false, stopped: false, removed: false, exitCode: null, oomKilled: false, failureCode: 'EXECUTION_CREATE_OUTCOME_UNKNOWN',
  });
  assert.equal(absent.calls.some((command) => ['kill', 'rm'].includes(command[0] ?? '')), false);
});

test('이름·token·Run label·full ID 불일치와 정리 도중 ID 교체는 다른 container를 건드리지 않는다', async () => {
  const mutations: ((container: JsonObject) => void)[] = [
    (container) => { container.Name = '/other'; },
    (container) => { ((container.Config as JsonObject).Labels as JsonObject)['work-assistant-harness.execution'] = 'other'; },
    (container) => { ((container.Config as JsonObject).Labels as JsonObject)['work-assistant-harness.run'] = 'other'; },
    (container) => { container.Id = 'c'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const fixture = prepare({ mutate });
    await fixture.preflight();
    const cleanup = await fixture.executor.recover(intent);
    assert.equal(cleanup.failureCode, 'EXECUTION_CONTAINER_OWNERSHIP_MISMATCH');
    assert.equal(cleanup.stopped, false);
    assert.equal(cleanup.removed, false);
    assert.equal(fixture.calls.some((command) => ['kill', 'rm'].includes(command[0] ?? '')), false);
  }
  const replaced = prepare({ replaceOnKill: true });
  await replaced.preflight();
  assert.equal((await replaced.executor.recover({ ...intent, id: null })).failureCode, 'EXECUTION_CONTAINER_OWNERSHIP_MISMATCH');
  assert.equal(replaced.calls.filter((command) => command[0] === 'kill').length, 1);
  assert.equal(replaced.calls.some((command) => command[0] === 'rm'), false);
  const renamed = prepare({ nameHidden: true });
  await renamed.preflight();
  const cleanup = await renamed.executor.recover(intent);
  assert.equal(cleanup.stopped, false);
  assert.equal(cleanup.removed, false);
  assert.equal(renamed.calls.some((command) => command.includes(`id=${containerId}`)), true);
  assert.equal(renamed.calls.some((command) => ['kill', 'rm'].includes(command[0] ?? '')), false);
});

test('복구 intent 변조·daemon 오류·정지 실패·제거 실패는 정리 성공으로 보고하지 않는다', async () => {
  for (const change of [
    { name: 'arbitrary' }, { runId: '--privileged' }, { token: 'other' }, { id: 'short' }, { commandId: 'arbitrary' },
  ]) {
    const fixture = prepare();
    await fixture.preflight();
    const cleanup = await fixture.executor.recover({ ...intent, ...change } as ExecutionContainerIntent);
    assert.equal(cleanup.stopped, false);
    assert.equal(cleanup.removed, false);
    assert.equal(fixture.calls.some((command) => command[0] === 'container'), false);
  }
  for (const options of [{ killFails: true }, { removalFails: true }, { inspectFails: true }]) {
    const fixture = prepare(options);
    await fixture.preflight();
    const cleanup = await fixture.executor.recover(intent);
    assert.equal(cleanup.stopped, false);
    assert.equal(cleanup.removed, false);
    assert.notEqual(cleanup.failureCode, null);
    assert.equal(JSON.stringify(cleanup).includes('synthetic-private'), false);
  }
});
