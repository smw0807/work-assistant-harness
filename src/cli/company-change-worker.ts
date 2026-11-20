import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteCompanyChangeStore } from '../adapters/sqlite-company-change-store.js';
import { CompanyChangePreparationService } from '../application/prepare-company-change.js';
import type { CompanyChangeSnapshot } from '../domain/company-change.js';
import { HarnessError } from '../domain/errors.js';
import { getCompanyChangeLimits } from '../policy/company-change.js';
import { companyPath, companyPathsOverlap } from './company-readonly-files.js';
import { acquireCompanyChangeLease, companyChangeFileExists, companyChangeReviewExists, pruneCompanyChangeReviews,
  readCompanyChangePrivateJson, removeCompanyChangeReview, validateCompanyChangeRuntime, writeCompanyChangeReview } from './company-change-files.js';
import { emptyCompanyChangeSummary, parseCompanyChangeWorkerOptions, type CompanyChangeSummary } from './company-change-protocol.js';

@Module({})
class CompanyChangeModule {}
const summaryFields = (snapshot: CompanyChangeSnapshot) => ({
  taskId: snapshot.plan.id, status: snapshot.status, planHash: snapshot.plan.planHash, draftHash: snapshot.plan.draftHash,
  createdAt: snapshot.plan.createdAt, expiresAt: snapshot.plan.expiresAt, auditExpiresAt: snapshot.plan.auditExpiresAt,
  changeCount: snapshot.plan.changeCount, draftAvailable: snapshot.draft !== null,
  approvalId: snapshot.approval?.id ?? null, approvalExpiresAt: snapshot.approval?.expiresAt ?? null,
});

const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = parseCompanyChangeWorkerOptions(process.argv[2] ?? '');
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const runtime = companyPath(options.runtimeDirectory), storeDirectory = join(runtime, 'store'), reviewsDirectory = join(runtime, 'reviews');
  const permissions = process.permission;
  if (options.harnessDirectory !== source || companyPathsOverlap(runtime, source) || !permissions
    || permissions.has('net') || permissions.has('child') || permissions.has('worker') || permissions.has('addons')
    || permissions.has('wasi') || permissions.has('inspector')
    || permissions.has('fs.write', runtime) || permissions.has('fs.write', source)
    || !permissions.has('fs.write', storeDirectory) || !permissions.has('fs.write', reviewsDirectory)
    || permissions.has('fs.read', source) || permissions.has('fs.read', dirname(runtime))
    || process.execArgv.filter(arg => /^--max[-_]old[-_]space[-_]size/u.test(arg)).join() !== '--max-old-space-size=128'
    // macOS may add its character-encoding metadata even when spawn receives an explicit environment.
    || Object.keys(process.env).some(key => !['LANG', 'TZ', 'NODE_NO_WARNINGS', '__CF_USER_TEXT_ENCODING'].includes(key))) {
    throw new HarnessError('COMPANY_CHANGE_UNSAFE_WORKER');
  }
  if (options.draftFile !== null) {
    companyPath(options.draftFile);
    if ([source, runtime].some(path => companyPathsOverlap(path, options.draftFile!))
      || permissions.has('fs.write', options.draftFile)) throw new HarnessError('COMPANY_CHANGE_UNSAFE_WORKER');
  }
  const guard = await validateCompanyChangeRuntime(runtime), release = await acquireCompanyChangeLease(runtime);
  let summary: CompanyChangeSummary = emptyCompanyChangeSummary(options);
  try {
    const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
    summary.prunedReviews = await pruneCompanyChangeReviews(runtime, context.now);
    const databasePath = join(storeDirectory, 'company-change.sqlite');
    if (options.command === 'plan' || await companyChangeFileExists(databasePath)) {
      const draft = options.command === 'plan' ? await readCompanyChangePrivateJson(options.draftFile!, getCompanyChangeLimits().maxDraftJsonBytes) : null;
      const store = new SqliteCompanyChangeStore(databasePath);
      try {
        const app = await NestFactory.createApplicationContext({ module: CompanyChangeModule, providers: [{
          provide: CompanyChangePreparationService, useFactory: () => new CompanyChangePreparationService(store),
        }] }, { logger: false });
        try {
          const service = app.get(CompanyChangePreparationService);
          if (options.command === 'prune') {
            context.now = new Date();
            const pruned = service.prune(context);
            summary.prunedDrafts = pruned.draftsRemoved; summary.prunedRecords = pruned.recordsRemoved;
          } else {
            try {
              context.now = new Date();
              const snapshot = options.command === 'plan' ? service.prepare(draft, context, options.taskId!)
                : options.command === 'approve' ? service.approve({ taskId: options.taskId!, planHash: options.planHash!, expiresInMinutes: options.expiresInMinutes! }, context)
                : options.command === 'cancel' ? service.cancel(options.taskId!, context)
                : options.command === 'review' ? service.review(options.taskId!, context) : service.inspect(options.taskId!, context);
              summary = { ...summary, ...summaryFields(snapshot) };
              if (options.command === 'review') await writeCompanyChangeReview(runtime, snapshot);
              if (!snapshot.draft) summary.prunedReviews += await removeCompanyChangeReview(runtime, options.taskId!, snapshot.plan);
              summary.reviewFileAvailable = await companyChangeReviewExists(runtime, options.taskId!, snapshot.plan);
            } catch (error) {
              if (options.command === 'plan' || !(error instanceof HarnessError) || error.code !== 'COMPANY_CHANGE_NOT_FOUND') throw error;
              summary.prunedReviews += await removeCompanyChangeReview(runtime, options.taskId!);
            }
          }
        } finally { await app.close(); }
      } finally { store.close(); }
    }
    await guard();
  } finally { await release(); }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
};
void run().catch((error: unknown) => {
  const code = error instanceof HarnessError && /^COMPANY_CHANGE_[A-Z_]+$/u.test(error.code) ? error.code : 'COMPANY_CHANGE_WORKER_FAILED';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
