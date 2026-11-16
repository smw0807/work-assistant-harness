import { posix } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import { MIGRATION_CHECK_VERSION, MIGRATION_PARTIAL_CHECK_VERSION, MIGRATION_CODEX_SHA256,
  type MigrationCheckConfig, type MigrationPartialCheckConfig } from '../domain/migration-check.js';
import { canonicalReadonlyJson, hashReadonlyValue } from './readonly-investigation-policy.js';
import { parseAnyReadonlyRelayConfig } from './readonly-relay-budget-policy.js';

const reject = (code = 'MIGRATION_CHECK_INVALID_CONFIG'): never => { throw new HarnessError(code); };
const snapshot = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length) return reject();
  return Object.fromEntries(keys.map((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return reject();
    return [key, field.value];
  }));
};
const sensitiveParts = new Set(['.codex', '.ssh', '.aws', '.azure', '.git', '.kube', '.docker', '.gnupg',
  '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'auth', 'auth.json', 'credential', 'credentials', 'credentials.json',
  'token', 'tokens', 'token.json', 'tokens.json', 'secret', 'secrets', 'secrets.json', 'keychains', 'id_rsa', 'id_ed25519']);

/** Lexical allowlist only; the filesystem adapter separately rejects links and path replacement. */
export const assertMigrationPath = (value: unknown, kind: 'config' | 'binary' | 'directory'): string => {
  if (!['config', 'binary', 'directory'].includes(kind) || typeof value !== 'string' || value.length > 4096 || !/^\/[A-Za-z0-9/_. -]+$/u.test(value)
    || value === '/' || value.endsWith('/') || posix.normalize(value) !== value
    || value.split('/').some((part) => sensitiveParts.has(part.toLowerCase()) || part.toLowerCase().startsWith('.env'))) {
    return reject('MIGRATION_CHECK_UNSAFE_PATH');
  }
  const name = posix.basename(value);
  if (kind === 'binary' && name !== 'codex'
    || kind === 'config' && !['migration-check.json', 'migration-check.example.json'].includes(name)) {
    return reject('MIGRATION_CHECK_UNSAFE_PATH');
  }
  return value;
};

export const parseMigrationCheckConfig = (value: unknown): MigrationCheckConfig => {
  try {
    const fields = snapshot(value, ['version', 'relay', 'runtimeDirectory']);
    const relayFields = snapshot(fields.relay, ['enabled', 'policyVersion', 'codexPath', 'codexSha256', 'model', 'authMode', 'timeoutMs', 'maxResponseBytes']);
    if (fields.version !== MIGRATION_CHECK_VERSION || relayFields.enabled !== false
      || !['readonly-relay-codex-v2', 'readonly-relay-codex-v3'].includes(relayFields.policyVersion as string)
      || relayFields.codexSha256 !== MIGRATION_CODEX_SHA256) return reject();
    assertMigrationPath(relayFields.codexPath, 'binary');
    const runtimeDirectory = assertMigrationPath(fields.runtimeDirectory, 'directory');
    return Object.freeze({ version: MIGRATION_CHECK_VERSION, relay: Object.freeze(parseAnyReadonlyRelayConfig(relayFields)), runtimeDirectory });
  } catch { return reject(); }
};
export const hashMigrationCheckConfig = (value: unknown): string =>
  hashReadonlyValue(canonicalReadonlyJson(parseMigrationCheckConfig(value)));

/** Partial runtime input must not redirect metadata probes to omitted executables or paths beneath them. */
export const assertMigrationPartialRuntimePath = (value: unknown): string => {
  const path = assertMigrationPath(value, 'directory');
  if (path.split('/').some(part => ['codex', 'sandbox-exec'].includes(part.toLowerCase()))) {
    return reject('MIGRATION_CHECK_UNSAFE_PATH');
  }
  return path;
};

/** Separate input contract: omission from a full configuration never selects a partial check. */
export const parseMigrationPartialCheckConfig = (value: unknown): MigrationPartialCheckConfig => {
  try {
    const fields = snapshot(value, ['version', 'enabled', 'runtimeDirectory']);
    if (fields.version !== MIGRATION_PARTIAL_CHECK_VERSION || fields.enabled !== false) return reject();
    const runtimeDirectory = assertMigrationPartialRuntimePath(fields.runtimeDirectory);
    return Object.freeze({ version: MIGRATION_PARTIAL_CHECK_VERSION, enabled: false, runtimeDirectory });
  } catch { return reject(); }
};
export const hashMigrationPartialCheckConfig = (value: unknown): string =>
  hashReadonlyValue(canonicalReadonlyJson(parseMigrationPartialCheckConfig(value)));

export const migrationNodeSupported = (version: string): boolean => {
  if (version.length > 32 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return major === 26 && Number.isSafeInteger(minor) && Number.isSafeInteger(patch)
    && (minor! > 12 || minor === 12 && patch! >= 1);
};
export const migrationPnpmDeclaration = (value: string | null): string | null => {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n\0]/u.test(value)) return null;
  const match = /^pnpm\/((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?: |$)/u.exec(value);
  return match && match[1]!.length <= 32 ? match[1]! : null;
};
