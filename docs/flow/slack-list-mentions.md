# Slack 리스트 댓글의 멘션을 발견하는 흐름

`SLACK_LIST_ID`에 리스트를 등록하고 `slack-listen`을 시작하면, 하네스가 주기적으로 리스트를 조회해 새 댓글에서 본인 멘션을 찾는다. **리스트마다 첫 성공 조회가 기준점**이다. 예전에 달린 댓글은 이때 확인한 것으로 표시하고, 이후 처음 발견한 댓글부터 알린다. 채널과 리스트를 함께 등록하면 [채널 수신](slack-intake.md)도 같은 worker에서 동작한다.

1. **감시할 리스트 선택.** `parseSlackEnvironment`가 쉼표로 구분한 리스트 ID를 읽는다. 수신 worker는 리스트 전용 사용자 토큰이 있으면 그 토큰을, 없으면 Web API 토큰을 읽기 클라이언트에 연결한다. 사용자 토큰을 쓰는 경우 workspace와 대상 사용자 ID를 확인한다. [환경 설정](../../src/cli/slack-environment.ts) · [클라이언트 구성](../../src/cli/slack-worker.ts)
2. **항목과 스레드 등록.** `pollSlackLists`가 리스트를 순회하고 `SlackListExportClient.read`가 댓글을 포함한 JSON을 받는다. `parseSlackListSnapshot`이 항목별 댓글과 직접 조회할 `record.thread_ts`를 추출한다. `SqliteSlackInbox.applyListSnapshot`은 첫 내보내기의 댓글 ID를 기준점으로 저장하고, 이후 내보내기에서 새로 발견한 직접 멘션을 기록한다. [폴링](../../src/application/poll-slack-list.ts) · [내보내기 API](../../src/adapters/slack-list-export.ts) · [파서](../../src/policy/slack-list-export.ts)
3. **내보내기에 빠진 답글 조회.** 다음 내보내기까지 5분 동안 `pollThreadReplies`가 항목 스레드를 한 페이지씩 돌아가며 읽는다. `SlackReadClient.readListThreadPage`는 같은 토큰으로 `conversations.replies`를 호출해 해당 항목의 마지막 저장 시각(`oldest`) 이후 답글을 가져온다. 첫 기준점은 내보내기 요청을 시작한 시각이다. 기존 DB에 직접 조회 이력이 없으면 항목별 마지막 댓글 시각에서 이어간다. 내보낸 댓글이 잘렸거나 잘못된 형식이면 `parseSlackListThreadBindings`로 이번 응답의 항목 ID와 스레드 시각을 다시 확인한다. SQLite에 같은 연결이 등록되어 있는 항목만 직접 조회한다. [직접 조회](../../src/adapters/slack-read-client.ts) · [스레드 등록과 시각 복구](../../src/adapters/sqlite-slack-inbox.ts)
4. **한 번만 알림.** `parseSlackListReplyPage`가 내보내기와 같은 규칙으로 작성자와 직접 멘션을 확인하고 발췌문을 마스킹한다. `applyListThreadReplies`가 페이지의 댓글과 마지막 답글 시각을 함께 저장한다. 같은 워크스페이스·리스트·대상 사용자·항목 안에서는 두 경로가 댓글 ID를 공유하므로, 같은 답글을 다음 내보내기나 재시작 후 다시 만나도 알림은 한 번이다. [멘션 판별](../../src/policy/slack-list-export.ts) · [저장과 중복 처리](../../src/adapters/sqlite-slack-inbox.ts) · [저장소 테스트](../../tests/slack-list-inbox.test.ts)

터미널의 `slack-list-poll` 이벤트는 `status: "mention"`과 리스트·항목·댓글 ID를 출력한다. 직접 조회로 발견한 멘션에는 `source: "thread"`가 붙는다. 권한 오류는 `status: "error"`, `method: "conversations.replies"`로 표시되며, 내보내기는 계속한다. 같은 설정과 데이터 디렉터리로 `slack-list`를 실행하면 `listMentions`에서 보관 중인 발췌문을 읽을 수 있다. [조회 결과 조립](../../src/cli/slack-worker.ts) · [리스트 권한과 오류 확인](../guides/slack.md#리스트-댓글-멘션-감시)

리스트 스레드 분석을 켜면 새 멘션이 발생한 항목의 전체 대화가 [답변 초안](thread-reply.md)의 입력이 된다. 최초 기준점의 댓글은 분석 대상에서 제외한다. 결과를 보려면 같은 설정으로 `slack-inspect <list-id> <comment-ts>`를 실행한다. [설정과 결과 조회](../guides/slack.md#slack-본인-멘션-자동-분석)

[전체 흐름 목록](README.md)
