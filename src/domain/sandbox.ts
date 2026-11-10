import type { CheckResult } from './types.js';

export const SANDBOX_POLICY_VERSION = 'docker-probe-v1' as const;

export const SANDBOX_LIMITS = Object.freeze({
  memoryBytes: 128 * 1024 * 1024,
  pids: 64,
  nanoCpus: 500_000_000,
  outputBytes: 16 * 1024,
  timeoutMs: 1_500,
  probeWatchdogMs: 7_500,
  metadataTimeoutMs: 10_000,
});

export const SANDBOX_BOUNDARY_CHECKS = Object.freeze([
  'workspaceWritable', 'protectedPathsDenied', 'hostWorkspacePathHidden', 'traversalDenied',
  'symlinkEscapeDenied', 'procRootPathsDenied', 'rootFilesystemWriteDenied', 'dockerSocketsHidden',
  'environmentAllowlisted', 'hostSecretsAbsent', 'fixedEnvironment', 'nonRootUser', 'nodeVersionPinned',
  'capabilitiesDropped', 'noNewPrivileges', 'seccompEnabled', 'loopbackOnlyInterfaces', 'tcpDenied',
  'dnsDenied', 'memoryLimit', 'swapDisabled', 'processLimit', 'cpuLimit',
]);

export interface SandboxConfig {
  enabled: boolean;
  backend: 'docker';
  policyVersion: typeof SANDBOX_POLICY_VERSION;
  dockerPath: string;
  socketPath: string;
  serverVersion: string;
  imageId: string;
  nodeVersion: string;
}

export type SandboxProbeId = 'boundary' | 'pids' | 'memory' | 'timeout' | 'output';

export interface SandboxProbeInput {
  workspaceRoot: string;
  protectedPaths: string[];
}

export interface SandboxProbeResult {
  probe: SandboxProbeId;
  containerName?: string;
  termination: 'completed' | 'timeout' | 'output_limit' | 'aborted' | 'failed';
  exitCode: number | null;
  stdout: string;
  stopped: boolean;
  removed: boolean;
  oomKilled: boolean;
  failureCode: string | null;
}

export interface SandboxBackendIdentity {
  serverVersion: string;
  imageId: string;
  imagePlatform: string;
  nodeVersion: string;
  policyVersion: typeof SANDBOX_POLICY_VERSION;
}

export interface SandboxVerificationReport {
  verificationId: string;
  createdAt: string;
  policyVersion: typeof SANDBOX_POLICY_VERSION;
  hostPlatform: string;
  status: 'passed' | 'failed' | 'blocked';
  executionEnabled: false;
  backend: SandboxBackendIdentity | null;
  limits: typeof SANDBOX_LIMITS;
  probes: Omit<SandboxProbeResult, 'stdout'>[];
  protectedSnapshot: { beforeHash: string; afterHash: string } | null;
  checks: CheckResult[];
  failureCode: string | null;
}
