import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MigrationCheckService } from '../src/application/migration-check.js';
import { MigrationPartialCheckService } from '../src/application/migration-partial-check.js';
import { MIGRATION_CHECK_VERSION, MIGRATION_CODEX_SHA256, MIGRATION_PARTIAL_CHECK_VERSION,
  type MigrationCheckConfig, type MigrationHostObservation, type MigrationPartialCheckConfig,
  type MigrationProbeObservation } from '../src/domain/migration-check.js';
import type { MigrationCheckPort, MigrationPartialCheckPort } from '../src/ports/migration-check.js';
import { hashMigrationCheckConfig, hashMigrationPartialCheckConfig, parseMigrationCheckConfig,
  parseMigrationPartialCheckConfig } from '../src/policy/migration-check.js';

const config: MigrationPartialCheckConfig = { version: MIGRATION_PARTIAL_CHECK_VERSION, enabled: false,
  runtimeDirectory: '/synthetic/private-runtime' };
const fullConfig: MigrationCheckConfig = { version: MIGRATION_CHECK_VERSION, relay: { enabled: false,
  policyVersion: 'readonly-relay-codex-v3', codexPath: '/synthetic/native/codex', codexSha256: MIGRATION_CODEX_SHA256,
  model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 }, runtimeDirectory: config.runtimeDirectory };
const host: MigrationHostObservation = { platform: 'darwin', arch: 'arm64', nodeVersion: '26.12.1', uid: 501,
  pnpmUserAgent: 'pnpm/12.16.1 npm/? node/v26.12.1 darwin arm64' };
const outsideScope = ['credentialAccess', 'modelCall', 'companyApproval', 'companySource', 'network',
  'nativeVersionExecution', 'sandboxRuntime', 'storageWriteProbe'];
const fakePort = (hostValue: MigrationHostObservation = host) => {
  const calls: string[] = [];
  const port: MigrationPartialCheckPort = {
    observeHost: () => { calls.push('host'); return hostValue; },
    inspectPartialPaths: async value => { assert.deepEqual(value, config); calls.push('paths'); return { status: 'passed', reason: 'PATHS_SEPARATE' }; },
    inspectRuntimeDirectory: async path => { assert.equal(path, config.runtimeDirectory); calls.push('directory'); return { status: 'passed', reason: 'DIRECTORY_METADATA_PRIVATE' }; },
  };
  return { port, calls };
};

test('partial configuration has its own disabled schema and hash without accepting full relay settings', async () => {
  const parsed = parseMigrationPartialCheckConfig(config);
  assert.deepEqual(parsed, config); assert.notEqual(parsed, config); assert.ok(Object.isFrozen(parsed));
  assert.equal(hashMigrationPartialCheckConfig(parsed), hashMigrationPartialCheckConfig(config));
  assert.notEqual(hashMigrationPartialCheckConfig(config), hashMigrationCheckConfig(fullConfig));
  assert.notEqual(hashMigrationPartialCheckConfig(config), hashMigrationPartialCheckConfig({ ...config, runtimeDirectory: '/synthetic/other-runtime' }));
  assert.throws(() => parseMigrationCheckConfig(config), { code: 'MIGRATION_CHECK_INVALID_CONFIG' });
  for (const value of [fullConfig, null, [], { ...config, enabled: true }, { ...config, version: MIGRATION_CHECK_VERSION },
    { ...config, relay: fullConfig.relay }, { ...config, codexPath: fullConfig.relay.codexPath },
    { ...config, token: 'SYNTHETIC_NOT_A_CREDENTIAL' }, { ...config, runtimeDirectory: '/synthetic/.codex' },
    ...['/usr/bin/sandbox-exec', '/usr/bin/sandbox-exec/runtime', '/synthetic/native/codex',
      '/synthetic/native/codex/runtime', '/synthetic/CODEX/runtime'].map(runtimeDirectory => ({ ...config, runtimeDirectory })),
    { ...config, runtimeDirectory: '/synthetic/../runtime' }]) {
    assert.throws(() => parseMigrationPartialCheckConfig(value), { code: 'MIGRATION_CHECK_INVALID_CONFIG' });
    const f = fakePort();
    await assert.rejects(new MigrationPartialCheckService(f.port).check(value), { code: 'MIGRATION_CHECK_INVALID_CONFIG' });
    assert.deepEqual(f.calls, []);
  }
});

