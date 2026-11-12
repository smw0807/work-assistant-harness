# 구조와 흐름

## 이 문서의 상태

이 문서는 `work-assistant-harness`의 구조와 단계별 설계를 설명한다. 실제 구현 경계는 아래 결과 문서로 구분하며, 후속 승인·실행 설계가 이미 사용 가능한 기능이라는 뜻은 아니다.

2026-11-09에 단계 0·1의 합성 자료 기반 읽기 전용 CLI를, 2026-11-10에 단계 2의 Slack 수신과 단계 3-A~3-D의 로컬 승인·Docker 진단·독립 합성 실행·취소·중단 복구를 구현했다. 2026-11-11의 후속 범위는 단계 4-A의 합성 답장 계획·별도 승인·모의 전송, 단계 4-B-1의 오프라인 Slack HTTP 계약 진단과 단계 4-B-2의 고정 시험 문구 단건 전송이다. 실제 구현과 검증 상태는 [stage-1-result.md](stage-1-result.md), [stage-2-result.md](stage-2-result.md), [stage-3a-result.md](stage-3a-result.md), [stage-3b-result.md](stage-3b-result.md), [stage-3c-result.md](stage-3c-result.md), [stage-3d-result.md](stage-3d-result.md), [stage-4a-result.md](stage-4a-result.md), [stage-4b1-result.md](stage-4b1-result.md), [stage-4b2-result.md](stage-4b2-result.md)를 따른다. 실제 Slack 단건 시험은 기본 비활성인 별도 live 경로로 분리하며 AI·회사 저장소·자동 업무 답장을 연결하지 않는다.

2026-11-12에는 단계 4-C-1의 오프라인 브랜치 계획·승인·모의 결과와 제어·복구를 추가했다. 실제 Git·Codex 작업과 구분하며 검증 범위는 [stage-4c1-result.md](stage-4c1-result.md)를 따른다.

단계 4-C-2는 독립 합성 Git source/workspace를 준비하고 별도 승인 후 작업 유형별 ref 하나를 만드는 경로다. 현재 추가한 구현과 최종 검증 상태는 [stage-4c2-result.md](stage-4c2-result.md)를 따른다. 실제 Codex·회사 저장소·코드 변경·작업 결과 commit·원격 작업은 연결하지 않는다.

단계 4-C-3은 독립 합성 작업 브랜치의 생성·선택을 고정 patch·등록 Docker 검사·취소·복구와 연결한다. 별도 실행 정책·DB·새 승인을 사용하며 실제 Codex나 회사 저장소는 연결하지 않는다. 전체 회귀 481개와 실제 Docker 격리 진단·실행/취소/복구 12개 시나리오가 통과했으며 상태와 한계는 [stage-4c3-result.md](stage-4c3-result.md)에 기록한다.

단계 4-C-4는 실제 Codex에 승인된 고정 합성 입력만 전송해 JSON 제안을 받은 뒤 새 실행 승인으로 독립 브랜치·Docker 검사에 연결한다. 모델 호출과 코드 실행은 서로 다른 정책·DB·승인을 사용한다. 실제 호출·격리·취소·복구와 기존 회귀의 최종 근거는 [stage-4c4-result.md](stage-4c4-result.md)를 따른다.

단계 4-C-5는 합성 다중 파일을 읽고 검토한 근거만 격리된 고정 응답 worker에 전달하는 `mock` 전용 조사다. 실제 모델 호출은 제외했고 읽기·전송·수정 권한 및 상태·보관 경계를 별도 정책/DB로 구현했다. 검증 결과는 [stage-4c5-result.md](stage-4c5-result.md)를 따른다.

- 구현 순서와 상세 수용 기준: [implementation-plan.md](implementation-plan.md)
- 권한과 승인 조건: [security-and-approval.md](security-and-approval.md)
- Codex 개발 지침: [루트 AGENTS.md](../AGENTS.md)

기존 구현 계획서를 `docs/implementation-plan.md`에 두고 함께 사용한다. 단계와 범위를 바꿀 때는 기준 계획서와 관련 문서를 함께 갱신한다. 실제 설치·실행 명령은 구현 후 README에 기록한다.

## 1. 하네스는 무엇을 하는가

하네스는 모델 주변에서 입력, 문맥, 도구, 승인과 결과 보관을 관리하는 프로그램이다. 모델은 요청을 해석하고 설명이나 계획을 제안한다. 일반 코드와 실행 환경이 접근 가능한 자료와 실행 가능한 동작을 제한한다.

이 프로젝트의 목표는 승인된 Slack 채널에서 **내 사용자 ID를 멘션한 요청**을 모아 관련 코드를 조사하고, 답변 초안이나 수정 계획을 나에게 먼저 보여 주는 것이다. 다른 사람이 수정을 요청했다는 사실만으로 코드가 바뀌지 않는다.

두 저장소를 구분한다.

- **하네스 저장소:** 지금 개발하는 TypeScript·NestJS 프로그램.
- **대상 제품 저장소:** 하네스가 조사할 업무 코드. 처음에는 합성 예제 저장소이며, 회사 저장소 연결은 별도 단계다.

하네스 개발 과정의 테스트와 하네스가 대상 제품의 테스트를 실행하는 것은 서로 다른 행위다.

## 2. 요청 하나가 지나가는 길

```text
가짜 이벤트 / 허가된 Slack 이벤트
  → 워크스페이스·채널·사용자 멘션 확인
  → 이벤트 정규화와 중복 제거
  → 필요한 스레드 문맥·대상 저장소 선택
  → 문의 / 변경 요청 / 불명확 분류
  → 허용된 커밋과 파일을 읽기 전용 조사
  → 나에게 로컬 보고서 제공
      문의: 근거 + 답변 초안
      불명확: 확인 질문
      변경 요청: 수정 계획 + 승인 대기
  → [단계 3-A] 로컬 소유자 승인·취소 기록 (APPROVED에서 정지)
  → [후속 연결] 실제 실행 정책의 새 승인·격리 환경에서 변경·허용된 검사
  → 실제 diff와 검사 결과 보고
```

### 입력과 문맥

허용된 `workspaceId`와 `channelId`를 먼저 확인하고, `<@TARGET_USER_ID>`를 검사한다. 이름 문자열로 사용자를 추정하지 않는다. 같은 `eventId`는 한 번만 처리한다.

스레드는 필요한 범위만 읽는다. 채널 또는 프로젝트와 저장소의 사전 연결을 사용하고, 후보가 여러 개면 임의로 고르지 않고 확인한다.

### 단계 2의 수집 경로

위 조사 흐름과 별도로 단계 2는 수집만 처리한다. 실제 형식의 메시지를 기존 fixture 모델·합성 저장소 조사에 자동 연결하지 않는다.

```text
실수신: auth.test workspace 확인 → Socket Mode
합성 입력: 로컬 Socket 프레임
  → 크기·구조·workspace·channel·이벤트 유형 확인
  → 저장 전 비밀·지원 개인정보 패턴 마스킹
  → SQLite inbox·이벤트 중복 키 commit
  → envelope_id ACK
  → 제한된 스레드 수집
  → SQLite 수집 기록과 로컬 CLI JSON 출력 (분석 not_run)
```

