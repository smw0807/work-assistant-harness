import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import type { Task } from '../domain/types.js';
import type { ReportSink } from '../ports/index.js';

export class LocalReportSink implements ReportSink {
  constructor(private readonly directory: string) {}

  async write(task: Task): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(task.taskId)) throw new HarnessError('INVALID_TASK_ID');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.directory) !== this.directory) throw new HarnessError('UNSAFE_REPORT_PATH');
    const filePath = join(this.directory, `${task.taskId}.json`);
    const contents = `${JSON.stringify(task, null, 2)}\n`;
    if (Buffer.byteLength(contents) > 128_000) throw new HarnessError('REPORT_TOO_LARGE');
    try {
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new HarnessError('UNSAFE_REPORT_PATH');
      }
      if (await readFile(filePath, 'utf8') === contents) return filePath;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(contents);
    } finally {
      await file.close();
    }
    await rename(temporaryPath, filePath);
    return filePath;
  }
}
