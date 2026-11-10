import type { CheckResult } from './types.js';
import type { SandboxConfig } from './sandbox.js';

export const EXECUTION_POLICY_VERSION = 'synthetic-execution-v1' as const;
export const EXECUTION_LIMITS = Object.freeze({
  memoryBytes: 128 * 1024 * 1024, pids: 64, nanoCpus: 500_000_000,
  outputBytes: 16 * 1024, timeoutMs: 3_000, scratchBytes: 16 * 1024 * 1024,
  workspaceBytes: 64 * 1024, workspaceFiles: 16,
});

export type ExecutionFixture = 'success' | 'test-failure' | 'timeout' | 'output';
export type ExecutionCommandId = 'synthetic-check-v1' | 'synthetic-timeout-v1' | 'synthetic-output-v1';

export interface RegisteredExecutionCommand {
  commandId: ExecutionCommandId;
  executable: '/usr/local/bin/node';
  argv: string[];
  argumentSchema: 'none';
  cwd: '/workspace';
  environment: { HOME: '/tmp'; LANG: 'C.UTF-8'; NODE_OPTIONS: '' };
  network: 'none';
  timeoutMs: number;
}

export interface ReplacementPatch {
  operation: 'replace';
  path: string;
  beforeHash: string;
  afterHash: string;
  content: string;
}

export interface ExecutionPolicy {
  version: typeof EXECUTION_POLICY_VERSION;
  backend: 'docker';
  serverVersion: string;
  imageId: string;
  nodeVersion: string;
  configHash: string;
  limits: typeof EXECUTION_LIMITS;
  network: 'none';
}

export interface ExecutionPlan {
  planId: string;
  version: 1;
  taskId: string;
  requestRevision: string;
  repoId: 'synthetic-execution';
  baseCommit: string;
  sourceHash: string;
  allowedFiles: string[];
  patches: ReplacementPatch[];
  commands: RegisteredExecutionCommand[];
  policy: ExecutionPolicy;
  planHash: string;
}

export interface ExecutionSource {
  sourceRoot: string;
  baseCommit: string;
  sourceHash: string;
  patches: ReplacementPatch[];
  commandIds: ExecutionCommandId[];
}

export interface ExecutionTask {
  taskId: string;
  status: 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
  requestRevision: string;
  baseCommit: string;
  sourceRoot: string;
  createdAt: string;
  updatedAt: string;
  plan: ExecutionPlan;
}

export interface ExecutionApprovalRequest {
  taskId: string;
  planHash: string;
  baseCommit: string;
  expiresInMinutes: number;
}

export interface ExecutionApprovalContext { ownerId: string; now: Date }

export interface ExecutionApproval {
  approvalId: string;
  taskId: string;
  ownerId: string;
  planHash: string;
  baseCommit: string;
  requestRevision: string;
  executionPolicy: typeof EXECUTION_POLICY_VERSION;
  planSnapshot: ExecutionPlan;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export interface ExecutionCommandResult {
  commandId: ExecutionCommandId;
  containerName: string | null;
  termination: 'completed' | 'timeout' | 'output_limit' | 'aborted' | 'failed';
  exitCode: number | null;
  stopped: boolean;
  removed: boolean;
  oomKilled: boolean;
  outputBytes: number;
  outputHash: string;
  failureCode: string | null;
}

export interface ExecutionDiff {
  path: string;
  beforeHash: string;
  afterHash: string;
  before: string;
  after: string;
}

export interface ExecutionRun {
  runId: string;
  taskId: string;
  approvalId: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
  startedAt: string;
  finishedAt: string | null;
  artifactDirectory: string;
  worktreeRoot: string | null;
  failureCode: string | null;
  checks: CheckResult[];
  commands: ExecutionCommandResult[];
  diff: ExecutionDiff[];
  sourceBeforeHash: string | null;
  sourceAfterHash: string | null;
}

export interface ExecutionWorkspace { worktreeRoot: string; containerRoot: string }

export interface ExecutionRunRequest { taskId: string; planHash: string; baseCommit: string }

/** 진단 보고서는 실행 승인이 아니다. 매 실행마다 설정과 backend를 다시 검증한다. */
export interface IsolatedExecutionPort {
  preflight(config: SandboxConfig, policy: ExecutionPolicy): Promise<void>;
  execute(command: RegisteredExecutionCommand, workspaceRoot: string, signal?: AbortSignal): Promise<ExecutionCommandResult>;
}