Socket Mode의 `envelope_id`는 전달별 ACK에만 쓰고, `event_id`는 중복 제거에 쓴다. 원본 메시지는 `(workspaceId, channelId, messageTs)`로 묶고 `threadTs`와 구분한다. 편집·삭제·멘션 제거는 기존 작업을 취소하고 오래된 계획·보고를 제거한다. 확인된 같은 스레드의 다른 reply가 바뀌어도 기존 문맥과 연결된 작업을 무효화한다. revision과 tombstone으로 순서 역전과 진행 중 수집의 늦은 결과를 거부한다. 취소 보고서 동기화는 ACK 이후의 별도 후속 작업이며 DB가 복구의 원본이다.

새 메시지가 큐 포화로 저장되지 않으면 ACK하지 않는다. 편집은 포화 상태에서도 기존 계획 무효화와 최신 요청의 `BLOCKED`를 먼저 commit한 뒤 ACK하고 문맥 수집만 생략한다. root가 불명확한 변경은 같은 채널의 진행 중 수집을 보수적으로 무효화할 수 있으며, 관련성이 확인되지 않은 완료 수집은 유지한다.

수신부만 토큰과 네트워크를 가진다. 기존 조사 worker의 네트워크·child process 차단은 유지한다. `liveReadEnabled` 기본값은 `false`이며 실제 계정·채널·자료 정책이 별도로 승인된 뒤에만 연결한다. `fetch`·`WebSocket`을 사용하는 읽기 어댑터를 두며 Slack 쓰기 API·외부 모델·대상 코드 실행 포트는 연결하지 않는다.

