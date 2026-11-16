import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MigrationCheckService } from '../src/application/migration-check.js';
import { MIGRATION_CHECK_VERSION, MIGRATION_CODEX_SHA256, type MigrationCheckConfig,
  type MigrationHostObservation, type MigrationProbeObservation } from '../src/domain/migration-check.js';
import type { MigrationCheckPort } from '../src/ports/migration-check.js';
import { assertMigrationPath, hashMigrationCheckConfig, migrationNodeSupported, migrationPnpmDeclaration,
  parseMigrationCheckConfig } from '../src/policy/migration-check.js';
import { getAnyReadonlyRelayConfigHash, getAnyReadonlyRelayProfileHash, getReadonlyRelayExecutionBudgetHash } from '../src/policy/readonly-relay-budget-policy.js';
import { getPersonalCollectionProfileHash } from '../src/policy/personal-readonly-collection.js';
import { getReadonlyRelayProfileHash } from '../src/policy/readonly-relay-policy.js';

const config: MigrationCheckConfig = { version: MIGRATION_CHECK_VERSION, relay: { enabled: false,
  policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/native/codex', codexSha256: MIGRATION_CODEX_SHA256,
  model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 }, runtimeDirectory: '/synthetic/private-runtime' };
const host: MigrationHostObservation = { platform: 'darwin', arch: 'arm64', nodeVersion: '26.12.1', uid: 501,
  pnpmUserAgent: 'pnpm/12.16.1 npm/? node/v26.12.1 darwin arm64' };
const fakePort = (hostValue: MigrationHostObservation = host) => {
  const calls: string[] = [];
  const port: MigrationCheckPort = {
    observeHost: () => { calls.push('host'); return hostValue; },
    inspectPaths: async () => { calls.push('paths'); return { status: 'passed', reason: 'PATHS_SEPARATE' }; },
    inspectSandboxExecutable: async () => { calls.push('sandbox'); return { status: 'passed', reason: 'SANDBOX_METADATA_MATCH' }; },
    inspectBinary: async () => { calls.push('binary'); return { status: 'passed', reason: 'BINARY_PIN_MATCH' }; },
    inspectRuntimeDirectory: async () => { calls.push('directory'); return { status: 'passed', reason: 'DIRECTORY_METADATA_PRIVATE' }; },
  };
  return { port, calls };
};

test('migration config is disabled, fixed to known binary and existing v2/v3 contracts with detached immutable copies', () => {
  const parsed = parseMigrationCheckConfig(config);
  assert.deepEqual(parsed, config); assert.notEqual(parsed, config); assert.notEqual(parsed.relay, config.relay);
  assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.relay));
  assert.equal(hashMigrationCheckConfig(parsed), hashMigrationCheckConfig(config));
  const legacy = { ...config, relay: { ...config.relay, policyVersion: 'readonly-relay-codex-v2' as const, timeoutMs: 60000 as const } };
  assert.deepEqual(parseMigrationCheckConfig(legacy), legacy);
  for (const value of [null, [], { ...config, enabled: false }, { ...config, sourceRoot: '/synthetic/company' },
    { ...config, authFile: '/synthetic/auth.json' }, { ...config, version: 'migration-live' },
    { ...config, relay: { ...config.relay, enabled: true } }, { ...config, relay: { ...config.relay, codexSha256: 'a'.repeat(64) } },
    { ...config, relay: { ...config.relay, timeoutMs: 120000 } }, { ...config, relay: { ...config.relay, maxResponseBytes: 32768 } },
    { ...config, relay: { ...config.relay, policyVersion: 'readonly-relay-codex-v1', timeoutMs: 60000 } },
    { ...config, relay: { ...config.relay, token: 'synthetic-hidden-value' } }]) {
    assert.throws(() => parseMigrationCheckConfig(value), { code: 'MIGRATION_CHECK_INVALID_CONFIG' });
  }
});

test('migration config rejects nested accessors, symbols and prototypes without evaluating getters', () => {
  let evaluated = 0;
  const getter = Object.defineProperty({ ...config.relay }, 'codexPath', { enumerable: true, get: () => { evaluated++; return config.relay.codexPath; } });
  for (const value of [{ ...config, relay: getter }, { ...config, [Symbol('extra')]: true },
    Object.assign(Object.create({ inherited: true }), config), { ...config, relay: { ...config.relay, [Symbol('extra')]: true } },
    Object.defineProperty({ ...config }, 'relay', { enumerable: true, get: () => { evaluated++; return config.relay; } })]) {
    assert.throws(() => parseMigrationCheckConfig(value), { code: 'MIGRATION_CHECK_INVALID_CONFIG' });
  }
  assert.equal(evaluated, 0);
});

