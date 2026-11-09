import { HarnessError } from '../domain/errors.js';
import type { Evidence, MessageEvent, ModelSummary, TriageDecision } from '../domain/types.js';
import type { ModelPort } from '../ports/index.js';

const scenarios = new Set([
  'inquiry', 'change', 'unclear', 'invalid-json', 'invalid-summary', 'hallucinated-file',
  'path-escape', 'symlink', 'secret', 'large', 'binary', 'malicious', 'forbidden-command', 'timeout',
]);

const scenarioPaths: Record<string, string> = {
  'hallucinated-file': 'src/missing.service.ts',
  'path-escape': '../outside.txt',
  symlink: 'src/linked.ts',
  secret: '.env',
  large: 'src/large.ts',
  binary: 'src/binary.ts',
};

export class FixtureModel implements ModelPort {
  constructor(private readonly scenario: string) {
    if (!scenarios.has(scenario)) throw new HarnessError('MODEL_UNKNOWN_SCENARIO');
  }

  async triage(_event: MessageEvent): Promise<string> {
    if (this.scenario === 'timeout') throw new HarnessError('MODEL_TIMEOUT');
    if (this.scenario === 'invalid-json') return '{ invalid';
    if (this.scenario === 'forbidden-command') return JSON.stringify({
      kind: 'change', objective: '등록되지 않은 실행 요청', reads: [], questions: [], command: 'arbitrary-command',
    });
    const kind = this.scenario === 'change' ? 'change' : this.scenario === 'unclear' ? 'unclear' : 'inquiry';
    const decision: TriageDecision = {
      kind,
      objective: kind === 'change' ? '중복 요청 처리 변경 계획 작성' : kind === 'unclear' ? '요청 목적 확인' : '요청 처리 동작 조사',
      reads: kind === 'unclear' ? [] : [{
        repoId: 'sample', path: scenarioPaths[this.scenario] ?? 'src/orders.service.ts', startLine: 1, endLine: 10,
      }],
      questions: kind === 'unclear' ? ['기대하는 동작과 문제가 발생하는 조건을 알려 주세요.'] : [],
    };
    if (this.scenario === 'malicious') {
      decision.reads.push({ repoId: 'sample', path: 'README.md', startLine: 1, endLine: 12 });
    }
    return JSON.stringify(decision);
  }

  async summarize(_event: MessageEvent, decision: TriageDecision, evidence: Evidence[]): Promise<string> {
    if (this.scenario === 'timeout') throw new HarnessError('MODEL_TIMEOUT');
    if (this.scenario === 'invalid-summary') return JSON.stringify({
      facts: [{ evidenceIndex: evidence.length, text: '확인하지 않은 근거' }],
      hypotheses: [], answerDraft: '', proposedChanges: [], risks: [],
    });
    const firstEvidence = evidence[0];
    const confirmsConflict = firstEvidence !== undefined
      && /409|ConflictException/.test(firstEvidence.excerpt)
      && /duplicate|existing|exists|중복/i.test(firstEvidence.excerpt);
    const summary: ModelSummary = {
      facts: firstEvidence ? [{ evidenceIndex: 0, text: confirmsConflict
        ? '확인한 코드에는 중복 요청을 충돌로 처리하는 분기가 있습니다.'
        : '허용된 커밋과 파일에서 지정한 줄 범위의 코드를 확인했습니다.' }] : [],
      hypotheses: [],
      answerDraft: confirmsConflict
        ? '확인한 코드 범위에서는 중복 요청을 충돌로 처리합니다. 파일 근거에서 해당 분기를 확인할 수 있습니다.'
        : '확인한 자료만으로 자세한 동작을 확정할 수 없습니다.',
      proposedChanges: decision.kind === 'change' && firstEvidence
        ? ['중복 요청 분기의 응답 방식을 검토하고, 기존 값을 반환하는 변경 범위와 검사를 소유자에게 제시합니다.'] : [],
      risks: ['고정 응답 모델을 이용한 로컬 모의 조사이며 실제 서비스 동작 검증은 수행하지 않았습니다.'],
    };
    return JSON.stringify(summary);
  }
}
