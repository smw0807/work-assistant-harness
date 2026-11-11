import { createHash, randomUUID } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import type { ReplyApprovalRequest, ReplyFixture, ReplyPlan, ReplyRetention, ReplyTask } from '../domain/reply.js';
import { redactSlackText } from './redaction.js';

export const replyFixtures: readonly ReplyFixture[] = ['success', 'not-sent', 'unknown', 'incomplete', 'gap'];
export const defaultReplyRetention: Readonly<ReplyRetention> = { bodyRetentionHours: 24, auditRetentionDays: null };
export const syntheticReplyBody = '합성 조사 결과입니다. 요청 내용을 확인했으며 실제 업무 코드나 계정에는 접근하지 않았습니다.';
export const hashReplyBody = (body: string): string => createHash('sha256').update(body).digest('hex');

const exactKeys = (value: object, keys: string[]): boolean => Object.keys(value).length === keys.length
  && Object.keys(value).every((key) => keys.includes(key));
const validDate = (value: string): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

export const assertReplyTime = (now: Date): void => {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new HarnessError('REPLY_INVALID_TIME');
};

export const assertReplyOwner = (ownerId: string): void => {
  if (typeof ownerId !== 'string' || !/^os-user:(0|[1-9]\d{0,15})$/.test(ownerId)) throw new HarnessError('REPLY_INVALID_OWNER');
};

export const assertReplyRetention = (retention: ReplyRetention): void => {
  if (!retention || typeof retention !== 'object'
    || !exactKeys(retention, ['bodyRetentionHours', 'auditRetentionDays'])
    || !Number.isSafeInteger(retention.bodyRetentionHours) || retention.bodyRetentionHours < 1 || retention.bodyRetentionHours > 168
    || (retention.auditRetentionDays !== null && (!Number.isSafeInteger(retention.auditRetentionDays)
      || retention.auditRetentionDays < 1 || retention.auditRetentionDays > 3650))) {
    throw new HarnessError('REPLY_INVALID_RETENTION');
  }
};

