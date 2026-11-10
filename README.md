# work-assistant-harness

Slack 요청을 로컬에 기록하고, 합성 자료로 조사와 승인 후 격리 실행을 검증하는 업무 하네스입니다. **단계 0·1의 모의 조사, 단계 2의 Slack 읽기 수신, 단계 3-A의 로컬 승인·취소 기록, 단계 3-B의 Docker 격리 진단, 단계 3-C의 고정 합성 patch·등록 검사 실행, 단계 3-D의 합성 실행 취소·중단 복구·잔여 변경 관찰**을 구현했습니다. 검증 결과는 [단계 3-B](docs/stage-3b-result.md), [단계 3-C](docs/stage-3c-result.md), [단계 3-D](docs/stage-3d-result.md)에 기록합니다. 실제 Slack 권한·AI·회사 저장소 연결과 실행은 검증하지 않았습니다.

```text
로컬 이벤트 JSON
  → 워크스페이스·채널·사용자 ID 멘션 필터
  → SQLite 이벤트 중복 확인
  → 고정 모델 응답과 JSON 스키마 검증
  → 허용된 커밋·파일·줄 읽기
  → SQLite + 로컬 JSON 보고서
      문의: REPORTED
      변경 요청: AWAITING_APPROVAL
      불명확: NEEDS_CLARIFICATION
```

기본 실행은 합성 자료만 사용합니다. Slack 수신은 명시적으로 켜는 별도 경로이며 모델·제품 저장소와 연결하지 않습니다. 기존 조사와 단계 3-A는 `APPROVED`에서 멈추며 기본 `ExecutionPort`는 항상 거부하고 `run` 명령은 제공하지 않습니다. 단계 3-C는 별도 `execution-*` 명령에서 새 합성 작업·실행 승인을 만들고 고정 patch와 등록 검사만 실행합니다. 외부 메시지와 Git 원격 작업은 구현하지 않았습니다.

## 설치와 실행

