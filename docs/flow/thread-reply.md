# 스레드 답변 초안이 만들어지고 표시되기까지

자동 분석을 켜면 Codex가 [채널 멘션](slack-intake.md) 또는 [리스트 댓글 멘션](slack-list-mentions.md)이 속한 스레드를 근거로 한국어 보고서를 작성한다. 리스트를 포함하려면 `SLACK_LIST_ANALYSIS_ENABLED=true`를 함께 설정한다. **답변 초안은 보고서의 `answerDraft` 필드**다. 사용자가 `slack-inspect`에서 읽는 시점이 이 흐름의 끝이다. Slack 게시에는 아래에 설명한 별도의 고정 문구 시험 경로가 있다.

## 초안 한 건의 생성 순서

1. **분석을 시작한다.** `slack-listen --env` 또는 `--env-file`에서 채널과 실수신을 설정하고, `SLACK_ANALYSIS_ENABLED=true`와 `SLACK_ANALYSIS_CODEX_CONFIG`로 분석 설정 파일을 지정한다. 분석 worker는 활성화된 설정과 Codex 바이너리를 확인하고 부모에게 준비 신호를 보낸다. 수신 worker가 Slack 토큰을 갖고, 분석 worker는 수신 결과를 읽는 별도 프로세스로 동작한다. [환경 설정](../../src/cli/slack-environment.ts) · [프로세스 기동 순서](../../src/cli/slack-analysis-supervisor.ts) · [분석 worker](../../src/cli/slack-analysis-worker.ts)
2. **현재 문맥을 고른다.** `SlackAnalysisService.tick`은 `tasks.sqlite`에서 이번 실행 중에 수신한 `RECORDED` 요청을 읽는다. 채널에서는 소켓 연결 공백 이전에 수집한 스레드를 건너뛴다. 리스트에서는 수신기가 확인한 항목과 댓글의 전체 문맥을 사용한다. 불완전한 스레드는 `BLOCKED`로 기록한다. 같은 workspace·채널·메시지·revision은 한 번만 시도한다. 한 번에 한 건씩, 데이터 디렉터리당 UTC 하루 최대 20건을 시도한다. [원본 읽기](../../src/adapters/slack-analysis-source.ts) · [tick과 중복 처리](../../src/application/analyze-slack.ts)
3. **Codex에 줄 지시와 자료를 만든다.** `buildSlackAnalysisPayload`는 루트 메시지와 멘션 원문이 스레드에 들어 있는지 확인하고 마스킹된 메시지마다 시각 기반 근거 ID와 줄 범위를 붙인다. 같은 파일의 `instructions`가 한국어 답변, 근거 인용, 부족한 정보에 대한 질문을 요청한다. `buildBody`가 이 지시·자료·출력 스키마를 묶는다. 사용자가 쓴 문장은 근거로만 전달하며 도구 목록은 비어 있다. [지시문과 요청 생성](../../src/policy/slack-analysis.ts) · [보고서 스키마](../../src/policy/readonly-investigation-policy.ts)
4. **초안을 받고 검증한다.** `SlackAnalysisService.analyze`가 모델 포트의 `transmit`을 호출한다. worker가 연결한 구현은 `RestrictedSlackAnalysisCodex`다. `parseSlackAnalysisResponse`는 돌아온 JSON을 검사하고 인용 ID와 줄 범위를 실제 입력 근거에 대조한다. 검증 대상에는 빈 수정 제안 목록, 민감정보, 일반 문장에 노출된 Slack 식별자도 있다. [모델 호출과 결과 처리](../../src/application/analyze-slack.ts) · [Codex 어댑터](../../src/adapters/slack-analysis-codex.ts) · [응답 정책](../../src/policy/slack-analysis.ts) · [Codex 인계 상세](codex-handoff.md)
5. **검토할 결과를 보관한다.** 서비스는 저장 직전 원본과 연결 상태를 다시 확인한다. 통과하면 `SqliteSlackAnalysisStore.finish`가 요약·사실·가설·초안·질문·한계를 `<data-dir>/slack-analysis.sqlite`에 `REPORTED`로 기록한다. 보고서 본문은 원본 보관 기한과 분석 시작 후 24시간 중 먼저 오는 시점에 만료된다. [저장과 만료 처리](../../src/adapters/sqlite-slack-analysis.ts)

## 내 초안 찾기