/** 필드 순서와 해시 대상을 고정하여 DB/CLI JSON의 키 순서와 승인 identity를 분리한다. */
export const hashReplyPlan = (plan: Omit<ReplyPlan, 'planHash'>): string => {
  const source = plan.source;
  const content = {
    taskId: plan.taskId, ownerId: plan.ownerId, policy: plan.policy, mode: plan.mode, fixture: plan.fixture,
    source: {
      requestId: source.requestId, workspaceId: source.workspaceId, channelId: source.channelId,
      messageTs: source.messageTs, threadTs: source.threadTs, requesterId: source.requesterId,
      requestRevision: source.requestRevision, contextRevision: source.contextRevision,
      complete: source.complete, gap: source.gap, expiresAt: source.expiresAt,
    },
    destination: {
      workspaceId: plan.destination.workspaceId, channelId: plan.destination.channelId, threadTs: plan.destination.threadTs,
    },
    bodyHash: plan.bodyHash, bodyBytes: plan.bodyBytes, createdAt: plan.createdAt, expiresAt: plan.expiresAt,
    retention: { bodyRetentionHours: plan.retention.bodyRetentionHours, auditRetentionDays: plan.retention.auditRetentionDays },
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
};

export const assertReplyPlan = (plan: ReplyPlan): void => {
  if (!plan || typeof plan !== 'object' || !exactKeys(plan, [
    'taskId', 'ownerId', 'policy', 'mode', 'fixture', 'source', 'destination', 'bodyHash', 'bodyBytes',
    'createdAt', 'expiresAt', 'retention', 'planHash',
  ]) || typeof plan.taskId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(plan.taskId)
    || plan.mode !== 'mock' || plan.policy !== 'synthetic-reply-v1' || !replyFixtures.includes(plan.fixture)
    || !plan.source || typeof plan.source !== 'object' || !plan.destination || typeof plan.destination !== 'object'
    || !exactKeys(plan.source, ['requestId', 'workspaceId', 'channelId', 'messageTs', 'threadTs', 'requesterId',
      'requestRevision', 'contextRevision', 'complete', 'gap', 'expiresAt'])
    || !exactKeys(plan.destination, ['workspaceId', 'channelId', 'threadTs'])
    || plan.source.requestId !== `synthetic-reply:${plan.taskId}`
    || plan.source.workspaceId !== 'W_LOCAL' || plan.source.channelId !== 'C_ALLOWED'
    || plan.source.messageTs !== '1700000000.000002' || plan.source.threadTs !== '1700000000.000001'
    || plan.source.requesterId !== 'U_REQUESTER' || plan.source.requestRevision !== 1 || plan.source.contextRevision !== 1
    || plan.source.complete !== (plan.fixture !== 'incomplete') || plan.source.gap !== (plan.fixture === 'gap')
    || plan.destination.workspaceId !== plan.source.workspaceId || plan.destination.channelId !== plan.source.channelId
    || plan.destination.threadTs !== plan.source.threadTs || !/^[a-f0-9]{64}$/.test(plan.bodyHash)
    || !Number.isSafeInteger(plan.bodyBytes) || plan.bodyBytes < 1 || plan.bodyBytes > 4096
    || !validDate(plan.createdAt) || !validDate(plan.expiresAt) || !validDate(plan.source.expiresAt)
    || !/^[a-f0-9]{64}$/.test(plan.planHash)) throw new HarnessError('REPLY_INVALID_PLAN');
  assertReplyOwner(plan.ownerId);
  assertReplyRetention(plan.retention);
  const sourceExpiry = Date.parse(plan.createdAt) + 24 * 3_600_000;
  const bodyExpiry = Date.parse(plan.createdAt) + plan.retention.bodyRetentionHours * 3_600_000;
  if (Date.parse(plan.source.expiresAt) !== sourceExpiry || Date.parse(plan.expiresAt) !== Math.min(sourceExpiry, bodyExpiry)) {
    throw new HarnessError('REPLY_INVALID_PLAN');
  }
  if (hashReplyPlan(plan) !== plan.planHash) throw new HarnessError('REPLY_PLAN_HASH_MISMATCH');
};

export const assertReplyBody = (body: string, plan: ReplyPlan): void => {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 4096 || redactSlackText(body) !== body
    || Array.from(body).some((character) => character.charCodeAt(0) < 32 && character !== '\n' && character !== '\t')
    || /[<>`]|@(here|channel|everyone)\b|https?:\/\//i.test(body)
    || body !== syntheticReplyBody) throw new HarnessError('REPLY_INVALID_BODY');
  if (hashReplyBody(body) !== plan.bodyHash || Buffer.byteLength(body) !== plan.bodyBytes) {
    throw new HarnessError('REPLY_BODY_MISMATCH');
  }
};

export const createReplyPlan = (
  fixture: ReplyFixture, ownerId: string, now: Date, retention: ReplyRetention = defaultReplyRetention,
): { plan: ReplyPlan; body: string } => {
  assertReplyTime(now);
  assertReplyOwner(ownerId);
  assertReplyRetention(retention);
  if (!replyFixtures.includes(fixture)) throw new HarnessError('REPLY_INVALID_FIXTURE');
  const taskId = randomUUID();
  const source = {
    requestId: `synthetic-reply:${taskId}`, workspaceId: 'W_LOCAL', channelId: 'C_ALLOWED',
    messageTs: '1700000000.000002', threadTs: '1700000000.000001', requesterId: 'U_REQUESTER',
    requestRevision: 1, contextRevision: 1, complete: fixture !== 'incomplete', gap: fixture === 'gap',
    expiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
  };
  const content: Omit<ReplyPlan, 'planHash'> = {
    taskId, ownerId, policy: 'synthetic-reply-v1', mode: 'mock', fixture, source,
    destination: { workspaceId: source.workspaceId, channelId: source.channelId, threadTs: source.threadTs },
    bodyHash: hashReplyBody(syntheticReplyBody), bodyBytes: Buffer.byteLength(syntheticReplyBody),
    createdAt: now.toISOString(), expiresAt: new Date(Math.min(Date.parse(source.expiresAt),
      now.getTime() + retention.bodyRetentionHours * 3_600_000)).toISOString(), retention: { ...retention },
  };
  const plan = { ...content, planHash: hashReplyPlan(content) };
  assertReplyPlan(plan);
  return { plan, body: syntheticReplyBody };
};

export const assertReplyReady = (task: ReplyTask, body: string | null, ownerId: string, now: Date): void => {
  assertReplyTime(now);
  assertReplyOwner(ownerId);
  assertReplyPlan(task.plan);
  if (task.plan.ownerId !== ownerId) throw new HarnessError('REPLY_OWNER_MISMATCH');
  if (body === null || now.getTime() >= Date.parse(task.plan.expiresAt)) throw new HarnessError('REPLY_PAYLOAD_EXPIRED');
  assertReplyBody(body, task.plan);
  if (task.taskId !== task.plan.taskId || task.generation !== 0 || task.invalidatedAt !== null
    || task.requestRevision !== task.plan.source.requestRevision || task.contextRevision !== task.plan.source.contextRevision) {
    throw new HarnessError('REPLY_INVALIDATED');
  }
  if (!task.plan.source.complete || task.plan.source.gap) throw new HarnessError('REPLY_CONTEXT_INVALID');
};

export const validateReplyApproval = (
  task: ReplyTask, body: string | null, request: ReplyApprovalRequest, ownerId: string, now: Date,
): void => {
  assertReplyReady(task, body, ownerId, now);
  if (!request || request.taskId !== task.taskId || !Number.isSafeInteger(request.expiresInMinutes)
    || request.expiresInMinutes < 1 || request.expiresInMinutes > 60) throw new HarnessError('REPLY_INVALID_APPROVAL');
  if (request.planHash !== task.plan.planHash) throw new HarnessError('REPLY_PLAN_HASH_MISMATCH');
};
