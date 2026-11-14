const kibibyte = 1024;
export const READONLY_RELAY_CAPACITY_CANDIDATES = Object.freeze([1048576, 2097152, 4194304] as const);
export type ReadonlyRelayCapacityBytes = 262144 | typeof READONLY_RELAY_CAPACITY_CANDIDATES[number];
export const READONLY_RELAY_CAPACITY_CORPUS = Object.freeze(['small-unicode', 'medium-metadata', 'large-metadata', 'stress-metadata'] as const);
export type ReadonlyRelayCapacityFixtureId = typeof READONLY_RELAY_CAPACITY_CORPUS[number] | 'fragmentation-320k'
  | 'frame-overflow' | 'frame-count-overflow' | 'final-output-overflow' | 'credential-reflection';
export const READONLY_RELAY_CAPACITY_SYNTHETIC_CREDENTIAL = Object.freeze({
  accessToken: 'AUTH_SENTINEL_ACCESS_93f0cde1752a', accountId: 'ACCOUNT_SENTINEL_64c61b96e281',
});
export interface ReadonlyRelayCapacityFixture {
  id: string; body: Buffer; finalText: string; bodyBytes: number; frames: number; deltaEvents: number; snapshotEvents: number;
  maxFrameBytes: number; finalBytes: number; largestFinalString: number;
  expectedFailure: 'FRAME_LIMIT' | 'OUTPUT_LIMIT' | 'CREDENTIAL_REFLECTION' | 'RESPONSE_LIMIT' | null;
  purpose: 'smoke' | 'synthetic-load' | 'synthetic-stress' | 'fragmentation' | 'negative';
}
const finalReport = (small = false): string => JSON.stringify({ classification: 'insufficient-evidence',
  summary: '합성 용량 검사 😀', facts: [], hypotheses: [],
  answerDraft: small ? '합성 응답만 확인합니다. 😀' : '합성 점검 문장입니다. '.repeat(100),
  questions: ['어떤 추가 근거가 필요한가요?'], suggestions: [], limitations: ['합성 스트레스이며 실제 응답 크기의 대표성을 보증하지 않습니다.'] });
const encode = (event: Record<string, unknown>): string => `event: ${event.type}\ndata: ${JSON.stringify(event)
  .replaceAll('CAPACITY_ESCAPED_MARKER', String.raw`\ud55c\uae00\ud83d\ude00`)}\n\n`;
const snapshot = (status: 'in_progress' | 'completed', output: unknown[]) => ({ id: 'resp_capacity_synthetic', object: 'response',
  model: 'gpt-6.1-sol', status, output, access_programs: { cyber: 'standard' } });
const maxString = (value: unknown): number => {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object') return 0;
  return Math.max(0, ...Object.values(value).map(maxString));
};
const describe = (id: string, body: string, finalText: string, purpose: ReadonlyRelayCapacityFixture['purpose'],
  expectedFailure: ReadonlyRelayCapacityFixture['expectedFailure'] = null): ReadonlyRelayCapacityFixture => {
  const frames = body.split('\n\n').slice(0, -1);
  return { id, body: Buffer.from(body), finalText, bodyBytes: Buffer.byteLength(body), frames: frames.length,
    deltaEvents: (body.match(/^event: response\.output_text\.delta$/gmu) ?? []).length,
    snapshotEvents: (body.match(/^event: response\.(?:created|in_progress|completed)$/gmu) ?? []).length,
    maxFrameBytes: Math.max(0, ...frames.map((frame) => Buffer.byteLength(frame + '\n\n'))),
    finalBytes: Buffer.byteLength(finalText), largestFinalString: maxString(JSON.parse(finalText)), purpose, expectedFailure };
};

