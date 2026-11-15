import { HarnessError } from '../domain/errors.js';
import { PERSONAL_COLLECTION_POLICY, PERSONAL_COLLECTION_REDACTOR, type PersonalCollectionProfile,
  type PersonalSourceView } from '../domain/personal-readonly-collection.js';
import type { ReadonlyEvidence, ReadonlyRange } from '../domain/readonly-investigation.js';
import { canonicalReadonlyJson, hashReadonlyValue } from './readonly-investigation-policy.js';
import { inspectEvidenceText, validateReadRequest } from './read-policy.js';
import { getSensitivePatternDefinitions } from './redaction.js';

const reject = (): never => { throw new HarnessError('PERSONAL_COLLECTION_INVALID_VIEW'); };
const limits = Object.freeze({ sourceFileBytes: 65536, fullViewBytes: 65536, excerptBytes: 32768, evidenceBytes: 65536,
  inputBytes: 131072, files: 8, ranges: 16, linesPerRange: 200, masks: 128 } as const);
const profile: PersonalCollectionProfile = Object.freeze({ policy: PERSONAL_COLLECTION_POLICY, redactor: PERSONAL_COLLECTION_REDACTOR,
  rawSensitivePolicy: 'existing-full-file-rejection-v1', viewSensitivePolicy: 'same-full-file-check-v1',
  relayProfileScope: 'unchanged-transport-component', limits });
export const getPersonalCollectionProfile = (): PersonalCollectionProfile => profile;
export const getPersonalCollectionProfileHash = (): string => hashReadonlyValue(canonicalReadonlyJson(profile));

// These are the existing read-policy's additional conservative checks, with global matching for complete masking.
const extraPatterns = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/gu,
  /\bxox[baprs]-[A-Za-z0-9-]+\b/gu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b["']?\s*[:=]\s*["']?[^\s"';,}]{8,}/giu,
];
const filePolicy = (path: string, excerptBytes: number = limits.fullViewBytes) => ({ repoId: 'collection-view', root: '/', baseCommit: '0'.repeat(40),
  allowedPaths: [path], maxFileBytes: limits.fullViewBytes, maxEvidenceBytes: excerptBytes });
const inspectFullFile = (path: string, bytes: Uint8Array): void => {
  const request = { repoId: 'collection-view', path, startLine: 1, endLine: 1 };
  validateReadRequest(filePolicy(path), request); inspectEvidenceText(filePolicy(path), request, bytes);
};
const snapshotBytes = (value: Uint8Array): Buffer => {
  if (!(value instanceof Uint8Array) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value))
    || value.buffer instanceof SharedArrayBuffer || value.byteLength > limits.sourceFileBytes) return reject();
  return Buffer.from(value);
};
interface Span { start: number; end: number }
const sensitiveSpans = (text: string): Span[] => {
  const spans: Span[] = [];
  const add = (start: number, end: number): void => {
    if (spans.length >= 1024 || start < 0 || end <= start || end > text.length) reject();
    spans.push({ start, end });
  };
  for (const pattern of [...getSensitivePatternDefinitions().map((definition) => definition.pattern), ...extraPatterns]) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) add(match.index, match.index + match[0].length);
  }
  // A header-only match must never leave the private key body readable, including a truncated key at EOF.
  for (const match of text.matchAll(/-----BEGIN ((?:[A-Z ]+ )?PRIVATE KEY)-----/gu)) {
    const closing = `-----END ${match[1]}-----`;
    const position = text.indexOf(closing, match.index + match[0].length);
    add(match.index, position < 0 ? text.length : position + closing.length);
  }
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Span[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  if (merged.length > limits.masks) reject();
  return merged;
};
const lineAt = (text: string, position: number): number => {
  let line = 1;
  for (let index = 0; index < position; index++) if (text.charCodeAt(index) === 10) line++;
  return line;
};
const linesIn = (text: string): number => lineAt(text, text.length) - (text.endsWith('\n') ? 1 : 0);

/** The raw rejection remains observable in safe proof metadata; only the fully rechecked view is usable as evidence. */
export const derivePersonalSourceView = (path: string, rawBytes: Uint8Array): PersonalSourceView => {
  try {
    if (typeof path !== 'string' || path.length > 512) reject();
    const source = snapshotBytes(rawBytes);
    let rawSensitiveCheck: 'passed' | 'rejected' = 'passed';
    try { inspectFullFile(path, source); }
    catch (error) {
      if (!(error instanceof HarnessError) || error.code !== 'SECRET_CONTENT_BLOCKED') throw error;
      rawSensitiveCheck = 'rejected';
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source);
    const spans = sensitiveSpans(text);
    if ((rawSensitiveCheck === 'passed') !== (spans.length === 0)) reject();
    let cursor = 0; const pieces: string[] = [];
    for (const span of spans) {
      pieces.push(text.slice(cursor, span.start), text.slice(span.start, span.end).replace(/[^\r\n]+/gu, '[REDACTED]'));
      cursor = span.end;
    }
    const bytes = spans.length ? Buffer.from([...pieces, text.slice(cursor)].join('')) : Buffer.from(source);
    if (bytes.length > limits.fullViewBytes) reject();
    inspectFullFile(path, bytes);
    const maskedLines = spans.map((span) => Object.freeze({ startLine: lineAt(text, span.start),
      endLine: Math.max(lineAt(text, span.start), lineAt(text, span.end) - (text[span.end - 1] === '\n' ? 1 : 0)) }));
    const sourceLines = linesIn(text), viewLines = linesIn(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (sourceLines !== viewLines) reject();
    return Object.freeze({ path, sourceHash: hashReadonlyValue(source), sourceBytes: source.length, sourceLines,
      viewHash: hashReadonlyValue(bytes), viewBytes: bytes.length, viewLines, rawSensitiveCheck, viewSensitiveCheck: 'passed' as const,
      maskCount: spans.length, maskedLines: Object.freeze(maskedLines) as unknown as PersonalSourceView['maskedLines'], bytes });
  } catch { return reject(); }
};

/** fileHash deliberately identifies the safe full view, while the raw hash stays in the private proof. */
export const extractPersonalCollectionEvidence = (repoId: string, baseCommit: string, range: ReadonlyRange, view: PersonalSourceView): ReadonlyEvidence => {
  try {
    const bytes = snapshotBytes(view.bytes);
    if (typeof repoId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(repoId) || !/^[a-f0-9]{40}$/u.test(baseCommit)
      || range.path !== view.path || view.viewSensitiveCheck !== 'passed' || view.viewBytes !== bytes.length
      || view.viewHash !== hashReadonlyValue(bytes)) reject();
    inspectFullFile(range.path, bytes);
    const policy = { ...filePolicy(range.path, limits.excerptBytes), repoId, baseCommit };
    validateReadRequest(policy, { repoId, ...range });
    const excerpt = inspectEvidenceText(policy, { repoId, ...range }, bytes);
    const item = { repoId, baseCommit, path: range.path, startLine: range.startLine, endLine: range.endLine,
      fileHash: view.viewHash, excerptHash: hashReadonlyValue(excerpt), excerpt };
    return { evidenceId: `evidence-${hashReadonlyValue(canonicalReadonlyJson(item))}`, ...item };
  } catch { return reject(); }
};
