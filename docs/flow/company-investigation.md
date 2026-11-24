# 회사 저장소에서 근거를 읽어 조사 보고서를 만드는 흐름

회사 코드에 대한 질문은 운영자가 등록 파일에 **질문, 기준 커밋, 읽을 파일·줄 범위**를 지정하면서 시작한다. 로컬 근거 준비가 끝나면 준비 작업 ID가 생긴다. 모의 조사와 실제 모델 조사는 이 ID를 입력받는 별개 명령이며, 운영자가 필요한 경로를 선택한다. Slack 멘션을 접수한 것만으로 회사 저장소를 읽지는 않는다.

## 1. 읽을 범위를 정하고 검토 자료를 저장한다

`pnpm harness company-readonly-v3-plan`을 예로 들면 다음 순서다.

1. CLI가 `--policy`의 읽기·보관 허용 선언과 보관 기한을 먼저 확인한다. 통과하면 `--registration`에서 `sourceRoot`, `baseCommit`, `question`, `readRanges`, `reviewPaths`를 읽는다. `readRanges`는 수집할 범위이고 `reviewPaths`는 그중 검토 입력에 담을 파일이다. [CLI](../../src/cli/company-readonly-v3.ts) · [공통 정책 예시](../../config/company-readonly-policy.example.json) · [v3 등록 예시](../../config/company-readonly-registration-v3.example.json)
2. worker가 저장소 판독기와 SQLite 저장소를 연결한다. `CompanyReadonlyPreparationServiceV3.prepare`가 선택 범위의 근거를 수집하고 원본을 다시 읽어 두 관찰의 `proofHash`를 비교한다. 일치하고 읽기 세션을 닫으면 마스킹을 거친 발췌문과 계획을 저장한다. [worker](../../src/cli/company-readonly-v3-worker.ts) · [준비 서비스](../../src/application/prepare-company-readonly-v3.ts) · [파일·Git 객체 판독기](../../src/adapters/company-git-range-unit-source.ts)
3. 결과는 `--data-dir` 아래 `store/company-readonly-v3.sqlite`에 남는다. CLI의 `taskId`와 `AWAITING_APPROVAL`은 로컬 검토 자료가 준비됐다는 뜻이다. `company-readonly-v3-inspect`로 상태를 확인하고 `cancel` 또는 `prune`으로 취소하거나 만료 자료를 정리할 수 있다. [저장소](../../src/adapters/sqlite-company-readonly-v3-store.ts) · [준비·취소·재조회 테스트](../../tests/company-readonly-v3-application.test.ts)

등록 형식과 자료를 읽는 구현은 명령 이름으로 고른다. 실패 시 다른 버전을 자동 시도하는 분기는 없다.

| 준비 명령 | 읽는 방식 | 코드에서 따라갈 파일 |
| --- | --- | --- |
| `company-readonly-plan` | v1 등록을 받아 기존의 제한된 Git 판독기와 마스킹·발췌 수집기를 재사용한다. | [CLI](../../src/cli/company-readonly.ts) → [준비 서비스](../../src/application/prepare-company-readonly.ts) → [수집 어댑터](../../src/adapters/company-readonly-repository.ts) |
| `company-readonly-v2-plan` | v2 등록의 `gitProfileHash`를 확인하고 선택한 Git 객체에 필요한 pack 구간을 읽는다. | [CLI](../../src/cli/company-readonly-v2.ts) → [준비 서비스](../../src/application/prepare-company-readonly-v2.ts) → [구간 판독 어댑터](../../src/adapters/company-readonly-v2-source.ts) |
| `company-readonly-v3-plan` | v3 등록의 `gitProfileHash`와 `guardPolicyHash`를 확인한다. 읽기 단위의 시작과 끝에서 경로를 검증하는 판독기를 사용한다. | [CLI](../../src/cli/company-readonly-v3.ts) → [준비 서비스](../../src/application/prepare-company-readonly-v3.ts) → [읽기 단위 어댑터](../../src/adapters/company-readonly-v3-source.ts) |