test('migration paths reject credential and repository metadata locations before any filesystem port', async () => {
  for (const part of ['.codex', '.ssh', '.aws', '.azure', '.git', '.kube', '.docker', '.gnupg', '.netrc', '.npmrc',
    '.pypirc', '.git-credentials', '.env', '.env.local', 'auth.json', 'credentials', 'tokens', 'secrets', 'Keychains']) {
    assert.throws(() => assertMigrationPath(`/synthetic/${part}/codex`, 'binary'), { code: 'MIGRATION_CHECK_UNSAFE_PATH' });
  }
  for (const value of ['/', '/synthetic/../codex', '/synthetic//codex', 'relative/codex', '/synthetic/codex/',
    '/synthetic/*/codex', '/synthetic/hidden\n/codex', '/synthetic/./codex', '/synthetic/auth.json']) {
    assert.throws(() => assertMigrationPath(value, 'binary'), { code: 'MIGRATION_CHECK_UNSAFE_PATH' });
  }
  assert.equal(assertMigrationPath('/synthetic/migration-check.json', 'config'), '/synthetic/migration-check.json');
  assert.equal(assertMigrationPath('/synthetic/migration-check.example.json', 'config'), '/synthetic/migration-check.example.json');
  assert.throws(() => assertMigrationPath('/synthetic/arbitrary.json', 'config'));
  const f = fakePort();
  await assert.rejects(new MigrationCheckService(f.port).check({ ...config, runtimeDirectory: '/synthetic/.codex' }));
  assert.deepEqual(f.calls, []);
});

test('migration runtime comparison has exact semver boundaries and treats pnpm only as launcher metadata', () => {
  for (const value of ['26.12.1', '26.12.2', '26.13.0', '26.99.99']) assert.equal(migrationNodeSupported(value), true);
  for (const value of ['26.12.0', '26.11.99', '25.99.99', '27.0.0', 'v26.12.1', '26.12.1-rc.1', '026.12.1', '26.12', '26.12.1\n']) {
    assert.equal(migrationNodeSupported(value), false);
  }
  assert.equal(migrationPnpmDeclaration(host.pnpmUserAgent), '12.16.1');
  assert.equal(migrationPnpmDeclaration('pnpm/12.18.1'), '12.18.1');
  for (const value of [null, '', 'npm/12.18.0', 'pnpm/12.18.0\nsynthetic', 'x'.repeat(513)]) assert.equal(migrationPnpmDeclaration(value), null);
});

test('migration records valid pnpm declarations without a version pin or a compatibility claim', async () => {
  for (const version of ['12.16.1', '12.18.0', '12.18.1', '10.29.3', '13.0.0']) {
    const f = fakePort({ ...host, pnpmUserAgent: `pnpm/${version} npm/? node/v26.12.1` });
    const result = await new MigrationCheckService(f.port).check(config);
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.checks.find(item => item.id === 'pnpmLauncher'),
      { id: 'pnpmLauncher', status: 'passed', reason: 'PNPM_DECLARATION_PRESENT' });
    assert.equal(result.environment.pnpmLauncherVersion, version);
    assert.equal(result.environment.pnpmEvidence, 'unverified_launcher_metadata');
    assert.equal(result.expected.pnpm, 'installed-pnpm');
    assert.deepEqual(f.calls, ['host', 'paths', 'sandbox', 'binary', 'directory']);
    assert.deepEqual([result.liveReady, result.executionAllowed, result.approvalCreated], [false, false, false]);
  }
});

test('missing and invalid pnpm declarations block resource probes without exposing launcher input', async () => {
  for (const pnpmUserAgent of [null, '', 'npm/12.16.1', 'yarn/4.0.0', 'pnpm/012.16.1', 'pnpm/12.16',
    'pnpm/12.16.1-rc.1', 'pnpm/12.16.1\nSYNTHETIC_LAUNCHER_INPUT', 'x'.repeat(513)]) {
    const f = fakePort({ ...host, pnpmUserAgent });
    const result = await new MigrationCheckService(f.port).check(config);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.checks.find(item => item.id === 'pnpmLauncher'), { id: 'pnpmLauncher',
      status: pnpmUserAgent === null ? 'not_run' : 'failed',
      reason: pnpmUserAgent === null ? 'PNPM_DECLARATION_UNAVAILABLE' : 'PNPM_DECLARATION_INVALID' });
    assert.equal(result.environment.pnpmLauncherVersion, null);
    assert.deepEqual(f.calls, ['host']);
    for (const id of ['pathSeparation', 'sandboxExecutable', 'nativeBinary', 'runtimeDirectory']) {
      assert.deepEqual(result.checks.find(item => item.id === id), { id, status: 'not_run', reason: 'PREREQUISITE_FAILED' });
    }
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_LAUNCHER_INPUT'), false);
  }
});

