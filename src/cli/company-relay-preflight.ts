import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteCompanyRelayStore } from '../adapters/sqlite-company-relay-store.js';
import { SqliteCompanyReadonlyV3Store } from '../adapters/sqlite-company-readonly-v3-store.js';
import { HarnessError } from '../domain/errors.js';
import { assertCompanyRelayAuthorizationAllowed } from '../policy/company-relay.js';
import { prepareCompanyRelayDirectory, readCompanyRelayAuthorization } from './company-relay-files.js';
import { parseCompanyRelayWorkerOptions } from './company-relay-protocol.js';
import { companyPathsOverlap } from './company-readonly-files.js';
import { companyV3FileExists, companyV3RuntimeHash, prepareCompanyV3Directory } from './company-readonly-v3-files.js';

/** Database validation stays under the same heap, permission and parent deadline boundaries as investigation work. */
const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = parseCompanyRelayWorkerOptions(process.argv[2] ?? '');
  const sourceDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const runtime = options.runtimeDirectory, preparationDirectory = options.preparationDirectory, permissions = process.permission;
  if (!['plan', 'approve', 'run'].includes(options.command) || !preparationDirectory || options.sourceDirectory !== sourceDirectory
    || companyPathsOverlap(runtime, sourceDirectory) || [runtime, sourceDirectory].some(path => companyPathsOverlap(path, preparationDirectory))
    || !permissions || ['net', 'child', 'worker', 'addons', 'wasi', 'inspector'].some(scope => permissions.has(scope))
    || permissions.has('fs.write', runtime) || permissions.has('fs.write', sourceDirectory) || permissions.has('fs.write', preparationDirectory)
    || !permissions.has('fs.write', join(preparationDirectory, 'store'))
    || permissions.has('fs.write', join(runtime, 'store')) !== (options.command !== 'plan')
    || process.execArgv.filter(arg => /^--max[-_]old[-_]space[-_]size/.test(arg)).join() !== '--max-old-space-size=128') {
    throw new HarnessError('COMPANY_RELAY_UNSAFE_PREFLIGHT');
  }
  const declaration = assertCompanyRelayAuthorizationAllowed(await readCompanyRelayAuthorization(options.authorizationFile!));
  if ([runtime, preparationDirectory, sourceDirectory].some(path => companyPathsOverlap(path, declaration.config.codexPath))) throw new HarnessError('COMPANY_RELAY_UNSAFE_DIRECTORY');
  const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  let preparationId = options.preparationId;
  // Plan does not touch the new investigation runtime. Approve/run must first bind an existing task to its preparation store.
  if (options.command !== 'plan') {
    await prepareCompanyRelayDirectory(runtime, false);
    const database = join(runtime, 'store/company-relay.sqlite');
    if (!await companyV3FileExists(database)) throw new HarnessError('COMPANY_RELAY_NOT_FOUND');
    const stored = new SqliteCompanyRelayStore(database);
    try {
      const snapshot = stored.inspect(options.taskId!, context);
      if (snapshot.plan.preparationRuntimeHash !== companyV3RuntimeHash(preparationDirectory, context.ownerId)) {
        throw new HarnessError('COMPANY_RELAY_PREPARATION_CHANGED');
      }
      preparationId = snapshot.plan.preparation.id;
    } finally { stored.close(); }
  }
  await prepareCompanyV3Directory(preparationDirectory, false);
  const database = join(preparationDirectory, 'store/company-readonly-v3.sqlite');
  if (!await companyV3FileExists(database)) throw new HarnessError('COMPANY_RELAY_PREPARATION_UNAVAILABLE');
  const prepared = new SqliteCompanyReadonlyV3Store(database);
  try {
    const snapshot = prepared.inspect(preparationId!, context);
    if (snapshot.status !== 'AWAITING_APPROVAL' || !snapshot.payload) throw new HarnessError('COMPANY_RELAY_PREPARATION_UNAVAILABLE');
    if ([runtime, preparationDirectory, sourceDirectory, options.authorizationFile!, declaration.config.codexPath, ...(options.ipcDirectory ? [options.ipcDirectory] : [])].some(path => companyPathsOverlap(snapshot.payload!.registration.sourceRoot, path))
      || permissions.has('fs.write', snapshot.payload.registration.sourceRoot)) throw new HarnessError('COMPANY_RELAY_UNSAFE_DIRECTORY');
  } finally { prepared.close(); }
  process.stdout.write('{"version":"company-relay-preflight-v1","passed":true}\n');
};

void run().catch(() => {
  process.stderr.write('COMPANY_RELAY_PREFLIGHT_FAILED\n');
  process.exitCode = 1;
});
