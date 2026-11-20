import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompanyReadonlyV3SourceAdapter } from '../adapters/company-readonly-v3-source.js';
import { SqliteCompanyReadonlyV3Store } from '../adapters/sqlite-company-readonly-v3-store.js';
import { CompanyReadonlyPreparationServiceV3 } from '../application/prepare-company-readonly-v3.js';
import type { CompanyReadonlySnapshotV3 } from '../domain/company-readonly-v3.js';
import { HarnessError } from '../domain/errors.js';
import { extractCompanyGitRangeSourceFailureReason } from '../policy/company-git-range-source-failure.js';
import { extractCompanyGitRangeUnitFailure, getCompanyGitRangeUnitGuardPolicyHash, getCompanyGitRangeUnitProfileHash } from '../policy/company-git-range-unit-budget.js';
import { assertCompanyReadonlyPolicyAllowed, parseCompanyReadonlyPolicy } from '../policy/company-readonly.js';
import { parseCompanyReadonlyRegistrationV3 } from '../policy/company-readonly-v3.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { companyPath, companyPathsOverlap, readCompanyPrivateJson } from './company-readonly-files.js';
import { companyV3FileExists, prepareCompanyV3Directory, readCompanyV3Registration, readCompanyV3Run } from './company-readonly-v3-files.js';
import { companyV3Disabled, parseCompanyV3WorkerOptions, type CompanyV3Summary } from './company-readonly-v3-protocol.js';
import { formatCompanyV3Diagnostic } from './company-readonly-v3-diagnostic-protocol.js';
import { companyV3WorkerFailureCode, formatCompanyV3WorkerFailure } from './company-readonly-v3-worker-failure.js';

@Module({})
class CompanyReadonlyV3Module {}
let diagnosticTaskId: string | null = null;
const throwCleanupFailure = (error: unknown, alreadyFailed: boolean): void => { if (!alreadyFailed) throw error; };

