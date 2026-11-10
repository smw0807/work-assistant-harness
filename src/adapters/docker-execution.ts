import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HarnessError } from '../domain/errors.js';
import { EXECUTION_LIMITS } from '../domain/execution.js';
import type { ExecutionCleanupResult, ExecutionCommandResult, ExecutionContainerIntent, ExecutionLifecycleHooks, ExecutionPolicy, IsolatedExecutionPort, RegisteredExecutionCommand } from '../domain/execution.js';
import type { SandboxConfig } from '../domain/sandbox.js';
import { DockerSandboxVerifier, type DockerCommandOptions, type DockerCommandResult, type DockerSandboxFileSystem } from './docker-sandbox.js';
import { assertExecutionCommand, assertExecutionPolicy, createExecutionPolicy, getExecutionCommand } from '../policy/execution-policy.js';

type CommandTermination = ExecutionCommandResult['termination'];

export interface DockerExecutionCommandResult extends DockerCommandResult {
  outputBytes?: number;
  outputHash?: string;
}
export type DockerExecutionCommandRunner = (arguments_: string[], options: DockerCommandOptions) => Promise<DockerExecutionCommandResult>;

const hostFileSystem: DockerSandboxFileSystem = {
  canonical: (filePath) => realpath(filePath),
  metadata: (filePath) => lstat(filePath),
  entries: (directory) => readdir(directory),
};

const containerPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const metadataBytes = 65_536;
const labelKey = 'work-assistant-harness.execution';
const runLabelKey = 'work-assistant-harness.run';
const scratchOptions = 'rw,noexec,nosuid,nodev,size=16777216,mode=1777';
const imagePath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const workspaceFiles = ['README.md', 'checks/check.mjs', 'checks/output.mjs', 'checks/timeout.mjs', 'src/message.mjs'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEmpty = (value: unknown): boolean => value === undefined || value === null
  || (Array.isArray(value) ? value.length === 0 : isRecord(value) && Object.keys(value).length === 0);
const sameStrings = (value: unknown, expected: string[]): boolean => Array.isArray(value)
  && value.length === expected.length && value.every((item: unknown, index) => item === expected[index]);
const overlaps = (left: string, right: string): boolean => {
  const difference = path.relative(left, right);
  return difference === '' || (!difference.startsWith(`..${path.sep}`) && difference !== '..' && !path.isAbsolute(difference));
};
const parseInspection = (output: string): Record<string, unknown> => {
  let parsed: unknown;
  try { parsed = JSON.parse(output) as unknown; } catch { throw new HarnessError('EXECUTION_INVALID_METADATA'); }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) throw new HarnessError('EXECUTION_INVALID_METADATA');
  return parsed[0];
};

