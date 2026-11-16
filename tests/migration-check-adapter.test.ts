import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { LocalMigrationCheck, readMigrationCheckConfiguration } from '../src/adapters/migration-check.js';
import { MIGRATION_CODEX_SHA256, MIGRATION_PARTIAL_CHECK_VERSION, type MigrationCheckConfig,
  type MigrationPartialCheckConfig } from '../src/domain/migration-check.js';

const fixture = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'migration-adapter-'))); chmodSync(directory, 0o700);
  const file = join(directory, 'migration-check.json'), runtime = join(directory, 'runtime'), binary = join(directory, 'native', 'codex');
  mkdirSync(runtime, { mode: 0o700 }); mkdirSync(join(directory, 'native'), { mode: 0o700 });
  const config: MigrationCheckConfig = { version: 'offline-migration-check-v1', runtimeDirectory: runtime,
    relay: { enabled: false, policyVersion: 'readonly-relay-codex-v3', codexPath: binary, codexSha256: MIGRATION_CODEX_SHA256,
      model: 'gpt-6.1-sol', authMode: 'chatgpt', timeoutMs: 125000, maxResponseBytes: 16384 } };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  // Format-compatible synthetic bytes cannot impersonate the approved native SHA.
  writeFileSync(binary, Buffer.concat([Buffer.from('cffaedfe0c000001', 'hex'), Buffer.alloc(64, 11)]), { mode: 0o500 });
  const port = new LocalMigrationCheck(file, join(directory, 'harness'));
  return { directory, file, runtime, binary, config, port, close: () => rmSync(directory, { recursive: true, force: true }) };
};

/** Mutate after capturing the initial metadata, without timers or other test processes. */
const afterFirstMetadataRead = async (context: TestContext, path: string, mutate: () => void, inspect: () => Promise<void>): Promise<void> => {
  const original = fsPromises.lstat; let mutated = false;
  const stat = context.mock.method(fsPromises, 'lstat', async (...args: Parameters<typeof original>) => {
    const metadata = await original(...args);
    if (args[0] === path && !mutated) { mutated = true; mutate(); }
    return metadata;
  });
  syncBuiltinESMExports();
  try { await inspect(); assert.equal(mutated, true); }
  finally { stat.mock.restore(); syncBuiltinESMExports(); }
};

test('private diagnostic config read preserves bytes, mode and directory entries', async () => {
  const h = fixture();
  try {
    const bytes = readFileSync(h.file), metadata = lstatSync(h.file), names = readdirSync(h.directory);
    assert.deepEqual(await readMigrationCheckConfiguration(h.file), h.config);
    assert.deepEqual(readFileSync(h.file), bytes); assert.equal(lstatSync(h.file).mtimeMs, metadata.mtimeMs);
    assert.equal(lstatSync(h.file).mode, metadata.mode); assert.deepEqual(readdirSync(h.directory), names);
  } finally { h.close(); }
});

test('config rejects duplicate keys, malformed UTF8, oversized content and public permissions', async () => {
  const h = fixture();
  try {
    for (const bytes of [Buffer.from('{"x":1,"x":2}'), Buffer.from([0xff]), Buffer.alloc(8193, 32)]) {
      writeFileSync(h.file, bytes); await assert.rejects(readMigrationCheckConfiguration(h.file), { code: 'MIGRATION_CHECK_INVALID_CONFIG_FILE' });
    }
    writeFileSync(h.file, JSON.stringify(h.config)); chmodSync(h.file, 0o644);
    await assert.rejects(readMigrationCheckConfiguration(h.file), { code: 'MIGRATION_CHECK_INVALID_CONFIG_FILE' });
    chmodSync(h.file, 0o600); chmodSync(h.directory, 0o755);
    await assert.rejects(readMigrationCheckConfiguration(h.file), { code: 'MIGRATION_CHECK_INVALID_CONFIG_FILE' });
  } finally { h.close(); }
});

