import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireSyntheticCompanyChangeControl } from '../adapters/synthetic-company-change-control.js';
import { SqliteSyntheticCompanyChangeStore } from '../adapters/sqlite-synthetic-company-change-store.js';
import { createSyntheticCompanyChangeWorkspace, openSyntheticCompanyChangeWorkspace,
  SYNTHETIC_COMPANY_CHANGE_FILES } from '../adapters/synthetic-company-change-workspace.js';
import { SyntheticCompanyChangeService } from '../application/apply-synthetic-company-change.js';
import { recoverSyntheticCompanyChange } from '../application/recover-synthetic-company-change.js';
import { HarnessError } from '../domain/errors.js';
import type { SyntheticCompanyChangeSnapshot } from '../domain/synthetic-company-change.js';
import { hashCompanyChangeValue, parseCompanyChangeDraft } from '../policy/company-change.js';
import { readSyntheticChangeDraft, syntheticChangePath, validateSyntheticChangeDraftPath, validateSyntheticChangeRuntime,
  writeSyntheticChangeJson, writeSyntheticChangeReport } from './synthetic-company-change-files.js';
import { parseSyntheticChangeWorkerOptions, syntheticChangeBoundary, type SyntheticChangeSummary } from './synthetic-company-change-protocol.js';
import { companyPathsOverlap } from './company-readonly-files.js';

@Module({})
class SyntheticChangeModule {}
const summaryFields = (snapshot: SyntheticCompanyChangeSnapshot) => ({
  taskId: snapshot.plan.id, status: snapshot.status, planHash: snapshot.plan.planHash, draftHash: snapshot.plan.draftHash,
  baseCommit: snapshot.plan.source.baseCommit, indexHash: snapshot.plan.source.indexHash,
  changeCount: snapshot.plan.changes.length, journalCount: snapshot.journal.length,
  approvalExpiresAt: snapshot.approval?.expiresAt ?? null, failureCode: snapshot.failureCode,
});
const context = () => ({ ownerId: `os-user:${process.getuid?.()}`, now: new Date() });
const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = parseSyntheticChangeWorkerOptions(process.argv[2] ?? '');
  const harness = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  if (process.argv.length !== 3 || options.harnessDirectory !== harness || process.permission
    || process.execArgv.join('\n') !== '--no-addons\n--disable-proto=throw\n--max-old-space-size=128'
    || Object.keys(process.env).some(key => !['LANG', 'TZ', 'NODE_NO_WARNINGS', '__CF_USER_TEXT_ENCODING'].includes(key))
    || process.env.LANG !== 'C.UTF-8' || process.env.TZ !== 'UTC' || process.env.NODE_NO_WARNINGS !== '1') {
    throw new HarnessError('SYNTHETIC_COMPANY_CHANGE_UNSAFE_WORKER');
  }
  const runtime = await syntheticChangePath(options.runtimeDirectory), initializing = options.command === 'init';
  if (companyPathsOverlap(runtime, harness) || options.draftFile && companyPathsOverlap(options.draftFile, harness)) {
    throw new HarnessError('SYNTHETIC_COMPANY_CHANGE_UNSAFE_RUNTIME');
  }
  const guard = await validateSyntheticChangeRuntime(runtime, initializing);
  const draftGuard = options.draftFile ? await validateSyntheticChangeDraftPath(runtime, options.draftFile) : null;
  if (initializing) for (const directory of ['store', 'control', 'reports']) await mkdir(join(runtime, directory), { mode: 0o700 });
  const release = acquireSyntheticCompanyChangeControl(runtime, initializing);
  let summary: SyntheticChangeSummary;
  try {
    const workspace = initializing ? await createSyntheticCompanyChangeWorkspace(runtime)
      : await openSyntheticCompanyChangeWorkspace(join(runtime, 'synthetic-workspace.json'));
    if (initializing) {
      workspace.register(join(runtime, 'synthetic-workspace.json'));
      const draft = parseCompanyChangeDraft({ version: 'company-change-draft-v1', repoId: 'synthetic-company-change', requestRevision: 1,
        objective: 'Apply three fixed synthetic example changes.', baseCommit: workspace.baseCommit, baseBranch: 'main', baseIndexHash: workspace.baseIndexHash,
        workType: 'fix', branch: 'fix/synthetic-example', changes: [
          { operation: 'replace', path: 'src/message.ts', beforeHash: hashCompanyChangeValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/message.ts']!), content: "export const message = 'after';\n" },
          { operation: 'replace', path: 'src/options.ts', beforeHash: hashCompanyChangeValue(SYNTHETIC_COMPANY_CHANGE_FILES['src/options.ts']!), content: 'export const options = { enabled: true };\n' },
          { operation: 'create', path: 'src/addition.ts', beforeHash: null, content: "export const addition = 'synthetic';\n" },
        ] });
      await writeSyntheticChangeJson(join(runtime, 'example-draft.json'), draft);
    }
    const store = new SqliteSyntheticCompanyChangeStore(join(runtime, 'store', 'synthetic-company-change.sqlite'));
    try {
      const app = await NestFactory.createApplicationContext({ module: SyntheticChangeModule, providers: [{
        provide: SyntheticCompanyChangeService, useFactory: () => new SyntheticCompanyChangeService(store, workspace),
      }] }, { logger: false });
      try {
        const service = app.get(SyntheticCompanyChangeService);
        if (initializing) {
          summary = { version: 'synthetic-change-result-v1', command: options.command, taskId: null, status: 'INITIALIZED',
            planHash: null, draftHash: null, baseCommit: workspace.baseCommit, indexHash: workspace.baseIndexHash, changeCount: 3,
            journalCount: 0, approvalExpiresAt: null, failureCode: null, reportAvailable: false, observationAvailable: false, ...syntheticChangeBoundary };
        } else {
          const draft = options.draftFile ? await readSyntheticChangeDraft(options.draftFile) : null;
          const result = options.command === 'recover' ? await recoverSyntheticCompanyChange(store, workspace,
            { taskId: options.taskId!, planHash: options.planHash! }, context) : null;
          const snapshot = result?.snapshot ?? (options.command === 'plan' ? await service.prepare(draft, options.taskId!)
            : options.command === 'approve' ? await service.approve({ taskId: options.taskId!, planHash: options.planHash!, expiresInMinutes: options.expiresInMinutes! }, draft)
            : options.command === 'apply' ? await service.apply({ taskId: options.taskId!, planHash: options.planHash! }, draft)
            : options.command === 'cancel' ? service.cancel(options.taskId!) : service.inspect(options.taskId!));
          const reportAvailable = ['inspect', 'recover'].includes(options.command);
          if (reportAvailable) await writeSyntheticChangeReport(runtime, snapshot.plan.id, {
            version: 'synthetic-change-local-report-v1', generatedAt: new Date().toISOString(),
            snapshot, observation: result?.observation ?? null, ...syntheticChangeBoundary,
          });
          summary = { version: 'synthetic-change-result-v1', command: options.command, ...summaryFields(snapshot),
            reportAvailable, observationAvailable: result !== null, ...syntheticChangeBoundary };
        }
      } finally { await app.close(); }
    } finally { store.close(); }
    await guard(); if (draftGuard) await draftGuard();
    const finalGuard = await validateSyntheticChangeRuntime(runtime); await finalGuard();
  } finally { release(); }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
};
void run().catch((error: unknown) => {
  const code = error instanceof HarnessError && /^SYNTHETIC_COMPANY_CHANGE_[A-Z_]{1,60}$/u.test(error.code)
    ? error.code : 'SYNTHETIC_COMPANY_CHANGE_WORKER_FAILED';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
