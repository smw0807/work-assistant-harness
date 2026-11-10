const sensitivePatterns: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
  /\b[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|password|secret|token)[A-Za-z0-9_]*["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/gi,
];

/** Apply the same conservative patterns to model inputs and local output. */
export const redactSensitiveText = (text: string): string => {
  return sensitivePatterns.reduce((result, pattern) => result.replace(pattern, '[REDACTED]'), text);
};

export const containsSensitiveText = (text: string): boolean => {
  return sensitivePatterns.some((pattern) => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text));
};

/** Slack 수신함에는 연락처가 조사 문맥으로 불필요하므로 지원 패턴을 함께 제거한다. */
export const redactSlackText = (text: string): string => {
  return redactSensitiveText(text)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/(?<![\d.])(?:\+82[- .]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}(?!\d)/g, '[REDACTED_PHONE]');
};
