# 단계 3-D 구현 결과

## 범위와 상태

2026-11-10에 **합성 실행의 요청 무효화·소유자 취소·실행 단계 영속화·명시적 중단 복구·잔여 변경 관찰**을 구현했다. 단계 3-C의 고정 fixture·실행 계획·새 승인·Docker 경계를 유지하며 기존 조사 Task나 실제 Slack 요청을 실행으로 연결하지 않는다. 실제 AI·회사 저장소·임의 patch·명령은 범위 밖이다.

`execution-cancel`·`execution-invalidate`·`execution-recover`를 추가했다. 기존 `ExecutionPort`는 항상 거부하고 `run`은 `UNKNOWN_COMMAND`다. 자동 재실행·소비 승인 복원·외부 메시지·Git push/PR·병합·배포·작업물 삭제는 제공하지 않는다. 기존 단계 1·2·3-A·3-B·3-C 결과 문서는 당시 검증 기록으로 보존했다.

## 구현과 데이터 흐름

```text
execution-plan → 합성 requestId·revision 1·generation 0
execution-approve → 같은 TX에서 요청 fence 확인 → 새 실행 승인
execution-run → 승인 소비 + Run + claimed lifecycle 원자 commit
  → FS guard·중간 파일/Git/view 증거·diff·검사 저장
  → 생성 전 name/token/Run journal → 동기 dispatch → 생성 후 전체 ID
  → Run label·권한 재검증 → 동기 start dispatch → 명령 결과·정리 저장
execution-cancel / execution-invalidate → 짧은 TX로 요청 무효화·승인 revoke
  → controller fence·polling → 새 동작 차단·소유 container 정리
execution-recover → 소유 container 정리·영속 증거로 파일 관찰
  → INTERRUPTED / CANCELLED / BLOCKED, 자동 실행 재개 없음
execution-inspect → 단일 DB snapshot → 누락 완료 보고서 재생성
```

| 변경 파일 | 책임 |
| --- | --- |
| `src/domain/execution.ts`, `src/ports/execution.ts` | 요청 제어·lifecycle·workspace/container 증거·관찰·cleanup·snapshot·dispatch 계약 |
| `src/adapters/sqlite-execution-store.ts` | 요청/이벤트 멱등 처리·승인 fence·원자적 claimed/finished·중간 기록·추가 전용 감사 이력·FS guard·spawn dispatch·단일 조회 snapshot·legacy backfill |
| `src/application/execute-synthetic.ts` | 단계별 fence·50ms 제어 polling·중간 저장·취소 종료·복구 전용 조사·원본 검증·최종 결과 |
| `src/adapters/docker-execution.ts` | 생성 전/후 journal hook·Run label·물리 dispatch gate·정확한 소유권과 ID 부재 확인·복구 시 자기 container만 정지/제거 |
| `src/adapters/execution-workspace.ts` | 영속 증거 제공·새 프로세스의 부분 파일/추가/삭제/권한/Git/view 관찰·링크와 민감 본문 접근 차단 |
| `src/cli/execution.ts` | 취소·편집/삭제·복구 CLI·제어/조회 lease 분리·일관된 snapshot·비공개 로컬 보고 |
| `tests/execution-lifecycle-store.test.ts`, `tests/execution-observation.test.ts` | 취소/소비/guard 경합·불변 기록·rollback·snapshot/dispatch·재시작 관찰과 위험 파일 경계 |
| `tests/docker-execution.test.ts`, `tests/docker-recovery.test.ts` | lifecycle hook 순서·시작 전 거부·소유권/Run label/ID/이름 변경·정리 미확인·Docker 오류 비노출 |
| `tests/execution-cancellation.test.ts`, `tests/execution-crash.test.ts`, `tests/execution-control-cli.test.ts` | 7개 단계×3종 제어·실행 중 polling·실제 child SIGKILL·복구/재시작·CLI lease와 옵션 |
| `tests/execution-workflow.test.ts` | 기존 정리 미확인 결과를 `BLOCKED`로 구분하는 회귀 보완 |
| `README.md`, `docs/architecture.md`, `docs/security-and-approval.md`, `docs/implementation-plan.md`, 이 문서 | 명령·권한·현재 구현과 검증 범위 |

