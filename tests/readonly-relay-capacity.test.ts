import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { measureReadonlyRelayCapacityCase, READONLY_RELAY_CAPACITY_BUDGETS, runReadonlyRelayCapacityCase } from '../src/adapters/readonly-relay-capacity-probe.js';
import { createReadonlyRelayCapacityByteOverflow, createReadonlyRelayCapacityFixture, READONLY_RELAY_CAPACITY_CORPUS,
  READONLY_RELAY_CAPACITY_SYNTHETIC_CREDENTIAL } from '../src/policy/readonly-relay-capacity-fixtures.js';
import { collectReadonlyRelayResponse, READONLY_RELAY_RESPONSE_LIMITS } from '../src/policy/readonly-relay-protocol.js';

test('capacity probe dependency graph has no broker, credential loader, HTTP transport, CLI or store', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return; seen.add(path);
    assert.doesNotMatch(path, /\/(?:[^/]*broker|codex-credentials|[^/]*codex|sqlite-[^/]+|runtime)\.js$/u);
    assert.doesNotMatch(path, /\/cli\//u);
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /(?:node:https?|loadCodexCredential|fetch\s*\()/u);
    for (const match of source.matchAll(/import\s+(?!type\b)[^;]*?from\s+['"](\.[^'"]+)['"]/gu)) visit(resolve(dirname(path), match[1]!));
  };
  visit(join(root, 'src/adapters/readonly-relay-capacity-probe.js'));
});

test('registered normal corpora keep complete investigation JSON and bounded frames while large cases contain many actual delta events', () => {
  const sizes: number[] = [];
  for (const id of READONLY_RELAY_CAPACITY_CORPUS) {
    const fixture = createReadonlyRelayCapacityFixture(id); sizes.push(fixture.body.length);
    assert.equal(fixture.bodyBytes, fixture.body.length); assert.ok(fixture.finalBytes < 16384); assert.ok(fixture.largestFinalString <= 4096);
    assert.ok(fixture.frames <= 2048); assert.ok(fixture.maxFrameBytes <= 65536); assert.equal(fixture.expectedFailure, null);
    const events = fixture.body.toString().split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.split('\ndata: ')[1]!));
    assert.equal(events[0].type, 'response.created'); assert.equal(events.at(-1).type, 'response.completed');
    assert.equal(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join(''), fixture.finalText);
    assert.equal(events.at(-1).response.output[0].content[0].text, fixture.finalText);
    assert.equal(JSON.parse(fixture.finalText).classification, 'insufficient-evidence');
    assert.match(fixture.body.toString(), /\\ud55c\\uae00\\ud83d\\ude00/u);
    assert.ok(fixture.body.includes(Buffer.from('가나다😀')));
  }
  assert.ok(sizes[0]! < 262144); assert.ok(sizes[1]! > 262144 && sizes[1]! < 1048576);
  assert.ok(sizes[2]! > 1048576 && sizes[2]! < 2097152); assert.ok(sizes[3]! > 2097152 && sizes[3]! < 3145728);
  assert.ok(createReadonlyRelayCapacityFixture('stress-metadata').deltaEvents >= 1000);
});

test('exact total-cap-plus-one corpora exceed only their chosen response byte bound', async () => {
  for (const responseBytes of [262144, 1048576, 2097152, 4194304] as const) {
    const fixture = createReadonlyRelayCapacityByteOverflow(responseBytes);
    assert.equal(fixture.body.length, responseBytes + 1); assert.ok(fixture.frames <= 2048); assert.ok(fixture.maxFrameBytes <= 65536);
    const result = await measureReadonlyRelayCapacityCase({ fixtureId: 'response-plus-one', responseBytes, chunkProfile: '16k' });
    assert.equal(result.status, 'passed'); assert.equal(result.failureCode, 'READONLY_RELAY_RESPONSE_LIMIT'); assert.equal(result.returnedWireBytes, 0);
    assert.equal(result.diagnostic?.receivedBytes, responseBytes + 1); assert.equal(result.diagnostic?.bufferedBytes, responseBytes);
    assert.equal(result.diagnostic?.failedLimit, 'response-bytes');
  }
});

test('large synthetic metadata is accepted at 4MiB while the unchanged default 256KiB contract rejects it', async () => {
  const fixture = createReadonlyRelayCapacityFixture('stress-metadata');
  await assert.rejects(collectReadonlyRelayResponse(new Response(Buffer.from(fixture.body)), new AbortController().signal,
    READONLY_RELAY_CAPACITY_SYNTHETIC_CREDENTIAL), { code: 'READONLY_RELAY_RESPONSE_LIMIT' });
  assert.equal(READONLY_RELAY_RESPONSE_LIMITS.responseBytes, 262144);
  const result = await measureReadonlyRelayCapacityCase({ fixtureId: 'stress-metadata', responseBytes: 4194304, chunkProfile: '16k' });
  assert.equal(result.status, 'passed'); assert.equal(result.outcome, 'accepted'); assert.equal(result.returnedWireBytes, fixture.body.length);
  assert.equal(result.diagnostic?.eof, true); assert.equal(result.diagnostic?.bufferedBytes, fixture.body.length);
});

