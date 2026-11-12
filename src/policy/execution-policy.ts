import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import {
  EXECUTION_LIMITS, EXECUTION_POLICY_VERSION, BRANCH_EXECUTION_POLICY_VERSION,
  type ExecutionCommandId, type ExecutionPlan, type ExecutionPolicy, type ExecutionPolicyVersion, type RegisteredExecutionCommand,
} from '../domain/execution.js';
import type { SandboxConfig } from '../domain/sandbox.js';
import { containsSensitiveText } from './redaction.js';
import { parseSandboxConfig } from './sandbox-policy.js';

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: unknown, keys: string[]): boolean => isRecord(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const branchPlanLifetimeMs = 24 * 60 * 60 * 1000;
const commandPaths: Record<ExecutionCommandId, string> = {
  'synthetic-check-v1': '/workspace/checks/check.mjs',
  'synthetic-timeout-v1': '/workspace/checks/timeout.mjs',
  'synthetic-output-v1': '/workspace/checks/output.mjs',
};

/** ID에서 고정 argv를 새로 만든다. 모델이나 CLI가 추가 인자를 전달할 수 없다. */
export const getExecutionCommand = (commandId: ExecutionCommandId): RegisteredExecutionCommand => {
  if (!Object.hasOwn(commandPaths, commandId)) throw new HarnessError('UNREGISTERED_EXECUTION_COMMAND');
  return {
    commandId, executable: '/usr/local/bin/node',
    argv: ['--no-addons', '--disable-proto=throw', commandPaths[commandId]], argumentSchema: 'none',
    cwd: '/workspace', environment: { HOME: '/tmp', LANG: 'C.UTF-8', NODE_OPTIONS: '' },
    network: 'none', timeoutMs: EXECUTION_LIMITS.timeoutMs,
  };
};

export const assertExecutionCommand = (command: RegisteredExecutionCommand): void => {
  if (!exactKeys(command, ['commandId', 'executable', 'argv', 'argumentSchema', 'cwd', 'environment', 'network', 'timeoutMs'])
    || !Object.hasOwn(commandPaths, command.commandId)
    || JSON.stringify(command) !== JSON.stringify(getExecutionCommand(command.commandId))) {
    throw new HarnessError('UNREGISTERED_EXECUTION_COMMAND');
  }
};

export const hashExecutionConfig = (config: SandboxConfig): string => {
  const parsed = parseSandboxConfig(config);
  return sha256(JSON.stringify({
    enabled: parsed.enabled, backend: parsed.backend, policyVersion: parsed.policyVersion,
    dockerPath: parsed.dockerPath, socketPath: parsed.socketPath, serverVersion: parsed.serverVersion,
    imageId: parsed.imageId, nodeVersion: parsed.nodeVersion,
  }));
};

export const createExecutionPolicy = (config: SandboxConfig, version: ExecutionPolicyVersion = EXECUTION_POLICY_VERSION): ExecutionPolicy => ({
  version, backend: 'docker', serverVersion: config.serverVersion,
  imageId: config.imageId, nodeVersion: config.nodeVersion, configHash: hashExecutionConfig(config),
  limits: EXECUTION_LIMITS, network: 'none',
});

export const assertExecutionPolicy = (policy: ExecutionPolicy): void => {
  if (!exactKeys(policy, ['version', 'backend', 'serverVersion', 'imageId', 'nodeVersion', 'configHash', 'limits', 'network'])
    || ![EXECUTION_POLICY_VERSION, BRANCH_EXECUTION_POLICY_VERSION].includes(policy.version)
    || policy.backend !== 'docker' || policy.network !== 'none'
    || !/^\d+\.\d+\.\d+$/.test(policy.serverVersion) || !/^\d+\.\d+\.\d+$/.test(policy.nodeVersion)
    || !/^sha256:[a-f0-9]{64}$/.test(policy.imageId) || !digest(policy.configHash)
    || !exactKeys(policy.limits, Object.keys(EXECUTION_LIMITS))
    || Object.entries(EXECUTION_LIMITS).some(([key, value]) => policy.limits[key as keyof typeof EXECUTION_LIMITS] !== value)) {
    throw new HarnessError('INVALID_EXECUTION_POLICY');
  }
};

export const assertExecutionConfig = (plan: ExecutionPlan, config: SandboxConfig): void => {
  assertExecutionPlan(plan);
  if (!config.enabled || JSON.stringify(plan.policy) !== JSON.stringify(createExecutionPolicy(config, plan.policy.version))) {
    throw new HarnessError('EXECUTION_POLICY_CHANGED');
  }
};

const planContent = (plan: Omit<ExecutionPlan, 'planHash'>): Omit<ExecutionPlan, 'planHash'> => ({
  planId: plan.planId, version: plan.version, taskId: plan.taskId, requestRevision: plan.requestRevision,
  repoId: plan.repoId, baseCommit: plan.baseCommit, sourceHash: plan.sourceHash,
  allowedFiles: plan.allowedFiles,
  patches: plan.patches.map((patch) => ({
    operation: patch.operation, path: patch.path, beforeHash: patch.beforeHash, afterHash: patch.afterHash, content: patch.content,
  })),
  commands: plan.commands.map((command) => ({
    commandId: command.commandId, executable: command.executable, argv: command.argv,
    argumentSchema: command.argumentSchema, cwd: command.cwd, environment: command.environment,
    network: command.network, timeoutMs: command.timeoutMs,
  })),
  policy: plan.policy,
  ...(plan.policy.version === BRANCH_EXECUTION_POLICY_VERSION && plan.branch ? { branch: {
    workType: plan.branch.workType, name: plan.branch.name, baseBranch: plan.branch.baseBranch, headRef: plan.branch.headRef,
    ownerId: plan.branch.ownerId, sourceRoot: plan.branch.sourceRoot,
    createdAt: plan.branch.createdAt, expiresAt: plan.branch.expiresAt,
  } } : {}),
});

export const hashExecutionPlan = (plan: Omit<ExecutionPlan, 'planHash'>): string => sha256(JSON.stringify(planContent(plan)));

const assertExecutionBranch = (plan: ExecutionPlan): void => {
  const branch = plan.branch;
  if (!exactKeys(branch, ['workType', 'name', 'baseBranch', 'headRef', 'ownerId', 'sourceRoot', 'createdAt', 'expiresAt'])
    || !branch || !uuid(plan.taskId) || !['feature', 'fix', 'chore', 'refactor'].includes(branch.workType)
    || branch.name !== `${branch.workType}/task-${plan.taskId}` || branch.baseBranch !== 'main'
    || branch.headRef !== `refs/heads/${branch.name}`
    || typeof branch.ownerId !== 'string' || !/^os-user:(0|[1-9]\d{0,15})$/.test(branch.ownerId)
    || typeof branch.sourceRoot !== 'string' || Buffer.byteLength(branch.sourceRoot) > 4096
    || !isAbsolute(branch.sourceRoot) || normalize(branch.sourceRoot) !== branch.sourceRoot
    || /[\\*,]/.test(branch.sourceRoot)
    || [...branch.sourceRoot].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || !branch.sourceRoot.endsWith(`/branch-executions/${plan.taskId}/source`)
    || !timestamp(branch.createdAt) || !timestamp(branch.expiresAt)
    || Date.parse(branch.expiresAt) - Date.parse(branch.createdAt) !== branchPlanLifetimeMs) {
    throw new HarnessError('INVALID_EXECUTION_BRANCH_PLAN');
  }
};

/** 저장된 만료 계획도 조회·복구할 수 있도록 실행 직전의 시간·소유 검사를 분리한다. */
export const assertExecutionPlanReady = (plan: ExecutionPlan, ownerId: string, now: Date): void => {
  assertExecutionPlan(plan);
  if (plan.policy.version !== BRANCH_EXECUTION_POLICY_VERSION) return;
  const branch = plan.branch!;
  if (branch.ownerId !== ownerId) throw new HarnessError('APPROVAL_OWNER_MISMATCH');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getTime() < Date.parse(branch.createdAt)) {
    throw new HarnessError('INVALID_APPROVAL_TIME');
  }
  if (now.getTime() >= Date.parse(branch.expiresAt)) throw new HarnessError('EXECUTION_PLAN_EXPIRED');
};

