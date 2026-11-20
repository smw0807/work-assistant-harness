# 단계 3-C 구현 결과

## 범위와 상태

2026-11-10에 **독립 합성 실행 계획·새 소유자 승인·고정 patch·등록 검사·Run과 실제 diff 보고**를 구현했다. 기존 조사 Task와 단계 3-A의 `approval-only-v1` 기록을 실행으로 승격하지 않고, 별도 `execution-*` CLI와 `execution.sqlite`를 사용한다. 단계 3-B의 진단 보고서도 실행 권한으로 사용하지 않는다.

실제 Slack·AI·회사 저장소·임의 대상 경로를 연결하지 않는다. 기본 `ExecutionPort`의 항상 거부 동작과 `run`의 `UNKNOWN_COMMAND`는 유지한다. 외부 메시지·Git push·PR·병합·배포·사용자 작업 정리도 제공하지 않는다. 실행 중 요청 무효화·소유자 취소·controller 강제 종료 후 복구는 단계 3-D 범위다.

## 구현과 데이터 흐름

```text
execution-plan → 고정 합성 원본·Git 커밋 준비·동결 → 계획 해시 → AWAITING_APPROVAL
execution-approve → 원본·설정·OS 소유자·TTL 검증 → 불변 계획 snapshot·새 승인 → APPROVED
execution-run → 원본·계획·승인·설정·실제 backend 재검증
  → 승인 소비 + Run INSERT + RUNNING을 원자 commit
  → 독립 Git 작업 트리 → 고정 replace → 실제 diff
  → Git 없는 읽기 전용 container view → 등록 검사
  → 원본 전후 해시·검사별 결과·종료·제거 확인 → SUCCEEDED / FAILED
execution-inspect → SQLite 감사 기록과 최신 승인 한 건·완료 보고서
```

| 경로 | 책임 |
| --- | --- |
| `src/domain/execution.ts`, `src/ports/execution.ts` | 실행 계획·patch·명령·정책·새 승인·Run·저장소·격리 실행 계약 |
| `src/policy/execution-policy.ts` | 정확한 계획 스키마·고정 명령 registry·정책·설정 해시와 변경 거부 |
| `src/adapters/execution-workspace.ts` | 고정 합성 원본 준비·동결·Git 검증, 독립 작업 트리·허용 patch·실제 diff·읽기 전용 실행 view |
| `src/adapters/sqlite-execution-store.ts` | 별도 SQLite Task·불변 승인·원자적 1회 소비와 Run, 만료·terminal 상태·이력 페이지 |
| `src/adapters/docker-execution.ts` | 고정 backend preflight·정확한 container 실행 정책·한도·출력 해시·소유 container 정지와 제거 |
| `src/application/execute-synthetic.ts` | 실행 전 검증·승인 소비·patch·등록 검사·실패와 미실행 결과·원본 전후 검증 |
| `src/cli/execution.ts`, `src/cli/main.ts` | NestJS context 기반 별도 CLI·고정 옵션·lease·OS 소유자·비공개 보고서·조회 재생성 |
| `src/cli/runtime.ts` | 소스 하위의 `..` 접두사 디렉터리를 내부 경로로 판별하는 경계 보완 |
| `tests/execution-store.test.ts`, `tests/execution-workspace.test.ts`, `tests/execution-workflow.test.ts`, `tests/docker-execution.test.ts`, `tests/runtime.test.ts` | 계약·파일·승인·경합·rollback·정책·실행·CLI·기존 경계 회귀 |
| `README.md`, `docs/architecture.md`, `docs/security-and-approval.md`, `docs/implementation-plan.md`, 이 문서 | 현재 명령·범위·검증 근거·한계와 다음 단계 |

패키지 매니저·의존성·lockfile과 기존 조사 worker의 네트워크·하위 프로세스 제한은 변경하지 않는다. 기존 단계 1·2·3-A·3-B 결과 기록은 당시 범위의 기록으로 보존한다.

## 계약과 승인 경계

