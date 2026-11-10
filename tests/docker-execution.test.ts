import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  type DockerCommandOptions, type DockerCommandResult, type DockerCommandRunner, type DockerSandboxFileSystem,
} from '../src/adapters/docker-sandbox.js';
import { DockerIsolatedExecution } from '../src/adapters/docker-execution.js';
import { createExecutionPolicy, getExecutionCommand } from '../src/policy/execution-policy.js';
import type { SandboxConfig } from '../src/domain/sandbox.js';
import { HarnessError } from '../src/domain/errors.js';
import type { ExecutionContainerIntent, ExecutionLifecycleHooks } from '../src/domain/execution.js';

type JsonObject = Record<string, unknown>;
const imageId = `sha256:${'b'.repeat(64)}`;
const containerId = 'a'.repeat(64);
const imageEnvironment = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NODE_VERSION=24.22.2', 'YARN_VERSION=1.22.22',
];
const hasCode = (code: string) => (error: unknown): boolean => error instanceof HarnessError && error.code === code;
const success = (stdout = ''): DockerCommandResult => ({ termination: 'completed', exitCode: 0, stdout });

interface FakeOptions {
  workspaceName?: string;
  daemon?: JsonObject;
  image?: JsonObject;
  mutateContainer?: (container: JsonObject) => void;
  execute?: DockerCommandResult;
  create?: DockerCommandResult;
  createAbsent?: boolean;
  removalFails?: boolean;
  killFails?: boolean;
  inspectFails?: boolean;
  runnerThrows?: boolean;
}

const createFakeDocker = (settings: FakeOptions = {}) => {
  const calls: { arguments: string[]; options: DockerCommandOptions }[] = [];
  let container: JsonObject | null = null;
  const runner: DockerCommandRunner = async (arguments_, options) => {
    calls.push({ arguments: [...arguments_], options });
    if (settings.runnerThrows) throw new Error('synthetic-secret-daemon-error');
    const argumentsWithoutControl = arguments_.slice(4);
    const operation = argumentsWithoutControl[0];
    const option = (name: string): string => {
      const index = argumentsWithoutControl.indexOf(name);
      return argumentsWithoutControl[index + 1] ?? '';
    };
    if (operation === 'info') return success(JSON.stringify({
      ServerVersion: '29.4.3', OSType: 'linux', Architecture: 'aarch64', CgroupVersion: '2', MemoryLimit: true,
      SwapLimit: true, PidsLimit: true, SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'], ...settings.daemon,
    }));
    if (operation === 'image') return success(JSON.stringify([{
      Id: imageId, Os: 'linux', Architecture: 'arm64', Config: { Env: imageEnvironment, Volumes: null, OnBuild: null }, ...settings.image,
    }]));
    if (operation === 'create') {
      const mount = option('--mount');
      const workspace = /src=([^,]+),/.exec(mount)?.[1];
      const command = argumentsWithoutControl.slice(argumentsWithoutControl.indexOf(imageId) + 1);
      container = {
        Id: containerId, Name: `/${option('--name')}`, Image: imageId,
        State: { Status: 'created', Running: false, Paused: false, Restarting: false, Dead: false, OOMKilled: false, ExitCode: 0 },
        Config: {
          User: '1000:1000', WorkingDir: '/workspace', Hostname: 'harness-execution', OpenStdin: false, Tty: false,
          Entrypoint: ['/usr/local/bin/node'], Cmd: command,
          Env: [...imageEnvironment, 'HOME=/tmp', 'LANG=C.UTF-8', 'NODE_OPTIONS='], Volumes: null, OnBuild: null,
          Healthcheck: { Test: ['NONE'] }, Labels: Object.fromEntries(argumentsWithoutControl.flatMap((argument, index) =>
            argument === '--label' ? [argumentsWithoutControl[index + 1]!.split('=')] : [])),
        },
        HostConfig: {
          NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null,
          SecurityOpt: ['no-new-privileges=true'], IpcMode: 'none', CgroupnsMode: 'private', Init: true, PidsLimit: 64,
          Memory: 134_217_728, MemorySwap: 134_217_728, NanoCpus: 500_000_000, AutoRemove: false, PublishAllPorts: false,
          PidMode: '', UTSMode: '', UsernsMode: '', CgroupParent: '', Runtime: 'runc', OomKillDisable: null,
          Binds: null, Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16777216,mode=1777' }, VolumesFrom: null, Devices: [], DeviceRequests: null, DeviceCgroupRules: null, PortBindings: {},
          ExtraHosts: null, Links: null, GroupAdd: null, Dns: [], DnsOptions: [], DnsSearch: [],
          LogConfig: { Type: 'none', Config: {} }, RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
          Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }, { Name: 'nofile', Soft: 128, Hard: 128 }, { Name: 'fsize', Soft: 4_194_304, Hard: 4_194_304 }],
          Mounts: [{ Type: 'bind', Source: workspace, Target: '/workspace', ReadOnly: true, BindOptions: { Propagation: 'rprivate', NonRecursive: true } }],
        },
        Mounts: [{ Type: 'bind', Source: workspace, Destination: '/workspace', RW: false, Propagation: 'rprivate' }],
      };
      if (settings.createAbsent) container = null;
      return settings.create ?? success(`${containerId}\n`);
    }
    if (operation === 'container' && argumentsWithoutControl[1] === 'inspect') {
      if (container === null || settings.inspectFails) return { ...success(), exitCode: 1 };
      const inspected = structuredClone(container);
      settings.mutateContainer?.(inspected);
      return success(JSON.stringify([inspected]));
    }
    if (operation === 'container' && argumentsWithoutControl[1] === 'ls') return success(container === null ? '' : `${containerId}\n`);
    if (operation === 'start') {
      assert.ok(container);
      const executed = settings.execute ?? success('{"checks":{}}\n');
      container.State = {
        Status: executed.termination === 'completed' ? 'exited' : 'running', Running: executed.termination !== 'completed',
        Paused: false, Restarting: false, Dead: false, OOMKilled: executed.exitCode === 137,
        ExitCode: executed.exitCode ?? 0,
      };
      return executed;
    }
    if (operation === 'kill') {
      assert.ok(container);
      if (settings.killFails) return { ...success(), exitCode: 1 };
      container.State = { Status: 'exited', Running: false, Paused: false, Restarting: false, Dead: false, OOMKilled: false, ExitCode: 137 };
      return success(containerId);
    }
    if (operation === 'rm') {
      if (settings.removalFails) return { ...success(), exitCode: 1 };
      container = null;
      return success(containerId);
    }
    throw new Error(`unexpected fake command: ${operation}`);
  };
  return { runner, calls };
};

