import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteCompanyInvestigationStore } from '../adapters/sqlite-company-investigation-store.js';
import { SqliteCompanyReadonlyV3Store } from '../adapters/sqlite-company-readonly-v3-store.js';
import { HarnessError } from '../domain/errors.js';
import { prepareCompanyInvestigationDirectory } from './company-investigation-files.js';
import { parseCompanyInvestigationWorkerOptions } from './company-investigation-protocol.js';
import { companyPathsOverlap } from './company-readonly-files.js';
import { companyV3FileExists, companyV3RuntimeHash, prepareCompanyV3Directory } from './company-readonly-v3-files.js';

/** Database validation stays under the same heap, permission and parent deadline boundaries as investigation work. */
const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = parseCompanyInvestigationWorkerOptions(process.argv[2] ?? '');
  const sourceDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const runtime = options.runtimeDirectory, preparationDirectory = options.preparationDirectory, permissions = process.permission;
  if (!['plan', 'approve', 'run'].includes(options.command) || !preparationDirectory || options.sourceDirectory !== sourceDirectory
    || companyPathsOverlap(runtime, sourceDirectory) || [runtime, sourceDirectory].some(path => companyPathsOverlap(path, preparationDirectory))
    || !permissions || ['net', 'child', 'worker', 'addons', 'wasi', 'inspector'].some(scope => permissions.has(scope))
    || permissions.has('fs.write', runtime) || permissions.has('fs.write', sourceDirectory) || permissions.has('fs.write', preparationDirectory)
    || !permissions.has('fs.write', join(preparationDirectory, 'store'))
    || permissions.has('fs.write', join(runtime, 'store')) !== (options.command !== 'plan')
    || process.execArgv.filter(arg => /^--max[-_]old[-_]space[-_]size/.test(arg)).join() !== '--max-old-space-size=128') {
    throw new HarnessError('COMPANY_INVESTIGATION_UNSAFE_PREFLIGHT');
  }
  const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  let preparationId = options.preparationId;
  // Plan does not touch the new investigation runtime. Approve/run must first bind an existing task to its preparation store.
  if (options.command !== 'plan') {
    await prepareCompanyInvestigationDirectory(runtime, false);
    const database = join(runtime, 'store/company-investigation.sqlite');
    if (!await companyV3FileExists(database)) throw new HarnessError('COMPANY_INVESTIGATION_NOT_FOUND');
    const stored = new SqliteCompanyInvestigationStore(database);
    try {
      const snapshot = stored.inspect(options.taskId!, context);
      if (snapshot.plan.preparationRuntimeHash !== companyV3RuntimeHash(preparationDirectory, context.ownerId)) {
        throw new HarnessError('COMPANY_INVESTIGATION_PREPARATION_CHANGED');
      }
      preparationId = snapshot.plan.preparation.id;
    } finally { stored.close(); }
  }
  await prepareCompanyV3Directory(preparationDirectory, false);
  const database = join(preparationDirectory, 'store/company-readonly-v3.sqlite');
  if (!await companyV3FileExists(database)) throw new HarnessError('COMPANY_INVESTIGATION_PREPARATION_UNAVAILABLE');
  const prepared = new SqliteCompanyReadonlyV3Store(database);
  try {
    const snapshot = prepared.inspect(preparationId!, context);
    if (snapshot.status !== 'AWAITING_APPROVAL' || !snapshot.payload) throw new HarnessError('COMPANY_INVESTIGATION_PREPARATION_UNAVAILABLE');
    if ([runtime, preparationDirectory, sourceDirectory].some(path => companyPathsOverlap(snapshot.payload!.registration.sourceRoot, path))
      || permissions.has('fs.write', snapshot.payload.registration.sourceRoot)) throw new HarnessError('COMPANY_INVESTIGATION_UNSAFE_DIRECTORY');
  } finally { prepared.close(); }
  process.stdout.write('{"version":"company-investigation-preflight-v1","passed":true}\n');
};

void run().catch(() => {
  process.stderr.write('COMPANY_INVESTIGATION_PREFLIGHT_FAILED\n');
  process.exitCode = 1;
});
