import type { ReplyClaim, ReplyDeliveryResult } from '../domain/reply.js';
import type { MockReplyDeliveryPort } from '../ports/reply.js';
import { assertReplyBody, assertReplyPlan } from '../policy/reply-policy.js';

/** 토큰, HTTP client, shell 없이 결정적인 합성 결과만 반환한다. */
export class MockReplyDelivery implements MockReplyDeliveryPort {
  readonly mode = 'mock' as const;

  async deliver(claim: ReplyClaim): Promise<ReplyDeliveryResult> {
    assertReplyPlan(claim.task.plan);
    assertReplyBody(claim.body, claim.task.plan);
    switch (claim.task.plan.fixture) {
      case 'success': return { status: 'SIMULATED', reason: null, receiptId: `mock:${claim.attempt.attemptId}` };
      case 'not-sent': return { status: 'NOT_SENT', reason: 'MOCK_NOT_SENT', receiptId: null };
      default: return { status: 'UNKNOWN', reason: 'MOCK_RESULT_UNKNOWN', receiptId: null };
    }
  }
}
