import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { MIGRATION_CHECK_VERSION, MIGRATION_CODEX_SHA256, MIGRATION_PARTIAL_CHECK_VERSION,
  type MigrationCheckReport, type MigrationPartialCheckReport } from '../src/domain/migration-check.js';

const auditPrefix = 'MIGRATION_TEST_IO:';
interface IoAudit { configOpens: number; unexpectedOpens: number; protectedAccesses: number; resourceMetadata: number;
  nativeMetadata: number; sandboxMetadata: number; directoryListings: number; writes: number; processes: number; network: number }
const expectedIdle: IoAudit = { configOpens: 0, unexpectedOpens: 0, protectedAccesses: 0, resourceMetadata: 0,
  nativeMetadata: 0, sandboxMetadata: 0, directoryListings: 0, writes: 0, processes: 0, network: 0 };
const sentinel = 'SYNTHETIC_MIGRATION_CANARY_NOT_A_CREDENTIAL';

const snapshot = async (root: string): Promise<Record<string, string>> => {
  const records: Record<string, string> = {};
  const visit = async (path: string, name: string): Promise<void> => {
    const stat = await lstat(path);
    records[name] = `${stat.mode}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(join(path, child), `${name}/${child}`);
    } else records[name] += `:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
  };
  await visit(root, '.');
  return records;
};

const prepare = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'migration-cli-')));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'synthetic-home'), runtime = join(root, 'runtime');
  const configPath = join(root, 'migration-check.json'), binary = join(root, 'missing-native', 'codex');
  await mkdir(home, { mode: 0o700 }); await mkdir(join(home, '.codex'), { mode: 0o700 });
  await mkdir(runtime, { mode: 0o700 });
  await writeFile(join(home, '.codex', 'auth.json'), sentinel, { mode: 0o600 });
  await writeFile(join(runtime, 'personal-readonly.sqlite'), sentinel, { mode: 0o600 });
  await writeFile(join(runtime, 'company-source.txt'), sentinel, { mode: 0o600 });
  const config = { version: MIGRATION_CHECK_VERSION, relay: { enabled: false, policyVersion: 'readonly-relay-codex-v3',
    codexPath: binary, codexSha256: MIGRATION_CODEX_SHA256, model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 },
  runtimeDirectory: runtime };
  const partialConfig = { version: MIGRATION_PARTIAL_CHECK_VERSION, enabled: false, runtimeDirectory: runtime };
  const save = (value: unknown) => writeFile(configPath, JSON.stringify(value), { mode: 0o600 });
  await save(config);
  const preload = join(root, 'observe-offline.mjs');
  await writeFile(preload, `
import fs from 'node:fs';
import cp from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import {syncBuiltinESMExports} from 'node:module';
const config=process.env.MIGRATION_TEST_CONFIG;
const home=process.env.HOME;
const runtime=process.env.MIGRATION_TEST_RUNTIME;
const binary=process.env.MIGRATION_TEST_BINARY;
const partial=process.env.MIGRATION_TEST_PARTIAL==='1';
const audit=${JSON.stringify(expectedIdle)};
const deny=()=>{throw Error('SYNTHETIC_ACCESS_DENIED');};
const guarded=(path)=>{
 const text=String(path);
 if(text.startsWith(home+'/.codex') || text.endsWith('.sqlite') || text.endsWith('/company-source.txt')){audit.protectedAccesses++;deny();}
 const native=text===binary || text===binary.slice(0,binary.lastIndexOf('/')) || text.endsWith('/codex');
 const sandbox=text.endsWith('/sandbox-exec');
 if(text===runtime || native || sandbox)audit.resourceMetadata++;
 if(native)audit.nativeMetadata++;
 if(sandbox)audit.sandboxMetadata++;
 if(partial && (native || sandbox))deny();
};
for(const name of ['open','readFile','readdir','stat','lstat','realpath','access']){
 const original=fs.promises[name];
 fs.promises[name]=async function(path,...args){
  guarded(path);
  if(name==='open'){if(String(path)!==config){audit.unexpectedOpens++;deny();}audit.configOpens++;}
  if(name==='readdir'){audit.directoryListings++;deny();}
  return original.call(this,path,...args);
 };
}
for(const name of ['readFileSync','openSync','statSync','lstatSync','realpathSync','readdirSync']){
 const original=fs[name];
 fs[name]=function(path,...args){guarded(path);return original.call(this,path,...args);};
}
for(const name of ['writeFile','appendFile','mkdir','rm','unlink','rename','chmod']){
 fs.promises[name]=async()=>{audit.writes++;deny();};
 fs[name]=()=>{audit.writes++;deny();};
 if(fs[name+'Sync'])fs[name+'Sync']=()=>{audit.writes++;deny();};
}
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>{audit.processes++;deny();};
for(const name of ['connect','createConnection','createServer'])net[name]=()=>{audit.network++;deny();};
tls.connect=()=>{audit.network++;deny();};
globalThis.fetch=async()=>{audit.network++;deny();};
syncBuiltinESMExports();
process.on('exit',()=>process.stderr.write('${auditPrefix}'+JSON.stringify(audit)+'\\n'));
`, { mode: 0o600 });
  const execute = (args: string[], pnpm: string | null = 'pnpm/12.16.1 npm/? node/v26.12.1', scope: 'full' | 'partial' = 'full') => spawnSync(process.execPath, [
    '--permission', '--allow-fs-read=*', '--import', preload, resolve('dist/src/cli/main.js'), ...args,
  ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: home,
      MIGRATION_TEST_CONFIG: configPath, MIGRATION_TEST_RUNTIME: runtime, MIGRATION_TEST_BINARY: binary,
      MIGRATION_TEST_PARTIAL: scope === 'partial' ? '1' : '0',
      ...(pnpm === null ? {} : { npm_config_user_agent: pnpm }) } });
  const inspect = (result: SpawnSyncReturns<string>): IoAudit => {
    assert.equal(result.error, undefined);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));
    assert.equal((result.stdout + result.stderr).includes(root), false);
    const line = result.stderr.split('\n').find(value => value.startsWith(auditPrefix));
    assert.ok(line, result.stderr); return JSON.parse(line.slice(auditPrefix.length)) as IoAudit;
  };
  const command = ['migration-check', '--config', configPath];
  return { root, home, runtime, configPath, config, partialConfig, save, execute, inspect, command };
};

