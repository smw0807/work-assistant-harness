import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HarnessError } from '../domain/errors.js';
import { SANDBOX_LIMITS } from '../domain/sandbox.js';
import type {
  SandboxBackendIdentity, SandboxConfig, SandboxProbeId, SandboxProbeInput, SandboxProbeResult,
} from '../domain/sandbox.js';
import type { SandboxVerificationPort } from '../ports/sandbox.js';
import { createSandboxProbeSource } from './sandbox-probes.js';

type CommandTermination = SandboxProbeResult['termination'];

export interface DockerCommandOptions {
  executable: string;
  environment: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface DockerCommandResult {
  termination: CommandTermination;
  exitCode: number | null;
  stdout: string;
}

export type DockerCommandRunner = (arguments_: string[], options: DockerCommandOptions) => Promise<DockerCommandResult>;

export interface DockerSandboxFileSystem {
  canonical(filePath: string): Promise<string>;
  metadata(filePath: string): Promise<{ isDirectory(): boolean; isSocket(): boolean; mode: number; uid: number }>;
  entries(directory: string): Promise<string[]>;
}

const hostFileSystem: DockerSandboxFileSystem = {
  canonical: (filePath) => realpath(filePath),
  metadata: (filePath) => lstat(filePath),
  entries: (directory) => readdir(directory),
};

const imagePattern = /^sha256:[a-f0-9]{64}$/;
const containerPattern = /^[a-f0-9]{64}$/;
const metadataBytes = 65_536;
const labelKey = 'work-assistant-harness.probe';
const imagePath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEmpty = (value: unknown): boolean => value === undefined || value === null
  || (Array.isArray(value) ? value.length === 0 : isRecord(value) && Object.keys(value).length === 0);
const sameStrings = (value: unknown, expected: string[]): boolean => Array.isArray(value)
  && value.length === expected.length && value.every((item: unknown, index) => item === expected[index]);
const overlaps = (left: string, right: string): boolean => {
  const difference = path.relative(left, right);
  return difference === '' || (!difference.startsWith(`..${path.sep}`) && difference !== '..' && !path.isAbsolute(difference));
};
const parseObject = (output: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(output);
    if (isRecord(parsed)) return parsed;
  } catch { /* 신뢰하지 않는 daemon 출력은 오류 메시지에 포함하지 않는다. */ }
  throw new HarnessError('SANDBOX_INVALID_METADATA');
};
const parseInspection = (output: string): Record<string, unknown> => {
  let parsed: unknown;
  try { parsed = JSON.parse(output) as unknown; } catch { throw new HarnessError('SANDBOX_INVALID_METADATA'); }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) throw new HarnessError('SANDBOX_INVALID_METADATA');
  return parsed[0];
};