## 2. v3 준비 작업을 어느 조사에 넘길지 고른다

**로컬 고정 응답으로 검증할 때**는 `company-investigation-plan --mode mock`에 `--preparation-task`와 `--preparation-data-dir`를 넘긴다. 새 조사 작업의 ID와 계획 hash로 `company-investigation-approve` 후 `company-investigation-run`을 호출한다. `CompanyInvestigationService`가 준비 자료와 원본을 재확인하고 `FixedCompanyInvestigationModel.investigate`에 선택 근거를 전달한다. 스키마와 인용 범위를 통과한 고정 보고서는 조사용 `store/company-investigation.sqlite`에 저장되며 `company-investigation-inspect`는 상태 요약을 보여 준다. [CLI](../../src/cli/company-investigation.ts) · [조사 서비스](../../src/application/investigate-company.ts) · [입력 구성·응답 검증](../../src/policy/company-investigation.ts) · [고정 응답](../../src/adapters/company-investigation-model.ts) · [모의 조사 테스트](../../tests/company-readonly-investigation-workflow.test.ts)

**선택 근거를 실제 모델에 전달할 때**는 같은 v3 준비 ID로 `company-relay-plan --mode live`를 별도로 시작한다. 모의 조사 결과나 그 승인은 입력으로 받지 않는다.

1. CLI가 회사 전송 허용 선언과 제공자·계정 설정을 받는다. 정책의 `buildInput`이 조사 지시와 선택 근거를 조합하고 `buildBody`가 전송할 요청 본문을 만든다. `company-relay-review`로 생성한 `reviews/<taskId>.json`의 `requestEnvelope.body`가 검토할 정확한 문자열이다. [CLI](../../src/cli/company-relay.ts) · [요청 구성](../../src/policy/company-relay.ts) · [검토 파일 생성](../../src/cli/company-relay-review.ts) · [설정 예시](../../config/company-relay-authorization.example.json)
2. 운영자가 이 **relay 작업**의 ID와 계획 hash, 유효기간으로 `company-relay-approve`를 수행하고 `company-relay-run`을 호출한다. `CompanyRelayService.run`은 원본·준비 상태를 재확인하고 단건 승인을 소비한 뒤에 실제 어댑터를 구성한다. `RestrictedCompanyRelayCodex`는 허용 계정을 대조하고, 전송 예약을 기록한 뒤 기존 Codex relay를 통해 요청을 보낸다. [서비스](../../src/application/investigate-company-relay.ts) · [worker의 어댑터 연결](../../src/cli/company-relay-worker.ts) · [회사 Codex 어댑터](../../src/adapters/company-relay-codex.ts)
3. 응답의 스키마와 근거 인용을 검증하고 원본을 다시 확인하면 `store/company-relay.sqlite`에 보고서가 남는다. `company-relay-inspect`로 상태를, `company-relay-review`로 검증된 보고서를 확인한다. 이 흐름의 출력은 로컬 보고서다. 게시나 파일 적용에는 각 기능의 별도 입력이 필요하다. [저장소](../../src/adapters/sqlite-company-relay-store.ts) · [승인·전송·결과 검증 테스트](../../tests/company-readonly-relay-workflow.test.ts)

회사 장비에서 새 Codex 대화로 오프라인 점검을 이어갈 때는 사람이 인수인계 문서의 시작 문구를 전달한다. 이때의 `migration-check`는 장비 준비 상태를 확인하는 독립 명령이다. 각 조사 명령의 전체 옵션과 보관 기한은 실행 가이드에서 확인할 수 있다. [오프라인 인수인계](../company-offline-handoff.md) · [장비 점검 CLI](../../src/cli/migration-check.ts) · [회사 작업 가이드](../guides/company-workflows.md)