- `repoId: synthetic-execution`, `requestRevision: synthetic-1`인 고정 fixture만 지원한다. 모델·이벤트 본문·README의 악성 지시는 실행 권한이 되지 않는다.
- 수정 허용 파일은 `src/message.mjs` 하나다. `before` 고정 내용에서 `approved` 또는 고의 실패용 `wrong` 고정 내용으로 교체한다. 원본 해시·내용·정확한 patch를 적용 전에 확인한다. 생성·삭제·이름 변경·실행 비트·symlink·hardlink·서브모듈·설치·검사 설정 변경은 지원하지 않는다. 읽기 근거 목록은 수정 허용 범위와 분리한다.
- `synthetic-check-v1`, `synthetic-timeout-v1`, `synthetic-output-v1` 중 fixture가 선택한 등록 명령 하나만 실행한다. `/usr/local/bin/node`, 고정 argv·인자 없음·cwd `/workspace`·최소 환경·네트워크 없음·한도와 `synthetic-execution-v1` 정책을 계획 해시에 결합한다. shell·사용자 제공 argv를 허용하지 않는다.
- 기준 커밋·원본 전체 해시·patch 전후 해시·고정 내용·명령 전체 사양·Engine·Node·이미지 ID·설정 해시를 승인 snapshot에 보존한다. 설정의 `enabled`·socket 변경도 새 계획과 승인을 요구한다.
- 소유자는 실제 `process.getuid()`의 `os-user:<uid>`이고 UID 미지원은 거부한다. TTL은 필수 정수 1~1440분이다. 승인 없음·만료·다른 소유자·변조·다른 계획/커밋/revision·정책 변경·재사용은 승인 소비나 patch 이전에 차단한다.
- 승인 소비·Run INSERT·Task의 `RUNNING` 전환은 단일 `BEGIN IMMEDIATE` 트랜잭션이다. SQL 실패는 모두 rollback하며 별도 두 Worker/store의 실제 동시 경합에서도 한 번만 소비한다. task당 Run은 하나이며 실패·완료 후 재승인·재실행을 허용하지 않는다. 승인 snapshot·usedAt·Run 감사 기록은 재시작 후에도 보존한다.

## 격리와 결과 보존

실제 backend는 3-B와 같은 macOS `darwin/arm64`, Docker Desktop Linux `aarch64`, Engine `29.4.3`, cgroup v2·기본 seccomp다. 컨테이너 Node는 `24.22.2`, 로컬 공식 `node:24.22.2-alpine3.23`의 전체 이미지 ID는 `sha256:0efee1e068d21f6edcab7fa8c962fc4ecd50d4e28727bc23963379b63ee318ab`다. 하네스의 Node 26.12.1과 구분한다. 고정 backend identity·설정·실효 container 정책이 다르면 거부하고 자동 pull·build·설치·다른 backend 대체를 하지 않는다.

동결 원본에서 같은 커밋의 **독립 Git 저장소**를 고정 파일로 재생성한다. 원본 `.git`을 공유하는 `git worktree`가 아니다. patch 적용 후 container에는 `.git` 없는 읽기 전용 실행 view만 마운트한다. 원본·승인 DB·하네스·호스트 홈·Docker socket은 노출하지 않는다. 호스트에서 검사 파일을 실행하거나 import하지 않는다.

| 제한 | 적용 값 |
| --- | --- |
| 쓰기 영역 | `/tmp`의 16MiB tmpfs, `rw,noexec,nosuid,nodev,mode=1777`; workspace·root는 읽기 전용 |
| view 상한 | 파일 16개·전체 64KiB, 링크·특수 파일·쓰기 가능한 파일·Git 경로 거부 |
| 권한·네트워크 | UID/GID `1000:1000`, 모든 capability 제거, no-new-privileges·기본 seccomp·private cgroup·IPC, `network none` |
| 메모리·swap | 128MiB·swap 0 |
| PID·CPU | 64개·0.5 CPU |
| 시간·출력 | 3초·stdout/stderr 합계 16KiB |

생성 후 시작 전 inspect에서 명령·mount·tmpfs·환경·권한·네트워크·자원 한도를 정확히 대조한다. 성공 fixture의 고정 검사도 실제 readonly·UID·환경·Git 미노출·16MiB tmpfs와 20MiB 쓰기의 `ENOSPC`를 확인한다. 시간·출력 fixture는 detached child를 만들며 7.5초 자체 watchdog을 보조 장치로 둔다. controller는 시간·출력 초과와 정상 신호 취소 때 소유 container만 종료하고 정지·제거를 확인한다. 이 장치를 강제 종료 후 crash 복구 구현으로 설명하지 않는다.