const prepare = async (options: FakeOptions = {}) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hsb-')));
  const control = path.join(temporary, 'control');
  const workspace = path.join(temporary, options.workspaceName ?? 'workspace');
  await mkdir(control, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o755 });
  await mkdir(path.join(workspace, 'checks'), { mode: 0o755 });
  await mkdir(path.join(workspace, 'src'), { mode: 0o755 });
  for (const filePath of ['README.md', 'src/message.mjs', 'checks/check.mjs', 'checks/timeout.mjs', 'checks/output.mjs']) {
    await writeFile(path.join(workspace, filePath), 'console.log(1);\n', { mode: 0o444 });
  }
  await chmod(path.join(workspace, 'checks'), 0o555);
  await chmod(path.join(workspace, 'src'), 0o555);
  await chmod(workspace, 0o555);
  const socketPath = path.join(temporary, 'docker.sock');
  await writeFile(socketPath, 'synthetic socket metadata fixture');
  // 오프라인 단위 검사는 실제 소켓 서버 없이 메타데이터 포트만 모의한다.
  const fileSystem: DockerSandboxFileSystem = {
    canonical: (filePath) => realpath(filePath),
    entries: (directory) => readdir(directory),
    metadata: async (filePath) => {
      const metadata = await lstat(filePath);
      return filePath === socketPath ? {
        isSocket: () => true, isDirectory: () => false, uid: metadata.uid, mode: metadata.mode,
      } : metadata;
    },
  };
  const config: SandboxConfig = {
    enabled: true, backend: 'docker', policyVersion: 'docker-probe-v1', dockerPath: '/usr/local/bin/docker', socketPath,
    serverVersion: '29.4.3', imageId, nodeVersion: '24.22.2',
  };
  const fake = createFakeDocker(options);
  const executor = new DockerIsolatedExecution(config, control, fake.runner, fileSystem);
  const policy = createExecutionPolicy(config);
  const close = async (): Promise<void> => {
    await chmod(workspace, 0o755);
    await chmod(path.join(workspace, 'checks'), 0o755);
    await chmod(path.join(workspace, 'src'), 0o755);
    await rm(temporary, { recursive: true, force: true });
  };
  return { executor, workspace, config, policy, control, temporary, fake, fileSystem, close };
};

