import { MIGRATION_CHECK_VERSION, MIGRATION_CODEX_SHA256, MIGRATION_CODEX_VERSION, MIGRATION_NODE_RANGE,
  MIGRATION_PNPM_VERSION, MIGRATION_PROBE_REASONS, type MigrationCheckConfig, type MigrationCheckId,
  type MigrationCheckItem, type MigrationCheckReport, type MigrationHostObservation, type MigrationProbeObservation } from '../domain/migration-check.js';
import type { MigrationCheckPort } from '../ports/migration-check.js';
import { hashMigrationCheckConfig, migrationNodeSupported, migrationPnpmDeclaration, parseMigrationCheckConfig } from '../policy/migration-check.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { getAnyReadonlyRelayConfigHash, getAnyReadonlyRelayProfileHash, getAnyReadonlyRelayProfileId,
  getReadonlyRelayExecutionBudget } from '../policy/readonly-relay-budget-policy.js';
import { getPersonalCollectionProfile, getPersonalCollectionProfileHash } from '../policy/personal-readonly-collection.js';

const unavailableHost = (): MigrationHostObservation => ({ platform: '', arch: '', nodeVersion: '', uid: null, pnpmUserAgent: null });
const observeHost = (port: MigrationCheckPort): MigrationHostObservation => {
  try {
    const value = port.observeHost();
    const keys = ['platform', 'arch', 'nodeVersion', 'uid', 'pnpmUserAgent'];
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== keys.length) return unavailableHost();
    const fields = Object.fromEntries(keys.map((key) => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw new Error();
      return [key, field.value];
    }));
    if (typeof fields.platform !== 'string' || typeof fields.arch !== 'string' || typeof fields.nodeVersion !== 'string'
      || fields.nodeVersion.length > 32 || !(fields.uid === null || Number.isSafeInteger(fields.uid) && (fields.uid as number) >= 0)
      || !(fields.pnpmUserAgent === null || typeof fields.pnpmUserAgent === 'string')) return unavailableHost();
    return fields as unknown as MigrationHostObservation;
  } catch { return unavailableHost(); }
};
const probe = async (id: MigrationCheckId, action: () => Promise<MigrationProbeObservation>, expected: MigrationProbeObservation['reason']): Promise<MigrationCheckItem> => {
  try {
    const value = await action();
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== 2) return { id, status: 'failed', reason: 'INVALID_OBSERVATION' };
    const status = Object.getOwnPropertyDescriptor(value, 'status'), reason = Object.getOwnPropertyDescriptor(value, 'reason');
    if (!status?.enumerable || !Object.hasOwn(status, 'value') || !reason?.enumerable || !Object.hasOwn(reason, 'value')
      || !['passed', 'failed'].includes(status.value) || !(MIGRATION_PROBE_REASONS as readonly unknown[]).includes(reason.value)
      || status.value === 'passed' && reason.value !== expected
      || status.value === 'failed' && ['PATHS_SEPARATE', 'SANDBOX_METADATA_MATCH', 'BINARY_PIN_MATCH', 'DIRECTORY_METADATA_PRIVATE'].includes(reason.value)) {
      return { id, status: 'failed', reason: 'INVALID_OBSERVATION' };
    }
    return { id, status: status.value, reason: reason.value };
  } catch { return { id, status: 'failed', reason: 'OBSERVATION_FAILED' }; }
};

/** A static diagnostic creates neither an approval nor a live capability, even when every checked prerequisite matches. */
export class MigrationCheckService {
  constructor(private readonly port: MigrationCheckPort) {}

