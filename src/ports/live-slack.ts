import type { LiveApproval, LiveAttempt, LiveClaim, LiveDeliveryResult, LivePlan, LiveSlackConfig, LiveSnapshot, LiveSource, LiveTask } from '../domain/live-slack.js';

/** 실제 Slack 접근은 이 포트에만 주입하며 모의/오프라인 승인 포트와 분리한다. */
export interface LiveSlackPort {
  capture(config: LiveSlackConfig, signal?: AbortSignal): Promise<LiveSource>;
  post(claim: LiveClaim, signal?: AbortSignal): Promise<LiveDeliveryResult>;
}

export interface LiveSlackStore {
  create(plan: LivePlan, now: Date): LiveSnapshot;
  inspect(taskId: string, ownerId: string, now: Date): LiveSnapshot;
  list(ownerId: string, now: Date): LiveTask[];
  approve(taskId: string, planHash: string, minutes: number, ownerId: string, source: LiveSource, now: Date): LiveApproval;
  claim(taskId: string, planHash: string, ownerId: string, source: LiveSource, now: Date): LiveClaim;
  finish(attemptId: string, result: LiveDeliveryResult, now: Date): LiveAttempt;
  block(taskId: string, ownerId: string, reason: string, now: Date): LiveSnapshot;
  cancel(taskId: string, ownerId: string, now: Date): LiveSnapshot;
  recover(taskId: string, ownerId: string, now: Date): LiveSnapshot;
  maintain(now: Date): { expiredPlans: number; purgedAudits: number };
  close(): void;
}
