# 로컬 모의 문의가 답변 초안이나 변경 계획이 되기까지

`replay`는 Slack이나 Codex 계정 없이 조사 로직을 따라가는 진입점이다. 예를 들어 [문의 fixture](../../fixtures/events/inquiry.json)를 선택하면, 고정 모델이 합성 저장소의 `src/orders.service.ts`를 읽도록 요청한다. 하네스가 기준 커밋에서 코드를 발췌한 뒤, 중복 주문에 409를 반환하는 분기를 근거로 로컬 답변 초안을 만든다. 실제 Slack 이벤트의 수신 경로는 [Slack 멘션 수신](slack-intake.md)에서 볼 수 있다.

## 이벤트에서 근거와 상태까지

1. **입력 준비.** CLI의 `run`이 비공개 데이터 디렉터리를 열고 `prepareDemoRepository`로 임시 Git 저장소를 준비한다. 실행 전에 저장소 전체를 해시하고, 선택한 이벤트 파일·합성 저장소·데이터 경로에 맞춰 Node 권한을 제한한 worker를 띄운다. [CLI](../../src/cli/main.ts) · [합성 저장소](../../src/adapters/demo-repository.ts) · [경로와 권한](../../src/cli/runtime.ts)
2. **의존성 연결.** Worker가 NestJS의 `HarnessModule.configure`로 `InvestigationService`를 구성한다. `MockSlackSource.read`는 fixture를 이벤트 배열로 읽고, worker가 이를 `InvestigationService.replay`에 넘긴다. [worker](../../src/cli/worker.ts) · [서비스 구성](../../src/cli/harness.module.ts) · [이벤트 판독기](../../src/adapters/mock-slack-source.ts)
3. **접수와 분류.** `normalizeMessage`는 허용 workspace·채널과 본인 멘션을 확인하고 본문을 마스킹한다. 서비스가 새 작업을 `RECEIVED`로 저장하면 `FixtureModel.triage`의 결과를 검증해 `TRIAGED`로 옮긴다. 같은 이벤트가 이미 저장돼 있으면 중복 건수만 증가한다. [수신 정책](../../src/policy/ingestion.ts) · [고정 모델](../../src/adapters/fixture-model.ts) · [조사 서비스](../../src/application/investigate.ts)
4. **근거 읽기.** `LocalGitReader.read`가 모델이 요청한 경로와 줄 범위를 검사하고, 등록된 기준 커밋의 Git tree·blob에서 발췌한다. `FixtureModel.summarize`가 돌려준 사실·가설·초안은 `JsonModelOutputValidator`의 스키마와 근거 인덱스 검사를 거친다. [Git 판독기](../../src/adapters/local-git-reader.ts) · [읽기 정책](../../src/policy/read-policy.ts) · [모델 출력 검증](../../src/policy/model-output.ts)

| 분류 | 멈추는 상태 | 확인할 값 |
| --- | --- | --- |
| 문의 `inquiry` | `REPORTED` | `report.evidence`, `report.facts`, `report.answerDraft` |
| 변경 `change` | `AWAITING_APPROVAL` | `plan.allowedFiles`, `plan.proposedChanges`, `plan.baseCommit`, `plan.planHash` |
| 불명확 `unclear` | `NEEDS_CLARIFICATION` | `report.questions`. 분류 직후 질문을 반환한다. |

모델 오류는 `FAILED`, 차단된 파일 접근 등은 `BLOCKED`와 `failureCode`로 남는다. 조사 중간에 프로세스가 끊긴 경우 다음 worker가 미완료 작업을 `BLOCKED`로 바꾼다. [상태 전이](../../src/domain/state.ts) · [조사 오류 처리](../../src/application/investigate.ts) · [SQLite 저장·복구](../../src/adapters/sqlite-task-store.ts)

## 결과 조회와 변경 계획 검토

```sh
pnpm harness replay --fixture inquiry --data-dir /private/tmp/harness-flow-demo
pnpm harness list --data-dir /private/tmp/harness-flow-demo
pnpm harness inspect "$TASK_ID" --data-dir /private/tmp/harness-flow-demo
```

마지막 명령의 `$TASK_ID`에는 첫 명령의 `result.tasks[].taskId`를 넣는다. `tasks.sqlite`가 작업 상태의 원본이다. Worker는 보고서를 `reports/<task-id>.json`에 기록하고, 부모 CLI는 원본 해시가 실행 전과 같은지 확인한 뒤 `runs/<run-id>.json`에 실행 기록을 남긴다. [보고서 작성기](../../src/adapters/local-report-sink.ts) · [실행 기록](../../src/cli/main.ts)

`--fixture change`로 만든 계획을 `approve`하면, `LocalApprovalService`가 OS 사용자·계획 해시·기준 커밋·만료 시간을 대조하는 저장소에 요청을 넘긴다. 승인이 기록되면 상태는 `APPROVED`이고 이 경로는 여기서 끝난다. `cancel`은 작업 취소와 보고서 갱신을 처리한다. 패치 적용을 시험하려면 [별도 합성 실행](synthetic-execution.md)에서 새 계획을 만든다. [승인 서비스](../../src/application/approve.ts) · [승인 규칙](../../src/domain/approval.ts) · [실행 거부 어댑터](../../src/adapters/denied-actions.ts)

[문의·변경·중단 시나리오 테스트](../../tests/workflow.test.ts) · [승인과 보고서 복구 테스트](../../tests/approval-report.test.ts) · [전체 흐름 목록](README.md)
