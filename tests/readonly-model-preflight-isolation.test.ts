import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { collectReadonlyPayload } from '../src/adapters/readonly-repository.js';
import { SqliteCodexProposalStore } from '../src/adapters/sqlite-codex-proposal-store.js';
import { SqliteReadonlyInvestigationStore } from '../src/adapters/sqlite-readonly-investigation-store.js';
import { SqliteReadonlyTransportStore } from '../src/adapters/sqlite-readonly-transport-store.js';
import { SqliteReadonlyModelPreflightStore } from '../src/adapters/sqlite-readonly-model-preflight-store.js';
import { ReadonlyModelPreflightService } from '../src/application/investigate-model-preflight.js';
import { assertChangePlan } from '../src/domain/approval.js';
import type { ChangePlan } from '../src/domain/types.js';
import type { CodexProposalPlan } from '../src/domain/codex-proposal.js';
import type { ReadonlyPlan } from '../src/domain/readonly-investigation.js';
import type { ReadonlyTransportPlan } from '../src/domain/readonly-transport.js';
import type { ReadonlyModelPreflightPlan } from '../src/domain/readonly-model-preflight.js';
import { assertCodexProposalPlan, createCodexProposalPlan, getCodexProposalInput } from '../src/policy/codex-proposal-policy.js';
import { assertReadonlyPlan, createReadonlyPlan, defaultReadonlySelection } from '../src/policy/readonly-investigation-policy.js';
import { assertReadonlyTransportPlan, createReadonlyTransportPayload, createReadonlyTransportPlan } from '../src/policy/readonly-transport-policy.js';
import { assertReadonlyModelPreflightPlan } from '../src/policy/readonly-model-preflight-policy.js';
import { buildReadonlyModelPreflightFakeHttpResponse, decodeReadonlyModelPreflightResponse } from '../src/policy/readonly-model-preflight-protocol.js';

test('135/140 same owner and UUID cannot reuse actual 4-C-4/5/6 approvals or mutate prior DBs', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'harness-preflight-isolation-'))); chmodSync(directory, 0o700);
  const priorFiles = ['codex-proposals.sqlite', 'readonly-investigations.sqlite', 'readonly-transports.sqlite'];
  const proposalStore = new SqliteCodexProposalStore(join(directory, priorFiles[0]!));
  const mockStore = new SqliteReadonlyInvestigationStore(join(directory, priorFiles[1]!));
  const transportStore = new SqliteReadonlyTransportStore(join(directory, priorFiles[2]!));
  const store = new SqliteReadonlyModelPreflightStore(join(directory, 'readonly-model-preflights.sqlite'));
  t.after(() => {
    store.close(); transportStore.close(); mockStore.close(); proposalStore.close();
    const unlock = (path: string): void => {
      if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)); }
    };
    unlock(directory); rmSync(directory, { recursive: true, force: true });
  });
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { fetchCalls++; throw new Error('UNEXPECTED_NETWORK'); });
  const current = () => ({ ownerId: `os-user:${process.getuid!()}`, now: new Date() });
  let calls = 0;
  const service = new ReadonlyModelPreflightService(store, { mode: 'offline', transport: 'in-memory-fake', transmit: async (request, signal) => {
    calls++;
    return decodeReadonlyModelPreflightResponse(buildReadonlyModelPreflightFakeHttpResponse(request.requestEnvelope.body), request.requestEnvelope.profileId, signal);
  } }, directory);
  const proposalInput = getCodexProposalInput();
  const planned = await service.plan('flow', undefined, current(), 'controller');
  const plan = planned.task.plan;
  const creation = { ...current(), now: new Date(plan.createdAt) };
  const mockPayload = await collectReadonlyPayload(planned.payload!.repository, defaultReadonlySelection(), creation);
  const mockPlan = createReadonlyPlan(mockPayload, creation);
  mockStore.create(mockPlan, mockPayload, current());
  mockStore.approve({ investigationId: plan.id, planHash: mockPlan.planHash, expiresInMinutes: 10 }, current());
  const transportPayload = createReadonlyTransportPayload(mockPayload);
  const transportPlan = createReadonlyTransportPlan(transportPayload, creation);
  transportStore.create(transportPlan, transportPayload, current());
  transportStore.approve({ investigationId: plan.id, planHash: transportPlan.planHash, expiresInMinutes: 10 }, current());
  const proposalPlan = createCodexProposalPlan('fix', 'a'.repeat(64), current(), plan.id);
  proposalStore.create(proposalPlan, current());
  proposalStore.approve({ proposalId: plan.id, planHash: proposalPlan.planHash, expiresInMinutes: 10 }, current());
  const inspectPrior = () => [mockStore.inspect(plan.id, current()), transportStore.inspect(plan.id, current()), proposalStore.inspect(plan.id, current())];
  const originalPrior = inspectPrior();
  const fileHashes = () => priorFiles.map((file) => createHash('sha256').update(readFileSync(join(directory, file))).digest('hex'));
  const originalHashes = fileHashes();
  const request = { investigationId: plan.id, planHash: plan.planHash };
  await assert.rejects(service.run(request, current()), { code: 'READONLY_MODEL_PREFLIGHT_APPROVAL_REQUIRED' });
  assert.equal(calls, 0); assert.equal(store.inspect(plan.id, current()).attempt, null);
  for (const previous of [mockPlan, transportPlan, proposalPlan]) {
    assert.throws(() => service.approve({ ...request, planHash: previous.planHash, expiresInMinutes: 10 }, current()));
    assert.throws(() => assertReadonlyModelPreflightPlan(previous as unknown as ReadonlyModelPreflightPlan));
  }
  assert.deepEqual(inspectPrior(), originalPrior); assert.deepEqual(fileHashes(), originalHashes);
  service.approve({ ...request, expiresInMinutes: 10 }, current());
  const result = await service.run(request, current());
  assert.equal(result.task.status, 'REPORTED'); assert.equal(calls, 1); assert.equal(fetchCalls, 0);
  assert.equal(result.report!.transport, 'in-memory-fake'); assert.equal(result.report!.liveReady, false);
  assert.equal(result.report!.requestEnvelopeHash, planned.payload!.requestEnvelopeHash);
  assert.equal(result.report!.connectionProfileHash, planned.payload!.connectionProfileHash);
  assert.deepEqual(inspectPrior(), originalPrior); assert.deepEqual(fileHashes(), originalHashes);
  for (const previous of inspectPrior()) {
    assert.equal(previous.task.status, 'APPROVED'); assert.equal(previous.attempt, null);
    assert.equal(previous.approvals[0]!.usedAt, null); assert.equal(previous.approvals[0]!.revokedAt, null);
  }
  assert.deepEqual(getCodexProposalInput(), proposalInput);
  assert.throws(() => assertReadonlyPlan(plan as unknown as ReadonlyPlan));
  assert.throws(() => assertReadonlyTransportPlan(plan as unknown as ReadonlyTransportPlan));
  assert.throws(() => assertCodexProposalPlan(plan as unknown as CodexProposalPlan));
  assert.throws(() => assertChangePlan(plan as unknown as ChangePlan));
  assert.deepEqual(result.task.plan.writeAllowedFiles, []); assert.deepEqual(result.task.plan.testCommandIds, []);
});