test('migration CLI rejects missing, unknown and duplicate arguments before opening configuration', async t => {
  const cli = await prepare(t), before = await snapshot(cli.root);
  for (const args of [
    ['migration-check'], ['migration-check', '--config'], ['migration-check', '--repository', cli.configPath],
    [...cli.command, '--config', cli.configPath], [...cli.command, '--live', 'true'],
  ]) {
    const result = cli.execute(args);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr.split('\n')[0], 'INVALID_ARGUMENTS');
    assert.deepEqual(cli.inspect(result), expectedIdle);
  }
  assert.deepEqual(await snapshot(cli.root), before);
});

test('migration CLI missing pnpm declaration skips all resource probes with no auth, state or write access', async t => {
  const cli = await prepare(t), before = await snapshot(cli.root);
  const result = cli.execute(cli.command, null), audit = cli.inspect(result);
  assert.equal(result.status, 1); assert.deepEqual(audit, { ...expectedIdle, configOpens: 1 });
  const report = JSON.parse(result.stdout) as MigrationCheckReport;
  assert.equal(report.status, 'blocked'); assert.equal(report.mode, 'offline');
  assert.equal(report.liveReady, false); assert.equal(report.executionAllowed, false); assert.equal(report.approvalCreated, false);
  assert.deepEqual(report.checks.find(item => item.id === 'pnpmLauncher'),
    { id: 'pnpmLauncher', status: 'not_run', reason: 'PNPM_DECLARATION_UNAVAILABLE' });
  for (const id of ['pathSeparation', 'sandboxExecutable', 'nativeBinary', 'runtimeDirectory']) {
    assert.equal(report.checks.find(item => item.id === id)?.status, 'not_run');
  }
  for (const id of ['credentialAccess', 'modelCall', 'companySource', 'companyApproval', 'network', 'nativeVersionExecution', 'sandboxRuntime', 'storageWriteProbe']) {
    assert.equal(report.checks.find(item => item.id === id)?.status, 'not_run');
  }
  assert.equal(report.environment.pnpmEvidence, 'unverified_launcher_metadata');
  assert.deepEqual(await snapshot(cli.root), before);
});

