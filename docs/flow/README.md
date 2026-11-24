# 하네스 실행 흐름

**채널에서 나를 멘션하면**, `slack-listen`이 이벤트를 받아 로컬 수신함에 기록하고 해당 스레드를 조회한다. 자동 분석을 켠 경우에는 별도 프로세스가 수집된 대화를 Codex에 보내고, 검증을 통과한 답변 초안을 저장한다. 사용자는 `slack-inspect`로 초안을 읽는다. 회사 코드를 조사하거나 파일을 적용하려면 별도 CLI에서 작업을 시작해야 한다.

| 알고 싶은 것 | 따라갈 흐름 |
| --- | --- |
| 어떤 채널 멘션을 받으며 언제 Slack에 수신 확인을 보내는가? | [Slack 멘션 수신과 스레드 수집](slack-intake.md) |
| Slack 리스트 댓글에 달린 멘션은 언제 발견되고 어디에 표시되는가? | [리스트 댓글 멘션 감지](slack-list-mentions.md) |
| 답변 초안은 누가 만들고 어디에서 읽는가? 실제 게시 기능은 어디까지인가? | [스레드 답변 초안과 전송](thread-reply.md) |
| Codex에 보낼 지시와 문맥은 어느 파일에서 조립하는가? 수정 제안은 누가 실행 계획으로 옮기는가? | [Codex 작업 인계](codex-handoff.md) |
| 토큰 없이 문의·변경 요청을 재현하면 어떤 파일이 근거를 읽고 계획과 보고서를 만드는가? | [로컬 모의 조사와 승인](local-replay.md) |
| 합성 브랜치를 만들거나 승인한 변경을 적용하고 Docker에서 검사하는 코드는 어디인가? | [합성 브랜치와 격리 실행](synthetic-execution.md) |
| 합성 자료나 개인 저장소 발췌를 모델에 전달하는 명령은 어떻게 다른가? | [읽기 전용 모델 조사](readonly-investigation.md) |
| 회사 저장소의 선택한 근거를 준비한 뒤 모의 조사나 실제 모델 전송은 어떻게 시작하는가? | [회사 저장소 조사](company-investigation.md) |
| 회사 수정안을 검토하고 승인한 파일을 로컬 브랜치에 적용하는 경로는 무엇인가? | [회사 변경안 검토와 적용](company-change.md) |

## 프로세스는 어디서 시작하는가?

1. `pnpm harness <명령>`은 TypeScript를 컴파일한 뒤 `node -- dist/src/cli/main.js`로 진입한다. `pnpm start`는 같은 진입점에 `slack-listen`과 스크립트에 지정된 env 파일·데이터 디렉터리를 넘긴다. [실행 스크립트](../../package.json)
2. `main.ts`가 명령을 담당 CLI로 보낸다. 예를 들어 `slack-listen`은 `runSlackCommand`로, `codex-proposal-plan`은 `runCodexProposalCommand`로 간다. `replay`·`list`·`inspect`는 이 파일의 `run`에서 로컬 조사 worker를 띄운다. 전체 명령과 필수 인자는 `pnpm harness --help`로 조회한다. [CLI 분기](../../src/cli/main.ts)
3. 각 CLI가 자신의 작업에 필요한 서비스와 어댑터를 연결한다. 예를 들어 모의 조사는 NestJS application context에 고정 모델과 Git 판독기를 등록한다. Slack 수신은 수신 worker에 Web API 클라이언트를 연결하고, 분석을 켜면 supervisor가 Codex용 프로세스도 관리한다. [모의 조사 모듈](../../src/cli/harness.module.ts) · [Slack CLI](../../src/cli/slack.ts) · [분석 supervisor](../../src/cli/slack-analysis-supervisor.ts)

코드를 직접 따라갈 때는 `src/cli/`에서 **무엇을 연결하는지**, `src/application/`에서 **어떤 순서로 호출하는지**를 본다. 예를 들어 채널 멘션을 처리하는 서비스는 [receive-slack.ts](../../src/application/receive-slack.ts)다. 이 서비스에서 멘션 인정 조건은 [수신 정책](../../src/policy/slack-ingestion.ts)으로, 스레드를 읽는 실제 API 호출은 [Slack 읽기 어댑터](../../src/adapters/slack-read-client.ts)로 이어진다.

## 결과를 찾는 기준

| 가지고 있는 정보 | 열어볼 결과 |
| --- | --- |
| Slack 채널 ID와 멘션 메시지의 `ts` | 수신 때와 같은 설정·데이터 디렉터리로 `slack-inspect <channel-id> <message-ts>`. 수신 문맥은 `tasks.sqlite`, 분석 보고서는 `slack-analysis.sqlite`에서 합쳐 보여 준다. [조회 코드](../../src/cli/slack-analysis-results.ts) |
| `replay`가 출력한 `taskId` | 같은 데이터 디렉터리로 `inspect <task-id>`. 분류·근거·계획·승인 이력은 SQLite에서, 사람이 읽을 작업 사본은 `reports/<task-id>.json`에서 확인한다. [조사 worker](../../src/cli/worker.ts) · [보고서 작성기](../../src/adapters/local-report-sink.ts) |
| 별도 승인 작업의 ID | 작업을 만든 명령과 같은 계열의 `*-inspect`로 조회한다. 예를 들어 `codex-proposal-inspect`는 모델 제안, `codex-execution-inspect`는 그 제안을 바탕으로 만든 실행 계획·결과를 연다. [제안 CLI](../../src/cli/codex-proposal.ts) · [실행 CLI](../../src/cli/execution.ts) |
| 설치 환경을 옮기기 위한 private 설정 | `migration-check --config <경로>`가 설정 버전에 따라 전체 또는 부분 정적 점검을 선택하고 결과 JSON을 터미널에 출력한다. [점검 CLI](../../src/cli/migration-check.ts) · [전체 점검](../../src/application/migration-check.ts) · [부분 점검](../../src/application/migration-partial-check.ts) |

설치와 Slack 설정은 [프로젝트 README](../../README.md), 실제 운영 명령은 [가이드 목록](../README.md), 각 작업의 승인 조건은 [보안과 승인](../security-and-approval.md)에 있다.
