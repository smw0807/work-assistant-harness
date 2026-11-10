import { isAbsolute } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import { SANDBOX_POLICY_VERSION, type SandboxConfig } from '../domain/sandbox.js';

const configKeys = [
  'enabled', 'backend', 'policyVersion', 'dockerPath', 'socketPath', 'serverVersion', 'imageId', 'nodeVersion',
];
const isVersion = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);

export const parseSandboxConfig = (value: unknown): SandboxConfig => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessError('INVALID_SANDBOX_CONFIG');
  const config = value as Record<string, unknown>;
  if (Object.keys(config).length !== configKeys.length || Object.keys(config).some((key) => !configKeys.includes(key))
    || typeof config.enabled !== 'boolean' || config.backend !== 'docker' || config.policyVersion !== SANDBOX_POLICY_VERSION
    || config.dockerPath !== '/usr/local/bin/docker'
    || typeof config.socketPath !== 'string' || !isAbsolute(config.socketPath)
    || config.socketPath.length > 1_024 || [...config.socketPath].some((character) => character.charCodeAt(0) <= 32 || character === ',')
    || !isVersion(config.serverVersion) || !isVersion(config.nodeVersion)
    || typeof config.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(config.imageId)) {
    throw new HarnessError('INVALID_SANDBOX_CONFIG');
  }
  return Object.freeze({ ...config }) as unknown as SandboxConfig;
};

export const assertSandboxHost = (platform: string, architecture: string): void => {
  if (platform !== 'darwin' || architecture !== 'arm64') throw new HarnessError('SANDBOX_UNSUPPORTED_HOST');
};
