# 개인 업무 하네스 구현 계획

TypeScript와 NestJS로 집에서 만들고 회사에서 연결하는 승인 중심 업무 도우미

핵심 방향은 Slack에서 나를 부른 메시지를 모아 저장소를 읽고, 답변 초안이나 수정 계획을 나에게 보여 주는 것이다. 코드 변경은 내가 승인한 뒤에만 격리된 작업 공간에서 수행한다. 첫 버전은 실제 회사 계정 없이 로컬에서 검증할 수 있게 만든다.

현재 구현 상태: 단계 0·1의 모의 조사, 단계 2의 수신·오프라인 검증, 단계 3-A의 로컬 승인, 단계 3-B의 Docker 격리 진단과 단계 3-C의 독립 합성 실행에 이어 2026-11-10에 단계 3-D의 합성 요청 무효화·취소·crash 복구·잔여 상태 관찰을 구현했다. 2026-11-11의 후속 요청 범위는 단계 4-A의 합성 답장 계획·별도 승인·모의 전송, 단계 4-B-1의 오프라인 Slack HTTP 계약 진단과 단계 4-B-2의 고정 시험 문구 단건 전송이다. 구현·검증 상태는 [4-A 결과](stage-4a-result.md), [4-B-1 결과](stage-4b1-result.md)와 [4-B-2 결과](stage-4b2-result.md)에 기록한다. 실제 검증은 [단계 3-B](stage-3b-result.md), [단계 3-C](stage-3c-result.md), [단계 3-D 결과](stage-3d-result.md)에 기록한다. 기존 조사 Task와 `approval-only-v1`은 실행에 연결하지 않으며 실제 Slack 단건 시험은 별도 live 경로로 분리한다. AI·회사 저장소와 자동 답장은 연결하지 않는다. 기존 범위는 [단계 1](stage-1-result.md), [단계 2](stage-2-result.md), [단계 3-A 결과](stage-3a-result.md), 현재 명령은 [README](../README.md)를 따른다. 회사 도입과 구체 live 계획에 대한 실제 게시 승인은 별도 범위다. 아래 범용 실행 명령 예시는 구현 제안이다.

2026-11-12에는 단계 4-C-1의 오프라인 브랜치 계획·별도 승인·모의 실행·제어·복구를 추가했다. 실제 Codex와 Git 작업은 연결하지 않으며 [4-C-1 결과](stage-4c1-result.md)에 검증 상태를 기록한다.

후속 4-C-2는 독립 합성 Git 저장소에 별도 승인으로 실제 ref 하나를 생성하고 관찰·복구하는 경로다. 실제 Codex·회사 저장소·코드 변경·작업 결과 commit·원격 작업은 연결하지 않는다. 최종 검증 상태는 [4-C-2 결과](stage-4c2-result.md)를 따른다.

4-C-3은 합성 작업 브랜치의 고정 수정·Docker 검사까지 연결했고 [4-C-3 결과](stage-4c3-result.md)에 완료 근거를 남겼다. 4-C-4는 별도 승인으로 고정 합성 입력만 실제 Codex에 보내 JSON 제안을 받은 뒤, 다시 승인한 독립 실행 계획에서 적용·검사하는 범위다. 회사 자료·회사 저장소·Git 원격 작업은 연결하지 않으며 실제 호출·격리·취소·복구와 회귀의 최종 결과는 [4-C-4 결과](stage-4c4-result.md)를 따른다.

4-C-5는 합성 다중 파일의 읽기 전용 조사를 `mock` 전용으로 구현한다. 읽기·전송·수정 범위를 분리하며 수정 허용 파일과 대상 검사 명령은 빈 목록이다. 이번 요청에서 실제 모델 호출은 제외했고 live adapter·동적 broker는 연결하지 않는다. 오프라인 수용 검증과 실제 모델 `not_run` 기록은 [4-C-5 결과](stage-4c5-result.md)를 따른다.

4-C-6은 승인한 합성 문맥으로 최종 요청 본문을 구성하고 가짜 transport에 전달하는 `offline`/`fake` 전용 경로다. 별도 승인·상태 저장소, 최종 본문 hash, 제한 worker와 JSON/NDJSON 응답 검증을 구현했다. 실제 모델 호출·인증정보 접근·외부 전송은 제외하며 수용 119~134와 실제 회귀 결과는 [4-C-6 결과](stage-4c6-result.md)를 따른다.

4-C-7은 다중 파일 조사용 실제 모델 연결을 준비하는 오프라인 경로로 구현했다. 연결 후보 profile·인증정보 없는 HTTP 요청 명세·JSON/SSE 변환 계층을 메모리 가짜 전송기로 검증했다. 실제 모델 호출·인증정보 접근·외부 전송은 제외하며 수용 135~150과 전체 726개 회귀의 최종 결과는 [4-C-7 결과](stage-4c7-result.md)를 따른다. 실제 연결과 의미 정확성 검증은 완료 범위에 포함하지 않는다.

4-C-8은 합성 다중 파일을 실제 모델로 읽기 전용 조사하는 별도 live 경로를 추가한다. 기존 오프라인 승인을 재사용하지 않으며 구체 입력 승인 전 실제 호출은 수행하지 않는다. 구현·로컬 검사·실제 인증/전송/격리의 결과를 [4-C-8 결과](stage-4c8-result.md)에 각각 기록한다.

### 하네스가 맡을 역할

하네스는 AI 모델 자체가 아니라 모델 주변의 실행 프로그램이다. 어떤 메시지를 받을지, 어떤 자료를 읽힐지, 어느 작업에서 멈출지, 누가 승인할지, 결과를 어디에 보관할지를 정한다. 모델은 해석과 추론을 맡고, 권한과 실행 여부는 일반 코드가 결정한다.

- 입력: 승인된 Slack 채널에서 내 고정 사용자 ID를 멘션한 메시지와 필요한 스레드 문맥.
- 처리: 문의, 변경 요청, 불명확한 요청으로 분류하고 관련 저장소의 근거를 찾는다.
- 출력: 나에게만 보이는 조사 결과, 답변 초안, 수정 계획, 실행 결과와 테스트 기록.

### 저장소 이름

추천 이름은 work-assistant-harness다. 특정 모델이나 Slack에 종속되지 않아 나중에 메일과 일정까지 늘려도 이름이 자연스럽다. 회사 제품 저장소와 별도로 관리한다.

| **대안** | **어울리는 방향** |
| --- | --- |
| approval-first-harness | 사람의 승인 절차가 프로젝트의 가장 중요한 특징일 때 |
| slack-code-assistant | 초기 범위를 Slack과 코드 조사에 명확히 한정할 때 |
| personal-work-harness | 개인용 업무 도구라는 성격을 강조할 때 |

### 첫 버전의 경계

개인 개발 저장소와 가짜 데이터로 시작한다. 자동 답장, 자동 push, PR 생성, 병합, 배포는 포함하지 않는다. Gmail, Calendar, Drive는 이후의 선택 기능이다. 아래 구조와 명령은 구현 제안이며 이미 존재하는 기능을 뜻하지 않는다.

**회사 Slack이나 소스 코드를 외부 AI 서비스에 보내도 되는지는 별도 승인 사항이다.** 개인의 코드 수정 승인만으로 회사의 데이터 반출 승인을 대신할 수 없다.

## 1 전체 동작 흐름

한 요청은 하나의 작업으로 기록한다. 메시지를 받았다는 이유만으로 코드 수정 권한이 생기지 않는다. 다른 사람이 Slack에서 요청한 내용은 조사 대상이며, 실행 승인은 별도로 내가 내린다.

### 1 메시지를 받는다

허용된 워크스페이스와 채널인지 확인하고, \<@TARGET\_USER\_ID\> 멘션을 찾는다. 이벤트 ID로 중복을 제거한다.

### 2 문맥과 저장소를 고른다

필요한 스레드 범위만 읽고, 사전 설정된 채널 또는 프로젝트와 저장소의 연결을 사용한다. 저장소 후보가 여러 개면 나에게 확인한다.

### 3 요청을 분류한다

문의, 변경 요청, 불명확 중 하나를 고른다. 모델의 분류는 추천이며 실행 허가가 아니다. 불확실하거나 분류 결과가 잘못된 형식이면 확인 단계로 보낸다.

### 4 읽기 전용으로 조사한다

승인된 경로와 파일만 읽는다. 파일 위치와 기준 커밋을 근거로 정리한다. 조사 중에는 패키지 설치, 테스트, 빌드, 쉘 스크립트 실행을 하지 않는다.

### 5 나에게 결과를 보여 준다

문의면 답변 초안을, 변경 요청이면 원인 가설과 수정 계획을 보여 준다. 불명확하면 질문을 제시한다. 요청자에게는 자동으로 보내지 않는다.

### 6 승인된 작업만 실행한다

수정 승인을 받으면 기준 커밋을 다시 확인하고 별도 브랜치와 worktree에서 작업한다. 후속 Codex 실행 연결에서는 대상 저장소의 작업 성격에 맞는 `feature/`, `fix/`, `chore/`, `refactor/` 브랜치를 만들고 그 안에서 수정한다. 허용된 테스트를 실행한 뒤 브랜치·diff·결과를 보고하며 PR 생성은 지시하지 않는다. 이 브랜치 규칙은 하네스가 Codex에 맡기는 대상 저장소 작업의 설계이며, 현재 하네스 저장소 자체의 개발 규칙이나 이미 구현된 기능을 뜻하지 않는다.

| **종류** | **메시지 예시** | **첫 결과** |
| --- | --- | --- |
| 문의 | “이 API는 왜 409를 반환하나요?” | 근거와 답변 초안 |
| 변경 요청 | “중복 요청일 때 409 대신 기존 값을 반환하게 바꿔 주세요.” | 수정 범위와 테스트 계획 |
| 불명확 | “이 부분 좀 봐 주세요.” | 목적과 기대 동작 확인 질문 |

보고서에는 요약, 확인한 사실과 가설, 파일 경로와 근거, 답변 초안 또는 변경 계획, 위험, 다음 승인 항목을 구분한다. “알 수 없음”을 허용하고 코드에서 찾지 못한 내용을 단정하지 않는다.

## 2 단계별 구현 범위

기능을 한 번에 붙이지 않는다. 가짜 이벤트로 승인 경계가 작동하는 것을 먼저 증명하고, 실제 Slack 연결과 코드 변경 기능을 차례로 더한다.

### 단계 0 로컬 모의 실행

- TypeScript 프로젝트와 NestJS application context 기반 CLI를 만든다. HTTP 서버와 대시보드는 아직 필요 없다.
- 가짜 Slack 이벤트, 작은 샘플 저장소, 고정 응답을 주는 모델 어댑터로 전체 흐름을 실행한다.
- SQLite에 작업 상태와 중복 처리 기록을 저장하고, 로컬 reports 디렉터리에 보고서를 만든다.

**완료 기준:** 인터넷과 실제 토큰 없이 문의, 변경 요청, 불명확 사례를 재현하고 프로그램을 재시작해도 기록이 남는다.

### 단계 1 읽기 전용 조사

- 저장소 경로 허용 목록과 파일 크기 제한을 적용한다. 고정 커밋의 스냅샷을 읽고, 근거에 저장소 ID와 커밋 및 경로와 줄 범위를 기록한다.
- 모델 어댑터는 교체할 수 있게 한다. 실제 AI 서비스 연결은 별도 설정이며, 허용된 데이터만 전달한다.
- Slack 대신 로컬 이벤트 파일로 먼저 조사 품질과 오류 처리를 검증한다.

**완료 기준:** 수정 요청이 들어와도 제품 저장소의 파일이 하나도 바뀌지 않고, 조사 보고서만 생성된다.

### 단계 2 Slack 읽기 연결

이번 개발은 **수신·보관·로컬 확인과 오프라인 검증**까지다. 실환경은 `liveReadEnabled: false`를 기본값으로 두고, 별도로 승인된 계정·워크스페이스·채널 및 회사 데이터 정책을 로컬 설정에 기록한 뒤에만 연결할 수 있게 만든다. 설정을 켜는 행위가 회사 승인 자체를 증명하지는 않는다. 실제 연결, Slack 설치와 권한 발급은 이번 작업에서 실행하지 않는다.

#### 수신부와 조사 경계

