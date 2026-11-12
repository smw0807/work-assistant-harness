import type { CheckResult } from './types.js';
import type { SandboxConfig } from './sandbox.js';
import type { BranchWorkType } from './branch.js';

export const EXECUTION_POLICY_VERSION = 'synthetic-execution-v1' as const;
export const BRANCH_EXECUTION_POLICY_VERSION = 'synthetic-branch-execution-v1' as const;
export const CODEX_EXECUTION_POLICY_VERSION = 'synthetic-codex-execution-v1' as const;
export type ExecutionPolicyVersion = typeof EXECUTION_POLICY_VERSION | typeof BRANCH_EXECUTION_POLICY_VERSION
  | typeof CODEX_EXECUTION_POLICY_VERSION;
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
  version: ExecutionPolicyVersion;
  backend: 'docker';
  serverVersion: string;
  imageId: string;
  nodeVersion: string;
  configHash: string;
  limits: typeof EXECUTION_LIMITS;
  network: 'none';
}

export interface ExecutionBranchPlan {
  workType: BranchWorkType;
  name: string;
  baseBranch: 'main';
  headRef: string;
  ownerId: string;
  sourceRoot: string;
  createdAt: string;
  expiresAt: string;
}

export interface ExecutionProposalMetadata {
  proposalId: string;
  inputHash: string;
  responseHash: string;
  configHash: string;
  validatorVersion: 'codex-proposal-v1';
}

export interface ExecutionPlan {
  planId: string;
  version: 1;
  taskId: string;
  requestRevision: string;
  repoId: 'synthetic-execution' | 'synthetic-branch-execution' | 'synthetic-codex-execution';
  baseCommit: string;
  sourceHash: string;
  allowedFiles: string[];
  patches: ReplacementPatch[];
  commands: RegisteredExecutionCommand[];
  policy: ExecutionPolicy;
  branch?: ExecutionBranchPlan;
  proposal?: ExecutionProposalMetadata;
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
  status: 'AWAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'INTERRUPTED';
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
  executionPolicy: ExecutionPolicyVersion;
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
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'INTERRUPTED';
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
  observation?: ExecutionObservation;
}

export interface ExecutionWorkspace { worktreeRoot: string; containerRoot: string }

export interface ExecutionRunRequest { taskId: string; planHash: string; baseCommit: string }

export type ExecutionControlKind = 'cancel' | 'edited' | 'deleted';
export interface ExecutionControlRequest {
  taskId: string;
  eventId: string;
  kind: ExecutionControlKind;
  revision: number;
}

export interface ExecutionRequestState {
  taskId: string;
  requestId: string;
  ownerId: string;
  revision: number;
  generation: number;
  invalidatedAt: string | null;
  reason: 'OWNER_CANCELLED' | 'REQUEST_EDITED' | 'REQUEST_DELETED' | null;
}

export type ExecutionPhase = 'claimed' | 'workspace_preparing' | 'workspace_ready' | 'patch_applying'
  | 'patch_applied' | 'view_preparing' | 'view_ready' | 'container_creating' | 'container_created'
  | 'container_starting' | 'command_finished' | 'finalizing' | 'recovering' | 'finished' | 'legacy_untracked';

export interface ExecutionWorkspaceEvidence {
  worktreeRoot: string;
  containerRoot: string;
  planHash: string;
  gitHash: string;
  viewHash: string | null;
}

export interface ExecutionContainerIntent {
  runId: string;
  name: string;
  token: string;
  id: string | null;
  commandId: ExecutionCommandId;
}

export interface ExecutionCleanupResult {
  found: boolean;
  stopped: boolean;
  removed: boolean;
  exitCode: number | null;
  oomKilled: boolean;
  failureCode: string | null;
}

export interface ExecutionObservedChange {
  path: string;
  kind: 'modified' | 'added' | 'deleted' | 'mode' | 'symlink' | 'special';
  beforeHash: string | null;
  afterHash: string | null;
  beforeMode: number | null;
  afterMode: number | null;
  inScope: boolean;
}

export interface ExecutionObservation {
  status: 'passed' | 'failed' | 'not_run';
  reason: string;
  changes: ExecutionObservedChange[];
  gitUnchanged: boolean | null;
  viewUnchanged: boolean | null;
  workspaceExists: boolean;
}

export interface ExecutionLifecycle {
  runId: string;
  taskId: string;
  generation: number;
  sequence: number;
  phase: ExecutionPhase;
  updatedAt: string;
  workspace: ExecutionWorkspaceEvidence | null;
  container: ExecutionContainerIntent | null;
  cleanup: ExecutionCleanupResult | null;
  observation: ExecutionObservation | null;
  legacy: boolean;
}

export interface ExecutionProgress {
  workspace?: ExecutionWorkspaceEvidence;
  container?: ExecutionContainerIntent;
  cleanup?: ExecutionCleanupResult;
  observation?: ExecutionObservation;
  command?: ExecutionCommandResult;
  sourceBeforeHash?: string;
  worktreeRoot?: string;
  diff?: ExecutionDiff[];
  checks?: CheckResult[];
}

export interface ExecutionLifecycleHooks {
  runId: string;
  dispatch?<T>(operation: () => Promise<T>): Promise<T>;
  beforeCreate(intent: ExecutionContainerIntent): Promise<void>;
  created(intent: ExecutionContainerIntent): Promise<void>;
  beforeStart(): Promise<void>;
  finished(result: ExecutionCommandResult): Promise<void>;
}

export interface ExecutionSnapshot {
  task: ExecutionTask;
  requestState: ExecutionRequestState;
  approvals: ExecutionApproval[];
  approvalPage: { offset: number; total: number; nextOffset: number | null };
  runs: ExecutionRun[];
  lifecycles: ExecutionLifecycle[];
}

/** 진단 보고서는 실행 승인이 아니다. 매 실행마다 설정과 backend를 다시 검증한다. */
export interface IsolatedExecutionPort {
  preflight(config: SandboxConfig, policy: ExecutionPolicy): Promise<void>;
  execute(command: RegisteredExecutionCommand, workspaceRoot: string, signal?: AbortSignal, hooks?: ExecutionLifecycleHooks): Promise<ExecutionCommandResult>;
  recover?(intent: ExecutionContainerIntent): Promise<ExecutionCleanupResult>;
}
