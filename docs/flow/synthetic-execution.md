# 합성 브랜치 생성과 승인한 패치 실행

하네스에서 브랜치와 파일 변경을 시험하는 명령은 각각 어떤 효과를 허용하는지에 따라 나뉜다. 예를 들어 `replay --fixture change`에서 받은 계획을 승인해도 Docker 검사는 시작되지 않는다. 실행을 시험하려면 아래 명령 중 하나로 전용 합성 작업을 만든다.

| 시작 명령 | 승인 후 일어나는 일 | 코드를 읽는 순서 |
| --- | --- | --- |
| `branch-plan` | `branch-simulate`가 브랜치 생성의 성공·충돌 등 가상 결과를 `branches.sqlite`에 기록한다. | [CLI](../../src/cli/branch.ts) → [SyntheticBranchService](../../src/application/simulate-branch.ts) → [모의 작업공간](../../src/adapters/mock-branch-workspace.ts) |
| `git-branch-plan` | `git-branch-create`가 하네스가 준비한 합성 Git 작업공간에 브랜치 ref를 실제로 생성한다. 승인·시도·관찰 결과는 `git-branches.sqlite`에 남는다. | [CLI](../../src/cli/local-branch.ts) → [LocalBranchService](../../src/application/local-branch.ts) → [ref 작성과 확인](../../src/adapters/local-branch-workspace.ts) |
| `execution-plan` | `execution-run`이 승인한 패치를 합성 사본에 적용하고 계획에 등록된 검사를 Docker에서 실행한다. | [실행 CLI](../../src/cli/execution.ts) → [SyntheticExecutionService](../../src/application/execute-synthetic.ts) |
| `branch-execution-plan` | 작업 유형을 받아 새 합성 실행 계획에 브랜치 이름까지 고정한다. `branch-execution-run`이 해당 브랜치와 패치를 확인하고 검사한다. | [실행 CLI의 프로필](../../src/cli/execution.ts) → [브랜치와 파일을 준비하는 작업공간](../../src/adapters/execution-workspace.ts) |
| `codex-execution-plan` | `READY`인 합성 Codex 제안을 한 번 소비해 새 실행 계획을 만든다. 별도 실행 승인을 받은 뒤 `codex-execution-run`을 호출한다. | [Codex 작업 인계](codex-handoff.md) → [제안 소비와 실행 계획 생성](../../src/cli/execution.ts) |

## 한 패치가 실행될 때

1. **계획.** `SyntheticExecutionService.plan` 또는 `planProposal`이 합성 원본을 준비한다. 기준 커밋, 원본 해시, 변경할 `src/message.mjs`의 내용, 등록된 검사 명령, Docker 설정을 계획에 묶고 `AWAITING_APPROVAL`로 저장한다. [계획 조립](../../src/application/execute-synthetic.ts) · [실행 정책과 명령 목록](../../src/policy/execution-policy.ts)
2. **승인.** 각 계열의 `*-approve`는 작업 ID·계획 해시·기준 커밋·만료 시간을 받는다. 서비스는 합성 원본과 설정을 다시 확인한다. 각 계열은 자신의 승인과 실행 이력을 `execution.sqlite`, `branch-execution.sqlite`, `codex-execution.sqlite` 중 해당 DB에 보관한다. [CLI 프로필](../../src/cli/execution.ts) · [승인 저장소](../../src/adapters/sqlite-execution-store.ts)
3. **실행.** `*-run`이 유효한 승인, 원본, Docker 준비 상태를 확인한 뒤 `beginRun`에서 승인을 소비한다. 하네스가 별도 작업공간에 패치를 적용하고 diff를 확인한 다음 컨테이너에서 볼 파일을 준비한다. Docker 어댑터는 계획에 등록된 명령을 실행하고 종료·정리 결과를 반환한다. [실행 순서](../../src/application/execute-synthetic.ts) · [패치 적용과 diff](../../src/adapters/execution-workspace.ts) · [Docker 어댑터](../../src/adapters/docker-execution.ts)
4. **조회와 복구.** `*-inspect`로 실행 상태, diff, 검사별 결과와 보고서 경로를 본다. 종료된 실행은 실행 디렉터리의 `report.json`에 기록한다. 도중에 끊기면 `*-recover`가 기록된 단계에 따라 컨테이너 정리 상태와 남은 작업 파일을 확인한다. 중단된 패치를 다시 적용하려고 이 명령을 사용할 수는 없다. [보고서·복구 CLI](../../src/cli/execution.ts) · [중단 복구 테스트](../../tests/execution-crash.test.ts)

## Docker 격리 자체를 확인할 때

`sandbox-check`는 독립된 진단 명령이다. `SandboxVerificationService.verify`가 합성 파일을 준비하고 Docker에서 파일 접근, 프로세스 수, 메모리, 시간·출력 제한을 시험한다. 종료 뒤 보호 대상의 전후 해시와 검사별 결과를 `sandbox-checks/<verification-id>/report.json`에 기록한다. 실행 계획의 승인과 실제 `*-run` 전 준비 검사는 각각 해당 실행 경로에서 처리한다. [진단 CLI](../../src/cli/sandbox.ts) · [검사 순서](../../src/application/verify-sandbox.ts) · [Docker 진단 어댑터](../../src/adapters/docker-sandbox.ts)

[합성 실행 테스트](../../tests/execution-workflow.test.ts) · [브랜치 실행 테스트](../../tests/branch-execution-workflow.test.ts) · [명령별 인자와 예시](../guides/synthetic-workflows.md) · [전체 흐름 목록](README.md)