  async check(value: unknown): Promise<MigrationCheckReport> {
    const config: MigrationCheckConfig = parseMigrationCheckConfig(value);
    const host = observeHost(this.port), hostSupported = host.platform === 'darwin' && host.arch === 'arm64';
    const nodeSupported = migrationNodeSupported(host.nodeVersion), ownerAvailable = host.uid !== null;
    const pnpm = migrationPnpmDeclaration(host.pnpmUserAgent);
    const checks: MigrationCheckItem[] = [
      { id: 'configuration', status: 'passed', reason: 'CONFIG_VALID_DISABLED' },
      { id: 'host', status: hostSupported ? 'passed' : 'failed', reason: hostSupported ? 'HOST_SUPPORTED' : 'HOST_UNSUPPORTED' },
      { id: 'node', status: nodeSupported ? 'passed' : 'failed', reason: nodeSupported ? 'NODE_SUPPORTED' : 'NODE_UNSUPPORTED' },
      { id: 'pnpmLauncher', status: host.pnpmUserAgent === null ? 'not_run' : pnpm === MIGRATION_PNPM_VERSION ? 'passed' : 'failed',
        reason: host.pnpmUserAgent === null ? 'PNPM_DECLARATION_UNAVAILABLE' : pnpm === MIGRATION_PNPM_VERSION ? 'PNPM_DECLARATION_MATCH' : 'PNPM_DECLARATION_MISMATCH' },
      { id: 'owner', status: ownerAvailable ? 'passed' : 'failed', reason: ownerAvailable ? 'UID_AVAILABLE' : 'UID_UNAVAILABLE' },
    ];
    const prerequisite = hostSupported && nodeSupported && ownerAvailable && pnpm === MIGRATION_PNPM_VERSION;
    const paths = prerequisite ? await probe('pathSeparation', () => this.port.inspectPaths(config), 'PATHS_SEPARATE')
      : { id: 'pathSeparation' as const, status: 'not_run' as const, reason: 'PREREQUISITE_FAILED' as const };
    checks.push(paths);
    const resources = [
      { id: 'sandboxExecutable' as const, expected: 'SANDBOX_METADATA_MATCH' as const, action: () => this.port.inspectSandboxExecutable() },
      { id: 'nativeBinary' as const, expected: 'BINARY_PIN_MATCH' as const, action: () => this.port.inspectBinary(config.relay) },
      { id: 'runtimeDirectory' as const, expected: 'DIRECTORY_METADATA_PRIVATE' as const, action: () => this.port.inspectRuntimeDirectory(config.runtimeDirectory) },
    ];
    for (const item of resources) checks.push(paths.status === 'passed' ? await probe(item.id, item.action, item.expected)
      : { id: item.id, status: 'not_run', reason: 'PREREQUISITE_FAILED' });
    const staticPassed = checks.every((item) => item.status === 'passed');
    for (const id of ['credentialAccess', 'modelCall', 'companyApproval', 'companySource', 'network', 'nativeVersionExecution',
      'sandboxRuntime', 'storageWriteProbe'] as const) checks.push({ id, status: 'not_run', reason: 'OUTSIDE_OFFLINE_SCOPE' });
    const profileId = getAnyReadonlyRelayProfileId(config.relay), budget = getReadonlyRelayExecutionBudget(config.relay);
    return { version: MIGRATION_CHECK_VERSION, mode: 'offline', status: staticPassed ? 'passed' : 'blocked',
      liveReady: false, executionAllowed: false, approvalCreated: false, checks,
      environment: { platform: host.platform === 'darwin' ? 'darwin' : 'unsupported', arch: host.arch === 'arm64' ? 'arm64' : 'unsupported',
        nodeVersion: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(host.nodeVersion) ? host.nodeVersion : null,
        pnpmLauncherVersion: pnpm, pnpmEvidence: 'unverified_launcher_metadata' },
      expected: { node: MIGRATION_NODE_RANGE, pnpm: MIGRATION_PNPM_VERSION, codexVersion: MIGRATION_CODEX_VERSION, codexSha256: MIGRATION_CODEX_SHA256 },
      contracts: { diagnosticConfigHash: hashMigrationCheckConfig(config), relayPolicyVersion: config.relay.policyVersion, profileId,
        relayConfigHash: getAnyReadonlyRelayConfigHash(profileId, config.relay), connectionProfileHash: getAnyReadonlyRelayProfileHash(profileId, config.relay),
        executionBudget: { ...budget }, executionBudgetHash: hashReadonlyValue(canonicalReadonlyJson(budget)),
        collectionProfile: structuredClone(getPersonalCollectionProfile()), collectionProfileHash: getPersonalCollectionProfileHash() } };
  }
}
