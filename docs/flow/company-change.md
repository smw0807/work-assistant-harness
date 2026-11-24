# 회사 파일 수정안을 검토하거나 적용하는 흐름

예를 들어 `src/service.ts` 하나를 바꾸려면, 수정안 JSON에 대상 경로와 `replace`, 변경 전 파일의 hash, 교체할 전체 본문을 담는다. 새 파일은 `create`와 `beforeHash: null`을 쓴다. 수정안은 사람이 명시적으로 전달한다. Slack 분석 결과나 회사 조사 보고서에서 수정안 작성·적용을 시작하는 자동 호출은 없다. [수정안 예시](../../config/company-change-draft.example.json) · [지원 명령 분기](../../src/cli/main.ts)

## 수정안의 내용을 먼저 검토할 때

1. `pnpm harness company-change-plan --draft <파일> --data-dir <경로>`를 실행하면 `CompanyChangePreparationService.prepare`가 선언된 기준 브랜치·커밋·index hash와 파일별 내용을 검증해 계획을 만든다. 이 단계의 원본 확인 상태는 `sourceVerification: not_run`이다. 입력한 수정안과 계획은 `store/company-change.sqlite`에 남는다. [CLI](../../src/cli/company-change.ts) · [계획 생성](../../src/application/prepare-company-change.ts) · [수정안 규칙](../../src/policy/company-change.ts) · [저장소](../../src/adapters/sqlite-company-change-store.ts)
2. `company-change-review`에 작업 ID를 넘기면 worker가 `reviews/<taskId>.json`을 만든다. 검토자는 파일마다 선언한 변경 전 hash와 적용할 새 본문을 확인한다. `company-change-approve`는 계획 hash와 유효기간을 받아 **검토 전용 승인**을 기록한다. `APPROVED`가 이 흐름의 종점이며, 원본 적용은 별도의 계획으로 시작한다. [검토 파일을 만드는 worker](../../src/cli/company-change-worker.ts) · [검토 전용 승인 테스트](../../tests/company-change-application.test.ts)

## 합성 저장소에서 변경 절차를 시험할 때

| 목적 | 진입점과 결과 | 구현 |
| --- | --- | --- |
| 파일 변경과 중단 복구를 단계별로 확인 | `synthetic-change-init`이 전용 디렉터리에 합성 Git 저장소와 `example-draft.json`을 만든다. 같은 명령군의 `plan → approve → apply`를 거쳐 그 저장소의 새 브랜치와 선택 파일을 변경한다. `inspect`와 `recover`는 로컬 보고서를 쓰고, `recover`는 중단 지점의 파일 상태를 관찰한다. | [CLI](../../src/cli/synthetic-company-change.ts) · [적용 서비스](../../src/application/apply-synthetic-company-change.ts) · [합성 작업 공간](../../src/adapters/synthetic-company-change-workspace.ts) · [복구 관찰](../../src/application/recover-synthetic-company-change.ts) · [CLI 테스트](../../tests/synthetic-company-change-cli.test.ts) |
| 쓰기 worker의 OS 격리와 한 번만 쓰는 승인을 일괄 점검 | `company-write-check --data-dir <새 경로>` 한 번으로 합성 저장소·등록·수정안·시험 승인을 생성한다. 지정 가능한 입력은 점검 디렉터리뿐이다. 브랜치 생성 순서, 선택 파일 결과, index 보존 여부 등을 JSON으로 출력한다. | [CLI](../../src/cli/company-write.ts) · [점검 절차](../../src/application/check-company-write.ts) · [격리 worker](../../src/adapters/company-write-isolation.ts) · [격리 점검 테스트](../../tests/company-write-check.test.ts) |

## 승인된 회사 원본에 파일을 적용할 때

이 경로의 입력은 두 파일이다. `company-write-registration-v1`에는 실제 대상 위치, 기준 브랜치·커밋·index hash와 `writeAllowedFiles`를 선언한다. `company-change-draft-v1`에는 그중 바꿀 파일의 내용을 담는다. 검토 전용 작업이나 합성 작업의 ID·승인을 가져오지 않는다. [등록 예시](../../config/company-write-registration.example.json) · [입력 조합을 확인하는 정책](../../src/policy/company-apply.ts)

1. **계획** — `company-apply-plan`이 등록·수정안을 읽고 `planCompanyApply`를 호출한다. 기존 파일은 기준 커밋의 blob과 index, 작업 파일을 대조하고 새 파일은 경로 충돌과 존재 여부를 확인한다. 결과로 이 원본에 대한 `taskId`와 `planHash`가 생긴다. [CLI](../../src/cli/company-apply.ts) · [계획·승인·실행 제어](../../src/application/company-apply.ts) · [Git 기준 확인](../../src/adapters/company-apply-git.ts) · [경로와 파일 확인](../../src/adapters/company-apply-workspace.ts)
2. **승인과 실행 요청** — `company-apply-approve`는 같은 등록·수정안, 작업 ID, 계획 hash, 유효기간으로 원본을 재확인하고 로컬 파일 적용용 승인을 기록한다. 별도의 `company-apply-run`에서 `runCompanyApply`가 다시 확인하고, macOS 격리 점검이 통과하면 승인 사용 기록을 남긴 뒤 적용 worker를 시작한다. [실행 제어](../../src/application/company-apply.ts) · [격리 실행기](../../src/adapters/company-apply-isolation.ts) · [적용 worker](../../src/cli/company-apply-worker.ts)
3. **실제 쓰기** — worker의 `applyClaimedCompanyApply`가 `CompanyApplyWorkspace.createBranch`로 새 브랜치를 만들어 전환한다. 이어서 계획 순서대로 `writeFile`을 호출하고 `verifyApplied`로 결과를 확인한다. 각 변경의 시작과 완료를 journal에 기록한다. [적용 순서](../../src/application/apply-company-apply.ts) · [실제 파일 변경](../../src/adapters/company-apply-workspace.ts) · [승인 사용 기록·journal](../../src/adapters/company-apply-journal.ts)
4. **결과 확인** — `company-apply-inspect`는 작업 ID와 runtime으로 기록을 읽는다. `APPLIED`이면 선택 파일 적용까지 끝났고 제품 검사는 `not_run`이다. 실행 도중 실패하면 이미 반영된 파일이 남을 수 있다. 완료를 확정할 수 없는 `UNKNOWN`은 같은 ID로 조회한다. 소비한 승인은 재실행할 수 없다. commit·push·PR은 이 경로에 포함되지 않는다. [CLI 수용 테스트](../../tests/company-apply-cli.test.ts) · [부분 실패와 승인 소비 테스트](../../tests/company-apply-execution.test.ts)

각 명령의 전체 옵션과 사전 조건은 [회사 작업 가이드](../guides/company-workflows.md), 합성 작업의 디렉터리와 보고서 형식은 [합성 작업 가이드](../guides/synthetic-workflows.md)에서 확인할 수 있다.
