import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HarnessError } from '../domain/errors.js';
import { SqliteSlackInbox } from '../adapters/sqlite-slack-inbox.js';
import { SqliteSlackAnalysisSource } from '../adapters/slack-analysis-source.js';
import { SqliteSlackAnalysisStore } from '../adapters/sqlite-slack-analysis.js';
import { RestrictedSlackAnalysisCodex } from '../adapters/slack-analysis-codex.js';
import { assertSlackAnalysisIdle, withSlackAnalysisNativeRun } from '../adapters/slack-analysis-active-run.js';
import type { SlackAnalysisModelPort } from '../domain/slack-analysis.js';
import { SlackAnalysisService } from '../application/analyze-slack.js';
import { parseSlackReceiverConfig } from '../policy/slack-ingestion.js';
import { parseSlackAnalysisRelayConfig } from '../policy/slack-analysis.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';
import { prepareDataDirectory } from './runtime.js';
import { readSlackPrivateFile } from './slack-environment.js';
import type { SlackWorkerOptions } from './slack.js';

const run = async (): Promise<void> => {
  process.umask(0o077);
  if (!process.send || !process.connected) throw new HarnessError('SLACK_ANALYSIS_CONTROLLER_REQUIRED');
  const options = JSON.parse(process.argv[2] ?? '{}') as SlackWorkerOptions;
  const config = parseSlackReceiverConfig(options.config);
  if (options.command !== 'slack-listen' || !config.liveReadEnabled || !options.analysisConfigPath) {
    throw new HarnessError('SLACK_ANALYSIS_DISABLED');
  }
  const controller = new AbortController(), stop = (): void => controller.abort();
  process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('disconnect', stop);
  let service: SlackAnalysisService | null = null;
  let source: SqliteSlackAnalysisSource | null = null;
  let store: SqliteSlackAnalysisStore | null = null;
  try {
    const directory = await prepareDataDirectory(options.dataDirectory, options.sourceRoot);
    const relay = parseSlackAnalysisRelayConfig(parseReadonlyTransportJson(await readSlackPrivateFile(options.analysisConfigPath), 16_384));
    if (!relay.enabled) throw new HarnessError('SLACK_ANALYSIS_DISABLED');
    const model = (id: string): SlackAnalysisModelPort => {
      const native = new RestrictedSlackAnalysisCodex(relay, directory, id);
      return { mode: 'live', transport: 'codex-cli-relay', verifyReady: () => native.verifyReady(),
        transmit: async (dispatch, signal, beforeTransmission, beforeCredentialAccess) => {
          try { return await withSlackAnalysisNativeRun(directory, id,
            () => native.transmit(dispatch, signal, beforeTransmission, beforeCredentialAccess)); }
          catch (error) {
            if (error instanceof HarnessError) throw error;
            throw new HarnessError('SLACK_ANALYSIS_NATIVE_REVIEW_REQUIRED');
          }
        } };
    };
    await new RestrictedSlackAnalysisCodex(relay, directory, randomUUID()).verifyReady();
    if (controller.signal.aborted) return;
    // Initialization uses the same schema; the analysis connection itself is strictly read-only.
    new SqliteSlackInbox(join(directory, 'tasks.sqlite'), config).close();
    source = new SqliteSlackAnalysisSource(join(directory, 'tasks.sqlite'), config);
    store = new SqliteSlackAnalysisStore(join(directory, 'slack-analysis.sqlite'));
    const startedAt = new Date();
    service = new SlackAnalysisService(source, store, config, relay, model, startedAt,
      notice => process.stdout.write(`${JSON.stringify(notice)}\n`));
    const recovered = service.recover();
    assertSlackAnalysisIdle(directory);
    process.stdout.write(`${JSON.stringify({ event: 'slack-analysis', status: 'ready', recovered,
      scope: 'mention-and-thread', maximumDailyAttempts: 20, concurrency: 1, retries: 0 })}\n`);
    process.send({ ready: true });
    while (!controller.signal.aborted) {
      service.tick();
      try { await delay(250, undefined, { signal: controller.signal }); }
      catch { if (!controller.signal.aborted) throw new HarnessError('SLACK_ANALYSIS_WAIT_FAILED'); }
    }
  } finally {
    try { await service?.close(); }
    finally {
      source?.close(); store?.close();
      process.off('SIGTERM', stop); process.off('SIGINT', stop); process.off('disconnect', stop);
      if (process.connected) process.disconnect?.();
    }
  }
};

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof HarnessError ? error.code : 'SLACK_ANALYSIS_FAILED'}\n`);
  process.exitCode = 1;
});
