import { HarnessError } from '../domain/errors.js';
import type { LiveDeliveryResult, LiveSlackConfig, LiveSource } from '../domain/live-slack.js';
import type { LiveSlackPort, LiveSlackStore } from '../ports/live-slack.js';
import { assertLiveConfig, assertLiveCurrent, assertLiveOwner, createLivePlan } from '../policy/live-slack-policy.js';

export class LiveSlackService {
  constructor(private readonly store: LiveSlackStore, private readonly slack: LiveSlackPort, private readonly clock: () => Date = () => new Date()) {}

  async create(config: LiveSlackConfig, ownerId: string) {
    assertLiveOwner(ownerId);
    assertLiveConfig(config);
    const source = await this.slack.capture(config);
    const now = this.clock();
    return this.store.create(createLivePlan(config, source, ownerId, now), now);
  }

  inspect(taskId: string, ownerId: string) { return this.store.inspect(taskId, ownerId, this.clock()); }
  list(ownerId: string) { return this.store.list(ownerId, this.clock()); }
  maintain() { return this.store.maintain(this.clock()); }
  cancel(taskId: string, ownerId: string) { return this.store.cancel(taskId, ownerId, this.clock()); }
  recover(taskId: string, ownerId: string) { return this.store.recover(taskId, ownerId, this.clock()); }

  async approve(taskId: string, planHash: string, minutes: number, ownerId: string) {
    const source = await this.current(taskId, planHash, ownerId);
    return this.store.approve(taskId, planHash, minutes, ownerId, source, this.clock());
  }

  async send(taskId: string, planHash: string, ownerId: string) {
    const source = await this.current(taskId, planHash, ownerId);
    const claim = this.store.claim(taskId, planHash, ownerId, source, this.clock());
    let result: LiveDeliveryResult;
    try { result = await this.slack.post(claim); }
    catch { result = { status: 'UNKNOWN', reason: 'LIVE_DELIVERY_UNCERTAIN', receipt: null }; }
    try { return this.store.finish(claim.attempt.attemptId, result, this.clock()); }
    catch (error) {
      if (!(error instanceof HarnessError) || error.code !== 'LIVE_INVALID_DELIVERY_RESULT') throw error;
      return this.store.finish(claim.attempt.attemptId, { status: 'UNKNOWN', reason: 'LIVE_INVALID_DELIVERY_RESULT', receipt: null }, this.clock());
    }
  }

  private async current(taskId: string, planHash: string, ownerId: string): Promise<LiveSource> {
    const snapshot = this.inspect(taskId, ownerId);
    if (snapshot.task.plan.planHash !== planHash) throw new HarnessError('LIVE_PLAN_HASH_MISMATCH');
    if (!['AWAITING_APPROVAL', 'APPROVED', 'FAILED'].includes(snapshot.task.status)) throw new HarnessError('LIVE_TASK_NOT_READY');
    try {
      const source = await this.slack.capture(snapshot.task.plan.config);
      assertLiveCurrent(snapshot.task.plan, source, this.clock());
      return source;
    } catch {
      this.store.block(taskId, ownerId, 'LIVE_SOURCE_NOT_CONFIRMED', this.clock());
      throw new HarnessError('LIVE_SOURCE_NOT_CONFIRMED');
    }
  }
}
