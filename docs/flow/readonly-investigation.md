# 선택한 파일과 줄을 근거로 조사하기

“컨트롤러가 요청을 받으면 어떤 서비스가 응답하는가?”처럼 코드에 근거가 필요한 질문은 읽기 전용 조사 명령으로 시작한다. 운영자가 조사할 자료와 모델에 전달할 범위를 계획에서 확인하고, 해당 계획을 승인해 실행한다. Slack 멘션 분석은 멘션과 스레드만으로 답하므로 저장소 조사는 별도로 시작해야 한다. [CLI 명령 분기](../../src/cli/main.ts) · [Slack의 Codex 인계](codex-handoff.md)

## 합성 예제의 호출 관계 조사

예를 들어 `pnpm harness readonly-investigation-plan --fixture flow --selection all --transfer controller`는 합성 예제의 근거를 수집한 뒤 컨트롤러 발췌만 모의 모델 입력으로 선택한다. 계획 출력에서 **읽은 범위**와 **실제로 전달할 범위**를 비교할 수 있다. [명령 인자](../../src/cli/readonly-investigation.ts)

1. `ReadonlyInvestigationService.plan`이 `prepareReadonlyRepository`로 합성 저장소를 준비하고 `collectReadonlyPayload`로 파일 경로, 줄 범위, 발췌, 근거 ID를 수집한다. `selectReadonlyTransfer`가 전달 대상만 추린다. [계획과 수집 순서](../../src/application/investigate-readonly.ts) · [합성 파일과 수집기](../../src/adapters/readonly-repository.ts) · [입력 구성](../../src/policy/readonly-investigation-policy.ts)
2. 서비스는 `readonly-investigations.sqlite`에 계획과 입력을 저장한다. `readonly-investigation-inspect`로 내용을 읽고 `readonly-investigation-approve`에서 작업 ID, 계획 해시, 유효 시간을 확인해 승인한다. [SQLite 저장소](../../src/adapters/sqlite-readonly-investigation-store.ts) · [승인 처리](../../src/application/investigate-readonly.ts)
3. `readonly-investigation-run`은 원본과 입력을 다시 검사하고 승인을 소비한 뒤 `RestrictedReadonlyModel.investigate`를 호출한다. 이 경로의 응답은 별도 로컬 worker의 `buildReadonlyMockResponse`가 만든다. 보고서의 인용이 선택한 근거와 줄 범위에 속하는지 확인한 후 `REPORTED`로 보관한다. [모의 모델 어댑터](../../src/adapters/readonly-model.ts) · [응답 생성 worker](../../src/cli/readonly-investigation-worker.ts) · [계획부터 조회까지의 테스트](../../tests/readonly-investigation-cli.test.ts)

## 같은 합성 예제로 전송 방식을 점검하는 명령

아래 각 행은 독립된 명령 묶음이다. 각 묶음의 `-plan`으로 시작해서 해당 계획의 `-approve`, `-run`, `-inspect`로 진행한다. 한 행의 성공이 다음 행을 실행하지 않는다.

| 명령과 입력 | 실행할 때 확인하는 것 | 처음 볼 파일 |
| --- | --- | --- |
| `readonly-transport-*` · 합성 발췌, JSON 또는 스트림 프로필 | 가짜 전송기에 검토한 본문을 넘기고 응답을 해석하는 오프라인 경로 | [CLI](../../src/cli/readonly-transport.ts) · [실행 서비스](../../src/application/investigate-transport.ts) · [가짜 전송기](../../src/adapters/readonly-fake-transport.ts) |
| `readonly-model-preflight-*` · 합성 발췌, JSON 또는 SSE 프로필 | HTTP 메서드·헤더·본문까지 포함한 요청과 예상 응답을 인증 없이 메모리에서 검증하는 경로 | [CLI](../../src/cli/readonly-model-preflight.ts) · [실행 서비스](../../src/application/investigate-model-preflight.ts) · [메모리 전송기](../../src/adapters/readonly-model-preflight-fake-transport.ts) |
| `readonly-live-*` · 합성 발췌, private 모델 설정 | 승인된 단건 요청의 응답을 하네스 broker가 해석하고 격리된 Codex의 최종 출력과 대조하는 실제 호출 경로 | [CLI](../../src/cli/readonly-live.ts) · [실행 서비스](../../src/application/investigate-live.ts) · [Codex 실행기](../../src/adapters/readonly-live-codex.ts) · [응답 처리](../../src/adapters/readonly-live-broker.ts) |
| `readonly-relay-*` · 합성 발췌, private relay 설정 | broker가 승인한 요청을 한 번 전송하고, 받은 스트림을 Codex에 전달해 CLI가 만든 최종 텍스트를 검증하는 실제 호출 경로 | [CLI](../../src/cli/readonly-relay.ts) · [실행 서비스](../../src/application/investigate-relay.ts) · [relay 실행기](../../src/adapters/readonly-relay-codex.ts) · [응답 중계](../../src/adapters/readonly-relay-broker.ts) |

## 등록된 개인 저장소 조사

1. `personal-readonly-plan`은 private 등록 JSON에서 기준 커밋, 질문, 읽을 범위와 전달할 범위를 읽는다. `PersonalReadonlyService.plan`이 등록 버전에 맞는 수집기를 골라 근거와 요청 본문을 만들고 계획을 `personal-readonly.sqlite`에 넣는다. [등록 예시](../../config/personal-readonly.example.json) · [CLI](../../src/cli/personal-readonly.ts) · [수집기 선택](../../src/application/investigate-personal-readonly.ts)
2. v1 수집기는 등록 원본에서 허용한 발췌를 얻는다. v2는 민감 패턴을 마스킹한 뒤 줄 번호를 보존한 텍스트에서 발췌하고, v3는 여기에 실행 시간과 프레임 수 한도를 계획에 고정한다. 등록 버전은 어떤 자료가 모델 입력이 되는지 결정한다. [v1 원본 검사](../../src/adapters/personal-readonly-repository.ts) · [v2 수집](../../src/adapters/personal-readonly-collection-repository.ts) · [v3 수집](../../src/adapters/personal-readonly-budget-repository.ts) · [버전별 입력 검증](../../src/policy/personal-readonly-contract.ts)
3. `personal-readonly-approve` 후 `personal-readonly-run`이 계획 해시와 원본을 다시 확인한다. `RestrictedPersonalReadonlyCodex.transmit`이 등록 버전에 맞게 요청을 검사해 공용 relay로 보낸다. 서비스가 응답의 근거를 검증하고 원본 상태를 확인해 보고서를 보관하면 `personal-readonly-inspect`로 읽을 수 있다. [승인·호출·결과 기록](../../src/application/investigate-personal-readonly.ts) · [개인 조사용 Codex 어댑터](../../src/adapters/personal-readonly-codex.ts) · [저장소](../../src/adapters/sqlite-personal-readonly-store.ts)

조사 흐름의 최종 산출물은 로컬 보고서다. 실제 호출용 설정과 각 경로에서 검증한 이력은 [모델·relay 운영 가이드](../guides/model-relay.md)에서 확인할 수 있다.
