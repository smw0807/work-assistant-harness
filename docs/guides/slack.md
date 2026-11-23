# Slack 수신과 멘션 분석

허용한 채널에서 본인 사용자 ID의 멘션과 해당 스레드를 수집하고, 명시적으로 켠 Codex 분석 결과를 로컬에서 확인하는 안내입니다. Slack 앱 설정·환경 파일·Codex JSON·실행과 조회·재시작 조건을 다룹니다.

수신과 분석의 구현 및 합성 검증은 완료했습니다. 실제 계정·채널의 연결 결과는 각 실행에서 확인해야 합니다. 분석은 회사 저장소 조사·수정이나 Slack 답장으로 이어지지 않습니다.

[문서 목록](../README.md) · [보안과 승인](../security-and-approval.md)

- [단계 2 Slack 읽기 수신](#단계-2-slack-읽기-수신)
- [Slack 본인 멘션 자동 분석](#slack-본인-멘션-자동-분석)
- [연결 문제 해결](#연결-문제-해결)

## 단계 2 Slack 읽기 수신

기본 수신 경로는 `Socket Mode → 허용 범위 검사 → SQLite commit → ACK → 제한된 스레드 조회 → 로컬 기록`입니다. 수신 프로세스는 모델을 호출하거나 대상 저장소를 읽지 않습니다. 수신 프로세스의 `checks.analysis`는 `not_run`이며, 자동 분석은 아래의 명시적 환경 설정으로 별도 연결합니다.

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

개인 테스트 또는 회사에서 승인받은 계정·자료·실행 환경에서 설정을 준비하고 `liveReadEnabled: true`를 명시한 경우에 사용할 명령입니다. 실제 계정·채널 연결의 성공 여부는 각 실행에서 별도로 확인합니다.

```sh
pnpm harness slack-listen --config /absolute/path/to/approved-slack.json --data-dir /absolute/path/to/private-slack-data
pnpm harness slack-list --config /absolute/path/to/approved-slack.json --data-dir /absolute/path/to/private-slack-data
```

수신부는 별도 Node 권한 프로세스에서 필요한 Slack 토큰만 받으며 대상 저장소를 읽는 권한이나 하위 프로세스 권한을 받지 않습니다. 조사 worker에는 토큰·네트워크 권한을 추가하지 않았습니다. 수신부의 Node `--allow-net`은 프로세스 전체 네트워크 허용이며 호스트별 OS 격리가 아닙니다. 어댑터가 고정 API와 정확한 WSS 호스트 목록을 검사하고 HTTP redirect를 거부합니다. 회사의 네트워크·데이터 정책 검증은 별도입니다.

실연결은 먼저 `auth.test`로 Web API 토큰의 workspace를 확인합니다. 스레드 조회 가능 여부는 선택한 token·scope·채널 멤버십으로 직접 검증해야 합니다. 조회 시간·응답 크기·페이지·메시지 수를 제한하고 `429 Retry-After`를 상한 안에서 처리합니다. 제한·조회 실패는 불완전 문맥으로 표시합니다. 재연결은 누락 없는 재생을 보장하지 않으며 최근 100개 연결·공백 상태를 보관합니다. 과거 메시지 자동 조회로 공백을 메우는 기능은 없습니다. [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [스레드 조회](https://docs.slack.dev/reference/methods/conversations.replies/), [토큰 workspace 확인](https://docs.slack.dev/reference/methods/auth.test/)

`tasks.sqlite`의 `slack_*` 테이블에 이벤트·요청·연결 이력을 저장합니다. 이벤트 ID는 중복 제거용이고 원본 메시지는 workspace·채널·message ts로 식별합니다. 편집·삭제·멘션 제거는 이전 문맥과 연계된 계획을 무효화합니다. 기존 조사 계획이 같은 메시지에 연결되어 있으면 DB에서 취소하고 로컬 보고서도 취소 상태로 다시 씁니다. DB가 원본이며, 보고서 쓰기 중 종료되면 다음 명령에서 복구합니다. 진행 중 중단된 수집은 `BLOCKED`로 보존하고 자동 재수집하지 않습니다.

본문과 스레드는 비밀 패턴, 지원 이메일·국내 휴대전화 패턴을 마스킹한 뒤 보관합니다. 보관 기간은 1~168시간이며 예시는 24시간입니다. 명령 시작·수신·처리 시점과 실수신 중 매분 만료 본문을 제거합니다. 중지된 앱의 DB는 다음 실행 전까지 남습니다. 최소 event ID·메시지 revision·삭제 marker는 오래된 이벤트의 부활을 막기 위해 DB 수명 동안 남고 저장량이 늘어날 수 있습니다. 삭제는 백업·로그·파일시스템의 물리적 완전 삭제를 보장하지 않습니다. 모든 개인정보·비밀 형식을 판별하는 기능도 아닙니다.

## Slack 본인 멘션 자동 분석

`slack-listen --env-file <private-env>`로 본인 멘션과 해당 스레드만 기존 Codex relay에 연결할 수 있습니다. 새 설정 예시는 [.env.example](../../.env.example)입니다. 파일은 저장소 밖의 소유자 전용 0600 파일로 준비합니다. 채널 이름 대신 **채널 ID**를 쉼표로 구분하고 Slack의 workspace ID·본인 사용자 ID도 지정합니다. `.env`를 자동 탐색하지 않으며 `--env`는 현재 프로세스 환경만, `--env-file`은 지정한 파일만 사용합니다. 둘과 기존 `--config`는 함께 사용할 수 없습니다.

```dotenv
SLACK_WORKSPACE_ID=T_EXAMPLE
SLACK_TARGET_USER_ID=U_EXAMPLE
SLACK_CHANNEL_IDS=C_EXAMPLE,C_SECOND_EXAMPLE
SLACK_LIVE_READ_ENABLED=true
SLACK_APP_TOKEN=<Socket Mode app token>
SLACK_WEB_TOKEN=<thread read token>
SLACK_ANALYSIS_ENABLED=true
SLACK_ANALYSIS_CODEX_CONFIG=/absolute/private/path/codex-relay.json
```

위 값들은 자리표시자입니다. `SLACK_ANALYSIS_CODEX_CONFIG`에는 실제로 생성한 하네스 전용 Codex 연결 JSON 파일의 절대 경로를 넣습니다. env 파일 안의 `~`나 `$HOME`은 확장하지 않으므로 `/Users/.../codex-relay.json`처럼 전체 경로를 사용합니다. JSON도 저장소 밖의 소유자 전용 `0600` 파일로 보관하며, 설정 디렉터리는 `0700`으로 준비합니다.

[v3 예시](../../config/readonly-relay-execution-budget.example.json)를 복사한 뒤 `enabled`를 `true`로, `codexPath`와 `codexSha256`을 확인한 실행 파일의 실제 경로와 SHA-256으로 설정합니다. `codexPath`는 심볼릭 링크가 없는 절대 경로여야 합니다. 기존 모델 `gpt-6.1-sol`, 인증 방식 `chatgpt`, 총 시간 `125000`ms, 최종 응답 `16384`바이트를 유지합니다. JSON에 Slack 토큰이나 ChatGPT 인증값을 넣지 않습니다. 기존 ChatGPT 인증은 relay controller가 호출 시에만 사용하고 native 자식에는 실제 토큰을 전달하지 않습니다.

Slack 분석의 relay-v3는 macOS ARM64 Codex `0.167.2` 중 아래 SHA-256과 일치하는 바이너리를 지원합니다. 2026-11-20 추가 점검에서 private JSON 생성·env 경로 반영과 해당 native의 합성 호환성 검증을 마쳤습니다. 실제 Slack·인증·모델 연결은 아직 실행하지 않았습니다. 검증 범위와 결과는 [추가 점검 기록](../history/slack-mention-analysis-result.md#2026-11-20-추가-점검-현재-codex-연결-설정과-호환성)을 따릅니다.

기존 `0.154.0`과 v1/v2 설정의 기존 한도는 유지합니다. 회사·개인 조사와 코드 제안 경로의 지원 버전을 자동으로 넓히지 않으며, 이후 Codex 업데이트도 자동 허용하지 않습니다.

```text
97bc82fd46f117cf10efb95e6ff0c81dc4784f5797bcdc2cb75093ba09e4def0
```

설정 파일 생성과 합성 검증은 실제 Slack 연결, 계정 인증 또는 모델 응답의 성공을 뜻하지 않습니다. 현재 버전의 격리에는 사용자가 승인한 `com.openai.codex` preference 읽기, cfprefsd의 세 Mach 조회 항목, 현재 사용자와 daemon의 정확한 CFPreferences 공유 영역 두 개에 대한 읽기만 추가했습니다. GlobalPreferences 읽기도 승인받았지만 동기화에 필요하지 않아 추가하지 않았습니다. 다른 preference 도메인·다른 사용자 공유 영역과 모든 preference·공유 영역 쓰기는 계속 거부합니다. native 호환성은 가짜 인증·합성 응답으로 검증했으며, 실제 서비스 연결은 별도의 실행 결과로 구분합니다.

아래 `pnpm harness`는 Node 옵션 경계를 `node --`로 고정합니다. 컴파일된 CLI를 직접 실행할 때도 `node -- dist/src/cli/main.js ...`를 사용합니다. `--` 없이 실행하면 Node 자체가 `--env-file`을 하네스보다 먼저 처리할 수 있습니다.

```sh
pnpm harness slack-listen --env-file /absolute/private/path/slack.env --data-dir /absolute/private/path/slack-data
# 다른 터미널에서 상태와 한 요청의 분석 결과를 조회합니다.
pnpm harness slack-list --env-file /absolute/private/path/slack.env --data-dir /absolute/private/path/slack-data
pnpm harness slack-inspect <channel-id> <message-ts> --env-file /absolute/private/path/slack.env --data-dir /absolute/private/path/slack-data
```

`package.json`의 `start`는 특정 사용자의 env·data 절대 경로를 담은 로컬 편의 스크립트입니다. 다른 환경에서는 위처럼 자신의 파일과 저장 위치를 명시한 `pnpm harness slack-listen` 명령을 사용합니다.

분석 설정과 native 바이너리의 정적 준비 검사를 마친 후 수신을 시작합니다. foreground로 동작하므로 터미널의 `Ctrl+C`로 종료할 수 있습니다. Slack 앱의 Socket Mode·읽기 scope·대상 채널 접근은 준비되어 있어야 합니다. 공개 채널 메시지는 `message.channels`를 구독하고 본인 `<@사용자ID>`를 필터링합니다. 앱 멘션인 `app_mention`과 구분합니다. [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [채널 메시지 이벤트](https://docs.slack.dev/reference/events/message.channels/), [스레드 읽기 권한](https://docs.slack.dev/reference/methods/conversations.replies/)

자동 분석은 이번 실행이 시작된 뒤 수신하고 완전하게 수집한 멘션/스레드만 처리합니다. 부분 스레드, 재연결 이전 문맥, 과거 수신 기록은 자동 전송하지 않습니다. 중복 요청·같은 revision은 한 번만 시도하고 실패/중단 뒤 자동 재시도하지 않습니다. 자동 분석 전용 추가 한도는 동시 1건·runtime별 UTC 하루 20시도이며 불완전/잘못된 입력의 차단도 시도에 포함합니다. 일일 한도에 아직 진입하지 못한 현재 세션 요청은 다음 UTC 날짜에 다시 선택될 수 있습니다. 기존 스레드 상한과 모델별 입력·응답·시간·정리 한도는 유지합니다.

수신 worker에는 Slack 토큰만, 분석 controller에는 최소 환경만 전달합니다. 기존 native sandbox·고정 목적지 broker·빈 tools·단건 호출 계약을 재사용하며 회사 코드·다른 파일·제품 명령·Slack 답장은 분석에 포함되지 않습니다. 요청자의 메시지는 분석 자료이며 실행 권한이 아닙니다. 설정의 `SLACK_ANALYSIS_ENABLED=true`와 명시적인 listen 실행은 이 한정된 자동 분석을 켜는 조작이며 기존 회사 수정 승인이나 단건 조사 승인을 재사용하지 않습니다.

표준 출력의 `slack-analysis` 이벤트에서 진행 상태를 확인하고, `slack-inspect`의 `analysis.results`에서 한국어 요약·근거·불확실성·답변 초안·추가 질문을 검토합니다. `slack-list`는 보고서 본문 없이 상태만 표시합니다. 결과는 private `slack-analysis.sqlite`에 보관하며 원래 Slack 본문을 분석 DB에 추가 복제하지 않습니다. 보고서 본문은 원본 보관 기한과 분석 시작 후 24시간 중 먼저 도래하는 때 제거하고, 중복 방지 metadata는 유지합니다. 실행 중 편집·삭제·멘션 제거·연결 공백은 진행 중 호출의 취소를 요청하고 오래된 결과의 게시를 막습니다. 이미 외부 전송한 내용을 되돌리지는 못합니다. 수신하지 못한 변경이나 의미적 정답까지 검증했다는 뜻은 아닙니다.

조회 명령은 모델 설정 파일이나 Codex 인증을 열지 않고 현재 수신 기록과 기존 결과를 대조합니다. 재시작 시 중단된 분석은 `INTERRUPTED`로 남고 재전송하지 않습니다. native 정리 여부가 불확실하면 다음 분석을 시작하지 않고 수신과 분석을 종료합니다. 호출 중 hard kill로 남은 `slack-analysis-active.json`도 다음 시작을 차단합니다. 남은 프로세스와 실행 기록의 로컬 확인 없이 이 marker를 자동 삭제하지 않습니다. 합성 검증과 실제 연결 여부는 [Slack 자동 분석 결과](../history/slack-mention-analysis-result.md)에 구분해 기록합니다.

## 연결 문제 해결

| 로그 | 의미 |
| --- | --- |
| `slack-analysis`의 `ready` | 분석 설정·native 바이너리의 정적 준비 완료. Slack 연결이나 모델 호출 성공은 아님 |
| 수신부의 `starting` | Web API 토큰의 `auth.test`와 workspace 확인을 통과한 뒤 Socket 연결을 시작하는 단계 |
| `checks.analysis: not_run` | 수신 worker 자체의 범위 표시. 별도 분석 controller가 비활성이라는 뜻은 아님 |
| `--allow-net`의 `ExperimentalWarning` | Node 권한 기능 안내이며 이 경고 자체가 연결 실패나 프로세스 종료의 원인은 아님 |

`SLACK_API_REJECTED` 등의 이유로 `gap`이 반복되고 `SLACK_RECONNECT_LIMIT` 뒤 `SLACK_ANALYSIS_PAIR_FAILED`로 끝났다면, 앞선 API 거부로 재연결 한도를 소진하여 수신·분석 묶음이 종료된 흐름입니다. 마지막 오류만으로 Codex 실패라고 판단하지 않습니다. 재연결 횟수와 분석 재시도·시간 한도는 그대로 유지합니다.

확인된 공식 오류만 고정 코드로 구분합니다. `SLACK_SOCKET_API_*`는 `apps.connections.open` 단계이며 인증 확인·스레드 조회는 각각 별도 접두사를 사용합니다. 미확인 응답값은 그대로 출력하지 않고 기존 `SLACK_API_REJECTED`로 남깁니다.

| Socket 오류 코드 | 확인할 조건 |
| --- | --- |
| `SLACK_SOCKET_API_INVALID_AUTH` | 앱 토큰의 유효성 |
| `SLACK_SOCKET_API_MISSING_SCOPE` | 해당 앱 토큰의 `connections:write` |
| `SLACK_SOCKET_API_NOT_ALLOWED_TOKEN_TYPE` | app-level `xapp-` 토큰을 사용했는지 |
| `SLACK_SOCKET_API_TOKEN_EXPIRED` / `SLACK_SOCKET_API_TOKEN_REVOKED` | 토큰 만료·철회 여부 |
| `SLACK_SOCKET_API_NOT_AUTHED` / `SLACK_SOCKET_API_MISSING_ARGS` | 필요한 토큰이 전달됐는지 |
| `SLACK_SOCKET_API_ACCOUNT_INACTIVE` / `SLACK_SOCKET_API_ACCESS_DENIED` | 계정·workspace 상태와 접근 제한 |
| `SLACK_SOCKET_API_ACCESSLIMITED` / `SLACK_SOCKET_API_FORBIDDEN_TEAM` | 네트워크·팀의 API 이용 제한 |

Slack 앱의 **Basic Information → App-Level Tokens**에서 `connections:write`가 있는 `xapp-` 토큰을, **Socket Mode → Enable Socket Mode**에서 활성화를 확인합니다. `SLACK_APP_TOKEN`과 스레드 조회용 `SLACK_WEB_TOKEN`은 역할이 다릅니다. [앱 토큰 설정](https://docs.slack.dev/tools/python-slack-sdk/socket-mode/index.html), [연결 권한](https://docs.slack.dev/reference/scopes/connections.write/), [공식 오류 목록](https://docs.slack.dev/reference/methods/apps.connections.open/)

`starting`은 Web API 인증 확인 결과이지 앱 토큰이나 스레드 읽기 권한까지 검증한 결과가 아닙니다. Socket Mode 비활성화를 특정 API 오류 코드 하나로 단정하지 않습니다. [인증 확인](https://docs.slack.dev/reference/methods/auth.test/), [Socket Mode 동작](https://docs.slack.dev/apis/events-api/using-socket-mode/)

설정을 바꿨다면 실행에 지정한 private env 파일에 반영한 뒤 다시 시작합니다. 토큰값·env 본문·인증 응답 원문을 터미널이나 공유 로그에 출력하지 않습니다. 원인을 확인하기 위해 읽기·쓰기 권한을 일괄 추가하지 않습니다.
