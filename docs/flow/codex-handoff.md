# Codex에 작업을 넘기는 경로

Slack 멘션에 대해 **무엇을 분석할지**는 `src/policy/slack-analysis.ts`의 `instructions`와 `buildBody`가 정한다. **어떻게 실행할지**는 `RestrictedSlackAnalysisCodex.transmit`에서 공용 Codex 실행기로 이어진다. 인계 시점에 TypeScript 코드가 요청 JSON을 조립하고, 격리된 Codex CLI의 표준 입력으로 전달한다. [Slack 분석 지시문과 본문](../../src/policy/slack-analysis.ts) · [Slack용 Codex 어댑터](../../src/adapters/slack-analysis-codex.ts)

## 멘션과 스레드를 분석해 달라는 요청

[스레드 수집과 분석 대상 선택](thread-reply.md)을 마치면 `SlackAnalysisService.analyze`가 `model(runId).transmit(payload.dispatch, …)`를 호출한다. 여기서 `model`에 실제 어댑터를 연결하는 곳은 분석 worker다. [호출 지점](../../src/application/analyze-slack.ts) · [어댑터 연결](../../src/cli/slack-analysis-worker.ts)

| 알고 싶은 내용 | 파일에서 따라갈 부분 |
| --- | --- |
| 분석 지시와 자료는 어디서 합치는가? | `buildSlackAnalysisPayload`가 스레드 메시지마다 `slack-message-<ts>` 근거 ID와 줄 범위를 붙인다. `buildBody`가 이 자료와 한국어 답변을 요청하는 `instructions`, 빈 도구 목록, `READONLY_OUTPUT_SCHEMA`를 묶는다. 최종 요청 문자열은 `payload.dispatch.requestEnvelope.body`다. [요청 구성](../../src/policy/slack-analysis.ts) · [출력 스키마](../../src/policy/readonly-investigation-policy.ts) |
| 어떤 명령으로 Codex를 띄우는가? | `RestrictedSlackAnalysisCodex.transmit`이 요청을 재검증해 공용 실행기로 넘긴다. 실행기는 임시 작업공간에 `schema.json`을 쓰고 격리를 점검한다. `readonlyRelayCodexArguments`가 `codex exec`에 줄 인자를 조립하고, `runReadonlyRelayProcess`를 거쳐 자식 프로세스의 표준 입력으로 요청 본문을 보낸다. [Slack 어댑터](../../src/adapters/slack-analysis-codex.ts) · [CLI 인자와 실행 순서](../../src/adapters/readonly-relay-codex.ts) · [기본 인자](../../src/adapters/codex-cli-contract.ts) · [실행기](../../src/adapters/readonly-relay-runner.ts) · [표준 입력 쓰기](../../src/adapters/readonly-relay-process.ts) |
| 누가 실제 요청을 보내고 응답을 돌려주는가? | 로컬 중계기(broker)의 `sendReadonlyRelayRequest`가 검증된 본문을 한 번 전송한다. 서비스는 인증을 읽기 전과 전송 직전에 원본이 아직 유효한지 확인한다. 실행기는 중계가 완료됐는지 확인하고 Codex의 최종 텍스트를 서비스에 반환한다. [중계기](../../src/adapters/readonly-relay-broker.ts) · [실행 결과 검증](../../src/adapters/readonly-relay-codex.ts) |
| 누가 초안을 저장하는가? | `parseSlackAnalysisResponse`가 인용 범위와 보고서 필드를 검사한다. 서비스가 원본을 다시 확인하고 `slack-analysis.sqlite`에 결과를 기록한다. 사용자가 읽는 값은 `slack-inspect`의 `analysis.results[].report.answerDraft`다. [응답 검사](../../src/policy/slack-analysis.ts) · [저장](../../src/adapters/sqlite-slack-analysis.ts) · [조회](../../src/cli/slack-analysis-results.ts) |

[모델 호출과 무효화 테스트](../../tests/slack-analysis-service.test.ts) · [합성 입력을 사용한 native CLI 인계 테스트](../../tests/slack-analysis-native.test.ts)

## 합성 파일의 수정안을 요청하는 경우

`codex-proposal-*`는 운영자가 독립적으로 시작하는 코드 제안 명령이다. 여기서 Codex가 받는 일은 고정된 합성 파일 `src/message.mjs`의 내보낸 문자열을 `before`에서 `approved`로 바꾸는 것이다. Slack 보고서는 스레드 분석의 최종 산출물로 남는다.

| 시점 | 입력에서 결과까지 | 담당 파일 |
| --- | --- | --- |
| 호출 계획 | `codex-proposal-plan`이 `getCodexProposalInput()`의 지시문 전체와 해시, 모델 설정, 호출 한도를 보여 준다. `codex-proposal-approve`가 계획 해시와 만료 시간을 지정해 단건 호출을 승인한다. | [고정 지시문](../../src/policy/codex-proposal-policy.ts) · [CLI와 인자](../../src/cli/codex-proposal.ts) |
| Codex 호출 | `codex-proposal-run`에서 `CodexProposalService.run`이 승인을 소비한 뒤 `port.propose(inputText, signal)`를 호출한다. `CodexCliProposal.propose`가 격리된 CLI를 시작하고, broker가 출력 스키마와 고정 지시문을 넣어 요청을 보낸다. | [승인 소비와 호출](../../src/application/propose-codex.ts) · [CLI 실행기](../../src/adapters/codex-cli.ts) · [모델 요청과 출력 스키마](../../src/adapters/codex-broker.ts) |
| 제안 검토 | 응답은 `path`와 `content` 두 필드를 가져야 한다. `parseCodexProposalResponse`가 경로와 내용 등을 검증한 결과만 `codex-proposals.sqlite`에 `READY`로 기록된다. `codex-proposal-inspect`로 제안을 읽는다. | [응답 검사](../../src/policy/codex-proposal-policy.ts) · [제안 저장소](../../src/adapters/sqlite-codex-proposal-store.ts) |
| 별도 적용 | `codex-execution-plan`이 `READY`를 `EXPORTED`로 한 번 소비하고 `codex-execution.sqlite`에 새 승인 대기 계획을 만든다. `codex-execution-approve`와 `codex-execution-run`을 거쳐야 하네스가 독립 합성 브랜치에 제안을 적용하고 등록된 검사를 수행한다. | [실행 명령과 제안 인수](../../src/cli/execution.ts) · [합성 실행 서비스](../../src/application/execute-synthetic.ts) · [적용 테스트](../../tests/codex-execution-workflow.test.ts) |

개인·합성 저장소의 코드 질문은 [읽기 전용 조사](readonly-investigation.md), 회사 저장소에 대해 사전 검토한 요청을 Codex에 보내는 과정은 [회사 저장소 조사](company-investigation.md)에서 이어진다.