/** Docker CLI 종료와 별도로 컨테이너를 종료하고 정지 여부를 확인한다. */
const runDockerCommand: DockerExecutionCommandRunner = async (arguments_, options) => {
  if (options.signal?.aborted) return { termination: 'aborted', exitCode: null, stdout: '' };
  return new Promise((resolve) => {
    const child = spawn(options.executable, arguments_, {
      shell: false, env: options.environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let termination: CommandTermination = 'completed';
    let totalBytes = 0;
    const outputDigest = createHash('sha256');
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
      outputDigest.update(chunk);
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
      resolve({ termination, exitCode, stdout: Buffer.concat(chunks).toString('utf8'), outputBytes: totalBytes, outputHash: outputDigest.digest('hex') });
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

/** 승인된 고정 합성 명령만 새 컨테이너에서 실행한다. 일반 실행 포트로 확장하지 않는다. */
export class DockerIsolatedExecution implements IsolatedExecutionPort {
  private verified = false;
  private readonly environment: Record<string, string>;

  constructor(
    private readonly config: SandboxConfig,
    private readonly controlDirectory: string,
    private readonly runner: DockerExecutionCommandRunner = runDockerCommand,
    private readonly fileSystem: DockerSandboxFileSystem = hostFileSystem,
  ) {
    this.config = Object.freeze({ ...config });
    this.environment = { LANG: 'C.UTF-8', TZ: 'UTC', HOME: controlDirectory, PATH: '/usr/bin:/bin' };
  }

  async preflight(config: SandboxConfig, policy: ExecutionPolicy): Promise<void> {
    this.verified = false;
    assertExecutionPolicy(policy);
    if (JSON.stringify(config) !== JSON.stringify(this.config) || !config.enabled
      || JSON.stringify(policy) !== JSON.stringify(createExecutionPolicy(config))) throw new HarnessError('EXECUTION_POLICY_MISMATCH');
    await new DockerSandboxVerifier(config, this.controlDirectory, this.runner, this.fileSystem).preflight();
    this.verified = true;
  }

  async execute(command: RegisteredExecutionCommand, workspaceRoot: string, signal?: AbortSignal, hooks?: ExecutionLifecycleHooks): Promise<ExecutionCommandResult> {
    const result: ExecutionCommandResult = {
      commandId: command.commandId, containerName: null, termination: 'failed', exitCode: null,
      stopped: true, removed: true, oomKilled: false, outputBytes: 0,
      outputHash: createHash('sha256').digest('hex'), failureCode: null,
    };
    const token = randomUUID();
    const name = `harness-execution-${token}`;
    let creationAttempted = false;
    let creationConfirmed = false;
    let createdId: string | null = null;
    const preflightVerified = this.verified;
    this.verified = false;
    try {
      if (signal?.aborted) throw new HarnessError('EXECUTION_ABORTED');
      if (!preflightVerified) throw new HarnessError('EXECUTION_PREFLIGHT_REQUIRED');
      assertExecutionCommand(command);
      if (hooks !== undefined && !uuidPattern.test(hooks.runId)) throw new HarnessError('EXECUTION_INVALID_CONTAINER_INTENT');
      const registeredCommand = getExecutionCommand(command.commandId);
      const workspace = await this.validateWorkspace(workspaceRoot);
      if (signal?.aborted) throw new HarnessError('EXECUTION_ABORTED');
      result.containerName = name;
      const intent: ExecutionContainerIntent | undefined = hooks === undefined ? undefined : {
        runId: hooks.runId, name, token, id: null, commandId: registeredCommand.commandId,
      };
      if (hooks !== undefined && intent !== undefined) await this.lifecycle(() => hooks.beforeCreate(intent));
      if (signal?.aborted) throw new HarnessError('EXECUTION_ABORTED');
      const create = (): Promise<DockerExecutionCommandResult> => {
        creationAttempted = true;
        return this.command(this.createArguments(name, token, workspace, registeredCommand, hooks?.runId), 10_000, metadataBytes, signal);
      };
      const created = await (hooks?.dispatch ? hooks.dispatch(create) : create());
      if (created.termination !== 'completed' || created.exitCode !== 0 || !containerPattern.test(created.stdout.trim())) {
        throw new HarnessError('EXECUTION_CREATE_FAILED');
      }
      creationConfirmed = true;
      createdId = created.stdout.trim();
      // 취소가 도착했더라도 생성된 ID는 먼저 영속하고 이 소유 컨테이너를 정리한다.
      if (hooks !== undefined && intent !== undefined) await this.lifecycle(() => hooks.created({ ...intent, id: createdId }));
      const owned = await this.inspectOwned(name, token, hooks?.runId, createdId);
      if (owned === null) throw new HarnessError('EXECUTION_CONTAINER_ID_MISMATCH');
      this.verifyCreatedContainer(owned.inspection, workspace, registeredCommand);
      if (hooks !== undefined) await this.lifecycle(() => hooks.beforeStart());
      if (signal?.aborted) throw new HarnessError('EXECUTION_ABORTED');
      const start = (): Promise<DockerExecutionCommandResult> => this.command(['start', '--attach', owned.id], EXECUTION_LIMITS.timeoutMs, EXECUTION_LIMITS.outputBytes, signal);
      const executed = await (hooks?.dispatch ? hooks.dispatch(start) : start());
      result.termination = executed.termination;
      result.exitCode = executed.exitCode;
      result.outputBytes = executed.outputBytes ?? Buffer.byteLength(executed.stdout);
      result.outputHash = executed.outputHash ?? createHash('sha256').update(executed.stdout).digest('hex');
      if (executed.termination === 'failed') result.failureCode = 'EXECUTION_START_FAILED';
    } catch (error: unknown) {
      result.termination = signal?.aborted ? 'aborted' : 'failed';
      result.failureCode = error instanceof HarnessError ? error.code : 'EXECUTION_COMMAND_FAILED';
    } finally {
      if (creationAttempted) {
        try {
          const cleanup = await this.cleanup(name, token, hooks?.runId, createdId);
          const confirmed = creationConfirmed || cleanup.found;
          result.stopped = confirmed && cleanup.stopped;
          result.removed = confirmed && cleanup.removed;
          result.oomKilled = cleanup.oomKilled;
          result.exitCode = cleanup.exitCode ?? result.exitCode;
          if (!confirmed) {
            result.termination = 'failed';
            result.failureCode = 'EXECUTION_CLEANUP_UNCONFIRMED';
          }
        } catch {
          result.stopped = false;
          result.removed = false;
          result.termination = 'failed';
          result.failureCode = 'EXECUTION_CLEANUP_UNCONFIRMED';
        }
      }
    }
    if (hooks !== undefined) {
      try { await this.lifecycle(() => hooks.finished({ ...result })); }
      catch { result.termination = 'failed'; result.failureCode = 'EXECUTION_LIFECYCLE_RECORD_FAILED'; }
    }
    return result;
  }

  /** 새 코드를 실행하지 않고 영속한 소유 컨테이너만 정지·제거한다. */
  async recover(intent: ExecutionContainerIntent): Promise<ExecutionCleanupResult> {
    const failed: ExecutionCleanupResult = {
      found: false, stopped: false, removed: false, exitCode: null, oomKilled: false, failureCode: null,
    };
    try {
      if (!this.verified) throw new HarnessError('EXECUTION_PREFLIGHT_REQUIRED');
      this.verified = false;
      this.validateIntent(intent);
      const cleanup = await this.cleanup(intent.name, intent.token, intent.runId, intent.id);
      if (intent.id === null && !cleanup.found) return { ...failed, failureCode: 'EXECUTION_CREATE_OUTCOME_UNKNOWN' };
      return { ...cleanup, failureCode: null };
    } catch (error: unknown) {
      return { ...failed, failureCode: error instanceof HarnessError ? error.code : 'EXECUTION_RECOVERY_FAILED' };
    }
  }

  private validateIntent(intent: ExecutionContainerIntent): void {
    if (typeof intent !== 'object' || intent === null || !uuidPattern.test(intent.runId) || !uuidPattern.test(intent.token)
      || intent.name !== `harness-execution-${intent.token}` || (intent.id !== null && !containerPattern.test(intent.id))) {
      throw new HarnessError('EXECUTION_INVALID_CONTAINER_INTENT');
    }
    getExecutionCommand(intent.commandId);
  }

  private async lifecycle(callback: () => Promise<void>): Promise<void> {
    try { await callback(); } catch { throw new HarnessError('EXECUTION_LIFECYCLE_RECORD_FAILED'); }
  }

  private async validateWorkspace(workspaceRoot: string): Promise<string> {
    const workspace = path.resolve(workspaceRoot);
    try {
      if (!path.isAbsolute(workspaceRoot) || workspace !== workspaceRoot || workspace === path.parse(workspace).root
        || (await this.fileSystem.canonical(workspace)) !== workspace
        || overlaps(workspace, this.controlDirectory) || overlaps(this.controlDirectory, workspace)
        || workspace.includes(',') || [...workspace].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error();
      let totalBytes = 0;
      let totalFiles = 0;
      const parent = await lstat(path.dirname(workspace));
      if (!parent.isDirectory() || (parent.mode & 0o7777) !== 0o700 || parent.uid !== process.getuid?.()) throw new Error();
      const seenFiles: string[] = [];
      const inspect = async (directory: string): Promise<void> => {
        const metadata = await lstat(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o7777) !== 0o555
          || metadata.uid !== process.getuid?.()) throw new Error();
        for (const entry of await readdir(directory)) {
          if (entry === '.git' || entry.startsWith('.')) throw new Error();
          const child = path.join(directory, entry);
          const relative = path.relative(workspace, child);
          const information = await lstat(child);
          if (information.isDirectory()) {
            if (relative !== 'checks' && relative !== 'src') throw new Error();
            await inspect(child);
          }
          else {
            if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1
              || (information.mode & 0o7777) !== 0o444 || information.uid !== process.getuid?.()
              || !workspaceFiles.includes(relative)) throw new Error();
            seenFiles.push(relative);
            totalBytes += information.size;
            totalFiles += 1;
            if (totalBytes > EXECUTION_LIMITS.workspaceBytes || totalFiles > EXECUTION_LIMITS.workspaceFiles) throw new Error();
          }
        }
      };
      await inspect(workspace);
      if (!sameStrings(seenFiles.sort(), workspaceFiles)) throw new Error();
    } catch { throw new HarnessError('EXECUTION_UNSAFE_WORKSPACE'); }
    return workspace;
  }

  private createArguments(name: string, token: string, workspace: string, command: RegisteredExecutionCommand, runId?: string): string[] {
    if (workspace.includes(',') || workspace.includes('\n') || workspace.includes('\r')) throw new HarnessError('EXECUTION_UNSAFE_WORKSPACE');
    return [
      'create', '--pull', 'never', '--name', name, '--label', `${labelKey}=${token}`,
      ...(runId === undefined ? [] : ['--label', `${runLabelKey}=${runId}`]),
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--user', '1000:1000', '--ipc', 'none', '--pids-limit', String(EXECUTION_LIMITS.pids),
      '--memory', String(EXECUTION_LIMITS.memoryBytes), '--memory-swap', String(EXECUTION_LIMITS.memoryBytes),
      '--cpus', '0.5', '--cgroupns', 'private', '--init', '--no-healthcheck', '--log-driver', 'none', '--restart', 'no',
      '--ulimit', 'core=0:0', '--ulimit', 'nofile=128:128', '--ulimit', 'fsize=4194304:4194304',
      '--hostname', 'harness-execution', '--workdir', '/workspace',
      '--env', 'HOME=/tmp', '--env', 'LANG=C.UTF-8', '--env', 'NODE_OPTIONS=',
      '--mount', `type=bind,src=${workspace},dst=/workspace,readonly,bind-propagation=rprivate,bind-recursive=disabled`,
      '--tmpfs', `/tmp:${scratchOptions}`,
      '--entrypoint', '/usr/local/bin/node', this.config.imageId, ...command.argv,
    ];
  }

  private validEnvironment(value: unknown, container: boolean): boolean {
    if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === 'string')) return false;
    const expected = new Map<string, string>([['PATH', imagePath], ['NODE_VERSION', this.config.nodeVersion]]);
    if (container) {
      expected.set('HOME', '/tmp'); expected.set('LANG', 'C.UTF-8'); expected.set('NODE_OPTIONS', '');
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

  private verifyCreatedContainer(container: Record<string, unknown>, workspace: string, command: RegisteredExecutionCommand): void {
    const host = container.HostConfig;
    const configuration = container.Config;
    const state = container.State;
    const unsafe = (): never => { throw new HarnessError('EXECUTION_EFFECTIVE_POLICY_MISMATCH'); };
    if (!isRecord(host) || !isRecord(configuration) || !isRecord(state)) unsafe();
    if (!isRecord(host) || !isRecord(configuration) || !isRecord(state)) return;
    if (container.Image !== this.config.imageId || state.Status !== 'created' || state.Running !== false
      || state.Paused !== false || state.Restarting !== false || state.Dead !== false
      || configuration.User !== '1000:1000' || configuration.WorkingDir !== '/workspace'
      || configuration.Hostname !== 'harness-execution' || configuration.OpenStdin !== false || configuration.Tty !== false
      || !sameStrings(configuration.Entrypoint, ['/usr/local/bin/node'])
      || !sameStrings(configuration.Cmd, command.argv)
      || !this.validEnvironment(configuration.Env, true) || !isEmpty(configuration.Volumes) || !isEmpty(configuration.OnBuild)
      || !isRecord(configuration.Healthcheck) || !sameStrings(configuration.Healthcheck.Test, ['NONE'])
      || host.NetworkMode !== 'none' || host.ReadonlyRootfs !== true || host.Privileged !== false
      || !sameStrings(host.CapDrop, ['ALL']) || !isEmpty(host.CapAdd)
      || !sameStrings(host.SecurityOpt, ['no-new-privileges=true']) || host.IpcMode !== 'none'
      || host.CgroupnsMode !== 'private' || host.Init !== true || host.PidsLimit !== EXECUTION_LIMITS.pids
      || host.Memory !== EXECUTION_LIMITS.memoryBytes || host.MemorySwap !== EXECUTION_LIMITS.memoryBytes
      || host.NanoCpus !== EXECUTION_LIMITS.nanoCpus || host.AutoRemove !== false || host.PublishAllPorts !== false
      || host.PidMode !== '' || host.UTSMode !== '' || host.UsernsMode !== '' || host.CgroupParent !== ''
      || host.Runtime !== 'runc' || host.OomKillDisable === true
      || !isEmpty(host.Binds) || !isRecord(host.Tmpfs) || Object.keys(host.Tmpfs).length !== 1 || host.Tmpfs['/tmp'] !== scratchOptions || !isEmpty(host.VolumesFrom) || !isEmpty(host.Devices) || !isEmpty(host.DeviceRequests)
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
      || container.Mounts[0].Destination !== '/workspace' || container.Mounts[0].RW !== false
      || container.Mounts[0].Propagation !== 'rprivate') unsafe();
    if (!Array.isArray(host.Mounts) || host.Mounts.length !== 1 || !isRecord(host.Mounts[0])) unsafe();
    const mount = (host.Mounts as Record<string, unknown>[])[0];
    if (mount === undefined || mount.Type !== 'bind' || mount.Source !== workspace || mount.Target !== '/workspace' || mount.ReadOnly !== true
      || !isRecord(mount.BindOptions) || mount.BindOptions.Propagation !== 'rprivate' || mount.BindOptions.NonRecursive !== true) unsafe();
  }

  private async inspectOwned(name: string, token: string, runId?: string, expectedId: string | null = null): Promise<OwnedContainer | null> {
    const response = await this.command(['container', 'inspect', name], 10_000, metadataBytes);
    if (response.termination !== 'completed' || response.exitCode !== 0) {
      if (await this.isAbsent(name, expectedId)) return null;
      throw new HarnessError('EXECUTION_CONTAINER_INSPECTION_FAILED');
    }
    const inspection = parseInspection(response.stdout);
    const configuration = inspection.Config;
    if (typeof inspection.Id !== 'string' || !containerPattern.test(inspection.Id) || inspection.Name !== `/${name}`
      || !isRecord(configuration) || !isRecord(configuration.Labels) || configuration.Labels[labelKey] !== token
      || (runId !== undefined && configuration.Labels[runLabelKey] !== runId)
      || (expectedId !== null && inspection.Id !== expectedId)) {
      throw new HarnessError('EXECUTION_CONTAINER_OWNERSHIP_MISMATCH');
    }
    return { id: inspection.Id, inspection };
  }

  private async cleanup(name: string, token: string, runId?: string, expectedId: string | null = null): Promise<CleanupResult> {
    let owned = await this.inspectOwned(name, token, runId, expectedId);
    if (owned === null) return { found: false, stopped: true, removed: true, oomKilled: false, exitCode: null };
    const originalId = owned.id;
    let state = owned.inspection.State;
    if (!isRecord(state)) throw new HarnessError('EXECUTION_INVALID_METADATA');
    if (state.Running === true || state.Paused === true || state.Restarting === true) {
      await this.command(['kill', '--signal', 'KILL', owned.id], 10_000, metadataBytes);
      owned = await this.inspectOwned(name, token, runId, originalId);
      if (owned === null) throw new HarnessError('EXECUTION_CONTAINER_DISAPPEARED');
      state = owned.inspection.State;
    }
    if (!isRecord(state) || state.Running !== false || state.Paused !== false || state.Restarting !== false
      || typeof state.OOMKilled !== 'boolean' || !Number.isInteger(state.ExitCode)) throw new HarnessError('EXECUTION_STOP_UNCONFIRMED');
    const removed = await this.command(['rm', '--force', owned.id], 10_000, metadataBytes);
    if (removed.termination !== 'completed' || removed.exitCode !== 0 || !(await this.isAbsent(name, originalId))) {
      throw new HarnessError('EXECUTION_REMOVAL_UNCONFIRMED');
    }
    return { found: true, stopped: true, removed: true, oomKilled: state.OOMKilled, exitCode: state.ExitCode as number };
  }

  private async isAbsent(name: string, expectedId: string | null = null): Promise<boolean> {
    const response = await this.metadata(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
    if (response.stdout.trim() !== '') return false;
    if (expectedId === null) return true;
    const byId = await this.metadata(['container', 'ls', '--all', '--no-trunc', '--filter', `id=${expectedId}`, '--format', '{{.ID}}']);
    return byId.stdout.trim() === '';
  }

  private async metadata(arguments_: string[]): Promise<DockerExecutionCommandResult> {
    const response = await this.command(arguments_, 10_000, metadataBytes);
    if (response.termination !== 'completed' || response.exitCode !== 0) throw new HarnessError('EXECUTION_METADATA_COMMAND_FAILED');
    return response;
  }

  private async command(arguments_: string[], timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<DockerExecutionCommandResult> {
    try {
      return await this.runner(['--config', this.controlDirectory, '--host', `unix://${this.config.socketPath}`, ...arguments_], {
        executable: this.config.dockerPath, environment: { ...this.environment }, timeoutMs, maxBytes,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch { throw new HarnessError('EXECUTION_DOCKER_COMMAND_FAILED'); }
  }
}
