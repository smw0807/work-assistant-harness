import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SandboxVerificationService } from '../src/application/verify-sandbox.js';
import { HarnessError } from '../src/domain/errors.js';
import {
  SANDBOX_BOUNDARY_CHECKS, SANDBOX_POLICY_VERSION,
  type SandboxBackendIdentity, type SandboxConfig, type SandboxProbeId,
  type SandboxProbeInput, type SandboxProbeResult, type SandboxVerificationReport,
} from '../src/domain/sandbox.js';
import { assertSandboxHost, parseSandboxConfig } from '../src/policy/sandbox-policy.js';
import type { SandboxVerificationPort } from '../src/ports/sandbox.js';

const sandboxConfig: SandboxConfig = {
  enabled: true, backend: 'docker', policyVersion: SANDBOX_POLICY_VERSION,
  dockerPath: '/usr/local/bin/docker', socketPath: '/tmp/synthetic-docker.sock',
  serverVersion: '29.4.3', imageId: `sha256:${'a'.repeat(64)}`, nodeVersion: '24.22.2',
};

const identity: SandboxBackendIdentity = {
  serverVersion: sandboxConfig.serverVersion, imageId: sandboxConfig.imageId,
  imagePlatform: 'linux/arm64', nodeVersion: sandboxConfig.nodeVersion, policyVersion: SANDBOX_POLICY_VERSION,
};

const successfulProbe = (probe: SandboxProbeId): SandboxProbeResult => ({
  probe, termination: probe === 'timeout' ? 'timeout' : probe === 'output' ? 'output_limit' : 'completed',
  exitCode: probe === 'memory' || probe === 'timeout' || probe === 'output' ? 137 : 0,
  stdout: probe === 'boundary'
    ? JSON.stringify({ checks: Object.fromEntries(SANDBOX_BOUNDARY_CHECKS.map((name) => [name, true])) })
    : probe === 'pids' ? JSON.stringify({ limited: true, count: 55 }) : '',
  stopped: true, removed: true, oomKilled: probe === 'memory', failureCode: null,
});

interface FakeBackend extends SandboxVerificationPort {
  preflightCalls: number;
  probes: SandboxProbeId[];
  lastInput: SandboxProbeInput | null;
}

type ProbeMutation = (
  probe: SandboxProbeId, input: SandboxProbeInput, result: SandboxProbeResult,
) => SandboxProbeResult | Promise<SandboxProbeResult>;

const fakeBackend = (options: {
  mutate?: ProbeMutation; preflightError?: string; writePositive?: boolean; omitReadyFor?: 'timeout' | 'output';
} = {}): FakeBackend => ({
  preflightCalls: 0, probes: [], lastInput: null,
  async preflight() {
    this.preflightCalls += 1;
    if (options.preflightError) throw new HarnessError(options.preflightError);
    return identity;
  },
  async runProbe(probe, input) {
    this.probes.push(probe);
    this.lastInput = input;
    if (probe === 'boundary' && options.writePositive !== false) {
      await writeFile(join(input.workspaceRoot, 'positive.txt'), 'synthetic writable workspace\n');
    }
    if ((probe === 'timeout' || probe === 'output') && options.omitReadyFor !== probe) {
      await writeFile(join(input.workspaceRoot, `${probe}-ready.txt`), 'synthetic descendant spawned\n');
    }
    const result = successfulProbe(probe);
    return options.mutate ? options.mutate(probe, input, result) : result;
  },
});

const privateDirectory = async (context: TestContext): Promise<string> => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'harness-sandbox-test-'));
  await chmod(directory, 0o700);
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
};

