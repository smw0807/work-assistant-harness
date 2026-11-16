import { MIGRATION_NODE_RANGE, MIGRATION_PARTIAL_CHECK_VERSION, MIGRATION_PNPM_POLICY,
  type MigrationCheckItem, type MigrationPartialCheckConfig, type MigrationPartialCheckReport } from '../domain/migration-check.js';
import type { MigrationPartialCheckPort } from '../ports/migration-check.js';
import { hashMigrationPartialCheckConfig, migrationNodeSupported, migrationPnpmDeclaration,
  parseMigrationPartialCheckConfig } from '../policy/migration-check.js';
import { observeMigrationHost, probeMigrationResource } from './migration-check-observation.js';

/** Passing partial prerequisites leaves the full diagnostic blocked until its two omitted file checks run. */
export class MigrationPartialCheckService {
  constructor(private readonly port: MigrationPartialCheckPort) {}

  async check(value: unknown): Promise<MigrationPartialCheckReport> {
    const config: MigrationPartialCheckConfig = parseMigrationPartialCheckConfig(value);
    const host = observeMigrationHost(this.port), hostSupported = host.platform === 'darwin' && host.arch === 'arm64';
    const nodeSupported = migrationNodeSupported(host.nodeVersion), ownerAvailable = host.uid !== null;
    const pnpm = migrationPnpmDeclaration(host.pnpmUserAgent);
    const checks: MigrationCheckItem[] = [
      { id: 'configuration', status: 'passed', reason: 'CONFIG_VALID_DISABLED' },
      { id: 'host', status: hostSupported ? 'passed' : 'failed', reason: hostSupported ? 'HOST_SUPPORTED' : 'HOST_UNSUPPORTED' },
      { id: 'node', status: nodeSupported ? 'passed' : 'failed', reason: nodeSupported ? 'NODE_SUPPORTED' : 'NODE_UNSUPPORTED' },
      { id: 'pnpmLauncher', status: host.pnpmUserAgent === null ? 'not_run' : pnpm !== null ? 'passed' : 'failed',
        reason: host.pnpmUserAgent === null ? 'PNPM_DECLARATION_UNAVAILABLE' : pnpm !== null ? 'PNPM_DECLARATION_PRESENT' : 'PNPM_DECLARATION_INVALID' },
      { id: 'owner', status: ownerAvailable ? 'passed' : 'failed', reason: ownerAvailable ? 'UID_AVAILABLE' : 'UID_UNAVAILABLE' },
    ];
    const prerequisite = hostSupported && nodeSupported && ownerAvailable && pnpm !== null;
    const paths = prerequisite ? await probeMigrationResource('pathSeparation', () => this.port.inspectPartialPaths(config), 'PATHS_SEPARATE')
      : { id: 'pathSeparation' as const, status: 'not_run' as const, reason: 'PREREQUISITE_FAILED' as const };
    checks.push(paths);
    checks.push(paths.status === 'passed'
      ? await probeMigrationResource('runtimeDirectory', () => this.port.inspectRuntimeDirectory(config.runtimeDirectory), 'DIRECTORY_METADATA_PRIVATE')
      : { id: 'runtimeDirectory', status: 'not_run', reason: 'PREREQUISITE_FAILED' });
    const partialPassed = checks.every(item => item.status === 'passed');
    for (const id of ['sandboxExecutable', 'nativeBinary'] as const) {
      checks.push({ id, status: 'not_run', reason: 'NOT_INCLUDED_IN_PARTIAL_CHECK' });
    }
    for (const id of ['credentialAccess', 'modelCall', 'companyApproval', 'companySource', 'network', 'nativeVersionExecution',
      'sandboxRuntime', 'storageWriteProbe'] as const) checks.push({ id, status: 'not_run', reason: 'OUTSIDE_OFFLINE_SCOPE' });
    const nextActions: MigrationPartialCheckReport['nextActions'] = partialPassed
      ? ['RUN_FULL_CHECK_WITH_APPROVED_NATIVE'] : ['FIX_PARTIAL_CHECKS', 'RUN_FULL_CHECK_WITH_APPROVED_NATIVE'];
    return { version: MIGRATION_PARTIAL_CHECK_VERSION, mode: 'offline', scope: 'partial', status: 'blocked',
      partialStatus: partialPassed ? 'passed' : 'blocked', liveReady: false, executionAllowed: false, approvalCreated: false, checks,
      environment: { platform: host.platform === 'darwin' ? 'darwin' : 'unsupported', arch: host.arch === 'arm64' ? 'arm64' : 'unsupported',
        nodeVersion: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(host.nodeVersion) ? host.nodeVersion : null,
        pnpmLauncherVersion: pnpm, pnpmEvidence: 'unverified_launcher_metadata' },
      expected: { node: MIGRATION_NODE_RANGE, pnpm: MIGRATION_PNPM_POLICY },
      diagnosticConfigHash: hashMigrationPartialCheckConfig(config), remainingChecks: ['sandboxExecutable', 'nativeBinary'], nextActions };
  }
}
