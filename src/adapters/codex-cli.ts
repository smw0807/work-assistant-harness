import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodexConfig } from '../domain/codex-config.js';
import { HarnessError } from '../domain/errors.js';
import type { CodexProposalPort } from '../ports/codex-proposal.js';
import { parseCodexConfig } from '../policy/codex-config.js';
import { getCodexProposalInput } from '../policy/codex-proposal-policy.js';
import { CODEX_RESPONSE_SCHEMA, startCodexBroker, type CodexBroker, type CodexTransport } from './codex-broker.js';
import { probeCodexIsolation, runSandboxedCodex, verifyCodexBinary } from './codex-isolation.js';
import type { CodexCredential } from './codex-credentials.js';
import { codexProposalArguments, parseCodexEvents } from './codex-cli-contract.js';

export { codexProposalArguments, parseCodexEvents } from './codex-cli-contract.js';

/** 실제 인증은 부모 broker만 보유하며 Codex에는 단건 broker capability만 전달한다. */
export class CodexCliProposal implements CodexProposalPort {
  constructor(private readonly config: CodexConfig, private readonly runDirectory: string,
    private readonly credential: string | CodexCredential, private readonly transport?: CodexTransport) {}

  async propose(input: string, signal?: AbortSignal): Promise<string> {
    const config = parseCodexConfig(this.config);
    if (!config.enabled) throw new HarnessError('CODEX_DISABLED');
    if (input !== getCodexProposalInput().inputText) throw new HarnessError('INVALID_CODEX_INPUT');
    if (signal?.aborted) throw new HarnessError('CODEX_CALL_ABORTED');
    const metadata = await lstat(this.runDirectory);
    if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== 0o700
      || await realpath(this.runDirectory) !== this.runDirectory) throw new HarnessError('UNSAFE_CODEX_DIRECTORY');
    const workspace = join(this.runDirectory, 'sandbox');
    const home = join(workspace, 'home');
    const schema = JSON.stringify(CODEX_RESPONSE_SCHEMA);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, config.timeoutMs);
    let broker: CodexBroker | null = null;
    let failureCode: string | null = null;
    let isolation = false;
    let phase = 'preflight';
    try {
      await verifyCodexBinary(config);
      await mkdir(workspace, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
      await writeFile(join(workspace, 'schema.json'), schema, { flag: 'wx', mode: 0o400 });
      broker = await startCodexBroker(config, input,
        typeof this.credential === 'string' ? { kind: 'api-key', apiKey: this.credential } : this.credential, controller.signal, this.transport);
      await probeCodexIsolation(this.runDirectory, workspace, broker.port, controller.signal);
      isolation = true;
      const environment = { HOME: home, CODEX_HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC',
        HARNESS_CODEX_CAPABILITY: broker.capability };
      const version = await runSandboxedCodex(config.codexPath, ['--version'], workspace, broker.port, environment,
        '', controller.signal, 4096);
      if (version.trim() !== 'codex-cli 0.154.0') throw new HarnessError('CODEX_VERSION_UNSUPPORTED');
      phase = 'request';
      const output = await runSandboxedCodex(config.codexPath, codexProposalArguments(config, workspace, broker.port),
        workspace, broker.port, environment, input, controller.signal, 128 * 1024);
      if (broker.calls() !== 1 || broker.failure() || controller.signal.aborted
        || await readFile(join(workspace, 'schema.json'), 'utf8') !== schema) throw new HarnessError('CODEX_CALL_FAILED');
      const result = parseCodexEvents(output, config.maxResponseBytes, config.model);
      phase = 'completed';
      return result;
    } catch (error) {
      failureCode = error instanceof HarnessError ? error.code : 'CODEX_CALL_FAILED';
      throw new HarnessError(failureCode);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      await broker?.close();
      await writeFile(join(this.runDirectory, 'call-report.json'), JSON.stringify({
        policyVersion: config.policyVersion, model: config.model, authMode: config.authMode, binaryHash: config.codexSha256,
        phase, isolation: isolation ? 'passed' : 'not_run', upstreamCalls: broker?.calls() ?? 0,
        failureCode: broker?.failure() ?? failureCode,
      }, null, 2), { flag: 'wx', mode: 0o600 });
    }
  }
}