test('135/148 CLI and worker dependency graphs contain no live adapter, credential loader or network transport', () => {
  const roots = ['src/cli/readonly-model-preflight.ts', 'src/cli/readonly-model-preflight-worker.ts'];
  const visited = new Set<string>();
  const prohibitedModules = /^(?:node:)?(?:http|https|http2|net|tls|dns(?:\/promises)?|dgram)$/u;
  const visit = (path: string): void => {
    const fullPath = resolve(path); if (visited.has(fullPath)) return;
    visited.add(fullPath);
    assert.doesNotMatch(fullPath, /\/(?:codex-(?:cli|broker|credentials|isolation)|live-slack|slack-live-[^/]+)\.ts$/u);
    const source = ts.createSourceFile(fullPath, readFileSync(fullPath, 'utf8'), ts.ScriptTarget.Latest, true);
    const check = (node: ts.Node): void => {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
          specifier = node.arguments[0];
          assert.ok(specifier && ts.isStringLiteral(specifier), `Uninspectable dependency in ${fullPath}`);
        }
        const callable = node.expression;
        assert.ok(!(ts.isIdentifier(callable) && callable.text === 'fetch'), `fetch in ${fullPath}`);
        assert.ok(!(ts.isPropertyAccessExpression(callable) && callable.name.text === 'fetch'), `fetch property in ${fullPath}`);
        assert.ok(!(ts.isElementAccessExpression(callable) && ts.isStringLiteral(callable.argumentExpression)
          && callable.argumentExpression.text === 'fetch'), `fetch element in ${fullPath}`);
      }
      if (specifier && ts.isStringLiteral(specifier)) {
        assert.doesNotMatch(specifier.text, prohibitedModules);
        if (specifier.text.startsWith('.')) visit(resolve(dirname(fullPath), specifier.text.replace(/\.js$/, '.ts')));
      }
      ts.forEachChild(node, check);
    };
    check(source);
  };
  roots.forEach(visit);
  assert.ok([...visited].some((path) => path.endsWith('/readonly-model-preflight-fake-transport.ts')));
  assert.ok([...visited].some((path) => path.endsWith('/readonly-model-preflight-broker.ts')));
  assert.ok([...visited].some((path) => path.endsWith('/readonly-model-preflight-protocol.ts')));
});
