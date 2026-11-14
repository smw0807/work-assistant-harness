import { join } from 'node:path';
import type { CodexConfig } from '../domain/codex-config.js';
import { HarnessError } from '../domain/errors.js';

export const codexProposalArguments = (config: CodexConfig, workspace: string, port: number): string[] => {
  const settings: Record<string, string | number | boolean> = {
    model_provider: 'harness', 'model_providers.harness.name': 'Harness proposal broker',
    'model_providers.harness.base_url': `http://127.0.0.1:${port}/v1`,
    'model_providers.harness.env_key': 'HARNESS_CODEX_CAPABILITY',
    'model_providers.harness.wire_api': 'responses', 'model_providers.harness.requires_openai_auth': false,
    'model_providers.harness.supports_websockets': false,
    'model_providers.harness.request_max_retries': 0, 'model_providers.harness.stream_max_retries': 0,
    'model_providers.harness.stream_idle_timeout_ms': 30000,
    cli_auth_credentials_store: 'ephemeral', web_search: 'disabled',
    'shell_environment_policy.inherit': 'none', 'features.enable_request_compression': false,
  };
  const disabled = ['shell_tool', 'shell_snapshot', 'hooks', 'multi_agent', 'apps', 'view_image', 'plugins',
    'browser_use', 'browser_use_external', 'in_app_browser', 'image_generation', 'skill_search', 'workspace_dependencies',
    'unbounded_connection_retries', 'memories', 'remote_plugin'];
  return ['-a', 'never', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config',
    '--skip-git-repo-check', '--sandbox', 'read-only', '--model', config.model,
    '--output-schema', join(workspace, 'schema.json'), '--json', '--color', 'never',
    ...disabled.flatMap((feature) => ['--disable', feature]),
    ...Object.entries(settings).flatMap(([name, value]) => ['-c', `${name}=${JSON.stringify(value)}`]), '-'];
};

export const parseCodexEvents = (output: string, maxResponseBytes: number, model?: string): string => {
  let result: string | null = null; let completed = 0;
  for (const line of output.split('\n').filter(Boolean)) {
    let event: { type?: string; item?: { type?: string; text?: unknown; message?: unknown } };
    try { event = JSON.parse(line) as typeof event; }
    catch { throw new HarnessError('INVALID_CODEX_EVENT'); }
    if (!event || !['thread.started', 'turn.started', 'turn.completed', 'item.started', 'item.completed'].includes(event.type ?? '')) {
      throw new HarnessError('CODEX_TURN_FAILED');
    }
    if (event.type === 'turn.completed') completed += 1;
    if (event.type?.startsWith('item.')) {
      // 비공개 model catalog를 복제하지 않는다. 이 고정된 metadata 경고만 최종 성공과 함께 허용한다.
      if (event.type === 'item.completed' && event.item?.type === 'error' && model
        && event.item.message === `Model metadata for \`${model}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`) continue;
      if (!event.item || !['agent_message', 'reasoning'].includes(event.item.type ?? '')) throw new HarnessError('CODEX_TOOL_CALL_REJECTED');
      if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        if (result !== null || typeof event.item.text !== 'string' || Buffer.byteLength(event.item.text) > maxResponseBytes) {
          throw new HarnessError('INVALID_CODEX_RESPONSE');
        }
        result = event.item.text;
      }
    }
  }
  if (completed !== 1 || result === null) throw new HarnessError('INCOMPLETE_CODEX_RESPONSE');
  return result;
};