const normal = (id: string, progress: number, padding: number, deltas: number,
  purpose: ReadonlyRelayCapacityFixture['purpose'], text = finalReport(id === 'small-unicode')): ReadonlyRelayCapacityFixture => {
  let sequence = 0; const frames: string[] = [];
  const push = (value: Record<string, unknown>): void => { frames.push(encode({ ...value, sequence_number: sequence++ })); };
  const initial = snapshot('in_progress', []);
  push({ type: 'response.created', response: initial });
  for (let index = 0; index < progress; index++) push({ type: 'response.in_progress', response: { ...initial,
    opaque_padding: 'x'.repeat(padding), opaque_index: index, opaque_unicode: '가나다😀', opaque_escaped: 'CAPACITY_ESCAPED_MARKER' } });
  const item = { id: 'msg_capacity_synthetic', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const reference = { response_id: initial.id, item_id: item.id, output_index: 0, content_index: 0 };
  push({ type: 'response.output_item.added', response_id: initial.id, output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  push({ type: 'response.content_part.added', ...reference, part: { type: 'output_text', text: '', annotations: [] } });
  const characters = Array.from(text);
  for (let index = 0; index < deltas; index++) {
    const delta = characters.slice(Math.floor(index * characters.length / deltas), Math.floor((index + 1) * characters.length / deltas)).join('');
    if (!delta) throw new Error('Capacity fixture requires nonempty deltas');
    push({ type: 'response.output_text.delta', ...reference, delta });
  }
  push({ type: 'response.output_text.done', ...reference, text });
  push({ type: 'response.content_part.done', ...reference, part: item.content[0] });
  push({ type: 'response.output_item.done', response_id: initial.id, output_index: 0, item });
  push({ type: 'response.completed', response: snapshot('completed', [item]) });
  return describe(id, frames.join(''), text, purpose);
};

/** ASCII SSE comment frames provide exact byte boundaries without enlarging any JSON value or frame. */
const padTo = (fixture: ReadonlyRelayCapacityFixture, target: number): string => {
  let remaining = target - fixture.body.length;
  if (remaining < 0) throw new Error('Capacity target is smaller than fixture');
  const frames: string[] = [];
  while (remaining >= 3) {
    let size = Math.min(32 * kibibyte, remaining);
    if (remaining - size > 0 && remaining - size < 3) size -= 3 - (remaining - size);
    frames.push(':' + 'x'.repeat(size - 3) + '\n\n'); remaining -= size;
  }
  const body = fixture.body.toString(); const boundary = body.indexOf('\n\n');
  return body.slice(0, boundary) + ' '.repeat(remaining) + '\n\n' + frames.join('') + body.slice(boundary + 2);
};

/** Registered synthetic corpora only. Large metadata repetition is stress data, not a provider-size estimate. */
export const createReadonlyRelayCapacityFixture = (id: ReadonlyRelayCapacityFixtureId): ReadonlyRelayCapacityFixture => {
  if (id === 'small-unicode') return normal(id, 2, 128, 64, 'smoke');
  if (id === 'medium-metadata') return normal(id, 36, 12 * kibibyte, 512, 'synthetic-load');
  if (id === 'large-metadata') return normal(id, 64, 22 * kibibyte, 768, 'synthetic-load');
  if (id === 'stress-metadata') return normal(id, 84, 30 * kibibyte, 1100, 'synthetic-stress');
  const small = normal('small-unicode', 2, 128, 64, 'smoke');
  if (id === 'fragmentation-320k') return describe(id, padTo(small, 320 * kibibyte), small.finalText, 'fragmentation');
  if (id === 'frame-overflow') return describe(id, `data: ${JSON.stringify({ opaque: 'x'.repeat(64 * kibibyte) })}\n\n`, small.finalText, 'negative', 'FRAME_LIMIT');
  if (id === 'frame-count-overflow') {
    const body = Array.from({ length: 2049 }, (_, index) => encode({ type: 'response.in_progress', sequence_number: index,
      response: snapshot('in_progress', []) })).join('');
    return describe(id, body, small.finalText, 'negative', 'FRAME_LIMIT');
  }
  if (id === 'final-output-overflow') {
    const text = JSON.stringify({ classification: 'insufficient-evidence', summary: 'x'.repeat(4096), facts: [], hypotheses: [],
      answerDraft: 'y'.repeat(4096), questions: ['z'.repeat(4096)], suggestions: [], limitations: ['w'.repeat(4096)] });
    const fixture = normal(id, 0, 0, 128, 'negative', text); return { ...fixture, expectedFailure: 'OUTPUT_LIMIT' };
  }
  if (id === 'credential-reflection') {
    const escaped = [...READONLY_RELAY_CAPACITY_SYNTHETIC_CREDENTIAL.accessToken].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    return describe(id, `data: {"opaque":"${escaped}"}\n\n`, small.finalText, 'negative', 'CREDENTIAL_REFLECTION');
  }
  throw new Error('Unregistered capacity fixture');
};

export const createReadonlyRelayCapacityByteOverflow = (responseBytes: ReadonlyRelayCapacityBytes): ReadonlyRelayCapacityFixture => {
  if (![262144, ...READONLY_RELAY_CAPACITY_CANDIDATES].includes(responseBytes)) throw new Error('Unregistered capacity limit');
  const small = createReadonlyRelayCapacityFixture('small-unicode');
  return describe(`response-${responseBytes}-plus-one`, padTo(small, responseBytes + 1), small.finalText, 'negative', 'RESPONSE_LIMIT');
};
