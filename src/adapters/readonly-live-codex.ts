import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodexConfig } from '../domain/codex-config.js';
import type { ReadonlyLiveConfig, ReadonlyLiveDispatch } from '../domain/readonly-live.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyLivePort, ReadonlyLiveTransmissionResult } from '../ports/readonly-live.js';
import { assertReadonlyLiveDispatch, parseReadonlyLiveConfig } from '../policy/readonly-live-policy.js';
import { READONLY_OUTPUT_SCHEMA } from '../policy/readonly-investigation-policy.js';
import { codexProposalArguments, parseCodexEvents } from './codex-cli.js';
import { loadCodexCredential } from './codex-credentials.js';
import { probeCodexIsolation, runSandboxedCodex, verifyCodexBinary } from './codex-isolation.js';
import { sendReadonlyLiveRequest, startReadonlyLiveBroker, type ReadonlyLiveBroker, type ReadonlyLiveCredential, type ReadonlyLiveTransport } from './readonly-live-broker.js';
import { createReadonlyLiveLifecycle, readonlyLiveScratchIdentity, removeReadonlyLiveScratch, type ReadonlyLiveScratchIdentity } from './readonly-live-lifecycle.js';
import { runReadonlyLiveProcess } from './readonly-live-runner.js';

interface SyntheticConnection { credential: ReadonlyLiveCredential; transport: ReadonlyLiveTransport }
/** A test connection is an explicit pair; a missing fake never falls back to real authentication. */
export class RestrictedReadonlyLiveCodex implements ReadonlyLivePort {
  readonly mode = 'live' as const;
  readonly transport = 'codex-cli-broker' as const;
  constructor(private readonly config: ReadonlyLiveConfig, private readonly dataDirectory: string,
    private readonly investigationId: string, private readonly synthetic?: SyntheticConnection) {}