test('실행 preflight는 매번 빈 private Docker config와 승인된 정책·이미지를 다시 확인한다', async () => {
  const fixture = await prepare();
  try {
    await fixture.executor.preflight(fixture.config, fixture.policy);
    await fixture.executor.preflight(fixture.config, fixture.policy);
    assert.equal(fixture.fake.calls.length, 4);
    for (const call of fixture.fake.calls) {
      assert.deepEqual(call.arguments.slice(0, 4), ['--config', fixture.control, '--host', `unix://${fixture.config.socketPath}`]);
      assert.deepEqual(call.options.environment, { LANG: 'C.UTF-8', TZ: 'UTC', HOME: fixture.control, PATH: '/usr/bin:/bin' });
      assert.equal(call.options.executable, '/usr/local/bin/docker');
    }
    await assert.rejects(fixture.executor.preflight(fixture.config, { ...fixture.policy, configHash: 'c'.repeat(64) }), hasCode('EXECUTION_POLICY_MISMATCH'));
    const blocked = await fixture.executor.execute(getExecutionCommand('synthetic-check-v1'), fixture.workspace);
    assert.equal(blocked.failureCode, 'EXECUTION_PREFLIGHT_REQUIRED');
    await writeFile(path.join(fixture.control, 'config.json'), '{}');
    await assert.rejects(fixture.executor.preflight(fixture.config, fixture.policy), hasCode('SANDBOX_UNSAFE_CONTROL_PATH'));
    assert.equal(fixture.fake.calls.length, 4);
  } finally { await fixture.close(); }
});

test('preflight 없는 실행과 변조된 registry 명령은 create 전에 거부한다', async () => {
  const fixture = await prepare();
  try {
    assert.equal((await fixture.executor.execute(getExecutionCommand('synthetic-check-v1'), fixture.workspace)).failureCode, 'EXECUTION_PREFLIGHT_REQUIRED');
    await fixture.executor.preflight(fixture.config, fixture.policy);
    for (const update of [
      { argv: ['--eval', 'process.exit(0)'] }, { executable: '/bin/sh' }, { timeoutMs: 100_000 },
      { network: 'host' }, { environment: { HOME: '/tmp', LANG: 'C.UTF-8', NODE_OPTIONS: '--require=/host/a' } },
    ]) {
      await fixture.executor.preflight(fixture.config, fixture.policy);
      const command = { ...getExecutionCommand('synthetic-check-v1'), ...update };
      const result = await fixture.executor.execute(command as ReturnType<typeof getExecutionCommand>, fixture.workspace);
      assert.equal(result.failureCode, 'UNREGISTERED_EXECUTION_COMMAND');
    }
    assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'create'), false);
  } finally { await fixture.close(); }
});