test('partial configuration rejects accessors and unexpected own keys before evaluating or observing anything', async () => {
  let evaluated = 0;
  for (const value of [Object.defineProperty({ ...config }, 'runtimeDirectory', {
    enumerable: true, get: () => { evaluated++; return config.runtimeDirectory; },
  }), { ...config, [Symbol('extra')]: true }, Object.assign(Object.create({ inherited: true }), config)]) {
    const f = fakePort();
    await assert.rejects(new MigrationPartialCheckService(f.port).check(value), { code: 'MIGRATION_CHECK_INVALID_CONFIG' });
    assert.deepEqual(f.calls, []);
  }
  assert.equal(evaluated, 0);
});

test('partial success reports seven prerequisites but never grants full readiness or accesses omitted ports', async () => {
  const f = fakePort(); let forbiddenAccess = 0;
  for (const name of ['inspectSandboxExecutable', 'inspectBinary']) Object.defineProperty(f.port, name, {
    get: () => { forbiddenAccess++; throw new Error('SYNTHETIC_FORBIDDEN_RESOURCE'); },
  });
  const report = await new MigrationPartialCheckService(f.port).check(config);
  assert.equal(forbiddenAccess, 0); assert.deepEqual(f.calls, ['host', 'paths', 'directory']);
  assert.equal(report.version, MIGRATION_PARTIAL_CHECK_VERSION); assert.equal(report.mode, 'offline');
  assert.equal(report.scope, 'partial'); assert.equal(report.status, 'blocked'); assert.equal(report.partialStatus, 'passed');
  assert.deepEqual([report.liveReady, report.executionAllowed, report.approvalCreated], [false, false, false]);
  assert.deepEqual(report.checks.filter(item => item.status === 'passed').map(item => item.id),
    ['configuration', 'host', 'node', 'pnpmLauncher', 'owner', 'pathSeparation', 'runtimeDirectory']);
  assert.equal(report.checks.length, 17); assert.equal(report.checks.filter(item => item.status === 'not_run').length, 10);
  assert.deepEqual(report.remainingChecks, ['sandboxExecutable', 'nativeBinary']);
  for (const id of report.remainingChecks) assert.deepEqual(report.checks.find(item => item.id === id),
    { id, status: 'not_run', reason: 'NOT_INCLUDED_IN_PARTIAL_CHECK' });
  for (const id of outsideScope) assert.deepEqual(report.checks.find(item => item.id === id),
    { id, status: 'not_run', reason: 'OUTSIDE_OFFLINE_SCOPE' });
  assert.deepEqual(report.nextActions, ['RUN_FULL_CHECK_WITH_APPROVED_NATIVE']);
  assert.deepEqual(report.environment, { platform: 'darwin', arch: 'arm64', nodeVersion: '26.12.1',
    pnpmLauncherVersion: '12.16.1', pnpmEvidence: 'unverified_launcher_metadata' });
  assert.deepEqual(report.expected, { node: '>=26.12.1 <27', pnpm: 'installed-pnpm' });
  assert.equal(report.diagnosticConfigHash, hashMigrationPartialCheckConfig(config));
  assert.equal(Object.hasOwn(report, 'contracts'), false);
  assert.equal(JSON.stringify(report).includes('/synthetic/'), false);
  assert.equal(JSON.stringify(report).includes('gpt-6.1-sol'), false);
});

