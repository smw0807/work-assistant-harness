# work-assistant-harness !

Slack 요청을 로컬에 기록하고, 합성 자료로 조사와 승인 후 격리 실행을 검증하는 업무 하네스입니다. **단계 0·1의 모의 조사, 단계 2의 Slack 읽기 수신, 단계 3-A의 로컬 승인·취소 기록, 단계 3-B의 Docker 격리 진단, 단계 3-C의 고정 합성 patch·등록 검사 실행, 단계 3-D의 합성 실행 취소·중단 복구·잔여 변경 관찰**에 이어 **단계 4-A의 합성 답장 계획·별도 승인·모의 전송, 단계 4-B-1의 오프라인 Slack HTTP 계약 진단, 단계 4-B-2의 별도 승인에 따른 고정 시험 문구 단건 전송**을 제공합니다. 검증 결과는 [단계 3-B](docs/stage-3b-result.md), [단계 3-C](docs/stage-3c-result.md), [단계 3-D](docs/stage-3d-result.md), [단계 4-A](docs/stage-4a-result.md), [단계 4-B-1](docs/stage-4b1-result.md), [단계 4-B-2](docs/stage-4b2-result.md)에 기록합니다. 4-B-2까지 전체 회귀 367개와 lint·typecheck·build가 통과했고, 개인 테스트 스레드의 고정 문구 단건 게시도 확인했습니다. AI·회사 저장소·실제 업무 자동 답장은 별도 검증입니다.

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

기본 실행은 합성 자료만 사용합니다. Slack 수신은 명시적으로 켜는 별도 경로이며 모델·제품 저장소와 연결하지 않습니다. 기존 조사와 단계 3-A는 `APPROVED`에서 멈추며 기본 `ExecutionPort`는 항상 거부하고 `run` 명령은 제공하지 않습니다. 단계 3-C는 별도 `execution-*` 명령에서 새 합성 작업·실행 승인을 만들고 고정 patch와 등록 검사만 실행합니다. 단계 4-A의 `reply-*` 명령은 고정 합성 요청과 가짜 전송 어댑터를 사용합니다. 단계 4-B-1의 `slack-post-check`는 가짜 HTTP 응답으로 요청·응답 계약만 진단하며 승인이나 실제 전송을 만들지 않습니다. 단계 4-B-2의 `slack-live-*`는 기본 비활성인 별도 live 계획·승인·고정 단건 시험 경로입니다. 실제 게시는 구체 계획에 대한 별도 승인이 필요하며 자동 업무 답장과 Git 원격 작업은 구현하지 않았습니다.

단계 4-C-1의 `branch-*`는 별도 DB에서 작업 유형별 브랜치 계획·승인·모의 결과·취소·복구를 제공합니다. 전체 회귀 397개와 lint·typecheck·build가 통과했습니다. 실제 브랜치 생성과 Codex 실행은 연결하지 않습니다. 사용법은 아래 4-C-1 절, 검증 결과는 [4-C-1 결과](docs/stage-4c1-result.md)를 따릅니다.

단계 4-C-2의 `git-branch-*`는 별도로 준비한 합성 Git 저장소에 새 승인으로 브랜치 ref 하나를 생성하고 관찰·복구합니다. 전체 회귀 442개와 lint·typecheck·build가 통과했습니다. 실제 Codex·회사 저장소·코드 수정·작업 결과 commit·원격 작업은 연결하지 않습니다. 검증 범위는 [4-C-2 결과](docs/stage-4c2-result.md)를 따릅니다.

단계 4-C-3의 `branch-execution-*`는 새 합성 실행 승인 후 유형별 브랜치를 생성·선택하고 고정 파일 patch와 등록 Docker 검사, 취소·복구를 연결합니다. 기존 3-C/D·4-C-2의 작업과 승인은 재사용하지 않습니다. 전체 회귀 481개와 lint·typecheck·build, 실제 Docker 격리 진단 및 실행·취소·복구 12개 시나리오가 통과했습니다. 근거는 [4-C-3 결과](docs/stage-4c3-result.md)에 기록합니다. 실제 Codex·회사 저장소·작업 결과 commit·push·PR/MR은 연결하지 않습니다.

단계 4-C-4의 `codex-proposal-*`와 `codex-execution-*`는 합성 입력의 Codex 제안 호출과 제안 코드의 실행을 서로 다른 승인·DB로 분리합니다. 기존 단계의 검증 결과를 실제 Codex 연결 검증으로 간주하지 않으며, 명령과 현재 경계는 아래 4-C-4 절을 따릅니다.

단계 4-C-5의 `readonly-investigation-*`는 합성 다중 파일을 조사하고 별도 승인한 근거만 모의 worker에 전달합니다. 신규 53개를 포함한 전체 583개 테스트와 lint·typecheck·build가 통과했습니다. 실제 모델 호출은 제외했으며 경계와 수용 근거는 [4-C-5 결과](docs/stage-4c5-result.md)를 따릅니다.

단계 4-C-6의 `readonly-transport-*`는 검토한 최종 요청을 별도 승인으로 가짜 전송기에 한 번 전달합니다. 신규 59개를 포함한 전체 642개 테스트와 lint·typecheck·build가 통과했습니다. 실제 모델·인증정보 접근·외부 전송은 제외했으며 [4-C-6 결과](docs/stage-4c6-result.md)에 수용 근거를 기록했습니다.

단계4-C-7은726개 회귀를 통과했습니다. 4-C-8의 최신 metadata 진단 계획은 native 포함1020개·집중98개·차등7416건·lint/typecheck/build 검증 뒤 TTL10분으로 별도 승인해 실제1회 호출했습니다. SSE created 내부 `access_programs`의 non-null 값이 기존 정책에 거부돼 `RESPONSE_METADATA`로 실패했으며 값의 형태·의미는 미확인이고 유효 보고서는 없습니다. 이번 승인·attempt·소비·upstream 각1회·자동 재시도0회와 원본/Git·코드·기존 작업물 보존·프로세스 종료를 독립 감사로 확인했습니다. 누적 upstream16회 실패·전송 전 실패1회·소비 승인17개이며 [4-C-8 결과](docs/stage-4c8-result.md)에 기록합니다.