의존성·패키지 매니저·lockfile은 변경하지 않았다. 하네스 Node 26.12.1·pnpm 12.18.0과 컨테이너 Node 24.22.2를 구분한다. 기존 읽기 worker의 네트워크·하위 프로세스 제한도 유지했다.

## 제어·취소와 잠금 계약

합성 요청은 `requestId: synthetic:<task-id>`, `revision: 1`, `generation: 0`으로 시작한다. OS 소유자는 현재 UID의 `os-user:<uid>`이며 CLI나 이벤트에서 임의 지정하지 못한다. 편집·삭제는 현재보다 큰 정수 revision만 적용하고 최대 1000000000이다. 같은 이벤트 ID·같은 payload는 멱등 처리하며 다른 payload의 ID 재사용은 거부한다. 오래된 revision은 상태를 되돌리지 않고 이벤트 기록만 보존한다.

취소·편집·삭제는 generation·무효화 시각·이유를 저장하고 미소비 승인을 revoke한다. 대기 Task는 `CANCELLED`, 실행 중 Task/Run은 controller가 정리를 확인할 때까지 `RUNNING`으로 남는다. 승인 생성·소비와 Run 종료는 같은 DB 트랜잭션에서 요청 상태를 확인한다. 취소가 먼저 commit되면 성공 종료를 차단하고, 완료가 먼저 commit되면 뒤늦은 제어로 terminal 결과를 다시 열지 않는다. 승인 `usedAt`은 되돌리지 않는다.

`execution-cancel`·`execution-invalidate`·`execution-inspect`만 전역 lease를 우회한다. 계획·승인·실행·복구와 실제 Slack 수신은 기존 전역 lease로 직렬화한다. 이 경로는 합성 이벤트 전용이며 실제 Slack 메시지와 실행 Task를 연결하지 않는다. 수신 중단 구간의 Slack 변경 감지도 보장하지 않는다.

짧은 FS guard는 파일 작업이 끝날 때까지 취소 writer를 기다리게 한다. 이미 commit된 취소 뒤에는 새 파일 동작을 시작하지 않는다. Docker create/start는 동기 dispatch 트랜잭션에서 generation을 확인하고 실제 CLI spawn 호출까지만 잠금을 유지한다. RPC 응답은 잠금 밖에서 기다린다. 취소 전 전달된 RPC나 이미 바뀐 파일은 되돌아가지 않으며 소유 container 정리와 잔여 관찰 대상으로 남는다.

## 영속 기록·복구와 보고

승인 소비·Run INSERT·Task `RUNNING`·최초 `claimed` lifecycle을 한 트랜잭션으로 저장한다. 생성 전 이름·소유 토큰·Run ID, 생성 뒤 전체 container ID를 영속하고 실제 container에 소유 토큰·Run label을 붙인다. workspace 경로·계획/Git/view 해시, 중간 diff·검사·명령 결과를 저장한다. identity는 임의 변경할 수 없고 container ID와 view hash의 최초 확정만 허용한다. 제어 이벤트와 순번 lifecycle 이력은 추가 전용이며 terminal 전환과 `finished` 기록도 원자적이다.

`execution-recover`는 새 코드를 실행하지 않는다. 기록한 이름·소유 토큰·Run label·전체 ID를 대조해 자기 container만 정지·제거한다. 이름 조회에서 보이지 않아도 기록한 ID의 부재까지 확인한다. 생성 응답이 불확실하고 ID가 없으면 현재 부재만으로 정리를 확정하지 않는다. 과거 3-C의 소유 정보 없는 Run은 `legacy_untracked`·`BLOCKED`로 보존하며 광범위 조회·kill을 하지 않는다.