for (const [name, override] of [
  ['unsupported OS', { platform: 'linux' }], ['unsupported CPU', { arch: 'x64' }],
  ['unsupported Node', { nodeVersion: '27.0.0' }], ['missing owner', { uid: null }],
  ['missing pnpm declaration', { pnpmUserAgent: null }], ['invalid pnpm declaration', { pnpmUserAgent: 'npm/12.16.1' }],
] as const) test(`partial diagnostic does not inspect paths or runtime for ${name}`, async () => {
  const f = fakePort({ ...host, ...override }), report = await new MigrationPartialCheckService(f.port).check(config);
  assert.deepEqual(f.calls, ['host']); assert.equal(report.status, 'blocked'); assert.equal(report.partialStatus, 'blocked');
  assert.deepEqual(report.nextActions, ['FIX_PARTIAL_CHECKS', 'RUN_FULL_CHECK_WITH_APPROVED_NATIVE']);
  for (const id of ['pathSeparation', 'runtimeDirectory']) assert.deepEqual(report.checks.find(item => item.id === id),
    { id, status: 'not_run', reason: 'PREREQUISITE_FAILED' });
  for (const id of report.remainingChecks) assert.deepEqual(report.checks.find(item => item.id === id),
    { id, status: 'not_run', reason: 'NOT_INCLUDED_IN_PARTIAL_CHECK' });
});

test('partial diagnostic copies no raw host errors or malformed host metadata and never evaluates getters', async () => {
  let evaluated = 0;
  const raw = '/synthetic/private-host-marker';
  for (const value of [{ ...host, unexpected: raw }, { ...host, uid: -1 }, { ...host, nodeVersion: raw },
    Object.defineProperty({ ...host }, 'pnpmUserAgent', { enumerable: true, get: () => { evaluated++; return raw; } })]) {
    const f = fakePort(value as MigrationHostObservation);
    const report = await new MigrationPartialCheckService(f.port).check(config);
    assert.equal(report.partialStatus, 'blocked'); assert.deepEqual(f.calls, ['host']);
    assert.equal(JSON.stringify(report).includes(raw), false);
  }
  const f = fakePort(); f.port.observeHost = () => { f.calls.push('host'); throw new Error(raw); };
  const report = await new MigrationPartialCheckService(f.port).check(config);
  assert.equal(report.partialStatus, 'blocked'); assert.deepEqual(f.calls, ['host']);
  assert.equal(JSON.stringify(report).includes(raw), false); assert.equal(evaluated, 0);
});

test('partial path failure prevents runtime access and preserves the fixed refusal reason', async () => {
  const f = fakePort(); f.port.inspectPartialPaths = async () => { f.calls.push('paths'); return { status: 'failed', reason: 'OVERLAP' }; };
  const report = await new MigrationPartialCheckService(f.port).check(config);
  assert.equal(report.partialStatus, 'blocked'); assert.deepEqual(f.calls, ['host', 'paths']);
  assert.deepEqual(report.checks.find(item => item.id === 'pathSeparation'), { id: 'pathSeparation', status: 'failed', reason: 'OVERLAP' });
  assert.deepEqual(report.checks.find(item => item.id === 'runtimeDirectory'), { id: 'runtimeDirectory', status: 'not_run', reason: 'PREREQUISITE_FAILED' });
});