/** Docker CLI 종료와 별도로 컨테이너를 종료하고 정지 여부를 확인한다. */
const runDockerCommand: DockerCommandRunner = async (arguments_, options) => {
  if (options.signal?.aborted) return { termination: 'aborted', exitCode: null, stdout: '' };
  return new Promise((resolve) => {
    const child = spawn(options.executable, arguments_, {
      shell: false, env: options.environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let termination: CommandTermination = 'completed';
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    let finished = false;
    const stop = (reason: CommandTermination): void => {
      if (termination === 'completed') termination = reason;
      child.kill('SIGKILL');
    };
    const abort = (): void => { stop('aborted'); };
    const timeout = setTimeout(() => { stop('timeout'); }, options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunk: Buffer, stdout: boolean): void => {
      const remaining = Math.max(0, options.maxBytes - totalBytes);
      totalBytes += chunk.length;
      if (stdout && remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (totalBytes > options.maxBytes) stop('output_limit');
    };
    child.stdout.on('data', (chunk: Buffer) => { collect(chunk, true); });
    child.stderr.on('data', (chunk: Buffer) => { collect(chunk, false); });
    const finish = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      resolve({ termination, exitCode, stdout: Buffer.concat(chunks).toString('utf8') });
    };
    child.once('error', () => { termination = 'failed'; finish(null); });
    child.once('close', (code) => { finish(code); });
    if (options.signal?.aborted) abort();
  });
};

interface OwnedContainer {
  id: string;
  inspection: Record<string, unknown>;
}

interface CleanupResult {
  found: boolean;
  stopped: boolean;
  removed: boolean;
  oomKilled: boolean;
  exitCode: number | null;
}

/** 고정 합성 probe만 Docker에 전달하며 저장소의 명령은 받지 않는다. */
export class DockerSandboxVerifier implements SandboxVerificationPort {
  private verified = false;
  private readonly environment: Record<string, string>;

  constructor(
    private readonly config: SandboxConfig,
    private readonly controlDirectory: string,
    private readonly runner: DockerCommandRunner = runDockerCommand,
    private readonly fileSystem: DockerSandboxFileSystem = hostFileSystem,
  ) {
    this.environment = { LANG: 'C.UTF-8', TZ: 'UTC', HOME: controlDirectory, PATH: '/usr/bin:/bin' };
  }

  async preflight(): Promise<SandboxBackendIdentity> {
    this.verified = false;
    if (!this.config.enabled || this.config.backend !== 'docker' || this.config.policyVersion !== 'docker-probe-v1'
      || this.config.dockerPath !== '/usr/local/bin/docker' || !imagePattern.test(this.config.imageId)
      || !/^\d+\.\d+\.\d+$/.test(this.config.serverVersion) || !/^\d+\.\d+\.\d+$/.test(this.config.nodeVersion)) {
      throw new HarnessError('SANDBOX_INVALID_CONFIG');
    }
    try {
      if (!path.isAbsolute(this.config.socketPath) || !path.isAbsolute(this.controlDirectory)
        || (await this.fileSystem.canonical(this.config.socketPath)) !== this.config.socketPath
        || !(await this.fileSystem.metadata(this.config.socketPath)).isSocket()
        || (await this.fileSystem.canonical(this.controlDirectory)) !== this.controlDirectory) throw new Error();
      const directory = await this.fileSystem.metadata(this.controlDirectory);
      if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()
        || (await this.fileSystem.entries(this.controlDirectory)).length !== 0) throw new Error();
    } catch { throw new HarnessError('SANDBOX_UNSAFE_CONTROL_PATH'); }
    const information = await this.metadata(['info', '--format', '{"ServerVersion":{{json .ServerVersion}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}},"CgroupVersion":{{json .CgroupVersion}},"MemoryLimit":{{json .MemoryLimit}},"SwapLimit":{{json .SwapLimit}},"PidsLimit":{{json .PidsLimit}},"SecurityOptions":{{json .SecurityOptions}}}']);
    const daemon = parseObject(information.stdout);
    if (daemon.ServerVersion !== this.config.serverVersion || daemon.OSType !== 'linux' || daemon.Architecture !== 'aarch64'
      || daemon.CgroupVersion !== '2' || daemon.MemoryLimit !== true || daemon.SwapLimit !== true || daemon.PidsLimit !== true
      || !Array.isArray(daemon.SecurityOptions) || !daemon.SecurityOptions.some((option: unknown) => typeof option === 'string' && /^name=seccomp,profile=builtin$/.test(option))) {
      throw new HarnessError('SANDBOX_UNSUPPORTED_BACKEND');
    }
    const image = parseInspection((await this.metadata(['image', 'inspect', this.config.imageId])).stdout);
    const imageConfig = image.Config;
    if (image.Id !== this.config.imageId || image.Os !== 'linux' || image.Architecture !== 'arm64' || !isRecord(imageConfig)
      || !isEmpty(imageConfig.Volumes) || !isEmpty(imageConfig.OnBuild) || !this.validEnvironment(imageConfig.Env, false)) {
      throw new HarnessError('SANDBOX_UNSAFE_IMAGE');
    }
    this.verified = true;
    return {
      serverVersion: this.config.serverVersion, imageId: this.config.imageId, imagePlatform: 'linux/arm64',
      nodeVersion: this.config.nodeVersion, policyVersion: 'docker-probe-v1',
    };
  }

  async runProbe(probe: SandboxProbeId, input: SandboxProbeInput, signal?: AbortSignal): Promise<SandboxProbeResult> {
    const result: SandboxProbeResult = {
      probe, termination: 'failed', exitCode: null, stdout: '', stopped: true, removed: true, oomKilled: false, failureCode: null,
    };
    if (signal?.aborted) return { ...result, termination: 'aborted' };
    if (!['boundary', 'pids', 'memory', 'timeout', 'output'].includes(probe)) return { ...result, failureCode: 'SANDBOX_UNKNOWN_PROBE' };
    const token = randomUUID();
    const name = `harness-probe-${token}`;
    let creationAttempted = false;
    let creationConfirmed = false;
    try {
      if (!this.verified) await this.preflight();
      const workspace = await this.validateWorkspace(input);
      const source = createSandboxProbeSource(probe, input, this.config.nodeVersion);
      if (signal?.aborted) return { ...result, termination: 'aborted' };
      creationAttempted = true;
      result.containerName = name;
      const created = await this.command(this.createArguments(name, token, workspace, source), SANDBOX_LIMITS.metadataTimeoutMs, metadataBytes, signal);
      if (created.termination !== 'completed' || created.exitCode !== 0 || !containerPattern.test(created.stdout.trim())) {
        throw new HarnessError('SANDBOX_CREATE_FAILED');
      }
      creationConfirmed = true;
      const owned = await this.inspectOwned(name, token);
      if (owned === null || owned.id !== created.stdout.trim()) throw new HarnessError('SANDBOX_CONTAINER_ID_MISMATCH');
      this.verifyCreatedContainer(owned.inspection, workspace, source);
      const timeoutMs = probe === 'timeout' || probe === 'output' ? SANDBOX_LIMITS.timeoutMs : SANDBOX_LIMITS.metadataTimeoutMs;
      const executed = await this.command(['start', '--attach', owned.id], timeoutMs, SANDBOX_LIMITS.outputBytes, signal);
      result.termination = executed.termination;
      result.stdout = executed.stdout;
      result.exitCode = executed.exitCode;
      if (executed.termination === 'failed') result.failureCode = 'SANDBOX_START_FAILED';
    } catch (error: unknown) {
      result.termination = signal?.aborted ? 'aborted' : 'failed';
      result.failureCode = error instanceof HarnessError ? error.code : 'SANDBOX_PROBE_FAILED';
    } finally {
      if (creationAttempted) {
        try {
          const cleanup = await this.cleanup(name, token);
          // 생성 RPC가 불확실하면 현재 부재만으로 늦은 생성 가능성을 배제하지 않는다.
          const confirmed = creationConfirmed || cleanup.found;
          result.stopped = confirmed && cleanup.stopped;
          result.removed = confirmed && cleanup.removed;
          result.oomKilled = cleanup.oomKilled;
          result.exitCode = cleanup.exitCode ?? result.exitCode;
          if (!confirmed) {
            result.termination = 'failed';
            result.failureCode = 'SANDBOX_CLEANUP_UNCONFIRMED';
          }
        } catch {
          result.stopped = false;
          result.removed = false;
          result.termination = 'failed';
          result.failureCode = 'SANDBOX_CLEANUP_UNCONFIRMED';
        }
      }
    }
    return result;
  }

  private async validateWorkspace(input: SandboxProbeInput): Promise<string> {
    const workspace = path.resolve(input.workspaceRoot);
    try {
      if (!path.isAbsolute(input.workspaceRoot) || workspace !== input.workspaceRoot || workspace === path.parse(workspace).root
        || (await this.fileSystem.canonical(workspace)) !== workspace || !(await this.fileSystem.metadata(workspace)).isDirectory()
        || overlaps(workspace, this.controlDirectory) || overlaps(this.controlDirectory, workspace)) throw new Error();
      for (const protectedPath of input.protectedPaths) {
        if (!path.isAbsolute(protectedPath)) throw new Error();
        const canonical = await this.fileSystem.canonical(protectedPath);
        if (overlaps(workspace, canonical) || overlaps(canonical, workspace)) throw new Error();
      }
    } catch { throw new HarnessError('SANDBOX_UNSAFE_WORKSPACE'); }
    return workspace;
  }

  private createArguments(name: string, token: string, workspace: string, source: string): string[] {
    if (workspace.includes(',') || workspace.includes('\n') || workspace.includes('\r')) throw new HarnessError('SANDBOX_UNSAFE_WORKSPACE');
    return [
      'create', '--pull', 'never', '--name', name, '--label', `${labelKey}=${token}`,
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--user', '1000:1000', '--ipc', 'none', '--pids-limit', String(SANDBOX_LIMITS.pids),
      '--memory', String(SANDBOX_LIMITS.memoryBytes), '--memory-swap', String(SANDBOX_LIMITS.memoryBytes),
      '--cpus', '0.5', '--cgroupns', 'private', '--init', '--no-healthcheck', '--log-driver', 'none', '--restart', 'no',
      '--ulimit', 'core=0:0', '--ulimit', 'nofile=128:128', '--ulimit', 'fsize=4194304:4194304',
      '--hostname', 'harness-probe', '--workdir', '/workspace',
      '--env', 'HOME=/workspace', '--env', 'LANG=C.UTF-8', '--env', 'NODE_OPTIONS=',
      '--mount', `type=bind,src=${workspace},dst=/workspace,bind-propagation=rprivate,bind-recursive=disabled`,
      '--entrypoint', '/usr/local/bin/node', this.config.imageId, '--input-type=module', '--eval', source,
    ];
  }

  private validEnvironment(value: unknown, container: boolean): boolean {
    if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === 'string')) return false;
    const expected = new Map<string, string>([['PATH', imagePath], ['NODE_VERSION', this.config.nodeVersion]]);
    if (container) {
      expected.set('HOME', '/workspace'); expected.set('LANG', 'C.UTF-8'); expected.set('NODE_OPTIONS', '');
    }
    const seen = new Set<string>();
    for (const entry of value as string[]) {
      const delimiter = entry.indexOf('=');
      const key = entry.slice(0, delimiter);
      const setting = entry.slice(delimiter + 1);
      if (delimiter < 1 || seen.has(key)) return false;
      seen.add(key);
      if (key === 'YARN_VERSION') {
        if (!/^\d+\.\d+\.\d+$/.test(setting)) return false;
      } else if (expected.get(key) !== setting || !expected.has(key)) return false;
    }
    return [...expected.keys()].every((key) => seen.has(key));
  }

  private verifyCreatedContainer(container: Record<string, unknown>, workspace: string, source: string): void {
    const host = container.HostConfig;
    const configuration = container.Config;
    const state = container.State;
    const unsafe = (): never => { throw new HarnessError('SANDBOX_EFFECTIVE_POLICY_MISMATCH'); };
    if (!isRecord(host) || !isRecord(configuration) || !isRecord(state)) unsafe();
    if (!isRecord(host) || !isRecord(configuration) || !isRecord(state)) return;
    if (container.Image !== this.config.imageId || state.Status !== 'created' || state.Running !== false
      || state.Paused !== false || state.Restarting !== false || state.Dead !== false
      || configuration.User !== '1000:1000' || configuration.WorkingDir !== '/workspace'
      || configuration.Hostname !== 'harness-probe' || configuration.OpenStdin !== false || configuration.Tty !== false
      || !sameStrings(configuration.Entrypoint, ['/usr/local/bin/node'])
      || !sameStrings(configuration.Cmd, ['--input-type=module', '--eval', source])
      || !this.validEnvironment(configuration.Env, true) || !isEmpty(configuration.Volumes) || !isEmpty(configuration.OnBuild)
      || !isRecord(configuration.Healthcheck) || !sameStrings(configuration.Healthcheck.Test, ['NONE'])
      || host.NetworkMode !== 'none' || host.ReadonlyRootfs !== true || host.Privileged !== false
      || !sameStrings(host.CapDrop, ['ALL']) || !isEmpty(host.CapAdd)
      || !sameStrings(host.SecurityOpt, ['no-new-privileges=true']) || host.IpcMode !== 'none'
      || host.CgroupnsMode !== 'private' || host.Init !== true || host.PidsLimit !== SANDBOX_LIMITS.pids
      || host.Memory !== SANDBOX_LIMITS.memoryBytes || host.MemorySwap !== SANDBOX_LIMITS.memoryBytes
      || host.NanoCpus !== SANDBOX_LIMITS.nanoCpus || host.AutoRemove !== false || host.PublishAllPorts !== false
      || host.PidMode !== '' || host.UTSMode !== '' || host.UsernsMode !== '' || host.CgroupParent !== ''
      || host.Runtime !== 'runc' || host.OomKillDisable === true
      || !isEmpty(host.Binds) || !isEmpty(host.Tmpfs) || !isEmpty(host.VolumesFrom) || !isEmpty(host.Devices) || !isEmpty(host.DeviceRequests)
      || !isEmpty(host.DeviceCgroupRules) || !isEmpty(host.PortBindings) || !isEmpty(host.ExtraHosts) || !isEmpty(host.Links)
      || !isEmpty(host.GroupAdd) || !isEmpty(host.Dns) || !isEmpty(host.DnsOptions) || !isEmpty(host.DnsSearch)
      || !isRecord(host.LogConfig) || host.LogConfig.Type !== 'none' || !isEmpty(host.LogConfig.Config)
      || !isRecord(host.RestartPolicy) || host.RestartPolicy.Name !== 'no' || host.RestartPolicy.MaximumRetryCount !== 0) unsafe();
    if (!Array.isArray(host.Ulimits) || host.Ulimits.length !== 3) unsafe();
    const limits = new Map([['core', 0], ['nofile', 128], ['fsize', 4_194_304]]);
    const seenLimits = new Set<string>();
    for (const limit of host.Ulimits as unknown[]) {
      if (!isRecord(limit) || typeof limit.Name !== 'string' || !limits.has(limit.Name) || seenLimits.has(limit.Name)
        || limit.Soft !== limits.get(limit.Name) || limit.Hard !== limits.get(limit.Name)) unsafe();
      if (isRecord(limit) && typeof limit.Name === 'string') seenLimits.add(limit.Name);
    }
    if (!Array.isArray(container.Mounts) || container.Mounts.length !== 1 || !isRecord(container.Mounts[0])
      || container.Mounts[0].Type !== 'bind' || container.Mounts[0].Source !== workspace
      || container.Mounts[0].Destination !== '/workspace' || container.Mounts[0].RW !== true
      || container.Mounts[0].Propagation !== 'rprivate') unsafe();
    if (!Array.isArray(host.Mounts) || host.Mounts.length !== 1 || !isRecord(host.Mounts[0])) unsafe();
    const mount = (host.Mounts as Record<string, unknown>[])[0];
    if (mount === undefined || mount.Type !== 'bind' || mount.Source !== workspace || mount.Target !== '/workspace'
      || !isRecord(mount.BindOptions) || mount.BindOptions.Propagation !== 'rprivate' || mount.BindOptions.NonRecursive !== true) unsafe();
  }

  private async inspectOwned(name: string, token: string): Promise<OwnedContainer | null> {
    const response = await this.command(['container', 'inspect', name], SANDBOX_LIMITS.metadataTimeoutMs, metadataBytes);
    if (response.termination !== 'completed' || response.exitCode !== 0) {
      if (await this.isAbsent(name)) return null;
      throw new HarnessError('SANDBOX_CONTAINER_INSPECTION_FAILED');
    }
    const inspection = parseInspection(response.stdout);
    const configuration = inspection.Config;
    if (typeof inspection.Id !== 'string' || !containerPattern.test(inspection.Id) || inspection.Name !== `/${name}`
      || !isRecord(configuration) || !isRecord(configuration.Labels) || configuration.Labels[labelKey] !== token) {
      throw new HarnessError('SANDBOX_CONTAINER_OWNERSHIP_MISMATCH');
    }
    return { id: inspection.Id, inspection };
  }

  private async cleanup(name: string, token: string): Promise<CleanupResult> {
    let owned = await this.inspectOwned(name, token);
    if (owned === null) return { found: false, stopped: true, removed: true, oomKilled: false, exitCode: null };
    let state = owned.inspection.State;
    if (!isRecord(state)) throw new HarnessError('SANDBOX_INVALID_METADATA');
    if (state.Running === true || state.Paused === true || state.Restarting === true) {
      await this.command(['kill', '--signal', 'KILL', owned.id], SANDBOX_LIMITS.metadataTimeoutMs, metadataBytes);
      owned = await this.inspectOwned(name, token);
      if (owned === null) throw new HarnessError('SANDBOX_CONTAINER_DISAPPEARED');
      state = owned.inspection.State;
    }
    if (!isRecord(state) || state.Running !== false || state.Paused !== false || state.Restarting !== false
      || typeof state.OOMKilled !== 'boolean' || !Number.isInteger(state.ExitCode)) throw new HarnessError('SANDBOX_STOP_UNCONFIRMED');
    const removed = await this.command(['rm', '--force', owned.id], SANDBOX_LIMITS.metadataTimeoutMs, metadataBytes);
    if (removed.termination !== 'completed' || removed.exitCode !== 0 || !(await this.isAbsent(name))) {
      throw new HarnessError('SANDBOX_REMOVAL_UNCONFIRMED');
    }
    return { found: true, stopped: true, removed: true, oomKilled: state.OOMKilled, exitCode: state.ExitCode as number };
  }

  private async isAbsent(name: string): Promise<boolean> {
    const response = await this.metadata(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
    return response.stdout.trim() === '';
  }

  private async metadata(arguments_: string[]): Promise<DockerCommandResult> {
    const response = await this.command(arguments_, SANDBOX_LIMITS.metadataTimeoutMs, metadataBytes);
    if (response.termination !== 'completed' || response.exitCode !== 0) throw new HarnessError('SANDBOX_METADATA_COMMAND_FAILED');
    return response;
  }

  private async command(arguments_: string[], timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<DockerCommandResult> {
    try {
      return await this.runner(['--config', this.controlDirectory, '--host', `unix://${this.config.socketPath}`, ...arguments_], {
        executable: this.config.dockerPath, environment: { ...this.environment }, timeoutMs, maxBytes,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch { throw new HarnessError('SANDBOX_DOCKER_COMMAND_FAILED'); }
  }
}
