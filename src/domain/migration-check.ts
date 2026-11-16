import type { ReadonlyRelayConfig, ReadonlyRelayProfileId } from './readonly-relay.js';
import type { ReadonlyRelayExecutionBudget } from './readonly-relay-budget.js';
import type { PersonalCollectionProfile } from './personal-readonly-collection.js';

export const MIGRATION_CHECK_VERSION = 'offline-migration-check-v1' as const;
export const MIGRATION_CODEX_VERSION = '0.154.0' as const;
export const MIGRATION_CODEX_SHA256 = '4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc' as const;
export const MIGRATION_NODE_RANGE = '>=26.12.1 <27' as const;
export const MIGRATION_PNPM_POLICY = 'installed-pnpm' as const;

export interface MigrationCheckConfig {
  version: typeof MIGRATION_CHECK_VERSION;
  relay: ReadonlyRelayConfig;
  runtimeDirectory: string;
}
export interface MigrationHostObservation {
  platform: string;
  arch: string;
  nodeVersion: string;
  uid: number | null;
  pnpmUserAgent: string | null;
}
export const MIGRATION_PROBE_REASONS = [
  'PATHS_SEPARATE', 'SANDBOX_METADATA_MATCH', 'BINARY_PIN_MATCH', 'DIRECTORY_METADATA_PRIVATE',
  'MISSING', 'UNSAFE_PATH', 'UNSAFE_FILE', 'UNSAFE_DIRECTORY', 'OVERLAP', 'IDENTITY_MISMATCH',
  'CHANGED_DURING_READ', 'READ_FAILED', 'PIN_MISMATCH', 'INVALID_OBSERVATION', 'OBSERVATION_FAILED',
] as const;
export type MigrationProbeReason = typeof MIGRATION_PROBE_REASONS[number];
export interface MigrationProbeObservation { status: 'passed' | 'failed'; reason: MigrationProbeReason }
export type MigrationCheckId = 'configuration' | 'host' | 'node' | 'pnpmLauncher' | 'owner'
  | 'pathSeparation' | 'sandboxExecutable' | 'nativeBinary' | 'runtimeDirectory'
  | 'credentialAccess' | 'modelCall' | 'companyApproval' | 'companySource' | 'network'
  | 'nativeVersionExecution' | 'sandboxRuntime' | 'storageWriteProbe';
export type MigrationCheckReason = MigrationProbeReason | 'CONFIG_VALID_DISABLED' | 'HOST_SUPPORTED' | 'HOST_UNSUPPORTED'
  | 'NODE_SUPPORTED' | 'NODE_UNSUPPORTED' | 'PNPM_DECLARATION_PRESENT' | 'PNPM_DECLARATION_INVALID'
  | 'PNPM_DECLARATION_UNAVAILABLE' | 'UID_AVAILABLE' | 'UID_UNAVAILABLE' | 'PREREQUISITE_FAILED' | 'OUTSIDE_OFFLINE_SCOPE';
export interface MigrationCheckItem {
  id: MigrationCheckId;
  status: 'passed' | 'failed' | 'not_run';
  reason: MigrationCheckReason;
}
export interface MigrationCheckReport {
  version: typeof MIGRATION_CHECK_VERSION;
  mode: 'offline';
  status: 'passed' | 'blocked';
  liveReady: false;
  executionAllowed: false;
  approvalCreated: false;
  checks: MigrationCheckItem[];
  environment: {
    platform: 'darwin' | 'unsupported';
    arch: 'arm64' | 'unsupported';
    nodeVersion: string | null;
    pnpmLauncherVersion: string | null;
    pnpmEvidence: 'unverified_launcher_metadata';
  };
  expected: { node: typeof MIGRATION_NODE_RANGE; pnpm: typeof MIGRATION_PNPM_POLICY;
    codexVersion: typeof MIGRATION_CODEX_VERSION; codexSha256: typeof MIGRATION_CODEX_SHA256 };
  contracts: {
    diagnosticConfigHash: string;
    relayPolicyVersion: ReadonlyRelayConfig['policyVersion'];
    profileId: ReadonlyRelayProfileId;
    relayConfigHash: string;
    connectionProfileHash: string;
    executionBudget: ReadonlyRelayExecutionBudget;
    executionBudgetHash: string;
    collectionProfile: PersonalCollectionProfile;
    collectionProfileHash: string;
  };
}