test('migration CLI rejects another package manager declaration before resource access', async t => {
  const cli = await prepare(t), before = await snapshot(cli.root);
  const launcher = 'npm/12.16.1 SYNTHETIC_LAUNCHER_INPUT';
  const result = cli.execute(cli.command, launcher), audit = cli.inspect(result);
  assert.equal(result.status, 1); assert.deepEqual(audit, { ...expectedIdle, configOpens: 1 });
  const report = JSON.parse(result.stdout) as MigrationCheckReport;
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.checks.find(item => item.id === 'pnpmLauncher'),
    { id: 'pnpmLauncher', status: 'failed', reason: 'PNPM_DECLARATION_INVALID' });
  assert.equal(report.environment.pnpmLauncherVersion, null);
  assert.equal(result.stdout.includes('SYNTHETIC_LAUNCHER_INPUT'), false);
  for (const id of ['pathSeparation', 'sandboxExecutable', 'nativeBinary', 'runtimeDirectory']) {
    assert.deepEqual(report.checks.find(item => item.id === id), { id, status: 'not_run', reason: 'PREREQUISITE_FAILED' });
  }
  assert.deepEqual(await snapshot(cli.root), before);
});

test('migration CLI valid launcher with missing native returns bounded blocked report without creating runtime state', async t => {
  const cli = await prepare(t), before = await snapshot(cli.root);
  const result = cli.execute(cli.command), audit = cli.inspect(result);
  assert.equal(result.status, 1);
  assert.deepEqual({ ...audit, resourceMetadata: 0, nativeMetadata: 0, sandboxMetadata: 0 }, { ...expectedIdle, configOpens: 1 });
  const report = JSON.parse(result.stdout) as MigrationCheckReport;
  assert.equal(report.status, 'blocked'); assert.equal(report.liveReady, false);
  assert.deepEqual(report.checks.find(item => item.id === 'pnpmLauncher'),
    { id: 'pnpmLauncher', status: 'passed', reason: 'PNPM_DECLARATION_PRESENT' });
  assert.equal(report.environment.pnpmLauncherVersion, '12.16.1');
  assert.equal(report.environment.pnpmEvidence, 'unverified_launcher_metadata');
  assert.equal(report.expected.pnpm, 'installed-pnpm');
  if (process.platform === 'darwin' && process.arch === 'arm64' && process.getuid) {
    assert.ok(audit.resourceMetadata > 0);
    assert.deepEqual(report.checks.find(item => item.id === 'nativeBinary'), { id: 'nativeBinary', status: 'failed', reason: 'MISSING' });
    assert.deepEqual(report.checks.find(item => item.id === 'runtimeDirectory'),
      { id: 'runtimeDirectory', status: 'passed', reason: 'DIRECTORY_METADATA_PRIVATE' });
  } else {
    assert.equal(audit.resourceMetadata, 0);
    assert.equal(report.checks.find(item => item.id === 'nativeBinary')?.status, 'not_run');
  }
  assert.deepEqual(await snapshot(cli.root), before);
});