test('고정 실행은 readonly workspace 하나와 제한된 tmpfs만 노출하고 출력 원문을 반환하지 않는다', async () => {
  const fixture = await prepare({ workspaceName: 'Application Support', execute: success('synthetic-private-output') });
  try {
    await fixture.executor.preflight(fixture.config, fixture.policy);
    const result = await fixture.executor.execute(getExecutionCommand('synthetic-check-v1'), fixture.workspace);
    assert.equal(result.termination, 'completed');
    assert.equal(result.failureCode, null);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stopped, true);
    assert.equal(result.removed, true);
    assert.equal(result.outputBytes, Buffer.byteLength('synthetic-private-output'));
    assert.match(result.outputHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(result).includes('synthetic-private-output'), false);
    const commands = fixture.fake.calls.map((call) => call.arguments.slice(4));
    const create = commands.find((arguments_) => arguments_[0] === 'create');
    assert.ok(create);
    assert.equal(create.filter((argument) => argument === '--mount').length, 1);
    assert.ok(create.includes(`type=bind,src=${fixture.workspace},dst=/workspace,readonly,bind-propagation=rprivate,bind-recursive=disabled`));
    assert.ok(create.includes('/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777'));
    assert.deepEqual(create.slice(-3), ['--no-addons', '--disable-proto=throw', '/workspace/checks/check.mjs']);
    assert.deepEqual(commands.find((arguments_) => arguments_[0] === 'start'), ['start', '--attach', containerId]);
    const start = fixture.fake.calls.find((call) => call.arguments[4] === 'start');
    assert.equal(start?.options.maxBytes, 16_384);
    assert.equal(start?.options.timeoutMs, 3_000);
  } finally { await fixture.close(); }
});

test('실효 readonly·tmpfs·network·권한·명령 변조는 start 전에 거부한다', async () => {
  const mutations: ((container: JsonObject) => void)[] = [
    (container) => { (container.HostConfig as JsonObject).NetworkMode = 'host'; },
    (container) => { (container.HostConfig as JsonObject).Privileged = true; },
    (container) => { (container.HostConfig as JsonObject).ReadonlyRootfs = false; },
    (container) => { (container.HostConfig as JsonObject).PidsLimit = 0; },
    (container) => { (container.HostConfig as JsonObject).Memory = 0; },
    (container) => { (container.HostConfig as JsonObject).MemorySwap = -1; },
    (container) => { (container.HostConfig as JsonObject).CapAdd = ['SYS_ADMIN']; },
    (container) => { (container.HostConfig as JsonObject).Binds = ['/host:/host']; },
    (container) => { (container.HostConfig as JsonObject).SecurityOpt = ['seccomp=unconfined']; },
    (container) => { (container.HostConfig as JsonObject).Tmpfs = {}; },
    (container) => { (container.HostConfig as JsonObject).Tmpfs = { '/tmp': 'rw,size=167772160' }; },
    (container) => { (container.HostConfig as JsonObject).Tmpfs = { '/tmp': 'rw,noexec,nosuid,nodev,size=16777216,mode=1777', '/host': 'rw' }; },
    (container) => { ((container.HostConfig as JsonObject).Mounts as JsonObject[])[0]!.ReadOnly = false; },
    (container) => { (container.Mounts as JsonObject[])[0]!.RW = true; },
    (container) => { (container.Mounts as JsonObject[]).push({ Type: 'volume', Destination: '/host' }); },
    (container) => { (container.Config as JsonObject).Cmd = ['/bin/sh']; },
    (container) => { (container.Config as JsonObject).Env = [...imageEnvironment, 'TOKEN=synthetic-secret']; },
    (container) => { (container.Config as JsonObject).User = '0'; },
  ];
  for (const mutateContainer of mutations) {
    const fixture = await prepare({ mutateContainer });
    try {
      await fixture.executor.preflight(fixture.config, fixture.policy);
      const result = await fixture.executor.execute(getExecutionCommand('synthetic-check-v1'), fixture.workspace);
      assert.equal(result.failureCode, 'EXECUTION_EFFECTIVE_POLICY_MISMATCH');
      assert.equal(result.removed, true);
      assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'start'), false);
    } finally { await fixture.close(); }
  }
});

test('timeout·출력 초과·abort는 CLI 종료와 별도로 소유 컨테이너 전체를 정지·삭제한다', async () => {
  for (const termination of ['timeout', 'output_limit', 'aborted'] as const) {
    const fixture = await prepare({ execute: { termination, exitCode: null, stdout: 'bounded-output' } });
    try {
      await fixture.executor.preflight(fixture.config, fixture.policy);
      const result = await fixture.executor.execute(getExecutionCommand('synthetic-timeout-v1'), fixture.workspace);
      assert.equal(result.termination, termination);
      assert.equal(result.exitCode, 137);
      assert.equal(result.stopped, true);
      assert.equal(result.removed, true);
      const kill = fixture.fake.calls.find((call) => call.arguments[4] === 'kill');
      assert.deepEqual(kill?.arguments.slice(4), ['kill', '--signal', 'KILL', containerId]);
      assert.equal(kill?.options.signal, undefined);
    } finally { await fixture.close(); }
  }
});

