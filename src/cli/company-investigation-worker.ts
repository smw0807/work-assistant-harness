import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixedCompanyInvestigationModel } from '../adapters/company-investigation-model.js';
import { CompanyInvestigationSourceAdapter } from '../adapters/company-investigation-source.js';
import { SqliteCompanyInvestigationStore } from '../adapters/sqlite-company-investigation-store.js';
import { SqliteCompanyReadonlyV3Store } from '../adapters/sqlite-company-readonly-v3-store.js';
import { CompanyInvestigationService } from '../application/investigate-company.js';
import type { CompanyInvestigationPreparationPort, CompanyInvestigationSnapshot } from '../domain/company-investigation.js';
import { HarnessError } from '../domain/errors.js';
import { prepareCompanyInvestigationDirectory } from './company-investigation-files.js';
import { companyInvestigationSummary, parseCompanyInvestigationWorkerOptions } from './company-investigation-protocol.js';
import { companyPathsOverlap } from './company-readonly-files.js';
import { companyV3FileExists, companyV3RuntimeHash, prepareCompanyV3Directory } from './company-readonly-v3-files.js';

@Module({})
class CompanyInvestigationModule {}
const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = parseCompanyInvestigationWorkerOptions(process.argv[2] ?? '');
  const sourceDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const runtime = options.runtimeDirectory, preparationDirectory = options.preparationDirectory, permissions = process.permission;
  if (options.sourceDirectory !== sourceDirectory || companyPathsOverlap(runtime, sourceDirectory)
    || preparationDirectory && [runtime, sourceDirectory].some(path => companyPathsOverlap(path, preparationDirectory))
    || !permissions || ['net', 'child', 'worker', 'addons', 'wasi', 'inspector'].some(scope => permissions.has(scope))
    || permissions.has('fs.write', runtime) || permissions.has('fs.write', sourceDirectory)
    || !permissions.has('fs.write', join(runtime, 'store'))
    || preparationDirectory && (permissions.has('fs.write', preparationDirectory) || !permissions.has('fs.write', join(preparationDirectory, 'store')))
    || process.execArgv.filter(arg => /^--max[-_]old[-_]space[-_]size/.test(arg)).join() !== '--max-old-space-size=128') {
    throw new HarnessError('COMPANY_INVESTIGATION_UNSAFE_WORKER');
  }
  await prepareCompanyInvestigationDirectory(runtime, false);
  const database = join(runtime, 'store/company-investigation.sqlite');
  let summary = companyInvestigationSummary(options.command, options.taskId);
  if (options.command !== 'plan' && !await companyV3FileExists(database)) {
    process.stdout.write(`${JSON.stringify(summary)}\n`); return;
  }
  const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  let prepared: SqliteCompanyReadonlyV3Store | null = null;
  let store: SqliteCompanyInvestigationStore | null = null;
  const controller = new AbortController(), abort = (): void => controller.abort();
  process.on('SIGTERM', abort); process.on('SIGINT', abort);
  try {
    let preparation: CompanyInvestigationPreparationPort | null = null;
    if (preparationDirectory) {
      await prepareCompanyV3Directory(preparationDirectory, false);
      const preparationDatabase = join(preparationDirectory, 'store/company-readonly-v3.sqlite');
      if (!await companyV3FileExists(preparationDatabase)) throw new HarnessError('COMPANY_INVESTIGATION_PREPARATION_UNAVAILABLE');
      prepared = new SqliteCompanyReadonlyV3Store(preparationDatabase);
      const preparationStore = prepared;
      preparation = {
        runtimeHash: companyV3RuntimeHash(preparationDirectory, context.ownerId),
        inspect: (id, current) => {
          const snapshot = preparationStore.inspect(id, current);
          if (snapshot.payload && ([runtime, preparationDirectory, sourceDirectory].some(path => companyPathsOverlap(snapshot.payload!.registration.sourceRoot, path))
            || permissions.has('fs.write', snapshot.payload.registration.sourceRoot))) throw new HarnessError('COMPANY_INVESTIGATION_UNSAFE_WORKER');
          return snapshot;
        },
      };
      // The parent checked before creating the empty runtime; repeat before creating the database.
      if (options.command === 'plan') preparation.inspect(options.preparationId!, context);
    }
    store = new SqliteCompanyInvestigationStore(database);
    const investigationStore = store;
    const app = await NestFactory.createApplicationContext({ module: CompanyInvestigationModule,
      providers: [{ provide: CompanyInvestigationService, useFactory: () => new CompanyInvestigationService(investigationStore, preparation,
        preparation ? new CompanyInvestigationSourceAdapter() : null, options.command === 'run' ? new FixedCompanyInvestigationModel() : null) }],
    }, { logger: false, abortOnError: false });
    try {
      const service = app.get(CompanyInvestigationService), id = options.taskId!;
      const request = { investigationId: id, planHash: options.planHash ?? '' };
      if (options.command === 'prune') {
        const result = service.prune(context);
        summary = { ...summary, prunedPayloads: result.payloads, prunedReports: result.reports, prunedRecords: result.records };
      } else {
        try {
          let snapshot: CompanyInvestigationSnapshot;
          if (options.command === 'plan') snapshot = await service.plan(options.preparationId!, context, id);
          else if (options.command === 'approve') snapshot = await service.approve({ ...request, expiresInMinutes: options.expiresInMinutes! }, context);
          else if (options.command === 'run') snapshot = await service.run(request, context, controller.signal);
          else if (options.command === 'cancel') snapshot = service.cancel(id, context);
          else if (options.command === 'recover') snapshot = service.recover(id, context);
          else snapshot = service.inspect(id, context);
          summary = companyInvestigationSummary(options.command, id, snapshot);
        } catch (error) {
          if (!['inspect', 'cancel', 'recover'].includes(options.command) || !(error instanceof HarnessError)
            || error.code !== 'COMPANY_INVESTIGATION_NOT_FOUND') throw error;
        }
      }
    } finally { await app.close(); }
  } finally {
    process.off('SIGTERM', abort); process.off('SIGINT', abort);
    try { store?.close(); } finally { prepared?.close(); }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
};
void run().catch((error: unknown) => {
  const code = error instanceof HarnessError && /^COMPANY_[A-Z0-9_]+$/.test(error.code) ? error.code : 'COMPANY_INVESTIGATION_FAILED';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
