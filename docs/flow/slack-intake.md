# Slack에서 나를 멘션하면

허용한 채널에서 다른 사용자가 `<@내사용자ID>`를 포함한 메시지를 쓰면, 하네스는 멘션을 저장하고 **수신 확인(ACK)을 보낸 뒤** 그 메시지가 속한 스레드를 읽는다. 수신 결과는 로컬 `tasks.sqlite`에서 조회할 수 있다. 채널에서 수신한 멘션은 분석 설정을 켰을 때 [스레드 답변 초안](thread-reply.md)의 입력이 된다.

## 채널 메시지 한 건이 지나가는 파일

| 순서 | 어떤 일이 일어나는가 | 담당 파일과 시작점 |
| --- | --- | --- |
| 1. 시작 | `pnpm harness slack-listen`을 Slack CLI로 보낸다. CLI가 채널·사용자·읽기 설정을 확인하고 수신 worker를 띄운다. 분석까지 켜면 분석 프로세스의 준비 신호를 기다린 뒤 수신을 시작한다. | [main.ts](../../src/cli/main.ts) → [slack.ts의 runSlackCommand](../../src/cli/slack.ts), [환경 설정](../../src/cli/slack-environment.ts), [분석 프로세스 감독](../../src/cli/slack-analysis-supervisor.ts) |
| 2. 연결 | worker가 NestJS에 수신 서비스와 SQLite 수신함을 연결한다. 채널 수신에서는 Web 토큰의 `auth.test` 결과로 workspace를 확인하고, 앱 토큰으로 `apps.connections.open`을 호출해 WebSocket을 연다. | [slack-worker.ts](../../src/cli/slack-worker.ts) → [SlackReadClient](../../src/adapters/slack-read-client.ts) → [SlackSocketTransport.run](../../src/adapters/slack-socket-transport.ts) |
| 3. 멘션 판별 | `parseSocketEnvelope`와 `normalizeSlackChange`가 이벤트를 해석한다. 새 요청은 허용 workspace·채널의 일반 `message`이며 본문에 정확한 대상 사용자 멘션이 있어야 한다. 봇과 본인이 쓴 메시지는 제외한다. 예제 앱은 공개 채널의 `message.channels`를 구독한다. | [수신 정책](../../src/policy/slack-ingestion.ts), [앱 manifest 예제](../../config/slack-app-manifest.example.json) |
| 4. 저장과 ACK | `SlackReceptionService.receive`가 `SqliteSlackInbox.receive`를 호출한다. 수신함은 본문 대조용 해시, 메시지 시각과 revision을 저장하고 workspace와 `event_id`로 재전달을 걸러낸다. 커밋 후 transport가 이번 전달의 `envelope_id`로 ACK한다. 필터에서 제외한 이벤트는 작업을 만들지 않고 ACK한다. 새 멘션을 보관할 큐가 가득 차면 ACK 전에 실패한다. | [receive-slack.ts](../../src/application/receive-slack.ts), [sqlite-slack-inbox.ts](../../src/adapters/sqlite-slack-inbox.ts), [본문 마스킹](../../src/policy/redaction.ts) |
| 5. 스레드 수집 | worker가 `drain()`을 예약한다. 대기 이벤트를 하나씩 선점하고 `readThread(channelId, threadTs, …)`로 `conversations.replies`를 조회한다. 루트 멘션은 자기 시각, 답글 속 멘션은 부모 스레드 시각이 조회 기준이다. 기본 한도인 루트 포함 200건, 20페이지, 65,536바이트 안에서 수집 상태·메시지 수·해시를 기록한다. 마스킹한 본문은 메모리에서 분석기로 전달한다. | [SlackReceptionService.drain](../../src/application/receive-slack.ts) → [SlackReadClient.readThread](../../src/adapters/slack-read-client.ts) → [수신함의 complete / block](../../src/adapters/sqlite-slack-inbox.ts) |

수집을 마치면 요청 상태는 `RECORDED`가 된다. 스레드 전체를 확보했는지는 `thread.complete`와 `thread.reason`으로 확인한다. 조회 중 예외는 `BLOCKED`와 실패 코드로 남는다. 편집·삭제가 도착하면 수신함이 revision을 대조한다. 멘션이 사라지거나 원문이 삭제되면 기존 수집 기록과 그 기록에 연결된 분석 결과를 무효화하고, 뒤늦은 옛 조회 결과가 덮어쓰는 것을 막는다. [수집 상태 처리](../../src/adapters/sqlite-slack-inbox.ts) · [중복·편집·ACK 테스트](../../tests/slack-reception.test.ts)

## 합성 이벤트로 확인하기

아래 명령은 기본 Slack 수신 설정과 예제 envelope를 사용한다. 같은 데이터 디렉터리에서 먼저 수신 결과를 만들고, 목록에서 얻은 **멘션 메시지의 시각**으로 조회한다. [수신 설정 예제](../../config/slack.example.json) · [합성 이벤트](../../fixtures/slack/receive.json)

```sh
pnpm harness slack-replay --data-dir /private/tmp/harness-slack-demo
pnpm harness slack-list --data-dir /private/tmp/harness-slack-demo
pnpm harness slack-inspect C_ALLOWED 1700000000.000001 --data-dir /private/tmp/harness-slack-demo
```

`slack-replay`는 `MockSlackSource`가 읽은 이벤트를 같은 `receive()`에 넣는다. 기본 예제는 최초 멘션, 재전달, 편집, 비허용 채널을 포함한다. 모의 스레드 reader가 반환하는 `OFFLINE_NO_THREAD_SOURCE`는 이 예제에서 예상되는 결과다. 실제 수신에서 쓰는 환경 파일과 권한 설정은 [Slack 실행 가이드](../guides/slack.md)에서 확인할 수 있다. [모의 입력 어댑터](../../src/adapters/mock-slack-source.ts) · [worker의 입력 선택](../../src/cli/slack-worker.ts)

리스트 항목에 달린 댓글은 별도의 [리스트 댓글 멘션 감지](slack-list-mentions.md)에서 처리한다.