test('partial migration CLI preserves canaries and reports incomplete readiness without any native or sandbox metadata access', async t => {
  const cli = await prepare(t); await cli.save(cli.partialConfig);
  const before = await snapshot(cli.root), result = cli.execute(cli.command, undefined, 'partial'), audit = cli.inspect(result);
  assert.equal(result.status, 1);
  assert.deepEqual({ ...audit, resourceMetadata: 0 }, { ...expectedIdle, configOpens: 1 });
  const report = JSON.parse(result.stdout) as MigrationPartialCheckReport;
  assert.equal(report.version, MIGRATION_PARTIAL_CHECK_VERSION); assert.equal(report.mode, 'offline');
  assert.equal(report.scope, 'partial'); assert.equal(report.status, 'blocked');
  assert.equal(report.liveReady, false); assert.equal(report.executionAllowed, false); assert.equal(report.approvalCreated, false);
  assert.deepEqual(report.remainingChecks, ['sandboxExecutable', 'nativeBinary']);
  assert.deepEqual(Object.keys(report.expected).sort(), ['node', 'pnpm']);
  assert.match(report.diagnosticConfigHash, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(report, 'contracts'), false);
  for (const id of ['sandboxExecutable', 'nativeBinary']) {
    assert.deepEqual(report.checks.find(item => item.id === id), { id, status: 'not_run', reason: 'NOT_INCLUDED_IN_PARTIAL_CHECK' });
  }
  for (const id of ['credentialAccess', 'modelCall', 'companyApproval', 'companySource', 'network',
    'nativeVersionExecution', 'sandboxRuntime', 'storageWriteProbe']) {
    assert.deepEqual(report.checks.find(item => item.id === id), { id, status: 'not_run', reason: 'OUTSIDE_OFFLINE_SCOPE' });
  }
  if (process.platform === 'darwin' && process.arch === 'arm64' && process.getuid) {
    assert.equal(report.partialStatus, 'passed'); assert.ok(audit.resourceMetadata > 0);
    assert.equal(report.checks.filter(item => item.status === 'passed').length, 7);
    assert.equal(report.checks.filter(item => item.status === 'failed').length, 0);
    assert.equal(report.checks.filter(item => item.status === 'not_run').length, 10);
    assert.deepEqual(report.nextActions, ['RUN_FULL_CHECK_WITH_APPROVED_NATIVE']);
  } else {
    assert.equal(report.partialStatus, 'blocked'); assert.equal(audit.resourceMetadata, 0);
    assert.deepEqual(report.nextActions, ['FIX_PARTIAL_CHECKS', 'RUN_FULL_CHECK_WITH_APPROVED_NATIVE']);
  }
  assert.deepEqual(await snapshot(cli.root), before);
});

test('partial migration CLI skips runtime metadata when the launcher declaration is absent or invalid', async t => {
  const cli = await prepare(t); await cli.save(cli.partialConfig);
  const before = await snapshot(cli.root);
  for (const launcher of [null, 'npm/12.16.1 SYNTHETIC_LAUNCHER_INPUT']) {
    const result = cli.execute(cli.command, launcher, 'partial'), audit = cli.inspect(result);
    assert.equal(result.status, 1); assert.deepEqual(audit, { ...expectedIdle, configOpens: 1 });
    const report = JSON.parse(result.stdout) as MigrationPartialCheckReport;
    assert.equal(report.status, 'blocked'); assert.equal(report.partialStatus, 'blocked');
    assert.deepEqual(report.nextActions, ['FIX_PARTIAL_CHECKS', 'RUN_FULL_CHECK_WITH_APPROVED_NATIVE']);
    for (const id of ['pathSeparation', 'runtimeDirectory']) {
      assert.deepEqual(report.checks.find(item => item.id === id), { id, status: 'not_run', reason: 'PREREQUISITE_FAILED' });
    }
    assert.equal(result.stdout.includes('SYNTHETIC_LAUNCHER_INPUT'), false);
  }
  assert.deepEqual(await snapshot(cli.root), before);
});

test('partial migration CLI rejects enabled, extra, unsafe and ambiguous configurations before resource inspection', async t => {
  const cli = await prepare(t);
  const cases = [
    { ...cli.partialConfig, enabled: true },
    { ...cli.partialConfig, nativePath: join(cli.root, 'unexpected-native', 'codex') },
    { ...cli.partialConfig, relay: cli.config.relay },
    { ...cli.partialConfig, runtimeDirectory: join(cli.home, '.codex') },
    ...[cli.config.relay.codexPath, join(cli.config.relay.codexPath, 'runtime'),
      '/usr/bin/sandbox-exec', '/usr/bin/sandbox-exec/runtime'].map(runtimeDirectory => ({ ...cli.partialConfig, runtimeDirectory })),
    { version: MIGRATION_PARTIAL_CHECK_VERSION, runtimeDirectory: cli.runtime },
    { ...cli.partialConfig, version: `${MIGRATION_PARTIAL_CHECK_VERSION}-unknown` },
    { version: MIGRATION_CHECK_VERSION, runtimeDirectory: cli.runtime },
    { version: MIGRATION_CHECK_VERSION, enabled: false, runtimeDirectory: cli.runtime },
  ];
  for (const config of cases) {
    await cli.save(config); const before = await snapshot(cli.root);
    const result = cli.execute(cli.command, undefined, 'partial');
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr.split('\n')[0], 'MIGRATION_CHECK_INVALID_CONFIG');
    assert.deepEqual(cli.inspect(result), { ...expectedIdle, configOpens: 1 });
    assert.deepEqual(await snapshot(cli.root), before);
  }
});

