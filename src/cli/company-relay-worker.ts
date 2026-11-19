import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RestrictedCompanyRelayCodex } from '../adapters/company-relay-codex.js';
import { inspectCompanyCodexIpcDirectory } from '../adapters/codex-isolation.js';
import { CompanyInvestigationSourceAdapter } from '../adapters/company-investigation-source.js';
import { SqliteCompanyRelayStore } from '../adapters/sqlite-company-relay-store.js';
import { SqliteCompanyReadonlyV3Store } from '../adapters/sqlite-company-readonly-v3-store.js';
import { CompanyRelayService } from '../application/investigate-company-relay.js';
import type { CompanyRelayPreparationPort, CompanyRelaySnapshot } from '../domain/company-relay.js';
import { HarnessError } from '../domain/errors.js';
import { prepareCompanyRelayDirectory, readCompanyRelayAuthorization } from './company-relay-files.js';
import { companyRelaySummary, parseCompanyRelayWorkerOptions } from './company-relay-protocol.js';
import { companyPathsOverlap } from './company-readonly-files.js';
import { companyV3FileExists, companyV3RuntimeHash, prepareCompanyV3Directory } from './company-readonly-v3-files.js';

import { assertCompanyRelayAuthorizationAllowed } from '../policy/company-relay.js';
import { pruneCompanyRelayReviews, writeCompanyRelayReview } from './company-relay-review.js';
import { pruneCompanyRelayArtifacts, registerCompanyRelayArtifacts } from './company-relay-artifacts.js';

