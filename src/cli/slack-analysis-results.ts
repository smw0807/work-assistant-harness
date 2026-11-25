import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteSlackAnalysisStore } from '../adapters/sqlite-slack-analysis.js';
import { SqliteSlackAnalysisSource } from '../adapters/slack-analysis-source.js';
import { getSlackListIds } from '../domain/slack.js';
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
    const listIds = getSlackListIds(options.config);
    // 조회는 모델을 호출하지 않으므로 분석을 끈 뒤에도 허용 리스트의 기존 결과를 검토할 수 있다.
    const config = listIds.length ? { ...options.config, listAnalysisEnabled: true as const } : options.config;
    source = new SqliteSlackAnalysisSource(join(options.dataDirectory, 'tasks.sqlite'), config);
    const records = store.list(now).filter(record => record.workspaceId === options.config.workspaceId
      && (options.config.channelIds.includes(record.channelId) || listIds.includes(record.channelId))
      && (options.command === 'slack-list' || record.channelId === options.channelId && record.messageTs === options.messageTs));
    const results = records.flatMap(record => {
      const listSource = listIds.includes(record.channelId);
      const current = listSource || record.status === 'REPORTED'
        ? source!.find(record.workspaceId, record.channelId, record.messageTs, now) : null;
      if (listSource && !current) return [];
      if (record.status === 'REPORTED') {
        let valid = false;
        try { valid = current !== null && hashSlackAnalysisSource(current.request, config) === record.sourceHash; }
        catch { /* Edited, expired, or incomplete source invalidates a stored draft. */ }
        if (!valid) record = store.invalidate(record.runId, now);
      }
      return [{ ...record, ...(listSource ? { listId: record.channelId, itemId: current?.request.listItemId, commentId: record.messageTs } : {}),
        report: options.command === 'slack-inspect' ? record.report : undefined }];
    });
    const result = JSON.parse(output) as Record<string, unknown>;
    return `${JSON.stringify({ ...result, analysis: { scope: 'mention-and-thread', results,
      semanticAccuracyVerified: false, messageDelivery: 'not_run', repositoryAccess: 'not_run' } }, null, 2)}\n`;
  } finally { source?.close(); store.close(); }
};
