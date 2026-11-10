import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashRepository } from '../adapters/demo-repository.js';
import { HarnessError } from '../domain/errors.js';
import {
  SANDBOX_BOUNDARY_CHECKS, SANDBOX_LIMITS, SANDBOX_POLICY_VERSION,
  type SandboxConfig, type SandboxProbeId, type SandboxProbeResult, type SandboxVerificationReport,
} from '../domain/sandbox.js';
import type { SandboxVerificationPort } from '../ports/sandbox.js';
import { assertSandboxHost } from '../policy/sandbox-policy.js';

interface VerificationEnvironment {
  platform: string;
  architecture: string;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

const waitForDescendants = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const abort = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    reject(new HarnessError('SANDBOX_ABORTED'));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, milliseconds);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
});

const parseProbeOutput = (result: SandboxProbeResult): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HarnessError('SANDBOX_INVALID_PROBE_OUTPUT');
  }
};

const assertStopped = (result: SandboxProbeResult): void => {
  if (!result.stopped || !result.removed) throw new HarnessError('SANDBOX_CLEANUP_UNCONFIRMED');
};

const prepareCanaries = async (directory: string) => {
  if (await realpath(directory) !== directory) throw new HarnessError('UNSAFE_SANDBOX_DIRECTORY');
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) throw new HarnessError('UNSAFE_SANDBOX_DIRECTORY');
  const workspaceRoot = join(directory, 'workspace');
  const protectedRoot = join(directory, 'protected');
  await mkdir(workspaceRoot, { mode: 0o700 });
  // 상위 검증 디렉터리는 0700이며 이 합성 작업 폴더만 컨테이너 UID에 쓰기를 허용한다.
  await chmod(workspaceRoot, 0o777);
  await mkdir(protectedRoot, { mode: 0o700 });
  const protectedPaths = [];
  for (const name of ['host-secret.txt', 'original-source.ts', 'approval.sqlite', 'shared-git-config']) {
    const filePath = join(protectedRoot, name);
    await writeFile(filePath, `synthetic-canary:${randomUUID()}\n`, { flag: 'wx', mode: 0o600 });
    protectedPaths.push(filePath);
  }
  await symlink(protectedPaths[0]!, join(workspaceRoot, 'escape'));
  await writeFile(join(workspaceRoot, '.git'), `gitdir: ${protectedRoot}\n`, { flag: 'wx', mode: 0o644 });
  return { workspaceRoot, protectedRoot, protectedPaths };
};

/** 자체 검증 결과를 기록하며 실행 권한이나 재사용 가능한 승인 토큰은 발급하지 않는다. */
export class SandboxVerificationService {
  constructor(
    private readonly config: SandboxConfig,
    private readonly backend: SandboxVerificationPort,
    private readonly environment: VerificationEnvironment = {
      platform: process.platform, architecture: process.arch, wait: waitForDescendants,
    },
  ) {}

