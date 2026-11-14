import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import type { CodexConfig } from '../domain/codex-config.js';
import { READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS, type ReadonlyRelayConfig, type ReadonlyRelayDispatch } from '../domain/readonly-relay.js';
import type { ReadonlyRelayPort, ReadonlyRelayTransmissionResult } from '../ports/readonly-relay.js';
import { assertReadonlyRelayDispatch, parseReadonlyRelayConfig } from '../policy/readonly-relay-policy.js';
import { parseReadonlyRelayCodexOutput } from '../policy/readonly-relay-protocol.js';
import { READONLY_OUTPUT_SCHEMA } from '../policy/readonly-investigation-policy.js';
import { codexProposalArguments } from './codex-cli-contract.js';
import { loadCodexCredential } from './codex-credentials.js';
import { probeCodexIsolation, runSandboxedCodex, verifyCodexBinary } from './codex-isolation.js';
import { createReadonlyRelayLifecycle, readonlyRelayCleanupConfirmed, readonlyRelayScratchIdentity, removeReadonlyRelayScratch, type ReadonlyRelayScratchIdentity } from './readonly-relay-lifecycle.js';
import { runReadonlyRelayProcess } from './readonly-relay-runner.js';
import { sendReadonlyRelayRequest, startReadonlyRelayBroker, type ReadonlyRelayBroker, type ReadonlyRelayCredential, type ReadonlyRelayTransport } from './readonly-relay-broker.js';

interface SyntheticConnection { credential: ReadonlyRelayCredential; transport: ReadonlyRelayTransport }
const fail = (suffix: string): never => { throw new HarnessError(`READONLY_RELAY_${suffix}`); };

/** Only the relay gets the longer idle wait: it first buffers bounded upstream EOF. */
export const readonlyRelayCodexArguments = (config: CodexConfig, workspace: string, port: number): string[] =>
  codexProposalArguments(config, workspace, port).map((argument) => argument === 'model_providers.harness.stream_idle_timeout_ms=30000'
    ? 'model_providers.harness.stream_idle_timeout_ms=55000' : argument);

/** Parent-only login, one approved request, bounded opaque response, and a separate native-output contract. */
export class RestrictedReadonlyRelayCodex implements ReadonlyRelayPort {
  readonly mode = 'live' as const;
  readonly transport = 'codex-cli-relay' as const;
  constructor(private readonly config: ReadonlyRelayConfig, private readonly dataDirectory: string,
    private readonly investigationId: string, private readonly synthetic?: SyntheticConnection) {}

  async verifyReady(): Promise<void> {
    const config = parseReadonlyRelayConfig(this.config);
    if (!config.enabled) fail('DISABLED');
    try { await verifyCodexBinary({ ...config, policyVersion: 'codex-cli-proposal-v1' }); }
    catch (error) {
      if (error instanceof HarnessError) throw error;
      fail('BINARY_UNAVAILABLE');
    }
  }