원시 stdout/stderr·Docker 오류는 보관하지 않는다. 수신한 바이트 수·출력 해시·고정 오류 코드만 Run에 남긴다. 출력 한도는 수신 chunk에서 초과를 감지하므로 관찰한 `outputBytes`가 16KiB보다 클 수 있다. 실제 diff에는 합성 파일의 전후 내용·해시를, 검사에는 `passed`·`failed`·`not_run`과 이유를 기록한다. 원본과 Git 메타데이터의 전후 전체 해시도 비교한다.

자료는 `<data-dir>/execution.sqlite`, `<data-dir>/executions/<task-id>/source/`, `run-<artifact-id>/worktree/`, `container-view/`, `report.json`에 보존한다. 비공개 부모는 `0700`, SQLite·보고서는 `0600`이며 동결 원본·view는 읽기 전용이다. SQLite가 원본이며 `execution-inspect`는 누락된 완료 보고서만 재생성한다. 기존 보고서의 링크·다른 내용은 덮어쓰지 않는다. 승인 이력은 최신 한 건씩 `{ approvals, approvalPage: { offset, total, nextOffset } }`로 조회한다. 작업물은 자동 commit·push·삭제하지 않는다.

## 사용 가능한 명령

```sh
pnpm harness execution-plan --fixture success --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-execution-data
pnpm harness execution-approve --task <id> --plan-hash <sha256> --base-commit <sha1> --expires-in-minutes 30 --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-execution-data
pnpm harness execution-run --task <id> --plan-hash <sha256> --base-commit <sha1> --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-execution-data
pnpm harness execution-inspect --task <id> --approval-offset 0 --data-dir /private/tmp/harness-execution-data
```

`execution-plan`의 `--fixture`는 기본 `success`이며 `test-failure`, `timeout`, `output`을 선택할 수 있다. `--config` 기본값은 비활성 `config/sandbox.example.json`이다. 비활성 계획은 만들 수 있지만 승인·실행할 수 없다. 활성화하려면 3-B에서 검증한 실제 로컬 identity와 `enabled: true`인 비공개 설정으로 새 계획을 만든다. 계획·승인은 Docker를 호출하지 않는다. 동일한 `--data-dir`를 사용하고 출력의 정확한 작업 ID·계획 해시·기준 커밋을 검토해 입력한다. 실행 성공은 종료 코드 0, 실패·거부는 1이다.

## 검증 결과

| 항목 | 결과 | 근거 또는 미실행 사유 |
| --- | --- | --- |
| `pnpm lint` | passed | 오류 없음 |
| `pnpm typecheck` | passed | 오류 없음 |
| `pnpm test` | passed | 214개, 실패·건너뜀 0. 기존 171개 + 신규 43개(Docker 9·store 14·workspace 11·workflow/CLI 9) |
| `pnpm build` | passed | 최종 TypeScript 빌드 완료 |
| 승인·Run 원자성·경합·재사용·변조·만료 | passed | 실제 SQLite 트리거 오류 rollback·별도 두 Worker 경합과 저장소 검사 |
| patch 범위·원본·링크·Git·명령·정책 변경 거부 | passed | 파일 적용 전 거부와 원본/작업 트리 상태 비교 |
| CLI 기본 비활성·Docker 접속 0회·lease·보고서 복구 | passed | mock 및 subprocess CLI 수용 검사 |
| 실제 Docker 성공·검사 실패·시간/출력 초과 | passed | 아래 최종 4개 fixture. 성공은 SUCCEEDED, 고의 실패들은 FAILED로 구분 |
| 실제 readonly·UID·최소 환경·Git 미노출·scratch quota | passed | 성공 검사가 실제 경계를 확인하고 16MiB tmpfs에서 20MiB 쓰기 ENOSPC 확인 |
| 실제 container 정지·제거·원본 불변·승인 재사용 거부 | passed | 4개 모두 stopped/removed true·OOM 아님, 원본 전후 hash 동일·한 파일 diff, 재시도 APPROVAL_REQUIRED |
| 공백 포함 데이터 경로·재시작 조회 | passed | `Application Support/data`에서 실제 성공·원본 불변과 새 CLI 조회의 SUCCEEDED 확인 |
| 실행 중 요청 변경·소유자 취소·crash 경합·재시작 복구 | not_run | 단계 3-D 미구현. 강제 종료 `RUNNING`과 소비 승인을 보존하고 자동 재실행하지 않음 |
| 실제 Slack·AI·회사 저장소·외부 메시지·Git 원격 작업 | not_run | 이번 합성 실행 범위에 연결하지 않음 |