const snapshotSummary = (snapshot: CompanyReadonlySnapshotV3) => ({
  status: snapshot.status, planHash: snapshot.plan.planHash, createdAt: snapshot.plan.createdAt,
  expiresAt: snapshot.plan.expiresAt, auditExpiresAt: snapshot.plan.auditExpiresAt, reviewAvailable: snapshot.payload !== null,
});
const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = parseCompanyV3WorkerOptions(process.argv[2] ?? '');
  if (options.command === 'plan' && options.diagnosticsVersion) diagnosticTaskId = options.taskId!;
  const sourceDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const runtime = companyPath(options.runtimeDirectory), storeDirectory = join(runtime, 'store');
  const permissions = process.permission;
  if (options.sourceDirectory !== sourceDirectory || companyPathsOverlap(runtime, sourceDirectory)
    || !permissions || permissions.has('net') || permissions.has('child') || permissions.has('worker')
    || permissions.has('addons') || permissions.has('wasi') || permissions.has('inspector')
    || permissions.has('fs.write', sourceDirectory) || permissions.has('fs.write', runtime)
    || permissions.has('fs.write', join(runtime, 'runs')) || !permissions.has('fs.write', storeDirectory)
    || process.execArgv.filter(arg => /^--max[-_]old[-_]space[-_]size/.test(arg)).join() !== '--max-old-space-size=128') {
    throw new HarnessError('COMPANY_READONLY_V3_UNSAFE_WORKER');
  }
  let registration, policy;
  if (options.command === 'plan') {
    for (const path of [options.policyFile!, options.registrationFile!]) {
      companyPath(path);
      if (companyPathsOverlap(path, sourceDirectory) || companyPathsOverlap(path, runtime)) throw new HarnessError('COMPANY_READONLY_V3_UNSAFE_WORKER');
    }
    policy = parseCompanyReadonlyPolicy(await readCompanyPrivateJson(options.policyFile!, 'policy'));
    assertCompanyReadonlyPolicyAllowed(policy);
    registration = parseCompanyReadonlyRegistrationV3(await readCompanyV3Registration(options.registrationFile!));
    companyPath(registration.sourceRoot);
    if ([runtime, sourceDirectory, options.policyFile!, options.registrationFile!].some(path => companyPathsOverlap(registration!.sourceRoot, path))
      || permissions.has('fs.write', registration.sourceRoot)
      || hashReadonlyValue(canonicalReadonlyJson(policy)) !== options.policyHash
      || hashReadonlyValue(canonicalReadonlyJson(registration)) !== options.registrationHash) throw new HarnessError('COMPANY_READONLY_V3_INPUT_CHANGED');
  }
  await prepareCompanyV3Directory(runtime, false);
  const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  if (options.command === 'plan') {
    const receipt = await readCompanyV3Run(runtime, options.taskId!);
    if (receipt.startedAt !== options.startedAt || receipt.policyHash !== options.policyHash || receipt.registrationHash !== options.registrationHash
      || receipt.gitProfileHash !== options.gitProfileHash || receipt.guardPolicyHash !== options.guardPolicyHash
      || receipt.auditExpiresAt !== new Date(Date.parse(receipt.startedAt) + policy!.auditRetentionDays! * 86_400_000).toISOString()
      || context.now.getTime() < Date.parse(receipt.startedAt) || context.now.getTime() - Date.parse(receipt.startedAt) >= 30_000) {
      throw new HarnessError('COMPANY_READONLY_V3_INPUT_CHANGED');
    }
    context.now = new Date(receipt.startedAt);
  }
  let summary: CompanyV3Summary = {
    version: 'company-readonly-v3-result-v1', command: options.command, taskId: options.taskId ?? null,
    status: options.command === 'prune' ? 'PRUNED' : 'NOT_FOUND', planHash: null, createdAt: null, expiresAt: null, auditExpiresAt: null,
    reviewAvailable: false, prunedPayloads: 0, prunedRecords: 0, gitProfileHash: getCompanyGitRangeUnitProfileHash(),
    guardPolicyHash: getCompanyGitRangeUnitGuardPolicyHash(),
    peakRssBytes: 1, oldSpaceMiB: 128, ...companyV3Disabled,
  };
  const databasePath = join(storeDirectory, 'company-readonly-v3.sqlite');
  if (options.command === 'plan' || await companyV3FileExists(databasePath)) {
    const store = options.command === 'prune' ? SqliteCompanyReadonlyV3Store.openForPrune(databasePath)
      : new SqliteCompanyReadonlyV3Store(databasePath);
    let storeFailed = false;
    try {
      const app = await NestFactory.createApplicationContext({ module: CompanyReadonlyV3Module,
        providers: [{ provide: CompanyReadonlyPreparationServiceV3,
          useFactory: () => new CompanyReadonlyPreparationServiceV3(store, new CompanyReadonlyV3SourceAdapter()) }],
      }, { logger: false });
      let appFailed = false;
      try {
        const service = app.get(CompanyReadonlyPreparationServiceV3);
        if (options.command === 'prune') {
          const result = service.prune(context);
          summary = { ...summary, prunedPayloads: result.payloadsRemoved, prunedRecords: result.recordsRemoved };
        } else {
          try {
            const snapshot = options.command === 'plan' ? service.prepare(registration, policy, context, options.taskId!)
              : options.command === 'inspect' ? service.inspect(options.taskId!, context) : service.cancel(options.taskId!, context);
            summary = { ...summary, ...snapshotSummary(snapshot) };
          } catch (error) {
            if (options.command === 'plan' || !(error instanceof HarnessError) || error.code !== 'COMPANY_READONLY_V3_NOT_FOUND') throw error;
          }
        }
      } catch (error) { appFailed = true; throw error; }
      finally {
        try { await app.close(); } catch (error) { throwCleanupFailure(error, appFailed); }
      }
    } catch (error) { storeFailed = true; throw error; }
    finally {
      try { store.close(); } catch (error) { throwCleanupFailure(error, storeFailed); }
    }
  }
  // A reply is emitted only after both application and database shutdown complete.
  summary.peakRssBytes = process.resourceUsage().maxRSS * 1024;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
};
void run().catch((error: unknown) => {
  const code = companyV3WorkerFailureCode(error);
  const failure = extractCompanyGitRangeUnitFailure(error);
  if (diagnosticTaskId && failure) {
    try { process.stderr.write(formatCompanyV3Diagnostic(diagnosticTaskId, failure)); }
    catch { /* Diagnostic formatting cannot change the original worker failure. */ }
  }
  if (diagnosticTaskId) {
    try {
      const sourceFailureReason = extractCompanyGitRangeSourceFailureReason(error);
      process.stderr.write(formatCompanyV3WorkerFailure(diagnosticTaskId, code, sourceFailureReason ?? undefined));
    }
    catch { /* A diagnostic cannot replace or expose the underlying failure. */ }
  }
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