@Module({})
class CompanyRelayModule {}
const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = parseCompanyRelayWorkerOptions(process.argv[2] ?? '');
  const sourceDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const runtime = options.runtimeDirectory, preparationDirectory = options.preparationDirectory, permissions = process.permission;
  if (options.sourceDirectory !== sourceDirectory || companyPathsOverlap(runtime, sourceDirectory)
    || preparationDirectory && [runtime, sourceDirectory].some(path => companyPathsOverlap(path, preparationDirectory))
    || (options.command === 'run' ? permissions !== undefined : !permissions
      || ['net', 'child', 'worker', 'addons', 'wasi', 'inspector'].some(scope => permissions.has(scope))
      || !permissions.has('fs.write', join(runtime, 'readonly-relay-runs')) || !permissions.has('fs.write', join(runtime, 'reviews'))
      || permissions.has('fs.write', runtime) || permissions.has('fs.write', sourceDirectory)
      || !permissions.has('fs.write', join(runtime, 'store'))
      || preparationDirectory && (permissions.has('fs.write', preparationDirectory) || !permissions.has('fs.write', join(preparationDirectory, 'store'))))
    || process.execArgv.filter(arg => /^--max[-_]old[-_]space[-_]size/.test(arg)).join() !== '--max-old-space-size=128') {
    throw new HarnessError('COMPANY_RELAY_UNSAFE_WORKER');
  }
  if (options.ipcDirectory) await inspectCompanyCodexIpcDirectory(options.ipcDirectory);
  await prepareCompanyRelayDirectory(runtime, false);
  const database = join(runtime, 'store/company-relay.sqlite');
  let summary = companyRelaySummary(options.command, options.taskId);
  if (options.command !== 'plan' && !await companyV3FileExists(database)) {
    if (['approve', 'run', 'review'].includes(options.command)) throw new HarnessError('COMPANY_RELAY_NOT_FOUND');
    process.stdout.write(`${JSON.stringify(summary)}\n`); return;
  }
  const authorization = options.authorizationFile ? assertCompanyRelayAuthorizationAllowed(await readCompanyRelayAuthorization(options.authorizationFile)) : null;
  if (authorization && [runtime, preparationDirectory!, sourceDirectory, ...(options.ipcDirectory ? [options.ipcDirectory] : [])].some(path => companyPathsOverlap(path, authorization.config.codexPath))) throw new HarnessError('COMPANY_RELAY_UNSAFE_DIRECTORY');
  if (options.ipcDirectory && [runtime, preparationDirectory!, sourceDirectory, options.authorizationFile!].some(path => companyPathsOverlap(path, options.ipcDirectory!))) throw new HarnessError('COMPANY_RELAY_UNSAFE_IPC');
  const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  let prepared: SqliteCompanyReadonlyV3Store | null = null;
  let store: SqliteCompanyRelayStore | null = null;
  const controller = new AbortController(), abort = (): void => controller.abort();
  process.on('SIGTERM', abort); process.on('SIGINT', abort);
  try {
    let preparation: CompanyRelayPreparationPort | null = null;
    if (preparationDirectory) {
      await prepareCompanyV3Directory(preparationDirectory, false);
      const preparationDatabase = join(preparationDirectory, 'store/company-readonly-v3.sqlite');
      if (!await companyV3FileExists(preparationDatabase)) throw new HarnessError('COMPANY_RELAY_PREPARATION_UNAVAILABLE');
      prepared = new SqliteCompanyReadonlyV3Store(preparationDatabase);
      const preparationStore = prepared;
      preparation = {
        runtimeHash: companyV3RuntimeHash(preparationDirectory, context.ownerId),
        inspect: (id, current) => {
          const snapshot = preparationStore.inspect(id, current);
          if (snapshot.payload && ([runtime, preparationDirectory, sourceDirectory, options.authorizationFile!, authorization!.config.codexPath, ...(options.ipcDirectory ? [options.ipcDirectory] : [])].some(path => companyPathsOverlap(snapshot.payload!.registration.sourceRoot, path))
            || permissions?.has('fs.write', snapshot.payload.registration.sourceRoot))) throw new HarnessError('COMPANY_RELAY_UNSAFE_WORKER');
          return snapshot;
        },
      };
      // The parent checked before creating the empty runtime; repeat before creating the database.
      if (options.command === 'plan') preparation.inspect(options.preparationId!, context);
    }
    store = new SqliteCompanyRelayStore(database);
    // Expired DB bodies are removed even when an auxiliary review/artifact is malformed.
    const investigationStore = store, expired = store.prune(context);
    await pruneCompanyRelayReviews(runtime, investigationStore, context);
    const artifactsBefore = await pruneCompanyRelayArtifacts(runtime, context);
    const app = await NestFactory.createApplicationContext({ module: CompanyRelayModule,
      providers: [{ provide: CompanyRelayService, useFactory: () => new CompanyRelayService(investigationStore, preparation,
        preparation ? new CompanyInvestigationSourceAdapter() : null, options.command === 'run'
          ? plan => {
            const relay = new RestrictedCompanyRelayCodex(plan.configSnapshot, runtime, plan.id, plan.accountIdHash, options.ipcDirectory!);
            return { mode: 'live', transport: 'codex-cli-relay', verifyReady: () => relay.verifyReady(),
              transmit: async (...args) => {
                await registerCompanyRelayArtifacts(runtime, plan);
                return relay.transmit(...args);
              } };
          } : null, authorization) }],
    }, { logger: false, abortOnError: false });
    try {
      const service = app.get(CompanyRelayService), id = options.taskId!;
      const request = { investigationId: id, planHash: options.planHash ?? '' };
      if (options.command === 'prune') {
        const result = service.prune(context);
        summary = { ...summary, prunedPayloads: expired.payloads + result.payloads, prunedReports: expired.reports + result.reports, prunedRecords: expired.records + result.records };
      } else {
        try {
          let snapshot: CompanyRelaySnapshot;
          if (options.command === 'plan') snapshot = await service.plan(options.preparationId!, context, id);
          else if (options.command === 'approve') snapshot = await service.approve({ ...request, expiresInMinutes: options.expiresInMinutes! }, context);
          else if (options.command === 'run') snapshot = await service.run(request, context, controller.signal);
          else if (options.command === 'cancel') snapshot = service.cancel(id, context);
          else if (options.command === 'recover') snapshot = service.recover(id, context);
          else snapshot = service.inspect(id, context);
          if (options.command === 'review') await writeCompanyRelayReview(runtime, investigationStore, id, context);
          summary = companyRelaySummary(options.command, id, snapshot);
          if (options.command === 'review') summary.reviewAvailable = true;
        } catch (error) {
          if (!['inspect', 'cancel', 'recover'].includes(options.command) || !(error instanceof HarnessError)
            || error.code !== 'COMPANY_RELAY_NOT_FOUND') throw error;
        }
      }
      await pruneCompanyRelayReviews(runtime, investigationStore, { ...context, now: new Date() });
      if (options.command === 'review') {
        const current = service.inspect(id, { ...context, now: new Date() });
        if (!current.payload || !await companyV3FileExists(join(runtime, 'reviews', `${id}.json`))) throw new HarnessError('COMPANY_RELAY_REVIEW_UNAVAILABLE');
        summary = { ...companyRelaySummary(options.command, id, current), reviewAvailable: true };
      }
      const artifactsAfter = await pruneCompanyRelayArtifacts(runtime, { ...context, now: new Date() });
      summary.prunedArtifactRuns = artifactsBefore.removedRuns + artifactsAfter.removedRuns;
      summary.prunedArtifactManifests = artifactsBefore.removedManifests + artifactsAfter.removedManifests;
      summary.preservedUncertainArtifacts = Math.max(artifactsBefore.preservedUncertain, artifactsAfter.preservedUncertain);
    } finally { await app.close(); }
  } finally {
    process.off('SIGTERM', abort); process.off('SIGINT', abort);
    try { store?.close(); } finally { prepared?.close(); }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
};
void run().catch((error: unknown) => {
  const code = error instanceof HarnessError && /^COMPANY_[A-Z0-9_]+$/.test(error.code) ? error.code : 'COMPANY_RELAY_FAILED';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