최종 전체 테스트 214개가 통과했고, 공백 경로 지원 보완 뒤 Docker 어댑터 9개·lint·build도 다시 통과했다. 실제 최종 4개 fixture는 readonly·scratch 경계 검사와 자체 watchdog을 반영한 코드로 실행했다.

| fixture | task ID | Run ID | 실제 결과 |
| --- | --- | --- | --- |
| `success` | `0f36452d-a806-495d-8dcd-716fa899bdd5` | `627a508e-8078-40cf-8867-8e5f38957b38` | SUCCEEDED, completed·코드 0 |
| `test-failure` | `567b9f67-957c-4f03-b939-d49062d59560` | `1351dd9d-3291-4425-8f2c-6bf6463c9765` | FAILED, completed·코드 1 |
| `timeout` | `0766c6c2-037f-45dc-83d8-d30e55f84baf` | `d4455a60-608d-4657-af33-5fecdbdd5ddc` | FAILED, timeout·코드 137 |
| `output` | `b1793578-e8c2-47f0-a357-6f67843eba53` | `50f1b603-a5f2-4e42-86ce-61542a2e15f2` | FAILED, output_limit·코드 137, 관찰 19,584바이트 |

기준 커밋은 `710f4b3301702c91b41bc90f32285d7d07d8ccab`다. 성공 fixture의 원본 전체 `sourceBeforeHash`와 `sourceAfterHash`는 모두 `0e4a6cf6b268394f491c288e6839a400dbd6118134d3e58989bf83a7450277be`다. 나머지 세 fixture도 각각 원본 전후 해시가 같고 `src/message.mjs` 한 파일만 승인 내용으로 변경했다. 네 command 모두 `stopped: true`, `removed: true`, `oomKilled: false`이며 원시 출력은 저장하지 않았다. 실패 세 경우의 Run 실패 코드는 `EXECUTION_CHECK_FAILED`이고 각 명령의 종료 유형과 코드를 별도로 보존했다. 네 작업의 재사용 시도는 모두 `APPROVAL_REQUIRED`로 거부했다.

실제 증거는 이 개발 환경의 `/private/tmp/harness-stage3c-FMfPpD/final-results.json`과 각 `data/executions/<task-id>/run-<artifact-id>/report.json`에 보존했다. 공백 경로 검증은 같은 루트의 `space-result.json`, task `e1c38ec3-5196-423b-bf77-7888c088f343`, Run `7ee139ac-d97e-42ea-b98c-a126d127bd33`이다. `Application Support/data`에서 SUCCEEDED와 원본 불변을 확인하고 새 CLI의 inspect에서도 SUCCEEDED를 조회했다. 임시 경로의 증거는 해당 로컬 환경에 한정하며 Git에 포함하지 않는다.

## 수용 기준과 남은 작업

수용 06~08은 새 승인·단일 실행·만료/위조/재사용·계획/커밋/revision 변경 거부로, 09~11은 기존 읽기 경계 유지와 합성 실행의 경로·링크·악성 자료·등록 명령 검증으로 확인한다. 12~13은 독립 작업 트리·실제 diff·등록 검사 성공/실패/미실행과 원본 불변으로 확인한다. 34~35는 고정 patch 계약과 명령·실행 정책의 승인 해시 결합으로 확인한다. 이 판정은 고정 합성 범위이며 실제 업무 저장소나 Slack 요청 실행의 승인이 아니다.

Docker daemon·Desktop VM·Linux 커널과 같은 OS 사용자는 신뢰 경계다. container escape의 완전한 방어·범용 악성 코드 실행·회사 보안 검토 통과를 주장하지 않는다. 실제 제품 저장소·AI가 생성한 patch·패키지 설치·검사 설정 변경·네트워크 목적지·비밀 주입·범용 자원 정책은 제공하지 않는다.

모든 새 CLI는 기존 전역 lease를 사용하므로 같은 데이터 디렉터리의 실시간 Slack 수신 중에는 거부된다. 수신 중단 구간의 Slack 변경 감지는 보장하지 않는다. 현재 소비된 승인은 실패·완료·중단 후 재사용할 수 없으며 controller 강제 종료로 남은 `RUNNING`도 자동 분류·복구·정리하지 않는다. 다음 최소 작업은 **3-D의 실행 중 요청 무효화·취소·controller crash 경합과 복구**다. 승인 소비 전후·patch 중·검사 중의 종료를 구분하고, 남은 프로세스·Run·승인·diff를 조사한 뒤 새 승인 필요 여부를 정확히 보고해야 한다.