새 workspace 인스턴스가 영속 증거로 부분 patch·추가·삭제·권한·symlink·특수 파일·Git·실행 view를 관찰한다. 경로 집합·파일 수·바이트·UID·권한을 확인하고 링크를 따라가거나 권한을 고치지 않는다. 예상 밖 이름은 `unapproved:<sha256>`로 보고하며 본문은 읽지 않는다. 한도 초과·증거 누락·상태 변경은 관찰 실패로 남긴다. 승인된 완성 diff와 중단 후 관찰 결과는 별도 필드다. 부분 patch가 승인 내용과 다르면 `observation.changes`에 실제 해시와 범위 밖 상태를 기록한다.

정리와 관찰이 확인된 중단은 `INTERRUPTED`, 확인된 취소는 `CANCELLED`, 정리·관찰이 불확실하면 `BLOCKED`다. 이미 `BLOCKED`인 Run을 재조사해 정리에 성공해도 기존 Run과 완료 보고서를 덮어쓰지 않는다. 최신 근거는 lifecycle의 `cleanup`·`observation`에 추가하고 Run은 `BLOCKED`로 유지한다. 새 실행에는 새 계획과 새 승인이 필요하며 기존 Task의 Run·소비 승인을 재사용하지 않는다.

`execution-inspect`는 Task·요청 상태·승인 페이지·Run·lifecycle을 단일 DB 트랜잭션에서 snapshot으로 읽고, 트랜잭션 종료 뒤 누락된 완료 보고서를 만든다. SQLite를 원본으로 삼으며 다른 내용의 기존 파일을 덮어쓰지 않는다. 중간 저장한 완성 diff가 최종 관찰의 실제 해시와 다르면 오래된 diff 본문은 제외하고 관찰 결과를 남긴다. 동결 원본·작업 영역·읽기 전용 view·보고서·소유권 기록을 검토용으로 보존한다. 원시 명령 출력·Docker 오류·민감 파일 본문은 보고서에 넣지 않는다.

## 사용 가능한 명령

기존 `execution-plan`·`execution-approve`·`execution-run`과 같은 `--data-dir`를 사용한다. 복구 설정은 원래 계획과 일치하는 실제 로컬 backend 설정이어야 한다.

```sh
pnpm harness execution-cancel --task <id> --event-id synthetic-cancel-1 --data-dir /private/tmp/harness-execution-data
pnpm harness execution-invalidate --task <id> --event edited --revision 2 --event-id synthetic-edit-2 --data-dir /private/tmp/harness-execution-data
pnpm harness execution-invalidate --task <id> --event deleted --revision 3 --event-id synthetic-delete-3 --data-dir /private/tmp/harness-execution-data
pnpm harness execution-recover --task <id> --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-execution-data
pnpm harness execution-inspect --task <id> --approval-offset 0 --data-dir /private/tmp/harness-execution-data
```

취소의 `--event-id`는 생략할 수 있고 새 UUID를 생성한다. 편집·삭제에는 `--event edited|deleted`·`--revision 2..1000000000`·`--event-id`가 필수다. `execution-cancel`은 조회한 현재 revision에 취소를 적용한다. `execution-recover`의 `--config` 기본값은 비활성 예제이며 container 정리가 필요한 작업은 원래 활성 설정이 없으면 `BLOCKED`다. `execution-inspect`는 기존 승인 페이지 옵션을 유지하며 `requestState`·`lifecycles`도 반환한다.

## 검증 결과