test('config refuses hardlinks, final symlinks and symlinked parent before content use', async () => {
  const h = fixture();
  try {
    const duplicate = join(h.directory, 'hardlink'); linkSync(h.file, duplicate);
    await assert.rejects(readMigrationCheckConfiguration(h.file), { code: 'MIGRATION_CHECK_INVALID_CONFIG_FILE' });
    rmSync(duplicate);
    const alias = join(h.directory, 'alias'); symlinkSync(h.directory, alias);
    await assert.rejects(readMigrationCheckConfiguration(join(alias, 'migration-check.json')), { code: 'MIGRATION_CHECK_INVALID_CONFIG_FILE' });
    rmSync(h.file); symlinkSync(h.binary, h.file);
    await assert.rejects(readMigrationCheckConfiguration(h.file), { code: 'MIGRATION_CHECK_INVALID_CONFIG_FILE' });
  } finally { h.close(); }
});

test('credential path denial precedes any filesystem read or metadata probe', async context => {
  let operations = 0;
  const open = context.mock.method(fsPromises, 'open', async () => { operations++; throw new Error('unexpected open'); });
  const stat = context.mock.method(fsPromises, 'lstat', async () => { operations++; throw new Error('unexpected stat'); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(readMigrationCheckConfiguration('/synthetic/.codex/migration-check.json'), { code: 'MIGRATION_CHECK_INVALID_CONFIG_FILE' });
    assert.equal(operations, 0);
  } finally { open.mock.restore(); stat.mock.restore(); syncBuiltinESMExports(); }
});

test('path separation rejects source/runtime/config/native overlaps without touching their contents', async () => {
  const h = fixture();
  try {
    assert.deepEqual(await h.port.inspectPaths(h.config), { status: 'passed', reason: 'PATHS_SEPARATE' });
    for (const runtimeDirectory of [h.directory, h.binary, h.file, join(h.directory, 'harness'), join(h.directory, 'harness', 'runtime')]) {
      assert.deepEqual(await h.port.inspectPaths({ ...h.config, runtimeDirectory }), { status: 'failed', reason: 'OVERLAP' });
    }
  } finally { h.close(); }
});

test('partial path separation rejects overlap and unsafe paths without filesystem or native inspection', async context => {
  const h = fixture();
  const config: MigrationPartialCheckConfig = { version: MIGRATION_PARTIAL_CHECK_VERSION, enabled: false, runtimeDirectory: h.runtime };
  let operations = 0;
  const guards = (['lstat', 'open', 'readdir'] as const).map(name => context.mock.method(fsPromises, name, async () => {
    operations++; throw new Error('unexpected filesystem access');
  }));
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await h.port.inspectPartialPaths(config), { status: 'passed', reason: 'PATHS_SEPARATE' });
    for (const runtimeDirectory of [h.directory, h.file, join(h.file, 'runtime'), join(h.directory, 'harness'), join(h.directory, 'harness', 'runtime')]) {
      assert.deepEqual(await h.port.inspectPartialPaths({ ...config, runtimeDirectory }), { status: 'failed', reason: 'OVERLAP' });
    }
    const sourceConfig = new LocalMigrationCheck(join(h.directory, 'harness', 'migration-check.json'), join(h.directory, 'harness'));
    assert.deepEqual(await sourceConfig.inspectPartialPaths(config), { status: 'failed', reason: 'OVERLAP' });
    const sourceUnderConfig = new LocalMigrationCheck(h.file, join(h.file, 'harness'));
    assert.deepEqual(await sourceUnderConfig.inspectPartialPaths(config), { status: 'failed', reason: 'OVERLAP' });
    for (const runtimeDirectory of ['relative/runtime', '/synthetic/../runtime', '/synthetic/.codex/runtime',
      '/usr/bin/sandbox-exec', '/usr/bin/sandbox-exec/runtime', '/synthetic/native/codex',
      '/synthetic/native/codex/runtime', '/synthetic/CODEX/runtime']) {
      assert.equal((await h.port.inspectPartialPaths({ ...config, runtimeDirectory })).status, 'failed');
    }
    for (const port of [new LocalMigrationCheck('/synthetic/.codex/migration-check.json', '/synthetic/harness'),
      new LocalMigrationCheck(h.file, 'relative/harness')]) {
      assert.equal((await port.inspectPartialPaths(config)).status, 'failed');
    }
    assert.equal(operations, 0);
  } finally { for (const guard of guards) guard.mock.restore(); syncBuiltinESMExports(); h.close(); }
});

