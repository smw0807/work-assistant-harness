import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HarnessError } from '../domain/errors.js';
import { assertReadonlyRelayCredentialText, collectReadonlyRelayResponse, parseReadonlyRelayCodexOutput } from '../policy/readonly-relay-protocol.js';
import type { ReadonlyRelayReceptionDiagnostic } from '../policy/readonly-relay-reception-diagnostics.js';
import { createReadonlyRelayCapacityByteOverflow, createReadonlyRelayCapacityFixture, READONLY_RELAY_CAPACITY_CANDIDATES,
  READONLY_RELAY_CAPACITY_CORPUS, READONLY_RELAY_CAPACITY_SYNTHETIC_CREDENTIAL,
  type ReadonlyRelayCapacityBytes, type ReadonlyRelayCapacityFixtureId } from '../policy/readonly-relay-capacity-fixtures.js';

export const READONLY_RELAY_CAPACITY_BUDGETS = Object.freeze({ normalElapsedMs: 5000, normalCpuMs: 4000,
  peakRssDeltaBytes: 96 * 1024 * 1024, fragmentationElapsedMs: 10_000, cancelMs: 5000 });
const profiles = ['16k', '7k', 'utf8-split', 'single-byte', 'giant', 'slow', 'cancel-immediate', 'cancel-empty'] as const;
type ChunkProfile = typeof profiles[number];
const fixtureIds: readonly string[] = [...READONLY_RELAY_CAPACITY_CORPUS, 'fragmentation-320k', 'frame-overflow', 'frame-count-overflow',
  'final-output-overflow', 'credential-reflection', 'response-plus-one'];