/** 기존 실행과 브랜치 실행은 정책·저장소·필수 metadata를 함께 검증한다. */
export const assertExecutionPlan = (plan: ExecutionPlan): void => {
  const branchExecution = plan?.policy?.version === BRANCH_EXECUTION_POLICY_VERSION;
  if (!exactKeys(plan, [
    'planId', 'version', 'taskId', 'requestRevision', 'repoId', 'baseCommit', 'sourceHash',
    'allowedFiles', 'patches', 'commands', 'policy', 'planHash',
    ...(branchExecution ? ['branch'] : []),
  ]) || !identifier(plan.planId) || !identifier(plan.taskId) || plan.version !== 1
    || plan.requestRevision !== 'synthetic-1'
    || plan.repoId !== (branchExecution ? 'synthetic-branch-execution' : 'synthetic-execution')
    || !/^[a-f0-9]{40}$/.test(plan.baseCommit) || !digest(plan.sourceHash) || !digest(plan.planHash)
    || !Array.isArray(plan.allowedFiles) || plan.allowedFiles.length !== 1 || plan.allowedFiles[0] !== 'src/message.mjs'
    || !Array.isArray(plan.patches) || plan.patches.length !== 1
    || !Array.isArray(plan.commands) || plan.commands.length !== 1) throw new HarnessError('INVALID_EXECUTION_PLAN');
  const patch = plan.patches[0]!;
  if (!exactKeys(patch, ['operation', 'path', 'beforeHash', 'afterHash', 'content']) || patch.operation !== 'replace'
    || patch.path !== 'src/message.mjs' || !digest(patch.beforeHash) || !digest(patch.afterHash)
    || patch.beforeHash === patch.afterHash || typeof patch.content !== 'string'
    || Buffer.byteLength(patch.content) > 8_192 || patch.content.includes('\0')
    || containsSensitiveText(patch.content) || sha256(patch.content) !== patch.afterHash) {
    throw new HarnessError('INVALID_EXECUTION_PATCH');
  }
  for (const command of plan.commands) assertExecutionCommand(command);
  assertExecutionPolicy(plan.policy);
  if (branchExecution) assertExecutionBranch(plan);
  if (hashExecutionPlan(plan) !== plan.planHash) throw new HarnessError('PLAN_HASH_MISMATCH');
};
