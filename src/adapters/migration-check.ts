import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import { MIGRATION_CODEX_SHA256, type MigrationCheckConfig, type MigrationHostObservation,
  type MigrationProbeObservation, type MigrationProbeReason } from '../domain/migration-check.js';
import type { ReadonlyRelayConfig } from '../domain/readonly-relay.js';
import type { MigrationCheckPort } from '../ports/migration-check.js';
import { assertMigrationPath } from '../policy/migration-check.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';

const reject = (reason: MigrationProbeReason): never => { throw new HarnessError(reason); };
const contains = (root: string, path: string): boolean => {
  const difference = relative(root, path);
  return difference === '' || difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
};
const sameIdentity = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink;
const unchangedFile = (left: BigIntStats, right: BigIntStats): boolean => sameIdentity(left, right)
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
type DirectoryObservation = { path: string; metadata: BigIntStats };

/** Directory metadata only: never enumerate or open the contents of a prospective runtime directory. */
const inspectParents = async (path: string): Promise<DirectoryObservation[]> => {
  const paths: string[] = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    paths.unshift(parent); if (parent === dirname(parent)) break;
  }
  const observations: DirectoryObservation[] = [];
  for (const parent of paths) {
    const metadata = await lstat(parent, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) reject('UNSAFE_PATH');
    observations.push({ path: parent, metadata });
  }
  return observations;
};
const assertParentsUnchanged = async (parents: DirectoryObservation[]): Promise<void> => {
  for (const parent of parents) {
    const current = await lstat(parent.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(parent.metadata, current)) reject('CHANGED_DURING_READ');
  }
};
const currentUid = (): bigint => {
  if (!process.getuid) return reject('IDENTITY_MISMATCH');
  return BigInt(process.getuid());
};
const privateDirectory = (metadata: BigIntStats): boolean => metadata.isDirectory() && !metadata.isSymbolicLink()
  && metadata.uid === currentUid() && (metadata.mode & 0o7777n) === 0o700n;
const regularFile = (metadata: BigIntStats, maximum: bigint): boolean => metadata.isFile() && !metadata.isSymbolicLink()
  && metadata.nlink === 1n && metadata.size > 0n && metadata.size <= maximum;
const assertOpened = async (handle: FileHandle, metadata: BigIntStats): Promise<void> => {
  if (!unchangedFile(metadata, await handle.stat({ bigint: true }))) reject('IDENTITY_MISMATCH');
};
const assertFinished = async (path: string, handle: FileHandle, metadata: BigIntStats, parents: DirectoryObservation[]): Promise<void> => {
  const extra = await handle.read(Buffer.alloc(1), 0, 1, Number(metadata.size));
  if (extra.bytesRead !== 0 || !unchangedFile(metadata, await handle.stat({ bigint: true }))
    || !unchangedFile(metadata, await lstat(path, { bigint: true }))) reject('CHANGED_DURING_READ');
  await assertParentsUnchanged(parents);
};

/** Only the named private diagnostic file is read, with a strict byte bound and no link following. */
export const readMigrationCheckConfiguration = async (requested: string): Promise<unknown> => {
  try {
    const path = assertMigrationPath(requested, 'config');
    const parents = await inspectParents(path);
    if (!privateDirectory(parents.at(-1)!.metadata)) reject('UNSAFE_DIRECTORY');
    const metadata = await lstat(path, { bigint: true });
    if (!regularFile(metadata, 8192n) || metadata.uid !== currentUid() || (metadata.mode & 0o7777n) !== 0o600n) reject('UNSAFE_FILE');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      await assertOpened(handle, metadata);
      const bytes = Buffer.alloc(Number(metadata.size)); let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) reject('CHANGED_DURING_READ'); offset += result.bytesRead;
      }
      await assertFinished(path, handle, metadata, parents);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return parseReadonlyTransportJson(text, 8192);
    } finally { await handle.close(); }
  } catch { throw new HarnessError('MIGRATION_CHECK_INVALID_CONFIG_FILE'); }
};

const observation = async (action: () => Promise<MigrationProbeReason>): Promise<MigrationProbeObservation> => {
  try { return { status: 'passed', reason: await action() }; }
  catch (error) {
    const known: MigrationProbeReason[] = ['UNSAFE_PATH', 'UNSAFE_FILE', 'UNSAFE_DIRECTORY', 'OVERLAP',
      'IDENTITY_MISMATCH', 'CHANGED_DURING_READ', 'PIN_MISMATCH'];
    if (error instanceof HarnessError && known.includes(error.code as MigrationProbeReason)) return { status: 'failed', reason: error.code as MigrationProbeReason };
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { status: 'failed', reason: 'MISSING' };
    return { status: 'failed', reason: 'READ_FAILED' };
  }
};

