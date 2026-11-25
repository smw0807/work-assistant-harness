채널 멘션 수신과 분석에는 아래 설정을 사용합니다. 리스트 댓글 멘션도 감지하려면 리스트 URL의 `/list/` 다음에 있는 `F…` ID를 복사하세요. `pnpm start`는 아래 경로의 `slack.env`를 읽으므로 이 파일에 `SLACK_LIST_ID=FEXAMPLE,FSECOND`처럼 모든 ID를 한 줄에 지정하세요. 같은 키를 여러 줄에 쓰면 마지막 값이 적용됩니다. 재시작한 뒤 시작 로그의 `listIds`에서 감시 대상을 확인할 수 있습니다. 토큰은 비공개 설정 파일에 보관하세요. 본인이 볼 수 있는 리스트를 감시하려면 본인 계정으로 승인한 토큰을 같은 파일의 `SLACK_LIST_USER_TOKEN`에 넣으세요. 내보내기에는 `lists:read`가 필요합니다. 내보내기에 빠진 답글까지 감지하려면 같은 토큰으로 해당 대화의 `conversations.replies`를 호출할 수 있어야 합니다. [리스트 권한과 실행 방법](docs/guides/slack.md#리스트-댓글-멘션-감시)

채널과 리스트의 스레드 분석 기본 상한은 루트 포함 200건, 20페이지, 65,536바이트입니다. Slack 본문은 수신 중 메모리에서 처리합니다. 수신 ID와 분석 결과는 로컬에서 조회할 수 있습니다.

먼저 [Slack 앱 관리 화면](https://api.slack.com/apps)에서 등록한 앱을 열고 설정해 주세요.

1. **Socket Mode → Enable Socket Mode**를 켭니다.
2. **Basic Information → App-Level Tokens**에서 `connections:write` 권한으로 토큰을 발급합니다. 이 값이 `SLACK_APP_TOKEN`입니다. [Socket Mode 안내](https://docs.slack.dev/apis/events-api/using-socket-mode/), [필요 권한](https://docs.slack.dev/reference/scopes/connections.write/)
3. **OAuth & Permissions → Bot Token Scopes**에 `channels:history`를 추가하고 워크스페이스에 설치하거나 재설치합니다. 발급된 **Bot User OAuth Token**이 `SLACK_WEB_TOKEN`입니다. [토큰 안내](https://docs.slack.dev/authentication/tokens/), [스레드 읽기 권한](https://docs.slack.dev/reference/methods/conversations.replies/)
4. **Event Subscriptions → Enable Events → Subscribe to bot events**에 `message.channels`를 추가합니다. 본인에게 온 멘션 감지에 필요한 이벤트입니다. [이벤트 안내](https://docs.slack.dev/reference/events/message.channels/)
5. 감지할 공개 채널에 해당 앱을 추가합니다.

설정 파일에는 다음처럼 채웁니다. 아래 값은 모두 예시입니다.

```dotenv
SLACK_WORKSPACE_ID=T실제워크스페이스ID
SLACK_TARGET_USER_ID=U본인멤버ID
SLACK_CHANNEL_IDS=C대상채널ID

SLACK_LIVE_READ_ENABLED=true
SLACK_APP_TOKEN=xapp-발급받은앱토큰
SLACK_WEB_TOKEN=xoxb-발급받은봇토큰

SLACK_ANALYSIS_ENABLED=true
# 리스트 멘션의 전체 스레드까지 분석할 때 사용합니다.
SLACK_LIST_ANALYSIS_ENABLED=true
SLACK_ANALYSIS_CODEX_CONFIG=/기존/설정파일/절대경로/codex-relay.json
```

| 항목                          | 넣을 값과 확인 방법                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_WORKSPACE_ID`          | 브라우저에서 Slack을 열면 주소가 `app.slack.com/client/T…/C…` 형태입니다. 여기서 `T…` 부분입니다. [공식 안내](https://slack.com/help/articles/221769328-Locate-your-Slack-URL-or-ID)          |
| `SLACK_TARGET_USER_ID`        | **본인 프로필 → ⋯ → 멤버 ID 복사**로 얻는 값입니다. [공식 안내](https://slack.com/help/articles/360003827751-Create-a-link-to-a-members-profile)                                              |
| `SLACK_CHANNEL_IDS`           | 해당 채널을 연 브라우저 주소의 `C…` 부분입니다. 여러 개면 `C첫번째,C두번째`처럼 쉼표로 구분합니다. [공식 안내](https://docs.slack.dev/messaging/formatting-message-text/#linking-to-channels) |
| `SLACK_LIVE_READ_ENABLED`     | 실제 멘션 수신을 켜려면 `true`                                                                                                                                                                |
| `SLACK_APP_TOKEN`             | 위에서 발급한 `xapp-…` 토큰                                                                                                                                                                   |
| `SLACK_WEB_TOKEN`             | 위에서 발급한 `xoxb-…` 토큰                                                                                                                                                                   |
| `SLACK_ANALYSIS_ENABLED`      | 수신한 멘션과 스레드의 AI 분석을 켜려면 `true`                                                                                                                                                |
| `SLACK_ANALYSIS_CODEX_CONFIG` | **하네스의 기존 Codex 연결 설정 JSON 파일 경로**                                                                                                                                              |

마지막 JSON은 **Codex 실행 파일 위치·검증값·모델·실행 한도를 기록한 하네스용 설정 파일**입니다. 기존에 준비한 파일의 절대 경로를 넣어야 합니다. 아직 위치를 모르면 우선 `SLACK_ANALYSIS_ENABLED=false`로 두고 마지막 줄을 생략하면 Slack 수신까지만 사용할 수 있습니다. 회사 레포 경로나 `SLACK_SEND_TOKEN`은 이번 기능에 필요하지 않습니다.

파일은 예를 들어 저장소 밖의 아래 위치에 보관하세요.

```sh
mkdir -p /Users/songmin-u/.config/work-assistant-harness
chmod 700 /Users/songmin-u/.config/work-assistant-harness
```

그 안에 `slack.env`를 저장한 뒤 권한을 설정합니다.

```sh
chmod 600 /Users/songmin-u/.config/work-assistant-harness/slack.env
```

하네스 폴더에서 실행하는 명령은 다음과 같습니다. **`.env`를 자동으로 읽지 않으므로 `--env-file`이 필요합니다.**

```sh
pnpm harness slack-listen \
  --env-file /Users/songmin-u/.config/work-assistant-harness/slack.env \
  --data-dir /Users/songmin-u/.config/work-assistant-harness/slack-data
```

실행 후 **다른 사람이 지정한 채널에서 본인을 멘션**하면 감지합니다. 현재 코드는 본인이 본인을 멘션한 메시지는 제외합니다.

참고로 README의 v3 설정 예시 링크에 오류가 있습니다. 올바른 파일은 [readonly-relay-execution-budget.example.json](/Users/songmin-u/dev/work-assistant-harness/config/readonly-relay-execution-budget.example.json)이며, 기존 연결 설정이 있다면 그 설정을 그대로 사용하면 됩니다.