스레드 페이지·메시지·바이트·시간과 재시도에 한도를 적용하고, 부분 조회·권한 오류·재연결 공백을 로컬 결과에 표시한다. 연결·공백 이력은 최근 100개를 DB에 보관하며 재연결이 메시지 전량 보존을 보장하지는 않는다. 마스킹한 본문·문맥 payload는 기한 후 제거하고 중복 키·revision·tombstone은 DB 수명 동안 유지한다. DB 폐기 후에는 과거 중복·순서 보존을 보장하지 않는다. 종료 시 후속 I/O를 정리한 뒤 DB를 닫는다. 상세 조건은 [단계 2 계획](implementation-plan.md#단계-2-slack-읽기-연결)을 따른다.

### 분류와 조사

모델의 분류 결과는 JSON 스키마로 검증한다. 잘못된 형식이나 불확실한 결과는 확인 또는 실패 상태로 보내며 실행으로 이어지지 않는다.

읽기 전용 조사에서는 고정된 기준 커밋의 필요한 파일만 읽는다. 근거에는 저장소 ID, 커밋, 경로와 줄 범위를 포함한다. 설치, 테스트, 빌드와 저장소 스크립트 실행은 조사에 포함하지 않는다.

### 보고와 승인 대기

보고서에는 확인한 사실과 가설, 근거, 답변 초안 또는 수정 계획, 위험과 다음 승인 항목을 구분한다. 근거가 부족하면 알 수 없다고 적는다. 요청자에게 답장을 자동 전송하지 않는다.

변경 요청의 조사는 `AWAITING_APPROVAL`에서 멈춘다. 단계 3-A의 로컬 CLI는 계획 해시·기준 커밋·필수 유효기간을 받아 불변 계획 스냅샷과 승인 기록을 저장하고 `APPROVED`로 바꾼다. 소유자는 OS UID의 `os-user:<uid>`로 고정하며 UID 미지원 환경은 거부한다. 승인 기록의 실행 정책은 `approval-only-v1`이고 실제 실행에 재사용하지 않는다. `ExecutionPort`는 항상 거부하며 `run` 명령은 없다.

기존 조사 Task의 실행 연결은 제공하지 않는다. 단계 3-C는 아래 독립 합성 흐름에서 새 실행 계획·승인을 만들고 로컬 diff와 검사 결과를 보고한다. 외부 메시지와 Git 원격 작업은 별도 기능이다.

### 단계 3-B의 격리 진단 경로

진단은 조사·승인 흐름과 분리하며 저장된 Task와 Approval을 입력으로 받지 않는다.

```text
sandbox-check → 기본 비활성 설정·지원 OS·로컬 socket 검사
  → private Docker 설정과 최소 환경으로 daemon·이미지·정책 확인
  → 별도 임시 workspace와 보호 영역의 합성 canary 준비
  → 고정 boundary / pids / memory / timeout / output probe
  → container 유효 설정·종료·제거와 canary 전후 상태 확인
  → 로컬 report.json (executionEnabled: false)
```

`SandboxVerificationPort`는 고정된 probe ID만 받는다. Docker 어댑터는 임의 명령·대상 저장소 경로를 실행 입력으로 열지 않는다. 신뢰하는 CLI controller가 Docker를 제어하며 읽기 worker의 Node 네트워크·하위 프로세스 권한은 추가하지 않는다. 초기 지원은 macOS arm64와 Docker Desktop Linux arm64, cgroup v2·기본 seccomp이며 정확한 daemon·이미지·정책 identity가 다르면 거부한다.

container는 workspace 한 곳만 마운트하고 nonroot·읽기 전용 root·네트워크 차단·자원 한도를 적용한다. probe는 호스트·원본·승인 DB·공유 Git의 합성 파일을 읽거나 변경하지 못해야 한다. 진단 보고서와 합성 작업물은 보존하며 이 진단이 생성한 container만 종료·제거한다. 결과가 `passed`여도 실행을 허용하는 영속 토큰이나 승인으로 사용하지 않는다. 정책·한계·검증 결과는 [보안 문서](security-and-approval.md#단계-3-b의-합성-docker-진단)와 [3-B 결과](stage-3b-result.md)를 따른다.

### 단계 3-C의 독립 합성 실행 경로

```text
execution-plan → 고정 합성 Git 원본 준비·동결 → 실행 계획 해시 → AWAITING_APPROVAL
execution-approve → 원본·설정·OS 소유자·TTL 검증 → 불변 snapshot·새 승인 → APPROVED
execution-run → 원본·승인·설정·backend 재검증
  → 승인 소비 + Run 생성 + RUNNING 원자 commit
  → 독립 Git 작업 트리 재생성 → 승인된 기존 파일의 고정 replace
  → Git 없는 읽기 전용 view → Docker의 등록 검사 + 크기 제한 tmpfs
  → 실제 diff·검사별 결과·원본 전후 hash → SUCCEEDED / FAILED
execution-inspect → SQLite의 Task·최신 승인 페이지·Run과 완료 보고서 확인
```

`execution.sqlite`의 `ExecutionTask`, `ExecutionPlan`, `ExecutionApproval`, `ExecutionRun`은 기존 조사 Task와 분리한다. 기존 `approve`의 `approval-only-v1`과 기본 `ExecutionPort`는 실행 권한을 만들지 않으며 `run`은 계속 `UNKNOWN_COMMAND`다. `SandboxVerificationPort`도 진단 전용으로 유지하고 별도 `IsolatedExecutionPort`를 연결한다. 계획·승인 단계에는 Docker 호출이 없고 실행 단계에서만 고정 local backend를 확인한다.

수정 허용 범위는 `src/message.mjs` 한 파일의 고정 내용 교체다. 읽은 근거 파일을 수정 범위로 승격하지 않는다. 계획에는 원본 해시·기준 커밋·고정 요청 revision·patch 전후 해시·명령 전체 사양·실행 정책과 설정 해시를 결합한다. `enabled: false`에서도 계획은 만들 수 있으나 승인·실행하려면 활성 설정으로 새 계획이 필요하다.

동결 원본과 Git 메타데이터는 container에 노출하지 않는다. 고정 파일에서 원본과 같은 커밋의 독립 Git 작업 트리를 재생성하고, patch 적용 후 Git 없는 읽기 전용 view를 만든다. 이는 원본 `.git`을 공유하는 `git worktree`가 아니다. 쓰기 영역은 16MiB `/tmp` tmpfs로 제한하며 nonroot·읽기 전용 root·네트워크 없음·seccomp·capability 제거와 메모리·CPU·PID·시간·출력 한도를 함께 적용한다.

승인 소비 뒤에는 실패하더라도 usedAt을 되돌리지 않으며 task당 Run은 한 번만 생성한다. `finishRun`은 원래 identity를 보존하고 `RUNNING`에서 terminal 상태로만 전환한다. SQLite를 감사 기록의 원본으로 삼고 `execution-inspect`가 누락된 완료 보고서를 재생성한다. 강제 종료 뒤 상태 조사는 아래 명시적 복구 경로를 사용하며 자동 재실행하지 않는다.

### 단계 3-D의 제어와 복구 경로

```text
execution-cancel / execution-invalidate → OS 소유자·이벤트·revision 검증
  → generation 증가·요청 무효화·미소비 승인 revoke 원자 commit
  → 실행 controller의 fence / 50ms polling → 새 동작 거부·소유 container 정리
execution-recover → 저장된 lifecycle·소유 identity·파일 증거 조사
  → 정지·제거 확인 + 잔여 파일/Git/view 관찰 → INTERRUPTED / CANCELLED / BLOCKED
execution-inspect → 한 DB snapshot의 Task·제어·승인 페이지·Run·lifecycle → 누락 보고서 재생성
```

합성 요청은 `synthetic:<task-id>`와 초기 revision 1·generation 0으로 식별한다. 같은 이벤트 ID·payload는 멱등 처리하고 다른 payload는 거부한다. 오래된 편집·삭제 revision은 상태를 되돌리지 않는다. 승인 생성과 소비는 같은 트랜잭션에서 무효화 여부를 확인한다. 실행 전 취소는 대기 Task를 `CANCELLED`로 바꾸고, 실행 중 제어는 먼저 요청 상태만 바꾼다. controller가 정리를 확인한 뒤 Run과 Task를 종료하며 성공 종료와 취소 경합도 `finishRun`에서 재검증한다.

`execution.sqlite`는 요청 제어 기록과 순번이 있는 lifecycle 최신 기록·추가 전용 이력을 보관한다. 승인 소비와 최초 `claimed` 기록은 원자적이다. 작업 영역의 경로·계획/Git/view 해시와 diff·검사·명령 결과를 중간 저장한다. Docker 생성 전 이름·소유 토큰·Run ID를 저장하고 생성 후 전체 ID를 추가한다. 이름·토큰·Run/command identity와 한 번 기록한 ID·workspace 증거는 바꿀 수 없다.

짧은 파일 작업은 DB guard 안에서 수행해 취소 writer와 직렬화한다. Docker create/start는 동기 dispatch gate가 generation을 확인하고 실제 CLI spawn 호출까지만 잠금을 유지한다. RPC 완료는 트랜잭션 밖에서 기다리며 이미 전달된 RPC의 container는 취소·복구 때 정리한다. container의 이름·소유 토큰·Run label·기록한 전체 ID를 대조하고 다른 container를 추측해 종료하지 않는다.

재시작 관찰은 메모리 snapshot에 의존하지 않는다. 저장된 파일/Git/view 증거로 부분 patch·추가·삭제·권한·링크·특수 파일을 조사하고 예상 밖 파일의 본문은 읽지 않는다. 정리나 관찰이 불확실하면 `BLOCKED`, 확인된 중단은 `INTERRUPTED`, 확인된 취소는 `CANCELLED`다. 과거 3-C의 소유 정보 없는 미완 Run은 `legacy_untracked`와 `BLOCKED`로 보존한다. 이미 `BLOCKED`인 Run의 재복구는 Run 역사를 유지하고 lifecycle의 정리·관찰만 갱신한다. 소비 승인 복원·작업 재개·commit·push·자동 삭제는 없다.

제어·조회만 전역 lease를 우회한다. 계획·승인·실행·복구는 전역 lease를 유지하므로 실제 Slack 수신과 합성 실행은 직렬화된다. 실제 Slack Task와 합성 요청을 연결하지 않으며 수신 공백 중 변경 감지도 보장하지 않는다.

### 단계 4-A의 합성 답장 경로

```text
reply-plan → 고정 합성 요청·본문 → 본문 해시·목적지·revision·보관 정책 결합
reply-inspect → 유효 본문·대상·계획 해시를 stdout에서 검토
reply-approve → 로컬 OS 소유자·정확한 해시·필수 TTL → 전송 전용 승인
reply-send → 정책·본문·source·승인 재검증
  → 승인 소비 + SENDING 시도 원자 commit → 가짜 전송 어댑터 1회 호출
  → SIMULATED / FAILED(NOT_SENT) / UNKNOWN
reply-cancel / reply-invalidate → 요청·문맥 fence·미소비 승인 revoke
reply-recover → 중단된 SENDING을 UNKNOWN으로 기록, 전송 재개 없음
reply-prune / 각 명령 시작 → 만료 본문·설정된 terminal 감사 기록 정리
```

이 경로는 기존 조사 Task·코드 변경 승인·합성 실행 Run·Slack 수신 DB와 분리한다. 입력은 코드에 고정한 합성 요청과 일반 텍스트 요약이며 실제 Slack 이벤트·모델 응답·제품 저장소 경로·임의 본문을 받지 않는다. 목적지는 `W_LOCAL`·`C_ALLOWED`의 원래 요청 스레드뿐이다. DM·다른 채널·첨부·알림 멘션·코드 전문과 실제 Slack 쓰기 API는 제공하지 않는다.

`replies.sqlite`에 답장 Task·본문 없는 계획/승인 snapshot·별도 만료 본문·전송 시도·제어 이벤트·최소 중복 marker를 저장한다. `ReplyStore`는 승인 생성·1회 소비·상태 변경·유효성 검사를 트랜잭션으로 수행한다. `MockReplyDeliveryPort`는 `mode: mock`인 가짜 어댑터 계약이며 실제 Slack 포트로 간주하지 않는다. 모든 답장 명령은 기존 전역 lease를 사용하므로 수신과 동시에 실행하지 않는다.

승인은 현재 OS UID와 정확한 계획 해시·TTL 1~60분에 묶는다. 기본 TTL 없이 입력을 요구하며 본문·문맥 만료 이내로 제한한다. 본문·목적지·요청/문맥 revision 변경과 새 reply는 기존 승인을 무효화하고, 불완전·공백·만료·최신성 미확인은 전송을 막는다. `SIMULATED`는 외부 메시지 전송을 뜻하지 않는다. 확실한 미전송 `NOT_SENT`만 새 승인으로 수동 재시도하며 `UNKNOWN`과 중단된 `SENDING`은 재전송하지 않는다. 재시작 후 자동 전송이나 승인 소비 복원은 없다.

본문은 기본 24시간이며 `bodyRetentionHours` 1~168시간과 source의 생성 후 24시간 기한 중 짧은 기한 뒤 제거하고 승인 snapshot·시도·영속 보고서에 복제하지 않는다. 유효 본문은 `reply-plan`·`reply-inspect`의 stdout에서만 보여 준다. 감사 metadata는 기본 DB 수명 동안 보관하거나 별도 1~3650일로 정하며, terminal 작업의 마지막 상태 갱신부터 해당 기간 뒤 감사 기록을 제거한 뒤에도 최소 task ID·계획 해시 marker를 유지한다. 정리는 명령 실행 시 수행하므로 중지 중 만료 자료는 다음 실행까지 남을 수 있고 물리적 완전 삭제를 보장하지 않는다. 자세한 정책과 실패 기준은 [단계 4-A 계획](implementation-plan.md#단계-4-a-합성-답장-계획별도-승인모의-전송)을 따른다.

### 단계 4-B-1의 오프라인 HTTP 계약 진단 경로

```text
slack-post-check → 고정 합성 설정·본문·thread·offline-http intent
  → 기본 disabled 포트는 HTTP 호출 없이 BLOCKED
  → 진단용 합성 HTTP 포트 주입
    → auth.test identity → conversations.replies 문맥 재확인
    → chat.postMessage JSON 직렬화와 receipt 검증
    → OFFLINE_CONFIRMED / NOT_SENT / UNKNOWN / BLOCKED
  → 예상 결과와 비교 → 비공개 로컬 report.json
```

`SlackPostContractPort`와 `SlackPostHttpPort`는 기존 `MockReplyDeliveryPort`와 분리한다. `slack-post-contract-v1`·`mode: offline-http`의 `OfflinePostIntent`는 HTTP 계약을 검증하기 위한 입력이며 소유자의 전송 승인이 아니다. 단계 4-A의 mock 계획/승인이나 기존 코드·실행 승인을 받거나 소비하지 않고 `replies.sqlite`도 열지 않는다. 진단 성공은 권한을 만들지 않으며 `liveEnabled`는 항상 `false`다.

합성 identity 확인과 제한된 thread 응답으로 설정·본문 hash·원문 revision·문맥 hash·완전성·만료를 대조한 뒤 post JSON과 응답을 검증한다. 새 reply·불완전·만료·identity 불일치는 post 전에 차단하고, post 이후 응답의 channel·message·thread·bot·본문이 정확히 일치할 때만 `OFFLINE_CONFIRMED`다. 확실한 미전송과 불확실 결과를 구분하며 자동 재시도는 없다. 요청 250ms·응답 16KiB와 redirect 거부는 이 합성 진단의 한도다.

NestJS application context를 여는 별도 제한 worker에는 네트워크·하위 프로세스·호스트 토큰 권한이 없다. 고정 합성 token·본문·응답은 메모리에서만 사용하고 `<data-dir>/slack-post-checks/<verificationId>/report.json`과 stdout에는 해시·결과·호출 횟수와 정적 원인을 남긴다. 전역 `fetch`를 사용하는 실제 transport와 실전송 활성화/토큰/본문/대상 입력 옵션은 제공하지 않는다.

별도 live 승인 소비·복구와 실제 단건 시험은 아래 4-B-2 경로를 사용한다. 합성 thread 재확인과 진단 통과를 실제 수신 공백·문맥 경합 해결이나 회사 계정/자료 정책의 충족으로 해석하지 않는다. 상세 수용 기준은 [4-B-1 계획](implementation-plan.md#단계-4-b-1-오프라인-slack-http-계약-진단)을 따른다.

### 단계 4-B-2의 고정 시험 문구 단건 전송 경로

```text
slack-live-plan → live 명시 활성화·고정 대상 → auth.test + conversations.replies
  → 고정 root 한 개·reply 없음·bot identity·문맥 metadata 확인 → live 계획
slack-live-inspect → 대상·계획 해시·코드의 고정 시험 문구 검토
slack-live-approve → 인증/문맥 재조회 → OS 소유자·계획 해시·필수 TTL → 새 live 승인
slack-live-send → 인증/문맥 재조회·5초 최신성·계획/승인 검사
  → 승인 소비 + SENDING 시도 원자 commit → 고정 chat.postMessage 최대 1회
  → receipt 대조 → SENT / FAILED(NOT_SENT) / UNKNOWN
slack-live-cancel / recover / prune → 승인 취소 / UNKNOWN 복구 / 30일 감사 정리
```

`slack-live-test-v1`과 별도 `live-replies.sqlite`를 사용하며 mock·diagnostic·기존 코드/실행 계획과 승인을 받지 않는다. `liveEnabled` 기본값은 `false`다. 실제 대상 ID는 로컬 CLI와 비공개 DB metadata로 관리하고 token은 환경 주입 또는 TTY 숨김 입력으로만 받는다. 설정 파일·fixture·Git에 token을 넣지 않는다. 허용 원문은 코드에 정한 `하네스 전송 테스트` root 한 개이며 전송 본문은 `하네스 Slack 단건 전송 테스트입니다. (4-B-2)`뿐이다. 모델·Slack 수신 큐·대상 제품 저장소·임의 본문과 연결하지 않는다.

source의 raw revision·문맥 hash·관측 시각·bot identity만 저장하고 원문·고정 전송 본문·token은 DB와 영속 보고서에 복제하지 않는다. 계획에는 OS UID 소유자·설정을 포함한 계획 hash·목적지·source·본문 hash와 최대 24시간 만료를 결합한다. 검토할 본문은 유효 계획에 대해 코드 상수로 재구성한다. 별도 live 승인은 정확한 계획 해시·필수 TTL 1~60분에 묶고 계획 만료 이내로 제한한다.

plan·approve·send의 제한 worker만 token과 네트워크를 받는다. 고정 auth/thread/post API, 요청 10초·응답 32KiB·redirect 거부·자동 재시도 0을 적용한다. 읽기·제어 명령은 token과 네트워크를 받지 않는다. 전역 lease로 실수신과 직렬화하고 매번 실제 인증·스레드를 다시 확인한다. 원문 편집·삭제·새 reply·불완전·identity 변경과 5초를 넘긴 관측은 차단한다. Slack 조회와 POST 사이 외부 변경을 원자적으로 막을 수 없다는 한계는 남는다. Node 네트워크 권한과 어댑터의 URL 제한은 호스트별 OS 격리가 아니다.

저장소는 승인 소비와 `SENDING` 시도를 원자적으로 만든다. 확인된 receipt만 `SENT`, 명백한 거부는 `NOT_SENT`/`FAILED`, 게시 결과가 불확실하면 `UNKNOWN`이다. 중단된 `SENDING`은 명시적 recover에서 `UNKNOWN`으로 확정하며 재전송하지 않는다. `SENT`·`UNKNOWN`의 workspace/channel/root 대상 marker는 다른 작업 ID의 새 계획까지 차단한다. terminal 감사 metadata는 30일 후 정리하되 대상 marker는 DB 수명 동안 유지한다. 개인 테스트 workspace의 구체 계획과 별도 승인으로 실제 단건 게시를 검증했다. 로컬 `SENT` 시도 한 개와 원래 Slack 스레드의 댓글 한 개·고정 본문·receipt 일치 근거는 [4-B-2 결과](stage-4b2-result.md)에 기록한다. 회사 운영·AI·실제 업무 자동 답장은 검증하지 않았다.

### 단계 4-C-5의 합성 다중 파일 조사

새 `synthetic-readonly-investigation-v1` 경로는 등록된 합성 저장소의 여러 파일을 읽고, 검토·승인한 발췌문만 고정 응답 모델에 전달한다. 읽기 범위와 전송 근거를 계획에 고정하며 `writeAllowedFiles=[]`, `testCommandIds=[]`, `executionAllowed=false`를 유지한다. 기존 단일 파일 제안의 `READY → EXPORTED`와 실행 계획에 연결하지 않는다.

```text
등록 fixture 준비·동결 → 커밋/파일 검증 → 문맥 snapshot
  → 정확한 전송 입력·hash 검토 → 새 조사 승인
  → 승인 소비 + RUNNING → 제한된 오프라인 모델 worker
  → 전송한 근거에 대한 JSON 참조 검증 → 로컬 보고서
취소·무효화·명시 복구 → generation과 소비 이력 보존, 자동 재호출 없음
```

원본 root·Git metadata·전체 로컬 snapshot은 모델 worker에 전달하지 않는다. worker는 승인된 입력만 받아 고정 응답을 만들고 대상 파일을 import하거나 실행하지 않는다. 네트워크·추가 프로세스·대상 쓰기 권한과 호스트 환경 자격증명을 갖지 않는다. 실제 모델 adapter와 인증 설정은 이 조사 경로에 연결하지 않는다.

새 조사 계약은 구형 `ChangePlan.allowedFiles`를 수정 권한으로 가져오지 않는다. 내용 payload와 본문 없는 승인/감사 기록을 분리하며 24시간 payload 만료, 최초 terminal 전환부터 30일 감사 보관, DB 수명의 소비 marker를 각각 적용한다. 오프라인 수용 결과와 실제 모델 미실행 상태는 [4-C-5 결과](stage-4c5-result.md)에 기록한다.

## 3. 구성 요소와 책임

처음에는 단일 프로세스, SQLite, 작업 하나씩 실행하는 구조로 시작한다. NestJS는 의존성 주입과 설정을 담당하고, 도메인 규칙은 NestJS나 외부 서비스 없이도 테스트할 수 있게 둔다.

| 구성 요소 | 책임 |
| --- | --- |
| Ingestion | 입력 정규화, 허용 범위 확인, 멘션 필터와 중복 제거 |
| Slack receiver / inbox | 전달별 ACK, 최소 수신 영속화, 메시지 revision·수집 한도·재시작 복구. 조사 실행 권한 없음 |
| Triage | 세 가지 분류와 모델 출력 스키마 검증 |
| RepoReader | 허용된 커밋·경로에서 필요한 근거만 읽기 |
| Planner | 조사 보고서, 답변 초안과 수정 계획 생성. 실행 권한 없음 |
| PolicyGate | 채널·저장소·경로·명령·데이터 전송 정책 검사 |
| ApprovalService | 단계 3-A의 OS 소유자·계획·기준 커밋·만료·취소 검증과 기록용 승인. 합성 실행 승인은 별도 서비스가 담당 |
| SandboxVerifier | 단계 3-B에서 로컬 Docker의 합성 probe·유효 정책·종료와 보호 경계를 확인. 대상 코드 실행 권한 없음 |
| SyntheticExecutionService / IsolatedExecutionPort | 독립 합성 계획·새 승인·원자적 Run과 고정 실행, 단계 3-D의 취소·소유 container 복구·잔여 상태 관찰 |
| SyntheticReplyService / ReplyStore / MockReplyDeliveryPort | 단계 4-A의 고정 합성 답장 계획·전송 전용 승인·원자 소비·모의 결과·무효화·명시적 복구·본문/감사 보관 |
| SlackPostContractPort / SlackPostHttpPort | 단계 4-B-1의 비활성 기본 포트·합성 HTTP 직렬화·identity/문맥/receipt 계약 진단. 영속 승인과 실제 전송 권한 없음 |
| Live reply service / store / Slack adapter | 단계 4-B-2의 고정 단건 시험·새 live 승인·원자 소비·실제 receipt·대상 중복 marker·명시적 복구 |
| TaskStore / Reporter | 상태·감사 기록 저장과 로컬 보고 |

외부 기능은 `MessageSource`, `ModelPort`, `RepoReadPort`, `ExecutionPort`, `ApprovalPort`, `ReportSink`로 나눈다. 모의 조사는 `MockSlackSource`, `FixtureModel`, 제한된 로컬 저장소 읽기와 로컬 보고를 사용한다. 단계 3-A는 로컬 승인 기록, 단계 3-B는 `SandboxVerificationPort`의 고정 probe, 단계 3-C는 `ExecutionStore`·`IsolatedExecutionPort`의 독립 합성 실행을 제공한다. 단계 4-A는 독립 `ReplyStore`·`MockReplyDeliveryPort`, 단계 4-B-1은 승인 DB와 분리된 `SlackPostContractPort`·`SlackPostHttpPort`를 사용한다. 단계 4-B-2는 별도 live 저장소와 실제 Slack 단건 시험 어댑터를 사용한다. 실제 Slack 요청·모델·제품 저장소와 실행·자동 답장 흐름의 연결은 제공하지 않는다.

특정 Codex SDK나 CLI를 필수 전제로 도메인 코드를 묶지 않는다. 실제 실행기를 선택할 때 해당 버전의 공식 문서, 인증과 권한 조건을 검증한다.

### 제안하는 디렉터리

```text
work-assistant-harness/
  AGENTS.md
  src/
    cli/
    domain/
    application/
    ports/
    adapters/
    policy/
  config/local.example.yaml
  fixtures/
  tests/
  docs/
    implementation-plan.md
    architecture.md
    security-and-approval.md
  .env.example
  .gitignore
  README.md
```

실제 토큰, 로컬 설정, SQLite, 승인 기록, 원문 메시지, 보고서, 실행 로그와 worktree는 소스 코드와 분리한다. 런타임 데이터의 기본 위치는 OS 사용자 데이터 디렉터리로 하고, 접근 권한과 보관 기간을 설정한다.

## 4. 저장할 기록과 상태

최소 기록은 다음과 같다. 세부 필드는 기준 계획서와 구현 스키마에서 관리한다.

- **Task:** 이벤트 출처, 요청자, 분류, 상태, 대상 저장소와 기준 커밋.
- **Plan:** 버전, 요청 메시지 revision, 목적, 허용 파일·동작·검사와 계획 해시.
- **Approval:** OS 소유자, 작업, 불변 계획 스냅샷·해시·요청 revision·저장소·기준 커밋, 실행 정책, 생성·만료·사용·취소 기록. 단계 3-A의 실행 정책은 `approval-only-v1`, 사용 시각은 `null`이다.
- **Evidence / Run:** 파일 근거, 실제 diff, 검사별 결과와 실패·미실행 사유.
- **Slack inbox / collection:** 이벤트 중복 키, 원본 메시지·revision, 수집 상태, 마스킹한 최소 문맥, 보관 만료와 분석 미실행 사유. 기존 Task의 조사 상태와 구분한다.
- **Sandbox verification:** 정책·daemon·이미지 identity, probe별 결과와 실패 사유, 보호 영역 전후 상태와 종료·제거 확인. `sandbox-checks/<verificationId>/report.json`에 저장하며 Task·Approval·Run과 연결하지 않는다.
- **Synthetic execution:** 별도 `execution.sqlite`에 실행용 Task·정확한 patch/명령/정책 계획·불변 승인·원자 소비와 Run을 저장한다. 작업물과 완료 보고서는 `executions/<task-id>/`에 보존한다. 기존 조사 승인과 혼용하지 않는다.
- **Synthetic reply:** 별도 `replies.sqlite`의 답장 Task·본문 해시/목적지/revision/정책 계획·본문 없는 승인 snapshot·1회 소비와 전송 시도·제어 이벤트·보관 정책. 본문은 별도 만료 payload에만 저장하고 최소 중복 marker는 DB 수명 동안 유지한다.
- **Live test reply:** 별도 `live-replies.sqlite`의 `LivePlan`·`LiveTask`·`LiveApproval`·`LiveAttempt`와 대상 중복 hash marker. 원문·전송 본문·token은 저장하지 않고 검토 본문은 plan/inspect 시 코드 상수로 재구성한다.

```text
RECEIVED → TRIAGED → ANALYZED
  문의      → REPORTED
  불명확    → NEEDS_CLARIFICATION
  변경 요청 → AWAITING_APPROVAL
               → [단계 3-A] APPROVED (실행 없음)
               → [후속 조사 연결] RUNNING → VERIFYING → REPORTED

예외 → BLOCKED / FAILED / CANCELLED

[단계 3-C·3-D 독립 합성 실행]
AWAITING_APPROVAL → APPROVED → RUNNING → SUCCEEDED / FAILED / BLOCKED / CANCELLED / INTERRUPTED
        취소·무효화 → CANCELLED

[단계 4-A 독립 합성 답장]
AWAITING_APPROVAL → APPROVED → SENDING → SIMULATED / FAILED / UNKNOWN
        소유자 취소 → CANCELLED, 요청/문맥 변경·불완전·공백·만료 → BLOCKED
        SENDING 무효화 → UNKNOWN
        NOT_SENT인 FAILED만 새 승인 후 수동 재시도
```

상태 변경은 트랜잭션으로 처리하고 이벤트 중복과 승인 재사용을 데이터베이스 제약으로 막는다. 재시작 후 기록을 복구하되, 중단된 변경을 자동 재실행하지 않는다. `REPORTED`는 보고가 끝났다는 뜻이며 모든 검사가 통과했다는 뜻이 아니다.

단계 3-A는 승인 삽입과 `APPROVED` 전환을 한 트랜잭션으로 처리하고 활성 승인의 중복 생성을 막는다. 만료 조정은 승인 취소와 `AWAITING_APPROVAL` 복귀를, 로컬 취소는 `CANCELLED` 전환을 함께 기록한다. 요청 편집·삭제도 기존 Task 무효화와 같은 트랜잭션에서 승인을 취소한다. Task의 계획·보고 제거와 별개로 승인 스냅샷은 보존한다. 이 기록을 3-C로 승격하지 않는다. 3-C는 `synthetic-execution-v1` 새 승인의 소비·Run 생성·`RUNNING` 전환을 한 SQLite 트랜잭션에서 처리한다.

승인 이력은 DB에 모두 남기고 CLI 응답은 최신순 1개 페이지로 제한한다. `inspect`는 기본 0인 `--approval-offset`과 `result.approvalPage`의 `nextOffset`으로 이어 조회하며 `result.approvals`에는 해당 페이지를 담는다. 승인·취소 응답도 같은 최신 페이지를 사용한다. worker stdout의 최대 크기는 1MiB다.

## 5. 단계별로 어디까지 만드는가

| 단계 | 범위 | 다음 단계로 넘어갈 조건 |
| --- | --- | --- |
| 0 | 로컬 CLI, 합성 이벤트·저장소, 고정 모델, SQLite와 보고서 | 실제 토큰과 인터넷 없이 세 분류가 재현되고 재시작 후 기록 유지 |
| 1 | 읽기 전용 조사, 경로 제한과 파일 근거 | 변경 요청도 대상 파일을 바꾸지 않고 보고서·계획만 생성 |
| 2 | 기본 비활성 Slack 읽기 어댑터와 오프라인 수집·복구 검증 | inbox commit 후 ACK, 최신 revision·보관 경계, 분석·외부 메시지 전송 없음. 실제 연결은 별도 승인·검증 |
| 3-A | 로컬 승인·취소와 불변 승인 기록 | 계획·OS 소유자·TTL 검증, 원자적 상태 변경·취소·만료, 실행 거부 유지 |
| 3-B | 실제 격리 backend 선정·실증 | 호스트·승인 DB·공유 Git 보호, 네트워크·자원·프로세스 제한을 실제 실패 테스트로 검증 |
| 3-C | 고정 합성 patch·명령 사양·허용 검사 | 새 실행 승인 소비, 계획·커밋·revision·정책 변경과 범위 초과 차단 |
| 3-D | 실행 취소·복구와 실제 diff 보고 | 요청 무효화·crash 경합 처리, 자동 재실행 없음, 승인·Run·잔여 작업물 보존 |
| 4-A | 합성 답장 계획·별도 승인·모의 전송·무효화·복구·보관 | 승인한 대상/본문만 모의 호출, 중복·불확실 재전송 차단, 실제 외부 전송 0 |
| 4-B-1 | 비활성 기본 포트와 오프라인 Slack HTTP 계약 진단 | 합성 identity·문맥·직렬화·receipt·불확실 결과·제한 worker 검증, 실제 전송 0. 승인 권한 생성 없음 |
| 4-B-2 | 고정 시험 문구의 별도 live 계획·승인·원자 소비·단건 Slack 전송·복구 | 합성 검증과 실제 게시 승인 분리. 정확한 identity/문맥/receipt·대상 중복 차단, 실제 게시 상태 별도 기록 |
| 4-C-1 | 대상 작업 브랜치의 오프라인 계획·승인·모의 결과 | 별도 DB·정책, 유형별 계획·원자 소비·충돌/불확실·취소/복구 검증. 실제 Git/Codex 효과 없음 |
| 4-C-2 | 독립 합성 Git 저장소의 ref 생성·관찰·복구 | 새 정책·승인·소유 증거·전후 hash·배타적 ref 생성·강제 종료 복구. HEAD/main 보존, 실제 Codex/회사 저장소 미연결 |
| 4-C-3 | 독립 합성 작업 브랜치의 고정 수정·Docker 검사 | 새 실행 정책·승인 뒤 유형별 ref·HEAD 선택, 고정 patch·읽기 전용 검사 view·취소·관찰 복구. 전체 회귀와 실제 Docker 검증 완료 |
| 4-C-4 | 실제 Codex 합성 제안·새 실행 승인 | 단건 호출 승인·외부 CLI 격리·부모 broker·JSON 검증·일회 export·별도 실행 승인. 실제 결과와 한계는 전용 결과 문서 참조 |
| 4-C-5 | 합성 다중 파일 읽기 전용 조사 | 읽기/전송/수정 권한 분리·불변 문맥·단건 모의 호출·근거 보고·취소/복구. 실제 모델 호출 제외 |
| 4-C 후속 | 대상 저장소의 실제 Codex 작업 브랜치·commit 준비·push | 승인·격리·브랜치 보존과 행위별 승인 별도 검증. PR/MR 생성 제외. 미구현 후속 설계 |
| 4-D | Gmail·Calendar·Drive의 선택 확장 | 기능마다 별도의 인증·권한·데이터 범위·승인 검증. 4-B-2 승인 범위 밖 |

4-C의 브랜치 규칙은 하네스가 Codex에 대상 저장소의 코드 수정을 지시할 때 적용한다. 승인된 기준 커밋에서 새 기능은 `feature/`, 오류 수정은 `fix/`, 유지보수는 `chore/`, 구조 개선은 `refactor/` 브랜치를 생성하고, 그 안에서 수정·허용된 검사 후 브랜치·diff·결과를 보고하도록 설계한다. PR 생성은 제외하고 GitLab MR로 대체하지 않는다. 이는 현재 하네스 저장소 개발 규칙이 아니다. 4-C-1은 계획·승인·모의 결과를, 4-C-2는 독립 합성 Git 저장소의 ref 생성·관찰·복구를 다룬다. 4-C-3은 새 합성 실행에서 브랜치 선택과 고정 수정·검사를 연결하고 4-C-4는 고정 합성 입력의 실제 Codex 제안을 새 실행 승인으로 연결한다. 회사 대상 저장소와 Codex 직접 수정은 후속 범위다. 상세 조건은 [4-C 계획](implementation-plan.md#후속-단계의-별도-범위)을 따른다.

4-C-1의 `branch-plan → branch-approve → branch-simulate`는 별도 `branches.sqlite`에서 `AWAITING_APPROVAL → APPROVED → SIMULATING → SIMULATED / FAILED / UNKNOWN`으로 진행한다. `synthetic-branch-v1`·`offline` 계획은 작업 유형·브랜치명·합성 repo/remote/base/diff·OS 소유자·24시간 유효기한에 결합한다. 필수 TTL 1~60분의 승인을 모의 시도와 원자 소비하며 작업당 시도는 한 번이다. 취소·변경은 미소비 승인을 취소하고 진행 중 결과는 `UNKNOWN`으로 차단한다. 시작·조회는 자동 실행하지 않으며 중단 상태의 명시적 복구는 recover를 사용한다. 제한 worker는 네트워크·child·호스트 토큰을 받지 않고 Git·Codex 포트도 연결하지 않는다. [4-C-1 결과](stage-4c1-result.md)에 검증 범위와 실제 연결의 미실행 상태를 기록한다.

4-C-2의 `git-branch-plan → git-branch-approve → git-branch-create`는 별도 `git-branches.sqlite`에서 `AWAITING_APPROVAL → APPROVED → RUNNING → SUCCEEDED / FAILED / BLOCKED`로 진행한다. 초기 고정 fixture만 `isomorphic-git`으로 각각 준비하며 source/workspace 사이 Git 객체나 worktree metadata를 공유하지 않는다. 계획은 소유 manifest·root·token·기준 커밋·두 트리 hash·작업 브랜치와 새 `local-synthetic-branch-v1` 정책에 결합한다. 실행은 승인 소비와 `claimed`를 원자 저장하고 `writing`을 먼저 기록한 뒤, 동기 guard에서 generation을 확인하며 계획한 loose ref 하나만 배타적으로 생성한다. `created`와 `finished` 시각·전후 관찰을 영속화한다. checkout·코드 변경·검사 스크립트·작업 결과 commit은 수행하지 않는다.

동기 workspace 관찰은 소유·경로·고정 파일 목록·한도를 먼저 검증하고 source와 정규화한 workspace hash를 비교한다. 계획 ref와 유형 디렉터리만 차이로 허용하며 main과 HEAD는 그대로 유지한다. `git-branch-inspect`는 중단된 `RUNNING`을 재개하지 않고, `git-branch-recover`는 현재 ref 유무와 안전성을 `INTERRUPTED / CANCELLED / BLOCKED` 결과에 남긴다. 존재하는 ref를 성공의 증거로 소급하지 않으며 자동 재생성·수리·삭제도 하지 않는다. `RUNNING` 내부 취소는 generation fence를 세우지만 CLI의 모든 명령은 전역 lease로 직렬화하므로 별도 cancel 프로세스가 실행 중 lease를 우회하지 않는다. [4-C-2 결과](stage-4c2-result.md)에 합성 Git 검증과 실제 회사 연결의 미실행 범위를 구분한다.

4-C-3의 `branch-execution-*`는 기존 3-C/D의 실행 service·workspace·Docker adapter·취소·lifecycle을 새 profile로 사용한다. 정책은 `synthetic-branch-execution-v1`, DB는 `branch-execution.sqlite`, 작업물은 `branch-executions/<task-id>/`에 분리한다. 기존 정책의 계획 키와 동작을 유지하며 4-C-2의 workspace나 승인을 가져오지 않는다. 계획 hash는 작업 유형·브랜치명·main·예상 HEAD·OS 소유자·정확한 source 경로·24시간 유효기간과 기존 원본·patch·검사·Docker identity를 함께 고정한다. 승인 TTL은 필수 정수 1~60분이며 계획 만료를 넘지 않는다.

```text
branch-execution-plan → 합성 source 초기 commit·동결 → AWAITING_APPROVAL
branch-execution-approve → 새 정책의 소유자·hash·기준·TTL 확인
branch-execution-run → 원본·Docker 사전 확인 → 승인 소비 + RUNNING
  → workspace_preparing → 독립 Git 초기화·ref 배타 생성·symbolic HEAD 선택
  → workspace_ready → 선택 완료 Git hash 저장 → src/message.mjs 고정 patch
  → Git 없는 읽기 전용 Docker view·등록 검사 → 원본·Git·diff 관찰·보고
branch-execution-cancel / invalidate → generation fence·소유 container 정리
branch-execution-recover → 영속 증거와 현재 작업물 관찰, 실행 재개 없음
```

source의 main·HEAD와 작업 영역의 main은 기준 커밋에 남긴다. 작업 ref와 HEAD 선택을 끝낸 뒤 최초 Git hash를 저장하고 그 이후에는 Git metadata 전체를 불변으로 검사한다. fixed patch는 신뢰하는 하네스가 적용하며 Docker에는 `.git`과 쓰기 권한이 없는 view만 전달한다. 대상 코드의 호스트 import나 임의 코드 생성·실행은 제공하지 않는다. 합성 초기 commit과 별개인 작업 결과 commit·push·PR/MR도 제공하지 않는다.

`workspace_preparing` 중단으로 최초 Git 증거 없이 작업물이 남으면 보수적으로 `BLOCKED`로 보존한다. 증거 저장 뒤 복구는 현재 HEAD·작업 ref·main·파일·view와 container 소유권을 검사해 `INTERRUPTED / CANCELLED / BLOCKED`로 기록한다. inspect·cancel·invalidate는 기존 3-D와 같이 전역 lease를 우회하는 짧은 DB 트랜잭션이며 실행·복구는 전역 lease를 유지한다. 승인·계획 TTL은 승인과 실행 진입에서 확인하고, 진행 중 실행은 generation fence·강제 시간 제한·최종 성공 재검증으로 제어한다. 자동 재시도·승인 복원·수리·작업물 삭제는 없다. 실제 검증 근거는 [4-C-3 결과](stage-4c3-result.md)를 따른다.

4-C-4는 모델 제안과 실행을 두 단계로 분리한다. `CodexProposalService`는 `CodexProposalPort`에 고정 입력 문자열만 전달한다. 호출 계획·승인·시도는 `codex-proposals.sqlite`의 `synthetic-codex-proposal-v1`에 속하고, 검증된 결과를 받아 만드는 실행 계획은 `codex-execution.sqlite`의 `synthetic-codex-execution-v1`에 속한다. CLI 설정은 `codex-cli-proposal-v1`, 응답 검증 근거는 `codex-proposal-v1`으로 별도 식별한다.

```text
codex-proposal-plan → 전송할 합성 입력·설정·계획 hash 표시
  → 별도 호출 승인 → usedAt + RUNNING 원자 저장
  → 부모 broker: 선택한 credential 보유·고정 upstream body 구성
  → guardian → 외부 SBPL → 빈 HOME의 native Codex CLI
      Codex ↔ localhost broker capability ↔ 고정 OpenAI/ChatGPT endpoint
  → JSON 검증 → READY → codex-execution-plan에서 EXPORTED 원자 소비
  → 새 실행 계획·새 승인 → 독립 유형별 브랜치·하네스 patch·Docker 검사
```

계획에 보이는 입력은 합성 `src/message.mjs`를 `before`에서 `approved`로 바꾸라는 고정 요청이다. 호출 계획은 제안 UUID·OS UID·작업 유형·입력 hash·설정 hash·24시간 만료를 결합하고 필수 정수 TTL 1~60분의 승인을 받는다. 호출은 한 번만 claim하며 오류·취소·강제 종료 후 재호출하지 않는다. 검증된 `path/content`와 원시 응답 hash만 저장하고 잘못된 응답·원시 오류·token은 기록하지 않는다.

실제 adapter는 macOS arm64 native Codex 0.154.0의 canonical 경로·권한·SHA-256·버전을 확인한다. CLI 자체의 read-only 옵션 외에 SBPL로 파일 읽기·쓰기·프로세스 실행·네트워크를 제한하고, 같은 profile로 host canary·영역 밖 쓰기·추가 exec·다른 TCP/Unix socket 거부를 실제 호출 전에 진단한다. Codex는 새 HOME/CODEX_HOME와 최소 환경을 사용하며 기존 설정·규칙·hooks·MCP·plugins·도구를 상속하지 않는다.

사용자가 선택한 기존 ChatGPT 로그인 또는 전용 API 키는 부모만 읽고 broker의 고정 upstream 요청에 사용한다. 자식과 guardian에는 실제 credential 대신 매 호출 난수 capability만 전달한다. broker는 Codex가 보낸 본문을 그대로 전달하지 않고 계획한 모델·고정 입력·JSON schema·빈 tools로 새 요청을 구성한다. upstream 최대 한 번, redirect·재시도 없음, 전체 60초·최종 응답 16KiB·Codex 출력 128KiB·broker 입력/upstream 응답 각각 256KiB를 적용한다. 부모 IPC 단절·취소·시간 초과를 guardian이 감시해 자식 그룹을 종료하고, 정상 호출 흐름은 자식과 broker close를 기다린다.

응답은 정확한 두 문자열 키와 한 파일, 8KiB 내용 한도·비밀 패턴·NUL·Unicode·무변경 검증을 통과해야 READY가 된다. Codex 이벤트에서 도구·다른 오류·불완전 응답을 거부하되 지정 모델의 정확한 metadata 부재 경고문만 예외로 허용한다. fallback metadata 사용은 모델 metadata가 완전하거나 최적의 동작이라는 보장이 아니다. 최종 JSON과 완료 turn을 각각 한 건 확인하며 유효한 JSON도 코드의 의미나 안전성을 승인한 것으로 취급하지 않는다.

내보내기는 같은 UUID의 READY를 EXPORTED로 한 번 소비한 후 내용과 입력/응답/설정 hash를 반환한다. 이후 실행 DB나 source 준비가 실패해도 소비를 되돌리지 않는다. 새 실행 계획은 이 근거와 검증 버전·실제 patch·브랜치·기준·Docker 정책을 다시 hash에 묶어 소유자 승인을 받는다. 신뢰하는 하네스가 승인한 `src/message.mjs`만 쓰고, 제안 코드는 Git 없는 읽기 전용 Docker view의 등록 검사에서만 실행한다. 기존 4-C-3의 source/main·Git 증거·diff·취소·복구 경계를 유지한다.

호출 경로의 inspect/cancel은 전역 lease를 우회하는 짧은 DB 트랜잭션이며 run/recover는 lease를 유지한다. 취소 generation은 늦은 응답을 READY로 저장하지 못하게 하고 READY 취소는 export를 차단한다. 중단된 RUNNING은 명시 recover로 INTERRUPTED가 되며 재호출하지 않는다. EXPORTED의 소비는 취소·복구로 되돌리지 않는다. 실행 경로의 제어·관찰은 기존 3-D와 같은 방식이다. 회사 자료·회사 저장소·Slack 요청·Codex 직접 작업 트리 수정·작업 결과 commit·push·PR/MR은 연결하지 않는다. 실제 호출과 종료·복구의 검증 범위는 [4-C-4 결과](stage-4c4-result.md)를 따른다.

기존 `ExecutionPort`의 항상 거부 동작을 유지하며 합성 실행과 고정 Slack 단건 시험을 각각 별도 명령·승인으로 연다. 기존 `approve`·`cancel`과 합성 계획·승인·실행·복구는 전역 lease를 유지한다. 합성 실행의 취소·무효화·조회는 실행 DB의 짧은 트랜잭션으로 전달한다. 실제 Slack 수신과 실행은 직렬화하며 수신 공백의 변경 감지는 보장하지 않는다. 단계 3의 작업 트리는 작업 분리 수단이며 Docker 격리 환경을 대신하지 않는다.

## 6. Slack 연결에서 혼동하지 않을 것

Slack의 `app_mention`은 **앱의 봇 사용자**가 언급된 이벤트다. **내 사용자 계정**이 멘션된 요청을 수집하려면 접근이 허용된 채널의 message 이벤트에서 내 고정 ID를 검사하는 방식이 필요하다.

단계 2의 연결 어댑터는 Socket Mode를 사용한다. 공개 수신 서버가 필요 없지만 앱 설치, 적절한 토큰·scope, 채널 접근 권한과 네트워크 연결은 여전히 필요하다. 기본 manifest는 공개 채널 읽기만 요청하며, 비공개 채널과 DM을 자동으로 확장하지 않는다. 이벤트 종류와 스레드 조회 권한은 연결 시점의 Slack 공식 문서 및 회사 관리 설정으로 확인한다.

Slack 재시도, 빠른 ACK와 후속 처리, 속도 제한, 봇·자기 메시지 루프, 편집·삭제를 처리한다. 요청 내용이 바뀌면 연결된 계획과 승인을 다시 검증한다. 내 ID 멘션이나 이모지 반응을 자동으로 실행 승인으로 해석하지 않는다. MVP의 승인은 로컬 CLI에서만 받는다.

## 7. 첫 완료를 판단하는 기준

실제 외부 연결보다 경계를 먼저 검증한다. 합성 데이터로 문의·변경 요청·불명확을 재현하고, 대상 저장소 전후 상태를 비교하며, 승인 전 파일 변경과 승인 없는 외부 전송이 모두 0임을 확인한다.

상세 fixture와 수용 테스트 목록은 [구현 계획](implementation-plan.md)에 둔다. 테스트 결과는 통과·실패·미실행을 구분한다. 회사 연결과 격리 실행기의 검증은 로컬 모의 테스트와 별도의 완료 항목이다.

