# work-assistant-harness

Slack에서 본인 멘션과 해당 스레드를 수집하고, 기존 Codex 연결로 분석한 결과를 로컬에서 확인하는 업무 하네스입니다. TypeScript·NestJS application context 기반이며 웹 UI 없이 터미널 CLI로 실행합니다.

멘션 자동 분석은 Slack 문맥으로 요약·사실·가설·답변 초안을 만듭니다. 회사 코드 조사·파일 적용은 별도 명령과 승인으로 분리되며, 자동 Slack 답장이나 Git push는 수행하지 않습니다.

2026-11-20 기준으로 Slack 분석용 Codex `0.167.2`의 합성 검증을 완료했습니다. 실제 Slack·계정 인증·모델 연결은 별도 확인이 필요합니다. 자세한 범위는 [검증 기록](docs/history/slack-mention-analysis-result.md)을 참고하세요.

## 설치

- 검증 환경: macOS ARM64, Node.js `>=26.12.1 <27` ([.node-version](.node-version)).
- 패키지 매니저: 현재 설치된 pnpm. 특정 pnpm 버전으로 자동 전환하지 않습니다.
- 의존성은 기존 `pnpm-lock.yaml`을 사용합니다.

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

`pnpm harness`는 TypeScript를 빌드한 뒤 CLI를 실행합니다. 전체 명령은 `pnpm harness --help`로 확인할 수 있습니다.

## 토큰 없이 먼저 확인하기

```sh
pnpm harness replay --fixture inquiry --data-dir /private/tmp/harness-demo-data
pnpm harness list --data-dir /private/tmp/harness-demo-data
pnpm harness inspect <task-id> --data-dir /private/tmp/harness-demo-data
```

합성 이벤트·고정 모델 응답·합성 저장소만 사용합니다. `task-id`는 앞 명령의 출력에서 확인합니다. 다른 fixture와 오류 재현은 [로컬 실행 가이드](docs/guides/local-runtime.md)에 있습니다.

## Slack 멘션 분석 시작하기

### 1. 설정 파일 준비

[.env.example](.env.example)과 [Codex relay-v3 예시](config/readonly-relay-execution-budget.example.json)를 참고해 **저장소 밖**에 env·JSON 파일을 준비합니다. 디렉터리는 `0700`, 설정 파일은 `0600` 권한을 사용합니다.

| env 키 | 넣을 값 |
| --- | --- |
| `SLACK_WORKSPACE_ID` | Slack workspace ID |
| `SLACK_TARGET_USER_ID` | 멘션을 감지할 본인 사용자 ID |
| `SLACK_CHANNEL_IDS` | 허용할 채널 ID, 여러 개는 쉼표로 구분 |
| `SLACK_LIST_ID` | 리스트 URL의 `/list/` 다음 ID. 최대 10개까지 `FEXAMPLE,FSECOND`처럼 한 줄에 지정합니다. 리스트만 감시할 때는 채널 ID와 앱 토큰을 생략할 수 있습니다. |
| `SLACK_APP_TOKEN` | Socket Mode용 app-level token |
| `SLACK_WEB_TOKEN` | 채널 스레드 조회용 Web API 토큰. 리스트 전용 토큰을 생략하면 이 토큰으로 리스트도 조회합니다. |
| `SLACK_LIST_USER_TOKEN` | 선택 사항. 본인이 볼 수 있는 리스트를 조회할 때 쓰는 `lists:read` 권한의 User OAuth Token. 리스트만 감시할 때는 이 토큰 하나로 충분합니다. |
| `SLACK_LIVE_READ_ENABLED` | 실제 수신을 켤 때 `true` |
| `SLACK_ANALYSIS_ENABLED` | Codex 분석을 켤 때 `true` |
| `SLACK_ANALYSIS_CODEX_CONFIG` | 하네스 전용 Codex relay JSON의 절대 경로 |

채널 이름 대신 ID를 사용합니다. `.env`는 자동으로 읽지 않으며, env 파일 안의 `~`·`$HOME`도 확장하지 않습니다. 토큰을 JSON이나 Git에 넣지 않습니다. Slack 앱 권한, JSON 필드, 지원 Codex 바이너리와 SHA-256은 [Slack 설정 가이드](docs/guides/slack.md)를 따릅니다.