| 항목 | 결과 | 근거 또는 미실행 사유 |
| --- | --- | --- |
| `pnpm lint` | passed | 오류 없음 |
| `pnpm typecheck` | passed | 오류 없음 |
| `pnpm test` | passed | 271개, 실패·건너뜀 0. 기존 214개 + 신규 57개 |
| `pnpm build` | passed | 통합 TypeScript 빌드 완료 |
| 제어·승인 소비·종료·guard 경합과 rollback | passed | 실제 SQLite·별도 Worker/store, 취소 전/후 소비와 terminal 경합·중복/역순 이벤트·불변 감사 이력 |
| snapshot·물리 dispatch 원자성 | passed | 단일 snapshot·legacy backfill·반환 객체 분리, 취소 뒤 dispatch callback 0회·RPC 대기 중 제어 commit |
| 단계별 합성 취소·편집·삭제 | passed | 7개 단계×3종 제어 21개 시나리오·실행 중 polling·정리 실패 `BLOCKED`·finalizing 신호 취소와 완료 후 신호 경합 |
| 실제 child-process SIGKILL 후 재시작 | passed | 9개 위치의 controller 강제 종료·새 store/service/workspace로 복구, 자동 재실행·소비 복원 없음. backend는 모의 어댑터 |
| 부분 파일·추가·삭제·권한·Git/view·위험 파일 관찰 | passed | 새 인스턴스 관찰·링크/특수 파일/한도/민감 본문·이름 비노출·보호 자료 불변·변경 128개 상한의 실패 기록·오래된 diff 제외 |
| Docker hook·소유권·ID·복구 오류 | passed | 모의 daemon 응답으로 생성 전/후 순서·Run label/ID 불일치·불확실 생성·이름 변경 잔존·오류 원문 비노출 확인 |
| 제어 CLI와 실행 소유 lease 분리 | passed | 별도 subprocess에서 제어/조회 허용·실행/복구 lease 유지·옵션과 소유자 검증 |
| 실제 Docker 정상·취소·편집·삭제·강제 종료 복구 | passed | 아래 6개 시나리오. 정상 SUCCEEDED·3종 무효화 CANCELLED·SIGKILL 복구 INTERRUPTED, stopped/removed true·원본 불변 |
| 실제 Docker 설정 불일치 차단·재복구 정리 | passed | 잘못된 설정은 BLOCKED. 올바른 설정 재조사로 정리를 확인해도 기존 Run/보고서 BLOCKED 불변 |
| 실제 Slack·AI·회사 저장소·외부 메시지·Git 원격 작업 | not_run | 이번 합성 범위에 연결하지 않음 |

신규 57개는 store 15개·workspace 관찰 9개·Docker hook 2개/복구 5개·취소/복구 14개·실제 process crash 9개·CLI 제어 3개다. 최종 회귀 271개에 신호 경합·관찰 상한·과거 diff 제거 검증을 포함했다. `finalizing` 중 외부 신호는 `OWNER_CANCELLED`와 `CANCELLED`로 기록하고, 완료 commit 뒤 신호는 `SUCCEEDED`를 바꾸지 않는다. 관찰 변경이 128개를 넘으면 한도 실패와 최대 128개의 변경을 저장한다. 테스트의 모의 backend와 실제 child-process 종료를 실제 Docker 정리 검증과 구분한다.

### 실제 Docker 근거

macOS `darwin/arm64`, Docker Desktop Linux `aarch64`·Engine 29.4.3, 컨테이너 Node 24.22.2에서 고정 로컬 이미지 `sha256:0efee1e068d21f6edcab7fa8c962fc4ecd50d4e28727bc23963379b63ee318ab`를 사용했다. 실제 결과는 다음과 같다.

| 시나리오 | Task ID | Run ID | 실제 결과 |
| --- | --- | --- | --- |
| 정상 등록 검사 | `e2e65569-a7e4-4ff7-a1c4-0230699bfca2` | `5ad6fd79-3271-440b-b857-37bbcdd6235d` | SUCCEEDED·종료 0·정지/제거 확인 |
| 실행 중 소유자 취소 | `751785d0-5858-484b-8d35-65f198309e6f` | `70a2734d-b537-4eff-8592-b85963398a45` | CANCELLED·aborted·종료 137·정지/제거 확인 |
| 실행 중 합성 편집 | `fc9d249d-1229-4512-8ca4-ad7dd6f0f76c` | `e12b38f0-9ef3-44c9-86a1-8ab34c38df74` | revision 2·CANCELLED·aborted·종료 137·정지/제거 확인 |
| 실행 중 합성 삭제 | `3a4cc7a6-8939-4e72-b588-982eab774038` | `b51805fc-ee6b-4f59-82e7-6991efeadbe7` | revision 2·CANCELLED·aborted·종료 137·정지/제거 확인 |
| controller SIGKILL 후 복구 | `53022ee6-ed5f-440c-99df-384a12a460b3` | `1d764395-3bfd-4f02-9d4c-193a92dc5e67` | INTERRUPTED·소유 container 종료 137·정지/제거·반복 복구 상태 불변 |
| SIGKILL 뒤 잘못된 설정과 재복구 | `34aaff1c-1c04-43d4-b3d0-618447eef509` | `fe0bb72d-7fab-496f-822c-6b6dada9f39e` | 최초 BLOCKED·설정 수정 후 정지/제거 확인·Run/보고서는 BLOCKED 유지 |