const verify = async (
  context: TestContext, backend: FakeBackend,
  options: {
    config?: SandboxConfig; platform?: string; architecture?: string; signal?: AbortSignal;
    wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<SandboxVerificationReport> => {
  const service = new SandboxVerificationService(options.config ?? sandboxConfig, backend, {
    platform: options.platform ?? 'darwin', architecture: options.architecture ?? 'arm64',
    wait: options.wait ?? (async () => {}),
  });
  const report = await service.verify(await privateDirectory(context), options.signal);
  assert.equal(report.executionEnabled, false);
  return report;
};

test('sandbox 설정은 고정 backend·정책·이미지 ID와 로컬 socket 경로만 받는다', () => {
  const parsed = parseSandboxConfig(sandboxConfig);
  assert.deepEqual(parsed, sandboxConfig);
  assert.ok(Object.isFrozen(parsed));
  assert.equal(parseSandboxConfig({ ...sandboxConfig, enabled: false }).enabled, false);
  const missingField: Record<string, unknown> = { ...sandboxConfig };
  delete missingField.nodeVersion;
  for (const candidate of [
    null, [], false, missingField,
    { ...sandboxConfig, shell: '/bin/sh' }, { ...sandboxConfig, enabled: 'true' },
    { ...sandboxConfig, backend: 'podman' }, { ...sandboxConfig, policyVersion: 'future-v2' },
    { ...sandboxConfig, dockerPath: '/tmp/docker' }, { ...sandboxConfig, dockerPath: 'docker' },
    { ...sandboxConfig, socketPath: 'tcp://127.0.0.1:2375' },
    { ...sandboxConfig, socketPath: 'ssh://example.invalid/docker' },
    { ...sandboxConfig, socketPath: 'unix:///tmp/docker.sock' },
    { ...sandboxConfig, socketPath: '/tmp/docker.sock,other' },
    { ...sandboxConfig, socketPath: '/tmp/docker socket' },
    { ...sandboxConfig, socketPath: `/tmp/${'x'.repeat(1_024)}` },
    { ...sandboxConfig, imageId: 'node:24-alpine' }, { ...sandboxConfig, imageId: `sha256:${'A'.repeat(64)}` },
    { ...sandboxConfig, serverVersion: 'latest' }, { ...sandboxConfig, nodeVersion: 'v24.22.2' },
  ]) {
    assert.throws(() => parseSandboxConfig(candidate), { code: 'INVALID_SANDBOX_CONFIG' });
  }
});

test('지원하지 않는 OS와 architecture 조합은 거부한다', () => {
  assert.doesNotThrow(() => assertSandboxHost('darwin', 'arm64'));
  for (const [platform, architecture] of [
    ['linux', 'arm64'], ['darwin', 'x64'], ['win32', 'arm64'], ['linux', 'x64'],
  ] as const) {
    assert.throws(() => assertSandboxHost(platform, architecture), { code: 'SANDBOX_UNSUPPORTED_HOST' });
  }
});

test('검증의 성공 경로는 다섯 probe와 전후 canary를 확인해도 실행 권한을 열지 않는다', async (context) => {
  const backend = fakeBackend();
  const waits: number[] = [];
  const report = await verify(context, backend, { wait: async (milliseconds) => { waits.push(milliseconds); } });
  assert.equal(report.status, 'passed');
  assert.equal(report.failureCode, null);
  assert.equal(report.policyVersion, SANDBOX_POLICY_VERSION);
  assert.deepEqual(report.backend, identity);
  assert.equal(backend.preflightCalls, 1);
  assert.deepEqual(backend.probes, ['boundary', 'pids', 'memory', 'timeout', 'output']);
  assert.deepEqual(waits, [3_250]);
  assert.equal(report.checks.length, 9);
  assert.ok(report.checks.every((check) => check.status === 'passed'));
  assert.equal(report.probes.length, 5);
  assert.ok(report.probes.every((probe) => !('stdout' in probe)));
  assert.ok(report.protectedSnapshot);
  assert.equal(report.protectedSnapshot.beforeHash, report.protectedSnapshot.afterHash);
  assert.ok(backend.lastInput);
  assert.equal(backend.lastInput.protectedPaths.length, 4);
  for (const path of backend.lastInput.protectedPaths) assert.match(await readFile(path, 'utf8'), /^synthetic-canary:/);
});

test('비활성·지원 외 호스트·이미지 preflight 실패는 probe를 호출하지 않는다', async (context) => {
  for (const scenario of ['disabled', 'unsupported', 'preflight'] as const) {
    const backend = fakeBackend(scenario === 'preflight' ? { preflightError: 'SANDBOX_UNSAFE_IMAGE' } : {});
    const report = await verify(context, backend, {
      ...(scenario === 'disabled' ? { config: { ...sandboxConfig, enabled: false } } : {}),
      ...(scenario === 'unsupported' ? { platform: 'linux' } : {}),
    });
    assert.equal(report.status, 'blocked', scenario);
    assert.equal(report.failureCode, {
      disabled: 'SANDBOX_DISABLED', unsupported: 'SANDBOX_UNSUPPORTED_HOST', preflight: 'SANDBOX_UNSAFE_IMAGE',
    }[scenario]);
    assert.equal(backend.preflightCalls, scenario === 'preflight' ? 1 : 0);
    assert.deepEqual(backend.probes, []);
    assert.equal(report.backend, null);
    assert.equal(report.checks[0]?.status, 'not_run');
  }
});

test('boundary의 거짓·누락·추가·잘못된 JSON은 후속 probe 전에 중단한다', async (context) => {
  for (const stdout of [
    'not-json', '[]', '{}', JSON.stringify({ checks: {} }),
    JSON.stringify({ checks: { ...Object.fromEntries(SANDBOX_BOUNDARY_CHECKS.map((name) => [name, true])), tcpDenied: false } }),
    JSON.stringify({ checks: { ...Object.fromEntries(SANDBOX_BOUNDARY_CHECKS.map((name) => [name, true])), unknownCheck: true } }),
  ]) {
    const backend = fakeBackend({ mutate: (_probe, _input, result) => ({ ...result, stdout }) });
    const report = await verify(context, backend);
    assert.equal(report.status, 'failed');
    assert.match(report.failureCode ?? '', /^SANDBOX_(?:INVALID_PROBE_OUTPUT|BOUNDARY_FAILED(?:_[A-Z]+)?)$/);
    assert.deepEqual(backend.probes, ['boundary']);
    assert.equal(report.checks.at(-1)?.name, 'sandbox_protected_canaries_unchanged');
    assert.equal(report.checks.at(-1)?.status, 'passed');
  }
});

test('종료나 제거가 확인되지 않은 probe 결과는 성공으로 인정하지 않는다', async (context) => {
  for (const incomplete of [{ stopped: false }, { removed: false }]) {
    const backend = fakeBackend({ mutate: (_probe, _input, result) => ({ ...result, ...incomplete }) });
    const report = await verify(context, backend);
    assert.equal(report.status, 'failed');
    assert.equal(report.failureCode, 'SANDBOX_CLEANUP_UNCONFIRMED');
    assert.deepEqual(backend.probes, ['boundary']);
  }
});

test('PID·OOM·시간·출력 제한의 예상 실패 증거가 없으면 검증을 중단한다', async (context) => {
  const scenarios: { probe: SandboxProbeId; changes: Partial<SandboxProbeResult>; code: string; called: number }[] = [
    { probe: 'pids', changes: { stdout: JSON.stringify({ limited: false, count: 55 }) }, code: 'SANDBOX_PROCESS_LIMIT_NOT_ENFORCED', called: 2 },
    { probe: 'pids', changes: { stdout: JSON.stringify({ limited: true, count: 80 }) }, code: 'SANDBOX_PROCESS_LIMIT_NOT_ENFORCED', called: 2 },
    { probe: 'memory', changes: { oomKilled: false }, code: 'SANDBOX_MEMORY_LIMIT_NOT_ENFORCED', called: 3 },
    { probe: 'memory', changes: { exitCode: 0 }, code: 'SANDBOX_MEMORY_LIMIT_NOT_ENFORCED', called: 3 },
    { probe: 'timeout', changes: { termination: 'completed' }, code: 'SANDBOX_LIMIT_NOT_ENFORCED', called: 4 },
    { probe: 'timeout', changes: { exitCode: 0 }, code: 'SANDBOX_LIMIT_NOT_ENFORCED', called: 4 },
    { probe: 'timeout', changes: { oomKilled: true }, code: 'SANDBOX_LIMIT_NOT_ENFORCED', called: 4 },
    { probe: 'timeout', changes: { stopped: false }, code: 'SANDBOX_CLEANUP_UNCONFIRMED', called: 4 },
    { probe: 'output', changes: { termination: 'completed' }, code: 'SANDBOX_LIMIT_NOT_ENFORCED', called: 5 },
    { probe: 'output', changes: { exitCode: 0 }, code: 'SANDBOX_LIMIT_NOT_ENFORCED', called: 5 },
    { probe: 'output', changes: { oomKilled: true }, code: 'SANDBOX_LIMIT_NOT_ENFORCED', called: 5 },
  ];
  for (const scenario of scenarios) {
    const backend = fakeBackend({ mutate: (probe, _input, result) => probe === scenario.probe ? { ...result, ...scenario.changes } : result });
    const report = await verify(context, backend);
    assert.equal(report.status, 'failed', scenario.probe);
    assert.equal(report.failureCode, scenario.code);
    assert.equal(backend.probes.length, scenario.called);
  }
});

test('예상 종료 결과와 함께 backend 오류를 보고한 probe는 모두 거부한다', async (context) => {
  const probes = ['boundary', 'pids', 'memory', 'timeout', 'output'] satisfies SandboxProbeId[];
  for (const [index, failedProbe] of probes.entries()) {
    const backend = fakeBackend({ mutate: (probe, _input, result) => probe === failedProbe
      ? { ...result, failureCode: 'SYNTHETIC_BACKEND_FAILURE' } : result });
    const report = await verify(context, backend);
    assert.equal(report.status, 'failed');
    assert.equal(report.failureCode, 'SANDBOX_PROBE_FAILED');
    assert.equal(backend.probes.length, index + 1);
  }
});

test('예상 시간·출력 종료와 137 코드여도 하위 프로세스 시작 증거가 없으면 실패한다', async (context) => {
  for (const probe of ['timeout', 'output'] as const) {
    const backend = fakeBackend({ omitReadyFor: probe });
    const report = await verify(context, backend);
    assert.equal(report.status, 'failed');
    assert.equal(report.failureCode, 'SANDBOX_DESCENDANT_NOT_STARTED');
    assert.equal(backend.probes.at(-1), probe);
    assert.equal(report.probes.at(-1)?.exitCode, 137);
  }
});

test('지연 하위 프로세스의 marker와 양성 대조군 누락은 검증 실패다', async (context) => {
  for (const marker of ['timeout-child.txt', 'output-child.txt']) {
    const backend = fakeBackend();
    const report = await verify(context, backend, { wait: async () => {
      assert.ok(backend.lastInput);
      await writeFile(join(backend.lastInput.workspaceRoot, marker), 'synthetic survivor\n');
    } });
    assert.equal(report.status, 'failed');
    assert.equal(report.failureCode, 'SANDBOX_DESCENDANT_SURVIVED');
    assert.equal(report.checks.find((check) => check.name === 'sandbox_descendants_stopped')?.status, 'failed');
  }
  const missingPositive = await verify(context, fakeBackend({ writePositive: false }));
  assert.equal(missingPositive.status, 'failed');
});

test('probe가 성공을 보고해도 호스트 보호 canary 변경을 발견하면 실패로 덮어쓴다', async (context) => {
  const backend = fakeBackend({ mutate: async (probe, input, result) => {
    if (probe === 'pids') {
      assert.ok(input.protectedPaths[0]);
      await writeFile(input.protectedPaths[0], 'synthetic mutation\n');
    }
    return result;
  } });
  const report = await verify(context, backend);
  assert.equal(report.status, 'failed');
  assert.equal(report.failureCode, 'SANDBOX_PROTECTED_FILES_CHANGED');
  assert.equal(report.checks.at(-1)?.status, 'failed');
  assert.equal(report.checks.at(-1)?.name, 'sandbox_protected_canaries_unchanged');
});

test('검증 전과 probe 사이의 취소는 다음 작업을 시작하지 않는다', async (context) => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const untouched = fakeBackend();
  const before = await verify(context, untouched, { signal: alreadyAborted.signal });
  assert.equal(before.failureCode, 'SANDBOX_ABORTED');
  assert.equal(untouched.preflightCalls, 0);
  assert.deepEqual(untouched.probes, []);

  const controller = new AbortController();
  const backend = fakeBackend({ mutate: (_probe, _input, result) => { controller.abort(); return result; } });
  const during = await verify(context, backend, { signal: controller.signal });
  assert.equal(during.status, 'failed');
  assert.equal(during.failureCode, 'SANDBOX_ABORTED');
  assert.deepEqual(backend.probes, ['boundary']);
});

const runCli = (args: string[]) => spawnSync(process.execPath, [resolve('dist/src/cli/main.js'), ...args], {
  encoding: 'utf8', timeout: 10_000, maxBuffer: 256_000,
  env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
});

test('오프라인 CLI 기본값은 Docker를 실행하지 않고 blocked 보고서를 비공개 경로에 보존한다', async (context) => {
  const directory = await privateDirectory(context);
  const result = runCli(['sandbox-check', '--data-dir', directory]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout) as SandboxVerificationReport & { reportPath: string; artifactDirectory: string };
  assert.equal(report.status, 'blocked');
  assert.equal(report.failureCode, 'SANDBOX_DISABLED');
  assert.equal(report.executionEnabled, false);
  assert.equal(report.backend, null);
  const saved = JSON.parse(await readFile(report.reportPath, 'utf8')) as SandboxVerificationReport;
  assert.equal(saved.failureCode, 'SANDBOX_DISABLED');
  assert.equal(saved.executionEnabled, false);
  assert.deepEqual((await readdir(report.artifactDirectory)).sort(), ['docker-control', 'report.json']);
});

test('sandbox CLI의 잘못된 옵션과 source 중첩 경로 및 run 명령을 거부한다', async (context) => {
  const directory = await privateDirectory(context);
  for (const flags of [
    ['--unknown', 'value'], ['--config'], ['--config', '--data-dir'],
    ['--data-dir', directory, '--data-dir', directory], ['--enable', 'true'],
  ]) {
    const result = runCli(['sandbox-check', ...flags]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /INVALID_ARGUMENTS/);
    assert.equal(result.stdout, '');
  }
  const overlaps = runCli(['sandbox-check', '--data-dir', process.cwd()]);
  assert.equal(overlaps.status, 1);
  assert.match(overlaps.stderr, /DATA_DIRECTORY_OVERLAPS_SOURCE/);
  const unsupported = runCli(['run', 'unused', '--data-dir', directory]);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /UNKNOWN_COMMAND/);
});

test('sandbox 보고서 디렉터리의 symlink를 거부하고 외부 경로를 보존한다', async (context) => {
  const directory = await privateDirectory(context);
  const outside = await privateDirectory(context);
  const sentinel = join(outside, 'sentinel.txt');
  await writeFile(sentinel, 'synthetic external directory\n');
  await symlink(outside, join(directory, 'sandbox-checks'));
  const result = runCli(['sandbox-check', '--data-dir', directory]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNSAFE_SANDBOX_DIRECTORY/);
  assert.equal(result.stdout, '');
  assert.deepEqual(await readdir(outside), ['sentinel.txt']);
  assert.equal(await readFile(sentinel, 'utf8'), 'synthetic external directory\n');
});
