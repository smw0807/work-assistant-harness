# 단계 4-C-3 구현 결과

## 범위와 상태

2026-11-12에 **새 합성 실행 승인 → 작업 유형별 브랜치 생성·선택 → 고정 1파일 수정 → 등록 Docker 검사 → 실제 diff·결과 보고**를 연결했다. 기존 3-C/D의 실행·취소·복구 구현을 정책별로 재사용하며, 기존 4-C-1/2의 명령·계획·승인과 분리한다. 상세 계약은 [4-C-3 계획](implementation-plan.md#단계-4-c-3-합성-작업-브랜치의-수정검사-연결)과 수용 81~90을 따른다.

전체 회귀 481개, lint·typecheck·build, 실제 Docker 격리 진단과 정상·검사 실패·시간/출력 제한·취소·강제 종료 복구 12개 시나리오가 통과했다. 실제 Codex·회사 GitLab·회사 자료·작업 결과 commit·push·PR/MR은 연결하지 않는다.

## 변경 파일과 실행 계약

| 파일 | 역할 |
| --- | --- |
| `src/domain/execution.ts`, `src/policy/execution-policy.ts` | 새 정책·브랜치/owner/source/기한 metadata·hash와 승인 검증 |
| `src/adapters/sqlite-execution-store.ts` | 인스턴스의 정책 고정, 기존/새 계획·승인·Run 양방향 분리, 새 TTL·기간·소유 검사 |
| `src/adapters/execution-workspace.ts` | 독립 작업 브랜치 배타 생성·HEAD 선택, 정확한 Git 경로/해시·원본 보존·새 프로세스 관찰 |
| `src/application/execute-synthetic.ts` | 준비 전 입력 경계, 실행 진입 시 실제 시각 검사, 브랜치·patch·검사 흐름과 create/start 직전 증거 재검증 |
| `src/adapters/docker-execution.ts` | 새 정책을 명시한 인스턴스만 허용하며 기존 네트워크 없음·readonly view·등록 명령·정리 경계 유지 |
| `src/cli/execution.ts`, `src/cli/main.ts` | `branch-execution-*` 7개 명령과 별도 DB/경로·TTL·유형 입력·보고서 |
| `tests/branch-execution-*.test.ts`, `tests/docker-execution.test.ts` | 정책/store 13개·workspace 7개·CLI 8개·workflow/crash 10개·Docker 정책 분리 1개 추가 |
| `README.md`, `docs/implementation-plan.md`, `docs/architecture.md`, `docs/security-and-approval.md`, 이 문서 | 실제 명령·권한·수용 기준·검증 근거와 한계 |

새 `synthetic-branch-execution-v1` 정책은 `branch-execution.sqlite`와 `branch-executions/<task-id>/`를 사용한다. 계획에 유형·`<type>/task-<task-id>`·main·예상 HEAD·OS UID·정확한 source 경로·24시간 유효기한과 기존 기준 커밋·source hash·정확한 patch·명령·Docker 정책을 결합한다. 필수 정수 TTL 1~60분의 승인이 계획 만료를 넘으면 거부한다. 승인 소비 이후에는 재승인 없이 한 번의 제한된 실행만 허용하며 generation과 명령 timeout으로 제어한다.

계획 단계에는 동결된 합성 source만 만든다. 승인 및 backend 확인 뒤 최초 Run과 승인 소비를 원자 저장하고, `workspace_preparing`에서 source와 공유하지 않는 Git 저장소를 초기화한다. 고정 기준 tree에서 ref를 배타 생성하고 symbolic HEAD를 작업 브랜치로 선택한 다음 최초 Git 증거를 `workspace_ready`에 저장한다. 이후 Git 증거를 재기준화하지 않으며 원본과 main을 보존한다.

고정 patch는 신뢰하는 하네스가 `src/message.mjs`에만 적용한다. 검사는 Git 없는 읽기 전용 view에서 기존 등록 명령으로 실행한다. view 준비 이후뿐 아니라 실제 container 생성·시작 직전에도 source·Git·diff·view 증거를 대조한다. 검사 스크립트가 바뀌면 실행을 막고 변조를 보고한다.

실행/복구의 전역 lease를 유지하면서 inspect/cancel/invalidate는 기존 3-D의 짧은 DB 트랜잭션으로 제어한다. 취소·편집·삭제는 새로운 파일 작업·container dispatch·늦은 성공을 차단한다. 복구는 기록된 소유 토큰·전체 container ID와 Git/파일/view 증거를 사용하며 자동 재실행·승인 소비 복원·ref나 작업물 삭제를 하지 않는다. 생성 중 최초 Git 증거 저장 전 중단은 보수적으로 `BLOCKED`로 보존한다.

## 검증 결과

하네스 환경은 macOS `darwin/arm64`, Node 26.12.1·pnpm 12.18.0이다. 의존성·lockfile·패키지 매니저는 변경하지 않았다.

| 검사 | 결과 | 근거 |
| --- | --- | --- |
| lint·typecheck·build | passed | 실제 정의된 pnpm 스크립트 실행 |
| 단위·통합·CLI 전체 회귀 | passed | 481 passed, 0 failed/cancelled/skipped. 기존 442개 + 신규 39개, 약 59초 |
| 변경·문서 검사 | passed | `git diff --check`, 새 테스트/문서 공백 검사, 로컬 문서 링크 107개 확인 |
| 신규 정책·기존 승인 거부 | passed | 양방향 policy/store/service/Docker 분리, 필수 유형·TTL·24h·owner/source/HEAD/hash 결합 |
| 브랜치·patch·원본·검사 경계 | passed | 네 유형 실제 Git/파일 확인, 같은 OID 충돌, HEAD/ref/파일/view 변조, 링크·소유자·한도·원시 오류 비노출 |
| 제어·중단·보고 | passed | 7단계×취소/편집/삭제, 실제 controller SIGKILL 7지점, 새 인스턴스 관찰·소비/작업물 보존·재실행 거부. 이 행의 backend는 모의 |
| 실제 Docker 격리 진단·실행 7건 | passed | 새로운 로컬 환경의 sandbox-check와 아래 실제 실행 결과 |
| 실제 Docker 취소·강제 종료 복구 | passed | 실제 Running 관찰 뒤 취소와 SIGKILL, created/starting SIGKILL, 설정 불일치 BLOCKED 후 소유 container 정리 5건 |
| 실제 Codex·회사 GitLab·회사 저장소·업무 메시지 | not_run | 고정 합성 자료만 사용하며 실제 서비스 연결 경로 없음 |
| 작업 결과 commit·push·PR/MR | not_run | 코드 변경 승인에 포함하지 않고 실행 명령을 제공하지 않음 |

전체 회귀 로그는 `/private/tmp/work-assistant-harness-stage4c3-final-tests.log`, 실제 합성 Docker 로그는 `/private/tmp/work-assistant-harness-stage4c3-live.log`, 실제 취소·복구 로그는 `/private/tmp/work-assistant-harness-stage4c3-live-recovery.log`다. 최초 TypeScript 검사에서 잘못된 JSON fixture의 타입 단언 오류 1건을 수정한 뒤 빌드와 전체 회귀를 통과했다.

### 실제 Docker 근거

현재 엔진은 Linux `aarch64`·Engine 28.3.3·cgroup v2이며 과거 3-D 문서의 엔진·이미지와 다르다. 이전 이미지는 로컬에 없었다. 빈 Docker 설정으로 공식 `node:24.22.2-bookworm-slim`을 준비하고 이미지 ID `sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`, Node 24.22.2를 확인해 새 로컬 설정과 각 승인 계획에 고정했다. [Node 공식 배포 기록](https://nodejs.org/en/download/archive/v24.22.2)

`sandbox-check`의 실제 격리 진단을 통과한 뒤 다음을 실행했다. 모든 작업에서 source hash, 원본 HEAD/main, 작업 main/ref, 작업 브랜치 HEAD, 정확한 diff와 readonly view 보존을 확인했다. 정상·실패 모두 자기 container의 stopped/removed가 true다.

| 유형·fixture | Task ID | 결과 |
| --- | --- | --- |
| feature·success | `044c9d1e-febc-496d-81ba-84a273107315` | SUCCEEDED, 검사 exit 0 |
| fix·success | `ad848b76-37d2-4f7b-9035-2fa3dd1ef663` | SUCCEEDED, 검사 exit 0 |
| chore·success | `144229e9-8305-4f8c-acd0-0fa5b7221786` | SUCCEEDED, 검사 exit 0 |
| refactor·success | `e09f0dc3-f41f-41d9-aec0-45750c2d1534` | SUCCEEDED, 검사 exit 0 |
| fix·test-failure | `80c48c5f-647f-46d9-b790-31348ce60247` | FAILED, 검사 exit 1 |
| chore·timeout | `823a664b-c9df-4dd9-80ca-5d355a470f1d` | FAILED, timeout·종료 확인 |
| refactor·output | `1c84798a-7115-4916-8ab2-7fe974244c10` | FAILED, output_limit·종료 확인 |
| Running 확인 후 취소 | `1784b275-9937-4b98-ab6c-90c2d34bb1ef` | CANCELLED, 실행 중 자기 container 정리 |
| container_created에서 SIGKILL | `7ac3194c-c7bc-48c1-9f30-95fd03b4c192` | INTERRUPTED, 검사 not_run·소유 container 정리 |
| container_starting에서 SIGKILL | `b4c8bf8a-10bf-4a3e-929d-12205a975757` | INTERRUPTED, 검사 결과 불확실·소유 container 정리 |
| 실제 Running 확인 후 SIGKILL | `68d86881-4c29-4c17-8f13-abf1dfd3a785` | INTERRUPTED, 실행 중 자기 container 정리 |
| 복구 설정 불일치 후 올바른 설정 재복구 | `3a1e4eb7-5656-4893-b378-534cbbf3246f` | BLOCKED 기록 보존, 이후 소유 container 정리 확인 |

합성 증거는 `/private/tmp/harness-stage4c3-live-2YnnMZ/`에 보존했다. `diagnostic-result.json`, `results.json`, `recovery-results.json`과 각 작업의 별도 DB·승인 snapshot·lifecycle·`report.json`이 근거다. 취소·복구 5건도 source/main/작업 ref·diff 보존, 소비 승인 유지, 실제 container 부재, 재실행 거부를 확인했다. 재복구로 정리를 확인해도 기존 BLOCKED 결과를 성공으로 바꾸지 않는다. 인증 정보·회사 자료는 사용하지 않았다. 공식 이미지 초기 준비와 런타임의 자동 pull 금지(`--pull never`)는 구분한다.

## 한계와 다음 최소 작업

하네스 controller와 동일 OS 사용자, Docker daemon·VM·커널은 신뢰 경계다. 이 기능은 고정 합성 patch와 등록 검사를 연결하며 범용 Codex 코드 수정·임의 저장소·명령·패키지 설치를 지원하지 않는다. 실제 회사 보안 검토 통과나 악성 호스트에 대한 완전한 격리를 의미하지 않는다. 파일 작업 도중 중단된 부분 변경과 불확실한 container 정리는 성공으로 판단하지 않는다.

다음 최소 작업은 실제 Codex 연결 방식을 결정하고 별도 계획을 만드는 것이다. 검토 가능한 patch만 제안받는 방식과 격리 공간에서 직접 수정하는 방식의 쓰기 권한·자료 전송·인증·네트워크·검사·취소 기준을 확정해야 한다. 이번 합성 승인을 실제 실행 권한으로 재사용하지 않으며 PR/MR 생성 제외 규칙을 유지한다.
