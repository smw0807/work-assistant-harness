import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DockerSandboxVerifier, type DockerCommandOptions, type DockerCommandResult, type DockerCommandRunner,
  type DockerSandboxFileSystem,
} from '../src/adapters/docker-sandbox.js';
import type { SandboxConfig, SandboxProbeInput } from '../src/domain/sandbox.js';
import { HarnessError } from '../src/domain/errors.js';

type JsonObject = Record<string, unknown>;
const imageId = `sha256:${'b'.repeat(64)}`;
const containerId = 'a'.repeat(64);
const imageEnvironment = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NODE_VERSION=24.22.2', 'YARN_VERSION=1.22.22',
];
const hasCode = (code: string) => (error: unknown): boolean => error instanceof HarnessError && error.code === code;
const success = (stdout = ''): DockerCommandResult => ({ termination: 'completed', exitCode: 0, stdout });

interface FakeOptions {
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
      ServerVersion: '29.4.1', OSType: 'linux', Architecture: 'aarch64', CgroupVersion: '2', MemoryLimit: true,
      SwapLimit: true, PidsLimit: true, SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'], ...settings.daemon,
    }));
    if (operation === 'image') return success(JSON.stringify([{
      Id: imageId, Os: 'linux', Architecture: 'arm64', Config: { Env: imageEnvironment, Volumes: null, OnBuild: null }, ...settings.image,
    }]));
    if (operation === 'create') {
      const token = option('--label').split('=')[1];
      const mount = option('--mount');
      const workspace = /src=([^,]+),/.exec(mount)?.[1];
      const source = argumentsWithoutControl.at(-1);
      container = {
        Id: containerId, Name: `/${option('--name')}`, Image: imageId,
        State: { Status: 'created', Running: false, Paused: false, Restarting: false, Dead: false, OOMKilled: false, ExitCode: 0 },
        Config: {
          User: '1000:1000', WorkingDir: '/workspace', Hostname: 'harness-probe', OpenStdin: false, Tty: false,
          Entrypoint: ['/usr/local/bin/node'], Cmd: ['--input-type=module', '--eval', source],
          Env: [...imageEnvironment, 'HOME=/workspace', 'LANG=C.UTF-8', 'NODE_OPTIONS='], Volumes: null, OnBuild: null,
          Healthcheck: { Test: ['NONE'] }, Labels: { 'work-assistant-harness.probe': token },
        },
        HostConfig: {
          NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null,
          SecurityOpt: ['no-new-privileges=true'], IpcMode: 'none', CgroupnsMode: 'private', Init: true, PidsLimit: 64,
          Memory: 134_217_728, MemorySwap: 134_217_728, NanoCpus: 500_000_000, AutoRemove: false, PublishAllPorts: false,
          PidMode: '', UTSMode: '', UsernsMode: '', CgroupParent: '', Runtime: 'runc', OomKillDisable: null,
          Binds: null, VolumesFrom: null, Devices: [], DeviceRequests: null, DeviceCgroupRules: null, PortBindings: {},
          ExtraHosts: null, Links: null, GroupAdd: null, Dns: [], DnsOptions: [], DnsSearch: [],
          LogConfig: { Type: 'none', Config: {} }, RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
          Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }, { Name: 'nofile', Soft: 128, Hard: 128 }, { Name: 'fsize', Soft: 4_194_304, Hard: 4_194_304 }],
          Mounts: [{ Type: 'bind', Source: workspace, Target: '/workspace', BindOptions: { Propagation: 'rprivate', NonRecursive: true } }],
        },
        Mounts: [{ Type: 'bind', Source: workspace, Destination: '/workspace', RW: true, Propagation: 'rprivate' }],
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
  const workspace = path.join(temporary, 'workspace');
  const protectedPath = path.join(temporary, 'protected.txt');
  await mkdir(control, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o777 });
  await writeFile(protectedPath, 'synthetic protected data');
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
    serverVersion: '29.4.1', imageId, nodeVersion: '24.22.2',
  };
  const fake = createFakeDocker(options);
  const input: SandboxProbeInput = { workspaceRoot: workspace, protectedPaths: [protectedPath] };
  const verifier = new DockerSandboxVerifier(config, control, fake.runner, fileSystem);
  const close = async (): Promise<void> => {
    await rm(temporary, { recursive: true, force: true });
  };
  return { verifier, input, config, control, temporary, fake, fileSystem, close };
};

