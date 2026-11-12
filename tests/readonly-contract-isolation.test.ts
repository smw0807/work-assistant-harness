import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteCodexProposalStore } from '../src/adapters/sqlite-codex-proposal-store.js';
import { SqliteReadonlyInvestigationStore } from '../src/adapters/sqlite-readonly-investigation-store.js';
import { ReadonlyInvestigationService } from '../src/application/investigate-readonly.js';
import { assertChangePlan, hashChangePlan } from '../src/domain/approval.js';
import type { ChangePlan } from '../src/domain/types.js';
import type { CodexProposalPlan } from '../src/domain/codex-proposal.js';
import type { ReadonlyPlan } from '../src/domain/readonly-investigation.js';
import { assertCodexProposalPlan, createCodexProposalPlan, getCodexProposalInput } from '../src/policy/codex-proposal-policy.js';
import { assertReadonlyPlan, buildReadonlyMockResponse } from '../src/policy/readonly-investigation-policy.js';

test('110/114 existing proposal approval cannot authorize investigation even when UUID and owner coincide', async (context) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-readonly-isolation-')));
  chmodSync(directory, 0o700);
  const legacy = new SqliteCodexProposalStore(join(directory, 'codex-proposals.sqlite'));
  const store = new SqliteReadonlyInvestigationStore(join(directory, 'readonly-investigations.sqlite'));
  context.after(() => {
    store.close(); legacy.close();
    const unlock = (path: string): void => {
      if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); }
    };
    unlock(directory); rmSync(directory, { recursive: true, force: true });
  });
  let calls = 0;
  const service = new ReadonlyInvestigationService(store, { mode: 'mock', investigate: async (input) => {
    calls++; return buildReadonlyMockResponse(input);
  } }, directory);
  const current = () => ({ ownerId: `os-user:${process.getuid!()}`, now: new Date() });
  const originalFixedInput = getCodexProposalInput();
  const planned = await service.plan('flow', undefined, current());
  const plan = planned.task.plan;
  const proposal = createCodexProposalPlan('fix', 'a'.repeat(64), current(), plan.id);
  legacy.create(proposal, current());
  legacy.approve({ proposalId: plan.id, planHash: proposal.planHash, expiresInMinutes: 10 }, current());
  const request = { investigationId: plan.id, planHash: plan.planHash };
  await assert.rejects(service.run(request, current()), { code: 'READONLY_APPROVAL_REQUIRED' });
  assert.equal(calls, 0);
  assert.equal(store.inspect(plan.id, current()).attempt, null);
  assert.throws(() => service.approve({ ...request, planHash: proposal.planHash, expiresInMinutes: 10 }, current()));
  service.approve({ ...request, expiresInMinutes: 10 }, current());
  const result = await service.run(request, current());
  assert.equal(result.task.status, 'REPORTED'); assert.equal(calls, 1);
  const previous = legacy.inspect(plan.id, current());
  assert.equal(previous.task.status, 'APPROVED'); assert.equal(previous.attempt, null);
  assert.equal(previous.approvals[0]!.usedAt, null);
  assert.throws(() => legacy.consumeForExecution(plan.id, current()));
  assert.deepEqual(getCodexProposalInput(), originalFixedInput);
  assert.throws(() => assertReadonlyPlan(proposal as unknown as ReadonlyPlan));
  assert.throws(() => assertCodexProposalPlan(plan as unknown as CodexProposalPlan));
  assert.throws(() => assertChangePlan(plan as unknown as ChangePlan));
  const oldFields = { planId: plan.id, version: 1, requestRevision: '1700000000.000001', repoId: 'sample',
    baseCommit: 'a'.repeat(40), objective: 'synthetic investigation', allowedFiles: ['src/service.ts'],
    proposedChanges: ['Review the service.'], testCommandIds: [], risks: ['Synthetic only.'] };
  const oldPlan = { ...oldFields, planHash: hashChangePlan(oldFields) };
  assert.doesNotThrow(() => assertChangePlan(oldPlan));
  assert.throws(() => assertReadonlyPlan(oldPlan as unknown as ReadonlyPlan));
  assert.deepEqual(result.task.plan.writeAllowedFiles, []);
  assert.deepEqual(result.task.plan.testCommandIds, []);
  assert.equal(result.report!.executionAllowed, false);
});