metadata 정적 진단은 기존 v9 수용 조건·오류 코드·hash를 유지합니다. 준비한 계획은 별도 승인으로1회 실행해 현재 `FAILED`이며 소비 승인은 재사용하지 않습니다. [최신 실제 실행·감사](docs/stage-4c8-result.md#metadata-진단-계획의-승인된-실제-단건-호출)와 [승인 전 로컬 준비 기록](docs/stage-4c8-result.md#metadata-정적-진단과-새-승인-대기-계획)을 구분합니다.

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
- `harness-lock.sqlite`: 실행 소유권과 실시간 Slack 수신을 직렬화하는 SQLite 잠금. 합성 실행의 `execution-cancel`·`execution-invalidate`·`execution-inspect` 및 대응하는 `branch-execution-*` 제어·조회는 짧은 별도 실행 DB 트랜잭션을 사용합니다. 프로세스 종료 시 OS가 잠금을 해제합니다.
- `reports/`: 작업별 JSON 보고서. DB에 저장된 자료로 누락된 보고서를 재생성합니다.
- `runs/`: 명령별 결과와 대상 전후 해시를 기록한 JSON 실행 기록.
- `execution.sqlite`, `executions/`: 독립 합성 작업·계획·승인·Run, 요청 revision·무효화·실행 단계 이력과 동결 원본·분리 작업 트리·읽기 전용 실행 view·보고서. 기존 `tasks.sqlite`의 작업과 승인을 실행에 사용하지 않습니다.
- `branch-execution.sqlite`, `branch-executions/`: 유형별 브랜치에서 고정 patch·Docker 검사를 수행하는 새 합성 실행 profile의 계획·승인·Run·제어·Git/파일/view 증거와 보고서. 기존 실행·브랜치 DB와 승인을 공유하지 않습니다.
- `codex-proposals.sqlite`, `codex-calls/`: 고정 합성 입력·Codex 설정 해시·호출 승인·단일 시도·검증한 제안과 호출별 격리 디렉터리. 인증값은 저장하지 않습니다.
- `codex-execution.sqlite`, `codex-executions/`: 한 번 소비한 제안에서 만든 별도 실행 계획·새 실행 승인·분리 합성 원본·작업 브랜치·Docker 검사와 관찰 보고서.
- `readonly-live.sqlite`, `readonly-live-runs/`: 합성 다중 파일 live 조사의 별도 계획·승인·단일 시도·검증한 로컬 보고서와 격리 프로세스 종료 증거. 인증값은 저장하지 않습니다.
- `replies.sqlite`: 독립 합성 답장 Task·본문 없는 계획/승인 snapshot·전송 시도·제어 이력·보관 정책·최소 중복 marker. 답장 본문은 별도 만료 payload에만 보관하며 영속 보고서에 복제하지 않습니다.
- `live-replies.sqlite`: 고정 단건 Slack 시험의 별도 계획·승인·시도와 대상 중복 hash marker. 원문·전송 본문·token은 저장하지 않습니다.

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

## 단계 4-A 합성 답장과 전송 전용 승인

실제 Slack·AI·회사 저장소를 연결하지 않고 고정된 합성 요청·일반 텍스트 요약만 사용합니다. 목적지는 `W_LOCAL`·`C_ALLOWED`의 원래 요청 스레드에 단건 답장입니다. 임의 본문·다른 채널·DM·멘션·첨부·코드 전문·토큰·설정 파일을 입력받지 않습니다. 기존 `approve`나 `execution-approve`는 답장 승인으로 사용할 수 없습니다.

```sh
pnpm harness reply-plan --fixture success --data-dir /private/tmp/harness-reply-data
pnpm harness reply-inspect --task <uuid> --data-dir /private/tmp/harness-reply-data
pnpm harness reply-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 30 --data-dir /private/tmp/harness-reply-data
pnpm harness reply-send --task <uuid> --plan-hash <sha256> --data-dir /private/tmp/harness-reply-data
pnpm harness reply-inspect --task <uuid> --approval-offset 0 --data-dir /private/tmp/harness-reply-data
```

`reply-plan`·`reply-inspect`가 출력한 `task.taskId`·`task.plan.planHash`를 그대로 사용합니다. 계획에서 대상·유효 본문을 검토하고 OS 소유자가 전송 전용 승인을 내립니다. `--expires-in-minutes`는 기본값 없이 필수이며 정수 1~60분만 허용합니다. 30분을 권장하고, 실제 승인 만료는 본문·source 만료보다 늦을 수 없습니다. 승인만으로 전송하지 않으며 `reply-send`가 승인 소비와 `SENDING` 시도를 원자 저장한 뒤 가짜 어댑터를 한 번 호출합니다.

| `reply-plan --fixture` | 기대 결과                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `success` (기본값)     | 승인 후 `SIMULATED`. 실제 Slack 전송을 뜻하지 않습니다.                                                                            |
| `not-sent`             | 시도 `NOT_SENT`·Task `FAILED`. 자동 재시도 없이 새 승인 후에만 수동 재시도합니다. 고정 fixture이므로 재시도도 미전송으로 끝납니다. |
| `unknown`              | 결과 `UNKNOWN`. 새 승인·재전송을 차단합니다.                                                                                       |
| `incomplete`, `gap`    | 문맥 불완전·수신 공백으로 `BLOCKED`. 승인·전송을 차단합니다.                                                                       |

`reply-send`는 `SIMULATED` 이외 결과에서 JSON 결과를 출력하고 종료 코드 1을 반환합니다. 본문·대상·요청/문맥 revision이 바뀌거나 새 reply가 생기면 기존 승인을 사용할 수 없습니다. 아래 명령은 실제 Slack 이벤트와 연결되지 않은 합성 제어 경로입니다.

```sh
pnpm harness reply-cancel --task <uuid> --event-id synthetic-cancel-1 --data-dir /private/tmp/harness-reply-data
pnpm harness reply-invalidate --task <uuid> --event reply --revision 2 --event-id synthetic-reply-2 --data-dir /private/tmp/harness-reply-data
pnpm harness reply-recover --task <uuid> --data-dir /private/tmp/harness-reply-data
pnpm harness reply-prune --data-dir /private/tmp/harness-reply-data
```

`reply-cancel`의 `--event-id`는 생략하면 새 ID를 만듭니다. `reply-invalidate`는 `--event edited|deleted|reply|gap|incomplete|expired`, 필수 `--revision 2..1000000000`과 `--event-id`를 받습니다. 초기 요청/문맥 revision은 1이며 같은 이벤트 ID·내용은 멱등 처리하고 다른 내용의 ID 재사용은 거부합니다. 오래된 revision은 최신 상태를 되돌리지 않습니다. 성공한 결과를 취소 이벤트로 다시 열거나 소비 승인을 복원하지 않습니다.

중단된 `SENDING`은 문맥이 유효하면 시작·조회 시 그대로 남고 자동 전송하지 않습니다. `reply-recover`는 이를 `UNKNOWN`으로 확정하며 모의 전송을 재개하지 않습니다. 별도 본문/source 만료·무효화도 진행 중 시도를 `UNKNOWN`으로 차단합니다. 모든 `reply-*` 명령은 기존 전역 lease를 사용하므로 같은 데이터 디렉터리의 `slack-listen`이 실행 중이면 거부합니다. 답장 worker에는 네트워크·하위 프로세스·호스트 토큰 권한을 주지 않습니다.

보관 정책은 계획을 만들 때 고정합니다.

```sh
pnpm harness reply-plan --body-retention-hours 24 --audit-retention-days 30 --data-dir /private/tmp/harness-reply-data
```

`--body-retention-hours`는 정수 1~168·기본 24입니다. 합성 source가 생성 후 24시간에 만료하므로 계획·본문은 설정값과 24시간 중 짧은 기한까지만 유효합니다. `--audit-retention-days`는 선택 정수 1~3650이며, 생략하면 `null`로 합성 감사 metadata를 DB 수명 동안 보관합니다. 이는 회사 운영 보관 정책이 아닙니다. 기간을 지정하면 terminal 작업의 감사 기한 뒤 metadata를 제거하되 최소 task ID·계획 해시 중복 marker는 DB 수명 동안 유지합니다.

본문은 별도 payload에만 저장하고 승인 snapshot·시도·영속 보고서에 복제하지 않습니다. `reply-plan`·`reply-inspect`만 유효 본문을 stdout에 표시하며 사용자가 redirect한 출력은 사용자의 보관 정책을 따릅니다. 각 답장 명령 시작과 `reply-prune`에서 정리하므로 중지 중 만료 자료는 다음 실행까지 남을 수 있습니다. SQLite 논리 삭제는 디스크·백업의 물리적 완전 삭제를 보장하지 않습니다. 실제 Slack 전송·회사 자료·실제 문맥 최신성은 `not_run`이며 다음 별도 범위입니다. 상세 계획과 검증 범위는 [4-A 계획](docs/implementation-plan.md#단계-4-a-합성-답장-계획별도-승인모의-전송)과 [결과](docs/stage-4a-result.md)를 따릅니다.

## 단계 4-B-1 오프라인 Slack HTTP 계약 진단

가짜 HTTP transport로 Slack 요청 직렬화·identity·스레드 문맥·성공 응답을 검증하는 별도 진단입니다. 기존 `reply-*`의 승인·DB·모의 전송은 그대로 사용하며 이 진단과 연결하지 않습니다. `liveEnabled`는 항상 `false`이고 실제 토큰·계정·설정·본문·대상을 입력하거나 전송을 활성화하는 옵션은 없습니다.

```sh
pnpm harness slack-post-check --data-dir /private/tmp/harness-slack-post-check
pnpm harness slack-post-check --fixture success --data-dir /private/tmp/harness-slack-post-check
pnpm harness slack-post-check --fixture disabled --data-dir /private/tmp/harness-slack-post-check
```

`--fixture`의 기본값은 `all`입니다. 각 시나리오가 예상한 결과를 반환하면 차단·오류도 진단 `passed`이며, 전체 통과 시 종료 코드는 0입니다. 보고서는 `<data-dir>/slack-post-checks/<verificationId>/report.json`에 저장합니다. stdout과 보고서에 본문·토큰·원시 HTTP 요청/응답·원시 오류를 남기지 않습니다.

| fixture                                                                             | 검증 내용과 예상 결과                                                                                     |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `success`                                                                           | 합성 `auth.test` → `conversations.replies` → `chat.postMessage`의 직렬화·응답 검증 후 `OFFLINE_CONFIRMED` |
| `disabled`                                                                          | 기본 비활성 HTTP 포트 호출 0, `BLOCKED`                                                                   |
| `auth-mismatch`, `source-changed`, `new-reply`, `incomplete`, `expired`             | identity·문맥·만료 불일치로 post 호출 전 `BLOCKED`                                                        |
| `denied`, `rate-limited`                                                            | 확실한 API 거부를 `NOT_SENT`로 분류, 자동 재시도 0                                                        |
| `server-error`, `timeout`, `malformed`, `oversized`, `receipt-mismatch`, `redirect` | post 결과 불확실성을 `UNKNOWN`으로 보존, 자동 재시도 0                                                    |

진단 입력인 `offline-http` intent는 유효한 합성 설정·대상·본문 hash·문맥 hash를 묶으며 생성 후 60초에 만료합니다. 이는 소유자의 전송 승인 TTL이 아닙니다. 고정 합성 workspace `T_LOCAL`·채널 `C_ALLOWED`·bot `B_LOCAL`·bot 사용자 `U_BOT`·원래 스레드와 고정 일반 텍스트만 사용합니다. 기본 포트는 요청을 수행하지 않고, 각 진단에서만 합성 HTTP 포트를 주입합니다. 가짜 token은 메모리의 합성 요청 검증에만 쓰며 호스트 토큰을 읽지 않습니다.

요청은 250ms·응답은 16KiB로 제한하고 redirect를 거부합니다. 합성 성공 receipt의 channel·message timestamp·thread·bot·본문을 대조합니다. 네트워크·하위 프로세스 권한과 호스트 토큰이 없는 별도 Node worker에서 NestJS application context로 실행하며 실제 `fetch` transport는 제공하지 않습니다. 진단 결과는 실제 Slack 전송 성공이나 전송 권한이 아닙니다.

실제 단건 시험은 아래 4-B-2의 별도 계획·승인·저장소를 사용합니다. 기존 4-A 모의 승인과 이 진단의 intent·성공 보고서를 실전송 승인으로 재사용할 수 없습니다. 이 진단은 실제 수신 문맥의 경합이나 회사 계정·자료 정책의 검증이 아닙니다. 자세한 수용 기준과 검증 상태는 [4-B-1 계획](docs/implementation-plan.md#단계-4-b-1-오프라인-slack-http-계약-진단)과 [결과](docs/stage-4b1-result.md)를 따릅니다.

## 단계 4-B-2 고정 시험 문구 단건 전송

개인 테스트 workspace의 공개 채널·원래 root 스레드 한 곳을 대상으로, 새 live 계획과 승인을 만들고 고정 합성 문구를 한 번 게시하는 경로입니다. 기본 활성화는 `false`이며 `--live-enabled true`를 명시해야 합니다. 구현·합성 검증과 별도 승인된 실제 단건 게시를 완료했습니다. 로컬 DB의 `SENT` 시도 한 개와 원래 Slack 스레드의 댓글 한 개·고정 본문·receipt 일치를 확인했습니다. [4-B-2 결과](docs/stage-4b2-result.md)에 검사 근거와 한계를 기록합니다. 실제 업무 요청·모델·제품 저장소를 자동 답장과 연결하지 않습니다.

원문은 **`하네스 전송 테스트`라는 root 한 개이고 reply가 없어야** 합니다. 전송 문구는 **`하네스 Slack 단건 전송 테스트입니다. (4-B-2)`**로 코드에 고정합니다. 임의 본문·본문 파일·DM·계획에 고정한 대상 외 채널 전송·메시지 수정/삭제는 지원하지 않습니다. 실제 workspace/channel/thread ID는 로컬 CLI에 입력하고 bot identity와 함께 비공개 DB의 metadata로 관리합니다. token은 `SLACK_SEND_TOKEN` 환경 주입 또는 TTY 숨김 입력으로만 제공하며 설정 파일에 넣지 않습니다. 실제 ID·token·런타임 DB는 fixture·Git에 넣지 않습니다.

| 명령 | 역할 |
| --- | --- |
| `slack-live-plan` | 인증·root 문맥 확인 후 최대 24시간 유효한 계획 생성 |
| `slack-live-inspect`, `slack-live-list` | 저장된 대상·해시·상태와 검토할 고정 문구 조회 |
| `slack-live-approve` | 인증·문맥 재확인 후 OS 소유자가 정확한 계획 해시에 필수 TTL 1~60분을 지정해 새 승인 생성 |
| `slack-live-send` | 인증·문맥 재확인과 승인 원자 소비 후 POST 최대 한 번 |
| `slack-live-cancel` | 미소비 승인 취소 |
| `slack-live-recover` | 중단된 `SENDING`을 `UNKNOWN`으로 확정하며 재전송하지 않음 |
| `slack-live-prune` | 만료·terminal 30일 감사 기록 정리와 최소 중복 marker 유지 |

다음 `<...>`는 검토한 비공개 로컬 값으로 바꿉니다. token이 환경에 없으면 각 네트워크 명령이 `SLACK_LIVE_TOKEN_READY`를 표시하고 숨김 입력을 받습니다. plan·inspect에 표시되는 `task.plan.taskId`와 `task.plan.planHash`를 그대로 사용합니다. approve와 send는 각각 실제 네트워크를 사용하며 **send가 실제 외부 게시를 수행**합니다.

```sh
pnpm harness slack-live-plan --workspace-id <T...> --channel-id <C...> --thread-ts <timestamp> --live-enabled true --data-dir /absolute/path/to/private-live-data
pnpm harness slack-live-inspect <task-id> --data-dir /absolute/path/to/private-live-data
pnpm harness slack-live-approve <task-id> --plan-hash <sha256> --expires-in-minutes 30 --live-enabled true --data-dir /absolute/path/to/private-live-data
pnpm harness slack-live-send <task-id> --plan-hash <sha256> --live-enabled true --data-dir /absolute/path/to/private-live-data
pnpm harness slack-live-cancel <task-id> --data-dir /absolute/path/to/private-live-data
pnpm harness slack-live-recover <task-id> --data-dir /absolute/path/to/private-live-data
pnpm harness slack-live-list --data-dir /absolute/path/to/private-live-data
pnpm harness slack-live-prune --data-dir /absolute/path/to/private-live-data
```

`SLACK_SEND_TOKEN`은 승인된 로컬 환경에 주입하거나 TTY 숨김 입력으로 제공합니다. token을 명령 인자·설정 파일·채팅·DB·보고서에 넣지 않습니다. 공개 테스트 채널용 bot에는 `chat:write`·`channels:history`와 채널 멤버십이 필요하며, 실제 token의 workspace·bot/user identity와 스레드 조회 가능 여부를 확인합니다. 이 전송 token은 기존 수신용 `SLACK_APP_TOKEN`·`SLACK_WEB_TOKEN`과 별도 경로입니다. plan·approve·send worker만 token·네트워크를 받고 조회·취소·복구·정리는 받지 않습니다.

계획·승인·전송마다 `auth.test`와 `conversations.replies`를 다시 확인합니다. 편집·삭제·새 reply·부분 조회·identity/문맥 불일치·5초가 지난 관측은 차단합니다. 같은 데이터 디렉터리의 실시간 수신과는 전역 lease로 직렬화합니다. Slack 조회와 POST가 별도 요청이므로 마지막 확인과 게시 사이 외부 변경을 원자적으로 막지는 못합니다. 이는 고정 단건 테스트의 한계이며 회사 운영의 최신성 보장이 아닙니다.

새 정책 `slack-live-test-v1`과 `live-replies.sqlite`를 사용합니다. 4-A 모의 승인·4-B-1 진단 보고서·코드 변경 승인을 가져오지 않습니다. send는 승인 소비와 `SENDING` 시도를 원자 저장한 뒤 고정 API를 호출하며, 요청 10초·응답 32KiB·redirect 거부·자동 재시도 0을 적용합니다. 정확한 receipt는 `SENT`, 명백한 미전송만 `NOT_SENT`/`FAILED`, 불확실한 응답이나 중단 복구는 `UNKNOWN`입니다. 확실한 미전송만 새 승인으로 수동 재시도하며 `SENT`·`UNKNOWN`은 같은 workspace/channel/root의 새 plan까지 막습니다.

Slack 원문·고정 전송 본문·token은 DB에 저장하지 않습니다. source의 raw revision·문맥 hash·관측 시각·identity와 계획/승인/시도 metadata만 저장하고, 유효 계획의 검토 본문은 코드 상수로 재구성해 plan·inspect stdout에서만 표시합니다. 사용자가 stdout을 파일로 redirect하면 해당 파일의 보관·삭제는 사용자 정책을 따릅니다. terminal 감사 metadata는 30일 후 명령 실행 시 정리하며 `SENT`·`UNKNOWN` 대상 marker는 DB 수명 동안 남깁니다. 게시 메시지는 Slack workspace의 보관 정책을 따릅니다. Node 네트워크 권한과 고정 URL 검증은 호스트별 OS 격리가 아닙니다. 상세 조건은 [4-B-2 계획](docs/implementation-plan.md#단계-4-b-2-고정-시험-문구의-slack-단건-전송)과 [보안 문서](docs/security-and-approval.md#단계-4-b-2의-고정-시험-문구-단건-전송)를 따릅니다.

## 단계 4-C-1 오프라인 브랜치 계획·승인

하네스가 Codex에 맡길 **대상 저장소 작업**의 브랜치 규칙을 합성 자료로 검증합니다. 작업 유형은 `feature`, `fix`, `chore`, `refactor` 중 명시하며 `<type>/synthetic-<task-id>`를 계획합니다. 실제 브랜치 생성·코드 수정·Codex 호출·commit·push·PR/MR은 수행하지 않습니다. 현재 하네스 저장소의 개발 브랜치 규칙을 바꾸는 기능도 아닙니다.

```sh
pnpm harness branch-plan --type fix --data-dir /private/tmp/harness-branch-data
pnpm harness branch-inspect --task <uuid> --data-dir /private/tmp/harness-branch-data
pnpm harness branch-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 30 --data-dir /private/tmp/harness-branch-data
pnpm harness branch-simulate --task <uuid> --plan-hash <sha256> --data-dir /private/tmp/harness-branch-data
pnpm harness branch-cancel --task <uuid> --data-dir /private/tmp/harness-branch-data
pnpm harness branch-invalidate --task <uuid> --event base-changed --revision 2 --event-id synthetic:base-change --data-dir /private/tmp/harness-branch-data
pnpm harness branch-recover --task <uuid> --data-dir /private/tmp/harness-branch-data
```

`<uuid>`와 `<sha256>`는 plan 출력의 `task.taskId`와 `task.plan.planHash`로 바꿉니다. 위 명령은 각 기능의 사용 예시이며 완료된 작업을 취소해 되돌리는 순서가 아닙니다. `branch-plan`의 선택 옵션 `--fixture success|collision|source-changed|unknown` 기본값은 `success`입니다. 다른 fixture로 충돌·기준 변경·불확실 결과를 재현합니다. `branch-invalidate`의 `--event`는 `edited|deleted|base-changed|diff-changed|branch-conflict`, revision은 2~1000000000이며 event ID는 필수입니다. `branch-cancel`은 선택 `--event-id`를 받습니다.

계획의 source 커밋·diff hash와 `gitlab.example.invalid` 원격은 고정 합성 식별자료입니다. 실제 경로·브랜치명·원격·본문·명령·모델 응답을 입력으로 받지 않습니다. 별도 `branches.sqlite`에 계획·승인·모의 시도·제어 이력을 저장하고 기존 DB의 승인을 재사용하지 않습니다. 계획은 24시간 유효하고 승인 TTL은 기본값 없는 정수 1~60분이며 계획 만료를 넘지 않습니다. `branch-inspect`의 `--approval-offset <0..1000000000>`은 기본 0으로 최신 승인 한 건과 `approvalPage.nextOffset`을 반환합니다.

승인 소비와 시도 `SIMULATING`을 원자 저장한 뒤 모의 adapter를 한 번 호출합니다. 성공은 `SIMULATED`, 충돌은 시도 `NOT_CREATED`·작업 `FAILED`, 불확실은 `UNKNOWN`입니다. 기준 변경 fixture는 계획부터 `BLOCKED`입니다. `branch-simulate`는 성공 시 종료 코드 0, 그 외 결과는 1입니다. 승인 전에는 모의 실행도 거부하며 실패 뒤에도 같은 작업을 재승인·재실행하지 않습니다. 새 프로세스의 조회는 중단된 `SIMULATING`을 보존하고 중단 상태의 명시적 복구는 `branch-recover`로 `UNKNOWN`을 확정합니다. 취소·무효화도 진행 중 시도를 `UNKNOWN`으로 차단합니다.

모든 명령은 전역 lease를 사용하므로 같은 데이터 디렉터리의 Slack 수신과 동시에 실행하지 않습니다. 제한 worker는 네트워크·하위 프로세스·추가 worker·상속 토큰 없이 비공개 데이터 디렉터리만 씁니다. metadata는 DB 수명 동안 보관하고 자동 정리하지 않습니다. 실제 Git/Codex 작업은 출력에서 `not_run`이며, 이 모의 승인은 후속 실제 실행 권한이 아닙니다. 상세 계약과 검증은 [4-C-1 계획](docs/implementation-plan.md#단계-4-c-1-오프라인-브랜치-계획승인모의-검증)과 [결과](docs/stage-4c1-result.md)를 따릅니다.

## 단계 4-C-2 합성 Git 브랜치 생성

4-C-1의 모의 승인과 분리한 경로입니다. `git-branch-plan`은 private data directory에 source와 workspace 합성 저장소를 각각 준비하고 `<type>/task-<task-id>` 브랜치를 계획합니다. 두 저장소의 고정 초기 커밋은 fixture 준비이며, 승인 후 작업 결과를 commit하는 기능은 없습니다. 실제 기존 저장소 경로·브랜치명·원격·코드·명령은 입력으로 받지 않습니다.

```sh
pnpm harness git-branch-plan --type fix --data-dir /private/tmp/harness-git-branch-data
pnpm harness git-branch-inspect --task <uuid> --data-dir /private/tmp/harness-git-branch-data
pnpm harness git-branch-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 30 --data-dir /private/tmp/harness-git-branch-data
pnpm harness git-branch-create --task <uuid> --plan-hash <sha256> --data-dir /private/tmp/harness-git-branch-data
pnpm harness git-branch-cancel --task <uuid> --data-dir /private/tmp/harness-git-branch-data
pnpm harness git-branch-recover --task <uuid> --data-dir /private/tmp/harness-git-branch-data
```

`--type`은 필수이며 `feature|fix|chore|refactor`를 받습니다. `<uuid>`와 `<sha256>`는 plan 출력의 `task.taskId`와 `task.plan.planHash`로 바꿉니다. 위 명령은 각 기능의 예시이며 완료된 브랜치를 취소해 삭제하는 순서가 아닙니다. 계획은 24시간 유효하며 승인 TTL은 기본값 없는 정수 1~60분, 계획 만료 이내입니다. `git-branch-inspect`의 선택 옵션 `--approval-offset <0..1000000000>`은 기본 0이고 최신 승인 한 건과 `approvalPage.nextOffset`을 반환합니다.

새 정책 `local-synthetic-branch-v1`과 `git-branches.sqlite`에 계획·승인·시도·전후 관찰을 저장합니다. 작업 영역은 `<data-dir>/git-branches/<uuid>/owner.json`, `source/`, `workspace/`입니다. source와 workspace는 Git 객체·메타데이터를 공유하지 않습니다. source는 읽기 전용으로 동결하고 workspace는 `.git/refs/heads`와 새 유형 디렉터리의 쓰기만 열어 둡니다. `HEAD`는 `main`에 유지되며 승인된 브랜치 ref 하나 외에 기존 파일·main·Git metadata를 바꾸지 않습니다. 실제 checkout·코드 변경·Codex 호출·작업 결과 commit·push·PR/MR은 수행하지 않습니다.

승인과 생성 직전에 root·소유 token·기준 커밋·source/workspace hash·ref 부재를 재검증합니다. 같은 커밋을 가리키는 기존 ref도 덮어쓰지 않습니다. 승인 소비·`RUNNING`·`claimed`를 원자 저장하고 `writing → created → finished` 단계와 시각을 기록합니다. ref는 배타적으로 생성하며 `O_SYNC`로 동기 쓰기를 요청합니다. 복구 검증은 프로세스 중단 범위이고 디렉터리 fsync·OS/전원 장애 내구성은 보장하지 않습니다. 정상 확인 결과는 `SUCCEEDED`이며 `git-branch-create`는 성공 시 종료 코드 0, 그 외 결과는 1입니다. 실패·중단 뒤에도 같은 작업을 재승인·재실행하지 않습니다.

새 프로세스의 inspect는 중단된 `RUNNING`을 보존합니다. `git-branch-recover`는 현재 파일을 조사해 `INTERRUPTED`, 취소가 기록되었으면 `CANCELLED`, 경계가 불확실하면 `BLOCKED`로 기록합니다. ref가 존재하더라도 중단 작업을 성공으로 소급하지 않습니다. 빈 유형 디렉터리는 ref 부재로, 부분 ref는 unsafe로 관찰하며 수리·재생성·삭제하지 않습니다. 대기 상태 cancel은 즉시 취소하지만 `RUNNING`의 내부 취소는 generation fence를 남긴 뒤 복구가 필요합니다. 모든 CLI 명령은 같은 전역 lease를 사용하므로 실행 중 별도 CLI cancel은 lease와 경합하며 실시간 중단 명령이 아닙니다.

제한 worker는 네트워크·child·추가 worker·상속 토큰 없이 하네스와 private data directory만 접근합니다. 합성 작업물·감사 metadata는 자동 정리하지 않습니다. 같은 OS 사용자와 신뢰하는 하네스 코드를 전제로 하며 악성 코드 실행용 sandbox는 아닙니다. 상세 계약과 검증 범위는 [4-C-2 계획](docs/implementation-plan.md#단계-4-c-2-합성-git-브랜치-생성관찰복구)과 [결과](docs/stage-4c2-result.md)를 따릅니다.

## 단계 4-C-3 합성 작업 브랜치의 수정·검사

`branch-execution-plan`은 `<data-dir>/branch-executions/<task-id>/source`에 고정 합성 Git 원본을 준비하고 `<type>/task-<task-id>` 브랜치·기준 커밋·허용 patch·등록 검사·Docker 정책을 함께 계획합니다. 원본 준비의 초기 commit은 fixture이며 작업 결과를 commit하는 기능은 없습니다. 승인 전에는 작업 브랜치·작업 트리·patch·Docker 실행을 만들지 않습니다.

```sh
pnpm harness branch-execution-plan --type fix --fixture success --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-branch-execution-data
pnpm harness branch-execution-inspect --task <uuid> --data-dir /private/tmp/harness-branch-execution-data
pnpm harness branch-execution-approve --task <uuid> --plan-hash <sha256> --base-commit <sha1> --expires-in-minutes 30 --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-branch-execution-data
pnpm harness branch-execution-run --task <uuid> --plan-hash <sha256> --base-commit <sha1> --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-branch-execution-data
pnpm harness branch-execution-cancel --task <uuid> --event-id synthetic-cancel-1 --data-dir /private/tmp/harness-branch-execution-data
pnpm harness branch-execution-invalidate --task <uuid> --event edited --revision 2 --event-id synthetic-edit-2 --data-dir /private/tmp/harness-branch-execution-data
pnpm harness branch-execution-recover --task <uuid> --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-branch-execution-data
```

위 명령은 기능별 사용 예시입니다. 계획 출력의 `task.taskId`, `task.plan.planHash`, `task.baseCommit`을 승인·실행 입력으로 사용합니다. 필수 `--type`은 `feature|fix|chore|refactor`이며 선택 `--fixture`는 `success|test-failure|timeout|output`, 기본값은 `success`입니다. 계획은 24시간 유효하며 승인 TTL은 기본값 없는 정수 1~60분, 계획 만료 이내입니다. 승인·실행 진입 때 유효기간을 확인하고 실행 중에는 generation 검사와 등록 명령의 강제 시간 제한을 사용합니다. `--config` 생략 시 기본 비활성 설정으로 계획만 만들 수 있으며 실제 실행은 정확한 로컬 Docker identity와 `enabled: true`를 묶은 새 계획이 필요합니다.

새 정책은 `synthetic-branch-execution-v1`, DB는 `branch-execution.sqlite`입니다. 3-C/D의 `synthetic-execution-v1`, 4-C-1의 모의 승인, 4-C-2의 ref 생성 승인을 사용하지 않습니다. 실행은 source와 Git 객체를 공유하지 않는 독립 worktree를 초기화한 뒤 ref를 배타적으로 만들고 symbolic HEAD를 그 브랜치로 선택합니다. source의 HEAD·main과 작업 영역의 main은 기준 커밋을 유지합니다. 선택 완료 뒤 전체 Git hash를 최초 증거로 저장하며 이후 patch·검사·복구에서 변경을 허용하지 않습니다. 기존 ref를 덮어쓰거나 reset하지 않습니다.

고정 `src/message.mjs` patch는 신뢰하는 하네스가 호스트의 승인된 합성 작업 영역에 적용합니다. 대상 코드를 호스트에서 실행하지 않으며 Docker에는 `.git` 없는 읽기 전용 view만 제공합니다. 등록 명령·로컬 이미지·네트워크 없음·nonroot·읽기 전용 root·16MiB tmpfs와 기존 3-C의 자원·시간·출력 제한을 유지합니다. 브랜치 계획은 DB의 Task·승인 snapshot에 보관합니다. `branch-executions/<task-id>/run-<artifact-id>/report.json`과 DB Run에는 브랜치 검증과 검사별 `passed`·`failed`·`not_run`, 실제 diff, Git·원본·view 관찰을 기록합니다. `branch-execution-run`은 `SUCCEEDED`일 때 0, 그 외 결과는 1로 종료합니다.

`branch-execution-inspect`는 선택 `--approval-offset <0..1000000000>`으로 최신 승인 한 건과 다음 offset을 조회하고 누락된 완료 보고서를 재생성합니다. inspect·cancel·invalidate는 3-D와 같이 전역 lease를 우회하는 짧은 DB 트랜잭션으로 실행 중 상태를 조회·제어합니다. cancel의 event ID는 선택이고 invalidate는 `edited|deleted`, revision 2~1000000000과 event ID가 필수입니다. 실행·복구는 전역 lease를 유지합니다. 취소는 새 동작과 늦은 성공을 차단하고 소유권이 확인된 container를 정리하며 이미 만든 ref·파일을 되돌리지 않습니다.

브랜치 생성·선택 중 최초 Git 증거 저장 전에 중단되어 작업 영역이 남으면 `BLOCKED`로 보존합니다. 증거 저장 뒤 명시 recover는 소유 container 정리와 현재 파일·Git·view 관찰만 수행하며 확인된 중단은 `INTERRUPTED`, 취소는 `CANCELLED`, 불확실한 경계는 `BLOCKED`입니다. 승인 소비 복원·자동 재실행·수리·작업물 삭제는 없습니다. 실제 Codex·회사 저장소·임의 patch나 명령·작업 결과 commit·push·PR/MR은 제공하지 않습니다. 최종 검증 상태와 한계는 [4-C-3 계획](docs/implementation-plan.md#단계-4-c-3-합성-작업-브랜치의-수정검사-연결)과 [결과](docs/stage-4c3-result.md)를 따릅니다.

## 단계 4-C-4 Codex 합성 제안과 별도 실행 승인

`codex-proposal-plan`은 고정 합성 입력만 보여 주고 호출 승인을 기다립니다. 임의 요청 본문·저장소·경로·명령을 입력받지 않습니다. 표시한 입력, 모델, 인증 방식, 고정 전송 endpoint, 호출 한도, 시간·출력 제한과 계획 해시를 검토해야 합니다. 계획은 24시간, 호출 승인은 필수 1~60분입니다.

`config/codex.example.json`은 기본 비활성입니다. 저장소 밖의 비공개 설정에 실제 native Codex 0.154.0 경로·SHA-256·모델을 고정하고 `enabled: true`로 설정합니다. `authMode: "chatgpt"`는 현재 OS 사용자의 기존 `~/.codex/auth.json`을 **run에서만** 읽습니다. 유효한 로그인이 없으면 `CODEX_LOGIN_REQUIRED`로 멈추고 자동 refresh나 로그인 파일 변경을 하지 않습니다. 선택 가능한 `authMode: "api-key"`는 run 프로세스의 `CODEX_PROPOSAL_API_KEY`를 사용하며 누락 시 `API_KEY_REQUIRED`로 멈춥니다. 인증값을 CLI 옵션·설정 파일·명령 예제에 넣지 않습니다.

```sh
pnpm harness codex-proposal-plan --type fix --codex-config /absolute/path/to/private-codex.json --data-dir /private/tmp/harness-codex-data
pnpm harness codex-proposal-inspect --task <proposal-uuid> --data-dir /private/tmp/harness-codex-data
pnpm harness codex-proposal-approve --task <proposal-uuid> --plan-hash <proposal-sha256> --expires-in-minutes 30 --codex-config /absolute/path/to/private-codex.json --data-dir /private/tmp/harness-codex-data
pnpm harness codex-proposal-run --task <proposal-uuid> --plan-hash <proposal-sha256> --codex-config /absolute/path/to/private-codex.json --data-dir /private/tmp/harness-codex-data
pnpm harness codex-proposal-cancel --task <proposal-uuid> --data-dir /private/tmp/harness-codex-data
pnpm harness codex-proposal-recover --task <proposal-uuid> --data-dir /private/tmp/harness-codex-data
```

인증은 부모 broker 메모리에만 두고 Codex 자식에는 단건 broker capability를 제공합니다. 자식은 빈 HOME·CODEX_HOME과 고정 합성 입력을 사용하며 기존 사용자 설정·skills·MCP·로그인 파일을 전달받지 않습니다. macOS 외부 sandbox의 파일·프로세스·네트워크 제한과 호출 전 진단을 함께 요구합니다. 생성 코드는 호스트나 Codex 자식에서 실행하지 않습니다. 호출은 한 번만 허용하고 실패·취소·중단 후 같은 제안을 자동 재시도하지 않습니다. `recover`는 남은 `RUNNING`을 `INTERRUPTED`로 기록하며 승인 소비를 복원하지 않습니다.

응답은 최대 16KiB의 정확한 JSON `{path, content}`여야 합니다. `path`는 `src/message.mjs` 하나로 제한하고 크기·비밀 패턴·동일 내용 등을 검사합니다. 검증을 통과한 `READY`도 실행 승인이 아닙니다. 다음 명령이 제안을 `EXPORTED`로 한 번 소비하고 같은 UUID의 새 실행 계획을 만듭니다. 원본·실행 DB 준비가 소비 이후 실패해도 `READY`로 되돌리지 않습니다.

```sh
pnpm harness codex-execution-plan --proposal <proposal-uuid> --codex-config /absolute/path/to/private-codex.json --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-codex-data
pnpm harness codex-execution-inspect --task <proposal-uuid> --data-dir /private/tmp/harness-codex-data
pnpm harness codex-execution-approve --task <proposal-uuid> --plan-hash <execution-sha256> --base-commit <sha1> --expires-in-minutes 30 --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-codex-data
pnpm harness codex-execution-run --task <proposal-uuid> --plan-hash <execution-sha256> --base-commit <sha1> --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-codex-data
pnpm harness codex-execution-cancel --task <proposal-uuid> --event-id synthetic-cancel-1 --data-dir /private/tmp/harness-codex-data
pnpm harness codex-execution-invalidate --task <proposal-uuid> --event edited --revision 2 --event-id synthetic-edit-2 --data-dir /private/tmp/harness-codex-data
pnpm harness codex-execution-recover --task <proposal-uuid> --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-codex-data
```

새 실행 정책은 `synthetic-codex-execution-v1`입니다. 제안의 유형과 검증된 전체 파일 내용, 입력·설정·응답 해시, 기준 커밋, 등록 검사와 Docker 정책을 새 계획에 묶습니다. `--type`·`--fixture`로 이를 바꿀 수 없습니다. 실행 승인도 필수 1~60분이며 제안 호출 승인과 기존 단계 승인은 재사용하지 않습니다. 승인 뒤에만 독립 합성 작업 브랜치를 선택하고 제안 코드를 적용합니다. 등록 검사는 인증·네트워크 없는 Docker의 읽기 전용 view에서 실행합니다. 원본 HEAD·main과 작업 영역 main 보존, 취소·무효화·중단 복구 경계는 4-C-3과 같습니다.

제안 inspect·cancel과 실행 inspect·cancel·invalidate는 전역 lease 중에도 동작하며 나머지는 lease를 요구합니다. 두 inspect 모두 `--approval-offset <0..1000000000>`을 지원합니다. 제안 run은 `READY`, 실행 run은 `SUCCEEDED`일 때만 종료 코드 0입니다. 회사 자료·회사 저장소·작업 결과 commit·push·PR/MR은 범위 밖입니다. 유형별 브랜치 규칙은 하네스가 맡기는 대상 작업에 적용하며 이 하네스 저장소의 개발 브랜치 규칙을 바꾸지 않습니다.

기존 ChatGPT 로그인으로 실제 제안을 받아 별도 승인·브랜치 적용·Docker 검사까지 확인했습니다. 전체 530개 테스트와 지원 범위·실패 기록은 [4-C-4 결과](docs/stage-4c4-result.md)에 기록했습니다. 기본 테스트에서는 실제 macOS 종료 감시 테스트 3개를 건너뛰며, macOS arm64에서 `HARNESS_NATIVE_CODEX_PROBE=1 pnpm test`로 포함할 수 있습니다. 이 테스트는 실제 모델 호출이나 로그인 정보를 사용하지 않습니다.

## 단계 4-C-5 합성 다중 파일 읽기 전용 조사

`readonly-investigation-*`는 등록된 `flow` fixture의 controller·service·설정·README를 읽고 승인한 근거만 격리된 고정 응답 worker에 전달합니다. `mode: mock` 전용이며 실제 모델·인증정보·네트워크를 사용하지 않습니다. 읽기와 전송 범위를 구분하고 `writeAllowedFiles=[]`, `testCommandIds=[]`, `executionAllowed=false`를 유지합니다.

```sh
# 네 파일을 읽고 controller 근거만 전송하는 계획
pnpm harness readonly-investigation-plan --fixture flow --selection all --transfer controller
pnpm harness readonly-investigation-inspect --task <uuid>
# inspect의 task.plan.planHash와 payload.inputText를 검토한 뒤 명시적 TTL로 승인
pnpm harness readonly-investigation-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 10
pnpm harness readonly-investigation-run --task <uuid> --plan-hash <sha256>
pnpm harness readonly-investigation-inspect --task <uuid>

pnpm harness readonly-investigation-cancel --task <uuid>
pnpm harness readonly-investigation-invalidate --task <uuid>
pnpm harness readonly-investigation-recover --task <uuid>
pnpm harness readonly-investigation-prune
```

모든 명령은 선택적으로 `--data-dir <private-directory>`를 받으며 같은 조사에는 같은 저장 위치를 사용해야 합니다. `plan`의 `--selection all|controller|service`는 읽기 구간을, `--transfer all|controller|service`는 그중 전달할 근거를 선택합니다(기본값 모두 `all`). 읽지 않은 파일을 전송 대상으로 고르면 거부합니다. 합성 요청은 `--request flow-question|change-request`만 허용하며 기본값은 `flow-question`입니다. 임의 root·본문·목적지·live 옵션은 받지 않습니다. 승인 이력은 `inspect --approval-offset <0..1000000000>`로 한 건씩 조회합니다.

계획·내용 payload는 생성 후 24시간, 승인 TTL은 1~60분입니다. 승인 소비·단일 attempt를 먼저 저장하며 실패·시간 초과·중단에도 다시 호출하지 않습니다. `cancel`·`invalidate`는 실행 중에도 generation을 변경해 늦은 응답을 막습니다. 부모 종료 후 `recover`는 신뢰하는 로컬 프로세스 기록으로 종료를 확인하면 `INTERRUPTED`, 확인할 수 없으면 `BLOCKED`를 기록합니다. 복구는 호출을 재개하지 않습니다.

내용은 전용 `readonly-investigations.sqlite`의 payload에 저장하고 승인·감사에는 ID·해시·범위·상태를 보관합니다. 명령 시작과 `prune`에서 만료 payload를 제거하며 감사는 최초 terminal 전환부터 30일 후 정리합니다. 최소 중복 방지 marker는 유지하고 합성 원본·Git·남은 작업물은 자동 삭제하지 않습니다. 보고서는 `mode: mock`, 의미 정확성 미검증, 실제 모델/외부 전송 `not_run`을 표시합니다. 실행 계획으로 내보내는 명령은 없습니다. 검사별 결과와 미실행 범위는 [4-C-5 결과](docs/stage-4c5-result.md)를 따릅니다.

## 단계 4-C-6 합성 문맥의 오프라인 전송 검증

`readonly-transport-*`는 등록된 합성 문맥으로 최종 요청 본문을 만들고 새 승인 후 가짜 전송기에 한 번 전달합니다. `mode: offline`, `transport: fake` 전용이며 실제 모델·인증정보·외부 전송 경로를 연결하지 않습니다. 기존 `readonly-investigation-*`의 mock 계획·승인은 별도로 유지합니다.

```sh
pnpm harness readonly-transport-plan --fixture flow --selection all --transfer controller --profile json
pnpm harness readonly-transport-inspect --task <uuid>
# 최종 요청 본문과 requestBodyHash, task.plan.planHash를 검토한 뒤 승인
pnpm harness readonly-transport-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 10
pnpm harness readonly-transport-run --task <uuid> --plan-hash <sha256>
pnpm harness readonly-transport-inspect --task <uuid>

pnpm harness readonly-transport-cancel --task <uuid>
pnpm harness readonly-transport-invalidate --task <uuid>
pnpm harness readonly-transport-recover --task <uuid>
pnpm harness readonly-transport-prune
```

모든 명령은 `--data-dir <private-directory>`를 선택적으로 받습니다. `plan`의 `--selection all|controller|service`와 `--transfer all|controller|service`는 읽기와 전달 근거를 각각 선택하며 기본값은 `all`입니다. `--request flow-question|change-request`의 기본값은 `flow-question`입니다. `--profile json|stream`은 고정 가짜 응답 형식이며 기본값은 `json`입니다. `stream`은 로컬 NDJSON 계약으로 외부 공급자의 스트리밍 규격을 검증하는 옵션이 아닙니다. 실제 모델명·URL·인증·live·임의 본문 옵션은 없습니다. 승인 이력은 `inspect --approval-offset <0..1000000000>`으로 조회합니다.

`contextHash`는 전체 근거, `inputHash`는 선택한 문맥 입력, `requestBodyHash`는 모델·지시문·schema·도구/보관/stream 설정까지 포함한 최종 직렬화 본문을 식별합니다. 표시한 본문을 그대로 전달하며 요청은 256KiB, 전체 응답은 256KiB, 최종 조사 JSON은 16KiB, 전달은 한 번·최대 60초로 제한합니다. 수정 파일과 대상 명령 목록은 빈 배열입니다.

승인은 명시적 TTL 1~60분, 계획·내용은 최대 24시간입니다. 단일 소비와 전달 예약을 먼저 저장하고 실패·취소·중단 후 재시도하지 않습니다. 부모 종료 후 명시 `recover`는 원본·본문 해시·프로세스 종료 증거를 확인하며 확실한 중단은 `INTERRUPTED`, 불확실하면 `BLOCKED`로 남깁니다. 검증된 내용만 private payload에 보관하고 잘못된 raw/부분 응답은 폐기합니다. 감사는 최초 terminal 전환부터 30일, 최소 소비 marker는 DB 수명 동안 유지합니다. 원본·Git·잔여 작업물은 자동 삭제하지 않습니다.

결과는 `responseOrigin: synthetic`과 의미 정확성 미검증을 명시합니다. 실제 모델·인증 접근·외부 전송·공급자 API 호환성은 `not_run`입니다. 수용 기준과 실제 검증 결과는 [4-C-6 결과](docs/stage-4c6-result.md)를 따릅니다.

## 단계 4-C-7 다중 파일 모델 연결의 오프라인 준비

`readonly-model-preflight-*`는 합성 다중 파일 문맥을 후보 요청 형식으로 바꾸고, 인증정보 없는 HTTP 명세를 새 승인 후 메모리 가짜 전송기로 검증합니다. `offline`/`in-memory-fake` 전용이며 `https://model.invalid/v1/responses`는 검토할 명세의 시험 문자열입니다. 실제 연결·인증정보 조회·모델 SDK/CLI 호출은 없습니다. 기존 4-C-5/4-C-6의 계획과 승인은 재사용하지 않습니다.

```sh
pnpm harness readonly-model-preflight-plan --fixture flow --selection all --transfer controller --profile json
pnpm harness readonly-model-preflight-inspect --task <uuid>
# 요청 본문, profile/envelope hash와 task.plan.planHash를 검토한 뒤 승인
pnpm harness readonly-model-preflight-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 10
pnpm harness readonly-model-preflight-run --task <uuid> --plan-hash <sha256>
pnpm harness readonly-model-preflight-inspect --task <uuid>

pnpm harness readonly-model-preflight-cancel --task <uuid>
pnpm harness readonly-model-preflight-invalidate --task <uuid>
pnpm harness readonly-model-preflight-recover --task <uuid>
pnpm harness readonly-model-preflight-prune
```

모든 명령은 `--data-dir <private-directory>`를 선택적으로 받습니다. `plan`의 `--selection all|controller|service`와 `--transfer all|controller|service`는 읽기 범위와 전달 근거를 구분하며 기본값은 `all`입니다. `--request flow-question|change-request`의 기본값은 `flow-question`, `--profile json|sse`의 기본값은 `json`입니다. URL·모델·헤더·인증·live·임의 본문 옵션은 받지 않습니다. 승인 이력은 `inspect --approval-offset <0..1000000000>`로 조회합니다.

`contextHash`·`inputHash`·`requestBodyHash`와 `connectionProfileHash`·`requestEnvelopeHash`를 승인과 전달 예약·복구에 결합합니다. `text.format`의 조사 schema, 빈 도구·수정 파일·대상 검사 목록을 유지합니다. JSON/SSE는 로컬 코드에 기록된 형식의 제한된 후보 계약입니다. SSE는 UTF-8/chunk·frame·ID·이벤트 순서·delta/최종 text 일치를 검사하며 도구·refusal·`[DONE]`·`usage`·추가 출력은 지원하지 않습니다. 공급자 호환성을 검증한 결과가 아닙니다.

전달/응답 최대 55초와 정리 최대 5초, 전달 최대 1회·재시도 0회를 적용합니다. 취소 후 늦은 결과를 저장하지 않고 종료 증거가 불확실하면 `BLOCKED`로 남깁니다. 부모 강제 종료 뒤 `recover`는 재호출 없이 `INTERRUPTED`/`BLOCKED`로 정리합니다.

상태는 별도 `readonly-model-preflights.sqlite`에 보관합니다. 계획/내용은 생성 후 24시간, 승인 TTL은 명시적 1~60분, 본문 없는 감사는 최초 terminal부터 30일이며 최소 소비 marker는 DB 수명 동안 유지합니다. 원본/Git/실패 작업물은 자동 삭제하지 않습니다. 보고서는 `liveReady=false`, 의미 정확성 미검증과 실제 모델·인증 접근·외부 전송·공급자 호환성·live 격리 `not_run`을 표시합니다. [4-C-7 결과](docs/stage-4c7-result.md)에 수용 135~150의 근거를 기록합니다.

## 단계 4-C-8 합성 다중 파일의 실제 모델 읽기 전용 조사

최신 metadata 진단 실제1회는 `created/access-programs/value`로 실패했습니다. 현재 SSE created 내부 response에서 non-null `access_programs`가 기존 생략/null 전용 검사에 거부된 사실만 확인했고 실제 값의 형태·의미·도구 활동은 미확인입니다. 승인·소비·전송 각1회·재시도0회이며 원본/Git 보존·프로세스 종료·sandbox 부재는 사후 감사 passed입니다. [최신 기록](docs/stage-4c8-result.md#metadata-진단-계획의-승인된-실제-단건-호출)을 우선하며 아래 내용은 이전 실제 실패 이력입니다.

2026-11-13에 재생성한 v9 계획을 TTL10분으로 별도 승인해 실제1회 호출했고, 응답 metadata 검증에서 실패했습니다. 승인·attempt·소비·실제 전송은 각1회, 자동 재시도0회입니다. 원본/Git과 코드 hash 보존, controller·guardian·child·프로세스 그룹 종료 및 sandbox 부재를 확인했습니다. 현재 상태는 `FAILED`이며 [최신 실행·감사 기록](docs/stage-4c8-result.md#v9-승인된-실제-단건-호출과-사후-감사)을 따릅니다. 유효 보고서가 없어 수용162는 미완료입니다.

`readonly-live-*`는 등록된 합성 `flow` fixture에서 승인한 근거만 고정 모델에 전달합니다. 기존 4-C-5/6/7 명령과 승인은 유지합니다. 이전 response 진단 실제1회는 `event=created`, `reason=envelope`, `missing=[]`, 예상 밖 속성5개·overflow 없음으로 실패했습니다. 모두 미등록 field 분류이며 array1·음수가 아닌 정수2·null1·object1입니다. 구체 이름·의미는 미확인이고 이전 v8의 origin으로 소급 적용하지 않습니다. 당시 유효 보고서·responseHash는 null이었으며 upstream14회 실패·전송 전 준비 실패1회·소비 승인15개·자동 재시도0회의 이력으로 보존합니다.

`config/readonly-live.example.json`은 기본 비활성인 설정 예제입니다. 저장소 밖 현재 OS 사용자 소유의 비공개 `0600` 설정 파일에 native Codex 경로·SHA-256을 고정합니다. v1~v8의 기존 설정/profile 계약은 보존합니다. v2 이후 요청 헤더32개·8KiB, 응답 헤더64개·16KiB, 모델 `gpt-6.1-sol`, 인증 `chatgpt`, 호출60초·최종 JSON16KiB는 고정입니다. 비활성 설정으로 계획은 검토할 수 있지만 승인·실행은 거부합니다. 버전·`enabled`를 포함한 설정 변경은 새 계획과 승인을 요구합니다. 기존 로그인은 승인된 run adapter에서만 읽고 계획·승인·조회·취소·복구·정리는 인증에 접근하지 않습니다.

v3 profile은 decoder `readonly-live-response-v2`와 `discard-set-cookie-v1` 정책을 고정합니다. 응답 `Set-Cookie`는 중복을 허용하되 모든 항목을 헤더 수·바이트 한도와 문자 검사에 포함한 뒤 즉시 버립니다. 쿠키를 저장·전달·재사용하지 않으며 다른 중복 헤더는 거부합니다. 이 보완이 앞선 실제 실패의 원인이었다는 증거는 없습니다.

v4는 v3 metadata/SSE 계약을 유지하며 decoder `readonly-live-response-v3`와 `http-token-discard-set-cookie-v1`을 결합합니다. HTTP token 헤더 이름, ASCII·HTAB 값, MIME 공백·따옴표 UTF-8과 identity 대소문자 정규화를 보완하고 거부 조건별 정적 오류를 구분합니다. 비ASCII·압축·Location·Retry-After 거부와 쿠키 폐기는 유지합니다. 로컬 검증을 완료했으나 실제 실패 원인이 해결됐다고 단정하지 않습니다.

4-C-4 성공 경로와 비교한 결과 `fetch`의 자동 압축 해제와 새 원시 HTTPS 수신·헤더 검증의 차이를 확인했습니다. 기존 기록으로는 실제 거부 조건을 복원할 수 없습니다. 향후 `call-report.json`의 `http.headerDiagnostics`에는 MIME/encoding 고정 분류, 문법 위반·중복·쿠키 개수와 Location/Retry-After 존재 여부만 남깁니다. 원시 헤더 이름·값·쿠키는 저장하지 않으며 이 관찰 보완은 응답 허용 조건이나 계획 hash를 바꾸지 않습니다.

v5는 `Content-Type` 헤더가 없는 경우에만 제한된 본문 접두어로 JSON 또는 SSE를 선택합니다. 선택 뒤에는 기존 완료 응답·도구 차단·조사 schema·근거·크기 검증을 그대로 적용하며 파서 실패 시 다른 형식으로 재시도하지 않습니다. 명시된 잘못된 MIME·압축·HTML·미완성 응답은 계속 거부합니다. decoder `readonly-live-response-v4`와 `responseFormatPolicy=content-type-or-bounded-body-v1`을 새 승인 해시에 결합하고, v1~v4 계약은 변경하지 않습니다.

기존 고정 진단과 새 `response`는 원문 없이 경로·거부 경계·제한된 필드 분류와 계수만 기록합니다. 이전 response 진단 호출에는 전체985개·집중88개·lint/typecheck/build를 통과한 코드를 사용했습니다(전체 실패/skip0, 약70.7초). 별도 v9 추가 JSON 호환 정책은 구현과 전체1005개·집중121개 검증을 마쳤습니다. 기존 v1~v8 계약·profile·hash는 보존합니다. 이후 재생성한 v9 계획을 별도 승인해1회 실행했으나 RESPONSE_METADATA로 실패했습니다. 승인·attempt·전송 각1회·자동 재시도0회입니다. 상세 이력은 [4-C-8 결과](docs/stage-4c8-result.md)를 따릅니다.

새 `response` 진단은 direct-response/created/in-progress/completed 경로와9종 거부 경계를 고정 enum으로 구분합니다. 키 검사 실패 때만 누락·예상 밖 필드의 고정 분류·8종 값 형태·횟수·overflow를 기록하며 원문 키·값·ID는 저장하지 않습니다. 필수5개·기존 선택28개와 관찰용8개 이름은 구분하고, 관찰 사전에 이름을 추가해도 응답을 허용하지 않습니다.

추가된 `metadata={event,field,reason}` 진단은 `RESPONSE_METADATA` 거부에서만 현재 decoder의 첫 실패 경계를 기록합니다. 경로4개·소스에 등록된 field39개·검사 사유6개만 허용하며 원문 키·값·응답 조각·ID·offset은 보관하지 않습니다. `shape/value/integer/number/text/size`는 실패한 검사 경계이고 원문 값의 확정된 형태 설명이 아닙니다. 정확한 own data property3개와 enum만 복사·동결하고 getter·symbol·추가 속성을 거부합니다. 내부 등록과 현재 decode 검증 경로를 확인하므로 transport/stream의 위조 오류와 과거 진짜 오류의 재생은 진단 증거가 되지 않습니다. v1/v2의 generic 오류와 `OUTPUT_LIMIT`·`TOOL_USAGE_ACTIVITY`, 기존 response 진단·profile/config/본문/명세 hash를 유지합니다. 이전 실제 실패의 필드·origin을 소급 확인한 것은 아닙니다. 이번 진단을 사용한 실제1회 결과는 최신 실행·감사 기록을 따릅니다.

추가한 `sseEnvelope`는 필수 키 누락의 고정 분류와 예상 밖 root 속성의 고정 필드·값 형태·횟수만 기록합니다. 최대128개 root 속성·32개 조합까지 집계하고 초과는 overflow로 표시합니다. 미등록 이름은 other로 분류하며 원문 키·값·ID는 보관하지 않습니다. 기존 v3~v7 응답 허용 조건·오류 code와 profile/config/body/envelope hash는 그대로입니다.

v8는 첫 `response.created`의 root에 추가 필드가 정확히1개이고 boolean이며 이름이 ASCII 식별자1~64자인 경우에만 그 필드를 검증용 사본에서 제외합니다. 알려진 SSE·제어·prototype 키는 제외할 수 없습니다. 기존 필수3키 검증과 원본 전체 민감정보 검사·sequence·내부 response·도구·완결성·크기 제한은 유지하고 추가 필드는 동작에 사용하지 않습니다. 이는 [공식 API의 이벤트 속성 추가 호환 정책](https://developers.openai.com/api/reference/overview#backwards-compatibility)을 참고한 제한적 정책이며 ChatGPT endpoint의 확정 schema 보장은 아닙니다. 실제 필드명·의미·ASCII 형태는 여전히 미확인입니다. 구형 v1~v7 계약은 그대로 두고 새 v8 profile·계획·승인을 요구합니다.

v9는 response의 알려진 필드를 기존대로 검사하고, 추가 JSON 필드만 최대8개·root 이름 ASCII 식별자64자·canonical UTF-8 합계16KiB·256노드·깊이8로 제한해 검증용 사본에서 제외합니다. 유한한 JSON 값만 받으며 제어/prototype root 키는 거부합니다. 제외할 원본 자료에도 숫자 별칭 없는 민감정보 검사를 적용하고 추가 자료는 보고서·상태·동작에 사용하지 않습니다. 새 `bounded-inert-json-v1` 정책과 한도를 profile에 결합하므로 새 계획·승인이 필요합니다. 구현과 전체1005개·집중121개 검증을 마쳤으며 재생성한 계획의 별도 승인 후 실제1회는 RESPONSE_METADATA로 실패했습니다.

v6는 공식 `tool_usage`의 정확한 경로·객체 형태를 검사한 숫자 집계만 민감정보 검사용 별칭으로 투영합니다. `tools=[]` 경계를 위한 하네스의 추가 정책으로 모든 수치를0으로 제한하고, 0이 아닌 집계는 정적 `TOOL_USAGE_ACTIVITY` 오류로 차단합니다. 실제 도구 호출·이벤트·출력은 계속 거부하며 v1~v5는 변경하지 않습니다. 공식 문서에서 집계0이나 선택 필드 생략은 도구 미실행의 증명이 아니므로 그렇게 해석하지 않습니다.

v7는 [공식 생성 이벤트 예시](https://developers.openai.com/api/reference/resources/responses/streaming-events)의 시작 sequence1을 지원하도록 첫 값을0 또는1로 받고 이후 연속성 검사는 유지하는 보완입니다. 원문 없는 정적 SSE 진단도 구현했습니다. 이번 v6 실패가 sequence 때문이었다고 확정한 것은 아니며, 구형 계약과 도구·출력·완료·근거·크기 검증은 유지합니다.

`readonly-live-run`은 승인 소비 전에 고정 바이너리의 존재·안전성·SHA-256을 확인합니다. 준비 검사 실패는 승인과 attempt를 소비하지 않으며, 준비 뒤 시간·취소·계획을 다시 검사합니다. 실행 직전의 바이너리 재검증도 유지합니다. native 합성 회귀에서 같은 0.154.0 바이너리를 별도 경로에 보관했다면 `HARNESS_NATIVE_CODEX_PROBE=1 HARNESS_NATIVE_CODEX_PATH=/absolute/path/to/codex pnpm test`로 지정할 수 있습니다. 이 환경변수는 테스트에만 적용되고 고정 SHA-256·버전 검사를 바꾸지 않습니다. 실제 CLI 실행 경로는 검토한 비공개 config에 명시해야 합니다.

```sh
pnpm harness readonly-live-plan --fixture flow --selection all --transfer controller --request flow-question --config /absolute/path/to/private-readonly-live.json --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-inspect --task <uuid> --data-dir /private/tmp/harness-readonly-live-data
# payload.inputText·requestBody·requestEnvelope와 설정, 다섯 hash·planHash를 검토한 뒤 승인
pnpm harness readonly-live-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 10 --config /absolute/path/to/private-readonly-live.json --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-run --task <uuid> --plan-hash <sha256> --config /absolute/path/to/private-readonly-live.json --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-inspect --task <uuid> --data-dir /private/tmp/harness-readonly-live-data

pnpm harness readonly-live-cancel --task <uuid> --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-invalidate --task <uuid> --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-recover --task <uuid> --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-prune --data-dir /private/tmp/harness-readonly-live-data
```

plan/approve/run은 `--config`가 필수입니다. plan의 `--selection all|controller|service`는 읽기 범위, `--transfer all|controller|service`는 그중 전송 근거를 선택하며 기본값은 `all`입니다. `--request flow-question|change-request`의 기본값은 `flow-question`입니다. profile은 설정 버전에 결합되며 임의 URL·모델·헤더·인증·저장소·본문·profile 옵션은 없습니다. v1~v7 실제 실패 이력과 로컬 검증 통과를 구분합니다. 변경 요청도 읽기 전용 보고서만 만들며 수정 파일·대상 검사 목록은 빈 배열입니다.

계획·내용은 생성부터 24시간, 승인 TTL은 명시적 1~60분입니다. 승인 소비와 단일 전달 예약 이후 원본·기간·설정·generation을 다시 확인하고 최대 한 번 전송합니다. 인증은 부모 broker 메모리에만 두며 Codex에는 빈 HOME/CODEX_HOME과 단건 capability만 제공합니다. 승인된 최종 본문을 고정 endpoint에 전달하고 retry·redirect·다른 모델 fallback을 하지 않습니다. 실패·취소·중단은 승인 소비를 복원하지 않으며, HTTP 취소를 원격 미접수나 서버 측 추론 종료 증거로 간주하지 않습니다.

응답은 완성된 조사 JSON과 전송한 근거 인용을 검증한 뒤 로컬에 보관합니다. schema 통과는 내용의 의미 정확성을 보증하지 않습니다. 실제 연결 증거와 합성 port 검증을 분리하고 수행하지 않은 검사는 `not_run`으로 남깁니다. 내용은 24시간, 본문 없는 감사는 최초 terminal부터 30일, 최소 소비 marker는 DB 수명 동안 보존합니다. 자식 종료 후 새로 만든 모델 임시 디렉터리와 빈 HOME/CODEX_HOME만 identity를 확인해 제거합니다. 합성 원본/Git·DB·감사 및 실패 작업물은 보존하며, 프로세스 종료나 임시 디렉터리 제거가 불확실하면 `BLOCKED`로 남깁니다.

inspect·cancel·invalidate는 전역 lease 중에도 동작하며 나머지는 lease를 요구합니다. inspect는 `--approval-offset <0..1000000000>`을 지원합니다. run은 `REPORTED`일 때만 종료 코드 0입니다. recover는 인증·모델·네트워크 없이 종료·원본·명세 증거를 확인하며 불확실하면 `BLOCKED`로 남깁니다. 회사 자료·실제 저장소·Slack·대상 코드 실행·브랜치/patch·commit/push·PR/MR과 실행 계획 export는 제공하지 않습니다. 기존 대상 작업 브랜치 규칙은 하네스 자체의 개발 규칙으로 확대하지 않습니다.

## ChatGPT 로그인 유지 relay 검토

후속 방향은 ChatGPT 로그인을 유지하고 공급자 응답 해석을 고정 Codex에 맡기는 relay다. 첫 구현은 실제 인증·모델 호출 없이 등록 합성 SSE를 native Codex에 전달하는 로컬 probe이며, 기존 v1~v9 명령과 승인은 유지한다. 공개 API 키 전환이나 `access_programs` 개별 허용 추가는 진행하지 않는다.

relay의 원시 metadata·도구 집계 검증과 최종 보고서 검증은 보증 범위가 달라진다. [전환 계획](docs/implementation-plan.md#단계-4-c-9-chatgpt-로그인-유지와-codex-응답-해석으로-전환)과 [로컬 결과](docs/stage-4c9-result.md)에 그 차이를 기록한다. 첫 probe는 `liveReady=false`인 합성 실험으로 유지한다. 별도 relay 계약·adapter·승인 저장소를 구현한 뒤 정확한 계획을 TTL10분으로 승인해 실제1회 호출했으나 HTTP200 응답 본문의256KiB 상한 초과로 실패했다. 유효 보고서는 없으며 원본/Git·프로세스 종료 사후 감사를 수행했다. 자동 재시도는0이고 소비 승인을 재사용하지 않는다. [실제 단건 결과](docs/stage-4c9-result.md#승인된-relay-실제-단건-호출과-사후-감사)를 참조한다.

## 단계 4-C-9 별도 relay 계약과 승인

`synthetic-readonly-relay-v1`·`codex-chatgpt-relay-v1`은 기존 ChatGPT 로그인과 고정 native Codex를 사용하는 새 계약입니다. `readonly-live-*`의 v1~v9 정책·DB·승인·hash는 유지하며 새 `readonly-relay.sqlite`와 `readonly-relay-runs/`를 사용합니다. 설정 예시 [readonly-relay.example.json](config/readonly-relay.example.json)은 기본 비활성입니다. 복사한 private 설정의 native 경로·SHA-256을 실제 검증한 값으로 지정해야 합니다. enabled 변경도 계획 hash가 달라지므로 새 계획이 필요합니다.

```sh
pnpm harness readonly-relay-plan --fixture flow --config /private/path/relay.json --selection all --transfer all --request flow-question --data-dir /private/path/relay-data
pnpm harness readonly-relay-inspect --task <uuid> --data-dir /private/path/relay-data
# 정확한 payload·profile·명세·설정과 planHash를 검토하고 별도 승인한 뒤에만 사용
pnpm harness readonly-relay-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 10 --config /private/path/relay.json --data-dir /private/path/relay-data
pnpm harness readonly-relay-run --task <uuid> --plan-hash <sha256> --config /private/path/relay.json --data-dir /private/path/relay-data
pnpm harness readonly-relay-cancel --task <uuid> --data-dir /private/path/relay-data
pnpm harness readonly-relay-invalidate --task <uuid> --data-dir /private/path/relay-data
pnpm harness readonly-relay-recover --task <uuid> --data-dir /private/path/relay-data
pnpm harness readonly-relay-prune --data-dir /private/path/relay-data
```

plan/approve/run은 `--config`가 필수입니다. fixture는 `flow`, selection/transfer는 `all|controller|service`, request는 `flow-question|change-request`만 허용합니다. inspect는 `--approval-offset <0..1000000000>`을 지원합니다. inspect/cancel/invalidate 외 명령은 전역 lease를 사용하고, run은 `REPORTED`일 때만 종료 코드0입니다. 다른 URL·모델·헤더·인증·도구·실행 export 옵션은 없습니다.

부모는 승인 본문 바이트만 최대1회 전송하며 인증 조회 직전과 네트워크 전송 직전에 승인 기간·generation·원본을 재검증합니다. 로그인 파일은 승인된 run의 부모만 읽고 refresh·복제·변경하지 않습니다. 자식은 빈 HOME과 단건 capability만 받습니다. retry/redirect/fallback은0이고 실패·중단 뒤 소비를 복원하지 않습니다.

응답은256KiB EOF까지 부모 메모리로 수신한 뒤 UTF8·SSE frame64KiB/2048개·일반 JSON 문법/중복 키/깊이16·인증값 반사를 검사합니다. 통과 전 자식 전달은0입니다. 원문·Unicode escape·순서 있는 JSON 문자열 조각과 최종 CLI JSON의 실제 token/account 반사를 검사하되, 임의 인코딩·암호화·변형 전반의 탐지는 보증하지 않습니다. upstream 헤더·쿠키·오류 본문은 자식에 중계하거나 저장하지 않습니다.

Codex가 응답 의미를 해석하고 하네스는 단일 완료 turn·최종 조사 JSON16KiB·전달 근거/줄·비밀/실행 필드를 검증합니다. 보고서의 `responseHash`는 원시 바이트, `finalTextHash`는 최종 text를 식별합니다. `contractVerified.cliOutput`과 `unverifiedResponseChecks`를 분리하며 private metadata·공급자 sequence/tool_usage·원시 전체 민감정보 검사·부모 text 비교를 통과했다고 표시하지 않습니다. `tools=[]`·OS 격리·CLI 도구 결과 거부는 유지하지만 공급자 도구 활동0을 보증하지 않습니다. operation55초와 공유 정리 대기5초를 적용하고 종료 불확실은 `BLOCKED`로 남깁니다. 하네스 DB·일반 로그에 원시/부분/거부 응답을 저장하지 않습니다. native 임시 영역은 종료 확인 후 제거하며 정리 불확실 시 잔류 내용의 제거를 보증하지 않습니다. 내용24h·terminal 감사30d·DB 수명 소비 marker를 유지합니다.

## 모의 입력과 오류 재현

`--fixture`는 이벤트 예제와 **고정 모델 시나리오**를 고릅니다. 실제 자연어 분류 모델이 메시지를 해석하는 기능은 아닙니다. `config/local.example.json`의 합성 ID인 `W_LOCAL`, `C_ALLOWED`, `U_OWNER`를 사용합니다.

| fixture                                                                    | 기대 결과                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `inquiry`, `change`, `unclear`                                             | 답변 초안, 승인 대기 계획, 확인 질문                              |
| `duplicate`                                                                | 같은 이벤트는 한 번만 처리                                        |
| `no-mention`, `other-user`, `disallowed-channel`, `other-workspace`        | 작업 생성 없음                                                    |
| `bot`, `self`, `edited`, `deleted`                                         | 작업 생성 없음. 편집·삭제 반영은 후속 단계                        |
| `invalid-json`, `invalid-summary`, `forbidden-command`, `timeout`          | `FAILED`와 정적 실패 코드                                         |
| `hallucinated-file`, `path-escape`, `symlink`, `secret`, `large`, `binary` | `BLOCKED`, 근거 및 실행 계획 없음                                 |
| `malicious`                                                                | 메시지와 README의 악성 지시를 자료로 읽고 실행 권한을 만들지 않음 |
| `redaction`                                                                | 합성 비밀 패턴을 모델 입력 전 마스킹                              |

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

전체 기준은 [구현 계획](docs/implementation-plan.md), [구조](docs/architecture.md), [보안과 승인](docs/security-and-approval.md)에 있고, 구현·검증 경계는 [단계 1](docs/stage-1-result.md), [단계 2](docs/stage-2-result.md), [단계 3-A](docs/stage-3a-result.md), [단계 3-B](docs/stage-3b-result.md), [단계 3-C](docs/stage-3c-result.md), [단계 3-D](docs/stage-3d-result.md), [단계 4-A](docs/stage-4a-result.md), [단계 4-B-1 결과](docs/stage-4b1-result.md), [단계 4-B-2 결과](docs/stage-4b2-result.md), [단계 4-C-1 결과](docs/stage-4c1-result.md), [단계 4-C-2 결과](docs/stage-4c2-result.md), [단계 4-C-3 결과](docs/stage-4c3-result.md)에 정리했습니다. 합성 실행·모의 전송·HTTP 계약 진단·합성 Git 작업, 별도 승인된 실제 Slack 단건 시험과 회사 도입 승인을 구분합니다.
