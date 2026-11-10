import { HarnessError } from '../domain/errors.js';
import type { ApprovalContext, ApprovalRequest } from '../domain/approval.js';
import type { ApprovalStore, ReportSink, TaskStore } from '../ports/index.js';

/** 승인 기록과 상태의 commit 후 로컬 보고서를 동기화한다. 실행 포트는 제공하지 않는다. */
export class LocalApprovalService {
  constructor(
    private readonly store: ApprovalStore & TaskStore,
    private readonly reporter: ReportSink,
  ) {}

  async approve(request: ApprovalRequest, context: ApprovalContext) {
    const approval = this.store.approve(request, context);
    const task = this.store.find(request.taskId);
    if (!task) throw new HarnessError('TASK_NOT_FOUND');
    await this.reporter.write(task);
    return { task, approval, ...this.store.listApprovalHistory(task.taskId, 0) };
  }

  async cancel(taskId: string, ownerId: string, now: Date) {
    const task = this.store.cancelApproval(taskId, ownerId, now);
    await this.reporter.write(task);
    return { task, ...this.store.listApprovalHistory(task.taskId, 0) };
  }
}
