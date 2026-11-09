import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { HarnessError } from '../domain/errors.js';
import { transitionTask } from '../domain/state.js';
import type { Task } from '../domain/types.js';
import type { TaskStore } from '../ports/index.js';
import { assertRuntimeFile } from '../policy/runtime-path.js';

export class SqliteTaskStore implements TaskStore {
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) assertRuntimeFile(`${filePath}${suffix}`);
    this.database = new DatabaseSync(filePath, { enableForeignKeyConstraints: true });
    chmodSync(filePath, 0o600);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(workspace_id, event_id)
      ) STRICT;
    `);
  }

  create(task: Task): boolean {
    const result = this.database.prepare(`
      INSERT INTO tasks(task_id, workspace_id, event_id, status, payload)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, event_id) DO NOTHING
    `).run(task.taskId, task.workspaceId, task.eventId, task.status, JSON.stringify(task));
    return result.changes === 1;
  }

  save(task: Task): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.find(task.taskId);
      if (!existing) throw new HarnessError('TASK_NOT_FOUND');
      if (existing.status !== task.status) transitionTask(existing, task.status);
      this.database.prepare('UPDATE tasks SET status = ?, payload = ? WHERE task_id = ?')
        .run(task.status, JSON.stringify(task), task.taskId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  find(taskId: string): Task | null {
    const row = this.database.prepare('SELECT payload FROM tasks WHERE task_id = ?').get(taskId);
    return row ? this.parseTask(row.payload) : null;
  }

  list(): Task[] {
    return this.database.prepare('SELECT payload FROM tasks ORDER BY rowid')
      .all().map((row) => this.parseTask(row.payload));
  }

  recoverInterrupted(): number {
    let recoveredCount = 0;
    for (const task of this.list()) {
      if (['RECEIVED', 'TRIAGED', 'ANALYZED'].includes(task.status)) {
        this.save({
          ...transitionTask(task, 'BLOCKED'),
          failureCode: 'INTERRUPTED_REVIEW_REQUIRED',
        });
        recoveredCount += 1;
      }
    }
    return recoveredCount;
  }

  close(): void {
    this.database.close();
  }

  private parseTask(payload: unknown): Task {
    if (typeof payload !== 'string' || payload.length > 256_000) {
      throw new HarnessError('INVALID_STORED_TASK');
    }
    // DB는 같은 OS 사용자의 비공개 런타임 자료이며 외부 입력으로 사용하지 않는다.
    return JSON.parse(payload) as Task;
  }
}
