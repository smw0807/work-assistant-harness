# 단계 2 구현 결과

## 범위와 상태

2026-11-10 기준 [단계 2 계획](implementation-plan.md#단계-2-slack-읽기-연결)의 Slack 읽기 어댑터·수집 저장소·로컬 CLI와 오프라인 테스트를 구현했다. 아래 구현 범위는 실제 파일과 대조했고 최종 lint·typecheck·전체 110개 테스트·별도 build를 통과했다. 실제 Slack 권한·회사 환경 검증 완료를 뜻하지 않는다.

실제 Slack 계정·AI 서비스·회사 저장소는 연결하지 않는다. `liveReadEnabled`는 기본 `false`이고, 실제 연결은 별도 승인된 계정·워크스페이스·채널과 데이터 보관 정책을 설정한 뒤 검증할 후속 작업이다. 수집과 분석을 분리하여 단계 2 수신 결과의 분석은 `not_run`으로 남긴다. 기존 fixture 모델의 합성 코드 답변을 실제 업무 답변으로 만들지 않는다.

## 변경 파일과 책임

| 경로 | 구현 |
| --- | --- |
| `src/domain/slack.ts`, `src/policy/slack-ingestion.ts` | 수신 계약, 엄격한 설정 검증, workspace·채널·고정 ID 멘션 필터, 원본 identity·revision 정규화 |
| `src/application/receive-slack.ts` | 영속 수신 후 ACK와 문맥 수집 분리, 단일 후속 처리, 수집 종료·오류 기록 |
| `src/adapters/sqlite-slack-inbox.ts` | inbox·수집 상태·중복·revision·삭제 marker, 보관 만료, 관련 작업·스레드 무효화, 최근 100개 연결 이력 |
| `src/adapters/slack-read-client.ts` | 고정 `auth.test`·`apps.connections.open`·`conversations.replies`, workspace 확인, 요청·응답·페이지·재시도 제한과 취소 |
| `src/adapters/slack-socket-transport.ts` | 정확한 WSS 호스트 검사, 프레임·큐 상한, 전달별 ACK, 제한된 재연결·취소 |
| `src/cli/slack.ts`, `src/cli/slack-worker.ts`, `src/cli/main.ts`, `src/cli/runtime.ts` | NestJS 수신 CLI, 비공개 경로·기존 변경 명령 잠금, 토큰·네트워크 분리, 수집 조회와 종료 순서 |
| `src/domain/types.ts`, `src/domain/state.ts`, `src/policy/ingestion.ts`, `src/application/investigate.ts`, `src/cli/worker.ts` | 기존 작업의 원본 messageTs 기록, 취소 전이, DB 원본에 따른 보고서 복구 |
| `src/policy/redaction.ts` | Slack app-level 토큰 패턴과 Slack 수집용 이메일·국내 휴대전화 마스킹 |
| `config/slack.example.json`, `config/slack-app-manifest.example.json`, `fixtures/slack/receive.json` | 기본 비활성·합성 설정, 공개 채널 읽기 최소 manifest, 합성 Socket 이벤트 |
| `tests/slack-inbox.test.ts`, `tests/slack-reception.test.ts`, `tests/slack-transport.test.ts` | 저장·정규화·실제 CLI·권한·가짜 HTTP/Socket 경계·재시작·취소 테스트 |
| `README.md`, `docs/` | 실제 명령, 데이터 흐름, 권한·보관 한계와 단계별 결과 |

패키지 매니저와 의존성·lockfile은 바꾸지 않았다. Slack SDK를 추가하지 않고 Node 기본 `fetch`·`WebSocket`을 사용한다. 승인·실행 포트와 기존 조사 worker의 네트워크·child process 차단은 유지한다.

## 데이터 흐름과 구현 경계

합성 Socket 이벤트 또는 명시적으로 켠 수신부에서 허용 workspace·채널·사용자 ID와 입력 한도를 확인한다. 마스킹한 최소 이벤트와 `(workspace_id, event_id)`를 `tasks.sqlite`의 `slack_*` 테이블에 commit한 뒤 해당 `envelope_id`를 ACK한다. ACK에는 업무 답변을 넣지 않는다. 저장 실패와 큐 포화로 새 메시지를 보존하지 못한 경우에는 성공 ACK하지 않는다. 편집은 큐가 가득 차도 기존 계획의 무효화와 최신 요청의 `BLOCKED`·`SLACK_INBOX_FULL`을 commit한 뒤 ACK하고 문맥 수집만 생략한다. commit 후 ACK 실패·재전달은 중복 키로 처리한다.

후속 스레드 수집과 취소 보고서 동기화는 ACK 핸들러에서 분리한다. 페이지·메시지·바이트·시간과 재시도를 제한하고 불완전 사유를 기록한다. 실제 연결 경로는 먼저 `auth.test`의 workspace를 설정과 비교하며, 토큰은 수신 worker 환경변수로만 전달한다. 종료 신호는 HTTP·대기·Socket·후속 수집에 전달하고 후속 작업이 끝난 뒤 DB를 닫는다.

원본은 `(workspaceId, channelId, messageTs)`로 묶고 timestamp 정밀도를 보존해 revision을 비교한다. 편집·삭제·멘션 제거는 오래된 본문·스레드를 무효화하며 관련 기존 조사 작업을 `CANCELLED`, DB의 계획·보고를 `null`로 바꾼다. 다른 reply의 편집·삭제도 확인한 같은 스레드의 cached·pending·진행 중 문맥과 연결된 계획을 무효화한다. 스레드 root를 알 수 없는 변경은 같은 채널의 `RECEIVED`이면서 pending·processing인 수집을 보수적으로 `INVALIDATED`·`THREAD_CHANGED`로 바꿔 늦은 문맥 저장을 막는다. 관련성이 확인되지 않은 완료 수집은 유지한다. 큐가 가득 차도 삭제·멘션 제거는 후속 수집 없이 반영한다. 삭제가 먼저 도착하거나 이전 revision의 수집이 늦게 끝나도 최신 상태를 되돌리지 않는다.

DB가 원본이다. 기존 조사 보고서 파일은 취소 상태로 다시 쓰고, 쓰기 중 종료되면 다음 명령에서 복구한다. 단계 2 수집 결과는 별도 답변 초안 파일을 만들지 않으며 SQLite와 CLI JSON 출력에서 확인한다. 중단된 `processing`은 자동 재수집 없이 `BLOCKED`, 아직 시작하지 않은 `pending`은 다음 수신 실행의 후속 처리 대상으로 남긴다.

보관 기한은 마스킹한 본문·문맥 payload에 적용한다. 명령 시작·수신·후속 처리와 실수신 중 매분 만료 payload를 지우며, 처리 중 기한이 지난 결과도 다시 저장하지 않는다. 중지된 DB는 다음 실행 전까지 남는다. 중복·revision·삭제 marker는 DB 수명 동안 보존하고 연결·공백 이력은 최근 100개를 보존한다. 실환경 연결과 토큰 권한 검증은 아직 실행하지 않았다.

## 검증 결과

최종 소스에서 macOS·Node 26.12.1 환경으로 아래 검사를 실행했다. 전체 테스트는 기존 60개와 수신함 21개·수신 서비스/CLI 12개·HTTP/Socket 17개로 총 110개이며, 실패 0개·미실행 0개다.

| 검사 | 결과 | 설명 |
| --- | --- | --- |
| `pnpm lint` | passed | ESLint 오류 없음 |
| `pnpm typecheck` | passed | strict TypeScript 검사 통과 |
| `pnpm test` | passed | 전체 110개, 실패 0개·미실행 0개 |
| `pnpm build` | passed | 전체 테스트 후 별도 컴파일 통과 |
| 대상 설치·테스트·빌드 | not_run | 읽기 단계의 금지 동작 |
| 실제 Slack 연결·토큰 권한·채널 멤버십·스레드 조회 | not_run | 실제 계정을 연결하지 않음 |
| 실제 AI·회사 저장소·회사 보안 검토 | not_run | 별도 승인과 검증이 필요한 범위 |
| 승인 소비·대상 코드 변경·격리 실행 | not_run | 단계 3 기능이며 이번 수집 경로에 연결하지 않음 |

수용 항목 17~26은 합성 프레임·가짜 HTTP/Socket·임시 SQLite·제한된 실제 CLI로 검증했다. 저장 실패와 ACK 순서, 다른 envelope의 재전달, 편집·삭제·멘션 제거·순서 역전, 포화 중 무효화, 다른 reply의 문맥 변경, 처리 중 보관 만료, 제한된 조회·429·취소·재연결, 토큰·권한 분리를 포함한다. 기존 단계 1의 모델 오류·악성 지시·읽기 정책·대상 전후 무변경 검사도 전체 테스트에 포함했다.

네트워크 허용 여부를 검사하는 권한 테스트에서 Node의 실험적 `--allow-net` 경고 1건이 발생했으며 실패는 아니다. 해당 테스트도 실제 네트워크에 접속하지 않는다. 모의 테스트의 통과를 Slack 앱 설치·토큰 권한·회사 보안 검토 통과로 확대하지 않는다.

## 남은 한계와 다음 최소 작업

- 오프라인 Socket·HTTP 모의 테스트는 실제 앱 설치·권한·Slack 전달 동작 검증이 아니다.
- 재연결 공백은 누락 가능 구간으로 남기며 전량 수집이나 자동 backfill을 보장하지 않는다.
- root를 알 수 없는 편집·삭제는 같은 채널에서 진행 중인 무관한 수집까지 보수적으로 중단할 수 있다. 포화로 `BLOCKED`가 된 편집과 무효화된 문맥을 자동 재수집하는 기능은 없다.
- 패턴 마스킹은 모든 비밀·개인정보를 판별하지 않는다. 실제 보관 기간과 처리 정책은 회사 승인에 따라 정한다.
- 본문·문맥 payload의 보관은 1~168시간, 기본 24시간이다. 중복 키·원본 identity·revision·삭제 marker는 DB 수명 동안 남으며 이 metadata로 전체 DB 크기가 계속 늘 수 있다. 논리적 삭제는 물리적 완전 삭제가 아니고, DB를 폐기한 뒤에는 과거 이벤트의 중복·순서 보존을 보장하지 않는다.
- 수신부의 네트워크 권한은 Node 프로세스 전체에 적용된다. 고정 API·redirect 거부·정확한 WSS 호스트 검증은 하네스 코드가 강제하며 호스트별 OS 격리가 아니다.
- 수집 결과는 분석 미실행이다. 실제 AI와 대상 저장소를 연결하려면 별도 데이터 정책과 조사 품질 검증이 필요하다.

다음 실환경 작업은 별도 승인된 테스트 워크스페이스에서 최소 공개 채널 하나의 읽기 범위와 수신·편집·삭제·재시도·재연결을 확인하는 것이다. 승인·코드 실행은 단계 3으로 분리한다.
