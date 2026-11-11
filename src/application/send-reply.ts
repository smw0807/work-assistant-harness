import { HarnessError } from '../domain/errors.js';
import type { ReplyApprovalRequest, ReplyControl, ReplyFixture, ReplyRetention } from '../domain/reply.js';
import type { MockReplyDeliveryPort, ReplyStore } from '../ports/reply.js';
import { createReplyPlan } from '../policy/reply-policy.js';

export class SyntheticReplyService {
  constructor(
    private readonly store: ReplyStore,
    private readonly delivery: MockReplyDeliveryPort,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (delivery.mode !== 'mock') throw new HarnessError('REPLY_LIVE_DELIVERY_DISABLED');
  }

  create(fixture: ReplyFixture, ownerId: string, now: Date, retention?: ReplyRetention) {
    const { plan, body } = createReplyPlan(fixture, ownerId, now, retention);
    this.store.create(plan, body, now);
    return this.store.inspect(plan.taskId, ownerId, now);
  }

  inspect(taskId: string, ownerId: string, now: Date, approvalOffset = 0) {
    return this.store.inspect(taskId, ownerId, now, approvalOffset);
  }

  approve(request: ReplyApprovalRequest, ownerId: string, now: Date) {
    return this.store.approve(request, ownerId, now);
  }

  async send(taskId: string, planHash: string, ownerId: string, now: Date) {
    const claim = this.store.claim(taskId, planHash, ownerId, now);
    // DB commit 뒤의 예외는 미전송으로 단정할 수 없다. 원시 어댑터 오류는 저장하지 않는다.
    let result;
    try {
      result = await this.delivery.deliver(claim);
    } catch {
      result = { status: 'UNKNOWN' as const, reason: 'REPLY_DELIVERY_UNCERTAIN', receiptId: null };
    }
    return this.store.finish(claim.attempt.attemptId, result, this.clock());
  }

  control(event: ReplyControl, ownerId: string, now: Date) {
    return this.store.control(event, ownerId, now);
  }

  recover(taskId: string, ownerId: string, now: Date) {
    return this.store.recover(taskId, ownerId, now);
  }

  maintain(now: Date) {
    return this.store.maintain(now);
  }
}
