# 구조와 흐름

## 이 문서의 상태

이 문서는 `work-assistant-harness`의 구조와 단계별 설계를 설명한다. 실제 구현 경계는 아래 결과 문서로 구분하며, 후속 승인·실행 설계가 이미 사용 가능한 기능이라는 뜻은 아니다.

2026-11-09에 단계 0의 최소 기반과 단계 1의 합성 자료 기반 읽기 전용 CLI를, 2026-11-10에 단계 2의 Slack 수신과 단계 3-A의 로컬 승인·취소 기록, 단계 3-B의 고정 합성 코드 기반 Docker 격리 진단을 구현했다. 실제 구현과 검증 상태는 [stage-1-result.md](stage-1-result.md), [stage-2-result.md](stage-2-result.md), [stage-3a-result.md](stage-3a-result.md), [stage-3b-result.md](stage-3b-result.md)를 따른다. 실제 Slack·AI·회사 저장소 연결과 승인 후 대상 코드 실행은 완료된 기능이 아니다.

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
  → [단계 3-C 이후] 실제 실행 정책의 새 승인·격리 환경에서 변경·허용된 검사
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

실제 실행은 격리 backend 실증 이후 별도 구현한다. 승인된 범위의 로컬 diff와 검사 결과를 보고하는 데까지 진행하며, 외부 메시지와 Git 원격 작업은 별도 기능이다.

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
| ApprovalService | 단계 3-A에서 OS 소유자·계획·기준 커밋·만료·취소 검증과 승인 기록. 소비와 1회 실행은 후속 단계 |
| SandboxVerifier | 단계 3-B에서 로컬 Docker의 합성 probe·유효 정책·종료와 보호 경계를 확인. 대상 코드 실행 권한 없음 |
| ExecutionRunner | 후속 단계에서 승인된 변경과 검사만 실행 |
| TaskStore / Reporter | 상태·감사 기록 저장과 로컬 보고 |

외부 기능은 `MessageSource`, `ModelPort`, `RepoReadPort`, `ExecutionPort`, `ApprovalPort`, `ReportSink`로 나눈다. 모의 조사는 `MockSlackSource`, `FixtureModel`, 제한된 로컬 저장소 읽기와 로컬 보고를 사용한다. 단계 3-A에서 로컬 승인 경로와 SQLite 승인 기록을 추가하고, 단계 3-B는 별도 `SandboxVerificationPort`로 고정 probe를 검증한다. 승인 소비와 실제 실행 연결은 후속 단계에 둔다.

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

```text
RECEIVED → TRIAGED → ANALYZED
  문의      → REPORTED
  불명확    → NEEDS_CLARIFICATION
  변경 요청 → AWAITING_APPROVAL
               → [단계 3-A] APPROVED (실행 없음)
               → [단계 3-C 이후] RUNNING → VERIFYING → REPORTED

예외 → BLOCKED / FAILED / CANCELLED
```

상태 변경은 트랜잭션으로 처리하고 이벤트 중복과 승인 재사용을 데이터베이스 제약으로 막는다. 재시작 후 기록을 복구하되, 중단된 변경을 자동 재실행하지 않는다. `REPORTED`는 보고가 끝났다는 뜻이며 모든 검사가 통과했다는 뜻이 아니다.

단계 3-A는 승인 삽입과 `APPROVED` 전환을 한 트랜잭션으로 처리하고 활성 승인의 중복 생성을 막는다. 만료 조정은 승인 취소와 `AWAITING_APPROVAL` 복귀를, 로컬 취소는 `CANCELLED` 전환을 함께 기록한다. 요청 편집·삭제도 기존 Task 무효화와 같은 트랜잭션에서 승인을 취소한다. Task의 계획·보고 제거와 별개로 승인 스냅샷은 보존한다. 승인 소비와 Run 생성은 아직 없으며 이후 실제 실행 정책의 새 승인이 필요하다.

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
| 4 | 답장, push·PR, Gmail·Calendar·Drive의 선택 확장 | 기능마다 별도의 인증·권한·데이터 범위·승인 검증 |

단계 3-B도 실제 실행 권한을 열지 않고 `ExecutionPort`의 항상 거부 동작과 외부 메시지 전송 차단을 유지한다. 승인·취소 CLI는 기존 전역 lease를 사용하므로 같은 데이터 디렉터리의 실시간 Slack 수신 중에는 거부된다. 수신을 멈춘 동안의 요청 변경 감지는 보장하지 않는다. 단계 3-D 전에 잠금을 재설계하거나 수신·실행을 명시적으로 직렬화하고 무효화 경합을 검증해야 한다. 단계 3의 worktree는 작업 분리 수단이며 보안 격리 환경을 대신하지 않는다.

## 6. Slack 연결에서 혼동하지 않을 것

Slack의 `app_mention`은 **앱의 봇 사용자**가 언급된 이벤트다. **내 사용자 계정**이 멘션된 요청을 수집하려면 접근이 허용된 채널의 message 이벤트에서 내 고정 ID를 검사하는 방식이 필요하다.

단계 2의 연결 어댑터는 Socket Mode를 사용한다. 공개 수신 서버가 필요 없지만 앱 설치, 적절한 토큰·scope, 채널 접근 권한과 네트워크 연결은 여전히 필요하다. 기본 manifest는 공개 채널 읽기만 요청하며, 비공개 채널과 DM을 자동으로 확장하지 않는다. 이벤트 종류와 스레드 조회 권한은 연결 시점의 Slack 공식 문서 및 회사 관리 설정으로 확인한다.

Slack 재시도, 빠른 ACK와 후속 처리, 속도 제한, 봇·자기 메시지 루프, 편집·삭제를 처리한다. 요청 내용이 바뀌면 연결된 계획과 승인을 다시 검증한다. 내 ID 멘션이나 이모지 반응을 자동으로 실행 승인으로 해석하지 않는다. MVP의 승인은 로컬 CLI에서만 받는다.

## 7. 첫 완료를 판단하는 기준

실제 외부 연결보다 경계를 먼저 검증한다. 합성 데이터로 문의·변경 요청·불명확을 재현하고, 대상 저장소 전후 상태를 비교하며, 승인 전 파일 변경과 승인 없는 외부 전송이 모두 0임을 확인한다.

상세 fixture와 수용 테스트 목록은 [구현 계획](implementation-plan.md)에 둔다. 테스트 결과는 통과·실패·미실행을 구분한다. 회사 연결과 격리 실행기의 검증은 로컬 모의 테스트와 별도의 완료 항목이다.