test('partial resource validation rejects malformed results and getters without trusting raw diagnostics', async () => {
  const raw = '/synthetic/private-probe-marker'; let evaluated = 0;
  for (const value of [{ status: 'passed', reason: 'READ_FAILED' }, { status: 'failed', reason: 'DIRECTORY_METADATA_PRIVATE' },
    { status: 'passed', reason: 'DIRECTORY_METADATA_PRIVATE', path: raw }, { status: 'failed', reason: raw },
    Object.defineProperty({ status: 'passed', reason: 'DIRECTORY_METADATA_PRIVATE' }, 'reason', {
      enumerable: true, get: () => { evaluated++; return raw; },
    })]) {
    const f = fakePort(); f.port.inspectRuntimeDirectory = async () => value as MigrationProbeObservation;
    const report = await new MigrationPartialCheckService(f.port).check(config);
    assert.equal(report.partialStatus, 'blocked');
    assert.deepEqual(report.checks.find(item => item.id === 'runtimeDirectory'),
      { id: 'runtimeDirectory', status: 'failed', reason: 'INVALID_OBSERVATION' });
    assert.equal(JSON.stringify(report).includes(raw), false);
    assert.deepEqual(report.nextActions, ['FIX_PARTIAL_CHECKS', 'RUN_FULL_CHECK_WITH_APPROVED_NATIVE']);
  }
  assert.equal(evaluated, 0);
  const f = fakePort(); f.port.inspectPartialPaths = async () => ({ status: 'passed', reason: 'PATHS_SEPARATE', path: raw });
  const report = await new MigrationPartialCheckService(f.port).check(config);
  assert.deepEqual(f.calls, ['host']);
  assert.deepEqual(report.checks.find(item => item.id === 'pathSeparation'), { id: 'pathSeparation', status: 'failed', reason: 'INVALID_OBSERVATION' });
  assert.equal(report.checks.find(item => item.id === 'runtimeDirectory')?.status, 'not_run');
  assert.equal(JSON.stringify(report).includes(raw), false);
});

test('partial runtime errors remain bounded refusals with no path or raw error output', async () => {
  const f = fakePort(); f.port.inspectRuntimeDirectory = async () => ({ status: 'failed', reason: 'CHANGED_DURING_READ' });
  const changed = await new MigrationPartialCheckService(f.port).check(config);
  assert.equal(changed.partialStatus, 'blocked');
  assert.deepEqual(changed.checks.find(item => item.id === 'runtimeDirectory'),
    { id: 'runtimeDirectory', status: 'failed', reason: 'CHANGED_DURING_READ' });
  const raw = '/synthetic/runtime-error-marker';
  f.port.inspectRuntimeDirectory = async () => { throw new Error(raw); };
  const failed = await new MigrationPartialCheckService(f.port).check(config);
  assert.deepEqual(failed.checks.find(item => item.id === 'runtimeDirectory'),
    { id: 'runtimeDirectory', status: 'failed', reason: 'OBSERVATION_FAILED' });
  assert.equal(JSON.stringify(failed).includes(raw), false);
});

test('shared observers leave the full diagnostic report and all full resource probes intact', async () => {
  const calls: string[] = [];
  const port: MigrationCheckPort = {
    observeHost: () => { calls.push('host'); return host; },
    inspectPaths: async () => { calls.push('paths'); return { status: 'passed', reason: 'PATHS_SEPARATE' }; },
    inspectSandboxExecutable: async () => { calls.push('sandbox'); return { status: 'passed', reason: 'SANDBOX_METADATA_MATCH' }; },
    inspectBinary: async () => { calls.push('binary'); return { status: 'passed', reason: 'BINARY_PIN_MATCH' }; },
    inspectRuntimeDirectory: async () => { calls.push('directory'); return { status: 'passed', reason: 'DIRECTORY_METADATA_PRIVATE' }; },
  };
  const report = await new MigrationCheckService(port).check(fullConfig);
  assert.equal(report.version, MIGRATION_CHECK_VERSION); assert.equal(report.status, 'passed');
  assert.deepEqual(calls, ['host', 'paths', 'sandbox', 'binary', 'directory']);
  assert.equal(Object.hasOwn(report, 'partialStatus'), false); assert.equal(Object.hasOwn(report, 'scope'), false);
  assert.equal(report.expected.codexVersion, '0.154.0');
  assert.equal(report.contracts.diagnosticConfigHash, hashMigrationCheckConfig(fullConfig));
  assert.equal(report.checks.filter(item => item.status === 'passed').length, 9);
  assert.deepEqual(report.checks.filter(item => item.status === 'not_run').map(item => item.id), outsideScope);
  assert.deepEqual([report.liveReady, report.executionAllowed, report.approvalCreated], [false, false, false]);
});