### 2. 수신과 분석 실행

아래 자리표시자를 준비한 파일·데이터 경로로 바꿉니다.

```sh
pnpm harness slack-listen --env-file /absolute/private/slack.env --data-dir /absolute/private/slack-data
```

터미널에서 실행 상태를 유지하며 `Ctrl+C`로 종료합니다. `pnpm start`는 `package.json`의 `--env-file`에 지정된 `slack.env`만 읽습니다. 같은 파일에 `SLACK_LIST_ID`를 여러 줄 쓰면 마지막 값이 적용되므로 모든 ID를 한 줄에 넣고 재시작하세요.

시작 로그의 `listIds`에서 감시 대상을 확인하세요. 수신기는 지정한 순서로 리스트를 조회하며, 한 리스트에서 오류가 나도 다음 리스트로 진행합니다. 전체 순회를 마치고 5분 뒤 다시 조회합니다. 각 리스트의 첫 성공은 기준점으로 기록합니다. 이후 새 댓글에서 `SLACK_TARGET_USER_ID`를 직접 멘션하면 터미널에 `slack-list-poll`의 `mention` 이벤트를 출력하고, `slack-list` 결과의 `listMentions`에 마스킹한 댓글을 표시합니다. [권한과 오류 확인 방법](docs/guides/slack.md#리스트-댓글-멘션-감시)

### 3. 로컬 결과 확인

다른 터미널에서 같은 설정과 데이터 경로를 사용합니다.

```sh
pnpm harness slack-list --env-file /absolute/private/slack.env --data-dir /absolute/private/slack-data
pnpm harness slack-inspect <channel-id> <message-ts> --env-file /absolute/private/slack.env --data-dir /absolute/private/slack-data
```

`slack-list`는 요청별 분석 상태를, `slack-inspect`는 수집 문맥과 분석 결과를 보여 줍니다. 이번 세션에 받은 완전한 스레드만 분석하며 같은 revision은 한 번만 시도합니다. 동시 분석은 1건, runtime별 UTC 하루 최대 20시도이고 실패 후 자동 재시도는 없습니다. 과거 메시지나 연결이 끊긴 동안의 누락을 자동으로 채우지 않습니다.

본문 보관·중단 복구·수신 제한은 [Slack 가이드](docs/guides/slack.md), DB와 보고서 위치는 [로컬 데이터 가이드](docs/guides/local-runtime.md)를 참고하세요. 결과는 검토용 초안이며 의미적 정확성을 보장하지 않습니다.

## 개발 검증

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`test`는 컴파일 후 Node 내장 테스트를 실행합니다. 합성 검사의 통과와 실제 서비스·회사 보안 검증은 구분합니다. 일부 native 검사는 명시적 opt-in이 있어야 실행됩니다. macOS 전체 회귀의 임시 경로·권한 조건과 개별 검사 명령은 [개발 검증 안내](docs/guides/local-runtime.md#개발-검증)를 따릅니다.

컴파일된 CLI를 직접 실행할 때도 `node -- dist/src/cli/main.js ...`로 Node 옵션 경계를 유지합니다.

## 문서 찾기

| 목적 | 문서 |
| --- | --- |
| 전체 문서와 현재 지원 범위 | [문서 안내](docs/README.md) |
| Slack 앱·env·Codex 설정과 운영 | [Slack 가이드](docs/guides/slack.md) |
| 회사 저장소 조사·전송·파일 적용 | [회사 작업 가이드](docs/guides/company-workflows.md) |
| 모델 연결·개인 저장소 조사 | [모델 relay 가이드](docs/guides/model-relay.md) |
| 합성 승인·격리 실행·전송 검증 | [합성 작업 가이드](docs/guides/synthetic-workflows.md) |
| 구조·개발 기준 | [구조](docs/architecture.md) · [코딩 컨벤션](docs/coding-conventions.md) |
| 승인·자료·실행 경계 | [보안과 승인](docs/security-and-approval.md) |
| 설계와 상세 수용 기준 | [구현 계획](docs/implementation-plan.md) |
| 단계별 과거 결과·실패·검증 근거 | [개발 이력](docs/history/README.md) |