test('생성 RPC가 불확실해도 소유 컨테이너를 정리하며 단순 부재만으로 정리 성공을 주장하지 않는다', async () => {
  for (const createAbsent of [false, true]) {
    const fixture = await prepare({ create: { termination: 'timeout', exitCode: null, stdout: '' }, createAbsent });
    try {
      await fixture.executor.preflight(fixture.config, fixture.policy);
      const result = await fixture.executor.execute(getExecutionCommand('synthetic-check-v1'), fixture.workspace);
      assert.equal(result.failureCode, createAbsent ? 'EXECUTION_CLEANUP_UNCONFIRMED' : 'EXECUTION_CREATE_FAILED');
      assert.equal(result.stopped, !createAbsent);
      assert.equal(result.removed, !createAbsent);
      assert.match(result.containerName ?? '', /^harness-execution-[a-f0-9-]{36}$/);
      assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'start'), false);
    } finally { await fixture.close(); }
  }
});

test('label 소유권·정지·제거 확인 실패를 성공으로 보고하지 않는다', async () => {
  for (const options of [
    { removalFails: true }, { inspectFails: true },
    { killFails: true, execute: { termination: 'timeout' as const, exitCode: null, stdout: '' } },
    { mutateContainer: (container: JsonObject) => { (container.Config as JsonObject).Labels = {}; } },
  ]) {
    const fixture = await prepare(options);
    try {
      await fixture.executor.preflight(fixture.config, fixture.policy);
      const result = await fixture.executor.execute(getExecutionCommand('synthetic-check-v1'), fixture.workspace);
      assert.equal(result.failureCode, 'EXECUTION_CLEANUP_UNCONFIRMED');
      assert.equal(result.stopped, false);
      assert.equal(result.removed, false);
      if (options.mutateContainer) assert.equal(fixture.fake.calls.some((call) => ['start', 'kill', 'rm'].includes(call.arguments[4] ?? '')), false);
    } finally { await fixture.close(); }
  }
});

test('symlink·hardlink·Git·쓰기 가능한 view·파일 상한 초과는 create 전에 거부한다', async () => {
  const modifications = [
    async (root: string) => { await symlink('/etc/passwd', path.join(root, 'escape')); },
    async (root: string) => { await link(path.join(root, 'checks', 'check.mjs'), path.join(root, 'hardlink')); },
    async (root: string) => { await writeFile(path.join(root, '.git'), 'gitdir: /synthetic/protected'); },
    async (root: string) => { await writeFile(path.join(root, 'writable'), 'data', { mode: 0o644 }); },
    async (root: string) => { await writeFile(path.join(root, 'large'), Buffer.alloc(65_537), { mode: 0o444 }); },
  ];
  for (const modify of modifications) {
    const fixture = await prepare();
    try {
      await fixture.executor.preflight(fixture.config, fixture.policy);
      await chmod(fixture.workspace, 0o755);
      await modify(fixture.workspace);
      await chmod(fixture.workspace, 0o555);
      const result = await fixture.executor.execute(getExecutionCommand('synthetic-check-v1'), fixture.workspace);
      assert.equal(result.failureCode, 'EXECUTION_UNSAFE_WORKSPACE');
      assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'create'), false);
    } finally { await fixture.close(); }
  }
});

test('취소 신호와 Docker 오류 원문은 외부 실행이나 비밀 출력으로 이어지지 않는다', async () => {
  const fixture = await prepare();
  try {
    const abort = new AbortController(); abort.abort();
    const result = await fixture.executor.execute(getExecutionCommand('synthetic-check-v1'), fixture.workspace, abort.signal);
    assert.equal(result.termination, 'aborted');
    assert.equal(fixture.fake.calls.length, 0);
  } finally { await fixture.close(); }
  const failed = await prepare({ runnerThrows: true });
  try {
    await assert.rejects(failed.executor.preflight(failed.config, failed.policy), (error: unknown) => !String(error).includes('synthetic-secret'));
  } finally { await failed.close(); }
});

