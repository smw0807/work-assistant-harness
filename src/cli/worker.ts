import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { InvestigationService } from '../application/investigate.js';
import { MockSlackSource } from '../adapters/mock-slack-source.js';
import { HarnessError } from '../domain/errors.js';
import type { ReportSink, TaskStore } from '../ports/index.js';
import { HarnessModule, REPORT_SINK, TASK_STORE, type WorkerOptions } from './harness.module.js';
import { assertWorkerPermissions } from './runtime.js';

const runWorker = async (): Promise<void> => {
  process.umask(0o077);
  const options = JSON.parse(process.argv[2] ?? '{}') as WorkerOptions;
  assertWorkerPermissions(options.sourceRoot, options.dataDirectory, options.repository.root);
  const application = await NestFactory.createApplicationContext(HarnessModule.configure(options), { logger: false, abortOnError: false });
  const store = application.get<TaskStore>(TASK_STORE);
  try {
    const recovered = store.recoverInterrupted();
    // SQLite를 원본으로 삼아 직전 종료 때 빠진 로컬 보고서만 복구한다.
    const reporter = application.get<ReportSink>(REPORT_SINK);
    for (const task of store.list()) if (task.report) await reporter.write(task);
    if (options.command === 'inspect') {
      const task = store.find(options.taskId);
      if (!task) throw new HarnessError('TASK_NOT_FOUND');
      process.stdout.write(`${JSON.stringify({ recovered, task })}\n`);
    } else if (options.command === 'list') {
      process.stdout.write(`${JSON.stringify({ recovered, tasks: store.list().map(({ taskId, status, classification, failureCode }) => ({ taskId, status, classification, failureCode })) })}\n`);
    } else {
      const source = new MockSlackSource(options.fixturePath);
      const result = await application.get(InvestigationService).replay(await source.read());
      process.stdout.write(`${JSON.stringify({ recovered, ...result })}\n`);
    }
  } finally {
    store.close();
    await application.close();
  }
};

runWorker().catch((error: unknown) => {
  process.stderr.write(`${error instanceof HarnessError ? error.code : 'WORKER_FAILED'}\n`);
  process.exitCode = 1;
});
