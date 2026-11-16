import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompanyReadonlyRepositoryAdapter } from '../adapters/company-readonly-repository.js';
import { SqliteCompanyReadonlyStore } from '../adapters/sqlite-company-readonly-store.js';
import { CompanyReadonlyPreparationService } from '../application/prepare-company-readonly.js';
import type { CompanyReadonlySnapshot } from '../domain/company-readonly.js';
import { HarnessError } from '../domain/errors.js';
import { assertCompanyReadonlyPolicyAllowed, parseCompanyReadonlyPolicy, parseCompanyReadonlyRegistration } from '../policy/company-readonly.js';
import { canonicalReadonlyJson, hashReadonlyValue } from '../policy/readonly-investigation-policy.js';
import { companyPath, companyPathsOverlap, prepareCompanyDirectory, readCompanyPrivateJson } from './company-readonly-files.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import type { CompanyReadonlyWorkerOptions } from './company-readonly.js';

@Module({})
class CompanyReadonlyModule {}

const summary = (snapshot: CompanyReadonlySnapshot) => ({
  version: snapshot.plan.version, taskId: snapshot.plan.id, status: snapshot.status, planHash: snapshot.plan.planHash,
  createdAt: snapshot.plan.createdAt, expiresAt: snapshot.plan.expiresAt, auditExpiresAt: snapshot.plan.auditExpiresAt,
  reviewAvailable: snapshot.payload !== null, approvalCreated: false, transmissionAllowed: false, executionAllowed: false,
  companyPolicyVerified: false, providerCompatibility: 'not_run', nativeExecution: 'not_run', realModel: 'not_run',
});
const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = parseReadonlyTransportJson(process.argv[2] ?? '', 32_768) as CompanyReadonlyWorkerOptions;
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || !['plan', 'inspect', 'cancel', 'prune'].includes(options.command)) throw new HarnessError('COMPANY_READONLY_INVALID_WORKER_INPUT');
  const fields = ['command', 'sourceDirectory', 'dataDirectory', ...(options.command === 'plan'
    ? ['policyFile', 'registrationFile', 'policyHash', 'registrationHash'] : options.command === 'prune' ? [] : ['taskId'])];
  if (Object.keys(options).length !== fields.length || Object.keys(options).some(key => !fields.includes(key))
    || Object.values(options).some(value => typeof value !== 'string')
    || options.command === 'plan' && ![options.policyHash, options.registrationHash].every(value => /^[a-f0-9]{64}$/.test(value!))
    || ['inspect', 'cancel'].includes(options.command) && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(options.taskId!)) {
    throw new HarnessError('COMPANY_READONLY_INVALID_WORKER_INPUT');
  }
  const sourceDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  companyPath(options.dataDirectory);
  if (options.sourceDirectory !== sourceDirectory || companyPathsOverlap(sourceDirectory, options.dataDirectory)) {
    throw new HarnessError('COMPANY_READONLY_UNSAFE_WORKER');
  }
  const permissions = process.permission;
  if (!permissions || permissions.has('net') || permissions.has('child') || permissions.has('worker')
    || permissions.has('addons') || permissions.has('wasi') || permissions.has('inspector')
    || permissions.has('fs.write', options.sourceDirectory) || !permissions.has('fs.write', options.dataDirectory)) {
    throw new HarnessError('COMPANY_READONLY_UNSAFE_WORKER');
  }
  const context = { ownerId: `os-user:${process.getuid?.()}`, now: new Date() };
  let registration, policy;
  if (options.command === 'plan') {
    for (const path of [options.policyFile!, options.registrationFile!]) {
      companyPath(path);
      if (companyPathsOverlap(path, sourceDirectory) || companyPathsOverlap(path, options.dataDirectory)) {
        throw new HarnessError('COMPANY_READONLY_UNSAFE_WORKER');
      }
    }
    policy = parseCompanyReadonlyPolicy(await readCompanyPrivateJson(options.policyFile!, 'policy'));
    assertCompanyReadonlyPolicyAllowed(policy);
    registration = parseCompanyReadonlyRegistration(await readCompanyPrivateJson(options.registrationFile!, 'registration'));
    if (hashReadonlyValue(canonicalReadonlyJson(policy)) !== options.policyHash
      || hashReadonlyValue(canonicalReadonlyJson(registration)) !== options.registrationHash
      || companyPathsOverlap(registration.sourceRoot, options.dataDirectory)
      || companyPathsOverlap(registration.sourceRoot, options.sourceDirectory)
      || companyPathsOverlap(registration.sourceRoot, options.policyFile!)
      || companyPathsOverlap(registration.sourceRoot, options.registrationFile!)
      || permissions.has('fs.write', registration.sourceRoot)) throw new HarnessError('COMPANY_READONLY_INPUT_CHANGED');
  }
  await prepareCompanyDirectory(options.dataDirectory, options.command === 'plan');
  const store = new SqliteCompanyReadonlyStore(join(options.dataDirectory, 'company-readonly.sqlite'));
  try {
    const app = await NestFactory.createApplicationContext({ module: CompanyReadonlyModule,
      providers: [{ provide: CompanyReadonlyPreparationService,
        useFactory: () => new CompanyReadonlyPreparationService(store, new CompanyReadonlyRepositoryAdapter()) }],
    }, { logger: false });
    try {
      const service = app.get(CompanyReadonlyPreparationService);
      const result = options.command === 'plan' ? summary(await service.prepare(registration!, policy!, context))
        : options.command === 'inspect' ? summary(service.inspect(options.taskId!, context))
          : options.command === 'cancel' ? summary(service.cancel(options.taskId!, context))
            : options.command === 'prune' ? service.prune(context) : (() => { throw new HarnessError('COMPANY_READONLY_UNKNOWN_COMMAND'); })();
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally { await app.close(); }
  } finally { store.close(); }
};
void run().catch((error: unknown) => {
  const code = error instanceof HarnessError && /^COMPANY_READONLY_[A-Z_]+$/.test(error.code) ? error.code : 'COMPANY_READONLY_PREPARATION_FAILED';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