test('Docker 진단은 고정 로컬 socket·빈 config·명시적 환경으로 버전과 이미지를 확인한다', async () => {
  const fixture = await prepare();
  try {
    assert.deepEqual(await fixture.verifier.preflight(), {
      serverVersion: '29.4.1', imageId, imagePlatform: 'linux/arm64', nodeVersion: '24.22.2', policyVersion: 'docker-probe-v1',
    });
    assert.equal(fixture.fake.calls.length, 2);
    for (const call of fixture.fake.calls) {
      assert.deepEqual(call.arguments.slice(0, 4), ['--config', fixture.control, '--host', `unix://${fixture.config.socketPath}`]);
      assert.deepEqual(call.options.environment, { LANG: 'C.UTF-8', TZ: 'UTC', HOME: fixture.control, PATH: '/usr/bin:/bin' });
      assert.equal(call.options.executable, '/usr/local/bin/docker');
      assert.equal(call.options.maxBytes, 65_536);
      assert.equal(call.options.timeoutMs, 10_000);
    }
  } finally { await fixture.close(); }
});

test('disabled·unpinned image·다른 실행 파일과 socket symlink·공유 config 권한은 Docker 호출 전 거부한다', async () => {
  const fixture = await prepare();
  try {
    for (const update of [{ enabled: false }, { imageId: 'node:latest' }, { dockerPath: '/bin/sh' }]) {
      await assert.rejects(new DockerSandboxVerifier({ ...fixture.config, ...update }, fixture.control, fixture.fake.runner).preflight(), hasCode('SANDBOX_INVALID_CONFIG'));
    }
    const link = path.join(fixture.temporary, 'socket-link');
    await symlink(fixture.config.socketPath, link);
    await assert.rejects(new DockerSandboxVerifier({ ...fixture.config, socketPath: link }, fixture.control, fixture.fake.runner).preflight(), hasCode('SANDBOX_UNSAFE_CONTROL_PATH'));
    await chmod(fixture.control, 0o755);
    await assert.rejects(fixture.verifier.preflight(), hasCode('SANDBOX_UNSAFE_CONTROL_PATH'));
    assert.equal(fixture.fake.calls.length, 0);
  } finally { await fixture.close(); }
});

test('실제 파일시스템은 일반 파일 socket을 거부하고 기존 Docker 설정도 허용하지 않는다', async () => {
  const fixture = await prepare();
  try {
    const actualMetadata = new DockerSandboxVerifier(fixture.config, fixture.control, fixture.fake.runner);
    await assert.rejects(actualMetadata.preflight(), hasCode('SANDBOX_UNSAFE_CONTROL_PATH'));
    await writeFile(path.join(fixture.control, 'config.json'), JSON.stringify({ proxies: { default: { httpProxy: 'http://proxy.example.invalid:8080' } } }));
    await assert.rejects(fixture.verifier.preflight(), hasCode('SANDBOX_UNSAFE_CONTROL_PATH'));
    assert.equal(fixture.fake.calls.length, 0);
  } finally { await fixture.close(); }
});

test('daemon 버전·cgroup·자원 제한·seccomp가 정책과 다르면 실행을 열지 않는다', async () => {
  for (const daemon of [
    { ServerVersion: '30.0.0' }, { OSType: 'windows' }, { Architecture: 'x86_64' }, { CgroupVersion: '1' },
    { MemoryLimit: false }, { SwapLimit: false }, { PidsLimit: false }, { SecurityOptions: ['name=seccomp,profile=unconfined'] },
  ]) {
    const fixture = await prepare({ daemon });
    try {
      await assert.rejects(fixture.verifier.preflight(), hasCode('SANDBOX_UNSUPPORTED_BACKEND'));
      assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'create'), false);
    } finally { await fixture.close(); }
  }
});

test('image의 volume·onbuild·추가 환경·중복 환경·다른 ID·플랫폼을 거부한다', async () => {
  for (const image of [
    { Id: `sha256:${'c'.repeat(64)}` }, { Os: 'windows' }, { Architecture: 'amd64' },
    { Config: { Env: imageEnvironment, Volumes: { '/host': {} } } },
    { Config: { Env: imageEnvironment, OnBuild: ['RUN malicious'] } },
    { Config: { Env: [...imageEnvironment, 'TOKEN=synthetic-secret'] } },
    { Config: { Env: [...imageEnvironment, 'NODE_VERSION=24.22.2'] } },
    { Config: { Env: imageEnvironment.filter((entry) => !entry.startsWith('NODE_VERSION=')) } },
  ]) {
    const fixture = await prepare({ image });
    try { await assert.rejects(fixture.verifier.preflight(), hasCode('SANDBOX_UNSAFE_IMAGE')); }
    finally { await fixture.close(); }
  }
});

