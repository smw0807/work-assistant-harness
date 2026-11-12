import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { collectReadonlyPayload } from '../src/adapters/readonly-repository.js';
import { SqliteCodexProposalStore } from '../src/adapters/sqlite-codex-proposal-store.js';
import { SqliteReadonlyInvestigationStore } from '../src/adapters/sqlite-readonly-investigation-store.js';
import { SqliteReadonlyTransportStore } from '../src/adapters/sqlite-readonly-transport-store.js';
import { ReadonlyTransportService } from '../src/application/investigate-transport.js';
import { assertChangePlan } from '../src/domain/approval.js';
import type { ChangePlan } from '../src/domain/types.js';
import type { CodexProposalPlan } from '../src/domain/codex-proposal.js';
import type { ReadonlyPlan } from '../src/domain/readonly-investigation.js';
import type { ReadonlyTransportPlan } from '../src/domain/readonly-transport.js';
import { assertCodexProposalPlan, createCodexProposalPlan, getCodexProposalInput } from '../src/policy/codex-proposal-policy.js';
import { assertReadonlyPlan, createReadonlyPlan, defaultReadonlySelection } from '../src/policy/readonly-investigation-policy.js';
import { assertReadonlyTransportPlan, buildReadonlyTransportFakeResponse } from '../src/policy/readonly-transport-policy.js';

test('120/124 same owner and UUID never let mock or proposal approvals authorize offline transport', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-transport-isolation-')));
  chmodSync(directory, 0o700);
  const proposalStore = new SqliteCodexProposalStore(join(directory, 'codex-proposals.sqlite'));
  const mockStore = new SqliteReadonlyInvestigationStore(join(directory, 'readonly-investigations.sqlite'));
  const store = new SqliteReadonlyTransportStore(join(directory, 'readonly-transports.sqlite'));
  t.after(() => {
    store.close(); mockStore.close(); proposalStore.close();
    const unlock = (path: string): void => {
      if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); }
    };
    unlock(directory); rmSync(directory, { recursive: true, force: true });
  });
  const current = () => ({ ownerId: `os-user:${process.getuid!()}`, now: new Date() });
  let calls = 0;
  const service = new ReadonlyTransportService(store, { mode: 'offline', transport: 'fake', transmit: async (body) => {
    calls++; return buildReadonlyTransportFakeResponse(body);
  } }, directory);
  const before = getCodexProposalInput();
  const planned = await service.plan('flow', undefined, current(), 'controller');
  const plan = planned.task.plan;
  const creation = { ...current(), now: new Date(plan.createdAt) };
  const mockPayload = await collectReadonlyPayload(planned.payload!.repository, defaultReadonlySelection(), creation);
  const mockPlan = createReadonlyPlan(mockPayload, creation);
  mockStore.create(mockPlan, mockPayload, current());
  mockStore.approve({ investigationId: plan.id, planHash: mockPlan.planHash, expiresInMinutes: 10 }, current());
  const proposal = createCodexProposalPlan('fix', 'a'.repeat(64), current(), plan.id);
  proposalStore.create(proposal, current());
  proposalStore.approve({ proposalId: plan.id, planHash: proposal.planHash, expiresInMinutes: 10 }, current());
  const request = { investigationId: plan.id, planHash: plan.planHash };
  await assert.rejects(service.run(request, current()), { code: 'READONLY_TRANSPORT_APPROVAL_REQUIRED' });
  assert.equal(calls, 0); assert.equal(store.inspect(plan.id, current()).attempt, null);
  for (const planHash of [mockPlan.planHash, proposal.planHash]) {
    assert.throws(() => service.approve({ ...request, planHash, expiresInMinutes: 10 }, current()));
  }
  service.approve({ ...request, expiresInMinutes: 10 }, current());
  const result = await service.run(request, current());
  assert.equal(result.task.status, 'REPORTED'); assert.equal(calls, 1);
  assert.equal(result.report!.mode, 'offline'); assert.equal(result.report!.transport, 'fake');
  assert.equal(result.report!.responseOrigin, 'synthetic');
  assert.equal(result.report!.requestBodyHash, planned.payload!.requestBodyHash);
  for (const previous of [mockStore.inspect(plan.id, current()), proposalStore.inspect(plan.id, current())]) {
    assert.equal(previous.task.status, 'APPROVED'); assert.equal(previous.attempt, null);
    assert.equal(previous.approvals[0]!.usedAt, null);
  }
  assert.deepEqual(getCodexProposalInput(), before);
  assert.throws(() => assertReadonlyPlan(plan as unknown as ReadonlyPlan));
  assert.throws(() => assertCodexProposalPlan(plan as unknown as CodexProposalPlan));
  assert.throws(() => assertChangePlan(plan as unknown as ChangePlan));
  assert.throws(() => assertReadonlyTransportPlan(mockPlan as unknown as ReadonlyTransportPlan));
  assert.throws(() => assertReadonlyTransportPlan(proposal as unknown as ReadonlyTransportPlan));
  assert.deepEqual(result.task.plan.writeAllowedFiles, []); assert.deepEqual(result.task.plan.testCommandIds, []);
});

test('119/131 offline application dependency graph cannot import live adapters or credential loaders', () => {
  const roots = ['src/cli/readonly-transport.ts', 'src/cli/readonly-transport-worker.ts'];
  const visited = new Set<string>();
  const visit = (path: string): void => {
    const fullPath = resolve(path);
    if (visited.has(fullPath)) return;
    visited.add(fullPath);
    assert.doesNotMatch(fullPath, /\/(?:codex-(?:cli|broker|credentials|isolation)|live-slack|slack-live-[^/]+)\.ts$/);
    const source = ts.createSourceFile(fullPath, readFileSync(fullPath, 'utf8'), ts.ScriptTarget.Latest, true);
    const check = (node: ts.Node): void => {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        visit(resolve(dirname(fullPath), specifier.text.replace(/\.js$/, '.ts')));
      }
      ts.forEachChild(node, check);
    };
    check(source);
  };
  roots.forEach(visit);
  assert.ok([...visited].some((path) => path.endsWith('/readonly-fake-transport.ts')));
  assert.ok([...visited].some((path) => path.endsWith('/readonly-transport-broker.ts')));
});
