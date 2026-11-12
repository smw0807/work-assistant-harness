import { createHash, randomUUID } from 'node:crypto';
import type { BranchWorkType } from '../domain/branch.js';
import { HarnessError } from '../domain/errors.js';
import {
  CODEX_PROPOSAL_POLICY_VERSION, type CodexProposalApprovalRequest, type CodexProposalContext,
  type CodexProposalPlan, type CodexProposalResult,
} from '../domain/codex-proposal.js';
import { containsSensitiveText } from './redaction.js';

export const CODEX_PROPOSAL_BEFORE = "export const message = 'before';\n";
const inputText = [
  'This is a fixed synthetic task with no company or user repository data.',
  'Return only one JSON object with exactly path and content keys. Do not use Markdown fences or tools.',
  'The path must be src/message.mjs. Replace the exported message value with approved so the registered check passes.',
  'Do not add files, commands, imports, dependencies, credentials or explanation.',
  `Current file: ${JSON.stringify({ path: 'src/message.mjs', content: CODEX_PROPOSAL_BEFORE })}`,
  'The registered check expects the exported message to equal approved.',
].join('\n');
export const hashCodexProposalValue = (value: string): string => createHash('sha256').update(value).digest('hex');
export const getCodexProposalInput = (): { inputText: string; inputHash: string } => ({ inputText, inputHash: hashCodexProposalValue(inputText) });
export const codexProposalExactKeys = (value: unknown, keys: string[]): boolean => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)));
export const isCodexProposalId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const isCodexProposalHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isCodexProposalTime = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const assertCodexProposalContext = (context: CodexProposalContext): void => {
  if (!context || !(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) throw new HarnessError('CODEX_PROPOSAL_INVALID_TIME');
  if (!process.getuid || context.ownerId !== `os-user:${process.getuid()}`) throw new HarnessError('CODEX_PROPOSAL_OWNER_MISMATCH');
};
export const hashCodexProposalPlan = (plan: Omit<CodexProposalPlan, 'planHash'>): string => hashCodexProposalValue(JSON.stringify({
  proposalId: plan.proposalId, ownerId: plan.ownerId, policy: plan.policy, workType: plan.workType,
  inputHash: plan.inputHash, configHash: plan.configHash, createdAt: plan.createdAt, expiresAt: plan.expiresAt,
}));
export const assertCodexProposalPlan = (plan: CodexProposalPlan): void => {
  if (!codexProposalExactKeys(plan, ['proposalId', 'ownerId', 'policy', 'workType', 'inputHash', 'configHash', 'createdAt', 'expiresAt', 'planHash'])
    || !isCodexProposalId(plan.proposalId) || typeof plan.ownerId !== 'string' || !/^os-user:(0|[1-9]\d{0,15})$/.test(plan.ownerId)
    || plan.policy !== CODEX_PROPOSAL_POLICY_VERSION || !['feature', 'fix', 'chore', 'refactor'].includes(plan.workType)
    || plan.inputHash !== getCodexProposalInput().inputHash || !isCodexProposalHash(plan.configHash)
    || !isCodexProposalTime(plan.createdAt) || !isCodexProposalTime(plan.expiresAt)
    || Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) !== 86_400_000
    || !isCodexProposalHash(plan.planHash)) throw new HarnessError('CODEX_PROPOSAL_INVALID_PLAN');
  if (hashCodexProposalPlan(plan) !== plan.planHash) throw new HarnessError('CODEX_PROPOSAL_PLAN_HASH_MISMATCH');
};
export const createCodexProposalPlan = (workType: BranchWorkType, configHash: string, context: CodexProposalContext, proposalId: string = randomUUID()): CodexProposalPlan => {
  assertCodexProposalContext(context);
  const expiresAt = new Date(context.now.getTime() + 86_400_000);
  if (!Number.isFinite(expiresAt.getTime())) throw new HarnessError('CODEX_PROPOSAL_INVALID_TIME');
  const plan = { proposalId, ownerId: context.ownerId, policy: CODEX_PROPOSAL_POLICY_VERSION, workType,
    inputHash: getCodexProposalInput().inputHash, configHash, createdAt: context.now.toISOString(),
    expiresAt: expiresAt.toISOString() };
  const result = { ...plan, planHash: hashCodexProposalPlan(plan) };
  assertCodexProposalPlan(result);
  return result;
};
export const assertCodexProposalApprovalRequest = (request: CodexProposalApprovalRequest): void => {
  if (!codexProposalExactKeys(request, ['proposalId', 'planHash', 'expiresInMinutes']) || !isCodexProposalId(request.proposalId)
    || !isCodexProposalHash(request.planHash) || !Number.isInteger(request.expiresInMinutes)
    || request.expiresInMinutes < 1 || request.expiresInMinutes > 60) throw new HarnessError('CODEX_PROPOSAL_INVALID_APPROVAL');
};
export const assertCodexProposalContent: (value: unknown) => asserts value is { path: 'src/message.mjs'; content: string } = (value) => {
  if (!codexProposalExactKeys(value, ['path', 'content'])) throw new HarnessError('CODEX_PROPOSAL_INVALID_RESPONSE');
  const output = value as { path: unknown; content: unknown };
  if (output.path !== 'src/message.mjs' || typeof output.content !== 'string' || Buffer.byteLength(output.content) > 8192
    || output.content.length === 0 || output.content.includes('\0') || output.content === CODEX_PROPOSAL_BEFORE
    || Buffer.from(output.content).toString('utf8') !== output.content
    || containsSensitiveText(output.content)) throw new HarnessError('CODEX_PROPOSAL_INVALID_RESPONSE');
};
export const parseCodexProposalResponse = (raw: string): CodexProposalResult => {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16 * 1024) throw new HarnessError('CODEX_PROPOSAL_OUTPUT_LIMIT');
  let output: unknown;
  try { output = JSON.parse(raw) as unknown; } catch { throw new HarnessError('CODEX_PROPOSAL_INVALID_RESPONSE'); }
  // 두 문자열 속성만 받으므로 JSON.parse가 조용히 덮어쓰는 중복 키도 허용하지 않는다.
  const pairPattern = '"(?:[^"\\\\]|\\\\.)*"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"';
  if (!new RegExp(`^\\s*\\{\\s*${pairPattern}\\s*,\\s*${pairPattern}\\s*\\}\\s*$`, 'su').test(raw)) {
    throw new HarnessError('CODEX_PROPOSAL_INVALID_RESPONSE');
  }
  assertCodexProposalContent(output);
  return { ...output, responseHash: hashCodexProposalValue(raw) };
};
export const assertCodexProposalResult = (result: CodexProposalResult): void => {
  if (!codexProposalExactKeys(result, ['path', 'content', 'responseHash']) || !isCodexProposalHash(result.responseHash)) {
    throw new HarnessError('CODEX_PROPOSAL_INVALID_RESPONSE');
  }
  assertCodexProposalContent({ path: result.path, content: result.content });
};