test('frame size, frame count, final-output size and credential reflection remain independent rejections at the largest candidate', async () => {
  for (const [fixtureId, code] of [['frame-overflow', 'FRAME_LIMIT'], ['frame-count-overflow', 'FRAME_LIMIT'],
    ['final-output-overflow', 'OUTPUT_LIMIT'], ['credential-reflection', 'CREDENTIAL_REFLECTION']] as const) {
    const result = await measureReadonlyRelayCapacityCase({ fixtureId, responseBytes: 4194304, chunkProfile: '7k' });
    assert.equal(result.status, 'passed'); assert.equal(result.failureCode, `READONLY_RELAY_${code}`);
    const output = JSON.stringify(result);
    for (const value of Object.values(READONLY_RELAY_CAPACITY_SYNTHETIC_CREDENTIAL)) assert.equal(output.includes(value), false);
  }
  const final = createReadonlyRelayCapacityFixture('final-output-overflow');
  assert.ok(final.finalBytes > 16384); assert.equal(final.largestFinalString, 4096); assert.ok(final.maxFrameBytes < 65536);
});

test('multibyte splits, 7KiB chunks, bounded slow pulls and immediate or empty-source cancellation preserve collector boundaries', async () => {
  for (const chunkProfile of ['utf8-split', '7k', 'slow', 'cancel-immediate', 'cancel-empty'] as const) {
    const result = await measureReadonlyRelayCapacityCase({ fixtureId: 'small-unicode', responseBytes: 1048576, chunkProfile });
    assert.equal(result.status, 'passed', chunkProfile);
    if (chunkProfile.startsWith('cancel')) {
      assert.equal(result.failureCode, 'READONLY_RELAY_CANCELLED'); assert.equal(result.sourceCancelled, 1); assert.equal(result.returnedWireBytes, 0);
      assert.ok(result.cancelLatencyMs !== null && result.cancelLatencyMs < 1000);
    } else assert.equal(result.outcome, 'accepted');
  }
});

test('a fixed fresh worker reports counts and resource observations without raw data or credentials', async () => {
  const result = await runReadonlyRelayCapacityCase({ fixtureId: 'small-unicode', responseBytes: 1048576, chunkProfile: '7k' });
  assert.equal(result.status, 'passed'); assert.equal(result.outcome, 'accepted');
  for (const value of [result.elapsedMs, result.cpuTotalMs, result.memory.processMaxRssBytes, result.memory.peakRssDeltaBytes]) assert.ok(Number.isFinite(value) && value >= 0);
  assert.equal(result.memory.delta.rss, result.memory.after.rss - result.memory.baseline.rss);
  assert.match(result.memoryInterpretation, /not exact peaks/u); assert.match(result.measurementScope, /fixture generation/u);
  assert.equal('body' in result, false); assert.equal('finalText' in result, false);
  assert.deepEqual(READONLY_RELAY_CAPACITY_BUDGETS, { normalElapsedMs: 5000, normalCpuMs: 4000, peakRssDeltaBytes: 100663296, fragmentationElapsedMs: 10000, cancelMs: 5000 });
  for (const credential of Object.values(READONLY_RELAY_CAPACITY_SYNTHETIC_CREDENTIAL)) assert.equal(JSON.stringify(result).includes(credential), false);
});

test('capacity probes accept no arbitrary fixture, cap, chunk strategy, executable or credential option', async () => {
  const valid = { fixtureId: 'small-unicode', responseBytes: 1048576, chunkProfile: '16k' };
  let reads = 0;
  for (const value of [{ ...valid, transport: () => {} }, { ...valid, credential: 'PRIVATE_CAPACITY_VALUE' }, { ...valid, executable: '/bin/sh' },
    { ...valid, responseBytes: 16777216 }, { ...valid, chunkProfile: 'unbounded' }, { ...valid, fixtureId: 'actual-response' },
    Object.defineProperty({ ...valid }, 'responseBytes', { get: () => { reads++; return 1048576; } }),
    Object.assign(Object.create({ inherited: true }), valid)]) {
    await assert.rejects(measureReadonlyRelayCapacityCase(value as Parameters<typeof measureReadonlyRelayCapacityCase>[0]));
  }
  assert.equal(reads, 0);
  await assert.rejects(runReadonlyRelayCapacityCase({ fixtureId: 'stress-metadata', responseBytes: 4194304, chunkProfile: 'single-byte' }));
});