  async verify(directory: string, signal?: AbortSignal, verificationId: string = randomUUID()): Promise<SandboxVerificationReport> {
    const report: SandboxVerificationReport = {
      verificationId, createdAt: new Date().toISOString(), policyVersion: SANDBOX_POLICY_VERSION,
      hostPlatform: `${this.environment.platform}/${this.environment.architecture}`, status: 'blocked',
      executionEnabled: false, backend: null, limits: SANDBOX_LIMITS, probes: [], protectedSnapshot: null,
      checks: [], failureCode: null,
    };
    const check = (name: string, passed: boolean, reason: string): void => {
      report.checks.push({ name, status: passed ? 'passed' : 'failed', reason });
      if (!passed) throw new HarnessError('SANDBOX_VERIFICATION_FAILED');
    };
    let canaries: Awaited<ReturnType<typeof prepareCanaries>> | null = null;
    let beforeHash: string | null = null;
    let stage = 'sandbox_preflight';
    try {
      if (!this.config.enabled) throw new HarnessError('SANDBOX_DISABLED');
      assertSandboxHost(this.environment.platform, this.environment.architecture);
      if (signal?.aborted) throw new HarnessError('SANDBOX_ABORTED');
      report.backend = await this.backend.preflight();
      check(stage, true, '고정된 로컬 엔진·이미지·정책과 격리 기능을 확인했습니다.');
      canaries = await prepareCanaries(directory);
      beforeHash = await hashRepository(canaries.protectedRoot);
      const input = { workspaceRoot: canaries.workspaceRoot, protectedPaths: canaries.protectedPaths };
      for (const probe of ['boundary', 'pids', 'memory', 'timeout', 'output'] as const) {
        stage = `sandbox_${probe}`;
        if (signal?.aborted) throw new HarnessError('SANDBOX_ABORTED');
        const result = await this.backend.runProbe(probe, input, signal);
        report.probes.push({
          probe: result.probe, termination: result.termination, exitCode: result.exitCode,
          stopped: result.stopped, removed: result.removed, oomKilled: result.oomKilled, failureCode: result.failureCode,
          ...(result.containerName === undefined ? {} : { containerName: result.containerName }),
        });
        assertStopped(result);
        this.verifyProbe(probe, result);
        if (probe === 'timeout' || probe === 'output') {
          let readiness: string;
          try { readiness = await readFile(join(canaries.workspaceRoot, `${probe}-ready.txt`), 'utf8'); }
          catch { throw new HarnessError('SANDBOX_DESCENDANT_NOT_STARTED'); }
          if (readiness !== 'synthetic descendant spawned\n') throw new HarnessError('SANDBOX_DESCENDANT_NOT_STARTED');
        }
        check(stage, true, '고정 합성 probe의 예상 차단과 컨테이너 종료·제거를 확인했습니다.');
      }
      stage = 'sandbox_descendants_stopped';
      await this.environment.wait(3_250, signal);
      for (const name of ['timeout-child.txt', 'output-child.txt']) {
        let exists = false;
        try { await lstat(join(canaries.workspaceRoot, name)); exists = true; }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        if (exists) throw new HarnessError('SANDBOX_DESCENDANT_SURVIVED');
      }
      check(stage, true, '중단한 컨테이너의 지연 하위 프로세스가 작업 파일을 만들지 않았습니다.');
      stage = 'sandbox_workspace_positive_control';
      const positive = await readFile(join(canaries.workspaceRoot, 'positive.txt'), 'utf8');
      check(stage, positive === 'synthetic writable workspace\n', '작업 폴더 쓰기의 양성 대조군을 호스트에서도 확인했습니다.');
      report.status = 'passed';
    } catch (error) {
      const code = error instanceof HarnessError ? error.code : 'SANDBOX_VERIFICATION_FAILED';
      report.status = report.backend === null ? 'blocked' : 'failed';
      report.failureCode = code;
      if (!report.checks.some((entry) => entry.name === stage && entry.status === 'failed')) {
        report.checks.push({ name: stage, status: report.status === 'blocked' ? 'not_run' : 'failed', reason: code });
      }
      for (const name of [
        'sandbox_preflight', 'sandbox_boundary', 'sandbox_pids', 'sandbox_memory', 'sandbox_timeout',
        'sandbox_output', 'sandbox_descendants_stopped', 'sandbox_workspace_positive_control', 'sandbox_protected_canaries_unchanged',
      ]) {
        if (name === 'sandbox_protected_canaries_unchanged' && canaries && beforeHash) continue;
        if (!report.checks.some((entry) => entry.name === name)) report.checks.push({ name, status: 'not_run', reason: code });
      }
    } finally {
      if (canaries && beforeHash) {
        try {
          const afterHash = await hashRepository(canaries.protectedRoot);
          report.protectedSnapshot = { beforeHash, afterHash };
          const unchanged = afterHash === beforeHash;
          report.checks.push({ name: 'sandbox_protected_canaries_unchanged', status: unchanged ? 'passed' : 'failed', reason: unchanged ? '호스트·원본·승인 DB·공유 Git을 대신한 합성 파일의 전후 해시가 같습니다.' : 'SYNTHETIC_PROTECTED_FILES_CHANGED' });
          if (!unchanged) { report.status = 'failed'; report.failureCode = 'SANDBOX_PROTECTED_FILES_CHANGED'; }
        } catch {
          report.status = 'failed'; report.failureCode = 'SANDBOX_CANARY_CHECK_FAILED';
          report.checks.push({ name: 'sandbox_protected_canaries_unchanged', status: 'failed', reason: report.failureCode });
        }
      }
    }
    return report;
  }

  private verifyProbe(probe: SandboxProbeId, result: SandboxProbeResult): void {
    if (result.probe !== probe) throw new HarnessError('SANDBOX_INVALID_PROBE_OUTPUT');
    if (result.failureCode !== null) throw new HarnessError('SANDBOX_PROBE_FAILED');
    if (probe === 'timeout' || probe === 'output') {
      const expected = probe === 'timeout' ? 'timeout' : 'output_limit';
      if (result.termination !== expected || result.exitCode !== 137 || result.oomKilled) throw new HarnessError('SANDBOX_LIMIT_NOT_ENFORCED');
      return;
    }
    if (result.termination !== 'completed') throw new HarnessError('SANDBOX_PROBE_FAILED');
    if (probe === 'memory') {
      if (!result.oomKilled || result.exitCode !== 137) throw new HarnessError('SANDBOX_MEMORY_LIMIT_NOT_ENFORCED');
      return;
    }
    if (result.exitCode !== 0) throw new HarnessError('SANDBOX_PROBE_FAILED');
    const output = parseProbeOutput(result);
    if (probe === 'pids') {
      if (output.limited !== true || typeof output.count !== 'number' || !Number.isSafeInteger(output.count)
        || output.count < 1 || output.count > 64) throw new HarnessError('SANDBOX_PROCESS_LIMIT_NOT_ENFORCED');
      return;
    }
    const checks = output.checks;
    if (!checks || typeof checks !== 'object' || Array.isArray(checks)) throw new HarnessError('SANDBOX_INVALID_PROBE_OUTPUT');
    const values = checks as Record<string, unknown>;
    if (Object.keys(values).length !== SANDBOX_BOUNDARY_CHECKS.length) throw new HarnessError('SANDBOX_BOUNDARY_FAILED');
    const failed = SANDBOX_BOUNDARY_CHECKS.find((name) => values[name] !== true);
    if (failed) throw new HarnessError(`SANDBOX_BOUNDARY_FAILED_${failed.toUpperCase()}`);
  }
}