  async verifyReady(): Promise<void> {
    const config = parseReadonlyLiveConfig(this.config);
    if (!config.enabled) throw new HarnessError('READONLY_LIVE_DISABLED');
    try { await verifyCodexBinary({ ...config, policyVersion: 'codex-cli-proposal-v1' }); }
    catch (error) {
      if (error instanceof HarnessError) throw error;
      if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'EACCES'].includes(String(error.code))) {
        throw new HarnessError('READONLY_LIVE_BINARY_UNAVAILABLE');
      }
      throw new HarnessError('READONLY_LIVE_BINARY_CHECK_FAILED');
    }
  }

  async transmit(dispatch: ReadonlyLiveDispatch, signal: AbortSignal, beforeTransmission: () => void): Promise<ReadonlyLiveTransmissionResult> {
    const config = parseReadonlyLiveConfig(this.config);
    if (!config.enabled) throw new HarnessError('READONLY_LIVE_DISABLED');
    assertReadonlyLiveDispatch(dispatch, config);
    if (signal.aborted) throw new HarnessError('READONLY_LIVE_CANCELLED');
    if (this.synthetic !== undefined && (!this.synthetic || typeof this.synthetic.transport !== 'function'
      || !this.synthetic.credential || this.synthetic.credential.kind !== 'chatgpt')) throw new HarnessError('READONLY_LIVE_INVALID_TRANSPORT');
    const legacyConfig: CodexConfig = { ...config, policyVersion: 'codex-cli-proposal-v1' };
    const location = { dataDirectory: this.dataDirectory, investigationId: this.investigationId };
    const lifecycle = createReadonlyLiveLifecycle(location, { requestBodyHash: dispatch.requestBodyHash,
      requestEnvelopeHash: dispatch.requestEnvelopeHash, connectionProfileHash: dispatch.requestEnvelope.connectionProfileHash });
    const workspace = join(lifecycle.directory, 'sandbox'); const home = join(workspace, 'home');
    const controller = new AbortController(); const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    const deadline = performance.now() + 55_000;
    const timer = setTimeout(abort, 55_000);
    let broker: ReadonlyLiveBroker | null = null;
    let isolation = false; let credentialAccess = false; let failureCode: string | null = null;
    let phase = 'preflight'; let cleanupConfirmed = false;
    let scratch: ReadonlyLiveScratchIdentity | null = null;
    const schema = JSON.stringify(READONLY_OUTPUT_SCHEMA);
    try {
      await verifyCodexBinary(legacyConfig);
      await mkdir(workspace, { mode: 0o700 }); scratch = readonlyLiveScratchIdentity(location);
      await mkdir(home, { mode: 0o700 });
      await writeFile(join(workspace, 'schema.json'), schema, { flag: 'wx', mode: 0o400 });
      broker = await startReadonlyLiveBroker(config, dispatch, async () => {
        if (this.synthetic) return this.synthetic.credential;
        const credential = await loadCodexCredential(legacyConfig);
        if (credential.kind !== 'chatgpt') throw new HarnessError('READONLY_LIVE_INVALID_CREDENTIAL');
        credentialAccess = true;
        return credential;
      }, controller.signal, this.synthetic?.transport ?? sendReadonlyLiveRequest, () => {
        if (!isolation || controller.signal.aborted || performance.now() >= deadline) throw new HarnessError('READONLY_LIVE_TIMEOUT');
        beforeTransmission();
      });
      await probeCodexIsolation(lifecycle.directory, workspace, broker.port, controller.signal);
      const environment = { HOME: home, CODEX_HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC',
        HARNESS_CODEX_CAPABILITY: broker.capability };
      const version = await runSandboxedCodex(config.codexPath, ['--version'], workspace, broker.port, environment, '', controller.signal, 4096);
      if (version.trim() !== 'codex-cli 0.154.0') throw new HarnessError('CODEX_VERSION_UNSUPPORTED');
      isolation = true; phase = 'request'; lifecycle.running();
      // The child sees the same approved body, but cannot select what the trusted broker sends.
      const output = await runReadonlyLiveProcess(config.codexPath, codexProposalArguments(legacyConfig, workspace, broker.port),
        workspace, broker.port, environment, dispatch.requestEnvelope.body, controller.signal, location);
      const decoded = broker.result();
      if (!decoded || broker.calls() !== 1 || broker.failure() || controller.signal.aborted || performance.now() >= deadline) {
        throw new HarnessError('READONLY_LIVE_CALL_FAILED');
      }
      const result = parseCodexEvents(output, config.maxResponseBytes, config.model);
      if (result !== decoded.text) throw new HarnessError('READONLY_LIVE_INVALID_RESPONSE');
      phase = 'completed';
      return { ...decoded, verification: { transport: this.synthetic ? 'fake' : 'live', upstreamCalls: 1,
        isolation: 'passed', credentialAccess: credentialAccess ? 'passed' : 'not_run' } };
    } catch (error) {
      failureCode = error instanceof HarnessError ? error.code : 'READONLY_LIVE_CALL_FAILED';
      throw new HarnessError(failureCode);
    } finally {
      try {
        await broker?.close();
        if (scratch) removeReadonlyLiveScratch(location, scratch);
        lifecycle.closed(); cleanupConfirmed = true;
      }
      finally {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        await writeFile(join(lifecycle.directory, 'call-report.json'), JSON.stringify({ policy: 'synthetic-readonly-live-v1',
          model: config.model, authMode: config.authMode, binaryHash: config.codexSha256, phase,
          requestBodyHash: dispatch.requestBodyHash, requestEnvelopeHash: dispatch.requestEnvelopeHash,
          connectionProfileHash: dispatch.requestEnvelope.connectionProfileHash,
          isolation: isolation ? 'passed' : 'not_run', credentialAccess: credentialAccess ? 'passed' : 'not_run',
          transport: this.synthetic ? 'fake' : 'live', upstreamCalls: broker?.calls() ?? 0, cleanupConfirmed,
          http: broker?.httpObservation() ?? null,
          json: broker?.jsonDiagnostic() ?? null,
          sensitive: broker?.sensitiveDiagnostic() ?? null,
          sensitiveAttribution: broker?.sensitiveAttribution() ?? null,
          sensitiveMatches: broker?.sensitiveMatches() ?? null,
          sse: broker?.sseDiagnostic() ?? null,
          sseEnvelope: broker?.sseEnvelopeDiagnostic() ?? null,
          response: broker?.responseDiagnostic() ?? null,
          metadata: broker?.metadataDiagnostic() ?? null,
          failureCode: broker?.failure() ?? failureCode,
        }, null, 2), { flag: 'wx', mode: 0o600 });
      }
    }
  }
}
