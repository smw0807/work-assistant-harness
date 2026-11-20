import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteSlackAnalysisStore } from '../adapters/sqlite-slack-analysis.js';
import { SqliteSlackAnalysisSource } from '../adapters/slack-analysis-source.js';
import { hashSlackAnalysisSource } from '../policy/slack-analysis.js';
import type { SlackWorkerOptions } from './slack.js';

/** Read existing local results without opening the model configuration or loading credentials. */
export const appendSlackAnalysisResults = (output: string, options: SlackWorkerOptions, now = new Date()): string => {
  if (!['slack-list', 'slack-inspect'].includes(options.command)) return output;
  const file = join(options.dataDirectory, 'slack-analysis.sqlite');
  if (!existsSync(file)) return output;
  const store = new SqliteSlackAnalysisStore(file);
  let source: SqliteSlackAnalysisSource | null = null;
  try {
    source = new SqliteSlackAnalysisSource(join(options.dataDirectory, 'tasks.sqlite'), options.config);
    const records = store.list(now).filter(record => record.workspaceId === options.config.workspaceId
      && options.config.channelIds.includes(record.channelId)
      && (options.command === 'slack-list' || record.channelId === options.channelId && record.messageTs === options.messageTs));
    const results = records.map(record => {
      if (record.status === 'REPORTED') {
        const current = source!.find(record.workspaceId, record.channelId, record.messageTs, now);
        let valid = false;
        try { valid = current !== null && hashSlackAnalysisSource(current.request, options.config) === record.sourceHash; }
        catch { /* Edited, expired, or incomplete source invalidates a stored draft. */ }
        if (!valid) record = store.invalidate(record.runId, now);
      }
      return options.command === 'slack-inspect' ? record : { ...record, report: undefined };
    });
    const result = JSON.parse(output) as Record<string, unknown>;
    return `${JSON.stringify({ ...result, analysis: { scope: 'mention-and-thread', results,
      semanticAccuracyVerified: false, messageDelivery: 'not_run', repositoryAccess: 'not_run' } }, null, 2)}\n`;
  } finally { source?.close(); store.close(); }
};