export interface ReadonlyRelayCapacityCase {
  fixtureId: ReadonlyRelayCapacityFixtureId | 'response-plus-one'; responseBytes: ReadonlyRelayCapacityBytes; chunkProfile: ChunkProfile;
}
interface Memory { rss: number; heapUsed: number; external: number; arrayBuffers: number }
export interface ReadonlyRelayCapacityResult {
  status: 'passed' | 'failed'; fixtureId: string; responseBytes: number; chunkProfile: ChunkProfile;
  outcome: 'accepted' | 'rejected'; expectedFailure: string | null; failureCode: string | null;
  bodyBytes: number; finalBytes: number; frames: number; deltaEvents: number; snapshotEvents: number; maxFrameBytes: number;
  returnedWireBytes: number; sourceCancelled: number; cancelLatencyMs: number | null; diagnostic: ReadonlyRelayReceptionDiagnostic | null;
  elapsedMs: number; cpuUserMs: number; cpuSystemMs: number; cpuTotalMs: number;
  memory: { baseline: Memory; after: Memory; delta: Memory; sampledPeakDelta: Memory; processMaxRssBytes: number; peakRssDeltaBytes: number };
  budgetPassed: boolean; measurementScope: string; memoryInterpretation: string;
}
const memory = (): Memory => {
  const value = process.memoryUsage(); return { rss: value.rss, heapUsed: value.heapUsed, external: value.external, arrayBuffers: value.arrayBuffers };
};
const validateCase = (value: unknown): ReadonlyRelayCapacityCase => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid capacity case');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !['fixtureId', 'responseBytes', 'chunkProfile'].every((key) => keys.includes(key))) throw new Error('Invalid capacity case');
  const fields = ['fixtureId', 'responseBytes', 'chunkProfile'].map((key) => Object.getOwnPropertyDescriptor(value, key));
  if (fields.some((field) => !field || !Object.hasOwn(field, 'value') || !field.enumerable)) throw new Error('Invalid capacity case');
  const [fixtureId, responseBytes, chunkProfile] = fields.map((field) => field!.value);
  if (!fixtureIds.includes(fixtureId) || ![262144, ...READONLY_RELAY_CAPACITY_CANDIDATES].includes(responseBytes)
    || !(profiles as readonly string[]).includes(chunkProfile)) throw new Error('Invalid capacity case');
  if (chunkProfile === 'single-byte' && fixtureId !== 'fragmentation-320k') throw new Error('Single-byte stress is limited to its registered 320KiB fixture');
  return { fixtureId, responseBytes, chunkProfile };
};
const cli = (text: string): string => [{ type: 'thread.started' }, { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed' }]
  .map((event) => JSON.stringify(event)).join('\n');

/** In-memory data only. The measured interval includes fixture generation and collector work, without forced GC. */
export const measureReadonlyRelayCapacityCase = async (input: ReadonlyRelayCapacityCase): Promise<ReadonlyRelayCapacityResult> => {
  const specification = validateCase(input); const baseline = memory(); const peak = { ...baseline };
  const cpu = process.cpuUsage(); const started = performance.now();
  const sample = (): void => {
    const current = memory(); for (const key of ['rss', 'heapUsed', 'external', 'arrayBuffers'] as const) peak[key] = Math.max(peak[key], current[key]);
  };
  const sampling = setInterval(sample, 10);
  const fixture = specification.fixtureId === 'response-plus-one' ? createReadonlyRelayCapacityByteOverflow(specification.responseBytes)
    : createReadonlyRelayCapacityFixture(specification.fixtureId);
  sample();
  const controller = new AbortController(); let abortedAt: number | null = null;
  const abort = (): void => { abortedAt ??= performance.now(); controller.abort(); };
  let offset = 0; let sourceChunks = 0; let sourceCancelled = 0; let cancelled = false;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined; let resume: (() => void) | undefined;
  const profile = specification.chunkProfile;
  const source = new ReadableStream<Uint8Array>({
    async pull(destination) {
      sourceChunks++;
      if (sourceChunks % 128 === 0) sample();
      if (profile === 'cancel-empty') {
        if (sourceChunks === 1) { destination.enqueue(new Uint8Array()); return; }
        await new Promise<void>((resolve) => { resume = resolve; }); return;
      }
      if (profile === 'cancel-immediate' && sourceChunks === 8) { abort(); return; }
      if (offset >= fixture.body.length) { destination.close(); return; }
      if (profile === 'slow') {
        await new Promise<void>((resolve) => { resume = resolve; pendingTimer = setTimeout(resolve, 1); });
        if (cancelled) return;
      }
      const size = profile === 'single-byte' ? 1 : profile === 'giant' ? fixture.body.length : profile === '7k' ? 7168
        : profile === 'utf8-split' ? [1, 2, 3, 7, 31, 8191][sourceChunks % 6]! : profile === 'slow' ? 1024 : profile === 'cancel-immediate' ? 64 : 16384;
      const end = Math.min(fixture.body.length, offset + size); destination.enqueue(fixture.body.subarray(offset, end)); offset = end;
    },
    cancel() { sourceCancelled++; cancelled = true; if (pendingTimer) clearTimeout(pendingTimer); resume?.(); },
  });
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  if (profile === 'cancel-empty') cancellationTimer = setTimeout(abort, 10);
  let diagnostic: ReadonlyRelayReceptionDiagnostic | null = null; let failureCode: string | null = null; let returnedWireBytes = 0;
  try {
    const received = await collectReadonlyRelayResponse(new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }), controller.signal,
      READONLY_RELAY_CAPACITY_SYNTHETIC_CREDENTIAL, { responseBytes: specification.responseBytes, observeDiagnostic: (value) => { diagnostic = value; sample(); } });
    returnedWireBytes = received.body.length;
    const text = parseReadonlyRelayCodexOutput(cli(fixture.finalText)); assertReadonlyRelayCredentialText(text, READONLY_RELAY_CAPACITY_SYNTHETIC_CREDENTIAL);
    if (text !== fixture.finalText) throw new Error('Fixed capacity output mismatch');
  } catch (error) {
    failureCode = error instanceof HarnessError && /^READONLY_RELAY_[A-Z0-9_]+$/u.test(error.code) ? error.code : 'READONLY_RELAY_CAPACITY_PROBE_FAILED';
  } finally { clearInterval(sampling); if (cancellationTimer) clearTimeout(cancellationTimer); if (pendingTimer) clearTimeout(pendingTimer); }
  sample(); const after = memory(); const elapsedMs = performance.now() - started; const used = process.cpuUsage(cpu);
  const cpuUserMs = used.user / 1000; const cpuSystemMs = used.system / 1000;
  const cancelledCase = profile === 'cancel-immediate' || profile === 'cancel-empty';
  const expectedFailure = cancelledCase ? 'READONLY_RELAY_CANCELLED' : fixture.body.length > specification.responseBytes ? 'READONLY_RELAY_RESPONSE_LIMIT'
    : fixture.expectedFailure ? `READONLY_RELAY_${fixture.expectedFailure}` : null;
  const delta = Object.fromEntries((Object.keys(baseline) as (keyof Memory)[]).map((key) => [key, after[key] - baseline[key]])) as unknown as Memory;
  const sampledPeakDelta = Object.fromEntries((Object.keys(baseline) as (keyof Memory)[]).map((key) => [key, peak[key] - baseline[key]])) as unknown as Memory;
  // Node resourceUsage.maxRSS is process-wide KiB, including startup. It is not retained Buffer capacity.
  const processMaxRssBytes = process.resourceUsage().maxRSS * 1024; const peakRssDeltaBytes = Math.max(0, processMaxRssBytes - baseline.rss);
  const cancelLatencyMs = abortedAt === null ? null : performance.now() - abortedAt;
  const elapsedBudget = profile === 'single-byte' ? READONLY_RELAY_CAPACITY_BUDGETS.fragmentationElapsedMs : READONLY_RELAY_CAPACITY_BUDGETS.normalElapsedMs;
  const budgetPassed = elapsedMs <= elapsedBudget && cpuUserMs + cpuSystemMs <= (profile === 'single-byte' ? elapsedBudget : READONLY_RELAY_CAPACITY_BUDGETS.normalCpuMs)
    && peakRssDeltaBytes <= READONLY_RELAY_CAPACITY_BUDGETS.peakRssDeltaBytes
    && (!cancelledCase || (cancelLatencyMs !== null && cancelLatencyMs <= READONLY_RELAY_CAPACITY_BUDGETS.cancelMs));
  return { status: failureCode === expectedFailure ? 'passed' : 'failed', fixtureId: fixture.id, responseBytes: specification.responseBytes, chunkProfile: profile,
    outcome: failureCode === null ? 'accepted' : 'rejected', expectedFailure, failureCode, bodyBytes: fixture.body.length, finalBytes: fixture.finalBytes,
    frames: fixture.frames, deltaEvents: fixture.deltaEvents, snapshotEvents: fixture.snapshotEvents, maxFrameBytes: fixture.maxFrameBytes,
    returnedWireBytes, sourceCancelled, cancelLatencyMs, diagnostic, elapsedMs, cpuUserMs, cpuSystemMs, cpuTotalMs: cpuUserMs + cpuSystemMs,
    memory: { baseline, after, delta, sampledPeakDelta, processMaxRssBytes, peakRssDeltaBytes }, budgetPassed,
    measurementScope: 'fixture generation plus collector/final guard; elapsed and CPU exclude process startup; memory baseline is before fixture creation; no forced GC',
    memoryInterpretation: 'bufferedBytes counts stored wire bytes; OS maxRSS includes startup and all process memory; RSS delta subtracts baseline RSS; heap/external peaks are sampled, not exact peaks' };
};