test('partial migration CLI keeps missing or public runtime directories blocked without native inspection', async t => {
  for (const scenario of ['missing', 'public'] as const) {
    const cli = await prepare(t);
    await cli.save({ ...cli.partialConfig, runtimeDirectory: scenario === 'missing' ? `${cli.runtime}-missing` : cli.runtime });
    if (scenario === 'public') await chmod(cli.runtime, 0o755);
    const before = await snapshot(cli.root), result = cli.execute(cli.command, undefined, 'partial'), audit = cli.inspect(result);
    assert.equal(result.status, 1); assert.deepEqual({ ...audit, resourceMetadata: 0 }, { ...expectedIdle, configOpens: 1 });
    const report = JSON.parse(result.stdout) as MigrationPartialCheckReport;
    assert.equal(report.status, 'blocked'); assert.equal(report.partialStatus, 'blocked');
    assert.deepEqual(report.nextActions, ['FIX_PARTIAL_CHECKS', 'RUN_FULL_CHECK_WITH_APPROVED_NATIVE']);
    if (process.platform === 'darwin' && process.arch === 'arm64' && process.getuid) {
      assert.deepEqual(report.checks.find(item => item.id === 'runtimeDirectory'),
        { id: 'runtimeDirectory', status: 'failed', reason: scenario === 'missing' ? 'MISSING' : 'UNSAFE_DIRECTORY' });
    }
    assert.deepEqual(await snapshot(cli.root), before);
  }
});

test('migration CLI rejects live, extra and credential path configurations without exposing their values', async t => {
  const cli = await prepare(t);
  const cases = [
    [{ ...cli.config, relay: { ...cli.config.relay, enabled: true } }, 'MIGRATION_CHECK_INVALID_CONFIG'],
    [{ ...cli.config, companySource: sentinel }, 'MIGRATION_CHECK_INVALID_CONFIG'],
    [{ ...cli.config, token: sentinel }, 'MIGRATION_CHECK_INVALID_CONFIG_FILE'],
    [{ ...cli.config, relay: { ...cli.config.relay, codexPath: join(cli.home, '.codex', 'codex') } }, 'MIGRATION_CHECK_INVALID_CONFIG'],
  ] as const;
  for (const [value, errorCode] of cases) {
    await cli.save(value); const before = await snapshot(cli.root);
    const result = cli.execute(cli.command);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr.split('\n')[0], errorCode);
    assert.deepEqual(cli.inspect(result), { ...expectedIdle, configOpens: 1 });
    assert.deepEqual(await snapshot(cli.root), before);
  }
});

test('migration CLI blocks a credential directory before access and help does not inspect configuration', async t => {
  const cli = await prepare(t), before = await snapshot(cli.root);
  const rejected = cli.execute(['migration-check', '--config', join(cli.home, '.codex', 'migration-check.json')]);
  assert.equal(rejected.status, 1); assert.equal(rejected.stdout, '');
  assert.equal(rejected.stderr.split('\n')[0], 'MIGRATION_CHECK_UNSAFE_PATH');
  assert.deepEqual(cli.inspect(rejected), expectedIdle);
  const help = cli.execute(['migration-check', '--help']);
  assert.equal(help.status, 0); assert.match(help.stdout, /pnpm harness migration-check --config/);
  assert.deepEqual(cli.inspect(help), expectedIdle);
  assert.deepEqual(await snapshot(cli.root), before);
});
