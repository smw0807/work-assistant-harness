import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SlackPostCheckService } from '../application/verify-slack-post.js';
import { HarnessError } from '../domain/errors.js';
import { slackPostFixtures, type SlackPostCheckReport } from '../domain/slack-post.js';
import { assertPrivateSlackPostPaths, type SlackPostWorkerOptions } from './slack-post.js';

@Module({})
class SlackPostCheckModule {}

const parseOptions = (): SlackPostWorkerOptions => {
  let options: unknown;
  try { options = JSON.parse(process.argv[2] ?? '{}'); } catch { throw new HarnessError('INVALID_ARGUMENTS'); }
  if (typeof options !== 'object' || !options || Array.isArray(options)) throw new HarnessError('INVALID_ARGUMENTS');
  const value = options as Record<string, unknown>;
  const keys = ['command', 'sourceRoot', 'dataDirectory', 'fixture', 'verificationId'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))
    || value['command'] !== 'slack-post-check' || typeof value['sourceRoot'] !== 'string'
    || typeof value['dataDirectory'] !== 'string' || typeof value['fixture'] !== 'string'
    || (value['fixture'] !== 'all' && !slackPostFixtures.some((fixture) => fixture === value['fixture']))
    || typeof value['verificationId'] !== 'string'
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value['verificationId'])) {
    throw new HarnessError('INVALID_ARGUMENTS');
  }
  return options as SlackPostWorkerOptions;
};

const assertRestrictedWorker = async (options: SlackPostWorkerOptions): Promise<void> => {
  const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
  const permissions = process.permission;
  if (options.sourceRoot !== sourceRoot || !permissions || permissions.has('fs.write', sourceRoot)
    || !permissions.has('fs.write', options.dataDirectory) || permissions.has('child') || permissions.has('worker')
    || permissions.has('net') || permissions.has('addons') || permissions.has('wasi') || permissions.has('inspector')) {
    throw new HarnessError('SLACK_POST_UNSAFE_WORKER_PERMISSIONS');
  }
  if (!process.getuid) throw new HarnessError('LOCAL_OWNER_UNAVAILABLE');
  const localeKeys = ['LANG', 'TZ', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])];
  if (Object.keys(process.env).some((key) => !localeKeys.includes(key))) {
    throw new HarnessError('SLACK_POST_UNSAFE_WORKER_ENVIRONMENT');
  }
  const directory = await lstat(options.dataDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
    || directory.uid !== process.getuid() || await realpath(options.dataDirectory) !== options.dataDirectory) {
    throw new HarnessError('DATA_DIRECTORY_NOT_PRIVATE');
  }
  assertPrivateSlackPostPaths(options.dataDirectory, options.verificationId);
};

const writeReport = async (options: SlackPostWorkerOptions, report: SlackPostCheckReport): Promise<string> => {
  const content = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(content) > 65_536) throw new HarnessError('SLACK_POST_REPORT_TOO_LARGE');
  const reportsDirectory = join(options.dataDirectory, 'slack-post-checks');
  const verificationDirectory = join(reportsDirectory, options.verificationId);
  for (const directory of [reportsDirectory, verificationDirectory]) {
    assertPrivateSlackPostPaths(options.dataDirectory, options.verificationId);
    await mkdir(directory, { mode: 0o700, recursive: true });
    if (await realpath(directory) !== directory) throw new HarnessError('SLACK_POST_UNSAFE_REPORT_PATH');
  }
  assertPrivateSlackPostPaths(options.dataDirectory, options.verificationId);
  const reportPath = join(verificationDirectory, 'report.json');
  let file;
  try {
    file = await open(reportPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new HarnessError('SLACK_POST_REPORT_CREATE_FAILED');
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid!()
      || await realpath(verificationDirectory) !== verificationDirectory) {
      throw new HarnessError('SLACK_POST_UNSAFE_REPORT_PATH');
    }
    await file.writeFile(content, 'utf8');
    assertPrivateSlackPostPaths(options.dataDirectory, options.verificationId);
    if (await realpath(reportPath) !== reportPath || await realpath(verificationDirectory) !== verificationDirectory) {
      throw new HarnessError('SLACK_POST_UNSAFE_REPORT_PATH');
    }
  } finally {
    await file.close();
  }
  return reportPath;
};

const run = async (): Promise<void> => {
  process.umask(0o077);
  const options = parseOptions();
  await assertRestrictedWorker(options);
  const application = await NestFactory.createApplicationContext({
    module: SlackPostCheckModule,
    providers: [{ provide: SlackPostCheckService, useFactory: () => new SlackPostCheckService() }],
  }, { logger: false, abortOnError: false });
  try {
    const service = application.get(SlackPostCheckService);
    const report = await service.verify(options.fixture, `os-user:${process.getuid!()}`, options.verificationId);
    report.checks.push({
      name: 'restricted_worker', status: 'passed',
      reason: '고정 합성 HTTP 응답만 사용하고 네트워크·하위 프로세스·상속 토큰 없이 private 보고서만 저장합니다. 기존 조사·수신·답장·실행 DB는 열지 않습니다.',
    });
    const reportPath = await writeReport(options, report);
    process.stdout.write(`${JSON.stringify({ ...report, reportPath, dataDirectory: options.dataDirectory }, null, 2)}\n`);
  } finally {
    await application.close();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof HarnessError ? error.code : 'SLACK_POST_WORKER_FAILED'}\n`);
  process.exitCode = 1;
});