test('successful migration checks disclose every unrun capability and preserve contract hashes without leaking paths', async () => {
  const f = fakePort(); const result = await new MigrationCheckService(f.port).check(config);
  assert.equal(result.status, 'passed'); assert.equal(result.mode, 'offline');
  assert.deepEqual([result.liveReady, result.executionAllowed, result.approvalCreated], [false, false, false]);
  assert.deepEqual(f.calls, ['host', 'paths', 'sandbox', 'binary', 'directory']);
  assert.equal(result.environment.pnpmEvidence, 'unverified_launcher_metadata');
  assert.equal(result.contracts.connectionProfileHash, getAnyReadonlyRelayProfileHash('codex-chatgpt-relay-v3', config.relay));
  assert.equal(result.contracts.relayConfigHash, getAnyReadonlyRelayConfigHash('codex-chatgpt-relay-v3', config.relay));
  assert.equal(result.contracts.executionBudgetHash, getReadonlyRelayExecutionBudgetHash());
  assert.equal(result.contracts.collectionProfileHash, getPersonalCollectionProfileHash());
  assert.equal(result.contracts.collectionProfile.limits.sourceFileBytes, 65536);
  assert.equal(result.contracts.collectionProfile.limits.files, 8);
  assert.equal(result.contracts.executionBudget.frames, 8192);
  assert.equal(result.contracts.executionBudget.workTimeoutMs, 120000);
  assert.deepEqual(result.checks.filter(item => item.status === 'not_run').map(item => item.id),
    ['credentialAccess', 'modelCall', 'companyApproval', 'companySource', 'network', 'nativeVersionExecution', 'sandboxRuntime', 'storageWriteProbe']);
  assert.equal(JSON.stringify(result).includes('/synthetic/'), false);
  assert.equal(JSON.stringify(result).includes('configSnapshot'), false);
});

test('legacy v2 diagnostics retain the previous profile and 55-second/2048-frame budget without changing collection limits', async () => {
  const legacy: MigrationCheckConfig = { ...config, relay: { ...config.relay, policyVersion: 'readonly-relay-codex-v2', timeoutMs: 60000 } };
  const result = await new MigrationCheckService(fakePort().port).check(legacy);
  assert.equal(result.status, 'passed');
  assert.equal(result.contracts.connectionProfileHash, getReadonlyRelayProfileHash('codex-chatgpt-relay-v2', legacy.relay));
  assert.equal(result.contracts.executionBudget.workTimeoutMs, 55000);
  assert.equal(result.contracts.executionBudget.frames, 2048);
  assert.equal(result.contracts.collectionProfileHash, getPersonalCollectionProfileHash());
});

for (const [name, override] of [
  ['unsupported OS', { platform: 'linux' }], ['unsupported CPU', { arch: 'x64' }], ['unsupported Node', { nodeVersion: '27.0.0' }],
  ['missing owner identity', { uid: null }],
] as const) test(`migration skips all filesystem probes for ${name}`, async () => {
  const f = fakePort({ ...host, ...override }); const result = await new MigrationCheckService(f.port).check(config);
  assert.equal(result.status, 'blocked'); assert.deepEqual(f.calls, ['host']);
  for (const id of ['pathSeparation', 'sandboxExecutable', 'nativeBinary', 'runtimeDirectory']) {
    assert.equal(result.checks.find(check => check.id === id)?.status, 'not_run');
  }
});

test('path separation failure prevents every filesystem resource probe', async () => {
  const f = fakePort(); f.port.inspectPaths = async () => { f.calls.push('paths'); return { status: 'failed', reason: 'OVERLAP' }; };
  const result = await new MigrationCheckService(f.port).check(config);
  assert.equal(result.status, 'blocked'); assert.deepEqual(f.calls, ['host', 'paths']);
});

test('port failures and malformed output remain fixed codes and cannot print raw paths or diagnostics', async () => {
  for (const observation of [{ status: 'passed', reason: 'READ_FAILED' }, { status: 'failed', reason: 'BINARY_PIN_MATCH' },
    { status: 'passed', reason: 'BINARY_PIN_MATCH', path: '/synthetic/private' }, { status: 'failed', reason: '/synthetic/private' }]) {
    const f = fakePort(); f.port.inspectBinary = async () => observation as MigrationProbeObservation;
    const result = await new MigrationCheckService(f.port).check(config);
    assert.equal(result.status, 'blocked');
    assert.equal(result.checks.find(item => item.id === 'nativeBinary')?.reason, 'INVALID_OBSERVATION');
    assert.equal(JSON.stringify(result).includes('/synthetic/private'), false);
  }
  const f = fakePort(); f.port.inspectBinary = async () => { throw new Error('/synthetic/private simulated sensitive diagnostic'); };
  const result = await new MigrationCheckService(f.port).check(config);
  assert.equal(result.checks.find(item => item.id === 'nativeBinary')?.reason, 'OBSERVATION_FAILED');
  assert.equal(JSON.stringify(result).includes('simulated sensitive'), false);
});

test('accessor host and probe observations are rejected without invoking getters', async () => {
  let evaluated = 0;
  const f = fakePort(); f.port.observeHost = () => Object.defineProperty({ ...host }, 'pnpmUserAgent', {
    enumerable: true, get: () => { evaluated++; return host.pnpmUserAgent; } });
  const first = await new MigrationCheckService(f.port).check(config);
  assert.equal(first.status, 'blocked'); assert.equal(evaluated, 0);
  const g = fakePort(); g.port.inspectBinary = async () => Object.defineProperty({ status: 'passed', reason: 'BINARY_PIN_MATCH' }, 'reason', {
    enumerable: true, get: () => { evaluated++; return 'BINARY_PIN_MATCH'; } }) as MigrationProbeObservation;
  const second = await new MigrationCheckService(g.port).check(config);
  assert.equal(second.status, 'blocked'); assert.equal(evaluated, 0);
});
