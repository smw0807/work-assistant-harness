import { isAbsolute, normalize } from 'node:path';
import type { CodexConfig } from '../domain/codex-config.js';
import { HarnessError } from '../domain/errors.js';
import { sha256 } from './execution-policy.js';

export const parseCodexConfig = (value: unknown): CodexConfig => {
  const keys = ['enabled', 'policyVersion', 'codexPath', 'codexSha256', 'model', 'authMode', 'timeoutMs', 'maxResponseBytes'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new HarnessError('INVALID_CODEX_CONFIG');
  }
  const config = value as CodexConfig;
  if (typeof config.enabled !== 'boolean' || config.policyVersion !== 'codex-cli-proposal-v1'
    || typeof config.codexPath !== 'string' || !isAbsolute(config.codexPath) || normalize(config.codexPath) !== config.codexPath
    || !/^[A-Za-z0-9/_. -]{1,4096}$/.test(config.codexPath)
    || !/^[a-f0-9]{64}$/.test(config.codexSha256) || !/^[a-z][a-z0-9.-]{0,79}$/.test(config.model)
    || !['api-key', 'chatgpt'].includes(config.authMode) || config.timeoutMs !== 60000 || config.maxResponseBytes !== 16384) {
    throw new HarnessError('INVALID_CODEX_CONFIG');
  }
  return { enabled: config.enabled, policyVersion: config.policyVersion, codexPath: config.codexPath,
    codexSha256: config.codexSha256, model: config.model, authMode: config.authMode,
    timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes };
};

export const hashCodexConfig = (config: CodexConfig): string => sha256(JSON.stringify(parseCodexConfig(config)));
