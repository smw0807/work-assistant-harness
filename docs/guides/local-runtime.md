# 로컬 저장과 모의 실행

합성 이벤트로 기본 흐름을 확인하고 작업 상태·보고서를 조회하는 안내입니다. 로컬 데이터 디렉터리, 재시작 상태와 오류 재현 fixture를 다룹니다.

이 문서의 `replay`는 고정 응답 모델과 임시 합성 저장소를 사용합니다. 실제 Slack 멘션 분석은 [Slack 안내](slack.md)를 따릅니다.

[문서 목록](../README.md) · [보안과 승인](../security-and-approval.md)

- [로컬 저장 위치와 재시작](#로컬-저장-위치와-재시작)
- [모의 입력과 오류 재현](#모의-입력과-오류-재현)
- [읽기 경계](#읽기-경계)
- [개발 검증](#개발-검증)

## 로컬 저장 위치와 재시작

기본 데이터 위치는 macOS에서 `~/Library/Application Support/work-assistant-harness`, Linux에서 `~/.local/share/work-assistant-harness`입니다. 다른 위치는 모든 명령에서 같은 `--data-dir`로 지정합니다.

```sh
pnpm harness replay --fixture change --data-dir /private/tmp/harness-demo-data
pnpm harness list --data-dir /private/tmp/harness-demo-data
pnpm harness inspect <task-id> --data-dir /private/tmp/harness-demo-data
```

데이터 폴더는 소스와 겹치지 않는 비공개 디렉터리여야 합니다. 새 폴더는 `0700`, SQLite와 보고서는 `0600`으로 만듭니다. 기존 폴더가 다른 사용자에게 열려 있으면 거부하며 임의로 권한을 바꾸지 않습니다. DB·저널의 symlink와 hardlink도 거부합니다.

- `tasks.sqlite`: 작업, 이벤트 중복 제약, 상태 이력, 근거와 계획, 별도 승인 테이블의 불변 계획 스냅샷과 승인·취소 이력. 모의 조사 작업은 원문 메시지와 모델 원문을 저장하지 않습니다. Slack 수집 자료의 별도 보관 범위는 [Slack 안내](slack.md#단계-2-slack-읽기-수신)를 따릅니다.
- `slack-analysis.sqlite`: Slack 분석 상태·중복 방지 metadata와 검증한 보고서 본문. 원래 Slack 본문을 추가 복제하지 않으며 보고서는 원본 TTL과 분석 시작 후 24시간 중 짧은 기간만 보관합니다. 결과는 `slack-inspect`로 조회합니다.
- `slack-analysis-active.json`: 진행 중 native 호출의 표시입니다. 중단 뒤 이 파일이 남으면 다음 시작을 차단하며, 프로세스·실행 기록 확인 없이 삭제하지 않습니다.
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
pnpm harness replay --fixture unclear
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

## 개발 검증

macOS ARM64와 Node.js `>=26.12.1 <27`, 현재 설치된 pnpm을 사용합니다. pnpm 버전을 자동 전환하거나 새로 설치하지 않습니다. 의존성 설치는 루트 [README](../../README.md)를 따릅니다.

```sh
pnpm lint
pnpm typecheck
(
  umask 022
  TMPDIR=/private/tmp env -u HARNESS_NATIVE_CODEX_PROBE -u HARNESS_NATIVE_CODEX_PATH \
    -u HARNESS_SLACK_NATIVE_PROBE pnpm test
)
pnpm build
```

`test`는 컴파일 후 Node 내장 test runner로 단위·통합·CLI 수용 검사를 실행합니다. 합성 저장소는 별도 임시 경로에 준비합니다. macOS의 전체 합성 회귀는 `TMPDIR=/private/tmp`와 `umask022`를 기준으로 검증했습니다. 일부 테스트는 의도적으로 다른 사용자에게 열린 파일을 만들어 거부 여부를 확인하므로 `umask077`로 실행하면 fixture 자체가 달라집니다. 위 subshell의 권한 설정은 테스트 fixture용이며 실제 설정·결과 로그의 보관 권한이 아닙니다. 보관할 로그는 별도의 소유자 전용 디렉터리 `0700`과 파일 `0600`을 사용합니다.

필요한 범위만 검증할 때는 기존 부분 스크립트를 선택할 수 있습니다.

| 명령 | 범위 |
| --- | --- |
| `pnpm test:migration` | 이전 점검의 정책·파일 adapter·CLI 합성 검사. 실제 native Codex·sandbox 실행과 바이너리 정적 준비 점검은 별도 |
| `pnpm test:company` | `company-readonly-*` 합성 검사. 실제 회사 저장소 조사·실행은 포함하지 않음 |

native opt-in은 필요한 실행 범위가 허용된 환경에서 명시적으로 선택합니다. 예를 들어 `HARNESS_SLACK_NATIVE_PROBE=1`은 현재 Slack native 호환 검사를 포함합니다. 가짜 인증·응답을 사용하는 이 검사는 실제 계정 인증이나 모델 호출의 성공을 뜻하지 않습니다. 기존 `HARNESS_NATIVE_CODEX_PROBE=1`은 다른 합성 native 검사군이며 요구하는 바이너리 버전·hash가 다를 수 있습니다. 결과에는 `passed`, `failed`, `not_run` 또는 건너뛴 검사를 구분해 남깁니다. 테스트 선택이 회사 자료·인증·외부 전송 권한을 추가하지는 않습니다.

`pnpm harness`의 진입점은 `node -- dist/src/cli/main.js`로 Node 옵션 해석을 끝냅니다. 컴파일된 CLI를 직접 실행해도 이 `--` 경계를 유지해야 파일의 `--env-file`을 하네스가 처리합니다. 전체·집중·native 검증의 실행 이력은 [검증 기록](../history/README.md)에서 확인합니다.