test('runtime inspection is metadata-only and creates no database or probe files', async context => {
  const h = fixture();
  const canary = join(h.runtime, 'auth.json'); writeFileSync(canary, 'synthetic runtime canary', { mode: 0o600 });
  let opens = 0;
  const open = context.mock.method(fsPromises, 'open', async () => { opens++; throw new Error('unexpected open'); });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await h.port.inspectRuntimeDirectory(h.runtime), { status: 'passed', reason: 'DIRECTORY_METADATA_PRIVATE' });
    assert.equal(opens, 0); assert.deepEqual(readdirSync(h.runtime), ['auth.json']);
    assert.equal(readFileSync(canary, 'utf8'), 'synthetic runtime canary');
    chmodSync(h.runtime, 0o755);
    assert.deepEqual(await h.port.inspectRuntimeDirectory(h.runtime), { status: 'failed', reason: 'UNSAFE_DIRECTORY' });
    assert.deepEqual(await h.port.inspectRuntimeDirectory(join(h.directory, 'absent')), { status: 'failed', reason: 'MISSING' });
    assert.equal(readdirSync(h.directory).includes('absent'), false);
    const alias = join(h.directory, 'alias'); symlinkSync(h.runtime, alias);
    assert.deepEqual(await h.port.inspectRuntimeDirectory(alias), { status: 'failed', reason: 'UNSAFE_DIRECTORY' });
  } finally { open.mock.restore(); syncBuiltinESMExports(); h.close(); }
});

test('unrelated child-directory creation does not change config, native or runtime identity', async context => {
  for (const probe of ['config', 'native', 'runtime-parent', 'runtime'] as const) {
    const h = fixture(), observed = probe === 'runtime' ? h.runtime : h.directory;
    try {
      await afterFirstMetadataRead(context, observed, () => mkdirSync(join(observed, 'unrelated-child'), { mode: 0o700 }), async () => {
        if (probe === 'config') assert.deepEqual(await readMigrationCheckConfiguration(h.file), h.config);
        else if (probe === 'native') {
          assert.deepEqual(await h.port.inspectBinary(h.config.relay), { status: 'failed', reason: 'PIN_MISMATCH' });
        } else assert.deepEqual(await h.port.inspectRuntimeDirectory(h.runtime), { status: 'passed', reason: 'DIRECTORY_METADATA_PRIVATE' });
      });
    } finally { h.close(); }
  }
});

test('runtime still rejects parent or final directory replacement, symlinks and permission changes during inspection', async context => {
  for (const target of ['parent', 'runtime'] as const) {
    for (const mutation of ['replacement', 'symlink', 'permissions'] as const) {
      const h = fixture(), parent = join(h.directory, 'observed-parent'), runtime = join(parent, 'runtime');
      mkdirSync(parent, { mode: 0o700 }); mkdirSync(runtime, { mode: 0o700 });
      const observed = target === 'parent' ? parent : runtime, previous = join(h.directory, 'original-directory');
      try {
        await afterFirstMetadataRead(context, observed, () => {
          if (mutation === 'permissions') { chmodSync(observed, 0o755); return; }
          renameSync(observed, previous);
          if (mutation === 'symlink') { symlinkSync(previous, observed); return; }
          mkdirSync(observed, { mode: 0o700 });
          if (target === 'parent') renameSync(join(previous, 'runtime'), runtime);
        }, async () => {
          assert.deepEqual(await h.port.inspectRuntimeDirectory(runtime), { status: 'failed', reason: 'CHANGED_DURING_READ' });
        });
      } finally { h.close(); }
    }
  }
});

test('runtime rejects changed owner or group metadata for parents and the final directory', async context => {
  for (const target of ['parent', 'runtime'] as const) {
    for (const field of ['uid', 'gid'] as const) {
      const h = fixture(), original = fsPromises.lstat, observed = target === 'parent' ? h.directory : h.runtime;
      let reads = 0;
      const stat = context.mock.method(fsPromises, 'lstat', async (...args: Parameters<typeof original>) => {
        const metadata = await original(...args);
        if (args[0] !== observed || ++reads !== 2) return metadata;
        return Object.assign(Object.create(Object.getPrototypeOf(metadata)) as typeof metadata, metadata,
          { [field]: BigInt(metadata[field]) + 1n });
      });
      syncBuiltinESMExports();
      try {
        assert.deepEqual(await h.port.inspectRuntimeDirectory(h.runtime), { status: 'failed', reason: 'CHANGED_DURING_READ' });
        assert.equal(reads, 2);
      } finally { stat.mock.restore(); syncBuiltinESMExports(); h.close(); }
    }
  }
});