test('고정 probe만 create하고 유효 정책 확인 후 start하며 소유 container만 정리한다', async () => {
  const fixture = await prepare();
  try {
    const result = await fixture.verifier.runProbe('boundary', fixture.input);
    assert.equal(result.termination, 'completed');
    assert.equal(result.failureCode, null);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stopped, true);
    assert.equal(result.removed, true);
    const commands = fixture.fake.calls.map((call) => call.arguments.slice(4));
    assert.deepEqual(commands.map((arguments_) => arguments_[0]), ['info', 'image', 'create', 'container', 'start', 'container', 'rm', 'container']);
    const create = commands.find((arguments_) => arguments_[0] === 'create');
    assert.ok(create);
    assert.ok(create.includes('never'));
    assert.ok(create.includes('--read-only'));
    assert.ok(create.includes('--init'));
    assert.equal(create.filter((argument) => argument === '--mount').length, 1);
    assert.ok(create.includes(`type=bind,src=${fixture.input.workspaceRoot},dst=/workspace,bind-propagation=rprivate,bind-recursive=disabled`));
    assert.equal(create.some((argument) => argument.includes('synthetic-secret')), false);
    assert.deepEqual(commands.find((arguments_) => arguments_[0] === 'start'), ['start', '--attach', containerId]);
    assert.deepEqual(commands.find((arguments_) => arguments_[0] === 'rm'), ['rm', '--force', containerId]);
  } finally { await fixture.close(); }
});

test('효과적 정책의 network·mount·권한·자원·명령 변조는 start 전에 거부한다', async () => {
  const mutations: ((container: JsonObject) => void)[] = [
    (container) => { (container.HostConfig as JsonObject).NetworkMode = 'host'; },
    (container) => { (container.HostConfig as JsonObject).Privileged = true; },
    (container) => { (container.HostConfig as JsonObject).ReadonlyRootfs = false; },
    (container) => { (container.HostConfig as JsonObject).PidsLimit = 0; },
    (container) => { (container.HostConfig as JsonObject).Memory = 0; },
    (container) => { (container.HostConfig as JsonObject).CapAdd = ['SYS_ADMIN']; },
    (container) => { (container.HostConfig as JsonObject).Binds = ['/host:/host']; },
    (container) => { (container.HostConfig as JsonObject).PidMode = 'host'; },
    (container) => { (container.HostConfig as JsonObject).SecurityOpt = ['seccomp=unconfined']; },
    (container) => { (container.HostConfig as JsonObject).Mounts = []; },
    (container) => { (container.Config as JsonObject).Cmd = ['/bin/sh']; },
    (container) => { (container.Config as JsonObject).Env = [...imageEnvironment, 'TOKEN=synthetic-secret']; },
    (container) => { (container.Config as JsonObject).User = '0'; },
    (container) => { (container.Config as JsonObject).Healthcheck = { Test: ['CMD', '/bin/sh'] }; },
    (container) => { (container.Mounts as JsonObject[]).push({ Type: 'volume', Destination: '/host' }); },
  ];
  for (const mutateContainer of mutations) {
    const fixture = await prepare({ mutateContainer });
    try {
      const result = await fixture.verifier.runProbe('boundary', fixture.input);
      assert.equal(result.termination, 'failed');
      assert.equal(result.failureCode, 'SANDBOX_EFFECTIVE_POLICY_MISMATCH');
      assert.equal(result.removed, true);
      assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'start'), false);
    } finally { await fixture.close(); }
  }
});

test('소유 label 불일치 container는 실행·kill·삭제하지 않고 정리 미확인으로 실패한다', async () => {
  const fixture = await prepare({ mutateContainer: (container) => { (container.Config as JsonObject).Labels = {}; } });
  try {
    const result = await fixture.verifier.runProbe('boundary', fixture.input);
    assert.equal(result.failureCode, 'SANDBOX_CLEANUP_UNCONFIRMED');
    assert.equal(result.stopped, false);
    assert.equal(result.removed, false);
    assert.equal(fixture.fake.calls.some((call) => ['start', 'kill', 'rm'].includes(call.arguments[4] ?? '')), false);
  } finally { await fixture.close(); }
});

test('timeout·출력 초과·abort는 CLI 결과 뒤 container 전체 kill과 종료·삭제 확인을 요구한다', async () => {
  for (const termination of ['timeout', 'output_limit', 'aborted'] as const) {
    const fixture = await prepare({ execute: { termination, exitCode: null, stdout: 'bounded-output' } });
    try {
      const result = await fixture.verifier.runProbe(termination === 'output_limit' ? 'output' : 'timeout', fixture.input);
      assert.equal(result.termination, termination);
      assert.equal(result.stopped, true);
      assert.equal(result.removed, true);
      const kill = fixture.fake.calls.find((call) => call.arguments[4] === 'kill');
      assert.deepEqual(kill?.arguments.slice(4), ['kill', '--signal', 'KILL', containerId]);
      const start = fixture.fake.calls.find((call) => call.arguments[4] === 'start');
      assert.equal(start?.options.maxBytes, 16_384);
      assert.equal(start?.options.timeoutMs, 1_500);
      assert.equal(kill?.options.signal, undefined);
    } finally { await fixture.close(); }
  }
});