제어·강제 종료 5개는 저장된 `container_starting` 단계와 실제 전체 container ID를 확인한 뒤 수행했다. 취소·편집·삭제는 generation 1과 각각 `OWNER_CANCELLED`·`REQUEST_EDITED`·`REQUEST_DELETED`를 남겼다. 세 Run의 재사용은 `EXECUTION_CANCELLED`, 중단·BLOCKED Run의 재실행은 `APPROVAL_REQUIRED`로 거부했다. 여섯 작업의 승인 `usedAt`은 모두 남고 `revokedAt`은 `null`로 보존됐다.

여섯 작업 모두 원본의 `sourceBeforeHash === sourceAfterHash`이고 승인된 `src/message.mjs` 한 파일 diff를 보존했다. 정상 작업의 원본 전후 해시는 `9039b82edc9c12a28e37d8783ab84229f10aa72d4fd5c96d9500b78f736cda38`다. crash 복구는 Git·view 불변과 승인된 한 파일의 실제 변경 해시를 관찰했다. 잘못된 설정의 최초 실패 코드는 `EXECUTION_RECOVERY_BACKEND_UNAVAILABLE`이며, 재조사의 lifecycle은 cleanup 정지/제거와 observation passed를 기록해도 이전 Run의 BLOCKED와 실패 검사를 수정하지 않았다. 최종 소유 execution container 조회 결과는 비어 있었다.

증거는 이 개발 환경의 `/private/tmp/harness-stage3d-oHCWVR/final-results.json`과 각 `data/executions/<task-id>/run-<artifact-id>/report.json`, `execution.sqlite`에 보존했다. 이 문서는 실제 JSON·완료 보고서와 승인 DB의 `usedAt`·원본 해시를 대조했다. 임시 경로의 증거는 해당 로컬 환경에 한정하며 Git에 포함하지 않는다.

## 수용 기준과 남은 범위

수용 14는 취소·강제 종료 뒤 자동 재실행이 없고 승인·Run·잔여 변경을 보존하는 것으로, 36은 승인 소비 전후·부분 patch·생성/시작·검사·최종 commit 경합과 새 프로세스의 복구로 검증한다. 수용 15는 Slack 쓰기·push/PR 연결 없이 기존 거부를 유지하는 것으로, 16은 합성 비밀·위험 파일·원시 출력이 모델 입력·보고서·Git 추적 자료로 유입되지 않는 회귀로 확인한다. 실제 비밀이나 회사 자료를 넣어 시험하지 않는다.

검증 환경은 macOS `darwin/arm64`와 Docker Desktop Linux `aarch64`, Engine 29.4.3·cgroup v2·기본 seccomp, 컨테이너 Node 24.22.2다. Docker daemon·Desktop VM·Linux 커널과 같은 OS 사용자는 신뢰 경계다. 범용 악성 코드 실행·container escape의 완전한 방어·회사 보안 검토 통과를 주장하지 않는다.

실제 Slack/AI/업무 저장소의 조사와 실행 연결, 회사 승인·데이터 반출 정책, 임의 patch·명령·패키지 설치·비밀 주입·다른 OS/backend는 별도 작업이다. 단계 4의 답장·push/PR·Gmail/Calendar/Drive도 각각 독립 승인과 정책이 필요하다. 다음 최소 작업은 원하는 실제 연결 범위를 정하고 별도 데이터·권한·검증 계획을 만드는 것이다.
