import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalMigrationCheck, readMigrationCheckConfiguration } from '../adapters/migration-check.js';
import { MigrationCheckService } from '../application/migration-check.js';
import { HarnessError } from '../domain/errors.js';
import { assertMigrationPath } from '../policy/migration-check.js';
import type { MigrationCheckPort } from '../ports/migration-check.js';

export const migrationCheckUsage = 'pnpm harness migration-check --config <absolute-private-migration-check.json>';

@Module({})
class MigrationCheckModule {
  static configure(port: MigrationCheckPort): DynamicModule {
    return { module: MigrationCheckModule,
      providers: [{ provide: MigrationCheckService, useFactory: () => new MigrationCheckService(port) }] };
  }
}

/** No default directories, leases, SQLite, registration or live adapter are created by this command. */
export const runMigrationCheckCommand = async (args: string[]): Promise<void> => {
  if (args.length !== 3 || args[0] !== 'migration-check' || args[1] !== '--config') throw new HarnessError('INVALID_ARGUMENTS');
  const configPath = assertMigrationPath(args[2], 'config');
  const config = await readMigrationCheckConfiguration(configPath);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const app = await NestFactory.createApplicationContext(MigrationCheckModule.configure(new LocalMigrationCheck(configPath, root)), { logger: false });
  try {
    const result = await app.get(MigrationCheckService).check(config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'passed') process.exitCode = 1;
  } finally { await app.close(); }
};
