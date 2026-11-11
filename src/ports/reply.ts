import type {
  ReplyApproval, ReplyApprovalRequest, ReplyAttempt, ReplyClaim, ReplyControl,
  ReplyDeliveryResult, ReplyPlan, ReplySnapshot, ReplyTask,
} from '../domain/reply.js';

export interface ReplyStore {
  create(plan: ReplyPlan, body: string, now: Date): ReplyTask;
  inspect(taskId: string, ownerId: string, now: Date, approvalOffset?: number): ReplySnapshot;
  approve(request: ReplyApprovalRequest, ownerId: string, now: Date): ReplyApproval;
  claim(taskId: string, planHash: string, ownerId: string, now: Date): ReplyClaim;
  finish(attemptId: string, result: ReplyDeliveryResult, now: Date): ReplyAttempt;
  control(event: ReplyControl, ownerId: string, now: Date): ReplyTask;
  // 명시적인 상태 복구만 수행한다. 시작 시 전송을 재개하지 않는다.
  recover(taskId: string, ownerId: string, now: Date): ReplySnapshot;
  maintain(now: Date): { expiredBodies: number; expiredAudits: number };
  close(): void;
}

/** 실제 Slack 전송 포트와 호환된다고 가정하지 않는다. 합성 전송만 구현한다. */
export interface MockReplyDeliveryPort {
  readonly mode: 'mock';
  deliver(claim: ReplyClaim): Promise<ReplyDeliveryResult>;
}
