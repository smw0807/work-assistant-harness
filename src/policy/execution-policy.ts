import { createHash } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import {
  EXECUTION_LIMITS, EXECUTION_POLICY_VERSION,
  type ExecutionCommandId, type ExecutionPlan, type ExecutionPolicy, type RegisteredExecutionCommand,
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

export const createExecutionPolicy = (config: SandboxConfig): ExecutionPolicy => ({
  version: EXECUTION_POLICY_VERSION, backend: 'docker', serverVersion: config.serverVersion,
  imageId: config.imageId, nodeVersion: config.nodeVersion, configHash: hashExecutionConfig(config),
  limits: EXECUTION_LIMITS, network: 'none',
});

export const assertExecutionPolicy = (policy: ExecutionPolicy): void => {
  if (!exactKeys(policy, ['version', 'backend', 'serverVersion', 'imageId', 'nodeVersion', 'configHash', 'limits', 'network'])
    || policy.version !== EXECUTION_POLICY_VERSION || policy.backend !== 'docker' || policy.network !== 'none'
    || !/^\d+\.\d+\.\d+$/.test(policy.serverVersion) || !/^\d+\.\d+\.\d+$/.test(policy.nodeVersion)
    || !/^sha256:[a-f0-9]{64}$/.test(policy.imageId) || !digest(policy.configHash)
    || !exactKeys(policy.limits, Object.keys(EXECUTION_LIMITS))
    || Object.entries(EXECUTION_LIMITS).some(([key, value]) => policy.limits[key as keyof typeof EXECUTION_LIMITS] !== value)) {
    throw new HarnessError('INVALID_EXECUTION_POLICY');
  }
};

export const assertExecutionConfig = (plan: ExecutionPlan, config: SandboxConfig): void => {
  assertExecutionPlan(plan);
  if (!config.enabled || JSON.stringify(plan.policy) !== JSON.stringify(createExecutionPolicy(config))) {
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
});

export const hashExecutionPlan = (plan: Omit<ExecutionPlan, 'planHash'>): string => sha256(JSON.stringify(planContent(plan)));

/** 3-C는 기존 합성 일반 파일 한 개의 내용 교체만 허용한다. */
export const assertExecutionPlan = (plan: ExecutionPlan): void => {
  if (!exactKeys(plan, [
    'planId', 'version', 'taskId', 'requestRevision', 'repoId', 'baseCommit', 'sourceHash',
    'allowedFiles', 'patches', 'commands', 'policy', 'planHash',
  ]) || !identifier(plan.planId) || !identifier(plan.taskId) || plan.version !== 1
    || plan.requestRevision !== 'synthetic-1' || plan.repoId !== 'synthetic-execution'
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
  if (hashExecutionPlan(plan) !== plan.planHash) throw new HarnessError('PLAN_HASH_MISMATCH');
};
