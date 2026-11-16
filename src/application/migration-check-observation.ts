import { MIGRATION_PROBE_REASONS, type MigrationCheckId, type MigrationCheckItem,
  type MigrationHostObservation, type MigrationProbeObservation } from '../domain/migration-check.js';

const unavailableHost = (): MigrationHostObservation => ({ platform: '', arch: '', nodeVersion: '', uid: null, pnpmUserAgent: null });

export const observeMigrationHost = (port: { observeHost(): MigrationHostObservation }): MigrationHostObservation => {
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

export const probeMigrationResource = async (id: MigrationCheckId, action: () => Promise<MigrationProbeObservation>,
  expected: MigrationProbeObservation['reason']): Promise<MigrationCheckItem> => {
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