- Socket Mode 수신부만 Slack 토큰과 네트워크를 갖는다. Node의 기본 `fetch`·`WebSocket`으로 고정 `auth.test`·`apps.connections.open`·`conversations.replies`와 ACK만 제공하고, 새 SDK 의존성은 추가하지 않는다. 실수신 시작 전 `auth.test` 응답의 workspace가 설정과 다르면 연결을 거부한다. HTTP 서버와 대시보드, Redis는 추가하지 않는다. [토큰 identity 확인](https://docs.slack.dev/reference/methods/auth.test/)
- 기존 조사 worker의 네트워크·child process 차단을 유지한다. 토큰을 조사 worker, fixture 모델, SQLite, 보고서나 오류 메시지에 전달하지 않는다.
- 단계 2 수신 결과는 메시지와 제한된 스레드의 **수집 기록**이다. 모델 분석은 `not_run`과 이유를 표시한다. 실제 메시지를 기존 고정 모델에 넘겨 합성 저장소의 답변을 업무 답변처럼 만들지 않는다.
- 실제 AI와 회사 저장소 연결, 승인 서비스와 실행기는 이 단계에 포함하지 않는다. `ApprovalPort`·`ExecutionPort`는 계속 거부하며, 요청자 답장·소유자 DM·push·PR 어댑터도 비활성화한다.

#### 영속 수신과 ACK

처리 순서는 `프레임 크기·구조 확인 → 허용 workspace/channel·유형 확인 → 최소 이벤트와 중복 키를 SQLite inbox에 commit → ACK → 제한된 스레드 수집·로컬 보고`다. ACK 전에 분석이나 스레드 조회를 기다리지 않는다.

- Socket Mode의 `envelope_id`는 해당 전달의 ACK용이고, Events API의 `event_id`는 이벤트 중복 제거용이다. 같은 이벤트가 다른 envelope로 재전달되어도 inbox·후속 결과는 한 번만 만들고 각 envelope는 ACK한다. [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [Events API 이벤트 필드](https://docs.slack.dev/apis/events-api/)
- 비허용 채널·멘션 없는 새 메시지·봇·자기 메시지·지원하지 않는 이벤트는 작업으로 만들지 않는다. 거부한 본문은 보관하지 않고 ACK하여 불필요한 재전달을 막는다. 허용된 기존 메시지의 편집·삭제는 멘션이 없어도 무효화에 필요한 범위만 처리한다.
- 저장 실패나 inbox 포화로 새 메시지를 보존할 수 없으면 성공 ACK하지 않는다. 편집은 포화 상태에서도 기존 계획 무효화와 최신 요청의 `BLOCKED`·`SLACK_INBOX_FULL`을 commit한 뒤 ACK하고 후속 문맥 수집만 차단한다. 이미 commit한 뒤 ACK가 실패하면 재시작·재전달 시 중복 키를 확인하여 다시 ACK한다.
- 재시작 시 pending inbox를 이어 처리하되 완료 수집을 중복 실행하지 않는다. 프로세스 잠금과 inbox 크기 한도를 두고, 저장 실패·ACK 전후 종료·포화를 실패 테스트로 검증한다.

#### 메시지 revision과 무효화

- 원본 메시지는 `(workspaceId, channelId, messageTs)`로 식별한다. `threadTs`는 스레드 위치이며 원본 식별자를 대신하지 않는다. 최초 작성·편집·삭제의 revision을 비교하여 늦게 온 이벤트가 최신 내용을 되살리지 못하게 한다. timestamp는 Slack 문자열의 정밀도를 보존한다.
- `message_changed`·`message_deleted`, 멘션 제거와 내용 변경은 연결된 기존 작업을 `CANCELLED`로 만들고 기존 계획·보고 자료를 제거한다. 승인 기능이 붙기 전에도 오래된 계획이 유효한 결과로 남지 않게 한다. [편집 이벤트](https://docs.slack.dev/reference/events/message/message_changed/), [삭제 이벤트](https://docs.slack.dev/reference/events/message/message_deleted/)
- 같은 스레드의 다른 reply가 편집·삭제되면 확인된 cached·pending·진행 중 문맥과 연결된 기존 작업도 무효화한다. root를 알 수 없으면 같은 채널의 `RECEIVED`이면서 pending·processing인 수집을 보수적으로 차단하며, 관련성이 확인되지 않은 완료 수집은 유지한다. 이 때문에 무관한 진행 중 수집도 중단될 수 있다. 큐가 가득 차도 삭제·멘션 제거와 편집의 기존 계획 무효화는 반영한다. 보고서 파일은 DB의 취소 상태로 다시 쓰며, 쓰기 중 종료되면 다음 명령에서 복구한다.
- 삭제·멘션 제거가 원문보다 먼저 도착해도 필요한 최소 tombstone을 남겨 오래된 원문을 거부한다. 변경 전 revision으로 시작한 스레드 수집의 늦은 결과도 최신 기록을 덮어쓰지 못하게 한다.
- 마스킹한 본문·스레드 payload는 보관 기한 후 제거하되 이벤트 중복 키, 메시지 identity·revision과 삭제 marker는 DB 수명 동안 유지한다. 만료 뒤 같은 이벤트가 재전달되어도 본문을 되살리지 않는다. 최소 marker까지 삭제하거나 DB를 교체한 뒤에는 과거 이벤트의 중복 제거·순서 보존을 보장하지 않는다.

#### 문맥·개인정보·운영 한도

- 스레드는 허용된 채널과 해당 thread만 조회한다. 페이지 수, 메시지 수, 본문·응답 바이트, 요청 시간과 재시도 횟수에 상한을 둔다. 한도·권한 부족·오류로 중단하면 불완전 수집임을 로컬 결과에 남긴다. [스레드 조회와 cursor](https://docs.slack.dev/reference/methods/conversations.replies/)
- `429`의 `Retry-After`를 지키고 무한 재시도를 하지 않는다. 허용된 대기 한도보다 길거나 헤더가 잘못되면 안전하게 중단하여 사유를 기록한다. [Slack 속도 제한](https://docs.slack.dev/apis/web-api/rate-limits/)
- 재연결에는 횟수·대기 한도를 둔다. 최근 100개 연결·공백 상태를 DB에 보관하고 disconnect부터 재연결까지는 누락 가능 구간으로 기록하며 전량 수집을 주장하지 않는다. 채널 전체 history를 자동 backfill하지 않는다. 종료 시 HTTP·대기·Socket·후속 작업을 취소·정리한 뒤 DB를 닫는다.
- 알려진 비밀 패턴과 이메일·전화번호 등 지원하는 개인정보 패턴을 저장 전에 마스킹한다. 원문 프레임 전체나 불필요한 blocks·첨부파일은 보관하지 않는다. 패턴 마스킹을 모든 개인정보 판별이나 회사 정책 준수 검증으로 설명하지 않는다.
- 마스킹한 메시지·스레드의 보관 기간은 `retentionHours` 1~168시간, 기본 24시간으로 제한하고 수신·조회·정리 시 만료 payload를 제거한다. 최소 marker는 계속 남으므로 DB 전체 크기는 보관 기한만으로 제한되지 않는다. 실제 보관 값과 DB 폐기 정책은 회사 정책에 맞추며, 예시 설정값을 운영 정책으로 간주하지 않는다. SQLite의 논리적 삭제는 백업·파일시스템·디스크에서의 물리적 완전 삭제를 보장하지 않는다. 별도로 내보내 저장한 CLI 출력은 사용자의 보관 정책을 따른다.

#### 앱 권한과 연결 전 확인

공개 채널만 사용하는 최소 manifest 예시는 `message.channels`와 `channels:history`를 사용한다. 비공개 채널이 별도로 허용된 경우에만 `message.groups`와 `groups:history`를 추가한다. DM·그룹 DM 이벤트, 쓰기 scope, 자동 채널 참여는 초기 범위에서 제외한다. 사용자 멘션은 message 본문의 고정 ID로 확인한다. [공개 채널 이벤트](https://docs.slack.dev/reference/events/message.channels/), [비공개 채널 이벤트](https://docs.slack.dev/reference/events/message.groups/)

Socket Mode의 app-level 토큰에는 연결용 `connections:write`를 사용한다. 메시지 읽기 토큰과 역할을 구분하고 자격증명을 설정 파일이나 manifest에 넣지 않는다. 설치된 앱의 채널 멤버십, 읽기 토큰 종류·scope와 스레드 API 사용 가능 여부는 승인된 테스트 워크스페이스에서 별도로 검증한다. [연결 scope](https://docs.slack.dev/reference/scopes/connections.write/), [토큰 종류](https://docs.slack.dev/authentication/tokens/)

공식 문서는 2026-11-10에 확인했다. 수신 프로세스의 Node 네트워크 권한은 프로세스 전체에 적용되므로 호스트별 OS 격리로 설명하지 않는다. 어댑터가 고정 Slack HTTPS API, redirect 거부, 정확히 허용한 WSS 호스트 검증으로 목적지를 제한한다. 하네스 자체를 신뢰하는 권한 경계이며 악성 코드 실행 sandbox는 아니다.

**구현 완료 기준:** 합성 프레임과 가짜 네트워크로 아래 수용 테스트 17~26을 통과하고, 단계 1의 무변경·권한 제한을 유지한다. 실제 Slack 수신·토큰 권한·회사 보안 검토는 `not_run`으로 분리한다. 실환경 완료 기준은 별도 승인된 테스트 워크스페이스에서 최소 채널의 수신·편집·삭제·재시도·재연결과 외부 메시지 전송 0을 확인하는 것이다.

### 단계 3 승인 후 코드 변경

승인 기록을 먼저 구현하고 실제 코드 실행은 격리를 검증한 뒤 연다. 단계 3-A를 완료해도 단계 3 전체나 실행기 검증을 완료한 것으로 표시하지 않는다. 실제 Slack·AI·회사 저장소 연결은 어느 하위 단계에도 묵시적으로 포함하지 않는다.

#### 단계 3-A 로컬 승인·취소와 영속 기록

- 순수 TypeScript 승인 규칙과 SQLite `ApprovalRecord`를 추가한다. 승인에는 변경 계획의 불변 스냅샷·해시, 요청 revision, 저장소 ID, 기준 커밋, 소유자, 생성·만료·취소·사용 시각을 묶는다.
- `approve`는 표시된 `planHash`와 `baseCommit`, 필수 유효기간을 받는다. 유효기간은 1~1440분의 정수이며 기본값으로 대신하지 않는다. 소유자는 CLI 옵션이나 Slack ID가 아닌 현재 `process.getuid()`의 `os-user:<uid>`이고, UID를 확인할 수 없는 환경에서는 거부한다.
- 승인 삽입과 `AWAITING_APPROVAL → APPROVED`를 한 트랜잭션으로 처리한다. 같은 작업의 활성 승인은 중복 생성하지 않는다. 만료 승인은 상태 확인 시 취소 기록을 남기고 작업을 `AWAITING_APPROVAL`로 돌린다.
- `cancel`은 `AWAITING_APPROVAL` 또는 `APPROVED`인 변경 요청을 `CANCELLED`로 바꾼다. 요청 편집·삭제에 따른 기존 작업 무효화도 같은 트랜잭션에서 승인을 취소한다. Task의 계획·보고를 제거하더라도 별도 승인 테이블의 불변 스냅샷은 감사용으로 보존한다.
- 현재 승인은 `executionPolicy: approval-only-v1`로 기록한다. `usedAt`은 `null`이며 승인 소비·Run 생성은 구현하지 않는다. 후속 실제 실행 정책의 승인으로 재사용하지 않는다. `ExecutionPort`는 계속 항상 거부하고 `run` 명령은 제공하지 않는다.
- 승인 이력은 DB에 모두 보존하되 CLI에서는 최신순 1개씩 조회한다. `inspect --approval-offset <0..1000000000>`의 기본값은 0이며 `result.approvals`와 `result.approvalPage { offset, total, nextOffset }`로 후속 페이지를 안내한다. 승인·취소 응답도 최신 페이지를 사용하고 worker stdout은 최대 1MiB로 제한한다.
- 승인·취소 CLI는 기존 전역 lease를 사용한다. 같은 데이터 디렉터리의 실시간 Slack 수신 중에는 거부하며, 이 단계에서 동시 수신·실행 조정을 제공한다고 설명하지 않는다.

**완료 기준:** 수용 테스트 27~32를 합성 데이터로 검증하고 단계 1의 대상 무변경, 단계 2의 수신·revision 경계를 유지한다. 승인 생성과 실행 승인의 소비를 구분한다. 실제 격리 실행·대상 코드 변경·대상 검사·외부 전송은 `not_run`이다.

#### 단계 3-B 실제 격리 backend 선정·실증

- 첫 backend는 macOS `darwin/arm64` 호스트와 Docker Desktop Linux `aarch64`, cgroup v2·기본 seccomp로 제한한다. 정확한 Engine·Node 버전과 로컬 이미지 전체 ID, `docker-probe-v1` 정책을 설정에 고정한다. 검증 환경은 Engine 29.4.3과 공식 `node:24.22.2-alpine3.23`의 `sha256:0efee1e068d21f6edcab7fa8c962fc4ecd50d4e28727bc23963379b63ee318ab`다. Node 권한 모델과 worktree를 실행 sandbox로 취급하지 않는다.
- `sandbox-check` 전용 CLI를 만들고 기본 `enabled: false`에서는 Docker 접속을 0회로 유지한다. 활성 설정은 로컬 Unix socket만 받으며 `/usr/local/bin/docker`에 shell 없는 고정 argv와 새 private Docker 설정·최소 환경을 적용한다. image pull·build·설치와 임의 명령·대상 저장소 입력을 제공하지 않는다. 준비·버전·유효 권한·네트워크 검사 실패 시 거부하며 다른 환경으로 대체하지 않는다.
- workspace 한 곳만 마운트하고 읽기 전용 root, nonroot UID, capability 제거, 권한 상승 금지, private IPC·cgroup, 기본 seccomp와 네트워크 차단을 강제한다. host proxy·credential·SSH agent·Docker socket과 이미지의 추가 환경·volume이 유입되지 않도록 확인한다.
- `boundary`, `pids`, `memory`, `timeout`, `output` 5개 고정 probe를 실제 backend에서 실행한다. 합성 보호 파일의 절대경로·symlink·경로 탈출·`/proc/1/root` 접근 실패와 전후 hash, 작업 영역 쓰기의 양성 대조군, TCP·DNS 실패·loopback만 있는 인터페이스, cgroup 한도·실제 PID 생성 거부와 OOM을 확인한다. 실제 호스트 비밀이나 회사 코드·승인 DB를 실험 자료로 사용하지 않는다.
- stdout/stderr 합계·실행 시간·메모리·CPU·PID를 제한한다. 시간·출력 초과 때 Docker CLI와 container 종료를 구분하고 이 진단이 만든 container만 소유권 확인 후 kill·정지 확인·제거한다. detached child의 실제 시작과 코드 137·OOM 아님, 지연 파일 생성이 없는지 검증한다. 생성 응답 불확실 후 단순 부재는 정리 성공으로 인정하지 않는다. CPU는 cgroup quota 값으로 실증하며 성능 벤치마크로 해석하지 않는다.
- `<data-dir>/sandbox-checks/<verificationId>/report.json`에 `passed`·`failed`·`not_run`과 실패 이유를 기록하고 합성 작업물을 보존한다. 결과의 `executionEnabled`는 항상 `false`다. 승인 소비·Run 생성·patch·대상 검사·외부 전송은 연결하지 않는다. 범용 실행기와 실행 작업의 디스크 quota는 단계 3-C 이후에 정한다.

**완료 기준:** 수용 테스트 33을 실제 backend에서 통과하고 backend identity·합성 probe·보호 영역 전후 상태·정지와 제거 근거를 결과 문서에 남긴다. 단순 mock 결과를 실제 격리 실증으로 표시하지 않는다. 검증되지 않은 OS·backend는 차단한다. 성공한 진단 결과도 대상 코드 실행 승인을 대신하지 않는다. Docker daemon·VM·Linux 커널은 신뢰 경계이며 container escape의 완전한 방지나 회사 도입 승인으로 설명하지 않는다.

#### 단계 3-C 고정 합성 patch와 허용 검사

- `execution-plan`·`execution-approve`·`execution-run`·`execution-inspect`를 별도 합성 경로로 구현한다. 기존 조사 Task·기록용 승인과 분리한 `execution.sqlite`에 실행 Task·계획·불변 승인·Run을 저장한다. 실제 AI·Slack 요청·회사 저장소·임의 대상 경로를 연결하지 않는다.
- `src/message.mjs` 한 기존 일반 파일의 고정 `replace`만 지원한다. 원본 파일 해시·허용 파일·정확한 고정 교체 내용을 적용 전에 검증한다. 파일 생성·삭제·이름 변경·실행 비트·symlink·서브모듈은 거부하며 읽기 근거 목록을 수정 허용 범위로 확장하지 않는다. 성공·고의 검사 실패·시간 초과·출력 초과의 합성 fixture를 제공한다.
- registry의 `synthetic-check-v1`·`synthetic-timeout-v1`·`synthetic-output-v1`만 지원한다. 실행 파일·정확한 argv·인자 없음·cwd·환경·네트워크 없음·시간과 자원 한도, `synthetic-execution-v1` 정책·backend identity·설정 해시를 계획 해시에 결합한다. 설정의 `enabled` 변경도 새 계획·승인을 요구한다. 계획·승인은 Docker를 호출하지 않으며 shell·임의 명령은 제공하지 않는다.
- 실행 직전 동결 원본·Git 객체·계획·요청 revision·기준 커밋·설정·실제 backend를 재검증한다. OS 소유자의 새 실행 승인과 TTL 1~1440분을 검증하고 승인 소비·Run 생성·`RUNNING` 전환을 단일 SQLite 트랜잭션으로 처리한다. 단계 3-A의 `approval-only-v1` 기록은 사용하지 않는다. task당 Run은 최대 하나이며 실패 후에도 소비를 되돌리지 않는다.
- 동결 원본에서 공유 Git 메타데이터가 없는 독립 Git 작업 트리를 재생성하고 승인 patch를 적용한다. container에는 Git 없는 읽기 전용 view만 마운트한다. 쓰기는 16MiB `/tmp` tmpfs로 한정하며 nonroot·읽기 전용 root·네트워크 없음·seccomp·권한 상승 금지와 메모리 128MiB·swap 0·PID 64·CPU 0.5개·시간 3초·출력 16KiB를 강제한다. 파일 수 16·내용 64KiB 한도를 적용한다. 설치·검사 설정 변경·image pull·다른 backend 대체는 제공하지 않는다.
- 실제 diff와 원본 전후 해시, 검사별 `passed`·`failed`·`not_run`, 명령 종료·정지·제거를 Run과 로컬 보고서에 저장한다. 원시 명령 출력은 저장하지 않고 관찰한 바이트 수·해시만 남긴다. SQLite에서 누락된 완료 보고서를 재생성하고 승인 이력은 최신 한 건씩 조회한다. 자동 commit·push·작업물 삭제는 하지 않는다.

**완료 기준:** 수용 테스트 06~13과 34~35를 합성 저장소에서 통과한다. 승인 없음·만료·재사용·계획/커밋/revision/정책 변경·범위 초과는 파일 변경 또는 검사 시작 전에 차단한다.

**후속 보완:** 실행 중 합성 요청 변경·소유자 취소·controller crash 경합은 아래 3-D에서 처리한다. 실시간 Slack 수신과 실행은 계속 전역 lease로 직렬화한다. 3-C 당시의 검증·한계는 [3-C 결과](stage-3c-result.md)에 보존한다.

#### 단계 3-D 실행 취소·복구·diff 보고

- `execution-cancel`·`execution-invalidate`·`execution-recover`를 합성 전용으로 제공한다. `synthetic:<task-id>`와 초기 revision 1·generation 0을 저장하고, OS 소유자·이벤트 중복·다른 payload·오래된 revision을 검증한다. 편집·삭제는 정수 revision 2~1000000000을 받는다. 요청 무효화·미소비 승인 revoke·대기 Task 취소를 한 트랜잭션으로 처리하고 승인 생성·소비·Run 종료에서 같은 fence를 확인한다.
- 승인 소비와 `claimed` lifecycle을 원자 저장한다. 생성 RPC 전에 container 이름·소유 토큰·Run ID를 기록하고 생성 뒤 전체 ID를 추가한다. 작업 영역 경로와 계획/Git/view 해시, 중간 diff·검사·명령 결과도 영속한다. 제어 이벤트와 순번 lifecycle 이력은 추가 전용으로 보존한다.
- 파일 작업은 짧은 DB guard로, Docker create/start의 실제 CLI spawn은 동기 dispatch gate로 취소 commit과 직렬화한다. RPC 완료는 잠금 밖에서 기다리며 이미 전달된 RPC는 소유권을 확인해 정리한다. controller는 실행 중 제어를 polling으로 감지하고 새 동작을 차단한다.
- 승인 소비 전후·patch 중·검사 중의 종료를 명시적 `execution-recover`로 조사한다. 이름·토큰·Run label·전체 ID가 일치하는 자기 container만 정지·제거한다. 확인된 취소는 `CANCELLED`, 중단은 `INTERRUPTED`, 정리·관찰 미확인은 `BLOCKED`다. 과거 3-C의 미완 Run에 소유 정보가 없으면 `legacy_untracked`로 보존하고 추측해 kill하지 않는다. 이미 `BLOCKED`인 Run의 재조사는 기존 Run을 유지하고 lifecycle 근거만 갱신한다.
- 새 프로세스에서 영속 증거로 부분 파일·추적/미추적 변경·삭제·권한·Git·실행 view를 관찰하고 검사별 `passed`·`failed`·`not_run`을 보고한다. 예상 밖 파일의 본문·원래 이름은 노출하지 않는다. `execution-inspect`는 단일 DB snapshot을 읽은 뒤 보고서 I/O를 수행한다. 승인 소비 복원·자동 재실행·commit·push·작업물 삭제는 없다.
- 취소·무효화·조회만 전역 lease를 우회해 짧은 실행 DB 트랜잭션을 사용한다. 계획·승인·실행·복구는 기존 lease를 유지해 실시간 Slack 수신과 직렬화한다. 실제 Slack Task는 합성 실행에 연결하지 않으며 수신 공백의 변경 감지도 보장하지 않는다.

**완료 기준:** 수용 테스트 14~16과 36을 통과하고 실패·취소·재시작 뒤에도 승인 기록과 잔여 diff가 보존된다. 단계 3 전체 완료는 3-A~3-D의 구현과 격리 실증을 모두 확인한 뒤 판단한다.

**검증 상태:** 합성 단위·통합·CLI와 실제 child-process 강제 종료를 포함한 최종 회귀 271개, 실제 Docker의 정상·3종 제어·SIGKILL 복구·설정 오류 후 재조사 6개 시나리오가 통과했다. lint·typecheck·build와 수용 기준의 구체적인 `passed`·`failed`·`not_run` 근거는 [3-D 결과](stage-3d-result.md)를 따른다. 이 판정은 고정 합성 범위에 한정하며 회사 자료·실제 Slack 요청 실행의 승인을 뜻하지 않는다.

### 단계 4 선택 확장

안정화 후에만 요청자 답장, 대상 저장소의 작업 브랜치·commit 준비·push, 회사 Gmail과 Calendar와 Drive를 각각 독립 기능으로 검토한다. 인증, 데이터 범위, 전송 대상, 승인 방식을 기능별로 정의한다. PR 생성은 후속 범위에서도 제외하며 GitLab MR 생성으로 대체하지 않는다. 초기 MVP를 완성하기 위한 필수 조건은 아니다.

#### 단계 4-A 합성 답장 계획·별도 승인·모의 전송

2026-11-11에 사용자가 권장 정책과 이 단계의 구현을 승인했다. 이는 하네스 기능의 개발 범위이며 실제 Slack 메시지 전송이나 회사 자료 처리의 승인이 아니다. 단계 0·1을 첫 범위로 정한 지침은 유지하고, 이 후속 요청만 합성 모의 전송으로 확장한다.

**목적과 데이터 흐름:** 고정 합성 요청과 일반 텍스트 답장 요약으로 계획을 만든 뒤, 로컬 소유자가 대상·본문·계획 해시를 검토하고 전송 전용 승인을 내린다. SQLite에서 승인 소비와 전송 시도를 원자 저장한 뒤 가짜 어댑터를 한 번 호출한다. 실제 Slack 수신 기록, 조사 Task, 모델 출력과 제품 저장소를 입력으로 연결하지 않는다.

```text
reply-plan → 고정 합성 요청·요약·원래 스레드 → AWAITING_APPROVAL / BLOCKED
reply-inspect → 대상·유효 본문·planHash·상태·승인/시도 이력 검토
reply-approve → OS 소유자·planHash·TTL·본문/문맥 확인 → APPROVED
reply-send → 동일 조건 재검증 → 승인 소비 + SENDING 시도 원자 commit
  → 가짜 어댑터 → SIMULATED / FAILED(NOT_SENT) / UNKNOWN
reply-cancel / reply-invalidate → 무효화·미소비 승인 취소
reply-recover → 남은 SENDING을 UNKNOWN으로 확정, 재전송 없음
reply-prune / 각 명령 시작 → 만료 본문·설정된 감사 기록 정리
```

**채택한 정책:**

| 항목 | 단계 4-A 기준 |
| --- | --- |
| 대상 | 합성 `W_LOCAL`·`C_ALLOWED`에서 원래 요청의 스레드에 단건 답장만 허용한다. 다른 채널·DM·임의 수신자는 입력으로 열지 않는다. |
| 본문 | 코드에 고정한 일반 텍스트 요약만 사용한다. 임의 본문·회사 자료·모델 출력·코드 전문·첨부·알림 멘션은 입력으로 받지 않는다. |
| 승인 | `process.getuid()`의 `os-user:<uid>`가 정확한 `planHash`와 필수 TTL 1~60분을 제출한다. 기본 TTL은 없고 권장값은 30분이다. 승인 만료는 본문과 원문 문맥의 유효기한을 넘지 못한다. |
| 문맥 | 대상·본문·요청 revision·문맥 revision 변경은 기존 승인을 무효화한다. 새 reply는 재검토하며 불완전 수집·수신 공백·만료·최신 여부 미확인은 승인과 전송을 차단한다. 4-A는 이를 합성 이벤트로 검증하며 실제 Slack 최신성은 보장하지 않는다. |
| 재시도 | 자동 재시도는 없다. 확실한 미전송은 시도 `NOT_SENT`·Task `FAILED`로 남기며 새 승인 후에만 수동 재시도할 수 있다. `UNKNOWN`과 중단된 `SENDING`은 재전송하지 않는다. |
| 보관 | 본문은 기본 24시간(`bodyRetentionHours` 1~168)이며 source의 생성 후 24시간 기한과 비교해 짧은 기한 뒤 제거한다. 감사 보관은 별도 `auditRetentionDays`로 정하며, 미지정 `null`은 합성 감사 metadata를 DB 수명 동안 보관한다. 1~3650일을 명시하면 terminal 작업의 마지막 상태 갱신부터 해당 기간 뒤 기록을 제거하되 최소 task ID·계획 해시 중복 marker는 DB 수명 동안 남긴다. 이 기본값은 회사 운영 보관 정책이 아니다. |

**계획과 승인 계약:** `ReplyPlan`에 합성 정책 `synthetic-reply-v1`·`mode: mock`, 소유자, 원래 요청 identity와 요청/문맥 revision·완전성·공백·만료, 정확한 목적지, 본문 해시·바이트 수, 생성·만료 시각과 보관 정책을 묶는다. 본문은 별도 만료 payload에만 저장하고 승인 snapshot·전송 시도·로컬 영속 보고서에 복제하지 않는다. `reply-plan`·`reply-inspect`만 유효 본문을 stdout에 표시하며 사용자가 redirect한 출력은 사용자의 보관 정책을 따른다. 승인 snapshot은 본문 없는 불변 계획이다. 기존 코드 변경 승인과 실행 승인을 전송에 재사용하지 않는다.

**상태·중복·복구 계약:** 별도 `replies.sqlite`에서 Task·계획 metadata·만료 본문·승인·시도·제어 이벤트·최소 중복 marker를 관리한다. 승인 삽입과 `APPROVED`, 승인 1회 소비와 `SENDING` 전환/시도 생성은 각각 한 트랜잭션이다. 취소·편집·삭제·새 reply·공백·불완전·만료는 generation fence와 요청/문맥 revision으로 오래된 승인을 차단한다. 같은 제어 이벤트 ID·payload는 멱등 처리하고 다른 payload 재사용은 거부한다. 완료한 전송 결과를 늦은 제어 이벤트로 다시 열지 않는다. 가짜 어댑터의 불확실한 결과·예외는 `UNKNOWN`으로 남긴다. 프로세스가 `SENDING`에서 중단되면 유효 문맥 동안 상태를 유지하고 명시적 복구로 `UNKNOWN`을 확정한다. 별도 만료·무효화도 진행 중 시도를 `UNKNOWN`으로 막는다. 승인 소비는 되돌리지 않으며 시작 시 자동 전송·복구 호출·재전송을 하지 않는다. 모든 `reply-*` 명령은 기존 전역 lease를 사용하며 실제 Slack 수신과 동시에 동작하지 않는다.

**보관 실행과 한계:** 시작과 각 답장 명령에서 만료 자료를 정리하며 `reply-prune`을 수동 실행할 수 있다. 프로그램이 멈춰 있는 동안에는 다음 실행까지 만료 본문이 DB에 남을 수 있다. SQLite 논리 삭제는 백업·파일시스템·디스크의 물리적 완전 삭제를 보장하지 않는다. 감사 보관 기한을 설정해도 진행 중 작업은 삭제하지 않고, 최소 중복 marker와 DB 폐기 정책은 별도로 관리한다.

**완료 기준:** 수용 테스트 15·16과 37~44를 합성 데이터로 검증한다. 계획·승인·전송·취소·무효화·복구·정리 명령과 경계 실패를 검증하고, 네트워크·실제 Slack 쓰기·제품 파일 변경·Git 원격 작업이 0인지 확인한다. 실제 Slack 토큰·전송·AI·회사 저장소 연결과 회사 보안 검토는 `not_run`이다.

**검증 상태:** 최종 회귀 301개(기존 271개 + 신규 30개), lint·typecheck·build가 통과했다. 실제 child-process 강제 종료·새 프로세스 복구·동시 승인 소비·본문 보관·제한 worker의 파일/child/TCP 차단 근거와 실제 외부 연결의 `not_run` 범위는 [4-A 결과](stage-4a-result.md)에 기록한다.

#### 단계 4-B-1 오프라인 Slack HTTP 계약 진단

2026-11-11의 후속 요청은 기본 비활성 전송 어댑터와 가짜 HTTP 응답 검증의 구현이다. 실제 토큰·계정·회사 자료·자유 본문·실제 네트워크를 연결하지 않는 범위여서 추가 운영 정책의 결정 없이 진행한다. 단계 4-A의 채택 정책·합성 승인·DB·기존 명령은 보존한다.

**목적과 데이터 흐름:** 실제 Slack 쓰기 API에 사용할 요청 직렬화와 응답 검증을 합성 transport로 진단한다. 이는 단계 3-B의 `sandbox-check`처럼 기능 권한을 만들지 않는 별도 진단이며, 영속 전송 승인 흐름의 확장이 아니다.

```text
slack-post-check → 고정 합성 설정·본문·thread·offline-http intent
  → 기본 disabled 포트: HTTP 호출 0, BLOCKED
  → 진단에서만 합성 HTTP 포트 주입
    → auth.test identity → conversations.replies 문맥 재검증
    → chat.postMessage 요청 JSON·응답 계약 검증
    → OFFLINE_CONFIRMED / NOT_SENT / UNKNOWN / BLOCKED
  → 시나리오별 예상 결과 비교 → 로컬 report.json
```

**권한과 입력 계약:** 새 계약의 정책은 `slack-post-contract-v1`, 진단 모드는 `offline-http`이며 `liveEnabled`는 항상 `false`다. `OfflinePostIntent`는 설정·합성 대상·본문·요청 revision·문맥 hash·유효기한을 묶는 진단 입력이며 생성 후 60초에 만료한다. 이 기한은 소유자 승인 TTL이 아니다. intent는 소유자의 전송 승인이나 승인 소비 기록이 아니며 진단 성공도 실제 전송을 허용하지 않는다. 단계 4-A의 `synthetic-reply-v1`·`mode: mock` 계획/승인과 기존 코드·실행 승인은 이 입력으로 수용하지 않는다. 실제 전송 활성화 옵션, 실제 토큰·설정 파일·대상 ID·본문 입력, 전역 `fetch`를 사용하는 transport는 제공하지 않는다.

**HTTP와 결과 계약:** 고정 합성 workspace/channel/bot/user identity와 원래 스레드·일반 텍스트 본문만 사용한다. `auth.test` identity를 확인한 뒤, 제한된 `conversations.replies` 응답에서 원문 revision·문맥 hash·완전성·새 reply·만료를 다시 확인한다. 조건이 다르면 post 호출 없이 차단한다. `chat.postMessage` 요청은 JSON으로 직렬화하고 알림 멘션·첨부·링크 확장 없이 고정한 스레드의 일반 텍스트만 담는다. 성공 응답은 channel·message timestamp·thread·bot identity·본문을 대조한 뒤 `OFFLINE_CONFIRMED`로 기록한다. 확실한 거부는 `NOT_SENT`, post 이후 timeout·서버 오류·잘못된 응답·receipt 불일치는 `UNKNOWN`으로 처리한다. 모든 결과에서 자동 재시도는 0회다. 요청 제한은 250ms, 응답은 16KiB이며 redirect를 거부한다. 이 시간·크기는 오프라인 진단 한도이며 실제 운영 한도가 아니다.

**CLI와 보관:** `slack-post-check [--fixture all|success|disabled|auth-mismatch|source-changed|new-reply|incomplete|expired|denied|rate-limited|server-error|timeout|malformed|oversized|receipt-mismatch|redirect] [--data-dir <private-directory>]`를 제공한다. 기본 fixture는 `all`이다. 예상한 차단·오류도 시나리오의 기대 결과와 일치하면 진단 `passed`이며, 전체 통과 시 CLI 종료 코드는 0이다. `<data-dir>/slack-post-checks/<verificationId>/report.json`에 `passed`·`failed`·`not_run`과 정적 원인을 남긴다. 본문·토큰·원시 HTTP 요청/응답·원시 오류는 stdout과 보고서에 넣지 않는다. 합성 token은 메모리에서 가짜 요청 직렬화 검증에만 사용한다. 보고서는 이 진단이 새로 만든 파일이며 기존 승인 DB를 열거나 변경하지 않는다.

**실행 경계:** NestJS application context의 별도 제한 worker는 하네스 읽기와 비공개 데이터 디렉터리 쓰기만 허용하고 네트워크·하위 프로세스·추가 worker·외부 native addon 권한을 받지 않는다. 호스트 토큰을 상속하지 않는다. 기본 포트는 합성 포트를 명시적으로 주입하기 전까지 어떤 HTTP 요청도 받지 않는다. 진단용 합성 문맥 재조회는 실제 Slack 최신성·수신과 전송의 원자성·전역 lease 문제를 해결한 것으로 해석하지 않는다.

**완료 기준:** 수용 15·16과 45~51을 검증한다. disabled 호출 0, 기존 승인 재사용 거부, identity·문맥·TTL 실패 시 post 0, 고정 HTTP 직렬화와 receipt 검증, 미전송/불확실 결과·상한·재시도 0, 토큰·본문 비보관, 제한 worker와 기존 흐름의 회귀를 확인한다. 실제 HTTP 전송·Slack 계정/scope·실제 수신 문맥과 경합·실전송 승인 소비·회사 자료/보관 정책은 `not_run`이다. 검증 결과는 [4-B-1 결과](stage-4b1-result.md)를 따른다.

**검증 상태:** 최종 회귀 324개(기존 301개 + 신규 23개), lint·typecheck·build가 통과했다. 15개 합성 HTTP 시나리오와 기본 차단·정밀 timestamp/문맥·직렬화·receipt·제한 worker·기존 DB 불변 근거는 [4-B-1 결과](stage-4b1-result.md)에 기록한다. 이는 실제 전송이나 live 승인 소비 검증을 뜻하지 않는다.

#### 단계 4-B-2 고정 시험 문구의 Slack 단건 전송

2026-11-11의 후속 구현 범위는 개인 테스트 workspace의 공개 채널·원래 스레드 한 곳에 고정 합성 문구를 별도 승인 후 한 번 전송하는 것이다. 실제 대상 ID·자격증명·원문·런타임 DB는 저장소 밖의 비공개 로컬 자료로만 관리한다. 회사 자료, 자유 본문, 모델 답변, 조사 결과와의 자동 연결, DM, 계획에 고정한 대상 외 채널 전송, Git 원격 작업은 이 범위에 포함하지 않는다. 실제 게시 승인은 구현·검증 뒤 구체적인 계획을 검토하는 마지막 단계에서 별도로 받는다.

**목적과 데이터 흐름:**

```text
slack-live-plan → 명시적 활성화·로컬 대상 설정 → auth.test + conversations.replies
  → identity·고정 root 원문·reply 없음·완전성 확인 → 본문 없는 live 계획
slack-live-inspect → 대상·계획 해시·코드의 고정 시험 문구 검토
slack-live-approve → auth + thread 재조회 → OS 소유자·정확한 해시·필수 TTL → 새 승인
slack-live-send → auth + thread 재조회 → 5초 이내 문맥·계획·승인 확인
  → 승인 소비 + SENDING 시도 원자 commit → chat.postMessage 최대 1회
  → SENT / FAILED(NOT_SENT) / UNKNOWN
slack-live-cancel → 미소비 승인 취소
slack-live-recover → 중단된 SENDING을 UNKNOWN으로 확정, 재전송 없음
slack-live-prune / 각 명령 시작 → 만료·terminal 30일 감사 정리, 대상 중복 marker 유지
```

**분리된 권한과 계획:** 새 정책 `slack-live-test-v1`과 별도 `live-replies.sqlite`를 사용한다. 4-A의 mock 계획·승인, 4-B-1의 진단 intent·성공 보고서, 기존 코드/실행 승인은 입력으로 수용하거나 전환하지 않는다. 기본 활성화는 `false`이며 `--live-enabled true`를 명시하고 허가된 대상 identity를 제공해야 네트워크를 사용할 수 있다. 계획은 OS UID 소유자·정책·설정을 포함한 계획 hash·workspace/channel/root·bot/user identity·원문 raw revision·문맥 hash·본문 hash·생성/만료를 결합한다. 계획 유효기간은 최대 24시간이다. 승인은 정확한 계획 해시와 기본값 없는 필수 정수 TTL 1~60분에 묶고 30분을 권장하며 계획 만료를 넘지 못한다.

**고정 입력과 문맥:** 전송 본문은 코드 상수 `하네스 Slack 단건 전송 테스트입니다. (4-B-2)`의 일반 텍스트다. 임의 본문 옵션이나 파일 입력은 제공하지 않는다. 허용 원문은 `하네스 전송 테스트`인 root 메시지 한 개이며 reply가 없어야 한다. plan·approve·send마다 인증과 스레드를 재조회하고 workspace·bot·bot user, root·원문 일치, raw revision·문맥 hash와 완전성을 검증한다. 편집·삭제·새 reply·다른 thread·불완전·만료·identity 변경은 승인 또는 전송을 차단한다. 저장하는 source는 raw revision·문맥 hash·관측 시각·bot identity 등 metadata뿐이며 Slack 원문과 응답 본문을 DB·승인 snapshot·보고서에 저장하지 않는다.

**최신성과 동시성:** 인증·문맥을 확인한 관측 시점이 승인 생성과 전송 claim/POST 시점의 5초 이내여야 한다. 전역 runtime lease로 같은 데이터 디렉터리의 실시간 수신과 live 명령을 직렬화한다. 수신 중에는 live 변경 명령을 실행하지 않으며 이 경로를 이벤트 스트림의 누락 없는 감지로 설명하지 않는다. Slack 조회와 POST는 독립 요청이므로 마지막 확인과 실제 게시 사이의 외부 편집·삭제·새 reply를 원자적으로 막을 수 없다. 5초 이내 재조회는 단건 테스트가 채택하는 제한된 최신성 확인이며 회사 운영의 무경합 보장이 아니다.

**승인 소비와 결과:** 저장소 트랜잭션에서 승인 유효성을 다시 확인하고 `usedAt`·`SENDING` 시도·작업 상태를 함께 commit한 뒤에만 POST한다. 동시 send나 저장 실패로 중복 게시하지 않는다. 고정 channel/thread/plain text·확장 제한으로 요청하고 성공 receipt의 channel·새 message timestamp·thread·bot·본문을 대조한 때만 `SENT`다. 명백한 API 거부·rate limit만 `NOT_SENT`/`FAILED`로 기록하고 새 승인으로 수동 재시도한다. POST 이후 timeout·서버 오류·redirect·잘못되거나 큰 응답·receipt 불일치는 `UNKNOWN`이며 자동 재시도는 없다. `SENDING` 중단 복구는 `UNKNOWN`으로 확정하고 소비 승인을 되돌리지 않는다. `SENT`·`UNKNOWN`은 workspace/channel/root 대상 키의 최소 marker를 DB 수명 동안 유지해 다른 작업 ID의 새 plan·승인·전송까지 차단한다. timestamp의 선행 0·소수부 뒤 0처럼 같은 값을 나타내는 표현도 같은 대상 키로 처리하되 source revision 원문 문자열은 보존한다.

**네트워크와 자격증명:** 실제 transport는 고정 `auth.test`·`conversations.replies`·`chat.postMessage`만 허용하고 요청 10초·응답 32KiB, redirect 거부·자동 재시도 0을 강제한다. `SLACK_SEND_TOKEN` 환경 주입 또는 TTY 숨김 입력만 받으며 token을 CLI 인자·설정·DB·보고서·로그에 기록하지 않는다. plan·approve·send의 제한 worker만 필요한 token·네트워크를 받고 inspect/list/cancel/recover/prune은 받지 않는다. Node 권한과 어댑터의 고정 URL 검증을 함께 적용하되 호스트별 OS 네트워크 격리로 주장하지 않는다. 실행 환경의 같은 OS 사용자·호스트 신뢰 가정은 유지한다.

**보관과 게시 후 처리:** 고정 전송 본문도 DB에 복제하지 않고 유효한 계획에 한해 코드 상수로 재구성해 검토한다. terminal 감사 metadata는 마지막 상태 변경 후 30일에 정리하고 `SENT`·`UNKNOWN` 대상 중복 marker는 남긴다. 정리는 명령 실행 시 수행하므로 정지 중 자료는 다음 실행까지 남을 수 있다. SQLite 논리 삭제는 디스크·백업의 완전 삭제를 보장하지 않는다. 게시 메시지는 Slack workspace의 보관 정책을 따르며 자동 수정·삭제 API는 제공하지 않는다.

**완료 기준과 상태:** 수용 52~61의 구현·합성 검증을 완료했다. 최종 회귀 367개(기존 324개 + 신규 43개: store/service 18개·adapter 15개·CLI 10개), lint·typecheck·build와 diff 검사가 통과했다. 실패·건너뜀은 0개다. 상세 근거는 [4-B-2 결과](stage-4b2-result.md)에 기록한다. 수용 62도 개인 테스트 workspace에서 실제 계획 생성·별도 승인·단건 게시 후 통과했다. 로컬 작업과 시도 한 개의 `SENT`, 승인 소비 한 번, 원래 Slack 스레드의 댓글 한 개·고정 본문·receipt 일치를 확인했다. 실제 회사 보안 검토·업무 자료·AI·자동 업무 답장은 `not_run`이다.

#### 단계 4-C-1 오프라인 브랜치 계획·승인·모의 검증

2026-11-12의 구현 범위는 **하네스가 Codex에 맡길 대상 저장소 작업의 브랜치 계약을 합성 자료로 검증하는 것**이다. 실제 Codex·모델·회사 GitLab·제품 저장소를 연결하지 않는다. 실제 브랜치 생성·파일 수정·commit·push·PR/MR은 수행하지 않는다. 현재 하네스 저장소 자체의 개발 브랜치 규칙을 바꾸는 기능도 아니다.

```text
branch-plan --type <feature|fix|chore|refactor> → 고정 합성 source·작업 브랜치·계획 hash → AWAITING_APPROVAL
branch-approve → OS 소유자·정확한 계획 hash·필수 TTL 검증 → APPROVED
branch-simulate → 유효 승인 소비 + SIMULATING 시도 원자 저장 → 고정 모의 adapter
  → SIMULATED / FAILED(NOT_CREATED) / UNKNOWN
branch-cancel / branch-invalidate → 승인 취소·요청 revision 무효화
branch-inspect → 영속 상태 조회, 중단된 SIMULATING 자동 재개 없음
branch-recover → 중단된 SIMULATING을 UNKNOWN으로 확정
```

- `synthetic-branch-v1`·`mode: offline`·`operation: simulate-branch`와 별도 `branches.sqlite`를 사용한다. 기존 조사·실행·답장·live DB와 승인을 재사용하지 않는다. 작업 유형은 필수 입력이고 브랜치는 `<type>/synthetic-<task-id>`로 생성한 **계획 문자열**이다.
- 계획 해시에 OS UID 소유자·정책·작업 유형·fixture·브랜치명·고정 합성 repo/remote·기준 브랜치와 커밋·요청 revision·허용 파일·diff hash·생성/만료를 결합한다. source의 `gitlab.example.invalid` 원격과 커밋·diff hash는 고정 합성 식별자료이며 실제 조회·실행 증거가 아니다. 실제 경로·원격·본문·명령·모델 JSON을 입력으로 받지 않는다.
- fixture는 `success`, `collision`, `source-changed`, `unknown`이다. 기준 변경은 초기 `BLOCKED`로 승인 전 차단하고, 충돌은 모의 시도 `NOT_CREATED`와 작업 `FAILED`, 불확실 결과는 `UNKNOWN`으로 구분한다. 성공은 `SIMULATED`이며 실제 브랜치가 생성되었다고 표시하지 않는다.
- 계획은 24시간 유효하다. 승인은 정확한 planHash와 기본값 없는 필수 정수 TTL 1~60분에 결합하고 계획 만료를 넘지 않는다. OS UID 미지원·다른 소유자·만료·변조·활성 중복 승인은 거부한다. 승인 만료는 취소 이력을 남기고 `AWAITING_APPROVAL`, 계획 만료는 `BLOCKED`로 조정한다.
- 승인 소비·`SIMULATING` 시도 생성·작업 전환은 한 SQLite 트랜잭션이다. 작업당 시도는 최대 한 번이고 저장 실패 시 모의 adapter를 호출하지 않는다. 실패·중단 뒤에도 소비 승인을 복원하거나 같은 작업에 재승인·재시도하지 않는다. 입력과 계획을 다시 검토한 별도 합성 작업만 만들 수 있다.
- 합성 제어는 `edited`, `deleted`, `base-changed`, `diff-changed`, `branch-conflict`와 소유자 취소다. 같은 event ID/payload는 멱등, 다른 payload 재사용은 거부, 오래된 revision은 무시한다. 대기 작업 무효화와 미소비 승인 취소를 함께 저장한다. 진행 중 제어는 시도를 `UNKNOWN`으로 확정하며 늦은 성공으로 덮어쓰지 않는다. 완료된 결과는 보존한다.
- 시작·조회는 `SIMULATING`을 그대로 보존하며 자동으로 실행하지 않는다. 명시적 `branch-recover`로 중단 상태를 `UNKNOWN`으로 확정하고 반복 복구는 멱등이다. 합성 metadata와 승인 snapshot·제어 이력·모의 receipt는 DB 수명 동안 보관한다. 이번 단계에는 자동 정리·실제 자료 보관 정책을 추가하지 않는다.
- 모든 명령은 전역 lease와 비공개 DB/sidecar의 경로·소유자·권한·symlink/hardlink 검사를 사용한다. NestJS application context의 제한 worker는 하네스 읽기와 비공개 데이터 디렉터리 쓰기만 허용하고 네트워크·child process·추가 worker·호스트 토큰을 차단한다. 같은 OS 사용자와 신뢰하는 하네스 코드라는 기존 경계는 유지한다.

**완료 기준:** 아래 수용 63~70과 기존 회귀를 검증한다. 실제 실행 연결과 Git 효과는 `not_run`으로 구분한다. 검사 결과와 한계는 [4-C-1 결과](stage-4c1-result.md)에 기록한다.

**검증 상태:** 최종 회귀 397개(기존 367개 + 신규 30개), lint·typecheck·build가 통과했다. 실제 child 강제 종료·새 프로세스 복구, 원자 소비 경합·rollback과 제한 worker 검증을 포함한다. 실제 Git/Codex 작업은 `not_run`이며 모의 성공을 실제 연결 검증으로 해석하지 않는다.

#### 단계 4-C-2 합성 Git 브랜치 생성·관찰·복구

이번 범위는 **하네스가 새로 준비한 독립 합성 Git 저장소에 작업 유형별 브랜치 ref 하나를 생성하고 보존·충돌·중단 복구를 검증하는 것**이다. 4-C-1의 모의 경로는 유지한다. 회사 저장소·사용자의 기존 저장소·실제 Codex를 입력으로 받지 않는다. checkout·코드 수정·검사 스크립트 실행·작업 결과 commit·push·PR/MR 생성은 제공하지 않는다. fixture를 준비하며 만드는 고정 초기 커밋은 승인 후 작업 결과를 commit하는 기능과 구분한다.

```text
git-branch-plan --type <feature|fix|chore|refactor>
  → 비공개 합성 source/workspace 초기화·소유 manifest·실제 기준 커밋/트리 hash
  → <type>/task-<task-id> 계획 → AWAITING_APPROVAL
git-branch-approve → OS 소유자·hash·TTL·source/workspace·ref 부재 재검증 → APPROVED
git-branch-create → 재검증 → 승인 소비+RUNNING+claimed 원자 저장
  → writing 기록 → 동기 DB guard의 generation 확인·배타적 ref 생성
  → created 기록·전후 관찰 → finished / SUCCEEDED 또는 실패 상태
git-branch-inspect → 저장된 계획·승인·시도 조회, RUNNING 자동 재개 없음
git-branch-cancel → 미소비 승인 취소 또는 RUNNING의 generation fence
git-branch-recover → 소유 작업 영역 관찰 → INTERRUPTED / CANCELLED / BLOCKED
```

- 새 정책 `local-synthetic-branch-v1`·`mode: local-synthetic`·`operation: create-branch`와 별도 `git-branches.sqlite`를 사용한다. 기존 4-C-1 계획·승인·receipt와 조사·실행·Slack 승인을 재사용하지 않는다. 유형과 private data directory 외에 임의 저장소·브랜치·원격·명령·patch 입력은 받지 않는다.
- `<data-dir>/git-branches/<task-id>/`에 소유 manifest와 `source/`, `workspace/`를 배타적으로 준비한다. 두 저장소는 코드에 고정한 합성 파일·작성자·시각·초기 커밋을 각각 생성하며 `.git`·객체·hardlink를 공유하지 않는다. 작업 영역을 기존 저장소에서 복사하지 않고 같은 ID의 기존 경로도 초기화하지 않는다.
- source는 디렉터리 `0555`·파일 `0444`로 동결한다. workspace도 같은 기본 권한을 사용하고 `.git/refs/heads`와 새 유형 디렉터리만 `0700`, 새 ref만 `0600`으로 둔다. `HEAD`와 `main`은 기준 커밋에 유지한다. 승인 후 바뀔 수 있는 것은 계획한 loose ref와 그 유형 디렉터리뿐이다.
- 계획은 작업 유형·브랜치명·OS UID·정확한 작업 root·소유 token·실제 기준 커밋·source/workspace hash·정책·24시간 유효기한에 결합한다. 승인은 정확한 hash와 기본값 없는 정수 TTL 1~60분을 받고 계획 만료를 넘지 않는다. 승인과 생성 직전에 소유·기준·모든 경계와 ref 부재를 확인한다. 같은 OID의 기존 ref도 생성 충돌이며 덮어쓰지 않는다.
- 동기 관찰은 고정된 파일 트리의 경로·소유자·권한·일반 파일·symlink/hardlink·엔트리 수·총 바이트를 먼저 검사한 뒤 제한된 읽기를 수행한다. 예상 밖 파일 이름·본문은 결과에 넣지 않는다. workspace hash에서는 계획한 ref와 선택적인 유형 디렉터리만 제외하며 원래 파일·Git metadata·main·HEAD는 보존해야 한다. 빈 유형 디렉터리는 `absent`, 정확한 ref는 `created`, 부분 파일·다른 OID·검증 실패는 `unsafe`다.
- 승인 소비·`RUNNING`·최초 `claimed` 기록은 원자적이다. `writing` 단계와 `writeStartedAt`을 ref 생성 전에 기록하고, 생성 뒤 `created`·`refCreatedAt`, 완료 뒤 `finishedAt`과 관찰 결과를 보관한다. 짧은 동기 guard 안에서 generation을 다시 확인하고 `wx`에 해당하는 배타적 생성과 `O_SYNC` 동기 쓰기 요청을 수행한다. 제한 worker에서 허용되지 않는 `fsyncSync`를 위해 권한을 넓히지 않는다. 검증 범위는 프로세스 중단 복구이며 디렉터리 fsync나 OS·전원 장애 내구성까지 보장하지 않는다. 작업당 시도는 한 번이며 실패·중단 뒤 소비를 복원하지 않는다.
- 대기 상태 취소는 승인 취소와 `CANCELLED`를 함께 저장한다. `RUNNING` 취소는 먼저 generation fence를 세우고 이미 만든 ref는 유지한다. 명시 복구는 소유 manifest·계획·영속 단계·현재 파일을 대조한다. 정확한 ref가 있더라도 중단을 성공으로 소급하지 않고 `INTERRUPTED`, 취소가 기록되어 있으면 `CANCELLED`, 경계가 불확실하면 `BLOCKED`로 보고한다. 재생성·재시도·수리·ref 삭제는 하지 않는다.
- 모든 CLI 명령은 data directory 전역 lease로 직렬화한다. 실행 중 별도 CLI 취소는 같은 lease와 경합하므로 실시간 인터럽트 기능으로 설명하지 않는다. 제한 worker는 하네스 읽기와 private data directory 쓰기만 받고 네트워크·child·추가 worker·상속 토큰을 받지 않는다. source 동결·소유 확인·Node 권한은 신뢰하는 하네스와 같은 OS 사용자 안의 경계이며 악성 코드용 sandbox가 아니다.
- 합성 repository·계획·승인·시도·관찰 기록은 보존하며 자동 삭제나 보관 만료 정책을 추가하지 않는다. 기존 사용자 작업과 회사 자료는 연결하지 않는다.

**완료:** 아래 수용 71~80을 포함한 전체 회귀 442개와 lint·typecheck·build가 통과했다. [4-C-2 결과](stage-4c2-result.md)에 근거와 한계를 기록했다. 실제 Codex·회사 저장소·코드 변경·작업 결과 commit·원격 작업은 `not_run`으로 분리한다.

#### 단계 4-C-3 합성 작업 브랜치의 수정·검사 연결

4-C-2의 ref 생성과 3-C/D의 고정 변경·Docker 검사·취소·복구를 하나의 새 합성 실행 흐름으로 연결한다. 새 `synthetic-branch-execution-v1` 정책과 `branch-execution.sqlite`, `branch-executions/` 경로를 사용하며 기존 실행·브랜치 정책과 승인은 서로 받지 않는다. 기존 3-C/D와 4-C-2 명령의 계약은 유지한다.

```text
branch-execution-plan --type <feature|fix|chore|refactor>
  → 고정 합성 원본·기준 커밋 → 브랜치/허용 patch/등록 검사/격리 정책 계획
branch-execution-approve → 소유자·계획 hash·기준·정책·TTL 확인
branch-execution-run → 원본/실제 Docker 사전 확인 → 승인 소비+RUNNING 원자 저장
  → workspace_preparing: 독립 Git 초기화·작업 ref 생성·HEAD 선택
  → workspace_ready: Git 증거 확정 → 고정 파일 patch → 실제 diff 확인
  → Git 없는 읽기 전용 view → 등록된 Docker 검사 → 원본·Git·diff 재검증·보고
branch-execution-cancel / invalidate → generation fence·새 동작 차단·소유 container 정리
branch-execution-recover → 저장한 소유권·Git/파일/view 증거로 관찰, 자동 재개 없음
```

- plan은 고정 합성 fixture와 필수 작업 유형만 받는다. `source/`는 기존 고정 파일·작성자·커밋으로 준비한 읽기 전용 원본이다. 승인 전 작업 브랜치 생성·코드 수정·Docker 실행은 하지 않는다. 초기 fixture commit과 작업 결과 commit은 구분한다.
- 계획 hash에 `<type>/task-<task-id>` 브랜치·`main`·예상 HEAD ref·OS 소유자·정확한 source 경로·생성/24시간 만료와 기존 기준 커밋·source hash·정확한 1파일 patch·등록 명령·Docker identity/제한을 결합한다. 승인 TTL은 기본값 없는 정수 1~60분이며 계획 만료 이내다. 실제 기존 저장소·브랜치명·patch·명령·원격 입력은 제공하지 않는다.
- 승인 후 원본과 공유하지 않는 독립 worktree를 준비하고 같은 기준 커밋에서 작업 ref를 배타적으로 생성한 뒤 HEAD를 그 ref로 선택한다. source의 HEAD와 main, 작업 영역의 main을 보존한다. 완성된 Git hash를 최초 workspace 증거로 저장하고 이후 재기준화하지 않는다. 변경 허용 파일은 `src/message.mjs` 하나이며 고정 내용 교체만 지원한다.
- branch 생성과 선택은 `workspace_preparing` 의도 기록 뒤 수행하고 완료된 Git 증거를 `workspace_ready`에 저장한다. 증거 저장 전 중단으로 작업 영역이 불완전하면 보수적으로 `BLOCKED` 처리하고 보존한다. 이후 patch·view·container 생성/시작·검사·최종 관찰의 lifecycle과 변경 결과를 기존 3-D 저장 규칙으로 기록한다.
- 기존 Docker 검사는 계속 Git 없는 읽기 전용 view와 네트워크 없음, 고정 등록 명령·이미지·자원/시간/출력 제한을 사용한다. 고정 patch는 신뢰하는 하네스가 승인된 합성 작업 영역에 적용하며 대상 코드를 호스트에서 import하거나 실행하지 않는다. 모델이나 임의 프로그램에 호스트 쓰기 권한을 주는 기능이 아니다.
- 실행/복구는 전역 lease를 유지하고 inspect/cancel/invalidate는 짧은 DB 트랜잭션으로 실행 중 상태를 관찰·무효화한다. 새 동작과 늦은 성공을 generation으로 차단하며 소유권과 전체 ID가 확인된 자기 container만 종료/제거한다. 소비 승인은 복원하지 않고 작업당 실행은 한 번이다. 파일·ref·diff·보고서는 자동 삭제하지 않는다.
- 보고서는 승인된 브랜치와 실제 Git 검증, 정확한 diff, 검사별 `passed`/`failed`/`not_run`, 원본 보존, container 정리와 중단 관찰을 구분한다. 기존 모의 backend 회귀와 실제 Docker 결과도 분리한다. 실제 Codex·회사 GitLab·회사 자료·작업 결과 commit·push·PR/MR은 연결하지 않는다.

**완료:** 수용 81~90을 포함한 전체 회귀 481개, lint·typecheck·build와 실제 로컬 Docker 격리 진단·실행/취소/강제 종료 복구 12개 시나리오를 통과했다. [4-C-3 결과](stage-4c3-result.md)에 근거와 한계를 기록했다. 실제 Codex 연결 시에는 patch 제안 방식과 격리 공간 직접 수정 방식, 인증·네트워크·자료 전송과 쓰기 권한을 별도 계획으로 확정한다.

#### 단계 4-C-4 Codex 합성 제안과 별도 실행 승인

실제 Codex는 고정 합성 입력으로 JSON 제안 한 건을 반환한다. 하네스가 검증된 결과를 새 실행 계획으로 한 번 옮기고, 소유자가 그 내용을 다시 승인한 뒤 독립 작업 브랜치에 적용한다. 모델 호출 승인과 파일 변경·Docker 검사 승인을 별개로 관리하며 실제 제품 저장소를 Codex에 직접 쓰게 하는 방식은 열지 않는다.

```text
codex-proposal-plan → 고정 합성 입력·모델/인증방식/설정·24h 계획 → AWAITING_APPROVAL
codex-proposal-approve → 단건 전송·모델 호출의 별도 승인
codex-proposal-run → 승인 소비 + RUNNING commit → Codex 격리 진단·단건 호출
  → 정확한 JSON·파일·크기·비밀 패턴 검사 → READY / FAILED
codex-execution-plan → READY를 EXPORTED로 한 번 소비
  → 새 source·브랜치·제안 patch·검사·Docker 정책 계획 → AWAITING_APPROVAL
codex-execution-approve → 제안 내용을 포함한 새 실행 승인
codex-execution-run → 유형별 브랜치 선택·승인 patch·읽기 전용 Docker 검사·diff
각 경로의 cancel / recover → 취소·중단 기록, 자동 재호출·재실행 없음
```

- 호출 계획은 `synthetic-codex-proposal-v1`·`codex-proposals.sqlite`, 실행 계획은 `synthetic-codex-execution-v1`·`codex-execution.sqlite`와 `codex-executions/`로 분리한다. CLI 설정 버전 `codex-cli-proposal-v1`과 출력 검증 버전 `codex-proposal-v1`도 구분한다. 기존 조사·실행·브랜치 승인은 어느 새 경로에서도 사용하지 않는다.
- 전송 입력은 `src/message.mjs`의 `export const message = 'before';`와 줄바꿈을 포함한 고정 합성 코드 및 값을 `approved`로 바꾸라는 요청뿐이다. CLI 계획에 전송할 전체 입력과 hash, 모델·인증 방식·고정 목적지·호출/시간/응답 한도를 표시한다. 회사 자료·임의 본문·추가 파일·명령·저장소 경로는 입력으로 제공하지 않는다.
- 호출 계획 hash에 제안 UUID·OS 소유자·작업 유형·고정 입력 hash·Codex 설정 hash·생성 및 24시간 만료를 묶는다. 승인 TTL은 기본값 없는 정수 1~60분이며 계획 만료 이내다. 승인·호출·내보내기는 같은 설정 hash를 요구하고 호출 직전에 실제 현재 시각으로 승인·계획 만료를 다시 확인한다.
- 호출 승인 소비와 `RUNNING`·단일 attempt를 SQLite 트랜잭션으로 먼저 확정한다. 한 제안은 실패·취소·중단을 포함해 한 번만 호출한다. 취소는 generation을 바꾸어 늦은 응답을 거부하며, 새 프로세스의 inspect는 중단된 `RUNNING`을 유지하고 명시 recover만 `INTERRUPTED`로 확정한다. READY 취소는 저장한 감사 결과를 보존하면서 내보내기를 차단한다.
- 실제 Codex 실행기는 macOS arm64의 native `codex-cli 0.154.0`만 받는다. 절대 canonical 실행 경로·파일 종류·권한·SHA-256을 확인하고 격리된 `--version` 결과도 비교한다. CLI의 `read-only` 설정과 별개로 외부 macOS SBPL profile을 적용하며 호출마다 같은 profile 생성기로 host canary 읽기·영역 밖 쓰기·추가 실행·다른 TCP/Unix socket 거부와 전용 broker 접속을 먼저 진단한다.
- 사용자가 명시적으로 선택한 기존 ChatGPT 로그인 또는 전용 `CODEX_PROPOSAL_API_KEY`는 신뢰하는 부모에서만 읽는다. 기존 로그인은 `~/.codex/auth.json`의 소유자·mode·링크·크기·만료를 검사하고 refresh·복제·설정 변경을 하지 않는다. Codex 자식은 빈 전용 HOME/CODEX_HOME, 최소 환경과 난수 broker capability만 받는다. 기존 사용자 설정·규칙·hooks·MCP·plugins·tools·토큰을 상속하지 않는다.
- localhost broker는 정확한 capability·HTTP 경로·요청 조건을 검사하고 부모가 고정된 upstream body를 새로 구성한다. 승인된 모델·고정 합성 입력·출력 schema와 `tools: []`, `store: false`만 보내며 자식의 도구·본문·주소·자격증명을 전달하지 않는다. API 키는 고정 OpenAI Responses 주소, 기존 로그인은 고정 ChatGPT Codex Responses 주소를 사용한다. redirect와 호출 재시도는 허용하지 않고 upstream 전송은 최대 한 번이다.
- 전체 호출 시간은 60초, 최종 JSON 응답은 16KiB, Codex stdout/stderr 합계는 128KiB, broker 입력 및 upstream 응답은 각각 256KiB로 제한한다. 부모 IPC를 감시하는 별도 guardian이 취소·시간 초과·부모 단절 때 sandbox 자식 프로세스 그룹을 SIGKILL한다. 정상 경로도 자식 close와 broker close를 기다린 뒤 호출 lease를 해제한다. 실제 강제 종료 정리 범위와 제한은 결과 문서에서 구분한다.
- 최종 출력은 정확한 `{path: 'src/message.mjs', content: string}` JSON만 허용한다. 중복/추가 키·잘못된 JSON·다른 경로·빈 내용·8KiB 초과·NUL·잘못된 Unicode·비밀 패턴·원본과 같은 내용은 거부한다. 유효한 응답만 내용과 원시 응답 SHA-256을 저장하며 잘못된 원문·오류 본문·token은 DB와 출력에 남기지 않는다. 내용 검증은 코드의 정확성이나 무해함을 보장하지 않으므로 새 실행 승인을 요구한다.
- Codex JSON 이벤트는 도구 호출·오류·불완전 turn을 거부하고 최종 agent message와 완료 turn을 각각 한 건 요구한다. 지정 모델의 정확한 metadata 부재 경고문만 예외로 허용한다. 이는 fallback metadata를 사용한다는 사실이며 모델 metadata의 완전성·최적 성능·호환성을 확인했다는 뜻이 아니다.
- `codex-execution-plan`은 READY를 `EXPORTED`로 원자 소비하고 같은 UUID를 실행 작업 ID로 사용한다. 내보내기 이후 실행 DB/원본 준비가 중단되어도 READY로 되돌리거나 재사용하지 않는다. 새 실행 계획 hash에 제안 UUID·입력/응답/설정 hash·검증 버전, 실제 patch 전후 hash·내용, 브랜치·기준·source·등록 검사·Docker 정책을 결합하고 새 실행 승인을 받는다.
- 실행은 4-C-3의 독립 Git·source/main 보존·브랜치 충돌 거부·불변 Git 증거·읽기 전용 Docker view·취소·복구를 유지한다. 신뢰하는 하네스가 승인된 한 파일만 쓰고 제안 코드를 호스트에서 import하거나 실행하지 않는다. 실제 Codex 직접 파일 수정·회사 자료/저장소·Slack 요청 연결·작업 결과 commit·push·PR/MR은 범위 밖이다.

**완료:** 수용 91~102를 포함한 전체 회귀 530개(실제 macOS guardian/self-exec 검사 3개 포함), lint·typecheck·build와 기존 ChatGPT 로그인으로 받은 실제 Codex 제안의 새 승인·브랜치 적용·Docker 검사가 통과했다. 모의 취소·중단 복구와 실제 프로세스 정리, 실제 단건 호출은 구분해 기록한다. 모의 adapter, 격리 진단, 실제 호출과 회사 도입 승인을 혼용하지 않으며 최종 결과와 남은 한계는 [4-C-4 결과](stage-4c4-result.md)를 따른다.

#### 단계 4-C-5 합성 다중 파일 읽기 전용 조사

**상태: 오프라인 구현.** 2026-11-12 후속 요청에 따라 신규 조사 계약·합성 reader·별도 승인/DB·격리 모의 worker·보고서·취소/복구/보관을 구현했다. 실제 모델 호출은 요청에서 제외했다. 아래 선택 live 경로는 후속 설계이며 현재 명령에서 사용할 수 없다. 필수 수용 검증과 회귀 결과는 [4-C-5 결과](stage-4c5-result.md)에 별도로 기록한다.

목표는 여러 합성 파일의 필요한 부분을 하나의 검토 가능한 문맥으로 묶고, 승인한 문맥만 모델에 전달하여 파일 근거가 있는 로컬 조사 보고서를 만드는 것이다. 첫 구현은 하네스가 만든 합성 저장소와 고정 응답 모델을 사용한다. 실제 모델을 통한 단건 확인은 오프라인 수용 기준을 통과한 뒤 별도 전송 승인으로 수행하는 선택 검증이다.

```text
합성 fixture·읽기 정책 선택 → 기준 커밋과 허용 파일 검증
  → 읽기 전용 수집·파일 전체 비밀 검사 → 불변 문맥 snapshot
  → 전송할 내용·범위·모델·목적지·한도 계획 → AWAITING_APPROVAL
  → 소유자 승인 → snapshot·현재 정책 재검증 → 승인 소비 + RUNNING
  → 모의 모델 1회 호출 → 구조·근거 검증 → 로컬 조사 보고서
취소·변경·중단 → 기존 승인 무효화·명시적 복구, 자동 재호출 없음
```

##### 읽기·전송·수정 범위

아래 필드는 신규 조사 계약의 구현 필드다. 같은 파일이 여러 목록에 나타나더라도 권한은 각각 검증한다.

| 범위 | 신규 계약 | 이번 단계의 규칙 |
| --- | --- | --- |
| 로컬 읽기 | `readAllowedFiles`와 `readRanges` | 사전 등록된 합성 저장소의 정확한 상대경로와 파일별 줄 범위만 허용한다. wildcard·디렉터리 전체·모델이 추가한 경로는 허용하지 않는다. |
| 모델 전송 | `transferEvidenceIds`와 `inputHash` | 검증된 읽기 근거 중 선택한 항목만 포함한다. 실제 전송 본문을 미리 표시하고 그 바이트의 해시를 승인에 묶는다. 로컬에서 읽었다는 사실만으로 전송하지 않는다. |
| 대상 파일 수정 | `writeAllowedFiles` | 항상 `[]`다. 읽기 근거, 변경 요청, 모델의 수정 제안으로 채우지 않는다. |
| 대상 명령 실행 | `testCommandIds`와 `executionAllowed` | 각각 `[]`와 `false`다. 대상 설치·테스트·빌드·쉘 실행과 브랜치 생성·patch 적용을 제공하지 않는다. |

- 전송 근거 ID는 검증된 snapshot의 근거 ID 집합에 포함되어야 한다. 수정·명령 범위 필드가 누락되거나 비어 있지 않은 값이면 거부하며, 누락을 기본 권한으로 보완하지 않는다.
- 문맥 생성 전의 합성 fixture 준비와 저장소 밖 조사 DB·보고서 쓰기는 대상 수정 권한과 구분한다. fixture 준비가 끝난 시점부터 기준 파일·권한·링크·Git 상태를 동결하고 조사 전후 무변경을 확인한다.
- 로컬 reader는 파일 종류·크기·자격증명 검사를 위해 허용 파일 전체를 읽을 수 있지만 근거·snapshot·모델·보고서에는 승인된 줄만 넣는다. 요청 줄 밖에서 비밀 패턴을 발견해도 파일 전체를 거부하며 원문을 오류나 로그에 남기지 않는다.
- 모델이 추가 문맥을 요청하면 자동으로 파일을 읽거나 두 번째 호출을 하지 않는다. 필요한 자료를 로컬 확인 항목으로 보고하고 새로운 읽기·전송 계획으로 다룬다.
- 변경 요청의 조사 결과에는 수정 후보 경로와 설명을 담을 수 있으나 이는 제안 자료다. `writeAllowedFiles`는 빈 목록을 유지하고 기존 실행 계획으로 내보내지 않는다. 후속 수정 단계에서는 소유자가 변경 파일·기준 커밋·정확한 patch·등록 검사를 새 계획에 명시하고 별도의 실행 승인을 받아야 한다.

**기존 코드와의 차이:** 현재 `src/application/investigate.ts`의 `createChangePlan`은 읽은 `evidence.path`를 `ChangePlan.allowedFiles`로 복사한다. 기존 `src/domain/approval.ts`는 이 구형 키와 비어 있지 않은 목록을 검증하고 해시에 포함한다. 이를 새 `writeAllowedFiles`의 별칭이나 실행 권한으로 해석하지 않는다. 4-C-5는 읽기·전송·수정 범위를 분리한 별도 조사 계약·정책 버전으로 구현하고, 기존 계획 해시·승인 snapshot을 자동 변환하거나 재사용하지 않는다. 기존 조사 경로의 구형 계획은 계속 실행에 연결하지 않는다.

##### 합성 저장소·문맥 수집

- 입력은 등록된 `fixtureId`와 합성 요청 사례로 제한한다. 예시는 controller·service·설정·설명 문서 사이의 호출 흐름을 조사하는 3~5개 파일이다. 임의 로컬 저장소 경로·원격 URL·회사 코드·실제 Slack 본문을 받지 않는다. 부정 사례도 실제 발급 토큰 없이 명백한 가짜 값이나 테스트 실행 중 생성한 합성 패턴으로 만든다.
- 합성 저장소는 별도 임시 경로에서 준비하고 `repoId`, canonical root의 로컬 identity, `baseCommit`, 추적 파일 manifest를 고정한다. reader는 해당 커밋의 내용과 일치하는 파일만 읽는다. 저장되지 않은 변경·추가 파일·커밋 변경·등록되지 않은 저장소는 거부하며 자동 checkout·reset·fetch로 고치지 않는다.
- 경로 정규화, 정확한 allowlist, 비밀 경로 제외, 부모 경로와 파일의 symlink·hardlink·특수 파일 거부, 잘못된 UTF-8·바이너리·제어문자 검사를 적용한다. 검사 후 파일 교체 경합도 열린 파일의 identity와 내용 해시 재검증으로 차단한다. 허용 밖 파일은 합성 준비 단계의 manifest로 변화를 관찰하며 본문을 조사 문맥으로 읽지 않는다.
- 초기 한도는 읽기 파일 최대 8개, 근거 구간 최대 16개, 구간당 최대 200줄, 파일당 최대 32KiB, 전체 근거 본문 최대 64KiB, 요청·지시문·schema를 포함한 직렬화된 모델 입력 최대 128KiB, 최종 모델 JSON 최대 16KiB다. 중복·겹치는 구간은 정규화 후 결정적인 순서로 묶고, 한도를 넘으면 자르거나 파일을 임의로 빼지 않고 계획 생성을 거부한다.
- 각 근거에는 `evidenceId`, `repoId`, `baseCommit`, 상대경로, 시작/끝 줄, 파일 전체 해시, 발췌문 해시와 발췌문을 저장한다. `contextHash`는 순서·정책 버전·파일/줄·근거 내용을 포함한 정규화된 snapshot 전체를 식별한다. 절대 호스트 경로와 불필요한 Git metadata는 모델 입력에서 제외한다.

##### 전송 계획·승인·격리

- 신규 조사 정책은 `synthetic-readonly-investigation-v1`로 분리한다. 기존 고정 입력 제안·실행·Slack·`approval-only-v1` 승인은 받지 않는다. 기존 정책을 느슨하게 만들거나 기존 제안 CLI에 임의 경로 옵션만 추가해 다중 파일 입력을 허용하지 않는다.
- 계획에는 조사 ID, OS 소유자, 합성 요청 ID·revision·본문 hash, repo/기준 커밋/manifest 해시, 읽기 파일·줄, 전송 근거 ID, 빈 수정·명령 범위, 문맥 해시, 실제 입력 해시, 출력 schema 버전, `mock`/`live` 모드, 모델·목적지·인증 방식·설정 해시, 크기/호출 한도, 생성·만료를 포함한다. 인증 비밀 자체는 넣지 않는다.
- 검토 화면은 전송할 지시문·합성 요청·근거·schema와 해당 파일/줄 목록, 모드·모델·목적지·한도를 보여 준다. `planHash`는 이 계획 전체를 묶는다. 계획은 24시간 유효하고 승인 TTL은 기본값 없이 1~60분을 요구하며, 계획과 payload 만료 중 이른 시점을 넘을 수 없다.
- 호출 직전에 소유자·현재 시각·취소 generation·정책/설정·원본 상태·snapshot·전송 본문 해시를 재검증한다. 기준 커밋, 파일 내용/줄, 요청, 모델, 목적지, 한도, 정책 중 하나라도 달라지면 기존 승인을 거부하고 새 계획을 요구한다. 검토한 snapshot에서 전송 본문을 만들며 호출 때 저장소를 다시 읽어 내용을 몰래 바꾸지 않는다.
- 검증된 승인 소비·단일 attempt 생성·`RUNNING` 전환은 SQLite 한 트랜잭션으로 확정한다. 그 뒤 신뢰하는 dispatcher가 취소 여부를 확인하고 최대 한 번 전달한다. 동시에 호출해도 한 번만 소비하며, 실패·timeout·중단·전송 여부 불확실 시 자동 재시도하거나 승인을 복원하지 않는다. 네트워크 전송과 로컬 취소 사이의 외부 경합은 되돌릴 수 있는 것으로 설명하지 않는다.
- reader는 원본 읽기만 수행하고, 모델 worker에는 snapshot 중 전송 승인된 근거로 구성한 입력만 전달한다. 모델에 저장소 탐색·쉘·쓰기 도구와 호스트 인증·설정·hooks·MCP를 제공하지 않는다. 문서와 주석의 지시문은 근거 자료로만 전달한다. 모의 경로는 네트워크 없이 실행한다.
- 선택적인 실제 모델 검증에는 4-C-4의 고정 실행기 identity, 부모 broker 인증, 외부 격리 진단, `tools: []`, 목적지 고정·redirect 금지, 단건 전송·60초 호출·출력/프로세스 한도를 적용한다. broker가 신규 승인 snapshot을 입력으로 구성하도록 별도로 구현·검증해야 하며, 기존 고정 입력 어댑터가 이미 동적 문맥을 지원한다고 가정하지 않는다.

##### 조사 결과·취소·보관

- 출력은 정확한 JSON schema로 분류, 요약, 사실, 가설, 답변 초안, 확인 질문, 수정 방향 제안, 근거 참조를 받는다. 각 사실에는 전달한 `evidenceId`와 그 안의 유효한 줄 범위가 필요하다. 존재하지 않는 파일/근거·범위 밖 줄·중복 키·추가 필드·비밀 패턴·과대 응답·실행용 patch/command 필드는 거부한다. 근거 부족은 확인 불가로 표시한다. 구조·참조 검증이 의미적 정확성까지 증명한다고 주장하지 않는다.
- 문의·변경 요청 모두 로컬 보고서로 끝낸다. 모의 결과는 `mode: mock`을 명시하고 실제 모델 조사로 표시하지 않는다. `READY → EXPORTED`나 `codex-execution-plan` 연결은 없으며 외부 답장·Git 원격 작업도 생성하지 않는다.
- 신규 조사 상태는 `AWAITING_APPROVAL → APPROVED → RUNNING → REPORTED / FAILED / BLOCKED / CANCELLED / INTERRUPTED`로 분리한다. 취소·요청 변경은 generation을 갱신하고 미소비 승인을 폐기한다. 실행 중 늦은 결과는 성공으로 저장하지 않는다. 재시작 시 `RUNNING`을 자동 재호출하지 않고 명시적 복구로 정리·관찰 후 `INTERRUPTED` 또는 불확실한 경우 `BLOCKED`를 기록한다.
- DB·snapshot·보고서는 합성 저장소 밖의 소유자 전용 위치에 둔다(디렉터리 0700, 파일 0600). 승인 snapshot과 감사 이력에는 내용 대신 ID·해시·범위·상태를 저장한다. 모델 입력·발췌·내용을 포함하는 보고서는 payload로 분리해 생성 후 24시간 보관한다. 만료 후 조회·호출·새 계획으로의 재사용을 거부하며 명령 시작과 명시적 정리에서 payload를 제거한다. 멈춰 있는 동안 즉시 삭제되거나 백업까지 물리적으로 지워진다고 주장하지 않는다.
- terminal 감사 metadata는 최초 terminal 전환 시각부터 30일 보관하며 조회·복구로 기한을 연장하지 않는다. 진행 중 기록은 복구 전에 지우지 않는다. 중복 호출 방지를 위한 조사 ID·소비 여부의 최소 marker는 DB 수명 동안 유지한다. 원본 저장소·Git·실패 작업물의 자동 정리는 제공하지 않으며 payload 보관 정리와 구분한다. 일반 로그에는 근거 본문·모델 원문·인증정보·원시 오류를 넣지 않는다.

##### 구현 순서와 완료 판정

1. **계약·fixture·reader:** 신규 조사 타입과 hash, 읽기/전송/빈 수정 범위, 다중 파일 fixture와 결정적인 문맥 snapshot을 구현한다. 기존 읽기 정책의 경로·비밀 검사를 재사용하되 총량·경합·원본 무변경 검증을 추가한다.
2. **계획·승인·모의 조사:** 별도 DB/정책, 검토·승인·단건 호출, 모의 모델의 근거 JSON 검증·로컬 보고, 취소·만료·재시작·정리를 연결한다. 모든 대상 변경·명령·외부 호출이 0인지 확인한다.
3. **회귀·문서:** 수용 103~118을 오프라인으로 검증하고 기존 조사·4-C-4의 호출/실행 승인 분리를 회귀 검사한다. 실제 구현한 CLI만 README에 기록하고 결과 문서에 검사별 `passed`·`failed`·`not_run`을 남긴다. 현재 `readonly-investigation-*` 명령과 허용 옵션은 README에 기록한다.
4. **선택적인 실제 단건 확인:** 앞 단계 통과와 신규 broker/격리 검증 후, 정확한 합성 전송 본문·모델·목적지를 검토한 별도 live 승인으로만 진행한다. 미수행이면 실제 모델 검증을 `not_run`으로 남기며 오프라인 완료와 구분한다. 실제 회사 자료·저장소 연결은 별도 후속 계획이다.

**오프라인 검증 완료:** 신규 53개를 포함한 전체 583개 테스트, lint·typecheck·build가 통과했다. 수용 103~118의 필수 오프라인 경계를 검증했으며 118의 선택 live 실증은 사용자 요청에 따라 `not_run`이다. 상세 근거와 미구현 live broker 범위는 [4-C-5 결과](stage-4c5-result.md)를 따른다.

**오프라인 완료 기준:** 수용 103~118의 필수 모의·로컬 검증 통과, 대상 파일/Git 변경 0, 대상 코드/설치/테스트/빌드 실행 0, 실제 외부 전송 0, 승인된 문맥과 모의 모델이 받은 본문의 정확한 일치다. 기존 530개 통과 기록을 신규 단계의 검증으로 대신하지 않으며 구현 후 실제 회귀 수와 결과를 기록한다.

#### 단계 4-C-6 합성 다중 파일 모델 연결 준비 — 오프라인 검증

**상태: 오프라인 구현.** 2026-11-12 후속 요청에 따라 새 계약·요청 builder·별도 승인/DB·필수 가짜 transport·제한 worker·응답 검증·복구/보관을 구현했다. 실제 모델 호출·인증정보 접근·외부 전송은 실행하지 않는다. 이 단계의 실제 검증 결과는 [4-C-6 결과](stage-4c6-result.md)에 기록하며 4-C-5 수용 118의 선택 live 실증은 별도 후속 범위로 유지한다.

목표는 승인한 합성 문맥을 모델 요청 형식으로 구성하고, 전용 broker가 정확히 그 요청만 가짜 전송기에 최대 한 번 전달하는 흐름을 검증하는 것이다. 여기서 broker는 요청을 검증·구성·전달하는 신뢰하는 중계 계층이며, 이번 구현에 HTTP 서버나 외부 모델 프로세스는 필요하지 않다. 가짜 전송 성공은 실제 모델 연결·추론 품질·공급자 API 호환성의 증거가 아니다.

```text
등록 합성 fixture → 기존 reader로 새 불변 문맥 수집
  → 선택 근거와 조사 schema로 최종 요청 본문 구성
  → 문맥/입력/요청 본문 hash·오프라인 한도 표시 → AWAITING_APPROVAL
  → 새 오프라인 승인 → 원본·본문·현재 정책 재검증
  → 승인 소비 + 단일 attempt + RUNNING 영속화
  → 전용 broker → 가짜 transport 최대 1회
  → 가짜 응답 형식·근거 검증 → 오프라인 로컬 보고서
취소·만료·중단 → 늦은 응답 차단·소비 유지·명시 복구, 자동 재전달 없음
```

##### 포함 범위와 제외 범위

| 구분 | 4-C-6의 범위 |
| --- | --- |
| 읽기 | 4-C-5의 등록 합성 fixture와 `readAllowedFiles`·`readRanges`만 사용한다. 전체 파일 비밀 검사·경로/링크/교체 경합·원본 identity 검증을 유지한다. |
| 전송 | 선택한 `transferEvidenceIds`로 만든 본문을 메모리 또는 제한된 로컬 IPC의 가짜 transport에만 전달한다. 실제 서비스 URL·임의 목적지·외부 DNS/HTTP/TLS 연결은 허용하지 않는다. |
| 수정·명령 | `writeAllowedFiles=[]`, `testCommandIds=[]`, `executionAllowed=false`다. 조사 전 fixture 준비와 저장소 밖 private 상태 기록을 제외하고 원본/Git을 변경하거나 대상 코드를 실행하지 않는다. |
| 인증·모델 | 실제 키·로그인 파일·keychain·환경 토큰을 읽지 않는다. 실제 모델 SDK/CLI 실행·인증 확인·refresh·모델 목록 조회도 제외한다. 필요한 부정 사례는 테스트가 만든 합성 값만 사용한다. |
| 결과 | 오프라인 요청 구성·전달·응답 검증 결과와 로컬 조사 보고서다. 실제 모델 응답, 코드 실행 계획, Slack 답장, commit·push·PR/MR은 만들지 않는다. |

- 이번 단계의 실제 외부 전송은 모든 경로에서 0회여야 한다. transport 누락·잘못된 설정·실패 시 실제 연결로 fallback하지 않고 거부한다. 가짜 transport는 생성 시 필수로 주입하며 새 오프라인 경로에서 실제 transport를 선택할 명령·옵션·환경변수 경로를 제공하지 않는다.
- 4-C-4의 `startCodexBroker`는 transport 기본값이 실제 전송이고 `CodexCliProposal`은 고정 입력·patch schema만 받는다. 이 기본값을 새 경로에 가져오거나 기존 입력 제한을 해제하지 않는다. 공유가 필요한 순수 직렬화·검증 함수만 분리하고 기존 동작은 회귀로 확인한다.
- 4-C-5에서 검증된 수집 함수를 재사용해 새 조사 ID·합성 저장소·snapshot을 만든다. 기존 완료 결과나 만료 payload를 새 계획으로 복사하지 않으며, 기존 승인을 데이터 읽기·전달 권한으로 가져오지 않는다.

##### 새 계약과 기존 정책 보존

- 새 정책은 `synthetic-readonly-transport-v1`, 실행 모드는 `offline`, transport 종류는 `fake`로 고정한다. 별도 상태 저장소와 승인 계약을 사용하며 4-C-5의 `synthetic-readonly-investigation-v1`·DB·CLI·해시·승인 snapshot은 자동 변환하지 않는다. Slack·4-C-4 제안/실행 승인도 받지 않는다.
- 현재 `ReadonlyPlan`만 아니라 입력 생성기·출력 parser·보고서·모델 port·service·프로세스 기록까지 `mock`에 고정돼 있다. 새 모드의 타입·검증·해시·기록을 일관되게 정의하며 기존 문자열 제한만 넓혀 연결하지 않는다. 오프라인 응답을 기존 mock 성공이나 live 결과로 기록하지 않는다.
- 오프라인 설정은 등록된 합성 model/profile ID와 `local:readonly-transport` 같은 로컬 논리 목적지, `authentication: none`을 사용한다. 실제 모델명·원격 URL·인증 방식의 선택은 이번 CLI 입력에 추가하지 않는다. 요청 profile은 로컬 직렬화 계약이며 실제 공급자 규격 준수로 표시하지 않는다.
- 향후 live는 별도 정책·계획·설정 해시·승인을 요구하는 후속 계약이다. 이번 단계에서는 미지원/live 모드를 생성·승인·dispatch 전에 거부하는 부정 테스트만 수행한다. offline 계획·승인·소비 marker를 live로 바꾸거나 재사용하는 경로는 없다.

##### 승인할 요청 본문과 해시

- `contextHash`는 수집한 전체 근거 snapshot, `inputHash`는 그중 선택한 근거·합성 요청·지시문·조사 schema를 포함한 직렬화 입력, `requestBodyHash`는 모델 식별자와 요청 옵션까지 감싼 **최종 직렬화 요청 본문의 정확한 바이트**를 식별한다. 같은 이름의 hash로 서로 다른 범위를 표현하지 않는다.
- 신뢰하는 builder가 등록 profile의 모델·지시문·선택 근거·출력 schema와 `tools=[]`, `store=false`, 지원하는 고정 stream 설정을 구성한다. worker나 입력 자료가 주소·모델·도구·schema·추가 본문을 지정해도 승인된 본문을 덮어쓰지 못한다. 변경은 새로운 계획과 승인을 요구한다.
- 요청 객체는 고정된 필드·순서·인코딩으로 직렬화하고 그 바이트를 private payload에 보관한다. 검토 화면에 최종 본문, 세 hash, profile/serializer/schema 버전, 모드·논리 목적지·인증 방식·한도를 표시한다. dispatch 때 다시 serialize하거나 저장소에서 문맥을 새로 읽어 승인 본문을 바꾸지 않는다.
- 새 Plan은 조사 ID·OS 소유자·요청 ID/revision/hash·repo/commit/manifest/로컬 identity hash·읽기 파일/줄·전송 근거 ID·빈 수정/명령 범위·세 hash·profile/model/destination·schema/serializer/policy/config 버전·모드/transport·한도·생성/만료를 `planHash`에 결합한다. 본문·발췌·호스트 절대경로·인증 비밀은 승인 snapshot에 넣지 않는다.
- 계획과 내용 payload의 유효 기간은 생성 후 최대 24시간이며 승인 TTL은 기본값 없이 1~60분을 요구한다. 승인 만료는 계획·payload 만료 중 이른 시각을 넘지 않는다. 소유자·현재 시각·정책/설정·원본·snapshot·세 hash·취소 generation을 전달 직전에 재검증한다.
- 4-C-5의 8파일·16구간·구간당 200줄·파일당 32KiB·총 근거 64KiB·입력 128KiB 한도를 유지한다. JSON escaping/wrapping 뒤 **최종 요청 본문은 256KiB**, 가짜 응답의 전체 envelope/stream은 256KiB, 추출한 최종 조사 JSON은 16KiB로 제한한다. 호출 전체 시간은 60초, fake 전달은 최대 1회, 재시도는 0회다. 경계값은 허용하고 초과는 절단 없이 거부하며 직렬화 전후 바이트를 각각 검사한다.

##### 가짜 전송·응답·격리

- 오프라인 broker는 새 승인과 저장된 최종 본문만 받는다. 가짜 transport가 받은 본문을 바이트 단위로 포착해 표시된 본문 및 `requestBodyHash`와 대조한다. 모델/본문/URL/인증을 worker가 재지정하거나 raw HTTP 요청을 그대로 중계하는 API는 제공하지 않는다.
- 통합 테스트는 정상 단일 JSON 또는 등록 profile의 합성 stream, 지연·timeout·전달 후 오류·불완전 응답·중복 완료·과대 응답을 반환하는 고정 가짜 전송기를 사용한다. 실제 endpoint·모델 CLI·인증에 접근하지 않고 transport 계층의 오류를 재현한다.
- 응답 envelope와 stream은 버전별 정확한 필드·이벤트 목록을 정의한다. 잘못된 UTF-8·JSON·중복/추가 키, 여러 완료/최종 메시지, 실패/불완전 완료, 도구 호출, redirect 지시와 범위 밖 모델/profile을 거부한다. 여러 조각에 걸친 크기 초과와 불완전 마지막 조각도 검사한다. 지원하지 않는 형태를 조용히 무시해 성공으로 만들지 않는다.
- 추출한 조사 JSON은 4-C-5와 같은 사실/가설/질문/제안 구조와 전송된 근거 ID·줄 범위를 검증한다. raw 및 JSON decode 후 비밀 패턴, 허구 경로·미전송 근거·추가 실행 필드를 거부한다. README·코드·요청·가짜 응답의 지시문은 자료이며 추가 읽기·두 번째 전달·도구 실행 권한이 되지 않는다.
- broker·worker 경계를 실제 Node 권한 프로세스로 검사한다. worker에는 승인된 요청 바이트와 실행에 필요한 최소 비밀 없는 metadata만 전달하고 source/DB/credential 경로·사용자 환경을 주지 않는다. 고정된 하네스 모듈 외 파일 읽기, 파일 쓰기, 네트워크, 추가 프로세스/worker·동적 도구를 차단한다. 입력과 출력 크기를 스트리밍 중 제한하고 원시 stderr는 일반 로그에 남기지 않는다.
- 보고서는 `mode: offline`, `transport: fake`, `responseOrigin: synthetic`과 `semanticAccuracyVerified: false`를 표시한다. 실제 모델·외부 전송·실제 인증 접근·공급자 API 호환성 실증은 각각 `not_run` 및 제외 사유를 기록한다. 고정 가짜 응답으로 추론 품질이 검증됐다고 표시하지 않는다.

##### 단일 소비·취소·복구·보관

- 승인 소비·단일 attempt·`RUNNING`을 한 트랜잭션으로 먼저 영속화한다. 전달 예약에는 `planHash`·`inputHash`·`requestBodyHash`·configHash·generation을 묶고 commit 이전 DB 실패는 fake 전달 0회여야 한다. 예약 commit 뒤 중단·실패·전달 여부 불확실은 소비를 유지하며 자동 재시도·승인 복원이 없다.
- 취소·무효화는 generation을 갱신하고 미소비 승인을 폐기한다. 승인 전·claim 전후·전달 직전·응답 중·결과 저장 직전의 경합을 검사한다. 늦은 응답은 성공/본문을 저장하지 못하며 timeout·취소는 fake worker/transport의 종료를 확인한 뒤 결과를 확정한다. 정리를 확인할 수 없으면 `BLOCKED`로 남긴다.
- 재시작은 남은 `RUNNING`을 자동 재개하지 않는다. 명시 recover는 만료되지 않은 payload, 같은 요청 본문 hash, 원본 파일/Git identity와 소유 프로세스/IPC 종료 증거를 재검증한다. 확인된 중단은 `INTERRUPTED`, 원본 변조·만료·누락/부분 종료 기록·살아 있거나 재사용된 PID 등 불확실은 `BLOCKED`로 기록한다. 추측한 PID를 종료하지 않고 과거 전송을 미전송으로 소급하지 않는다.
- 저장소 밖 디렉터리 0700·파일 0600과 DB/sidecar·payload 경로의 링크 보호를 유지한다. 발췌·입력·최종 요청·검증을 통과한 응답/보고서 내용은 계획 생성 후 최대 24시간의 private payload로 분리한다. 거부된 raw 응답·부분 응답은 폐기하고 DB/payload에 저장하지 않으며, 감사에는 정적 오류 코드·크기·상태만 남긴다. inspect·명령 시작·명시 prune에서 만료 내용을 조회·전달·재사용하지 못하게 하고 정리한다.
- 승인/attempt/감사는 본문 없는 ID·범위·해시·상태만 남긴다. 감사는 최초 terminal 전환부터 30일, 최소 조사 ID·소비 marker는 DB 수명 동안 유지한다. inspect/recover로 보관 기한을 늘리지 않으며 진행 중 기록은 복구 전에 삭제하지 않는다. 원본/Git/실패 작업물 자동 삭제와 일반 로그의 원시 요청·응답·credential 노출은 제공하지 않는다.

##### 구현 순서와 오프라인 완료 판정

1. **계약·해시·builder:** 새 offline 타입/정책과 요청 profile, 선택 근거 기반 본문 구성, input/body 해시·한도·정확한 검토 표시를 구현한다. 기존 4-C-5·4-C-4 계약을 바꾸지 않는 테스트를 먼저 둔다.
2. **계획·승인·broker:** 새 상태 저장소와 명시 승인, 원자 소비·단건 전달을 연결한다. 가짜 transport 필수 주입과 실제 transport/credential loader 미연결을 검증한다.
3. **응답·격리·중단:** 가짜 envelope/stream 검증, 제한 worker, 취소/timeout/강제 종료·새 프로세스 복구·보관 테스트를 수행한다. 정상·실패·취소·복구 전후 원본과 Git 무변경을 확인한다.
4. **CLI·회귀·문서:** 실제 구현한 오프라인 명령/필수 옵션만 README에 기록하고 새 수용 119~134와 기존 회귀를 실행한다. 결과 문서에 검사별 `passed`·`failed`·`not_run`과 실제 테스트 수를 남긴다. 현재 `readonly-transport-*` 8개 명령과 허용 옵션은 README에 기록한다.

**오프라인 검증 완료:** 수용 119~134를 포함한 신규 59개와 기존 583개, 전체 642개 테스트가 통과했다(실패 0·skip 0). lint·typecheck·build도 통과했다. 실제 모델·인증정보 접근·외부 전송·공급자 API 호환성 실증은 `not_run`이며 세부 근거는 [4-C-6 결과](stage-4c6-result.md)를 따른다.

**완료 기준:** 수용 119~134 통과, 기존 583개와 신규 테스트의 회귀 통과, lint·typecheck·build 통과, 검토한 최종 본문과 fake transport 입력의 byte/hash 일치, fake 전달 최대 1회·재시도 0회, 실제 모델 호출·실제 인증 접근·외부 전송·대상 수정/명령 실행 0이다. 기존 583개 통과 기록을 새 단계의 검증으로 대신하지 않는다. 실제 모델 연결·회사 저장소·Slack 업무 자료·직접 수정·원격 작업은 완료 조건에 포함하지 않는다.

#### 단계 4-C-7 다중 파일 조사용 실제 모델 연결 준비 — 오프라인 계약 검증

**상태: 오프라인 구현·검증 완료.** 2026-11-12 후속 요청에 따라 새 profile·요청 명세·정책/승인/DB·메모리 가짜 전송기·JSON/SSE 변환·제한 worker·복구/보관과 CLI를 구현했다. 수용 135~150과 전체 726개 테스트가 통과했으며 실제 모델 호출·인증정보 접근·외부 전송은 제외했다. 검사별 근거와 환경 제한을 해소한 재검증 기록은 [4-C-7 결과](stage-4c7-result.md)를 따른다.

목표는 4-C-6의 합성 요청/응답 계약에서 한 단계 나아가, 실제 연결에 사용할 후보 형식의 요청 encoder·HTTP 응답 분류·JSON/SSE decoder를 네트워크 없이 검증하는 것이다. **4-C-6은 합성 JSON/NDJSON의 전달 경계를 검증했고, 4-C-7은 연결 profile과 HTTP 요청 명세 전체의 승인 결합, 공급자 형식 후보의 변환, live 전환 불가를 추가한다.** 인증·실제 목적지·실제 공급자 호환성 검증이 끝난 것으로 표현하지 않는다.

```text
등록 합성 fixture → 새 읽기 전용 문맥 → 전송할 근거 선택
  → 고정 연결 후보 profile + 요청 encoder → 인증정보 없는 HTTP 요청 명세
  → profile/본문/명세 hash와 검토 내용 표시 → 새 오프라인 승인
  → 재검증·단일 소비·전달 예약 → 메모리 가짜 HTTP exchange 최대 1회
  → HTTP 상태/헤더 → JSON 또는 SSE decoder → 조사 schema·근거 검증
  → 오프라인 보고서 + 실제 연결의 미검증 항목, liveReady=false
취소·만료·중단 → 소비 유지·명시 복구, 자동 재전달·인증·live fallback 없음
```

##### 범위와 기존 단계의 보존

| 구분 | 4-C-7의 허용 범위 |
| --- | --- |
| 읽기 | 4-C-5 reader로 새로 준비한 등록 합성 fixture의 `readAllowedFiles`·`readRanges`만 수집한다. 전체 파일 비밀 검사·경로/링크/교체 경합·원본 identity 검증과 수집 한도를 유지한다. 실제 저장소·회사 코드·Slack 본문은 입력받지 않는다. |
| 오프라인 전달 | 선택한 `transferEvidenceIds`와 고정 profile로 구성한 명세를 메모리 가짜 exchange에만 전달한다. 제한 worker IPC는 허용하되 신규 경로에 HTTP 서버·loopback 소켓·DNS·HTTP/TLS 연결은 만들지 않는다. |
| 대상 수정·명령 | `writeAllowedFiles=[]`, `testCommandIds=[]`, `executionAllowed=false`를 계획·승인·보고서에서 유지한다. fixture 준비 이후 원본/Git 무변경이며 대상 설치·테스트·빌드·쉘·브랜치 생성·patch 적용을 제공하지 않는다. |
| 인증 | `authentication=none`으로 고정한다. 실제 키·로그인 파일·keychain·사용자 설정·환경 토큰의 값 조회와 존재 확인, 인증 갱신·인증 시험·모델 목록 조회를 모두 제외한다. 부정 사례는 임시 경로의 합성 canary만 사용한다. |
| 연결 코드 | 순수 profile/encoder/decoder와 fake 전용 broker를 구현한다. 실제 SDK/CLI·fetch transport·credential loader를 신규 경로의 의존 그래프에 연결하지 않는다. |
| 결과 | 합성 조사 보고서와 오프라인 계약 점검 결과다. 실제 모델 응답·실행 계획·Slack 게시·commit·push·PR/MR로 내보내지 않는다. |

- 신규 정책은 `synthetic-readonly-model-preflight-v1`, 실행은 `mode=offline`, `transport=in-memory-fake`, `responseOrigin=synthetic`으로 분리한다. 별도 상태 저장소·승인/attempt namespace를 사용하고 기존 4-C-5/4-C-6 계획·승인·DB·CLI·해시를 변환하지 않는다. 새 문맥을 수집하며 과거 결과나 만료 payload를 복사하지 않는다.
- 4-C-4의 `startCodexBroker`는 실제 전송 기본값·credential 인자·고정 patch schema를 갖는다. 이를 호출·상속하거나 입력 제한을 완화하지 않는다. 로컬 `src/adapters/codex-broker.ts`에 기록된 요청/응답 형태는 후보 계약의 참고 자료로만 사용한다. 네트워크·인증과 분리된 순수 함수만 필요에 따라 재사용하며 구형 계약의 의미와 검증 강도를 보존한다.
- 기존 `synthetic-json-v1`/`synthetic-stream-v1`은 그대로 둔다. 새 후보 JSON/SSE profile은 로컬 계약 버전이며 NDJSON을 SSE로 이름만 바꾸지 않는다. 현재 공급자 API 규격 확인·접속 실증은 수행하지 않고, 실제 서비스 적용 전 별도 검증이 필요함을 기록한다.

##### 연결 후보 profile과 승인할 요청 명세

- 초기 후보는 한 종류의 Responses 형태 계약에 대해 `responses-candidate-json-v1`과 `responses-candidate-sse-v1` 두 가지로 제한한다. 근거가 된 로컬 코드 경로·내용 hash, 지원 필드/이벤트 목록과 금지 형태를 버전 관리한 계약 fixture로 고정한다. 호환되지 않는 형식은 추측해서 보완하지 않는다.
- profile에는 ID/버전, encoder/decoder/schema 버전, 합성 모델 ID, `POST`, 고정 시험 목적지 `https://model.invalid/v1/responses`, 허용 헤더, JSON/SSE 선택, redirect/retry 금지, 크기·시간 한도를 넣는다. 이 URL은 명세 검사용 문자열이며 절대 접속하지 않는다. 실제 endpoint·모델·인증 방식은 후속 live 계약에서 새로 정한다. CLI·환경·자료·worker의 URL/모델/헤더/profile 파일 override를 허용하지 않는다.
- 요청 encoder는 선택 근거·합성 요청·지시문을 `input`으로, 조사 JSON schema를 `text.format`으로 구성하고 `tools=[]`, `store=false`, profile의 고정 `stream` 값을 포함한다. 4-C-4 patch schema나 4-C-6 `responseFormat`을 그대로 전송하지 않는다. 자동 추가 문맥·도구·대화 이력·이전 응답 재사용 필드를 제공하지 않는다.
- 인증 없는 요청 명세는 method·고정 시험 URL·정규화된 비밀 없는 헤더·최종 본문 바이트·redirect/retry 정책을 포함한다. 헤더는 `Content-Type`과 profile에 맞는 `Accept`만 허용하고 Authorization·Cookie·계정 식별자·proxy 인증·임의 헤더를 거부한다. 실제 인증을 흉내 내는 발급 토큰 형태의 fixture나 가짜 Authorization 값도 만들지 않는다.
- `contextHash`는 전체 근거, `inputHash`는 선택 근거·지시문·요청·schema 입력, `requestBodyHash`는 새 encoder가 만든 정확한 본문 바이트다. `connectionProfileHash`는 위 profile과 계약 fixture를, `requestEnvelopeHash`는 method/URL/정규화 헤더/본문 hash/전달 정책을 묶는다. 헤더명 대소문자·정렬·UTF-8 직렬화 규칙을 고정하고 중복 헤더·CR/LF·모호한 URL 표현은 거부한다.
- 검토 화면은 최종 본문과 비밀 없는 명세 전체, 다섯 hash, 읽기/전달/빈 수정 범위, 후보 계약 근거와 한도를 보여 준다. `planHash`는 이 정보와 OS 소유자·요청 revision·원본 identity·정책/config·생성/만료를 결합한다. 승인 후 본문을 재직렬화하거나 profile·헤더를 덧붙이지 않는다. fake에서 포착한 명세와 저장·표시된 명세의 byte/hash 일치를 검증한다.
- 계획/payload는 생성 후 최대 24시간, 승인 TTL은 명시적 1~60분이며 이른 만료를 넘지 않는다. dispatch 직전 현재 시각·소유자·generation·원본·모든 hash·profile/config를 다시 확인한다. 기존 승인 혼용, hash만 재계산한 변조, profile/codec/헤더/목적지 변경은 새 계획과 승인 없이는 거부한다.

##### 가짜 HTTP와 JSON/SSE 변환 검증

- 가짜 exchange는 생성 시 필수 주입하고 승인된 명세와 AbortSignal만 받는다. 구현이 반환하는 것은 합성 HTTP status·headers·바이트 chunk의 비동기 열이다. 요청/응답 헤더 입력은 중복을 보존하는 이름/값 쌍 목록으로 표현하며 CR/LF·개수·바이트와 대소문자를 무시한 중복을 검사한 뒤 명세용으로 정규화한다. worker가 임의 HTTP 요청을 중계하도록 하지 않고 실제 `fetch`, dispatcher, proxy, 네트워크 소켓, credential 공급자로 대체할 기본값·옵션을 두지 않는다.
- HTTP 성공은 등록 profile의 status/content-type·encoding 조건을 모두 통과한 경우만 허용한다. 3xx와 Location은 따라가지 않고 401/403·429/Retry-After·5xx도 정적 오류로 끝낸다. 인증 갱신·대기 후 재시도·다른 모델/목적지 fallback은 모두 0회다. 중복/모순 헤더, 잘못된 MIME, 미지원 압축·charset, body 누락은 거부하며 오류 원문은 저장하지 않는다.
- JSON 후보는 완성 응답 하나에서 완료 상태·합성 모델·허용된 output 구조와 assistant text 한 건만 추출한다. ID 형식과 응답 내부 참조 일관성을 검사하며 응답 ID를 요청 전에 알고 있다고 가정하지 않는다. 도구/함수 호출·refusal·실패/불완전 상태·복수 최종 text·내부 참조 불일치·중복/추가 필드를 거부한다. 허용 metadata는 계약에 명시한 타입/한도만 검사하며 실제 사용량·비용·모델 품질로 해석하지 않는다.
- SSE 후보는 incremental UTF-8 decode와 SSE frame 경계를 따로 검사한다. LF/CRLF, 여러 `data:` 줄, UTF-8/JSON/구분자가 chunk 사이에서 나뉜 경우를 지원한다. 최초 시작 이벤트에서 응답 ID를, 항목 시작에서 항목 ID를 확정한 뒤 후속 event/type·ID·순서·text delta·최종 text의 일치를 확인한다. 알 수 없는 이벤트, 도구 이벤트, ID/순서 불일치, 중복/누락 완료, 완료 뒤 추가 data, 불완전 마지막 frame은 거부한다. 주석·빈 frame은 크기와 개수에 포함한 뒤 무시하고 `[DONE]`은 이 후보 계약에서 미지원으로 거부한다. 재연결·Last-Event-ID는 제공하지 않는다.
- 4-C-6의 근거 64KiB·입력 128KiB·최종 본문 256KiB·전체 응답 body 256KiB·최종 조사 JSON 16KiB·worker stderr 16KiB·전체 60초·전달 최대 1회·재시도 0회를 유지한다. 전달/응답은 최대 55초, 중단/정리는 최대 5초로 나눠 전체 기한 안에 종료한다. 추가로 요청/응답 헤더는 각각 8KiB·16개 이하, 정규화 명세 metadata와 원본 본문 바이트의 합은 272KiB 이하, SSE frame은 64KiB·총 2,048개 이하로 제한한다. 명세 크기 계산에서 본문을 이중 JSON escaping하지 않는다. 주석·빈 frame·미지원 data도 전체 바이트/프레임 한도에 포함하고 초과를 자르지 않는다.
- 추출한 text는 기존 조사 schema와 전달 근거 ID·줄 범위를 다시 검증한다. raw/decoded 비밀 패턴, 허구 인용·추가 실행 필드·과대 JSON을 거부하고 raw/부분/거부 응답은 폐기한다. SSE 조각이 유효해도 최종 envelope·조사 결과·종료 확인 전에는 성공 보고서를 만들지 않는다.

##### 승인·격리·중단·결과의 경계

- 새 승인 소비·단일 attempt·`RUNNING`과 전달 예약을 영속화한 뒤 fake에 전달한다. 예약에 profile/명세 hash까지 결합하고 commit 이전 DB 실패 시 전달 0회를 검증한다. 동시 run, 오류·timeout·예약 후 crash에도 전달 최대 1회·소비 유지·승인 복원 없음이 유지돼야 한다.
- 취소/무효화 generation을 승인·claim·전달·HTTP headers·SSE frame·결과 저장 경계에서 확인한다. AbortSignal로 fake stream을 중단하고 iterator 정리와 worker 종료를 확인한다. abort를 무시하거나 iterator의 `return()`이 끝나지 않는 사례도 검증하며 정리 대기는 최대 5초 뒤 끝낸다. 늦은 chunk/완료/저장으로 결과가 부활하지 않으며 정리를 확인할 수 없으면 `BLOCKED`다. 실제 로컬 부모/worker 강제 종료 뒤 새 CLI recover가 원본·명세/profile hash·소유 프로세스 종료 증거를 확인해 `INTERRUPTED`/`BLOCKED`로 정리하며 재호출하지 않는다.
- 제한 Node worker에는 승인된 요청과 고정 하네스 코드만 제공한다. source/DB/사용자 설정/인증 경로·상속 환경·네트워크·파일 쓰기·추가 프로세스/worker 권한은 주지 않는다. 신규 경로의 import graph와 설정 진입점 검사, 합성 canary 및 금지 API 호출 계수로 실제 transport·credential loader가 호출되지 않음을 확인한다. 실파일·실제 토큰의 존재를 확인하는 검사는 하지 않는다. 이 검증을 실제 모델 프로세스의 OS 격리 실증으로 표시하지 않는다.
- 4-C-6의 private 디렉터리 0700/파일 0600·DB/sidecar 링크 보호·내용 payload 24h·최초 terminal 감사 30일·DB 수명 소비 marker를 새 명세/profile 기록에도 적용한다. 승인/감사에는 본문 없는 ID·범위·hash·상태만 남긴다. inspect/recover로 만료를 연장하지 않고 원본/Git/실패 작업물을 자동 정리하지 않는다.
- 보고서는 `offlineContractVerified`의 검사별 결과, `mode=offline`, `transport=in-memory-fake`, `responseOrigin=synthetic`, `semanticAccuracyVerified=false`, `liveReady=false`를 표시한다. 실제 모델·인증정보 접근·외부 전송·실제 공급자 호환성·live 격리·의미 정확성 검증은 각각 `not_run`과 제외 사유를 기록한다. 후속 연결에 필요한 미검증 항목을 명시하되 준비 점검을 전송 승인이나 실행 가능한 live 설정으로 내보내지 않는다.
- 미래 live는 실제 endpoint/model/인증 방식·전송 본문·격리 환경을 정한 새 정책·계획·승인으로 설계한다. 4-C-7의 mode 변경·승인 승격·결과 export로 열 수 없으며 4-C-5 수용 118의 선택 live 실증도 여전히 별도 범위다.

##### 구현 순서와 오프라인 완료 판정

1. **계약·순수 변환:** 신규 domain/policy에 profile·요청 명세·해시 계약을 정의하고 로컬 참고 근거와 JSON/SSE fixture를 고정한다. 요청 기대 바이트와 응답 기대 결과는 테스트 대상 encoder/decoder로 생성하지 않고 독립적인 golden fixture로 검토한다. 순수 encoder/decoder·HTTP 분류의 정상/부정/한도 테스트를 먼저 만든다. 실제 SDK·새 외부 의존성 설치는 포함하지 않는다.
2. **계획·승인·예행 전달:** 새 application/store/port와 fake 전용 adapter를 연결한다. 기존 reader를 재사용하고 새 요청 명세 검토·승인·원자 소비·명세 포착 일치를 검사한다. 기존 CLI·정책·승인과 상호 재사용을 거부한다.
3. **제한 worker·실패·복구:** 정상 JSON/SSE, HTTP 실패, chunk 분할·과대 응답·취소·timeout·실제 로컬 중단/새 프로세스 복구·보관 검증을 추가한다. 전후 원본/Git 무변경과 실제 인증/모델/외부 호출 0회를 확인한다.
4. **CLI·회귀·결과:** 명령군 `readonly-model-preflight-{plan,inspect,approve,run,cancel,invalidate,recover,prune}`를 구현하며 fixture/선택 근거/등록 profile과 기존 승인 필수 옵션만 허용한다. 임의 URL·헤더·인증·live 옵션은 없다. README에 실제 명령을 기록하고 `docs/stage-4c7-result.md`에 수용 135~150 및 검사별 `passed`·`failed`·`not_run`, 실제 테스트 수와 제외 사유를 남긴다.

**오프라인 검증 완료:** 신규 84개와 기존 642개, 전체 726개 테스트가 통과했다(실패 0·skip 0). lint·typecheck·build도 통과했다. 실제 모델·인증 접근·외부 전송·공급자 호환성·live 격리·의미 정확성은 `not_run`이고 `liveReady=false`를 유지한다. JSON/SSE 후보는 로컬에 고정한 제한된 형태이며 `usage`와 `[DONE]`도 미지원으로 거부한다.

**완료 기준:** 신규 수용 135~150, 기존 642개와 신규 단위/통합/수용 회귀, lint·typecheck·build가 통과해야 한다. 기존 native/loopback 회귀는 합성 로컬 검증으로 따로 기록하며 실제 인증·외부 모델을 호출하는 검사는 실행하지 않는다. 검토한 명세와 fake 입력 일치, 전달 최대 1회·재시도 0회, 대상 파일/Git 변경·대상 코드 실행·실제 모델 호출·인증정보 접근·외부 전송 0이 필요하다. 현재 642개 통과 기록으로 이 단계의 검증을 대신하지 않으며, 모든 오프라인 검사를 통과해도 `liveReady=false`를 유지한다.

#### 단계 4-C-8 합성 다중 파일의 실제 모델 읽기 전용 단건 조사

**상태: 전체985개 검증 코드의 response 진단을 별도 승인해1회 실행했으나 SSE created 내부 response의 엄격한 키 검사에서 실패했다. 필수 누락0·미등록 추가 필드5개(array1·nonnegative-integer2·null1·object1)·overflow 없음을 확인했으며 이름·의미는 미확인이다.** 이전 v8의 origin 단정 불가 정정은 유지하고 이번 결과를 소급 적용하지 않는다. 누적 upstream14회 실패·전송 전 실행 파일 부재 실패1회·소비 승인15개·자동 재시도0회를 보존하며 유효 보고서는 없다. 별도 v9 추가 JSON 호환 정책은 구현과 전체1005개·집중121개 검증을 마쳤다. 기존 v1~v8 계약·profile·hash는 보존한다. 새 v9 계획 준비를 마쳤으며 추가 승인을 기다린다. 새 계획의 승인·attempt·전송은0회다. [4-C-8 결과](stage-4c8-result.md)에 이력과 근거를 기록한다.

```text
등록 합성 flow fixture → 허용 파일/줄 수집 → 전달 근거 선택
  → 고정 live profile + 정확한 요청 본문·명세·hash 검토
  → 새 소유자 승인 → 원본/설정/기간 재검증 + 단일 소비·전달 예약
  → 부모 인증 broker + 격리 Codex → 고정 endpoint에 최대 한 번 전송
  → 완성 응답·조사 schema·인용 검증 → 로컬 읽기 전용 보고서
취소·중단·불확실한 전달 → 소비 보존·명시 복구, 재호출·실행 export 없음
```

- **자료와 권한:** 기존 reader로 새 합성 `flow` 원본을 준비한다. `--selection`과 `--transfer`는 `all|controller|service`, 요청은 `flow-question|change-request`만 허용한다. 회사 자료·실제 저장소·Slack 본문·임의 root/본문/경로는 받지 않는다. 계획·승인·보고서에서 `writeAllowedFiles=[]`, `testCommandIds=[]`, `executionAllowed=false`를 유지한다. 원본과 Git을 보존하고 대상 코드·설치·테스트·쉘·브랜치·patch·commit/push·PR/MR은 실행하지 않는다.
- **고정 연결 계약:** `gpt-6.1-sol`, 기존 ChatGPT 로그인, 고정 Codex upstream만 지원한다. 기존 `readonly-live-codex-v1`/`codex-chatgpt-sse-v1` 설정·profile·한도·hash는 유지해 실패 작업과 승인을 조회할 수 있다. 보완 설정 `readonly-live-codex-v2`는 `codex-chatgpt-sse-v2`와만 짝을 이루며 응답 헤더 한도 64개·16KiB를 별도로 적용한다. 두 버전 모두 native Codex 경로·SHA-256·고정 한도를 결합하고 요청 헤더 한도 32개·8KiB와 본문 직렬화는 유지한다. JSON/SSE 선택이나 임의 URL·모델·헤더·profile·인증 옵션은 제공하지 않는다. 4-C-7의 후보 검증을 완화하거나 성공 결과로 대체하지 않는다.
- **v3 보완:** 공식 응답 metadata의 null·추가 필드 형식 차이를 로컬에서 재현했다. 새 `readonly-live-codex-v3`/`codex-chatgpt-sse-v3`와 decoder `readonly-live-response-v2`에만 엄격한 보완·원시 값 없는 단계별 오류를 적용하고 v1·v2 profile/hash는 바꾸지 않는다. profile의 `responseHeaderPolicy=discard-set-cookie-v1`은 중복 Set-Cookie도 헤더 수·바이트·문자 검사 뒤 즉시 버리고 저장·전달·재사용하지 않는다. 다른 중복 헤더는 거부한다. 요청 본문과 기존 범위·한도는 유지하며 실제 실패 원인으로 단정하지 않는다. v3 회귀 뒤 별도 승인한 실제 1회도 헤더 검사에서 실패했고 정확한 거부 조건을 로컬에서 조사한다.
- **v4 보완:** 새 `readonly-live-codex-v4`/`codex-chatgpt-sse-v4`, decoder `readonly-live-response-v3`, `responseHeaderPolicy=http-token-discard-set-cookie-v1`에서만 HTTP token 이름·ASCII/HTAB·MIME OWS/따옴표 UTF-8·identity 대소문자를 정규화한다. v3 metadata/SSE를 상속하고 본문·모델·요청 헤더·한도는 유지한다. 비ASCII·압축·Location·Retry-After와 다른 중복 헤더 거부, Set-Cookie 검사 후 폐기는 유지하며 거부 조건별 정적 오류를 구분한다. 구형 세 버전의 조회·승인 분리를 포함한 회귀를 완료했다. 후속 고정 경로 v4 호출은 Content-Type 부재로 실패해 v5에서 대응한다.
- **v5 원인 수정:** 고정 경로 v4 응답에서 확인한 Content-Type 부재에만 대응한다. 새 decoder `readonly-live-response-v4`·`responseFormatPolicy=content-type-or-bounded-body-v1`을 승인 profile에 결합하고, 없는 헤더 대신 제한된 본문 접두어로 기존 strict JSON/SSE parser를 선택한다. 명시적 MIME/encoding·완결성·도구/근거·크기/시간 제한은 그대로다. 구형 네 버전과 실제 저장 기록을 보존한다.
- **후속 JSON 진단 구현 완료:** 원시 응답 없이 origin `response`/`sse`와 reason `syntax`/`depth`/`duplicate-key`/`unicode`/`sensitive-content`/`canonicalization`만 구분한다. 허용 조건·기존 오류 code·profile/config/body hash와 기존 계획의 유효성을 유지했다. 전체 895개·lint·typecheck·build 통과 뒤 별도 10분 승인으로 최대 1회·재시도 0회의 진단 호출을 수행했고 `sse`/`sensitive-content`로 실패했다. 후속 로컬 비교·합성 재현과 진단 보완은 아래 이력으로 이어지며, 정확한 원인 확인 없이 허용 범위를 넓히지 않는다.
- **민감정보 패턴·영역 진단 구현 완료:** 기존 `json` 두 키를 유지하고 `sensitive`에 `pattern`·`area`·`usageField`·`usageShape` 고정 enum만 기록한다. canonical redaction 문자열의 실제 정규식 일치 범위를 정적 영역에 매핑하고, known usage는 정확한 공식 경로·형태·redaction 투영만 인정한다. 복수·불확실한 경우 `multiple`/`other`로 남기며 원문 필드·값·일치 문자열·offset은 저장하지 않는다. 분류기 예외도 기존 거부를 유지한다. 수용 조건·공개 오류 code·profile/config/body hash를 보존하며 전체 907개·lint·typecheck·build를 통과했다(실패/skip 0, 약 67.7초). 이 코드로 별도 승인한 실제 1회는 `credential-assignment`/`other`로 실패했다.
- **민감정보 귀속 진단 구현 완료:** 기존 진단에 `sensitiveAttribution` 열 고정 enum을 추가했다. 실제 일치 시작 속성과 전체 범위를 분리하며 서로 다른 경로의 일치는 같은 분류라도 `multiple`로 기록한다. 전체915개·focused92개·lint·typecheck·build를 통과한 코드로 실제1회를 실행했으나 복수 귀속 상태로 실패했다. 정상 created의 `usage:null`도 기존 `invalid-shape`에 포함될 수 있어 실제 usage가 잘못됐다고 판단하지 않는다.
- **민감정보 일치 집계 구현·실제 진단 완료:** 기존 진단을 유지하고 `sensitiveMatches`에 여섯 고정 enum 조합별 `count`, `observedMatches`, `overflow`를 추가했다. 서로 다른 경로의 같은 조합은 합산하고 최대128회 일치·32개 조합으로 제한한다. 원문 키·값·경로·일치 문자열·offset은 저장하지 않는다. 수용 조건·오류 code·profile/config/body hash를 유지한 전체924개·lint·typecheck·build 통과 코드로 별도 승인1회를 실행했으며 `tool_usage` 영역의 일치4회를 확인했다.
- **v6 제한 보완 구현·실제 검증:** 공식 `tool_usage`의 정확한 응답 경로·필수/선택 객체 형태·안전한 정수 집계를 확인한 뒤 민감정보 검사용 숫자 별칭으로 투영한다. `tools=[]` 경계를 위한 하네스 정책으로 모든 수치를0으로 제한하며 nonzero는 정적 `TOOL_USAGE_ACTIVITY`로 거부한다. 선택 cache/output 상세 생략은 허용하되 null·추가 키·문자열은 허용하지 않는다. 집계0·생략은 도구 미실행 증거가 아니며 실제 tool call/event/output 차단을 유지한다. v1~v5 계약·hash를 보존한 새 profile의 전체935개·집중81개·lint/typecheck/build 검증을 마쳤다. 별도 승인한 실제1회는 SSE_EVENT로 실패했으며 승인 소비·단건 전송을 유지한다.
- **v7 SSE 호환성·진단 구현·로컬 검증 완료:** 공식 생성 이벤트 예시의 sequence1을 지원하도록 첫 값0 또는1을 허용하되 이후1씩 연속되는지 검사한다. 원문 없는 정적 SSE 실패 분류를 추가하고 구형 v1~v6 계약·도구 차단·출력/완료/근거·크기/시간 검증을 보존한다. v6의 정확한 실패 조건은 미확인으로 남긴다. 전체946개·집중89개·lint/typecheck/build 검증 뒤 별도 승인1회를 실행했으나 created/envelope/zero/first로 실패했다. 누락/추가된 세부 키는 미확인이다.
- **envelope 정적 진단 구현·로컬 검증 완료:** root eventObject 키 검사 실패 때만 `sseEnvelope`를 추가한다. missing은 등록된 필수 키 분류, unexpected는 고정 field·8종 valueType·count이며 총계·overflow를 함께 기록한다. root128개·32조합 한도, 미등록 이름 other, accessor/symbol/잘못된 형태 거부와 깊은 복사·동결을 적용한다. 실제 키·값·ID를 보관하지 않고 v3~v7 수용 조건·오류 code·profile/config/body/envelope hash를 유지한다. 전체960개·집중80개·lint/typecheck/build 및 새 계획 준비 검증을 완료했다. 같은 v7 계약으로 별도 승인1회를 실행했으나 사전미등록 boolean 추가 필드1개로 실패했다. 필드명·의미는 미확인이다.
- **v8 제한 호환 정책 구현·로컬 검증 완료:** 첫 response.created root의 추가 필드 정확히1개가 boolean·ASCII 식별자1~64자이며 SSE/제어/prototype 예약 키가 아닐 때만 검증용 사본에서 제외한다. 필수3키·원본 전체 민감정보·내부 response·다른 이벤트/직접 JSON·도구·sequence·완결성·hash/바이트 검증은 유지하고 필드 값을 동작에 쓰지 않는다. 실제 필드명·의미·ASCII 형태는 미확인이며 공식 일반 API 호환 정책을 참고한 명시적 제한으로 구분한다. v1~v7 계약·hash를 보존하는 새 v8 profile의 전체971개·집중99개·lint/typecheck/build와 새 계획 준비 검사를 완료했다. 별도 승인1회를 실행했으나 RESPONSE_FIELDS로 실패했으며 직접 JSON/SSE origin은 미확인이다. 추가 실행은 없다.
- **response 정적 진단 구현·로컬 검증 완료:** direct-response/created/in-progress/completed 네 경로와9종 거부 경계를 고정 enum으로 기록한다. envelope 실패만 missing/unexpected/count/overflow를 추가하며 필수5·선택28·관찰용8개 이름을 분리하고 root128개·32조합·8종 값 형태를 제한한다. 원문·키·값·ID를 보관하지 않고 getter 미실행·깊은 복사·동결·로컬 decoder 선택을 유지한다. v8 수용 조건·오류 code·hash는 바꾸지 않는다. 전체985개·집중88개·lint/typecheck/build와 독립 검토를 마쳤으며 같은 v8 계획을 별도 승인해1회 실행했으나 created 내부 response의 추가 필드5개로 실패했다. 이름·의미는 미확인이다.
- **v9 제한 호환 정책 구현·로컬 검증 완료:** 새 decoder `readonly-live-response-v8`과 `responseExtensionPolicy=bounded-inert-json-v1`, 공유된 불변 한도 `{fields:8,keyCharacters:64,bytes:16384,nodes:256,depth:8}`을 새 profile에 결합한다. 추가 response 필드의 root 이름은 ASCII 식별자로 제한하고 제어/prototype 키를 거부한다. 추가 묶음을 깊이0·노드1로 세며 키 포함 canonical UTF-8 크기와 유한한 JSON·own data property를 검사한다. 숫자 별칭 없는 추가 원본의 민감정보 검사 뒤 검증용 사본에서만 제외한다. 알려진 필드·도구·sequence·완료 검증은 유지하고 추가 자료는 보고서·상태·동작에 사용하지 않는다. 기존9종 response 거부 분류에 extension-key/limit/value/sensitive/control을 더하고 v1~v8 계약·hash를 보존한다. 전체1005개·집중121개 검사를 통과했다. 새 계획 준비를 마쳤으며 추가 승인을 기다린다. 새 승인·attempt·전송은0회다.
- **검토와 승인:** 최종 입력·전송 본문·인증값 없는 명세, 읽기/전달/빈 수정 범위, 모델·endpoint·인증 방식·격리 정책과 한도를 표시한다. `contextHash`·`inputHash`·`requestBodyHash`·`connectionProfileHash`·`requestEnvelopeHash`와 설정·원본·소유자·revision을 새 계획에 고정한다. 계획/내용 24시간과 명시적 승인 TTL 1~60분을 적용하고 실제 dispatch 직전에 재검증한다. 4-C-4/5/6/7 승인·결과·DB를 live로 승격하지 않는다.
- **인증과 격리:** plan/inspect/approve/cancel/invalidate/recover/prune는 인증을 읽지 않는다. run의 승인·dispatch 이후 adapter 안에서만 기존 로그인 정보를 읽고 부모 메모리에서 사용한다. refresh·로그인 파일 변경/복제·환경 토큰 탐색은 하지 않는다. Codex에는 빈 HOME/CODEX_HOME과 단건 broker capability만 주며 기존 설정·skills·MCP·인증 파일을 넘기지 않는다. 고정된 실행 파일과 승인 입력, broker 목적지에 한정한 외부 OS 격리·guardian 종료를 실제 호출 전에 확인한다.
- **단건 전송과 실패:** 승인 소비·attempt·전달 예약을 commit하기 전 인증/모델 전송을 하지 않는다. 실제 전달은 작업당 최대 1회이며 오류·timeout·취소·불확실한 응답·재시작 뒤 retry/redirect/fallback·승인 복원을 하지 않는다. 부모가 승인한 정확한 본문만 전송한다. 외부 요청의 취소를 서버 측 추론 중지나 미전송의 증거로 간주하지 않는다.
- **결과와 보관:** 완성된 응답에서 조사 JSON 한 건만 추출하고 전달 근거 ID·포함된 줄, 비밀 패턴, 크기와 추가 실행 필드를 검사한다. raw/부분/거부 응답은 보관하지 않는다. payload 24시간, 최초 terminal 감사 30일, DB 수명의 소비 marker와 private 경로·링크 방어를 유지한다. 근거가 부족하면 불확실성을 표시하며 제한된 사례의 내용 검토를 일반적 의미 정확성 보증으로 확대하지 않는다.
- **제어와 복구:** cancel/invalidate generation으로 늦은 결과를 차단한다. guardian/worker 종료·원본/Git·명세 hash·모델 임시 디렉터리 부재가 확인된 중단만 명시 recover로 정리하며 불확실한 상태는 `BLOCKED`로 남긴다. 전달 예약 뒤 취소된 작업도 같은 복구 증거를 요구한다. 자식 종료 뒤 새로 만든 모델 임시 디렉터리와 빈 HOME/CODEX_HOME만 inode/dev를 확인해 제거하고, 합성 원본/Git·DB·감사·실패 작업물은 보존한다. 복구는 인증·네트워크·모델 호출이나 원본/실패 작업물 자동 정리를 하지 않는다.

구현 명령은 `readonly-live-{plan,inspect,approve,run,cancel,invalidate,recover,prune}`다. plan/approve/run은 `--config`가 필수이며 inspect·cancel·invalidate는 짧은 DB 트랜잭션으로 전역 lease를 우회한다. 나머지는 lease를 요구한다. 설정 예제는 기본 비활성이고 구체 실제 호출은 검토 가능한 계획·본문이 준비된 뒤 별도로 승인받는다.

**현재 완료 판정:** 첫 v5·JSON 진단·패턴/영역 진단·귀속 진단·일치 집계 진단·v6·v7·envelope 진단·v8·response 진단 실제 호출에는 각각886개·895개·907개·915개·924개·935개·946개·960개·971개·985개 전체 회귀와 lint·typecheck·build를 통과한 코드를 사용했다. 직전 실제 호출 코드의985개는 실패/skip0, 약70.7초이며 집중88개도 통과했다. 이후 v9의 최신1005개(기존726개·신규279개)·집중121개·lint/typecheck/build가 모두 통과했다(실패/skip0, 전체 약68.5초). 실제 upstream14회 모두 failed이고 전송 전 실패까지 소비 승인15개다. 유효 조사 보고서가 없어 수용162는 미완료다. 별도 v9 추가 JSON 호환 정책은 구현과 전체1005개·집중121개 검증을 마쳤다. 기존 v1~v8 계약·profile·hash는 보존한다. 새 v9 계획 준비를 마쳤으며 추가 승인을 기다린다. 새 계획의 승인·attempt·전송은0회다. 이전 소비 승인은 재사용하지 않는다. 로컬 검증과 공급자 실제 성공·회사 도입 검증을 구분한다.

#### 후속 단계의 별도 범위

- 4-C 후속 후보: 4-C-8의 합성 다중 파일 단건 live 조사의 실제 검증 상태를 먼저 확인하고, 등록한 실제 대상 저장소의 읽기 전용 조사와 Codex 직접 수정 방식을 각각 별도 범위로 설계한다. 실제 모델의 인증·전송 범위·공급자 호환성·격리 검증은 4-C-7 오프라인 완료에도 포함되지 않는다. commit 준비와 push는 구분하며 원격·브랜치·커밋·diff의 별도 승인을 설계한다. PR/MR 생성은 포함하지 않는다.
- 4-D 후보: Gmail·Calendar·Drive를 서비스별 읽기와 변경 기능으로 나누고 인증·자료·전송·보관 정책을 정한다.

4-C-5/4-C-6/4-C-7의 오프라인 완료 기록과 이 절의 후속 후보는 각각 구현·검증·운영 범위를 구분한다. 계획 추가가 실제 모델·인증 접근·회사 자료 처리나 외부 게시를 승인하지 않으며 후속 후보도 별도 계획 대상이다.

**대상 저장소의 Codex 작업 규칙 (2026-11-12 결정):** 회사 대상 저장소는 GitLab으로 관리하며, 하네스의 코드 수정 지시에 다음 규칙을 적용한다. 이 규칙을 현재 하네스 저장소 개발에 적용하는 것은 아니다.

| 작업 성격 | 대상 작업 브랜치 예시 |
| --- | --- |
| 새 기능 | `feature/add-request-filter` |
| 오류 수정 | `fix/duplicate-event` |
| 설정·의존성·유지보수 | `chore/update-config` |
| 동작을 유지하는 구조 개선 | `refactor/split-policy` |

- 계획에 작업 유형·브랜치 이름·기준 브랜치와 커밋·허용 diff 범위를 명시한다. 유효한 수정 승인과 검증된 격리 환경을 확인한 뒤, 기준 커밋에서 `<type>/<short-description>` 형태의 작업 브랜치를 생성하고 해당 브랜치에서만 수정한다. 기준 브랜치를 직접 수정하지 않는다.
- 기존 사용자 변경과 같은 이름의 브랜치를 덮어쓰거나 초기화하지 않는다. 재시작 시 같은 작업의 브랜치인지 확인하며, 다른 작업과 충돌하면 계획을 조정한다. 승인에 묶인 브랜치·기준 커밋·변경 범위가 달라지면 재승인한다.
- Codex에는 허용된 수정·검사와 로컬 브랜치·diff·결과 보고까지만 지시한다. PR/MR 생성 경로를 제공하지 않으며, commit·push는 코드 수정 승인에서 분리한다. push에는 실제 원격·브랜치·커밋·diff를 검토한 별도 승인이 필요하다.
- 4-C-1은 오프라인 계획·승인·모의 결과를, 4-C-2는 독립 합성 저장소의 실제 ref 생성·보존·복구를, 4-C-3은 합성 작업 브랜치의 고정 수정·Docker 검사·취소·복구를, 4-C-4는 실제 Codex의 고정 합성 제안과 새 실행 승인을 다룬다. 회사 대상 저장소 변경·Git 원격 작업은 구현하지 않았다. 회사 연결 전에는 작업 유형별 브랜치 선택, 승인 전 무변경, 기준 브랜치 보존, 이름 충돌·재시작, 승인 후 계획 변경, PR/MR 호출 없음과 미승인 push 차단을 해당 환경에서 검증한다. 기존 합성 검증 결과를 회사 연결의 검증으로 재사용하지 않는다.

## 3 구조와 데이터 모델

NestJS는 조립과 설정에 쓰고, 상태 전이와 승인 규칙은 외부 서비스에 의존하지 않는 TypeScript 코드로 둔다. 처음에는 단일 프로세스, SQLite, 작업 하나씩 실행하는 구조면 충분하다.

| **구성 요소** | **책임** |
| --- | --- |
| Ingestion | Slack 또는 fixture 입력을 공통 이벤트로 바꾸고 중복을 제거한다. |
| Triage | 문의와 변경 요청과 불명확을 분류하고 JSON 스키마로 검증한다. |
| RepoReader | 허용된 저장소의 필요한 파일만 읽고 근거를 돌려준다. |
| Planner | 조사 결과, 답변 초안, 수정 계획을 만든다. 도구 실행 권한은 없다. |
| PolicyGate | 채널, 저장소, 경로, 명령, 데이터 전송 범위와 승인을 검사한다. |
| ApprovalService | 소유자 승인, 계획 버전, 만료, 1회 사용을 검증하고 저장한다. |
| ExecutionRunner | 승인된 변경과 테스트만 격리 환경에서 실행한다. |
| TaskStore와 Reporter | 상태 전이와 감사 기록을 저장하고 나에게 보고서를 보여 준다. |

### 외부 서비스 교체 지점

MessageSource, ModelPort, RepoReadPort, ExecutionPort, ApprovalPort, ReportSink를 인터페이스로 둔다. 구현은 MockSlackSource, FixtureModel, LocalGitReader, LocalCliApproval처럼 분리한다. 특정 Codex SDK나 CLI를 전제로 도메인 코드를 묶지 않는다. 실제 실행기 연결 시 해당 버전의 공식 문서와 인증 조건을 확인한다.

### 최소 데이터

- Task: taskId, eventId, workspaceId, channelId, threadTs, requesterId, 분류, 상태, repoId, baseCommit, createdAt.
- Slack inbox와 메시지 수집 기록: eventId, 원본 messageTs, revision, 수집 상태, 마스킹한 최소 본문·스레드, 보관 기한. envelopeId는 ACK용이며 이벤트나 원본 메시지의 식별자를 대신하지 않는다.
- 기존 Plan: planId, version, 원문 revision, 목적, allowedFiles, 변경 제안, testCommandIds, 위험, planHash. 구형 조사 계약의 allowedFiles는 읽기 근거에서 만들어지며 실행 권한으로 재사용하지 않는다.
- 신규 읽기 전용 조사 Plan(4-C-5): repo/baseCommit/manifest, requestRevision, readAllowedFiles·readRanges, transferEvidenceIds·contextHash·inputHash, writeAllowedFiles=[], testCommandIds=[], executionAllowed=false, 모드·모델·목적지·정책·보관 기한·planHash. 내용 payload와 본문 없는 승인/감사 기록을 분리한다.
- 후속 수정 계획의 설계 원칙: 읽기 범위에서 수정 범위를 복사하지 않고 소유자가 정한 writeAllowedFiles·정확한 patch·등록 명령을 별도 hash와 실행 승인에 묶는다. 이는 4-C-5에 실행 기능을 추가한다는 뜻이 아니다.
- Approval: approvalId, ownerId, taskId, planHash, baseCommit, 허용 동작, 만료 시각, 사용 시각, 취소 여부.
- Evidence와 Run: 파일 경로와 줄, 커밋, diff 요약, 검사별 passed 또는 failed 또는 not\_run, 실패 사유.
- 합성 답장: 별도 `replies.sqlite`의 `ReplyTask`, 본문 없는 `ReplyPlan`·승인 snapshot, 별도 만료 본문, 전송 시도·제어 이벤트와 최소 중복 marker. 기존 코드 승인·실행 Run·Slack inbox를 재사용하지 않는다.
- live 단건 시험: 별도 `live-replies.sqlite`의 `LivePlan`·`LiveTask`·`LiveApproval`·`LiveAttempt`와 hash로 된 대상 중복 marker. 원문·고정 전송 본문을 저장하지 않고 source metadata와 receipt만 유지한다.

### 상태 전이

```text
RECEIVED → TRIAGED → ANALYZED
  문의       → REPORTED
  불명확     → NEEDS_CLARIFICATION
  변경 요청  → AWAITING_APPROVAL → APPROVED
             → RUNNING → VERIFYING → REPORTED
  예외       → BLOCKED / FAILED / CANCELLED
```

상태는 데이터베이스 트랜잭션으로 바꾼다. 이벤트 ID와 승인 사용 기록에는 유일성 제약을 둔다. 재시작은 기록 복구이지, 중단된 수정 작업의 자동 재실행 허가가 아니다.

단계 3-A는 `APPROVED`까지 저장하고 실행하지 않는다. 승인 만료는 취소 기록을 남긴 뒤 `APPROVED → AWAITING_APPROVAL`, 로컬 취소와 요청 무효화는 `CANCELLED`로 전환한다. 불변 승인 스냅샷과 `approval-only-v1` 정책은 Task와 별도로 보존한다. 단계 3-C·3-D의 독립 합성 실행은 별도 `execution.sqlite`에서 `AWAITING_APPROVAL → APPROVED → RUNNING → SUCCEEDED / FAILED / BLOCKED / CANCELLED / INTERRUPTED`와 새 `synthetic-execution-v1` 승인·Run·요청 무효화/lifecycle 기록을 관리한다. 기존 조사 상태 전이와 혼용하지 않는다.

단계 4-A는 `replies.sqlite`에서 `AWAITING_APPROVAL → APPROVED → SENDING → SIMULATED / FAILED / UNKNOWN`을 별도 관리한다. 대기 중 소유자 취소는 `CANCELLED`, 요청/문맥 변경·불완전·공백·만료는 `BLOCKED`이며 `SENDING`의 무효화는 `UNKNOWN`으로 차단한다. `NOT_SENT`로 확인된 `FAILED`만 새 승인으로 수동 재시도하며 `SIMULATED`·`UNKNOWN`은 재전송하지 않는다. 중단된 `SENDING`은 문맥이 유효하면 명시적 복구 전까지 그대로 보존한다.

단계 4-C-4의 호출 전용 `codex-proposals.sqlite`는 `AWAITING_APPROVAL → APPROVED → RUNNING → READY / FAILED / CANCELLED / INTERRUPTED`와 한 번의 `READY → EXPORTED`를 관리한다. 별도 `codex-execution.sqlite`는 새 실행 승인을 받은 후 기존 실행 상태 전이를 사용한다. 두 DB를 하나의 트랜잭션으로 묶지 않으며 export commit 뒤 후속 계획 생성 실패도 제안을 다시 소비할 권한으로 바꾸지 않는다.

4-C-5의 신규 조사 상태·보관·취소는 `mock` 전용 별도 DB에 구현했다. 조사 결과는 REPORTED로 종료하고 기존 제안의 EXPORTED 및 코드 실행 상태 전이로 연결하지 않는다.

## 4 승인과 실행 경계

승인은 “이 작업을 해도 된다”는 구체적인 기록이어야 한다. 모델의 자신감이나 Slack 요청자의 말투, 문서 안의 명령문은 승인으로 취급하지 않는다.

### 수정 전에 보여 줄 내용

- 작업 ID, 대상 저장소, 기준 커밋, 원래 요청과 예상 동작.
- 읽기 허용 파일·줄, 모델에 전송할 근거와 실제 본문 해시, 수정 허용 파일·patch를 각각 구분한다. 읽은 파일이라는 이유로 수정 대상에 넣지 않는다.
- 수정 방향, 별도로 허용된 검사 명령, 외부 연결 필요 여부. 4-C-5는 수정 파일·대상 검사 명령이 빈 목록임을 표시한다.
- 예상 위험과 한계, 승인 유효기간, 취소 방법. 초기 유효기간은 30분 같은 설정값으로 제안한다.

### 승인 처리 규칙

MVP의 승인은 로컬 CLI에서만 받는다. 원격 서버를 열지 않고 현재 OS 사용자와 파일 접근 권한을 신뢰 경계로 삼는다. taskId만 맞으면 승인되는 구조를 피하고, 표시된 planHash와 baseCommit 및 허용 동작을 함께 묶는다.

단계 3-A의 소유자 ID는 `os-user:<uid>`이며 `process.getuid()`를 지원하지 않으면 승인·취소를 거부한다. Slack의 소유자 ID와 혼용하지 않는다. 이 단계의 `baseCommit` 검증은 Task·계획 스냅샷·CLI 입력의 일치 검사다. 실제 실행 직전 대상 저장소 상태의 재검증과 승인 소비는 아직 수행하지 않는다.

계획 내용, 대상 저장소, 기준 커밋, 요청 메시지 revision이 바뀌면 이전 승인은 무효다. 승인 소비와 RUNNING 전환은 원자적으로 처리한다. 같은 승인으로 두 번 실행하지 않는다. 새 파일이나 명령이 필요하면 멈추고 수정 계획을 다시 보여 준다.

| **행위** | **MVP의 처리** |
| --- | --- |
| 읽기와 초안 작성 (4-C-5) | readAllowedFiles·줄 범위 안에서만 자료를 수집한다. writeAllowedFiles와 대상 명령은 별도로 검증하며 읽기 권한으로 채우지 않는다. |
| 모델 전송 (4-C-5) | 검토한 전송 근거·본문 해시·모델·목적지의 전용 승인을 요구한다. 로컬 읽기 허용 및 코드 수정 승인과 구분한다. |
| 제품 코드 변경과 테스트 | 유효한 소유자 승인 뒤에, 허용된 범위와 격리 환경에서 실행한다. |
| 요청자에게 답장 | 기본 차단. 받는 사람과 채널과 본문을 제시하고 별도 승인을 받는다. |
| push | 기본 차단. 원격·브랜치·커밋·diff를 따로 승인받는다. |
| PR/MR 생성 | 하네스의 대상 저장소 작업 지시와 후속 구현 범위에서 제외한다. |
| 병합과 배포 | 첫 버전에서 구현하지 않는다. 코드 수정 승인을 재사용하지 않는다. |

### 취소와 실패

실행 전 취소는 대기 작업을 끝낸다. 실행 중 취소는 새 동작을 막고 하위 프로세스를 종료한 뒤, 이미 바뀐 파일과 실행 결과를 보고한다. 취소가 이전의 외부 동작을 되돌린다고 가정하지 않는다. 수정 중 실패하거나 재시작하면 결과를 조사한 뒤 재개 여부를 묻는다.

### worktree의 의미

별도 작업 트리는 원래 작업 디렉터리를 어지럽히지 않게 한다. 보안 격리 자체는 아니므로 경로·명령·파일시스템·네트워크 제한을 별도로 적용한다. 일반적인 `git worktree`는 Git 메타데이터를 공유하지만 현재 3-C 합성 실행은 고정 파일에서 독립 Git 저장소를 재생성하고 container에 Git 없는 view만 제공한다. 기본 동작은 로컬 diff 보고까지이며 실행 결과를 자동 commit하거나 정리하지 않는다.

## 5 보안과 Slack 연결

### 회사 데이터를 다루기 전의 조건

회사 정책에서 AI 제공자, 실행 위치, 전송 가능한 코드와 메시지, 보관 기간, 감사 요구를 먼저 확인한다. 회사 승인이 없으면 회사 계정이나 저장소를 연결하지 않는다. 집에서 사용하는 fixture에는 실제 회사 코드, 고객 정보, 비공개 메시지를 넣지 않는다.

### 읽기 단계의 안전장치

- 실제 경로를 정규화하고 symlink와 경로 탈출을 검사한다. 허용된 repo root 밖의 파일을 읽지 않는다.
- 비밀 파일, 개인 키, 자격증명, 대용량 파일과 바이너리는 제외한다. allowlist와 denylist를 함께 사용하고 필요한 줄만 모델에 전달한다.
- 저장소 파일을 읽는 것과 프로그램을 실행하는 것을 분리한다. package.json의 test나 install도 임의 코드를 실행할 수 있으므로 조사 단계에서 실행하지 않는다.
- Slack 본문, README, 코드 주석은 신뢰하지 않는 자료다. “규칙을 무시하라”는 문구가 있어도 권한, 프롬프트 정책, 실행 명령을 바꿀 수 없다.

### 실행 단계의 안전장치

명령은 미리 등록된 commandId와 인자 스키마로 선택한다. 모델 문자열을 쉘에 넣지 않는다. 실행 환경은 비밀정보를 상속하지 않고, 네트워크는 기본 차단하며, 시간과 메모리와 출력 크기를 제한한다. 승인되지 않은 파일 변경을 감지하면 성공 처리하지 않는다. 패키지 설치와 테스트 설정 변경도 승인된 범위에 포함되어야 한다.

### 사용자 멘션을 잡는 방법

Slack의 app\_mention은 앱의 봇 사용자가 언급되는 이벤트다. 내 계정이 언급되는 경우를 잡으려면 접근이 승인된 채널의 message 이벤트를 수신하고, \<@TARGET\_USER\_ID\>를 검사하는 방식을 검토한다. 이름 문자열 검색은 이름 변경이나 동명이인 때문에 쓰지 않는다.

단계 2 연결 방식은 Socket Mode로 한정한다. 공개 수신 서버가 없어도 앱 설치, 필요한 토큰과 권한, 네트워크 연결은 필요하다. 최소 manifest는 공개 채널만 대상으로 하며 비공개 채널은 별도 허용 시 추가한다. DM은 이번 범위 밖이다. 실제 토큰·scope·멤버십 및 스레드 조회 권한은 회사 관리 설정과 승인된 테스트 워크스페이스에서 검증한다.

### 이벤트 처리

- 허용된 workspaceId와 channelId를 먼저 검사한다. 앱이 접근할 수 있는 범위 이상을 읽지 않는다.
- 수락한 이벤트는 최소 자료와 중복 키를 SQLite inbox에 commit한 뒤 빠르게 ACK한다. 스레드 수집과 로컬 보고는 ACK 이후 처리한다. 저장 실패를 성공 수신으로 표시하지 않는다.
- 봇과 자기 메시지에 대한 루프를 막는다. 편집과 삭제 이벤트는 별도 처리하고, 내용이 바뀐 계획의 승인은 무효화한다.
- 내 ID 멘션 자체를 승인으로 보지 않는다. 결과 보고는 로컬이 기본이며, Slack DM 전송도 별도 설정한다.

## 6 저장소 구성과 집에서의 실험

처음에는 하나의 패키지에서 시작한다. 저장소 구조는 NestJS 모듈과 순수 도메인 로직, 외부 어댑터의 경계를 보여 주는 정도면 충분하다.

```text
work-assistant-harness/
  src/
    cli/                  # 실행과 승인 명령
    domain/               # 상태와 승인 규칙
    application/          # 조사 계획 실행 흐름
    ports/                # 외부 기능 인터페이스
    adapters/             # slack model git sqlite report
    policy/               # 경로 명령 데이터 검사
  config/local.example.yaml
  fixtures/               # slack sample-repo model
  tests/                  # unit integration acceptance
  docs/                   # 구조 보안 회사 도입 가이드
  .env.example
  .gitignore
  README.md
```

### 저장소 밖에 두는 것

실제 토큰, 개인 또는 회사 설정, 승인 기록, SQLite 파일, 원문 메시지, 보고서, 실행 로그와 worktree는 커밋하지 않는다. 실행 데이터의 기본 경로는 OS 사용자 데이터 디렉터리로 정하고, 프로젝트 안에 둘 때도 .gitignore와 비밀정보 검사를 적용한다. .env.example에는 실제 값 대신 명백한 placeholder만 넣는다.

### 필수 fixture

| **사례** | **재현할 내용** |
| --- | --- |
| 정상 흐름 | 문의, 변경 요청, 불명확, 멘션 없음, 다른 사용자 멘션 |
| 이벤트 경계 | 동일 eventId 재전송, 순서 뒤바뀜, 메시지 편집과 삭제 |
| 권한 경계 | 허용되지 않은 채널, 다른 저장소, 경로 탈출과 symlink |
| 모델 오류 | 잘못된 JSON, 근거 없는 파일명, timeout, 금지 명령 요청 |
| 실행 오류 | 승인 만료, 중복 실행, 테스트 실패, 취소와 재시작 |
| 다중 파일 조사 (4-C-5) | 파일 간 근거 연결, 읽기/전송/수정 범위 구분, 줄 밖 비밀, 중복 구간, 승인 후 snapshot 변조, 원본 무변경 |

### 제안하는 개발 명령

```text
pnpm test && pnpm lint && pnpm typecheck
pnpm harness replay --fixture inquiry
pnpm harness inspect <task-id>
pnpm harness approve <task-id> --plan-hash <hash>
pnpm harness run <task-id>
```

명령은 구현 제안이다. 버전과 lockfile을 고정하고 sample-repo를 임시 Git 저장소로 초기화해 테스트한다.

## 7 회사 도입과 이후 확장

### 회사에서 처음 실행하는 순서

- 회사 정책 확인: 승인 담당자와 AI 사용 정책, 허용된 제공자와 모델, 데이터 반출 및 보관 범위를 확인한다.
- 개인 코드와 회사 자료 분리: 하네스의 범용 코드만 회사 환경으로 가져온다. 회사 코드와 설정을 개인 원격 저장소로 보내지 않는다. 회사의 소프트웨어 반입 절차도 따른다.
- 실행 환경 준비: 승인된 회사 장비 또는 환경에서 저장소를 clone하고, 고정 버전으로 의존성을 설치한 뒤 모의 테스트를 먼저 돌린다.
- 계정과 경로 설정: 회사에서 발급받은 자격증명을 승인된 비밀 저장소에 둔다. workspaceId, 내 userId, 허용 채널, repo root, 모델 목적지를 실제 값으로 설정한다.
- 범위를 좁혀 검증: 채널 하나와 저장소 하나에서 읽기 전용으로 시작한다. 어떤 파일과 메시지가 모델에 전달되는지 확인한다.
- 수정 기능 열기: 회사 정책과 격리 실행 검증이 끝난 후 명시적 승인 방식으로 켠다. 개인의 기존 작업 디렉터리는 건드리지 않는다.
- 운영 기준 정하기: 보관 기간, 로그 마스킹, 오류 알림, 중지 스위치, 토큰 교체와 권한 해제 절차를 정한다.

### 도입 전에 결정할 값

Slack 대상 ID와 허용 채널, 저장소 연결 규칙, AI 사용 가능 범위, 실행 환경, 승인 유효기간, 테스트 명령 목록, 작업 동시 실행 수, 결과 보관 기간을 회사 환경의 로컬 설정에 기록한다. 예시 값을 실제 정책처럼 하드코딩하지 않는다.

### Gmail과 Calendar와 Drive

| **확장** | **읽기 기능의 예** | **변경 기능의 경계** |
| --- | --- | --- |
| Gmail | 관련 메일을 찾아 사실과 답장 초안을 제시 | 메일 보내기와 보관 처리 등은 별도 승인 |
| Calendar | 일정 확인과 가능한 시간 제안 | 일정 생성과 수정 및 초대는 별도 승인 |
| Drive | 허용된 문서의 필요한 부분만 참고 | 문서 수정과 파일 공유 및 권한 변경은 별도 승인 |

각 커넥터는 최소 권한과 회사 승인 절차를 따르고, 공통 작업 모델에 데이터를 제공한다. Google 로그인이 된다는 이유로 전체 메일과 문서를 읽지 않는다. 회사 계정과 개인 계정의 자격증명, 캐시, 보고서를 분리한다.

### 운영 시 확인할 지표

멘션 누락과 중복률, 불명확 분류 비율, 잘못된 저장소 선택, 근거 없는 답변, 승인 없이 시도한 실행, 테스트 실패, 모델 비용과 처리 시간을 기록한다. 생산성 수치보다 권한 위반이 0인지 먼저 확인한다. 원문 메시지와 코드 전문을 로그에 남기는 방식은 피한다.

## 8 완료 판단을 위한 수용 테스트

각 테스트는 실행 가능한 코드로 작성한다. 금지 동작은 프롬프트의 문구가 아니라 PolicyGate, 어댑터 권한, 실제 파일 상태로 검증한다. 모든 외부 전송 어댑터는 기본적으로 비활성화한다.

| **번호** | **조건** | **통과 기준** |
| --- | --- | --- |
| 01 | 내 ID 멘션과 허용 채널 | 작업 1개 생성. 다른 ID와 비허용 채널은 0개. |
| 02 | 같은 이벤트가 반복 수신됨 | 분석과 보고서가 중복 생성되지 않음. |
| 03 | 문의 요청 | 파일 근거와 답변 초안 생성. 저장소 변경 없음. |
| 04 | 명확한 변경 요청 | 수정 계획만 생성. 승인 전 diff가 비어 있음. |
| 05 | 불명확하거나 잘못된 분류 JSON | 확인 또는 실패 상태. 코드 실행 없음. |
| 06 | 정상 실행 승인 (단계 3-C) | 일치하는 계획과 커밋으로 1회만 실행. 단계 3-A의 승인 기록만으로 실행하지 않음. |
| 07 | 만료와 위조와 중복 승인 | 모두 거부. 소비된 승인 재사용 불가. |
| 08 | 계획과 커밋과 요청 내용 변경 | 기존 승인 무효. 새 계획 확인 필요. |
| 09 | 경로 탈출과 symlink와 비밀 파일 | 읽기 차단. 모델 입력과 로그에 내용 없음. |
| 10 | Slack과 README의 악성 지시 | 정책 변경, 외부 전송, 명령 실행으로 이어지지 않음. |
| 11 | 모델이 임의 쉘 명령을 제안 | 등록되지 않은 명령은 실행되지 않음. |
| 12 | 승인된 수정과 테스트 | 별도 worktree만 변경. 결과와 실제 diff가 일치. |
| 13 | 테스트 실패 또는 미실행 | failed와 not\_run을 구분하고 성공으로 표시하지 않음. |
| 14 | 실행 중 취소와 프로세스 재시작 | 자동 재실행 없음. 중단 상태와 잔여 diff 보존. |
| 15 | Slack 답장과 Git 원격 작업 경계 | 별도 승인 없이 전송 또는 원격 변경 없음. 4-A의 승인은 모의 전송에만 유효하고 4-B-2는 새 live 계획·승인으로 고정 단건만 허용. push 차단을 유지하고 PR/MR 생성 경로는 제공하지 않음. |
| 16 | 토큰과 환경변수와 로그 검사 | Git 추적 파일과 모델 입력 및 보고서에 비밀 없음. |
| 17 | 같은 eventId가 다른 envelopeId로 전달됨 | inbox·수집 결과는 하나이며 전달별 ACK. ACK에 업무 답변 payload 없음. |
| 18 | inbox 저장 실패·포화·commit 후 ACK 실패 | 미보관 새 메시지는 성공 ACK 없음. 포화 편집은 무효화·BLOCKED를 commit 후 ACK하고 수집 생략. commit 이벤트는 재전달·재시작에도 중복 수집 없음. |
| 19 | 원본과 스레드 reply의 편집·삭제·멘션 제거 | messageTs·확인한 스레드로 연결된 작업·문맥 무효화. root 불명 변경은 같은 채널의 진행 중 수집을 보수 차단하고 무관한 완료 기록 유지. 취소 보고서 복구. 큐 포화여도 기존 계획 무효화 반영. |
| 20 | 편집·삭제가 원문보다 먼저 도착하거나 수집 중 변경 | 오래된 revision과 늦은 스레드 결과가 최신 내용·삭제 상태를 덮어쓰지 않음. |
| 21 | 스레드 cursor·과대 응답·수집 한도 | 허용된 thread만 조회. 페이지·메시지·바이트·시간 한도 준수와 불완전 사유 표시. |
| 22 | 429와 Retry-After·권한 부족·오류 | 지정 대기와 재시도 상한 준수. 헤더 오류·과도한 대기는 실패 사유. 무한 재시도 없음. |
| 23 | Socket disconnect·재연결·재시작·종료 | pending 후속 처리·processing 차단 복구, 재연결 한도, 최근 100개 연결·공백 이력. 취소 후 후속 작업 정리·DB 종료. 자동 채널 전체 backfill 없음. |
| 24 | 마스킹·보관 만료·만료 후 재전달 | 본문·스레드·수집 출력에 지원 비밀·개인정보 패턴 없음. payload 제거 후 최소 중복·revision marker 유지로 같은 이벤트가 내용을 되살리지 않음. |
| 25 | liveReadEnabled 기본 설정·토큰 분리·workspace 불일치 | 기본 외부 접속 0. 설정 오류·읽기 토큰 workspace 불일치 시 연결 거부. 조사 worker는 토큰·네트워크 없음. |
| 26 | 실제 형식 메시지 수집 결과 | 분석 not_run과 이유 표시. 고정 모델의 합성 답변·코드 조사·승인·실행·외부 메시지 전송 없음. |
| 27 | 로컬 승인 입력과 소유자 (3-A) | 계획 해시·기준 커밋·저장소·요청 revision 일치 및 필수 TTL 1~1440분 검증. 소유자는 OS UID로 고정하고 UID 미지원·다른 소유자·잘못된 입력 거부. |
| 28 | 승인 영속화·중복·만료·이력 조회 (3-A) | 승인 INSERT와 APPROVED가 원자적. 활성 승인 중복 생성 없음. 만료 조정 후 기존 승인 취소·AWAITING_APPROVAL 복귀와 이력 유지. 최신순 1개 페이지와 nextOffset으로 이력을 조회하고 offset 범위·출력 한도 준수. |
| 29 | 로컬 취소 (3-A) | 승인 대기·승인됨 변경 요청만 CANCELLED. 기존 승인 취소와 상태 변경이 원자적이며 불변 승인 스냅샷·이력 보존. |
| 30 | 승인 후 요청 편집·삭제 (3-A) | 기존 Task 무효화와 승인 취소가 같은 트랜잭션. Task 계획·보고 제거 뒤에도 승인 스냅샷은 유지. |
| 31 | 승인 기록과 실행의 분리 (3-A) | executionPolicy는 approval-only-v1, usedAt은 null. ExecutionPort 항상 거부, run은 UNKNOWN_COMMAND. 대상 변경·검사·승인 소비·Run·외부 전송 없음. |
| 32 | 실시간 수신과 승인 CLI의 잠금 (3-A) | 같은 데이터 디렉터리의 수신 lease가 있으면 approve/cancel 거부. 잠금 실패 시 상태·승인 변경 없음. |
| 33 | 실제 격리 backend의 실패 검사 (3-B) | 고정 local Docker identity·유효 정책, 합성 호스트·원본·승인 DB·공유 Git 접근 차단과 전후 hash, 환경·socket 미노출, 외부 TCP·DNS 차단, cgroup·실제 PID/OOM 한도, timeout·출력 초과와 detached child 종료·container 제거 실증. disabled 접속 0회, backend 불가·검증 실패 거부. 보고서는 실행 권한이 아니며 executionEnabled=false 유지. |
| 34 | 고정 합성 patch 계약 (3-C) | 원본 해시·허용 파일·지원 파일 동작 검증. 범위 초과·미지원 파일 동작·경로 탈출을 적용 전에 거부. |
| 35 | 명령·실행 정책 변경 (3-C) | 실행 파일·argv·cwd·환경·네트워크·한도·정책 버전이 승인에 결합. 변경 시 재승인, approval-only-v1 재사용 불가. |
| 36 | 실행 중 무효화·취소·crash (3-D) | 승인 소비 전후·patch·검사 중 변경과 종료를 검증. 프로세스 트리 종료, 자동 재실행 없음, 불변 승인·Run·잔여 diff 보존과 정확한 결과 보고. |
| 37 | 합성 답장 대상·본문·정책 경계 (4-A) | 원래 합성 workspace/channel/thread의 고정 일반 텍스트 단건 계획만 허용. 다른 목적지·임의 본문·멘션·첨부·코드 전문·다른 모드·정책·변조 해시 거부. 실제 Slack·모델·저장소 입력과 네트워크 없음. |
| 38 | 답장 별도 승인·TTL (4-A) | OS UID 소유자·정확한 planHash·필수 정수 TTL 1~60분 확인. 기본값 없음. 승인 만료는 본문/source 만료 이내. 다른 소유자·UID 미지원·활성 중복·기존 코드 승인·만료/취소 승인으로 전송 불가. |
| 39 | 승인 소비와 중복 전송 경합 (4-A) | 승인 소비·SENDING 시도·Task 전환이 원자적. 같은 승인으로 가짜 어댑터를 두 번 호출하지 않고 저장 실패 때 전송 0. SIMULATED 결과·승인 usedAt 보존. |
| 40 | 요청·문맥 변경·취소 (4-A) | 편집·삭제·새 reply·본문/목적지/revision 변조 뒤 기존 승인 차단. 불완전·공백·만료는 승인/전송 불가. 이벤트 중복·다른 payload·역순 revision과 전송 제어 경합에서도 오래된 계획 재사용 없음. |
| 41 | 미전송 실패와 불확실 결과 (4-A) | 확실한 미전송은 NOT_SENT/FAILED·자동 재시도 0이며 새 승인으로만 수동 재시도. UNKNOWN은 새 승인·재전송 금지. 원시 어댑터 오류·민감값 비노출. |
| 42 | SENDING 중단·재시작·명시적 복구 (4-A) | 새 프로세스가 자동 전송하지 않고 유효 문맥의 SENDING을 보존. reply-recover가 UNKNOWN으로 확정하며 반복 복구 멱등·소비 승인 복원 없음·이후 재전송 금지. 별도 만료·무효화도 진행 중 시도를 UNKNOWN으로 차단. |
| 43 | 본문·감사 보관과 만료 후 재생성 (4-A) | 기본 본문 24h·1~168h와 별도 감사 null/1~3650일 검증. 본문은 별도 payload만 존재하고 snapshot·attempt·영속 보고서에 복제 없음. 만료 승인 취소·본문 제거·terminal 감사 정리 뒤 최소 marker로 같은 task ID 재생성 거부. |
| 44 | 답장 CLI·저장 경계와 회귀 (4-A) | 실제 명령·옵션·출력과 소유자·lease·private DB 경계를 검증. plan/inspect 외 stdout에 본문 없음. 기존 조사/실행/Slack 수신 승인과 DB 분리, 대상 전후 상태 불변과 실제 외부 전송 0 유지. |
| 45 | 기본 비활성·진단 입력 경계 (4-B-1) | `liveEnabled=false` 고정, 기본 disabled HTTP 호출 0. 실제 활성화/토큰/본문/대상 입력 옵션 없음. 기존 4-A 계획·승인·코드 승인과 live 모드/추가 필드/변조된 진단 intent 거부. |
| 46 | identity와 최신 합성 문맥 검증 (4-B-1) | auth의 workspace/bot/user 불일치, 원문 revision 변경·새 reply·불완전·만료 때 post 호출 0. 고정 thread·본문·설정·문맥 hash를 다시 검증. 실제 최신성 보장과 구분. |
| 47 | 고정 post 직렬화·receipt 대조 (4-B-1) | 고정 API·JSON channel/thread/text·확장 제한·redirect 거부 검증. channel/message/thread/bot/text가 일치하는 합성 응답만 OFFLINE_CONFIRMED. 실제 전송 성공으로 표시하지 않음. |
| 48 | 미전송과 불확실 결과 (4-B-1) | 확실한 API 거부·rate limit과 post 이후 서버 오류·timeout·malformed·oversized·receipt 불일치·redirect를 구분. 자동 재시도 0, 원시 응답/오류 비노출, 불확실 성공을 미전송으로 단정하지 않음. |
| 49 | 시간·응답 크기 상한 (4-B-1) | 250ms 제한·16KiB 응답 상한을 코드로 강제. 무응답·과대 응답·잘못된 JSON에도 무한 대기/무한 재시도 없음. |
| 50 | 제한 worker·보고서 보관 경계 (4-B-1) | 네트워크·child·상속 토큰 차단, 비공개 경로·보고서 symlink 경계 검증. stdout/report에 본문·토큰·원시 HTTP 자료 없음. 기존 승인 DB/대상 저장소 변경과 실제 외부 전송 0. |
| 51 | CLI 진단과 기존 기능 회귀 (4-B-1) | 지원 fixture·기본 all·옵션 검증·기대 차단 포함 CLI 종료 코드·보고서 passed/failed/not_run 확인. 진단 성공으로 승인/활성화 권한을 만들지 않고 기존 reply/수신/조사/합성 실행 경계 유지. |
| 52 | live 정책·기본 비활성·대상 입력 (4-B-2) | `slack-live-test-v1`·별도 DB와 명시적 활성화. 비활성·잘못된 설정·다른 정책·mock/diagnostic 승인·임의 본문은 auth/thread/post 호출 전 거부. 실제 대상/자격증명 fixture·Git 유입 없음. |
| 53 | 인증·scope·bot identity (4-B-2) | plan/approve/send의 고정 auth 호출과 workspace/bot/user 일치 확인. 읽기/쓰기 최소 권한·토큰 형식·불일치를 차단하고 원시 응답·비밀 비노출. |
| 54 | root 문맥·revision·5초 최신성 (4-B-2) | 고정 원문 root 한 개만 허용. edit/delete/new reply·불완전/페이지 초과·다른 thread·hash/identity 불일치·5초 초과면 승인/POST 0. timestamp는 raw string을 보존. 조회-POST 외부 경합 한계 명시. |
| 55 | 새 live 승인·OS 소유자·TTL (4-B-2) | 설정을 포함한 정확한 계획 hash·목적지/source identity와 OS UID를 묶음. 기본값 없는 정수 TTL 1~60분·계획 24h 만료 이내. 만료/취소/사용/중복/다른 소유자·변조 승인 거부. |
| 56 | 원자 claim·다중 작업 중복 차단 (4-B-2) | 승인 소비+SENDING 시도+작업 상태를 원자 저장한 뒤 POST. 저장 실패·동시 send는 호출 0 또는 최대 1. SENT/UNKNOWN 대상 marker가 다른 task ID와 동등한 timestamp 표현의 새 plan·승인·전송을 막음. |
| 57 | 요청·receipt·실패 분류 (4-B-2) | 정확한 API·channel/thread/plain text·확장 제한과 새 message ts/bot/body receipt 검증. 명백한 거부만 NOT_SENT, POST 후 timeout/5xx/redirect/malformed/oversized/불일치는 UNKNOWN. 요청 10초·응답 32KiB·재시도 0. |
| 58 | SENDING 중단·명시적 복구 (4-B-2) | 재시작 자동 전송 없음. recover가 SENDING→UNKNOWN과 대상 marker를 영속 저장하고 소비 승인 복원·재승인·새 plan 없음. 반복 복구 멱등. |
| 59 | 원문/본문 비저장·감사 정리 (4-B-2) | DB·승인 snapshot·시도·영속 보고서에 Slack 원문·고정 본문·token·원시 HTTP 없음. 계획 유효 24h 내 상수 본문 재구성, terminal 감사 30일 정리 뒤 SENT/UNKNOWN 대상 marker 유지. |
| 60 | CLI·TTY·worker·파일 경계 (4-B-2) | 실제 명령/옵션·기본 거부·숨김 입력·정적 오류·private DB·경로/symlink 검증. 네트워크/token은 plan/approve/send만 받고 읽기·제어 명령에는 없음. 하위 프로세스와 불필요한 호스트 환경 차단. |
| 61 | 전역 lease·기존 기능 회귀 (4-B-2) | 실수신 lease 중 live 변경 명령 거부·저장 상태 불변. 기존 조사/실행/mock/diagnostic DB와 권한 분리, 대상 제품 저장소 전후 불변. 외부 호출 없는 합성 수용과 실제 게시를 구분. |
| 62 | 승인된 단건 실제 게시 (4-B-2) | 구체 대상·고정 본문·계획 해시·TTL의 별도 소유자 승인 뒤 실제 receipt와 스레드 단건 확인. 승인 전·환경 미확정·미실행은 not_run. 회사 운영·자동 답장·게시 후 삭제는 별도 범위. |
| 63 | 작업 유형과 합성 계획 (4-C-1) | feature/fix/chore/refactor별 브랜치 계획, 고정 source·diff·정책 hash 검증. 임의 경로·원격·명령·추가 필드·기존 승인 policy/mode·잘못된 JSON 구조 거부. |
| 64 | 별도 승인과 TTL (4-C-1) | OS UID·정확한 계획 hash·필수 정수 TTL 1~60분과 24h 계획 만료 확인. 소유자·활성 중복·만료·변조 거부와 만료 이력·페이지 조회. |
| 65 | 원자 소비·1회 모의 실행 (4-C-1) | 승인 소비+SIMULATING+시도 원자 저장. 동시 claim 최대 한 번, 저장 실패 adapter 0회, 기존 승인 DB 불변. |
| 66 | 결과와 재시도 금지 (4-C-1) | 성공 SIMULATED·충돌 NOT_CREATED/FAILED·기준 변경 BLOCKED·불확실 UNKNOWN 구분. 원시 오류 비노출과 작업당 시도 한 번, 실제 Git 성공으로 표시하지 않음. |
| 67 | 요청 변경·취소·경합 (4-C-1) | 편집/삭제/base/diff/branch 변경은 승인 무효화. event 멱등·다른 payload 거부·역순 revision 무시. 진행 중 제어는 UNKNOWN 보존, 늦은 성공으로 덮어쓰기 없음. |
| 68 | 중단·새 프로세스 복구 (4-C-1) | 실제 child 강제 종료 후 SIMULATING/소비 승인 보존, 시작·조회 자동 실행 없음. 명시적 recover로 UNKNOWN 확정, 반복 복구 멱등과 재승인·재실행 차단. |
| 69 | CLI·worker·파일 경계 (4-C-1) | 실제 명령/필수 옵션·전역 lease·비공개 DB/sidecar·symlink/hardlink·출력 제한, worker의 네트워크/child/호스트 토큰 차단 검증. |
| 70 | 외부 효과 없음과 회귀 (4-C-1) | 별도 합성 대상의 전후 파일/Git 상태 동일. 실제 저장소·Codex·Git 원격 호출 없음, commit/push/PR/MR 명령 없음, 기존 조사·실행·Slack 경계 유지. |
| 71 | 독립 합성 저장소 준비와 소유 identity (4-C-2) | source/workspace가 고정 파일·초기 커밋으로 각각 생성되고 `.git`·객체·hardlink 공유 없음. 기존 경로 재초기화·실제 저장소 입력 거부. private root·소유 manifest·token과 정확한 root 검증. |
| 72 | 네 유형과 실제 ref 생성 (4-C-2) | feature/fix/chore/refactor의 계획한 ref만 생성하고 Git 조회의 OID가 기준 커밋과 일치. source·main·HEAD·기존 파일/Git metadata 전후 동일, checkout·코드 수정 없음. |
| 73 | 새 정책·별도 승인·TTL (4-C-2) | 4-C-1 및 기존 승인 재사용 거부. OS UID·정확한 계획 hash·필수 TTL 1~60분·24h 계획 검증, 만료·취소·변조·활성 중복 차단. 승인 전 ref 생성 없음. |
| 74 | 충돌·기준 변경·배타적 생성 (4-C-2) | 같은 OID를 포함한 기존 ref를 덮어쓰지 않음. source/main/HEAD/객체/index/config/hash 변경과 임의 ref·packed-refs를 생성 전에 차단. 배타적 ref 생성 경합에서 중복 쓰기 없음. |
| 75 | 경로·파일·관찰 한도 (4-C-2) | 경로 탈출·부모/파일 symlink·hardlink·잘못된 권한·추가 비밀 파일·과대 파일/엔트리를 차단. 예상 밖 본문/이름·원시 오류 비노출. 빈 유형 디렉터리 absent·부분 ref unsafe 구분. |
| 76 | 원자 claim과 영속 단계 (4-C-2) | 승인 소비+RUNNING+claimed 원자 저장, 저장 실패 시 ref 쓰기 없음. writing/created/finished와 시각·전후 관찰을 보존하고 작업당 시도 한 번, 소비 복원 없음. |
| 77 | 취소 fence와 완료 경합 (4-C-2) | 대기 취소는 승인 revoke와 CANCELLED 원자 처리. RUNNING 취소는 generation fence를 세워 새 쓰기를 막고 이미 생성한 ref는 보존. 늦은 성공이 취소를 덮어쓰지 않음. CLI lease 경합과 내부 제어 검증을 구분. |
| 78 | 강제 종료·명시 복구 (4-C-2) | ref 생성 전후 실제 child 강제 종료 뒤 새 프로세스가 RUNNING·승인 소비·단계 증거를 보존. recover는 현재 ref 관찰과 함께 INTERRUPTED/CANCELLED/BLOCKED로 기록하며 자동 재실행·성공 소급·수리·삭제 없음. |
| 79 | CLI·worker·DB 경계 (4-C-2) | 실제 git-branch 명령/필수 옵션·private DB/sidecar·OS 소유자·최소 환경·권한·출력 한도·전역 lease 검증. 임의 경로/명령·token·Codex·checkout·commit·push·PR/MR 입력 없음. |
| 80 | 기존 경로 보존과 회귀 (4-C-2) | 4-C-1 및 조사·실행·Slack DB/승인 재사용 없음, 기존 기능 회귀 통과. 합성 fixture 초기 커밋과 실제 작업 결과 commit을 구분하며 회사 저장소·외부 연결·코드 실행은 not_run. |
| 81 | 새 계획·승인·정책 분리 (4-C-3) | branch/HEAD·owner/sourceRoot·24h 기한·기준·patch·검사·Docker 정책을 hash에 결합. 필수 TTL 1~60분, 기존/새 정책 양방향 거부와 별도 DB/작업 경로 검증. |
| 82 | 네 작업 브랜치 선택과 기준 보존 (4-C-3) | 네 유형의 실제 ref와 HEAD 선택, source/main/기준 커밋 보존, 승인 전 작업 ref·코드 변경 없음. 충돌 시 덮어쓰기·reset 없음. |
| 83 | 고정 patch·실제 diff·검사 연결 (4-C-3) | 승인된 1파일만 교체하고 정확한 before/after hash·diff를 보고. Git 없는 읽기 전용 view의 등록 검사로 정상과 검사 실패를 구분. |
| 84 | 범위·경로·Git 변조 차단 (4-C-3) | source/worktree/HEAD/ref/main/객체·비허용 파일·링크·권한·한도 변경을 차단하고 예상 밖 본문·원시 오류를 노출하지 않음. |
| 85 | 원자 소비와 단계 증거 (4-C-3) | 단일 승인/Run/claimed, workspace_preparing 의도 뒤 브랜치 준비·완료 뒤 불변 Git 증거. 저장 실패·중복 run·중간 실패 시 소비 복원·자동 재실행 없음. |
| 86 | 제어·완료 경합 (4-C-3) | 취소/편집/삭제의 generation fence, patch/검사 dispatch/완료 전 재검증, 동일 제어 멱등, 늦은 성공 차단 및 자기 container만 정리. |
| 87 | 실제 process 중단·재시작 복구 (4-C-3) | 브랜치 준비·patch·검사 단계 강제 종료 후 영속 Git/파일/소유 container 증거로 INTERRUPTED/CANCELLED/BLOCKED 구분. 부분 작업물 보존과 재실행 금지. |
| 88 | CLI·보고·lease·입력 경계 (4-C-3) | branch-execution 명령/필수 유형·TTL·정확한 source/아티팩트 경로, inspect/제어 lease 우회와 실행 lease 유지, DB·보고서 안전성, 임의 실행 입력 거부. |
| 89 | 실제 Docker 통합 (4-C-3) | 승인된 로컬 backend에서 정상/검사 실패/취소/강제 종료 복구, 원본과 main 보존, 네트워크 없는 readonly 검사·정리 확인. 모의 backend 통과와 구분. |
| 90 | 기존 계약 보존 (4-C-3) | 기존 3-C/D·4-C-1/2·조사·Slack 전체 회귀 통과, 기본 ExecutionPort 거부·기존 승인 경계 유지. 실제 Codex/회사 연결/결과 commit/push/PR/MR not_run. |
| 91 | 두 정책·두 승인·DB 분리 (4-C-4) | 호출 `synthetic-codex-proposal-v1`과 실행 `synthetic-codex-execution-v1`, 별도 DB/작업 경로·기존 승인 재사용 거부. 호출 승인이 수정·검사 권한이 되지 않음. |
| 92 | 고정 전송 입력·계획·TTL (4-C-4) | 실제 전송할 합성 입력/hash·모델·인증방식·목적지·한도 표시. UUID/OS UID/type/inputHash/configHash/24h를 planHash에 결합, 필수 TTL 1~60분·현재시각·설정변경 차단. |
| 93 | 원자 호출 소비·1회 제한 (4-C-4) | usedAt+RUNNING+단일 attempt 원자 저장, 동시 claim·저장 실패 rollback·만료/취소/재사용 거부. 실패·중단 후 동일 제안 재호출 없음. |
| 94 | 정확한 JSON과 출력 한도 (4-C-4) | path/content만 허용, 중복·추가 키/잘못된 JSON·경로·8KiB 내용·16KiB 응답·비밀·NUL·잘못된 Unicode·무변경 거부. 유효 responseHash만 보관, invalid 원문·token·원시 오류 비노출. |
| 95 | 선택한 인증과 자식 비밀 차단 (4-C-4) | 사용자 선택 기존 ChatGPT 로그인 또는 전용 API 키를 부모만 읽고 검증. credential 복제·refresh·기존 HOME/config/hooks/MCP 상속 없음, 자식은 빈 HOME와 난수 capability만 받음. |
| 96 | 고정 broker와 단일 upstream (4-C-4) | capability·고정 POST 경로, 병렬/반복 요청 차단, 부모가 승인 입력·모델·schema·tools=[] body 재구성. 목적지 고정·redirect/재시도 없음·256KiB 입력/응답 한도·원시 토큰 비노출. |
| 97 | native CLI 고정과 실제 SBPL 진단 (4-C-4) | macOS arm64·0.154.0·SHA-256·실행 경로/권한 검증. 외부 profile의 canary 읽기·영역 밖 쓰기·추가 exec·다른 TCP/Unix socket 거부와 broker 접속 확인. |
| 98 | 호출 취소·부모 종료·복구 (4-C-4) | generation으로 늦은 응답 차단, 60초/128KiB 제한, IPC guardian의 SIGKILL과 child/broker 종료 확인. 재시작 RUNNING 보존→명시 INTERRUPTED, 소비 복원·자동 재호출 없음. |
| 99 | READY 단일 내보내기와 경합 (4-C-4) | EXPORTED commit 후 한 번 반환, 경합·취소·만료·설정변경·중복 거부. export 저장 실패 rollback, commit 후 실행 계획 생성 중단은 소비 유지. |
| 100 | 제안 provenance와 새 실행 승인 (4-C-4) | 같은 UUID·입력/응답/설정 hash·validatorVersion과 실제 patch·브랜치·기준·Docker 정책을 새 계획에 결합. 별도 소유자 승인 전 source 준비 외 수정·검사 없음. |
| 101 | 실제 브랜치·Docker·Git 보존 (4-C-4) | 승인한 제안 한 파일만 하네스가 적용, source/main·Git 증거 유지. Git 없는 readonly Docker 검사·실제 diff·검사 실패·취소·강제 종료 복구, 호스트에서 제안 코드 실행 없음. |
| 102 | 실제 호출·경고 한계·기존 회귀 (4-C-4) | 단건 실제 Codex/모의 port/격리 probe/실제 Docker 결과 분리, 정확한 metadata fallback 경고만 예외·도구/다른 오류 거부. 기존 회귀·승인 경계 유지, 회사 자료·원격·결과 commit·PR/MR 미실행. |
| 103 | 합성 다중 파일과 기준 고정 (4-C-5) | 등록된 fixture의 여러 파일 근거를 수집하고 repo·commit·manifest identity 일치 확인. 임의 root/remote·추가 파일·기준 변경은 거부. |
| 104 | 읽기·전송·수정 권한 분리 (4-C-5) | 읽기 목록의 일부만 전송해도 정확히 선택된 근거만 전달. writeAllowedFiles=[]·testCommandIds=[]·executionAllowed=false 강제, 변경 요청·모델 제안으로 권한 확대 불가. |
| 105 | 경로·파일·교체 경합 (4-C-5) | 범위 밖 경로·부모/파일 symlink·hardlink·특수 파일·잘못된 UTF-8·바이너리·파일 교체를 차단. 비허용 본문이 snapshot·모델·로그에 없음. |
| 106 | 비밀 검사와 합성 fixture (4-C-5) | 요청 줄 밖의 비밀 패턴도 파일 전체 거부. 실제 발급 토큰 없이 합성 패턴으로 검증하고 원문·인증 값이 오류·보고서·Git에 유입되지 않음. |
| 107 | 파일·구간·바이트 한도 (4-C-5) | 8파일·16구간·구간당 200줄·파일당 32KiB·근거 합계 64KiB·입력 128KiB·출력 16KiB의 경계값/초과값 검증. 중복 구간 정규화, 무통보 절단 없음. |
| 108 | snapshot 결정성과 원본 무변경 (4-C-5) | 동일 입력의 근거/전체 hash 재현, 파일·줄·순서·본문 변조 감지. 정상·실패·취소 전후 원본 파일/권한/링크/Git 동일, 대상 코드·명령 실행 0. |
| 109 | 검토한 내용과 실제 전달 일치 (4-C-5) | 표시된 지시문·요청·근거·schema와 모의 port가 받은 본문이 byte/hash 일치. 절대 호스트 경로·미선택 근거·도구·임의 목적지 추가 불가. |
| 110 | 신규 승인·만료·정책 변경 (4-C-5) | OS 소유자·planHash·24h 계획·명시적 1~60분 TTL 검증. 요청/commit/파일/줄/정책/모델/목적지 변경과 만료·위조·구형 승인·mock 승인으로 live 호출을 소비 전 거부. |
| 111 | 승인 소비·호출 중복·실패 (4-C-5) | 승인 전 모델 호출 0, 동시 요청의 단일 소비·attempt와 최대 1회 전달, DB 실패 시 전달 0. timeout·실패·전송 불확실 후 자동 재시도·승인 복원 없음. |
| 112 | 악성 자료와 범위 확대 (4-C-5) | README·주석·요청의 정책 무시/전체 파일 전송/쉘 지시가 도구·권한·전송 범위를 바꾸지 않음. 추가 근거 요청은 로컬 확인 사항으로만 남고 자동 추가 읽기·호출 없음. |
| 113 | 보고서 schema·근거 정확성 (4-C-5) | 존재하는 근거 ID·승인 줄만 인용하고 사실·가설·확인 불가 구분. 허구 경로/줄·중복/추가 키·비밀·과대 출력·실행 필드 거부. 모의 결과와 의미 검증의 한계 표시. |
| 114 | 실행 경로 연결 차단·구형 계약 보존 (4-C-5) | 비어 있는 수정 범위 유지, 조사 결과의 export·patch·브랜치·명령·Slack/Git 작업 0. 구형 allowedFiles/hash/승인 자동 변환 없음, 기존 조사·4-C-4와 상호 정책 재사용 거부. |
| 115 | 취소·변경·중단 복구 (4-C-5) | 승인/전달/응답 경계의 취소와 generation 경합, 늦은 성공 차단. 실제 로컬 worker 강제 종료 뒤 새 프로세스 복구·중복 전달 없음, 정리 불확실은 BLOCKED. |
| 116 | payload 보관·출력 경계 (4-C-5) | private DB/snapshot/report·경로/링크 보호, payload 24h 후 조회·호출 거부와 정리. 최초 terminal 전환부터 감사 30일·조회/복구로 연장 없음·중복 marker 보존, 원본 자동 삭제 없음, 로그/승인 snapshot에 본문·인증 값 없음. |
| 117 | 오프라인 CLI·회귀와 구현 상태 (4-C-5) | 구현한 명령·필수 옵션·허용 fixture만 문서화. lint·typecheck·단위/통합/수용 회귀 결과 기록, 신규 native 검사는 별도 표시. 실제 외부 호출 0이며 미구현·미실행을 성공으로 표기하지 않음. |
| 118 | 실제 모델 검증의 별도 조건 (4-C-5) | 필수 모의 검증에서 live 기본 비활성·기존 승인 재사용 거부·정확한 snapshot broker 구성과 격리 경계 확인. 선택 live 실증은 별도 승인 후 1회 전달·근거 결과·원본 무변경을 기록하고 미수행 시 not_run. |
| 119 | 오프라인 전용 연결과 기본 거부 (4-C-6) | 가짜 transport 필수, 누락/잘못된 설정은 거부. 실제 adapter·credential loader·환경 토큰 탐색·모델 CLI·외부 연결 경로 실행 0, fallback 없음. |
| 120 | 기존 계약과 권한 분리 (4-C-6) | 새 offline 정책/저장소/승인 분리. 기존 4-C-5/4-C-4 해시·DB·승인 자동 변환 없음. 등록 합성 fixture·선택 근거만 사용, writeAllowedFiles=[]·testCommandIds=[]·executionAllowed=false 유지. |
| 121 | 최종 요청 구성과 해시 일치 (4-C-6) | contextHash/inputHash/requestBodyHash 범위 구분, 모델·지시문·schema·tools/store/stream 포함 결정적 직렬화. 검토/저장/전달 바이트 일치, 재직렬화·본문 교체·field 누락/추가 거부. |
| 122 | 입력 최소화와 악성 지시 (4-C-6) | 전체 읽기 중 선택 근거만 요청에 포함. 절대 호스트 경로·Git metadata·미선택 발췌·비밀 제외. 자료/worker의 추가 파일·모델·도구·목적지 지시가 요청/권한을 바꾸지 않음. |
| 123 | 직렬화·응답 한도 (4-C-6) | 기존 수집/입력 한도와 wrapping 후 요청256KiB·전체 응답256KiB·최종 JSON16KiB의 경계/초과 검증. Unicode/escaping·분할 stream의 실제 바이트 검사, 무통보 절단 없음. |
| 124 | 승인·모드·TTL 결합 (4-C-6) | OS 소유자·명시 TTL1~60분·계획/payload 최대24h·실제 dispatch 시각 검증. 세 hash·profile/schema/serializer/config·모드/목적지 변경과 구형/mock/live 승인 혼용을 소비 전 거부. |
| 125 | 단일 소비와 DB 실패 (4-C-6) | 승인/예약 commit 전 fake 전달0회, 동시 claim/dispatch는 attempt 하나·최대1회 전달. DB rollback·실패·전달 불확실·재시작 뒤 승인 복원/자동 재시도 없음. |
| 126 | 전용 broker와 가짜 transport 계약 (4-C-6) | 부모가 승인한 최종 본문만 전달. worker가 보낸 임의 body/model/tools/URL/header를 중계하지 않음. 정상/지연/오류를 fake로 재현하고 실제 transport 미선택을 확인. |
| 127 | 응답 envelope·stream 거부 기준 (4-C-6) | 잘못된 UTF-8/JSON·중복/추가 키·불완전/중복 완료·여러 최종 응답·도구·redirect·다른 profile을 거부. 거부된 raw/부분 응답의 로그·DB/payload 비보관, 실패 후 재전달0회. |
| 128 | 조사 schema·근거·표시 (4-C-6) | 전달한 근거 ID와 포함된 줄만 인용, 허구 경로·실행 필드·decoded 비밀 거부. offline/fake/synthetic 결과와 의미 정확성 미검증, 실제 모델/인증/공급자 호환성 not_run 표시. |
| 129 | 취소·무효화·시간 초과 (4-C-6) | 승인/claim/전달/응답/저장 경계의 generation 경합, 60초 timeout, 늦은 성공과 payload 부활 차단. 종료 확인 전 성공 처리 없음, 정리 불확실 BLOCKED. |
| 130 | 실제 로컬 중단과 복구 (4-C-6) | fake worker를 포함한 실제 부모 강제 종료 뒤 새 프로세스에서 RUNNING·소비 보존. requestBodyHash·원본/Git·종료 증거 확인 후 INTERRUPTED, 만료/변조/누락/불확실 BLOCKED, 재호출0회. |
| 131 | worker 격리와 인증정보 경계 (4-C-6) | Node 권한으로 비허용 파일 읽기·쓰기·네트워크·추가 프로세스/worker 차단 실증. 상속 환경/실제 credential 접근 없음, source/DB 경로와 비밀이 worker·요청·일반 로그에 없음. |
| 132 | payload·감사·보관 (4-C-6) | private 경로/권한/링크, 내용·승인 기록 분리. 생성+24h 내용 만료/정리, 최초 terminal+30d 감사·DB 수명 marker, 조회/복구로 연장 없음·진행 중 자동 삭제/원본 자동 정리 없음. |
| 133 | 구형 회귀와 구현 상태 (4-C-6) | 기존 583개와 신규 단위/통합/수용 회귀, lint·typecheck·build 결과 기록. 구현한 CLI만 문서화하고 fake 검증을 실제 연결 완료로 표시하지 않음. |
| 134 | 오프라인 종단 완료 (4-C-6) | 문의/변경 요청·일부 근거 전송·실패/취소/복구에서 원본/Git 무변경, fake 전달 최대1회·재시도0회. 실제 모델/인증 접근/외부 전송/대상 코드·명령 실행0, 후속 live·실제 저장소는 범위 밖. |
| 135 | 오프라인 전용과 기존 계약 보존 (4-C-7) | 새 정책/DB/승인 namespace, 필수 in-memory fake, live/구형/4-C-5/4-C-6 승인 혼용 거부. 실제 transport/credential loader/SDK/CLI import·호출 경로 없음, 누락/실패 시 fallback0, 기존 계약·hash·DB 무변경. |
| 136 | 연결 후보 profile 고정 (4-C-7) | 로컬 근거 경로/hash와 지원 필드/이벤트 fixture를 고정. 등록 JSON/SSE profile만 허용하며 정책/codec/schema/한도 변경은 hash·승인에 반영. 임의 profile 파일·URL·모델·헤더·환경 override 거부, 실제 공급자 호환성 not_run. |
| 137 | 읽기·전달·수정 권한과 최소 입력 (4-C-7) | 새 합성 문맥의 허용 파일/줄·선택 근거만 사용, 미선택 본문/호스트 경로/Git metadata 제외. writeAllowedFiles=[]·testCommandIds=[]·executionAllowed=false 유지. 악성 자료로 추가 읽기·도구·후속 호출·실행 export 불가. |
| 138 | 후보 요청 encoder (4-C-7) | 선택 입력을 input·조사 schema를 text.format으로 구성하고 tools/store/stream 고정. patch schema·구형 responseFormat·추가 대화/도구 필드 거부. 독립 golden 바이트로 Unicode/escaping·필드 누락/추가·결정적 직렬화와 정확한 requestBodyHash 검증. |
| 139 | 인증 없는 요청 명세·해시 (4-C-7) | context/input/body/profile/envelope hash 범위를 분리하고 method·시험 URL·헤더·전달 정책을 승인에 결합. 표시/저장/fake 포착 명세 일치, 중복/CRLF 헤더·모호한 URL·Authorization/Cookie/계정/proxy 값·본문 또는 명세 변조 거부. |
| 140 | 승인·만료·변경 재검증 (4-C-7) | OS 소유자·planHash·명시 TTL1~60분·계획/payload24h·dispatch 현재 시각 검사. 원본/revision·다섯 hash·profile/config·모드 변경, hash 재계산 변조, 만료·취소·위조 승인을 소비 전 거부. |
| 141 | 원자 소비·단건 fake 전달 (4-C-7) | 승인/attempt/명세 예약 commit 전 전달0, 동시 run도 최대1회. DB 실패·예약 후 crash·전달 불확실 시 소비 유지·자동 재전달/승인 복원0. worker가 임의 HTTP 요청을 전달시키지 못함. |
| 142 | HTTP 상태·헤더·오류 처리 (4-C-7) | profile별 status/MIME/encoding/body 조건 확인. 3xx/Location·401/403·429/Retry-After·5xx·중복/모순 헤더·미지원 압축/charset·누락 body 거부. redirect·인증 갱신·retry·fallback0, 원시 오류 비보관. |
| 143 | JSON 응답 후보 decoder (4-C-7) | 독립 fixture로 완료 상태·모델·허용 metadata/output·assistant text 한 건 확인. 잘못된 UTF-8/JSON·중복/추가 키·도구/refusal·실패/불완전·복수 text·ID 형식/내부 참조 불일치 거부. 추출 후 조사 schema·전송 근거/줄·raw/decoded 비밀 검증. |
| 144 | SSE frame·이벤트·최종 일치 (4-C-7) | 독립 fixture로 LF/CRLF·여러 data 줄·임의 chunk/UTF-8 분할 처리. 시작에서 확정한 ID·event/type·순서·delta/최종 text 일치, 미지원/도구 이벤트·완료 중복/누락·완료 후 data·잘린 frame·[DONE] 거부. 주석/빈 frame 계수 후 무시, NDJSON 혼용·자동 재연결 없음. |
| 145 | 명세·헤더·stream 자원 한도 (4-C-7) | 입력128KiB·본문256KiB·명세272KiB·요청/응답 헤더 각8KiB/16개·응답 body256KiB·SSE frame64KiB/2,048개·최종JSON16KiB·stderr16KiB·전체60초(전달/응답55초+정리5초)의 경계/초과 검사. 주석/빈 frame·멀티바이트·분할 초과도 계수, 무통보 절단 없음. |
| 146 | 취소·timeout·늦은 응답 (4-C-7) | claim/전달/headers/frame/최종 저장 경계 generation 경합 검증. abort 후 iterator 정리·worker 종료 확인, abort 무시/return 미완료도 최대5초 뒤 BLOCKED, 늦은 chunk/완료와 payload 부활 거부·재전달0. |
| 147 | 실제 로컬 중단·새 프로세스 복구 (4-C-7) | 부모/worker 강제 종료 후 RUNNING·소비 보존. recover가 원본/Git·profile/envelope/body hash·종료 증거를 검증해 INTERRUPTED/BLOCKED 기록. 만료·변조·누락·살아 있거나 재사용된 PID에 보수적 거부, 추측 종료·재호출0. |
| 148 | 격리·인증정보 비접근 (4-C-7) | 합성 canary로 제한 worker의 비허용 읽기/쓰기·네트워크·child/worker 차단 실증. 신규 경로의 credential/config 탐색·실제 transport 호출0과 환경 비상속 확인. 실제 인증 경로 존재 확인/값 읽기·TCP/UDP/listener/DNS/외부 연결0(사전 구성 stdio/로컬 IPC 제외), live OS 격리 실증은 not_run. |
| 149 | 보관·보고서·live 승격 차단 (4-C-7) | private 권한/링크 보호, 내용24h·최초 terminal 감사30일·DB 수명 marker 유지. raw/부분/거부 응답 비보관, 조회/복구로 기한 연장·원본 자동 정리 없음. offline/fake/synthetic·semanticAccuracyVerified=false·liveReady=false·제외 항목 not_run, live 설정/승인 export 없음. |
| 150 | CLI·회귀·오프라인 종단 완료 (4-C-7) | 문의/변경 요청·부분 근거·JSON/SSE·실패/취소/복구를 검증. 기존642개+신규 회귀·lint/typecheck/build의 실제 결과와 구현 CLI 기록. 원본/Git 무변경·대상 실행/실제 모델/인증 접근/외부 전송0, fake 최대1회·retry0, 미구현·미실행을 passed로 표시하지 않음. |

| 151 | 새 live 계약과 기존 단계 보존 (4-C-8) | 새 정책/DB/승인 namespace, 고정 profile/model/endpoint/auth/config 결합. 4-C-4/5/6/7 계약·승인·해시·DB 혼용·live 승격 거부, 기존 명령 보존. |
| 152 | 합성 읽기·전송·수정 범위 (4-C-8) | 등록 flow·선택 파일/줄·전송 근거만 허용. 미선택 본문·호스트 경로·Git·비밀 배제, 악성 자료의 범위 확대 거부, 빈 수정/검사 범위 유지. |
| 153 | 검토 본문과 실제 전송 일치 (4-C-8) | 입력·최종 본문·인증 없는 명세와 다섯 hash·설정/격리 정책 표시. 승인 후 재직렬화/교체/override 거부, 실제 adapter 포착 바이트와 승인 내용 일치. |
| 154 | 승인·TTL·소비·동시성 (4-C-8) | OS 소유자·필수 TTL1~60분·계획24h·dispatch 현재 시각·원본/revision/config 확인. 원자 claim/예약 전 인증·전송0, 동시 호출 최대1회, rollback/중단 뒤 소비 복원 없음. |
| 155 | 인증의 지연 접근과 비노출 (4-C-8) | 승인된 run adapter에서만 기존 로그인 사용, 다른 명령 인증 조회0. refresh/복제/변경·환경 토큰 탐색0, 자식/본문/로그/DB에 실제 인증값0, 인증 실패 정적 오류. |
| 156 | 실제 연결 격리와 종료 (4-C-8) | 고정 native binary·빈 HOME·OS profile·단건 broker·guardian. 합성 canary로 비허용 읽기/쓰기/추가 실행/네트워크를 차단하고 부모 중단 후 종료·소유 모델 임시 디렉터리 제거 확인. 다른 inode·루트 symlink 거부 및 하위 symlink 대상 보존. 실제 실행한 검사만 passed. |
| 157 | 공급자 응답과 조사 검증 (4-C-8) | 고정 SSE live 계약의 완료·허용 metadata/이벤트·한도·assistant text 한 건을 검증. 도구·refusal·오류·추가 출력·허구 인용·비밀·실행 필드 거부, raw/부분/거부 응답 비보관. |
| 158 | 단건 전달·취소·timeout (4-C-8) | 최대1회·retry/redirect/fallback0, generation·늦은 결과 차단·종료 확인. 원격 접수/중지 불확실성을 로컬 정리 성공과 구분, 실패 뒤 같은 작업 재호출0. |
| 159 | 중단과 재시작 복구 (4-C-8) | 실제 로컬 프로세스 중단 뒤 소비 유지, 원본/Git·profile/body/envelope hash·프로세스 종료·모델 임시 디렉터리 부재 확인. 전달 예약 뒤 CANCELLED도 재검증하며 불확실 BLOCKED 구분, recover 인증·모델·전송0. |
| 160 | private 보관과 보고 사실성 (4-C-8) | DB/sidecar·설정 링크/권한 보호, 내용24h·최초 terminal 감사30d·소비 marker. 모의/실제 응답 근거 분리, 대상 무변경·실행false, 의미 정확성 미검증·제외 항목 표시. |
| 161 | CLI·기존 회귀 (4-C-8) | 8개 명령·필수 config/TTL·strict 옵션·lease·조회/취소·구형 승인 거부. 기존726개+신규 검사, lint/typecheck/build 실제 결과 기록. |
| 162 | 구체 승인된 실제 단건 조사 (4-C-8) | 최종 입력·profile·범위 승인 후 실제 호출 최대1회, 전송hash·근거 인용·불확실성·원본/Git 보존과 로컬 보고 확인. 미승인/미실행이면 not_run. 회사 자료·실제 저장소·Slack·대상 실행·Git 원격0. |

### 최종 검증 묶음

lint, typecheck, 단위 테스트, 통합 테스트, 수용 테스트를 각각 실행하고 결과를 남긴다. 집의 모의 테스트 통과는 실제 Slack 권한이나 회사 보안 검토 통과를 뜻하지 않는다. 실환경 연결 검증과 실행기 격리 검증은 별도 항목으로 완료 처리한다.

초기 출시 기준은 모의 데이터에서 전체 흐름이 재현되고, 승인 전 제품 파일 변경과 승인 없는 외부 전송이 모두 0인 상태다. 실제 회사 연결은 회사 승인과 별도 검증이 끝난 뒤에만 진행한다.

## 9 Codex에 전달할 첫 구현 지시

아래 내용을 첫 작업의 지시문으로 사용한다. 전체 계획을 참고하되, 첫 실행에서는 단계 0과 단계 1의 모의 흐름까지만 만든다. 실제 Slack이나 회사 자료 연결, 코드 변경 실행은 후속 단계로 남긴다.

### 첫 작업 지시문

TypeScript와 NestJS로 work-assistant-harness 저장소의 첫 버전을 만들어 주세요. 저는 개념을 먼저 이해하면서 진행하고 싶습니다. 먼저 아래 흐름과 구조를 짧게 설명하고, 최소 단위로 구현해 주세요. 이미 저장소가 있으면 관련 지침과 기존 구조를 확인하고 보존하세요.

목표는 Slack에서 제 고정 사용자 ID가 멘션된 요청을 받아 문의, 변경 요청, 불명확으로 분류하고, 허용된 저장소를 읽기 전용으로 조사해 저에게 결과를 보여 주는 개인 업무 하네스입니다. 첫 버전에서는 실제 Slack, 실제 AI 서비스, 회사 저장소를 연결하지 마세요. 가짜 이벤트, 합성 NestJS 예제 저장소, 고정 응답 모델로 실행되게 해 주세요.

NestJS application context를 사용하는 CLI로 시작하고, 도메인 규칙과 서비스 어댑터를 분리해 주세요. MessageSource, ModelPort, RepoReadPort, ApprovalPort, ExecutionPort, ReportSink를 교체 가능하게 두세요. 과한 프레임워크, Redis, 대시보드, 다중 에이전트 구성은 먼저 넣지 마세요.

현재 구현할 범위는 이벤트 정규화, ID 기반 멘션 필터, 중복 제거, 세 가지 분류, 읽기 전용 파일 근거 수집, 보고서 생성, SQLite 작업 저장입니다. 수정 요청도 계획만 만들고 AWAITING\_APPROVAL에서 멈춰야 합니다. ExecutionPort의 기본 구현은 항상 거부해야 합니다. 하네스 자체의 개발과 검증 명령은 실행하되, 대상 제품 저장소의 변경과 스크립트 실행, 외부 메시지 전송과 Git 원격 작업은 하지 마세요.

모델 출력은 JSON 스키마로 검증하고 권한으로 사용하지 마세요. Slack 본문과 저장소 내용은 외부 자료로 취급하세요. 허용 경로 검사, symlink와 경로 탈출 방지, 비밀 파일 제외, 파일과 출력 크기 제한을 코드로 구현하세요. 실제 토큰과 회사 데이터는 커밋하지 마세요. 예시 설정에는 가짜 값만 넣으세요.

문의, 변경 요청, 불명확, 잘못된 JSON, 중복 이벤트, 다른 사용자 멘션, 비허용 채널, 경로 탈출, 악성 지시를 fixture와 테스트로 제공해 주세요. 조회 전후 제품 저장소 해시 또는 diff를 비교하여 읽기 단계에서 아무 파일도 바뀌지 않는지 검증하세요. 프로그램 재시작 후 작업 기록도 유지되어야 합니다.

README에 개념과 실행 방법을, docs에 구조와 보안 경계 및 회사 도입 전 점검표를 작성해 주세요. 각 패키지의 현재 안정 버전과 런타임 호환성을 확인하고 버전 및 lockfile을 고정해 주세요. 외부 SDK나 CLI의 존재와 옵션을 추측하지 마세요.

마지막에 만든 파일, 실행한 검사와 결과, 실행하지 못한 검사, 남은 위험, 다음 단계의 최소 작업을 정리해 주세요. 첫 버전 성공 여부는 실제 외부 연결이 아니라, 모의 흐름 재현과 승인 전 제품 저장소 무변경 및 외부 전송 0으로 판단합니다.

### 이후 작업을 요청하는 순서

단계 1 이후에는 단계 2의 수신 계약·오프라인 복구 테스트와 기본 비활성 연결 어댑터를 만든다. 실제 Slack 연결은 별도 회사 승인과 승인된 테스트 워크스페이스가 준비된 뒤 검증한다. 승인 모델·로컬 승인 명령과 격리 실행은 단계 3 기능이다. 실행 연결 없는 만료·취소·1회 소비·계획 및 커밋 불일치 테스트만 선택적으로 선행 보강할 수 있다. 각 단계의 권한 경계와 실패 테스트가 통과하기 전에는 다음 단계로 넓히지 않는다.