수신 때 사용한 설정과 데이터 디렉터리로 `slack-list`를 실행해 요청의 `channelId`와 `messageTs`를 찾는다. 이 두 값을 `slack-inspect`에 넘긴다. 스레드 답글에서 멘션됐다면 **멘션 메시지의 시각**인 `messageTs`와 루트의 `threadTs`가 다를 수 있다.

```sh
pnpm harness slack-list --env-file "$SLACK_ENV_FILE" --data-dir "$SLACK_DATA_DIR"
pnpm harness slack-inspect "$CHANNEL_ID" "$MESSAGE_TS" --env-file "$SLACK_ENV_FILE" --data-dir "$SLACK_DATA_DIR"
pnpm harness slack-inspect "$LIST_ID" "$COMMENT_ID" --env-file "$SLACK_ENV_FILE" --data-dir "$SLACK_DATA_DIR"
```

채널은 `channelId`와 `messageTs`, 리스트는 `listId`와 타임스탬프 형식의 `commentId`로 조회한다. 환경 파일과 데이터 경로는 수신 때 사용한 값을 넣는다. 첫 명령은 분석 상태를 보여 준다. 해당 `slack-inspect` 명령은 원본·스레드와 함께 **`analysis.results[].report.answerDraft`**를 표시한다. `appendSlackAnalysisResults`가 조회 시점에도 원본 해시를 대조하므로, 편집 등으로 근거가 달라진 결과는 무효화된다. 조회에는 새 모델 호출이 필요하지 않다. [조회 결과 결합](../../src/cli/slack-analysis-results.ts) · [미완성 스레드·무효화·조회 테스트](../../tests/slack-analysis-service.test.ts)

## 답장 관련 명령은 어디서 처리하나

| 명령 | 입력과 결과 | 담당 파일 |
| --- | --- | --- |
| `replay --fixture inquiry` | 합성 저장소 조사 예제에서도 `answerDraft`를 볼 수 있다. `FixtureModel.summarize`가 만든 답안을 `InvestigationService`가 문의 보고서에 넣고 `reports/<taskId>.json`으로 쓴다. | [고정 응답 모델](../../src/adapters/fixture-model.ts) · [조사 서비스](../../src/application/investigate.ts) · [로컬 보고서](../../src/adapters/local-report-sink.ts) |
| `reply-plan`, `reply-inspect`, `reply-approve`, `reply-send` | 고정 합성 본문 `syntheticReplyBody`를 계획에 결합한다. 소유자가 본문을 검토하고 계획 해시와 유효기간을 승인한 뒤, `send`를 호출하면 승인 소비와 시도 기록을 `replies.sqlite`에 남기고 가짜 어댑터를 한 번 호출한다. 성공 상태는 `SIMULATED`다. | [reply worker](../../src/cli/reply-worker.ts) · [본문과 계획](../../src/policy/reply-policy.ts) · [SyntheticReplyService](../../src/application/send-reply.ts) · [모의 전송](../../src/adapters/mock-reply-delivery.ts) |
| `slack-post-check` | 합성 HTTP 응답으로 인증, 스레드 재확인, 게시 요청의 형식과 응답 분류를 검사한다. 결과물은 `slack-post-checks/<verificationId>/report.json`이다. | [진단 worker](../../src/cli/slack-post-worker.ts) · [진단 서비스](../../src/application/verify-slack-post.ts) · [메시지 계약 어댑터](../../src/adapters/slack-post-message.ts) |
| `slack-live-plan`, `slack-live-inspect`, `slack-live-approve`, `slack-live-send` | 실전송 시험용이다. 정해진 시험 원문과 답글 없는 스레드를 확인하고, 별도 계획·승인을 `live-replies.sqlite`에 보관한다. 명시적으로 활성화한 `send`만 고정 `liveTestBody`를 `chat.postMessage`로 한 번 보낸다. | [live CLI](../../src/cli/live-slack.ts) · [시험 문구](../../src/policy/live-slack-policy.ts) · [승인·전송 서비스](../../src/application/live-slack.ts) · [Slack API 어댑터](../../src/adapters/live-slack.ts) |

현재 멘션 분석의 `answerDraft`를 받아 실제 스레드에 게시하는 CLI 연결은 없다. [모의 전송 승인 테스트](../../tests/reply-service.test.ts) · [고정 문구 실전송 CLI 테스트](../../tests/live-slack-cli.test.ts)
