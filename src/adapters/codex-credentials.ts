import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexConfig } from '../domain/codex-config.js';
import { HarnessError } from '../domain/errors.js';

export type CodexCredential = { kind: 'api-key'; apiKey: string }
  | { kind: 'chatgpt'; accessToken: string; accountId: string };

export const parseCodexCredential = (raw: string, now = Date.now()): CodexCredential => {
  try {
    if (Buffer.byteLength(raw) > 32768) throw new Error();
    const parsed = JSON.parse(raw) as { auth_mode?: unknown; tokens?: { access_token?: unknown; account_id?: unknown } };
    if (parsed.auth_mode !== 'chatgpt' || typeof parsed.tokens?.access_token !== 'string'
      || typeof parsed.tokens.account_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(parsed.tokens.account_id)) throw new Error();
    const token = parsed.tokens.access_token;
    if (token.length > 16384 || !/^[a-zA-Z0-9_.-]+$/.test(token)) throw new Error();
    // 여기서는 만료만 조기에 거부한다. 서명·계정의 유효성은 OpenAI 응답으로 확인한다.
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now + 60000) throw new Error();
    return { kind: 'chatgpt', accessToken: token, accountId: parsed.tokens.account_id };
  } catch { throw new HarnessError('CODEX_LOGIN_REQUIRED'); }
};

/** 사용자가 선택한 기존 로그인은 부모에서만 읽는다. refresh·복제·설정 변경은 하지 않는다. */
export const loadCodexCredential = async (config: CodexConfig): Promise<CodexCredential> => {
  if (config.authMode === 'api-key') {
    const apiKey = process.env.CODEX_PROPOSAL_API_KEY;
    if (!apiKey || apiKey.length > 16384 || /[\r\n\0]/.test(apiKey)) throw new HarnessError('API_KEY_REQUIRED');
    return { kind: 'api-key', apiKey };
  }
  try {
    const path = join(homedir(), '.codex', 'auth.json');
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o077) !== 0 || metadata.size > 32768 || await realpath(path) !== path) throw new Error();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (opened.ino !== metadata.ino || opened.dev !== metadata.dev || opened.size > 32768) throw new Error();
      const bytes = Buffer.alloc(32769);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 32768) throw new Error();
      return parseCodexCredential(bytes.subarray(0, bytesRead).toString('utf8'));
    } finally { await file.close(); }
  } catch { throw new HarnessError('CODEX_LOGIN_REQUIRED'); }
};
