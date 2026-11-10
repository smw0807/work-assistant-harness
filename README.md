# work-assistant-harness

Slack 요청을 로컬에 기록하고, 합성 자료로 읽기 전용 조사를 검증하는 업무 하네스입니다. **단계 0·1의 모의 조사와 단계 2의 Slack 읽기 수신 기능**을 구현했습니다. 실제 Slack 권한과 회사 환경 검증은 아직 수행하지 않았습니다.

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

기본 실행은 합성 자료만 사용합니다. Slack 수신은 명시적으로 켜는 별도 경로이며 모델·제품 저장소와 연결하지 않습니다. 승인 후 수정, 대상 스크립트 실행, 외부 메시지, Git 원격 작업은 구현하지 않았습니다. `ApprovalPort`와 `ExecutionPort`의 기본 구현은 항상 거부합니다.

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

- `tasks.sqlite`: 작업, 이벤트 중복 제약, 상태 이력, 근거와 계획. 원문 메시지와 모델 원문은 저장하지 않습니다.
- `harness-lock.sqlite`: 동시 CLI 실행 방지용 SQLite 잠금. 프로세스 종료 시 OS가 잠금을 해제합니다.
- `reports/`: 작업별 JSON 보고서. DB에 저장된 자료로 누락된 보고서를 재생성합니다.
- `runs/`: 명령별 결과와 대상 전후 해시를 기록한 JSON 실행 기록.

같은 이벤트는 재시작 후에도 다시 분석하지 않습니다. 중간에 종료된 `RECEIVED`, `TRIAGED`, `ANALYZED` 작업은 `BLOCKED`와 `INTERRUPTED_REVIEW_REQUIRED`로 남기고 자동 재실행하지 않습니다. 승인 대기 상태도 그대로 유지합니다. 자동 보관 기간·삭제·재처리 기능은 아직 없습니다.

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

Node 권한 모델은 신뢰하는 하네스 코드의 실수를 제한하는 장치입니다. 악성 코드를 실행하는 보안 sandbox가 아니며, 같은 OS 사용자의 동시 파일 변조까지 방어한다고 주장하지 않습니다. 현재는 저장소 파일을 실행·import하지 않습니다. 별도 worktree와 실행 환경은 단계 3에서 검증해야 합니다.

합성 저장소 경로는 실행 기록의 `repository.root`에 남깁니다. CLI는 검토를 위해 이 임시 자료를 자동 삭제하지 않습니다. 테스트는 자신이 만든 임시 자료만 종료 후 정리합니다. 보고서의 `passed`, `failed`, `not_run`은 구분되며 대상 설치·테스트·외부 전송·승인 후 실행은 `not_run`입니다.

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

전체 기준은 [구현 계획](docs/implementation-plan.md), [구조](docs/architecture.md), [보안과 승인](docs/security-and-approval.md)에 있고, 구현·검증 경계는 [단계 1 결과](docs/stage-1-result.md)와 [단계 2 결과](docs/stage-2-result.md)에 정리했습니다.
