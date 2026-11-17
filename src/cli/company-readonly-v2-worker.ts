import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompanyReadonlyV2SourceAdapter } from '../adapters/company-readonly-v2-source.js';
import { SqliteCompanyReadonlyV2Store } from '../adapters/sqlite-company-readonly-v2-store.js';
import { CompanyReadonlyPreparationServiceV2 } from '../application/prepare-company-readonly-v2.js';
import type { CompanyReadonlySnapshotV2 } from '../domain/company-readonly-v2.js';
import { HarnessError } from '../domain/errors.js';
import { extractCompanyGitRangeFailure, getCompanyGitRangeProfileHash } from '../policy/company-git-range-budget.js';
import { assertCompanyReadonlyPolicyAllowed, parseCompanyReadonlyPolicy } from '../policy/company-readonly.js';
import { parseCompanyReadonlyRegistrationV2 } from '../policy/company-readonly-v2.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { companyPath, companyPathsOverlap, readCompanyPrivateJson } from './company-readonly-files.js';
import { companyV2FileExists, prepareCompanyV2Directory, readCompanyV2Registration, readCompanyV2Run } from './company-readonly-v2-files.js';
import { companyV2Disabled, parseCompanyV2WorkerOptions, type CompanyV2Summary } from './company-readonly-v2-protocol.js';
import { formatCompanyV2Diagnostic } from './company-readonly-v2-diagnostic-protocol.js';

@Module({})
class CompanyReadonlyV2Module {}
let diagnosticTaskId: string | null = null;

const snapshotSummary = (snapshot: CompanyReadonlySnapshotV2) => ({
  status: snapshot.status, planHash: snapshot.plan.planHash, createdAt: snapshot.plan.createdAt,
  expiresAt: snapshot.plan.expiresAt, auditExpiresAt: snapshot.plan.auditExpiresAt, reviewAvailable: snapshot.payload !== null,
});
const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = parseCompanyV2WorkerOptions(process.argv[2] ?? '');
  const sourceDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const runtime = companyPath(options.runtimeDirectory), storeDirectory = join(runtime, 'store');
  const permissions = process.permission;
  if (options.sourceDirectory !== sourceDirectory || companyPathsOverlap(runtime, sourceDirectory)
    || !permissions || permissions.has('net') || permissions.has('child') || permissions.has('worker')
    || permissions.has('addons') || permissions.has('wasi') || permissions.has('inspector')
    || permissions.has('fs.write', sourceDirectory) || permissions.has('fs.write', runtime)
    || permissions.has('fs.write', join(runtime, 'runs')) || !permissions.has('fs.write', storeDirectory)
    || process.execArgv.filter(arg => /^--max[-_]old[-_]space[-_]size/.test(arg)).join() !== '--max-old-space-size=128') {
    throw new HarnessError('COMPANY_READONLY_V2_UNSAFE_WORKER');
  }
  let registration, policy;
  if (options.command === 'plan') {
    for (const path of [options.policyFile!, options.registrationFile!]) {
      companyPath(path);
      if (companyPathsOverlap(path, sourceDirectory) || companyPathsOverlap(path, runtime)) throw new HarnessError('COMPANY_READONLY_V2_UNSAFE_WORKER');
    }
    policy = parseCompanyReadonlyPolicy(await readCompanyPrivateJson(options.policyFile!, 'policy'));
    assertCompanyReadonlyPolicyAllowed(policy);
    registration = parseCompanyReadonlyRegistrationV2(await readCompanyV2Registration(options.registrationFile!));
    companyPath(registration.sourceRoot);
    if ([runtime, sourceDirectory, options.policyFile!, options.registrationFile!].some(path => companyPathsOverlap(registration!.sourceRoot, path))
      || permissions.has('fs.write', registration.sourceRoot)
      || hashReadonlyValue(canonicalReadonlyJson(policy)) !== options.policyHash
      || hashReadonlyValue(canonicalReadonlyJson(registration)) !== options.registrationHash) throw new HarnessError('COMPANY_READONLY_V2_INPUT_CHANGED');
  }
  await prepareCompanyV2Directory(runtime, false);
  const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  if (options.command === 'plan') {
    const receipt = await readCompanyV2Run(runtime, options.taskId!);
    if (receipt.startedAt !== options.startedAt || receipt.policyHash !== options.policyHash || receipt.registrationHash !== options.registrationHash
      || receipt.auditExpiresAt !== new Date(Date.parse(receipt.startedAt) + policy!.auditRetentionDays! * 86_400_000).toISOString()
      || context.now.getTime() < Date.parse(receipt.startedAt) || context.now.getTime() - Date.parse(receipt.startedAt) >= 30_000) {
      throw new HarnessError('COMPANY_READONLY_V2_INPUT_CHANGED');
    }
    context.now = new Date(receipt.startedAt);
    if (options.diagnosticsVersion) diagnosticTaskId = options.taskId!;
  }
  let summary: CompanyV2Summary = {
    version: 'company-readonly-v2-result-v1', command: options.command, taskId: options.taskId ?? null,
    status: options.command === 'prune' ? 'PRUNED' : 'NOT_FOUND', planHash: null, createdAt: null, expiresAt: null, auditExpiresAt: null,
    reviewAvailable: false, prunedPayloads: 0, prunedRecords: 0, gitProfileHash: getCompanyGitRangeProfileHash(),
    peakRssBytes: 1, oldSpaceMiB: 128, ...companyV2Disabled,
  };
  const databasePath = join(storeDirectory, 'company-readonly-v2.sqlite');
  if (options.command === 'plan' || await companyV2FileExists(databasePath)) {
    const store = new SqliteCompanyReadonlyV2Store(databasePath);
    try {
      const app = await NestFactory.createApplicationContext({ module: CompanyReadonlyV2Module,
        providers: [{ provide: CompanyReadonlyPreparationServiceV2,
          useFactory: () => new CompanyReadonlyPreparationServiceV2(store, new CompanyReadonlyV2SourceAdapter()) }],
      }, { logger: false });
      try {
        const service = app.get(CompanyReadonlyPreparationServiceV2);
        if (options.command === 'prune') {
          const result = service.prune(context);
          summary = { ...summary, prunedPayloads: result.payloadsRemoved, prunedRecords: result.recordsRemoved };
        } else {
          try {
            const snapshot = options.command === 'plan' ? service.prepare(registration, policy, context, options.taskId!)
              : options.command === 'inspect' ? service.inspect(options.taskId!, context) : service.cancel(options.taskId!, context);
            summary = { ...summary, ...snapshotSummary(snapshot) };
          } catch (error) {
            if (options.command === 'plan' || !(error instanceof HarnessError) || error.code !== 'COMPANY_READONLY_V2_NOT_FOUND') throw error;
          }
        }
      } finally { await app.close(); }
    } finally { store.close(); }
  }
  // A reply is emitted only after both application and database shutdown complete.
  summary.peakRssBytes = process.resourceUsage().maxRSS * 1024;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
};
void run().catch((error: unknown) => {
  const failure = extractCompanyGitRangeFailure(error);
  if (diagnosticTaskId && failure) {
    try { process.stderr.write(formatCompanyV2Diagnostic(diagnosticTaskId, failure)); }
    catch { /* Diagnostic formatting cannot change the original worker failure. */ }
  }
  const code = error instanceof HarnessError && /^COMPANY_(READONLY|GIT_RANGE)_[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'COMPANY_READONLY_V2_PREPARATION_FAILED';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
