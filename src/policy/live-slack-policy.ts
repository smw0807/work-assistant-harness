import { createHash, randomUUID } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import type { LiveClaim, LivePlan, LiveSlackConfig, LiveSource } from '../domain/live-slack.js';

export const liveTestBody = '하네스 Slack 단건 전송 테스트입니다. (4-B-2)';
export const liveTestRootText = '하네스 전송 테스트';
export const liveRequestTimeoutMs = 10_000;
export const liveMaxResponseBytes = 32_768;
export const liveContextMaxAgeMs = 5_000;
export const livePlanLifetimeMs = 86_400_000;
export const liveAuditRetentionMs = 30 * 86_400_000;
export const liveHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const liveIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value);
export const liveTimestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{1,20}\.\d{1,20}$/.test(value);
export const liveUuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const liveDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const liveDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const liveRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const liveKeys = (value: unknown, keys: string[]): boolean => liveRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => key in value);

export const assertLiveOwner = (ownerId: string): void => {
  if (!process.getuid || ownerId !== `os-user:${process.getuid()}`) throw new HarnessError('LIVE_OWNER_MISMATCH');
};

export const assertLiveConfig = (config: LiveSlackConfig): void => {
  if (!liveKeys(config, ['policy', 'liveEnabled', 'workspaceId', 'channelId', 'threadTs'])
    || config.policy !== 'slack-live-test-v1' || typeof config.liveEnabled !== 'boolean'
    || !liveIdentifier(config.workspaceId) || !config.workspaceId.startsWith('T')
    || !liveIdentifier(config.channelId) || !config.channelId.startsWith('C') || !liveTimestamp(config.threadTs)) {
    throw new HarnessError('LIVE_INVALID_CONFIG');
  }
  if (!config.liveEnabled) throw new HarnessError('LIVE_DISABLED');
};

export const assertLiveSource = (source: LiveSource): void => {
  if (!liveKeys(source, ['botId', 'botUserId', 'rootRevision', 'contextHash', 'observedAt'])
    || !liveIdentifier(source.botId) || !source.botId.startsWith('B') || !liveIdentifier(source.botUserId)
    || !liveTimestamp(source.rootRevision) || !liveDigest(source.contextHash) || !liveDate(source.observedAt)) {
    throw new HarnessError('LIVE_INVALID_SOURCE');
  }
};

export const assertLiveFresh = (source: LiveSource, now: Date): void => {
  assertLiveSource(source);
  const age = now.getTime() - Date.parse(source.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > liveContextMaxAgeMs) throw new HarnessError('LIVE_CONTEXT_STALE');
};

export const compareLiveTimestamp = (left: string, right: string): number => {
  const [leftSeconds = '', leftFraction = ''] = left.split('.');
  const [rightSeconds = '', rightFraction = ''] = right.split('.');
  if (BigInt(leftSeconds) !== BigInt(rightSeconds)) return BigInt(leftSeconds) < BigInt(rightSeconds) ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(width, '0').localeCompare(rightFraction.padEnd(width, '0'));
};

export const liveTargetKey = (config: LiveSlackConfig): string => {
  const [seconds = '', fraction = ''] = config.threadTs.split('.');
  const timestamp = `${BigInt(seconds)}.${fraction.replace(/0+$/, '') || '0'}`;
  return liveHash(JSON.stringify([config.workspaceId, config.channelId, timestamp]));
};

export const hashLiveContext = (message: { ts: string; user: string; text: string; revision: string }): string => liveHash(JSON.stringify({
  ts: message.ts, user: message.user, text: message.text, revision: message.revision,
}));

export const hashLivePlan = (plan: Omit<LivePlan, 'planHash'>): string => liveHash(JSON.stringify({
  taskId: plan.taskId, ownerId: plan.ownerId, policy: plan.policy, mode: plan.mode,
  config: { policy: plan.config.policy, liveEnabled: plan.config.liveEnabled, workspaceId: plan.config.workspaceId,
    channelId: plan.config.channelId, threadTs: plan.config.threadTs },
  source: { botId: plan.source.botId, botUserId: plan.source.botUserId, rootRevision: plan.source.rootRevision,
    contextHash: plan.source.contextHash, observedAt: plan.source.observedAt },
  bodyHash: plan.bodyHash, bodyBytes: plan.bodyBytes, createdAt: plan.createdAt, expiresAt: plan.expiresAt,
}));

