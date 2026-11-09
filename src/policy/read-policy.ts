import { posix } from 'node:path';
import { HarnessError } from '../domain/errors.js';
import type { ReadRequest, RepositoryPolicy } from '../domain/types.js';
import { containsSensitiveText } from './redaction.js';

const maximumFileBytes = 256 * 1024;
const maximumEvidenceBytes = 64 * 1024;
const maximumRequestedLines = 200;

export const isRepositoryPath = (path: string): boolean => {
  return path.length > 0
    && !/[\\:]/u.test(path)
    && !Array.from(path).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && !posix.isAbsolute(path)
    && posix.normalize(path) === path
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
};

export const validateRepositoryPolicy = (policy: RepositoryPolicy): void => {
  if (!policy.repoId || !/^[a-f0-9]{40}$/u.test(policy.baseCommit)
    || !Array.isArray(policy.allowedPaths) || policy.allowedPaths.length === 0
    || policy.allowedPaths.some((path) => !isRepositoryPath(path))
    || !Number.isSafeInteger(policy.maxFileBytes) || policy.maxFileBytes < 1
    || policy.maxFileBytes > maximumFileBytes
    || !Number.isSafeInteger(policy.maxEvidenceBytes) || policy.maxEvidenceBytes < 1
    || policy.maxEvidenceBytes > maximumEvidenceBytes) {
    throw new HarnessError('INVALID_REPOSITORY_POLICY');
  }
};

const isSecretPath = (path: string): boolean => {
  return path.split('/').some((part) => {
    return ['.git', '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.npmrc', '.netrc', '.pypirc', '.git-credentials'].includes(part.toLowerCase())
      || /^\.env(?:\.|$)/iu.test(part)
      || /^(?:credentials?|secrets?)(?:\.|$)/iu.test(part)
      || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/iu.test(part)
      || /\.(?:pem|key|p8|p12|pfx|jks|keystore|kdbx)$/iu.test(part);
  });
};

export const validateReadRequest = (policy: RepositoryPolicy, request: ReadRequest): void => {
  if (request.repoId !== policy.repoId) {
    throw new HarnessError('REPOSITORY_NOT_ALLOWED');
  }
  if (!isRepositoryPath(request.path)) {
    throw new HarnessError('INVALID_REPOSITORY_PATH');
  }
  if (isSecretPath(request.path)) {
    throw new HarnessError('SECRET_FILE_BLOCKED');
  }
  if (!policy.allowedPaths.includes(request.path)) {
    throw new HarnessError('PATH_NOT_ALLOWED');
  }
  if (!Number.isSafeInteger(request.startLine) || !Number.isSafeInteger(request.endLine)
    || request.startLine < 1 || request.endLine < request.startLine
    || request.endLine - request.startLine + 1 > maximumRequestedLines) {
    throw new HarnessError('INVALID_LINE_RANGE');
  }
};

const containsCredential = (text: string): boolean => {
  return containsSensitiveText(text)
    || /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(text)
    || /\bxox[baprs]-[A-Za-z0-9-]+\b/u.test(text)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u.test(text)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(text)
    || /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/iu.test(text)
    || /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b["']?\s*[:=]\s*["']?[^\s"';,}]{8,}/iu.test(text);
};

export const inspectEvidenceText = (
  policy: RepositoryPolicy,
  request: ReadRequest,
  bytes: Uint8Array,
): string => {
  if (bytes.byteLength > policy.maxFileBytes) {
    throw new HarnessError('FILE_TOO_LARGE');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HarnessError('BINARY_FILE_BLOCKED');
  }
  if (Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
  })) {
    throw new HarnessError('BINARY_FILE_BLOCKED');
  }
  // 요청한 줄 밖에 있는 자격증명도 모델 입력으로 넘어가기 전에 파일 전체에서 거부한다.
  if (containsCredential(text)) {
    throw new HarnessError('SECRET_CONTENT_BLOCKED');
  }
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (request.endLine > lines.length) {
    throw new HarnessError('INVALID_LINE_RANGE');
  }
  const excerpt = lines.slice(request.startLine - 1, request.endLine).join('\n');
  if (Buffer.byteLength(excerpt, 'utf8') > policy.maxEvidenceBytes) {
    throw new HarnessError('EVIDENCE_TOO_LARGE');
  }
  return excerpt;
};
