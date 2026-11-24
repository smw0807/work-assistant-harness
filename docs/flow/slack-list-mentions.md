# Slack 리스트 댓글의 멘션을 발견하는 흐름

`SLACK_LIST_ID`에 리스트를 등록하고 `slack-listen`을 시작하면, 하네스가 주기적으로 리스트를 조회해 새 댓글에서 본인 멘션을 찾는다. **리스트마다 첫 성공 조회가 기준점**이다. 예전에 달린 댓글은 이때 확인한 것으로 표시하고, 이후 처음 발견한 댓글부터 알린다. 채널과 리스트를 함께 등록하면 [채널 수신](slack-intake.md)도 같은 worker에서 동작한다.

1. **감시할 리스트 선택.** `parseSlackEnvironment`가 쉼표로 구분한 리스트 ID를 읽는다. 수신 worker는 리스트 전용 사용자 토큰이 있으면 그 토큰을, 없으면 Web API 토큰을 읽기 클라이언트에 연결한다. 사용자 토큰을 쓰는 경우 workspace와 대상 사용자 ID를 확인한다. [환경 설정](../../src/cli/slack-environment.ts) · [클라이언트 구성](../../src/cli/slack-worker.ts)
2. **댓글 읽기.** `pollSlackLists`가 리스트를 순서대로 순회한다. `SlackListExportClient.read`가 댓글 스레드를 포함하는 JSON 내보내기를 요청하고 완료된 파일을 읽는다. `parseSlackListComments`가 항목 ID, 댓글 ID, 직접 멘션 여부를 추출한다. 한 리스트에서 오류가 나도 다음 리스트로 진행하며, 한 바퀴를 마치면 5분 뒤 다시 시작한다. [폴링](../../src/application/poll-slack-list.ts) · [내보내기 API](../../src/adapters/slack-list-export.ts) · [멘션 판별](../../src/policy/slack-list-export.ts)
3. **새 멘션 기록.** `SqliteSlackInbox.applyListSnapshot`이 workspace·리스트·대상 사용자별로 기존 댓글 ID와 비교한다. 기준점 이후 처음 삽입된 댓글에 대상 멘션이 있으면 본문을 마스킹해 `tasks.sqlite`에 저장한다. 다음 조회에서 같은 댓글을 다시 읽어도 새 알림을 만들지 않는다. [기준점·중복 처리](../../src/adapters/sqlite-slack-inbox.ts) · [재시작·오류 복구 테스트](../../tests/slack-list-worker.test.ts)

터미널에서는 `slack-list-poll` 이벤트의 `status: mention`과 리스트·항목·댓글 ID를 확인한다. 감시할 때와 같은 설정과 데이터 디렉터리로 `slack-list`를 실행하면 `listMentions`에 보관 중인 댓글 본문이 표시된다. 이 흐름의 출력은 로컬 알림과 댓글 목록이다. [조회 결과 조립](../../src/cli/slack-worker.ts) · [리스트 권한과 설정 예시](../guides/slack.md)

[전체 흐름 목록](README.md)