test('memory probe의 OOM 상태와 종료코드를 보존하고 다른 진단에는 10초 상한을 적용한다', async () => {
  const fixture = await prepare({ execute: { termination: 'completed', exitCode: 137, stdout: '' } });
  try {
    const result = await fixture.verifier.runProbe('memory', fixture.input);
    assert.equal(result.oomKilled, true);
    assert.equal(result.exitCode, 137);
    assert.equal(result.removed, true);
    assert.equal(fixture.fake.calls.find((call) => call.arguments[4] === 'start')?.options.timeoutMs, 10_000);
  } finally { await fixture.close(); }
});

test('create timeout으로 ID 출력을 잃어도 무작위 이름과 label로 소유 container를 찾아 제거한다', async () => {
  const fixture = await prepare({ create: { termination: 'timeout', exitCode: null, stdout: '' } });
  try {
    const result = await fixture.verifier.runProbe('boundary', fixture.input);
    assert.equal(result.termination, 'failed');
    assert.equal(result.failureCode, 'SANDBOX_CREATE_FAILED');
    assert.equal(result.removed, true);
    assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'start'), false);
    assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'rm'), true);
  } finally { await fixture.close(); }
});

test('생성 응답이 불확실하고 현재 부재만 확인되면 정리 완료로 단정하지 않는다', async () => {
  const fixture = await prepare({ create: { termination: 'timeout', exitCode: null, stdout: '' }, createAbsent: true });
  try {
    const result = await fixture.verifier.runProbe('boundary', fixture.input);
    assert.equal(result.termination, 'failed');
    assert.equal(result.failureCode, 'SANDBOX_CLEANUP_UNCONFIRMED');
    assert.equal(result.stopped, false);
    assert.equal(result.removed, false);
    assert.match(result.containerName ?? '', /^harness-probe-[a-f0-9-]{36}$/);
    assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'start'), false);
  } finally { await fixture.close(); }
});

test('kill·inspect·삭제 확인 실패를 성공으로 보고하지 않는다', async () => {
  for (const options of [
    { removalFails: true }, { inspectFails: true },
    { killFails: true, execute: { termination: 'timeout' as const, exitCode: null, stdout: '' } },
  ]) {
    const fixture = await prepare(options);
    try {
      const result = await fixture.verifier.runProbe('timeout', fixture.input);
      assert.equal(result.termination, 'failed');
      assert.equal(result.failureCode, 'SANDBOX_CLEANUP_UNCONFIRMED');
      assert.equal(result.stopped, false);
      assert.equal(result.removed, false);
    } finally { await fixture.close(); }
  }
});

test('취소된 요청은 Docker를 호출하지 않으며 protected 경로 겹침과 workspace symlink를 거부한다', async () => {
  const fixture = await prepare();
  try {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await fixture.verifier.runProbe('boundary', fixture.input, controller.signal);
    assert.equal(cancelled.termination, 'aborted');
    assert.equal(fixture.fake.calls.length, 0);
    const overlap = await fixture.verifier.runProbe('boundary', { ...fixture.input, protectedPaths: [fixture.input.workspaceRoot] });
    assert.equal(overlap.failureCode, 'SANDBOX_UNSAFE_WORKSPACE');
    const link = path.join(fixture.temporary, 'workspace-link');
    await symlink(fixture.input.workspaceRoot, link);
    const symbolic = await fixture.verifier.runProbe('boundary', { ...fixture.input, workspaceRoot: link });
    assert.equal(symbolic.failureCode, 'SANDBOX_UNSAFE_WORKSPACE');
    assert.equal(fixture.fake.calls.some((call) => call.arguments[4] === 'create'), false);
  } finally { await fixture.close(); }
});

test('Docker 오류 본문·원래 예외를 결과와 오류 코드에 노출하지 않는다', async () => {
  const fixture = await prepare({ runnerThrows: true });
  try {
    const result = await fixture.verifier.runProbe('boundary', fixture.input);
    assert.equal(result.failureCode, 'SANDBOX_DOCKER_COMMAND_FAILED');
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
    assert.equal(result.stdout, '');
  } finally { await fixture.close(); }
});