/** Reads only the explicit diagnostic configuration and pinned executable; all other probes are metadata-only. */
export class LocalMigrationCheck implements MigrationCheckPort {
  constructor(private readonly configPath: string, private readonly harnessRoot: string) {}
  observeHost(): MigrationHostObservation {
    return { platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
      uid: process.getuid ? process.getuid() : null, pnpmUserAgent: process.env.npm_config_user_agent ?? null };
  }
  async inspectPaths(config: MigrationCheckConfig): Promise<MigrationProbeObservation> {
    return observation(async () => {
      const input = assertMigrationPath(this.configPath, 'config');
      const binary = assertMigrationPath(config.relay.codexPath, 'binary');
      const runtime = assertMigrationPath(config.runtimeDirectory, 'directory');
      if (contains(this.harnessRoot, runtime) || contains(runtime, this.harnessRoot)
        || contains(runtime, input) || contains(runtime, binary) || contains(binary, runtime)
        || contains(input, runtime) || contains(input, binary) || contains(binary, input)) reject('OVERLAP');
      return 'PATHS_SEPARATE';
    });
  }
  async inspectSandboxExecutable(): Promise<MigrationProbeObservation> {
    return observation(async () => {
      const path = '/usr/bin/sandbox-exec', parents = await inspectParents(path);
      const metadata = await lstat(path, { bigint: true });
      if (!regularFile(metadata, 512n * 1024n * 1024n) || metadata.uid !== 0n
        || (metadata.mode & 0o022n) !== 0n || (metadata.mode & 0o111n) === 0n) reject('UNSAFE_FILE');
      await assertParentsUnchanged(parents);
      if (!unchangedFile(metadata, await lstat(path, { bigint: true }))) reject('CHANGED_DURING_READ');
      return 'SANDBOX_METADATA_MATCH';
    });
  }
  async inspectBinary(config: ReadonlyRelayConfig): Promise<MigrationProbeObservation> {
    return observation(async () => {
      if (config.codexSha256 !== MIGRATION_CODEX_SHA256) reject('PIN_MISMATCH');
      const path = assertMigrationPath(config.codexPath, 'binary'), parents = await inspectParents(path);
      const metadata = await lstat(path, { bigint: true });
      if (!regularFile(metadata, 512n * 1024n * 1024n) || metadata.size < 8n
        || ![0n, currentUid()].includes(metadata.uid) || (metadata.mode & 0o7022n) !== 0n
        || (metadata.mode & 0o111n) === 0n) reject('UNSAFE_FILE');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        await assertOpened(handle, metadata);
        const header = Buffer.alloc(8), first = await handle.read(header, 0, header.length, 0);
        // The approved component is a thin 64-bit arm64 Mach-O; no executable is launched to identify it.
        if (first.bytesRead !== 8 || header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c) reject('UNSAFE_FILE');
        const hash = createHash('sha256').update(header), buffer = Buffer.alloc(65536); let offset = header.length;
        while (offset < Number(metadata.size)) {
          const result = await handle.read(buffer, 0, Math.min(buffer.length, Number(metadata.size) - offset), offset);
          if (result.bytesRead === 0) reject('CHANGED_DURING_READ');
          hash.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead;
        }
        await assertFinished(path, handle, metadata, parents);
        if (hash.digest('hex') !== MIGRATION_CODEX_SHA256) reject('PIN_MISMATCH');
      } finally { await handle.close(); }
      return 'BINARY_PIN_MATCH';
    });
  }
  async inspectRuntimeDirectory(requested: string): Promise<MigrationProbeObservation> {
    return observation(async () => {
      const path = assertMigrationPath(requested, 'directory'), parents = await inspectParents(path);
      const metadata = await lstat(path, { bigint: true });
      if (!privateDirectory(metadata)) reject('UNSAFE_DIRECTORY');
      await assertParentsUnchanged(parents);
      if (!sameIdentity(metadata, await lstat(path, { bigint: true }))) reject('CHANGED_DURING_READ');
      return 'DIRECTORY_METADATA_PRIVATE';
    });
  }
}