  async transmit(dispatch: ReadonlyRelayDispatch, signal: AbortSignal, beforeTransmission: () => void,
    beforeCredentialAccess: () => void): Promise<ReadonlyRelayTransmissionResult> {
    const config = parseReadonlyRelayConfig(this.config);
    if (!config.enabled) fail('DISABLED');
    assertReadonlyRelayDispatch(dispatch, config);
    if (signal.aborted) fail('CANCELLED');
    if (typeof beforeTransmission !== 'function' || typeof beforeCredentialAccess !== 'function') fail('INVALID_TRANSPORT');
    if (this.synthetic !== undefined && (!this.synthetic || typeof this.synthetic.transport !== 'function'
      || !this.synthetic.credential || this.synthetic.credential.kind !== 'chatgpt')) fail('INVALID_TRANSPORT');
    const legacyConfig: CodexConfig = { ...config, policyVersion: 'codex-cli-proposal-v1' };
    const location = { dataDirectory: this.dataDirectory, investigationId: this.investigationId };
    const lifecycle = createReadonlyRelayLifecycle(location, { requestBodyHash: dispatch.requestBodyHash,
      requestEnvelopeHash: dispatch.requestEnvelopeHash, connectionProfileHash: dispatch.requestEnvelope.connectionProfileHash });
    const workspace = join(lifecycle.directory, 'sandbox'); const home = join(workspace, 'home');
    const started = performance.now(); const deadline = started + 55_000; const totalDeadline = started + 60_000;
    const controller = new AbortController();
    let cleanupDeadline: number | null = null; let timedOut = false; let uncertain = false;
    let notifyAbort: () => void = () => {};
    const aborted = new Promise<null>((resolve) => { notifyAbort = () => resolve(null); });
    const abort = (): void => {
      cleanupDeadline ??= Math.min(totalDeadline, performance.now() + 5000);
      controller.abort(); notifyAbort();
    };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; abort(); }, Math.max(0, deadline - performance.now()));
    const connection: { broker: ReadonlyRelayBroker | null } = { broker: null };
    let scratch: ReadonlyRelayScratchIdentity | null = null;
    let isolation = false; let credentialAccess = false; let cleanupConfirmed = false; let phase = 'preflight';
    let failureCode: string | null = null; let finalTextHash: string | null = null;
    const remainingCleanup = (): number => {
      cleanupDeadline ??= Math.min(totalDeadline, performance.now() + 5000);
      return Math.max(0, cleanupDeadline - performance.now());
    };
    const waitUntil = async <T>(pending: Promise<T>, milliseconds: number): Promise<T> => {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        waitTimer = setTimeout(() => { uncertain = true; reject(new HarnessError('READONLY_RELAY_LIFECYCLE_UNSAFE')); }, milliseconds);
      })]); }
      finally { if (waitTimer) clearTimeout(waitTimer); }
    };
    const operation = async <T>(pending: Promise<T>): Promise<T> => {
      const settled = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
      const outcome = await Promise.race([settled, aborted]);
      if (outcome === null || controller.signal.aborted) {
        await waitUntil(settled, remainingCleanup());
        return fail(timedOut ? 'TIMEOUT' : 'CANCELLED');
      }
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    };
    try {
      await operation(verifyCodexBinary(legacyConfig));
      await operation(mkdir(workspace, { mode: 0o700 }).then(() => { scratch = readonlyRelayScratchIdentity(location); }));
      await operation(mkdir(home, { mode: 0o700 }));
      await operation(writeFile(join(workspace, 'schema.json'), JSON.stringify(READONLY_OUTPUT_SCHEMA), { flag: 'wx', mode: 0o400 }));
      await operation(startReadonlyRelayBroker(config, dispatch, async () => {
        if (this.synthetic) return { ...this.synthetic.credential };
        const credential = await loadCodexCredential(legacyConfig);
        if (credential.kind !== 'chatgpt') fail('INVALID_CREDENTIAL');
        credentialAccess = true;
        return credential as ReadonlyRelayCredential;
      }, controller.signal, this.synthetic?.transport ?? sendReadonlyRelayRequest, () => {
        if (!isolation || controller.signal.aborted || performance.now() >= deadline) fail('TIMEOUT');
        beforeTransmission();
      }, () => {
        if (!isolation || controller.signal.aborted || performance.now() >= deadline) fail('TIMEOUT');
        beforeCredentialAccess();
      }).then((startedBroker) => { connection.broker = startedBroker; return startedBroker; }));
      const activeBroker = connection.broker;
      if (!activeBroker) return fail('BROKER_FAILED');
      await operation(probeCodexIsolation(lifecycle.directory, workspace, activeBroker.port, controller.signal));
      const environment = { HOME: home, CODEX_HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC',
        HARNESS_CODEX_CAPABILITY: activeBroker.capability };
      const foundVersion = await operation(runSandboxedCodex(config.codexPath, ['--version'], workspace, activeBroker.port, environment, '', controller.signal, 4096));
      if (foundVersion.trim() !== 'codex-cli 0.154.0') fail('BINARY_UNSUPPORTED');
      isolation = true; phase = 'request'; lifecycle.running();
      const output = await operation(runReadonlyRelayProcess(config.codexPath, readonlyRelayCodexArguments(legacyConfig, workspace, activeBroker.port),
        workspace, activeBroker.port, environment, dispatch.requestEnvelope.body, controller.signal, location));
      const relayed = activeBroker.result();
      const brokerFailure = activeBroker.failure();
      if (brokerFailure) {
        if (brokerFailure === 'READONLY_RELAY_LIFECYCLE_UNSAFE') uncertain = true;
        throw new HarnessError(brokerFailure);
      }
      if (!relayed || activeBroker.calls() !== 1 || controller.signal.aborted || performance.now() >= deadline) return fail('CALL_FAILED');
      const text = parseReadonlyRelayCodexOutput(output, config.maxResponseBytes);
      activeBroker.verifyFinalText(text);
      finalTextHash = createHash('sha256').update(text).digest('hex');
      phase = 'completed';
      return { text, responseHash: relayed.responseHash, finalTextHash,
        verification: { transport: this.synthetic ? 'fake' : 'live', upstreamCalls: 1, isolation: 'passed',
          credentialAccess: credentialAccess ? 'passed' : 'not_run', responseValidation: 'codex-native-output-v1', relayCompleted: true,
          credentialReflection: 'passed' } };
    } catch (error) {
      if (connection.broker?.failure() === 'READONLY_RELAY_LIFECYCLE_UNSAFE') uncertain = true;
      failureCode = uncertain ? 'READONLY_RELAY_LIFECYCLE_UNSAFE'
        : error instanceof HarnessError && /^READONLY_RELAY_[A-Z0-9_]+$/u.test(error.code) ? error.code : 'READONLY_RELAY_CALL_FAILED';
      throw new HarnessError(failureCode);
    } finally {
      const broker = connection.broker;
      try {
        if (broker) await waitUntil(broker.close(), remainingCleanup());
        if (uncertain || remainingCleanup() <= 0) fail('LIFECYCLE_UNSAFE');
        if (scratch) removeReadonlyRelayScratch(location, scratch);
        lifecycle.closed();
        cleanupConfirmed = readonlyRelayCleanupConfirmed(this.dataDirectory, this.investigationId, {
          requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: dispatch.requestEnvelopeHash,
          connectionProfileHash: dispatch.requestEnvelope.connectionProfileHash });
        if (!cleanupConfirmed) fail('LIFECYCLE_UNSAFE');
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        await writeFile(join(lifecycle.directory, 'call-report.json'), JSON.stringify({ policy: 'synthetic-readonly-relay-v1',
          model: config.model, authMode: config.authMode, binaryHash: config.codexSha256, phase,
          requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: dispatch.requestEnvelopeHash,
          connectionProfileHash: dispatch.requestEnvelope.connectionProfileHash, responseValidation: 'codex-native-output-v1',
          unverifiedResponseChecks: READONLY_RELAY_UNVERIFIED_RESPONSE_CHECKS,
          isolation: isolation ? 'passed' : 'not_run', credentialAccess: credentialAccess ? 'passed' : 'not_run',
          transport: this.synthetic ? 'fake' : 'live', upstreamCalls: broker?.calls() ?? 0, cleanupConfirmed,
          http: broker?.httpObservation() ?? null, relay: broker?.result() ?? null, finalTextHash,
          failureCode: cleanupConfirmed ? broker?.failure() ?? failureCode : 'READONLY_RELAY_LIFECYCLE_UNSAFE',
        }, null, 2), { flag: 'wx', mode: 0o600 });
      }
    }
  }
}
