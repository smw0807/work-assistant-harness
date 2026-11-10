import { createHash, randomUUID } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import { transitionTask } from '../domain/state.js';
import type {
  ChangePlan, Evidence, IngestionPolicy, MessageEvent, ModelSummary, RepositoryPolicy,
  Task, TaskReport,
} from '../domain/types.js';
import type { ModelOutputValidator, ModelPort, RepoReadPort, ReportSink, TaskStore } from '../ports/index.js';
import { normalizeMessage } from '../policy/ingestion.js';
import { containsSensitiveText } from '../policy/redaction.js';

const boundedModelCall = async (operation: () => Promise<string>): Promise<string> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new HarnessError('MODEL_TIMEOUT')), 2_000);
      }),
    ]);
    if (containsSensitiveText(output)) throw new HarnessError('MODEL_SENSITIVE_OUTPUT');
    return output;
  } finally {
    clearTimeout(timeout);
  }
};

export const unexecutedChecks = (): TaskReport['checks'] => [
  { name: 'target_install_test_build', status: 'not_run', reason: '단계 1은 대상 코드를 읽기만 하며 설치·검사·빌드를 실행하지 않습니다.' },
  { name: 'external_delivery', status: 'not_run', reason: '외부 모델·Slack 전송·Git 원격 어댑터가 연결되지 않았습니다.' },
  { name: 'approval_and_execution', status: 'not_run', reason: '승인 후 실행은 단계 3의 미구현 기능이며 기본 포트는 항상 거부합니다.' },
];

const createChangePlan = (task: Task, objective: string, evidence: Evidence[], summary: ModelSummary): ChangePlan => {
  const content = {
    planId: randomUUID(),
    version: 1,
    requestRevision: task.requestRevision,
    repoId: task.repoId,
    baseCommit: task.baseCommit,
    objective,
    allowedFiles: [...new Set(evidence.map((entry) => entry.path))].sort(),
    proposedChanges: summary.proposedChanges,
    testCommandIds: [],
    risks: summary.risks,
  };
  return { ...content, planHash: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
};

export interface ReplayResult {
  created: number;
  ignored: number;
  duplicates: number;
  tasks: { taskId: string; status: Task['status'] }[];
}

export class InvestigationService {
  constructor(
    private readonly ingestionPolicy: IngestionPolicy,
    private readonly repository: RepositoryPolicy,
    private readonly model: ModelPort,
    private readonly validator: ModelOutputValidator,
    private readonly reader: RepoReadPort,
    private readonly store: TaskStore,
    private readonly reporter: ReportSink,
  ) {}

  async replay(inputs: unknown[]): Promise<ReplayResult> {
    const result: ReplayResult = { created: 0, ignored: 0, duplicates: 0, tasks: [] };
    for (const input of inputs) {
      const event = normalizeMessage(input, this.ingestionPolicy);
      if (!event) {
        result.ignored += 1;
        continue;
      }
      let task = this.newTask(event);
      if (!this.store.create(task)) {
        result.duplicates += 1;
        continue;
      }
      result.created += 1;
      try {
        task = await this.analyze(task, event);
      } catch (error) {
        // 외부 자료가 포함될 수 있는 예외 메시지와 모델 원문은 저장하지 않는다.
        const failureCode = error instanceof HarnessError ? error.code : 'INVESTIGATION_FAILED';
        const storedTask = this.store.find(task.taskId) ?? task;
        task = {
          ...transitionTask(storedTask, failureCode.startsWith('MODEL_') ? 'FAILED' : 'BLOCKED'),
          failureCode,
          report: {
            summary: '조사를 완료하지 못했습니다. 확인된 근거가 부족합니다.',
            facts: [], hypotheses: [], evidence: [], answerDraft: '', questions: [],
            risks: [failureCode],
            checks: [{ name: 'read_only_investigation', status: 'failed', reason: failureCode }, ...unexecutedChecks()],
            nextApproval: '조사 조건을 확인해야 합니다. 실행 기능은 비활성화되어 있습니다.',
          },
        };
      }
      this.store.save(task);
      await this.reporter.write(task);
      result.tasks.push({ taskId: task.taskId, status: task.status });
    }
    return result;
  }

  private newTask(event: MessageEvent): Task {
    const now = new Date().toISOString();
    return {
      taskId: randomUUID(), eventId: event.eventId, workspaceId: event.workspaceId,
      channelId: event.channelId, threadTs: event.threadTs, requesterId: event.requesterId,
      messageTs: event.messageTs ?? event.threadTs,
      requestRevision: event.revision, classification: null, status: 'RECEIVED',
      repoId: this.repository.repoId, baseCommit: this.repository.baseCommit,
      createdAt: now, updatedAt: now, history: ['RECEIVED'], plan: null, report: null, failureCode: null,
    };
  }

  private async analyze(task: Task, event: MessageEvent): Promise<Task> {
    const decision = this.validator.triage(await boundedModelCall(() => this.model.triage(event)));
    task = { ...transitionTask(task, 'TRIAGED'), classification: decision.kind };
    this.store.save(task);
    if (decision.kind === 'unclear') {
      return {
        ...transitionTask(task, 'NEEDS_CLARIFICATION'),
        report: {
          summary: decision.objective, facts: [], hypotheses: [], evidence: [], answerDraft: '',
          questions: decision.questions, risks: ['목적과 기대 동작이 확정되지 않았습니다.'],
          checks: unexecutedChecks(), nextApproval: '목적과 기대 동작을 확인해야 합니다.',
        },
      };
    }
    const evidence: Evidence[] = [];
    for (const request of decision.reads) {
      evidence.push(await this.reader.read(request));
      if (Buffer.byteLength(JSON.stringify(evidence)) > this.repository.maxEvidenceBytes) {
        throw new HarnessError('EVIDENCE_TOO_LARGE');
      }
    }
    if (evidence.length === 0) throw new HarnessError('INSUFFICIENT_EVIDENCE');
    const summary = this.validator.summary(
      await boundedModelCall(() => this.model.summarize(event, decision, evidence)), evidence.length,
    );
    task = transitionTask(task, 'ANALYZED');
    this.store.save(task);
    const report: TaskReport = {
      summary: decision.objective, facts: summary.facts, hypotheses: summary.hypotheses, evidence,
      answerDraft: decision.kind === 'inquiry' ? summary.answerDraft : '', questions: [],
      risks: summary.risks,
      checks: [{ name: 'read_only_investigation', status: 'passed', reason: '허용된 파일 근거 수집과 모델 JSON 검증을 완료했습니다.' }, ...unexecutedChecks()],
      nextApproval: decision.kind === 'change'
        ? '수정 계획만 생성했습니다. 승인과 실행 명령은 단계 3에서 구현합니다.'
        : '로컬 답변 초안입니다. 외부 전송은 별도 승인 대상입니다.',
    };
    return {
      ...transitionTask(task, decision.kind === 'change' ? 'AWAITING_APPROVAL' : 'REPORTED'),
      plan: decision.kind === 'change' ? createChangePlan(task, decision.objective, evidence, summary) : null,
      report,
    };
  }
}
