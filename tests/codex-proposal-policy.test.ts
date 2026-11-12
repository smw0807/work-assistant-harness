import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodexProposalPlan } from '../src/domain/codex-proposal.js';
import {
  assertCodexProposalPlan, CODEX_PROPOSAL_BEFORE, createCodexProposalPlan,
  getCodexProposalInput, hashCodexProposalPlan, hashCodexProposalValue, parseCodexProposalResponse,
} from '../src/policy/codex-proposal-policy.js';

const context = { ownerId: `os-user:${process.getuid!()}`, now: new Date('2026-11-12T00:00:00.000Z') };
const configHash = 'a'.repeat(64);

test('proposal input is fixed synthetic text matching the execution fixture and plan binds every approval field', () => {
  const input = getCodexProposalInput();
  assert.equal(input.inputHash, hashCodexProposalValue(input.inputText));
  assert.ok(input.inputText.includes(JSON.stringify(CODEX_PROPOSAL_BEFORE)));
  assert.deepEqual(getCodexProposalInput(), input);
  for (const workType of ['feature', 'fix', 'chore', 'refactor'] as const) {
    const plan = createCodexProposalPlan(workType, configHash, context);
    assert.doesNotThrow(() => assertCodexProposalPlan(plan));
    assert.equal(plan.expiresAt, '2026-11-13T00:00:00.000Z');
    for (const [key, value] of Object.entries({ ownerId: 'os-user:987654321', workType: 'changed', configHash: 'b'.repeat(64),
      inputHash: 'b'.repeat(64), createdAt: '2026-11-12T00:00:00.001Z', expiresAt: '2026-11-13T00:00:00.001Z' })) {
      assert.notEqual(hashCodexProposalPlan({ ...plan, [key]: value }), plan.planHash);
      assert.throws(() => assertCodexProposalPlan({ ...plan, [key]: value }));
    }
    assert.throws(() => assertCodexProposalPlan({ ...plan, extra: true } as CodexProposalPlan));
    assert.throws(() => assertCodexProposalPlan({ ...plan, policy: 'local-synthetic-branch-v1' } as unknown as CodexProposalPlan));
  }
});

test('proposal output accepts only two JSON string fields and records the exact raw response hash', () => {
  const content = "export const message = 'approved';\n";
  for (const raw of [JSON.stringify({ path: 'src/message.mjs', content }), `\n{ "content": ${JSON.stringify(content)}, "path": "src/message.mjs" }\n`]) {
    assert.deepEqual(parseCodexProposalResponse(raw), { path: 'src/message.mjs', content, responseHash: hashCodexProposalValue(raw) });
  }
  const boundary = JSON.stringify({ path: 'src/message.mjs', content: 'a'.repeat(8192) });
  assert.equal(parseCodexProposalResponse(boundary).content.length, 8192);
});

test('malformed, duplicate, additional, secret, oversized, unchanged and unsafe outputs expose only static errors', () => {
  const content = "export const message = 'approved';\n";
  const invalid = ['not-json-private-body', 'null', '[]', '"text"', '{}', '```json\n{}\n```',
    JSON.stringify({ path: '../outside', content }), JSON.stringify({ path: 'src/message.mjs', content, command: 'private-command' }),
    JSON.stringify({ path: 'src/message.mjs', content: 10 }), JSON.stringify({ path: 'src/message.mjs', content: '' }),
    JSON.stringify({ path: 'src/message.mjs', content: CODEX_PROPOSAL_BEFORE }),
    JSON.stringify({ path: 'src/message.mjs', content: 'a\0b' }),
    JSON.stringify({ path: 'src/message.mjs', content: '\ud800' }),
    JSON.stringify({ path: 'src/message.mjs', content: 'export const token = "synthetic-private-token";' }),
    JSON.stringify({ path: 'src/message.mjs', content: 'a'.repeat(8193) }),
    '{"path":"src/message.mjs","path":"src/message.mjs","content":"changed"}',
    ' '.repeat(16 * 1024 + 1)];
  for (const raw of invalid) assert.throws(() => parseCodexProposalResponse(raw), (error: unknown) => {
    assert.match(String(error), /^HarnessError: CODEX_PROPOSAL_(INVALID_RESPONSE|OUTPUT_LIMIT)$/);
    return true;
  });
});
