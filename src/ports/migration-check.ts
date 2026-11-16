import type { MigrationCheckConfig, MigrationPartialCheckConfig, MigrationHostObservation, MigrationProbeObservation } from '../domain/migration-check.js';
import type { ReadonlyRelayConfig } from '../domain/readonly-relay.js';

/** No credentials, repository content, process execution, network or writes are exposed by this port. */
export interface MigrationCheckPort {
  observeHost(): MigrationHostObservation;
  inspectPaths(config: MigrationCheckConfig): Promise<MigrationProbeObservation>;
  inspectSandboxExecutable(): Promise<MigrationProbeObservation>;
  inspectBinary(config: ReadonlyRelayConfig): Promise<MigrationProbeObservation>;
  inspectRuntimeDirectory(path: string): Promise<MigrationProbeObservation>;
}

/** The partial path has no native or sandbox executable inspection capability. */
export interface MigrationPartialCheckPort {
  observeHost(): MigrationHostObservation;
  inspectPartialPaths(config: MigrationPartialCheckConfig): Promise<MigrationProbeObservation>;
  inspectRuntimeDirectory(path: string): Promise<MigrationProbeObservation>;
}