export const assertLivePlan = (plan: LivePlan): void => {
  if (!liveKeys(plan, ['taskId', 'ownerId', 'policy', 'mode', 'config', 'source', 'bodyHash', 'bodyBytes', 'createdAt', 'expiresAt', 'planHash'])
    || !liveUuid(plan.taskId) || typeof plan.ownerId !== 'string' || !/^os-user:(0|[1-9]\d{0,15})$/.test(plan.ownerId)
    || plan.policy !== 'slack-live-test-v1' || plan.mode !== 'live-test'
    || plan.bodyHash !== liveHash(liveTestBody) || plan.bodyBytes !== Buffer.byteLength(liveTestBody)
    || !liveDate(plan.createdAt) || !liveDate(plan.expiresAt)
    || Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) !== livePlanLifetimeMs) throw new HarnessError('LIVE_INVALID_PLAN');
  assertLiveConfig(plan.config);
  assertLiveSource(plan.source);
  if (plan.planHash !== hashLivePlan(plan)) throw new HarnessError('LIVE_INVALID_PLAN');
};

export const assertLiveCurrent = (plan: LivePlan, source: LiveSource, now: Date): void => {
  assertLivePlan(plan);
  assertLiveFresh(source, now);
  if (now.getTime() < Date.parse(plan.createdAt) || now.getTime() >= Date.parse(plan.expiresAt)) throw new HarnessError('LIVE_PLAN_EXPIRED');
  if ((['botId', 'botUserId', 'rootRevision', 'contextHash'] as const).some((key) => source[key] !== plan.source[key])) {
    throw new HarnessError('LIVE_SOURCE_CHANGED');
  }
};

export const createLivePlan = (config: LiveSlackConfig, source: LiveSource, ownerId: string, now: Date): LivePlan => {
  assertLiveOwner(ownerId);
  assertLiveConfig(config);
  assertLiveFresh(source, now);
  const value: Omit<LivePlan, 'planHash'> = {
    taskId: randomUUID(), ownerId, policy: 'slack-live-test-v1', mode: 'live-test', config: structuredClone(config), source: structuredClone(source),
    bodyHash: liveHash(liveTestBody), bodyBytes: Buffer.byteLength(liveTestBody), createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + livePlanLifetimeMs).toISOString(),
  };
  const plan = { ...value, planHash: hashLivePlan(value) };
  assertLivePlan(plan);
  return plan;
};

export const assertLiveClaim = (claim: LiveClaim, now: Date): void => {
  if (!liveKeys(claim, ['task', 'approval', 'attempt', 'checkedAt'])
    || !liveKeys(claim.task, ['plan', 'status', 'updatedAt', 'reason'])
    || !liveKeys(claim.approval, ['approvalId', 'taskId', 'ownerId', 'planHash', 'planSnapshot', 'createdAt', 'expiresAt', 'usedAt', 'revokedAt'])
    || !liveKeys(claim.attempt, ['attemptId', 'taskId', 'approvalId', 'planHash', 'status', 'startedAt', 'finishedAt', 'receipt', 'reason'])) {
    throw new HarnessError('LIVE_INVALID_CLAIM');
  }
  assertLivePlan(claim.task.plan);
  assertLivePlan(claim.approval.planSnapshot);
  assertLiveOwner(claim.task.plan.ownerId);
  const { task, approval, attempt } = claim;
  if (task.status !== 'SENDING' || task.reason !== null || attempt.status !== 'SENDING' || !liveUuid(attempt.attemptId)
    || !liveUuid(approval.approvalId) || !liveDate(attempt.startedAt) || !liveDate(approval.createdAt)
    || approval.createdAt > attempt.startedAt || approval.usedAt !== attempt.startedAt || task.updatedAt !== attempt.startedAt
    || attempt.finishedAt !== null || attempt.receipt !== null || attempt.reason !== null
    || attempt.taskId !== task.plan.taskId || approval.taskId !== task.plan.taskId || attempt.approvalId !== approval.approvalId
    || attempt.planHash !== task.plan.planHash || approval.planHash !== task.plan.planHash || approval.ownerId !== task.plan.ownerId
    || !liveDate(approval.usedAt) || approval.revokedAt !== null || !liveDate(approval.expiresAt)
    || approval.planSnapshot.planHash !== task.plan.planHash || hashLivePlan(approval.planSnapshot) !== task.plan.planHash
    || !liveDate(claim.checkedAt) || claim.checkedAt > attempt.startedAt || now.getTime() < Date.parse(attempt.startedAt)
    || approval.expiresAt > task.plan.expiresAt || Date.parse(approval.expiresAt) - Date.parse(approval.createdAt) > 60 * 60_000
    || now.getTime() >= Date.parse(approval.expiresAt) || now.getTime() >= Date.parse(task.plan.expiresAt)) {
    throw new HarnessError('LIVE_INVALID_CLAIM');
  }
  assertLiveFresh({ ...task.plan.source, observedAt: claim.checkedAt }, now);
};