/** Each measurement uses this exact local worker and a minimal environment, never an arbitrary executable or transport. */
export const runReadonlyRelayCapacityCase = async (input: ReadonlyRelayCapacityCase): Promise<ReadonlyRelayCapacityResult> => {
  const specification = validateCase(input);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-addons', fileURLToPath(import.meta.url), '--capacity-worker', JSON.stringify(specification)],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let size = 0; let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 15_000);
    child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 32768) { failed = true; child.kill('SIGKILL'); } else output += bytes.toString('utf8'); });
    child.stderr.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 32768) { failed = true; child.kill('SIGKILL'); } });
    child.once('error', () => { failed = true; });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) { reject(new Error('READONLY_RELAY_CAPACITY_WORKER_FAILED')); return; }
      try { resolve(JSON.parse(output) as ReadonlyRelayCapacityResult); } catch { reject(new Error('READONLY_RELAY_CAPACITY_WORKER_FAILED')); }
    });
  });
};

export const runReadonlyRelayCapacityMatrix = async () => {
  const measurements: ReadonlyRelayCapacityResult[] = [];
  for (const responseBytes of READONLY_RELAY_CAPACITY_CANDIDATES) for (const fixtureId of READONLY_RELAY_CAPACITY_CORPUS) {
    measurements.push(await runReadonlyRelayCapacityCase({ fixtureId, responseBytes, chunkProfile: '16k' }));
  }
  const supplemental: ReadonlyRelayCapacityResult[] = [];
  for (const [fixtureId, chunkProfile] of [['fragmentation-320k', 'single-byte'], ['small-unicode', '7k'], ['small-unicode', 'utf8-split'],
    ['small-unicode', 'slow'], ['stress-metadata', 'giant'], ['small-unicode', 'cancel-immediate'], ['small-unicode', 'cancel-empty'], ['credential-reflection', 'utf8-split']] as const) {
    supplemental.push(await runReadonlyRelayCapacityCase({ fixtureId, responseBytes: 4194304, chunkProfile }));
  }
  const candidates = READONLY_RELAY_CAPACITY_CANDIDATES.map((responseBytes) => {
    const cases = measurements.filter((value) => value.responseBytes === responseBytes);
    return { responseBytes, corpusAccepted: cases.every((value) => value.outcome === 'accepted' && value.status === 'passed'),
      budgetsPassed: cases.every((value) => value.budgetPassed), cases: cases.length };
  });
  const supplementaryPassed = supplemental.every((value) => value.status === 'passed' && value.budgetPassed);
  const recommendedResponseBytes = supplementaryPassed ? candidates.find((value) => value.corpusAccepted && value.budgetsPassed)?.responseBytes ?? null : null;
  return { version: 'offline-readonly-relay-capacity-v1', mode: 'offline-only', measurements, supplemental, candidates, supplementaryPassed,
    recommendedResponseBytes, budgets: READONLY_RELAY_CAPACITY_BUDGETS,
    selectionBasis: 'Smallest registered candidate accepting every defined synthetic corpus and local resource/cancellation observation budget; production selection remains a separate decision.',
    limitations: ['No real response was used or its size estimated.', 'Large metadata repetition is synthetic stress, not a representative workload claim.',
      'No authentication, broker, CLI, external network or actual model is used.', 'Observed worker resources are local measurements, not runtime memory or CPU enforcement.'] };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--capacity-worker') throw new Error('READONLY_RELAY_CAPACITY_WORKER_ARGUMENTS');
  void measureReadonlyRelayCapacityCase(validateCase(JSON.parse(process.argv[3]!))).then((value) => process.stdout.write(JSON.stringify(value)),
    () => { process.stderr.write('READONLY_RELAY_CAPACITY_WORKER_FAILED\n'); process.exitCode = 1; });
}