검증 환경은 macOS, Node.js **26.12.1**, pnpm **12.18.0**입니다. `.node-version`, `packageManager`, 직접 의존성 버전과 `pnpm-lock.yaml`을 고정했습니다. 다른 OS는 아직 검증하지 않았습니다.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm harness replay --fixture inquiry
pnpm harness replay --fixture change
pnpm harness replay --fixture unclear
pnpm harness list
pnpm harness inspect <task-id>
```

`harness` 스크립트는 TypeScript를 빌드한 뒤 CLI를 실행합니다. HTTP 서버를 열지 않습니다. 이벤트·모델 응답·저장소는 모두 로컬 합성 자료이며 의존성 설치 후 실행에는 인터넷이나 토큰이 필요하지 않습니다.

출력의 `result.tasks`에서 작업 ID와 상태를 확인할 수 있습니다. `receiptPath`에는 실행 기록, `dataDirectory/reports/<task-id>.json`에는 작업 보고서가 있습니다. 보고서는 확인한 파일 근거, 모델이 제안한 사실·가설, 답변 초안 또는 계획, 위험, 검사 결과와 다음 승인 항목을 구분합니다. 근거 인덱스 검증은 문장의 의미적 정확성까지 보장하지 않으므로 초안을 검토해야 합니다.

패키지의 최신 안정 버전과 peer dependency를 공식 npm 레지스트리에서 확인했습니다. TypeScript 최신 계열 7은 선택한 `typescript-eslint`의 지원 범위 밖이라 호환되는 **6.0.3**을 사용합니다. `node:sqlite`는 Node 26의 내장 API이며 공식 문서상 release candidate입니다. [NestJS application context](https://docs.nestjs.com/standalone-applications), [Node SQLite](https://nodejs.org/api/sqlite.html), [Node 권한 모델](https://nodejs.org/api/permissions.html)을 기준으로 구현했습니다.

## 로컬 저장 위치와 재시작

기본 데이터 위치는 macOS에서 `~/Library/Application Support/work-assistant-harness`, Linux에서 `~/.local/share/work-assistant-harness`입니다. 다른 위치는 모든 명령에서 같은 `--data-dir`로 지정합니다.

```sh
pnpm harness replay --fixture change --data-dir /private/tmp/harness-demo-data
pnpm harness list --data-dir /private/tmp/harness-demo-data
pnpm harness inspect <task-id> --data-dir /private/tmp/harness-demo-data
```

데이터 폴더는 소스와 겹치지 않는 비공개 디렉터리여야 합니다. 새 폴더는 `0700`, SQLite와 보고서는 `0600`으로 만듭니다. 기존 폴더가 다른 사용자에게 열려 있으면 거부하며 임의로 권한을 바꾸지 않습니다. DB·저널의 symlink와 hardlink도 거부합니다.

- `tasks.sqlite`: 작업, 이벤트 중복 제약, 상태 이력, 근거와 계획, 별도 승인 테이블의 불변 계획 스냅샷과 승인·취소 이력. 모의 조사 작업은 원문 메시지와 모델 원문을 저장하지 않습니다. Slack 수집 자료의 별도 보관 범위는 아래 단계 2를 따릅니다.
- `harness-lock.sqlite`: 실행 소유권과 실시간 Slack 수신을 직렬화하는 SQLite 잠금. 합성 실행의 `execution-cancel`·`execution-invalidate`·`execution-inspect`는 짧은 별도 실행 DB 트랜잭션을 사용합니다. 프로세스 종료 시 OS가 잠금을 해제합니다.
- `reports/`: 작업별 JSON 보고서. DB에 저장된 자료로 누락된 보고서를 재생성합니다.
- `runs/`: 명령별 결과와 대상 전후 해시를 기록한 JSON 실행 기록.
- `execution.sqlite`, `executions/`: 독립 합성 작업·계획·승인·Run, 요청 revision·무효화·실행 단계 이력과 동결 원본·분리 작업 트리·읽기 전용 실행 view·보고서. 기존 `tasks.sqlite`의 작업과 승인을 실행에 사용하지 않습니다.

같은 이벤트는 재시작 후에도 다시 분석하지 않습니다. 중간에 종료된 `RECEIVED`, `TRIAGED`, `ANALYZED` 작업은 `BLOCKED`와 `INTERRUPTED_REVIEW_REQUIRED`로 남기고 자동 재실행하지 않습니다. 승인 대기 상태도 그대로 유지합니다. 만료된 승인은 상태 확인 시 취소 기록을 남기고 `AWAITING_APPROVAL`로 되돌립니다. 조사 작업과 승인 이력의 자동 보관 기간·삭제·재처리 기능은 아직 없습니다.

## 단계 3-A 로컬 승인·취소

변경 요청의 계획을 `inspect`로 확인하고, 표시된 해시와 기준 커밋을 그대로 승인 입력에 사용합니다. 유효기간은 1~1440분의 정수를 반드시 지정합니다.

```sh
pnpm harness inspect <task-id> --data-dir /private/tmp/harness-demo-data
pnpm harness approve <task-id> --plan-hash <sha256> --base-commit <sha1> --expires-in-minutes 30 --data-dir /private/tmp/harness-demo-data
pnpm harness inspect <task-id> --data-dir /private/tmp/harness-demo-data
pnpm harness inspect <task-id> --approval-offset 1 --data-dir /private/tmp/harness-demo-data
pnpm harness cancel <task-id> --data-dir /private/tmp/harness-demo-data
```

`--data-dir`를 생략하면 기본 데이터 위치를 사용합니다. `approve`는 `AWAITING_APPROVAL`인 변경 요청의 계획·요청 revision·저장소·기준 커밋을 검증하고, 불변 계획 스냅샷과 승인 기록을 `APPROVED` 상태 변경과 같은 트랜잭션으로 저장합니다. 활성 승인을 중복 생성하지 않습니다. 소유자는 `process.getuid()`로 확인한 `os-user:<uid>`이며 소유자 CLI 옵션이나 Slack 사용자 ID로 바꿀 수 없습니다. UID를 확인할 수 없는 OS에서는 거부합니다.

`inspect`는 취소·만료 기록을 포함한 승인 이력을 최신순으로 한 번에 1개씩 반환합니다. 선택 옵션 `--approval-offset <0..1000000000>`의 기본값은 `0`입니다. `result.approvals`는 해당 페이지이고 `result.approvalPage`는 `{ offset, total, nextOffset }`입니다. `nextOffset`이 있으면 그 값을 다음 `--approval-offset`에 넣어 이어 조회합니다. `approve`·`cancel` 응답도 최신 승인 1개와 같은 페이지 정보를 반환하며, 전체 이력은 DB에 보존합니다. worker 출력은 최대 1MiB로 제한합니다.

`cancel`은 `AWAITING_APPROVAL` 또는 `APPROVED`인 변경 요청을 `CANCELLED`로 바꾸고 기존 승인을 취소합니다. 만료 승인은 상태 확인 시 취소되고 작업이 다시 승인 대기 상태가 됩니다. 원본 요청의 편집·삭제도 Task 무효화와 같은 트랜잭션에서 승인을 취소하며, Task 계획·보고가 제거돼도 별도 승인 스냅샷은 보존합니다.

이 단계의 승인은 `executionPolicy: approval-only-v1`, `usedAt: null`인 기록입니다. 후속 실제 실행 정책의 승인으로 재사용하지 않습니다. 현재 기준 커밋 검증은 Task·계획·CLI 입력의 일치 검사이며 대상 저장소의 실행 직전 상태 검증은 후속 단계입니다. 승인 소비·Run 생성·실제 patch·대상 검사는 `not_run`입니다. `pnpm harness run <task-id>`는 `UNKNOWN_COMMAND`로 거부됩니다.

승인·취소는 기존 전역 프로세스 잠금을 사용합니다. 같은 데이터 디렉터리에서 `slack-listen`이 실행 중이면 거부되므로 수신과 동시에 승인하는 기능은 제공하지 않습니다. 수신 중단 구간의 Slack 편집·삭제 감지도 보장하지 않습니다. 실제 실행 전에는 수신·무효화·실행의 잠금과 취소 흐름을 추가 검증해야 합니다.

## 단계 3-B Docker 격리 진단

`sandbox-check`는 하네스에 고정한 합성 진단 코드 5개만 실행합니다. 작업 ID·대상 저장소·patch·임의 명령은 입력받지 않으며, 성공해도 `executionEnabled: false`를 유지합니다. 승인 기록을 소비하거나 `ExecutionPort`를 활성화하지 않습니다.

```sh
pnpm harness sandbox-check --data-dir /private/tmp/harness-sandbox-data
pnpm harness sandbox-check --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-sandbox-data
```

기본값인 `config/sandbox.example.json`은 `enabled: false`입니다. 첫 명령은 Docker에 접속하지 않고 차단 결과를 남깁니다. 두 번째 명령은 비공개 설정에서 `enabled: true`를 명시하고 Docker Desktop이 실행 중이며 지정 이미지가 로컬에 준비된 경우에 사용합니다. 설정에는 `/usr/local/bin/docker`, 실제 로컬 Unix socket의 절대 경로, 정확한 Engine 버전·Node 버전·이미지 전체 `sha256` ID와 `policyVersion: docker-probe-v1`을 고정합니다. 예제의 socket과 0으로 채운 이미지 ID는 자리표시자입니다. 자동 image pull·build·설치와 다른 backend 대체는 하지 않습니다. 실제 설정은 저장소 밖에 두며 `config/sandbox.local.json`도 Git에서 제외합니다.

지원 범위는 macOS `darwin/arm64` 호스트와 Docker Desktop의 Linux `aarch64` backend, cgroup v2, 기본 seccomp입니다. 이번 검증 환경은 Engine **29.4.3**, 컨테이너 Node **24.22.2**, 공식 `node:24.22.2-alpine3.23`의 이미지 ID `sha256:0efee1e068d21f6edcab7fa8c962fc4ecd50d4e28727bc23963379b63ee318ab`입니다. 하네스의 Node 26 요구사항과 컨테이너의 Node 버전을 구분합니다. 설정·daemon·image·유효 권한이 맞지 않으면 진단을 차단합니다.

진단은 workspace 한 곳만 쓰기 마운트하고, 호스트·원본·승인 DB·공유 Git을 나타내는 합성 canary를 그 밖에 둡니다. 경로·symlink·환경변수·Docker socket·root 파일시스템·외부 통신 접근 실패와 호스트 canary 전후 해시를 확인합니다. nonroot·capability 제거·seccomp·권한 상승 금지, 메모리 128MiB·swap 금지·PID 64개·CPU 0.5개 한도도 검사합니다. 별도 probe가 PID 생성 거부, OOM 종료, 1.5초 시간 초과, stdout/stderr 합계 16KiB 초과를 확인합니다. 시간·출력 검사는 하위 프로세스의 시작 증거와 종료 코드, 지연 파일 미생성까지 요구합니다. CPU 검사는 cgroup quota 값 확인이며 성능 벤치마크가 아닙니다.

결과는 `<data-dir>/sandbox-checks/<verificationId>/report.json`에 기록합니다. backend identity·한도·probe별 종료와 정리 결과·보호 영역 전후 해시를 남깁니다. 상태 `passed`는 종료 코드 0, `failed`·`blocked`는 1입니다. 생성한 probe container만 소유권을 확인해 종료·제거하고, 합성 workspace와 보고서는 검토용으로 보존합니다. Docker CLI를 종료하는 것과 container 종료를 구분해 잔존 여부를 확인합니다. 생성 응답이 불확실한 상태에서 현재 부재만 확인되면 정리 미확인으로 기록합니다. 이 진단용 controller만 Docker 호출 권한을 가지며 기존 읽기 worker의 네트워크·하위 프로세스 제한은 유지합니다.

Docker daemon과 Linux VM·커널을 신뢰하는 경계입니다. container escape의 완전한 방지나 회사 보안 검토 통과를 뜻하지 않습니다. 진단 보고서와 실행 승인은 분리합니다. 단계 3-C의 제한된 합성 실행은 아래 경로를 사용하며 범용 실행기는 제공하지 않습니다. 자세한 정책과 근거는 [보안과 승인](docs/security-and-approval.md#단계-3-b의-합성-docker-진단)을 따릅니다.

## 단계 3-C 합성 patch와 등록 검사

기존 조사 Task와 분리된 합성 저장소에서 `src/message.mjs` 한 파일의 내용 교체를 계획하고, OS 소유자의 새 승인 후 Docker에서 등록 검사 하나를 실행합니다. `success`, `test-failure`, `timeout`, `output` fixture를 제공하며 기본값은 `success`입니다. 대상 저장소 경로·임의 patch·명령·추가 인자를 받지 않습니다.

```sh
pnpm harness execution-plan --fixture success --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-execution-data
pnpm harness execution-approve --task <id> --plan-hash <sha256> --base-commit <sha1> --expires-in-minutes 30 --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-execution-data
pnpm harness execution-run --task <id> --plan-hash <sha256> --base-commit <sha1> --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-execution-data
pnpm harness execution-inspect --task <id> --data-dir /private/tmp/harness-execution-data
pnpm harness execution-inspect --task <id> --approval-offset 1 --data-dir /private/tmp/harness-execution-data
```

계획 출력의 `task.taskId`, `task.plan.planHash`, `task.baseCommit`을 검토해 승인·실행 입력에 사용합니다. `--expires-in-minutes`는 필수 정수 1~1440입니다. `--config` 생략 시 기본 비활성 예제를 사용해 계획은 만들 수 있지만 승인·실행은 거부됩니다. `enabled`까지 설정 해시에 포함하므로 비활성 상태의 계획을 만든 뒤 설정만 켤 수 없습니다. 실행하려면 위 지원 환경의 실제 socket·Engine·Node·로컬 이미지 ID와 `enabled: true`인 비공개 설정으로 **새 계획**을 만들어야 합니다. 계획과 승인은 Docker를 호출하지 않으며 실행 때 backend를 다시 검증합니다.

계획 해시는 원본 전체 해시·커밋·고정 요청 revision, 수정 허용 파일·patch 전후 해시와 내용, 등록 명령의 실행 파일·argv·cwd·환경·네트워크·한도, `synthetic-execution-v1` 정책과 설정 해시에 결합합니다. 읽기 근거 목록을 수정 허용 범위로 확장하지 않습니다. 기존 일반 파일의 고정 내용 교체만 지원하며 생성·삭제·이름 변경·실행 비트·symlink·서브모듈·설치·검사 설정 변경은 거부합니다. `test-failure`는 고의로 잘못된 고정 내용을 적용해 실패를 재현합니다.

새 승인은 `execution.sqlite`에 불변 계획 snapshot과 함께 저장합니다. 실행 직전에 원본·계획·커밋·revision·설정·backend를 검증하고 승인 소비·Run 생성·`RUNNING` 전환을 한 트랜잭션으로 처리합니다. 승인 없음·만료·다른 소유자·변조·재사용은 거부하며 기존 `approval-only-v1`을 사용하지 않습니다. 실패하거나 완료된 작업도 자동으로 다시 실행하지 않습니다.

동결 원본에서 공유 Git 메타데이터가 없는 독립 Git 작업 트리를 재생성하고 승인 patch를 적용합니다. container에는 Git 없는 읽기 전용 실행 view만 마운트하고, 쓰기 영역은 `/tmp`의 **16MiB tmpfs**로 제한합니다. 네트워크 없음·nonroot·읽기 전용 root·capability 제거·권한 상승 금지·기본 seccomp와 메모리 **128MiB**·swap **0**·PID **64**·CPU **0.5개**·시간 **3초**·stdout/stderr 합계 **16KiB**를 강제합니다. 출력은 수신 chunk에서 한도 초과를 감지하므로 관찰한 `outputBytes`가 16KiB를 넘을 수 있으며 원시 출력 대신 합계 바이트와 해시만 보관합니다.

결과는 `executions/<task-id>/run-<artifact-id>/report.json`과 SQLite Run에 저장합니다. 검사별 `passed`·`failed`·`not_run`, 실제 파일 전후 내용·해시, 원본 전후 해시, 명령의 종료 유형·코드·정지·제거 결과를 남깁니다. 실행 성공은 종료 코드 0, 실패는 1입니다. `execution-inspect`는 SQLite를 원본으로 누락된 완료 보고서를 재생성하고 승인 이력을 최신 한 건씩 `{ approvals, approvalPage }`로 반환합니다. `approvalPage.nextOffset`을 다음 조회에 사용합니다. 작업물은 자동 commit·push·정리하지 않습니다.

`execution-plan`·`execution-approve`·`execution-run`·`execution-recover`는 기존 전역 lease를 유지해 같은 데이터 디렉터리의 실시간 Slack 수신과 직렬화합니다. 실행 중 합성 제어·복구는 아래 3-D 경로를 사용합니다. 실제 Slack 요청과 합성 실행 Task는 연결하지 않으며 수신 중단 구간의 Slack 변경 감지를 보장하지 않습니다.

## 단계 3-D 합성 실행 취소와 중단 복구

실행 중인 합성 작업에 소유자 취소 또는 편집·삭제 이벤트를 전달합니다. `execution-cancel`·`execution-invalidate`·`execution-inspect`는 전역 lease를 우회하고 실행 DB의 짧은 트랜잭션을 사용하므로 `execution-run`이 진행 중이어도 호출할 수 있습니다. 기존 조사 작업의 `cancel`과 구분합니다.

```sh
pnpm harness execution-cancel --task <id> --event-id synthetic-cancel-1 --data-dir /private/tmp/harness-execution-data
pnpm harness execution-invalidate --task <id> --event edited --revision 2 --event-id synthetic-edit-2 --data-dir /private/tmp/harness-execution-data
pnpm harness execution-invalidate --task <id> --event deleted --revision 3 --event-id synthetic-delete-3 --data-dir /private/tmp/harness-execution-data
pnpm harness execution-recover --task <id> --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-execution-data
pnpm harness execution-inspect --task <id> --data-dir /private/tmp/harness-execution-data
```

`execution-cancel`의 `--event-id`는 선택 사항이며 생략하면 새 ID를 만듭니다. 편집·삭제는 `--event-id`와 정수 `--revision` 2~1000000000이 필수입니다. 요청은 `synthetic:<task-id>`, 초기 revision 1로 식별합니다. 같은 ID·내용의 이벤트는 멱등 처리하고 다른 내용의 ID 재사용은 거부합니다. 오래되거나 같은 편집·삭제 revision은 무시합니다. 무효화 후 기존 계획은 다시 승인하거나 실행할 수 없으며 새 계획이 필요합니다.

승인 소비 전 제어는 대기 Task를 `CANCELLED`로 바꾸고 미소비 승인을 취소합니다. 실행 중에는 generation fence로 새 patch·view·Docker 생성/시작을 막고, 진행 중인 container를 소유권 확인 후 종료·제거합니다. 짧은 로컬 파일 작업은 취소 commit과 직렬화하며 이미 전달된 Docker RPC는 정리 대상으로 남깁니다. 취소는 파일 변경을 되돌리지 않습니다. 성공 종료와 경합한 취소도 같은 DB 트랜잭션에서 확인하며, 정리나 관찰이 불확실하면 `BLOCKED`를 유지합니다.

강제 종료 뒤 `execution-recover`는 저장된 실행 단계·container 이름·소유 토큰·Run label·전체 ID와 작업 영역 증거를 읽어 정리와 관찰만 수행합니다. 실행을 재개하지 않습니다. 확인된 중단은 `INTERRUPTED`, 확인된 취소는 `CANCELLED`, 정리·파일 상태 미확인은 `BLOCKED`입니다. 과거 3-C의 미완 Run에 소유 정보가 없으면 `legacy_untracked`와 `BLOCKED`로 남기고 다른 container를 추측해 종료하지 않습니다. 이미 `BLOCKED`인 Run을 다시 복구하면 기존 Run·보고서는 유지하고 lifecycle의 정리·관찰 근거만 갱신합니다.

부분 patch·추가·삭제·권한·Git·실행 view 상태는 새 프로세스에서도 관찰합니다. 예상 밖 파일의 본문과 이름은 읽거나 출력하지 않고 이름 해시와 변경 종류를 기록합니다. `execution-inspect`는 Task·제어·승인 페이지·Run·lifecycle을 한 DB snapshot으로 읽은 뒤 누락된 완료 보고서를 만듭니다. 승인 `usedAt`, 불변 계획과 작업물은 유지하며 자동 재실행·승인 복원·commit·push·작업물 삭제는 하지 않습니다. 실제 검증 범위와 한계는 [3-D 결과](docs/stage-3d-result.md)를 따릅니다.

## 모의 입력과 오류 재현

`--fixture`는 이벤트 예제와 **고정 모델 시나리오**를 고릅니다. 실제 자연어 분류 모델이 메시지를 해석하는 기능은 아닙니다. `config/local.example.json`의 합성 ID인 `W_LOCAL`, `C_ALLOWED`, `U_OWNER`를 사용합니다.

| fixture | 기대 결과 |
| --- | --- |
| `inquiry`, `change`, `unclear` | 답변 초안, 승인 대기 계획, 확인 질문 |
| `duplicate` | 같은 이벤트는 한 번만 처리 |
| `no-mention`, `other-user`, `disallowed-channel`, `other-workspace` | 작업 생성 없음 |
| `bot`, `self`, `edited`, `deleted` | 작업 생성 없음. 편집·삭제 반영은 후속 단계 |
| `invalid-json`, `invalid-summary`, `forbidden-command`, `timeout` | `FAILED`와 정적 실패 코드 |
| `hallucinated-file`, `path-escape`, `symlink`, `secret`, `large`, `binary` | `BLOCKED`, 근거 및 실행 계획 없음 |
| `malicious` | 메시지와 README의 악성 지시를 자료로 읽고 실행 권한을 만들지 않음 |
| `redaction` | 합성 비밀 패턴을 모델 입력 전 마스킹 |

```sh
pnpm harness replay --fixture invalid-json
pnpm harness replay --fixture path-escape
pnpm harness replay --fixture malicious
pnpm harness replay --fixture inquiry --events /absolute/path/to/synthetic-events.json
```

`--events`는 최대 64,000바이트의 로컬 합성 이벤트 배열을 받습니다. 형식은 `fixtures/events/inquiry.json`을 참고합니다. 사용자 지정 이벤트도 `--fixture`로 선택한 고정 모델 응답을 사용합니다. 실제 비밀·회사 자료를 넣으면 안 됩니다. 조사 작업의 `FAILED`/`BLOCKED`는 결과에 기록되며, CLI 자체의 실행 오류와 구분됩니다.

## 읽기 경계

CLI는 매번 OS 임시 경로에 합성 Git 저장소를 준비한 뒤 읽기 전용 모드로 동결합니다. 이 준비는 조사 전에 수행하며 대상 코드·설치·테스트·빌드를 실행하지 않습니다. 조사 프로세스에는 다음 제한을 적용합니다.

- Node `--permission`으로 대상·하네스 소스 읽기와 데이터 폴더 쓰기를 분리하고, 네트워크·하위 프로세스·worker·외부 native addon 권한을 주지 않습니다. 호스트 환경변수도 전달하지 않습니다.
- 읽기 포트는 full SHA의 Git 객체와 정확한 파일 허용 목록만 사용합니다. 작업 트리 변경을 근거로 섞지 않으며 Git 실행 파일이나 shell을 호출하지 않습니다.
- 실제 경로와 Git tree의 symlink, 경로 탈출, 비밀 파일·자격증명 패턴, 바이너리·대용량 파일을 차단합니다. 현재 합성 저장소는 파일 32KiB, 근거 합계 16KiB로 제한합니다.
- 초기 reader는 크기를 제한한 **loose Git 객체만 지원**합니다. pack 객체와 임의의 회사 저장소 연결은 지원하지 않습니다.
- 조회 전후 전체 파일·미추적 파일·Git 메타데이터·권한·symlink 대상을 해시로 비교합니다. 차이가 있으면 성공 처리하지 않고 변경물을 보존합니다.

Node 권한 모델은 신뢰하는 하네스 코드의 실수를 제한하는 장치입니다. 악성 코드를 실행하는 보안 sandbox가 아니며, 같은 OS 사용자의 동시 파일 변조까지 방어한다고 주장하지 않습니다. 조사 worker는 저장소 파일을 실행·import하지 않습니다. 단계 3-B 진단과 별도의 3-C 합성 실행 controller만 제한된 Docker 경로를 사용합니다. worktree만으로 보안 격리가 되지는 않습니다.

합성 저장소 경로는 실행 기록의 `repository.root`에 남깁니다. CLI는 검토를 위해 이 임시 자료를 자동 삭제하지 않습니다. 테스트는 자신이 만든 임시 자료만 종료 후 정리합니다. 조사 보고서의 `passed`, `failed`, `not_run`은 구분되며 이 조사 경로의 대상 설치·테스트·외부 전송·승인 후 실행은 `not_run`입니다.

## 단계 2 Slack 읽기 수신

수신 경로는 `Socket Mode → 허용 범위 검사 → SQLite commit → ACK → 제한된 스레드 조회 → 로컬 기록`입니다. 이 경로는 모델을 호출하거나 대상 저장소를 읽지 않습니다. 결과의 `analysis`는 `not_run`이며, 고정 모델의 답변을 실제 요청의 답변으로 만들지 않습니다.

토큰 없이 합성 Socket Mode envelope를 재생할 수 있습니다.

```sh
pnpm harness slack-replay --data-dir /private/tmp/harness-slack-demo
pnpm harness slack-list --data-dir /private/tmp/harness-slack-demo
pnpm harness slack-inspect C_ALLOWED 1700000000.000001 --data-dir /private/tmp/harness-slack-demo
pnpm harness slack-replay --events /absolute/path/to/synthetic-envelopes.json --data-dir /private/tmp/harness-slack-demo
```

기본 예제는 최초 메시지, 다른 envelope의 동일 이벤트 재전달, 편집, 비허용 채널을 포함합니다. `slack-replay`는 합성 입력 전용이며 실제 스레드를 조회하지 않아 `OFFLINE_NO_THREAD_SOURCE`를 기록합니다. 조사용 `replay` 명령은 단계 1의 동작을 그대로 사용합니다.

`slack-list`는 최근 100개 요청의 상태·ID와 연결 이력을 표시하고 `slack-inspect`는 해당 요청의 마스킹된 본문·문맥을 표시합니다. 장시간 수신 중에도 이 두 조회 명령을 사용할 수 있습니다. 수신·모의 조사 변경 명령끼리는 기존 프로세스 잠금으로 겹치지 않게 합니다.

실연결 준비에는 다음 값이 필요합니다. 실제 토큰·회사 설정은 저장소 밖에서 관리합니다.

- `config/slack.example.json`: 허용 workspace·채널·소유자 ID, 보관 기간, 큐·스레드 상한. 기본 `liveReadEnabled`는 `false`입니다.
- `config/slack-app-manifest.example.json`: 공개 채널의 `message.channels`와 `channels:history`만 사용하는 앱 예시. 앱을 허가된 최소 채널에만 초대합니다. DM·비공개 채널·메시지 쓰기 권한은 예시에 없습니다.
- `SLACK_APP_TOKEN`: Socket Mode 연결용 app-level token, `connections:write`.
- `SLACK_WEB_TOKEN`: 스레드 조회용 최소 읽기 권한 토큰. 별도의 승인된 비밀 저장소에서 실행 환경에 주입합니다.

개인 테스트 또는 회사에서 승인받은 계정·자료·실행 환경에서 설정을 준비하고 `liveReadEnabled: true`를 명시한 경우에 사용할 명령입니다. 이번 구현에서는 실행하지 않았습니다.

```sh
pnpm harness slack-listen --config /absolute/path/to/approved-slack.json --data-dir /absolute/path/to/private-slack-data
pnpm harness slack-list --config /absolute/path/to/approved-slack.json --data-dir /absolute/path/to/private-slack-data
```

수신부는 별도 Node 권한 프로세스에서 필요한 Slack 토큰만 받으며 대상 저장소를 읽는 권한이나 하위 프로세스 권한을 받지 않습니다. 조사 worker에는 토큰·네트워크 권한을 추가하지 않았습니다. 수신부의 Node `--allow-net`은 프로세스 전체 네트워크 허용이며 호스트별 OS 격리가 아닙니다. 어댑터가 고정 API와 정확한 WSS 호스트 목록을 검사하고 HTTP redirect를 거부합니다. 회사의 네트워크·데이터 정책 검증은 별도입니다.

실연결은 먼저 `auth.test`로 Web API 토큰의 workspace를 확인합니다. 스레드 조회 가능 여부는 선택한 token·scope·채널 멤버십으로 직접 검증해야 합니다. 조회 시간·응답 크기·페이지·메시지 수를 제한하고 `429 Retry-After`를 상한 안에서 처리합니다. 제한·조회 실패는 불완전 문맥으로 표시합니다. 재연결은 누락 없는 재생을 보장하지 않으며 최근 100개 연결·공백 상태를 보관합니다. 과거 메시지 자동 조회로 공백을 메우는 기능은 없습니다. [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [스레드 조회](https://docs.slack.dev/reference/methods/conversations.replies/), [토큰 workspace 확인](https://docs.slack.dev/reference/methods/auth.test/)

`tasks.sqlite`의 `slack_*` 테이블에 이벤트·요청·연결 이력을 저장합니다. 이벤트 ID는 중복 제거용이고 원본 메시지는 workspace·채널·message ts로 식별합니다. 편집·삭제·멘션 제거는 이전 문맥과 연계된 계획을 무효화합니다. 기존 조사 계획이 같은 메시지에 연결되어 있으면 DB에서 취소하고 로컬 보고서도 취소 상태로 다시 씁니다. DB가 원본이며, 보고서 쓰기 중 종료되면 다음 명령에서 복구합니다. 진행 중 중단된 수집은 `BLOCKED`로 보존하고 자동 재수집하지 않습니다.

본문과 스레드는 비밀 패턴, 지원 이메일·국내 휴대전화 패턴을 마스킹한 뒤 보관합니다. 보관 기간은 1~168시간이며 예시는 24시간입니다. 명령 시작·수신·처리 시점과 실수신 중 매분 만료 본문을 제거합니다. 중지된 앱의 DB는 다음 실행 전까지 남습니다. 최소 event ID·메시지 revision·삭제 marker는 오래된 이벤트의 부활을 막기 위해 DB 수명 동안 남고 저장량이 늘어날 수 있습니다. 삭제는 백업·로그·파일시스템의 물리적 완전 삭제를 보장하지 않습니다. 모든 개인정보·비밀 형식을 판별하는 기능도 아닙니다.

## 개발 검증

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`test`는 컴파일 후 Node 내장 test runner로 단위·통합·CLI 수용 테스트를 실행합니다. 합성 저장소는 별도 임시 경로에 준비합니다. 하네스 테스트가 통과해도 실제 Slack 권한·회사 보안·격리 실행기의 검증을 통과한 것은 아닙니다.

전체 기준은 [구현 계획](docs/implementation-plan.md), [구조](docs/architecture.md), [보안과 승인](docs/security-and-approval.md)에 있고, 구현·검증 경계는 [단계 1](docs/stage-1-result.md), [단계 2](docs/stage-2-result.md), [단계 3-A](docs/stage-3a-result.md), [단계 3-B](docs/stage-3b-result.md), [단계 3-C](docs/stage-3c-result.md), [단계 3-D 결과](docs/stage-3d-result.md)에 정리했습니다. 합성 실행 검증과 실제 Slack·회사 도입 승인을 구분합니다.
