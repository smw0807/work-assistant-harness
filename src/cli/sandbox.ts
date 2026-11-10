import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerSandboxVerifier } from '../adapters/docker-sandbox.js';
import { SandboxVerificationService } from '../application/verify-sandbox.js';
import { HarnessError } from '../domain/errors.js';
import type { SandboxConfig } from '../domain/sandbox.js';
import type { SandboxVerificationPort } from '../ports/sandbox.js';
import { parseSandboxConfig } from '../policy/sandbox-policy.js';
import { acquireRuntimeLease, assertSafeEventFile, defaultDataDirectory, prepareDataDirectory } from './runtime.js';

export const sandboxUsage = 'pnpm harness sandbox-check [--config <local-json>] [--data-dir <private-directory>]';

@Module({})
class SandboxCheckModule {
  static configure(config: SandboxConfig, backend: SandboxVerificationPort): DynamicModule {
    return {
      module: SandboxCheckModule,
      providers: [{ provide: SandboxVerificationService, useFactory: () => new SandboxVerificationService(config, backend) }],
    };
  }
}

const parseArguments = (arguments_: string[]): Map<string, string> => {
  if (arguments_[0] !== 'sandbox-check') throw new HarnessError('UNKNOWN_COMMAND');
  const options = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const name = arguments_[index] ?? '';
    const value = arguments_[index + 1];
    if (!['--config', '--data-dir'].includes(name) || !value || value.startsWith('--') || options.has(name)) {
      throw new HarnessError('INVALID_ARGUMENTS');
    }
    options.set(name, value);
  }
  return options;
};

export const runSandboxCheckCommand = async (arguments_: string[]): Promise<void> => {
  process.umask(0o077);
  const options = parseArguments(arguments_);
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const configPath = await assertSafeEventFile(options.get('--config') ?? join(sourceRoot, 'config', 'sandbox.example.json'));
  let config: SandboxConfig;
  try { config = parseSandboxConfig(JSON.parse(await readFile(configPath, 'utf8'))); }
  catch { throw new HarnessError('INVALID_SANDBOX_CONFIG'); }
  const dataDirectory = await prepareDataDirectory(options.get('--data-dir') ?? defaultDataDirectory(), sourceRoot);
  const releaseLease = acquireRuntimeLease(dataDirectory);
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  try {
    const reportsDirectory = join(dataDirectory, 'sandbox-checks');
    await mkdir(reportsDirectory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(reportsDirectory);
    if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0 || await realpath(reportsDirectory) !== reportsDirectory) {
      throw new HarnessError('UNSAFE_SANDBOX_DIRECTORY');
    }
    const verificationId = randomUUID();
    const artifactDirectory = join(reportsDirectory, verificationId);
    await mkdir(artifactDirectory, { mode: 0o700 });
    const controlDirectory = join(artifactDirectory, 'docker-control');
    await mkdir(controlDirectory, { mode: 0o700 });
    const backend = new DockerSandboxVerifier(config, controlDirectory);
    const application = await NestFactory.createApplicationContext(SandboxCheckModule.configure(config, backend), { logger: false, abortOnError: false });
    try {
      const report = await application.get(SandboxVerificationService).verify(artifactDirectory, controller.signal, verificationId);
      const reportPath = join(artifactDirectory, 'report.json');
      const contents = `${JSON.stringify(report, null, 2)}\n`;
      if (Buffer.byteLength(contents) > 64_000) throw new HarnessError('SANDBOX_REPORT_TOO_LARGE');
      await writeFile(reportPath, contents, { flag: 'wx', mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ ...report, reportPath, artifactDirectory }, null, 2)}\n`);
      if (report.status !== 'passed') process.exitCode = 1;
    } finally {
      await application.close();
    }
  } finally {
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
    releaseLease();
  }
};
