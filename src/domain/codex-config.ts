export interface CodexConfig {
  enabled: boolean;
  policyVersion: 'codex-cli-proposal-v1';
  codexPath: string;
  codexSha256: string;
  model: string;
  authMode: 'api-key' | 'chatgpt';
  timeoutMs: 60000;
  maxResponseBytes: 16384;
}