test('container intent와 full ID는 생성 RPC 전후에 기록하고 start 전에 다시 승인 세대를 확인한다', async () => {
  const fixture = await prepare();
  try {
    await fixture.executor.preflight(fixture.config, fixture.policy);
    const phases: string[] = [];
    let savedIntent: ExecutionContainerIntent | null = null;
    const runId = '12345678-1234-4234-8234-123456789abc';
    const hooks: ExecutionLifecycleHooks = {
      runId,
      beforeCreate: async (intent) => {
        assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'create'), false);
        assert.equal(intent.id, null);
        assert.equal(intent.runId, runId);
        savedIntent = intent;
        phases.push('intent');
      },
      created: async (intent) => {
        assert.equal(intent.id, containerId);
        assert.equal(intent.name, savedIntent?.name);
        assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'create'), true);
        savedIntent = intent;
        phases.push('created');
      },
      beforeStart: async () => {
        assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'start'), false);
        phases.push('fenced');
      },
      finished: async (result) => {
        assert.equal(result.removed, true);
        assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'rm'), true);
        phases.push('finished');
      },
    };
    const result = await fixture.executor.execute(getExecutionCommand('synthetic-check-v1'), fixture.workspace, undefined, hooks);
    assert.equal(result.failureCode, null);
    assert.deepEqual(phases, ['intent', 'created', 'fenced', 'finished']);
    const create = fixture.fake.calls.find((call) => call.arguments[4] === 'create');
    assert.ok(create?.arguments.includes(`work-assistant-harness.run=${runId}`));
  } finally { await fixture.close(); }
});

test('lifecycle 저장 실패와 start 직전 취소는 새 실행을 막고 이미 생성한 container를 먼저 정리한다', async () => {
  for (const failurePhase of ['beforeCreate', 'created', 'beforeStart', 'finished'] as const) {
    const fixture = await prepare();
    try {
      await fixture.executor.preflight(fixture.config, fixture.policy);
      let finished = false;
      const record = async (phase: string): Promise<void> => {
        if (phase === failurePhase) throw new Error('synthetic-private-store-error');
      };
      const hooks: ExecutionLifecycleHooks = {
        runId: '12345678-1234-4234-8234-123456789abc',
        beforeCreate: async () => { await record('beforeCreate'); },
        created: async () => { await record('created'); },
        beforeStart: async () => { await record('beforeStart'); },
        finished: async (result) => {
          finished = true;
          assert.equal(result.removed, true);
          if (failurePhase !== 'beforeCreate') assert.ok(fixture.fake.calls.some((call) => call.arguments[4] === 'rm'));
          await record('finished');
        },
      };
      const result = await fixture.executor.execute(getExecutionCommand('synthetic-check-v1'), fixture.workspace, undefined, hooks);
      assert.equal(result.failureCode, 'EXECUTION_LIFECYCLE_RECORD_FAILED');
      assert.equal(result.removed, true);
      assert.equal(finished, true);
      assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'create'), failurePhase !== 'beforeCreate');
      assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'start'), failurePhase === 'finished');
      assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
    } finally { await fixture.close(); }
  }
  const fixture = await prepare();
  try {
    await fixture.executor.preflight(fixture.config, fixture.policy);
    const abort = new AbortController();
    let recordedId: string | null = null;
    const hooks: ExecutionLifecycleHooks = {
      runId: '12345678-1234-4234-8234-123456789abc',
      beforeCreate: async () => {},
      created: async (intent) => { recordedId = intent.id; abort.abort(); },
      beforeStart: async () => {},
      finished: async () => {},
    };
    const result = await fixture.executor.execute(getExecutionCommand('synthetic-check-v1'), fixture.workspace, abort.signal, hooks);
    assert.equal(recordedId, containerId);
    assert.equal(result.termination, 'aborted');
    assert.equal(result.removed, true);
    assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'start'), false);
  } finally { await fixture.close(); }
});