test('config and native reads reject a hardlink added after the initial file metadata check', async context => {
  for (const probe of ['config', 'native'] as const) {
    const h = fixture(), original = fsPromises.open, file = probe === 'config' ? h.file : h.binary;
    let linked = false;
    const open = context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (args[0] === file) { linkSync(file, join(h.directory, 'new-hardlink')); linked = true; }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      if (probe === 'config') await assert.rejects(readMigrationCheckConfiguration(h.file), { code: 'MIGRATION_CHECK_INVALID_CONFIG_FILE' });
      else assert.deepEqual(await h.port.inspectBinary(h.config.relay), { status: 'failed', reason: 'IDENTITY_MISMATCH' });
      assert.equal(linked, true);
    } finally { open.mock.restore(); syncBuiltinESMExports(); h.close(); }
  }
});

test('native probe checks fixed pin, executable metadata, Mach-O format and SHA without executing bytes', async () => {
  const h = fixture();
  try {
    assert.deepEqual(await h.port.inspectBinary({ ...h.config.relay, codexSha256: '0'.repeat(64) }), { status: 'failed', reason: 'PIN_MISMATCH' });
    assert.deepEqual(await h.port.inspectBinary(h.config.relay), { status: 'failed', reason: 'PIN_MISMATCH' });
    chmodSync(h.binary, 0o700); writeFileSync(h.binary, '#!/bin/sh\nexit 99\n'); chmodSync(h.binary, 0o500);
    assert.deepEqual(await h.port.inspectBinary(h.config.relay), { status: 'failed', reason: 'UNSAFE_FILE' });
    chmodSync(h.binary, 0o600);
    assert.deepEqual(await h.port.inspectBinary(h.config.relay), { status: 'failed', reason: 'UNSAFE_FILE' });
    chmodSync(h.binary, 0o777);
    assert.deepEqual(await h.port.inspectBinary(h.config.relay), { status: 'failed', reason: 'UNSAFE_FILE' });
    chmodSync(h.binary, 0o700); truncateSync(h.binary, 512 * 1024 * 1024 + 1); chmodSync(h.binary, 0o500);
    assert.deepEqual(await h.port.inspectBinary(h.config.relay), { status: 'failed', reason: 'UNSAFE_FILE' });
  } finally { h.close(); }
});

test('native final or parent symlinks and hardlinks fail before hashing', async () => {
  const h = fixture();
  try {
    const duplicate = join(h.directory, 'linked'); linkSync(h.binary, duplicate);
    assert.deepEqual(await h.port.inspectBinary(h.config.relay), { status: 'failed', reason: 'UNSAFE_FILE' });
    rmSync(duplicate); const alias = join(h.directory, 'alias'); symlinkSync(join(h.directory, 'native'), alias);
    assert.deepEqual(await h.port.inspectBinary({ ...h.config.relay, codexPath: join(alias, 'codex') }), { status: 'failed', reason: 'UNSAFE_PATH' });
    rmSync(h.binary); symlinkSync(h.file, h.binary);
    assert.deepEqual(await h.port.inspectBinary(h.config.relay), { status: 'failed', reason: 'UNSAFE_FILE' });
  } finally { h.close(); }
});

test('config replacement between lstat and open is rejected and never returned as a valid configuration', async context => {
  const h = fixture(), original = fsPromises.open;
  const open = context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    if (args[0] === h.file) { rmSync(h.file); writeFileSync(h.file, JSON.stringify(h.config), { mode: 0o600 }); }
    return original(...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(readMigrationCheckConfiguration(h.file), { code: 'MIGRATION_CHECK_INVALID_CONFIG_FILE' }); }
  finally { open.mock.restore(); syncBuiltinESMExports(); h.close(); }
});
