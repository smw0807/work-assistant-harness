# 단계 4-B-1 구현 결과

## 범위와 상태

2026-11-11의 후속 요청으로 **기본 비활성 HTTP 포트와 오프라인 Slack 요청·응답 계약 진단**을 구현했다. 최종 회귀 324개와 lint·typecheck·build가 통과했다. 상세 범위와 수용 기준은 [4-B-1 계획](implementation-plan.md#단계-4-b-1-오프라인-slack-http-계약-진단)을 따른다. 실제 전송과 회사 검증은 아래 표의 `not_run`으로 구분한다.

고정 합성 workspace/channel/bot/user·원래 스레드·일반 텍스트·가짜 token과 메모리 HTTP 응답만 사용한다. 실제 Slack 쓰기 어댑터·계정·scope·실제 토큰·네트워크·회사 자료·자유 본문 입력은 연결하지 않는다. 기존 단계 4-A의 `reply-*`, `synthetic-reply-v1`·`mode: mock`, 전용 승인과 `replies.sqlite`는 변경 없이 보존한다. 이전 단계의 결과 문서는 당시 검증 기록으로 유지한다.

## 구현과 데이터 흐름

```text
slack-post-check → 합성 설정·고정 본문·thread·offline-http intent
  → 기본 disabled HTTP 포트: 호출 0, BLOCKED
  → 진단에서만 합성 HTTP 포트 주입
    → auth.test workspace/bot/user 확인
    → conversations.replies revision/문맥/완전성/만료 확인
    → chat.postMessage JSON 직렬화·receipt 대조
    → OFFLINE_CONFIRMED / NOT_SENT / UNKNOWN / BLOCKED
  → fixture 예상 결과와 비교 → 로컬 report.json
```

| 변경 파일 | 책임 |
| --- | --- |
| `src/domain/slack-post.ts`, `src/ports/slack-post.ts` | 진단 intent·고정 비활성 설정·HTTP 포트·결과·보고서 계약 |
| `src/policy/slack-post-policy.ts` | 합성 설정/본문/대상·hash·진단 만료·허용 모드 검증 |
| `src/adapters/slack-post-message.ts`, `src/adapters/offline-slack-http.ts` | 기본 disabled·합성 HTTP 요청/응답·identity/thread/post 직렬화와 결과 분류 |
| `src/application/verify-slack-post.ts` | fixture별 진단 실행과 예상 결과 비교·민감 원시 자료 없는 보고서 |
| `src/cli/slack-post.ts`, `src/cli/slack-post-worker.ts`, `src/cli/main.ts` | `slack-post-check` 명령·제한 worker·NestJS application context·비공개 보고서 |
| `tests/slack-post-policy.test.ts`, `tests/slack-post-adapter.test.ts`, `tests/slack-post-cli.test.ts` | 정책·HTTP 계약·결과 불확실성·CLI·권한·보고서·기존 흐름 수용 검증 |
| `README.md`, `docs/implementation-plan.md`, `docs/architecture.md`, `docs/security-and-approval.md`, 이 문서 | 실제 명령·상세 수용 기준·권한/진단 경계·검증 결과 |

의존성·패키지 매니저·lockfile을 바꾸지 않았다. 기존 조사 `ExecutionPort`의 항상 거부, 합성 실행과 답장의 승인 분리, 실제 외부 메시지·Git 원격 작업 차단을 유지한다.

## 진단 입력과 HTTP 계약

정책은 `slack-post-contract-v1`, 모드는 `offline-http`, `liveEnabled`는 `false`로 고정한다. `OfflinePostIntent`는 소유자 형식·설정 hash·합성 목적지·본문 hash·원문 revision·문맥 hash·생성/만료 시각을 묶는 진단 입력이다. 생성 후 60초 유효기한은 진단 입력의 expiry이며 소유자의 전송 승인 TTL이 아니다. intent·진단 성공 보고서는 승인 권한을 만들지 않는다. 기존 4-A mock 계획/승인·코드 승인·합성 실행 승인을 수용하거나 소비하는 연결도 없다.

기본 HTTP 포트는 요청을 수행하지 않는다. 진단에서 합성 포트를 명시적으로 주입할 때만 workspace `T_LOCAL`·channel `C_ALLOWED`·bot `B_LOCAL`·bot user `U_BOT`·고정 thread·일반 텍스트를 검증한다. `auth.test` identity 불일치, 원문 변경·새 reply·불완전·만료는 post 전에 `BLOCKED`다. 이 합성 thread 재확인을 실제 수신 문맥의 최신성 보장으로 설명하지 않는다.

post 요청은 JSON으로 직렬화하며 고정한 스레드의 일반 텍스트와 확장 제한을 사용한다. 요청 250ms·응답 16KiB 한도와 redirect 거부를 적용한다. 합성 성공 응답의 channel·message timestamp·thread·bot·본문이 맞고 기존 스레드 메시지 timestamp를 재사용하지 않을 때만 `OFFLINE_CONFIRMED`다. 허용 목록의 명시적 API 거부·rate limit은 `NOT_SENT`, 성공 증거가 섞인 오류·post 이후 서버 오류·timeout·잘못되거나 과대한 응답·receipt 불일치·redirect는 `UNKNOWN`으로 구분한다. 자동 재시도는 모두 0회다. 분류는 합성 HTTP 계약 결과이며 실제 메시지 전달 보장이 아니다.

## 실행·보관·사용 경계

`slack-post-check`는 기존 답장 DB를 열거나 상태·승인·시도를 생성하지 않는 별도 진단이다. 실제 토큰·설정·본문·대상 ID 입력과 실전송 활성화 옵션, 실제 `fetch` transport는 없다. 가짜 token·본문·원시 HTTP 요청/응답은 메모리에서만 사용한다.

NestJS application context를 여는 별도 worker는 Node 권한 모델로 하네스 읽기와 비공개 데이터 디렉터리 쓰기만 허용하고 네트워크·하위 프로세스·추가 worker·외부 native addon 권한과 호스트 토큰을 받지 않는다. 이는 신뢰하는 하네스 코드의 접근 제한이며 악성 코드 실행 sandbox가 아니다.

보고서는 `<data-dir>/slack-post-checks/<verificationId>/report.json`에 저장한다. stdout/report에는 진단/receipt metadata·해시·정적 결과 코드·호출 횟수·`passed`·`failed`·`not_run`을 남기며 본문·가짜/실제 token·원시 HTTP 자료·원시 오류를 넣지 않는다. 진단 metadata 보고서를 회사 운영 보관 정책의 기본값으로 사용하지 않는다.

```sh
pnpm harness slack-post-check --data-dir /private/tmp/harness-slack-post-check
pnpm harness slack-post-check --fixture success --data-dir /private/tmp/harness-slack-post-check
pnpm harness slack-post-check --fixture disabled --data-dir /private/tmp/harness-slack-post-check
```

지원 fixture는 `all`(기본값), `success`, `disabled`, `auth-mismatch`, `source-changed`, `new-reply`, `incomplete`, `expired`, `denied`, `rate-limited`, `server-error`, `timeout`, `malformed`, `oversized`, `receipt-mismatch`, `redirect`다. 예상한 차단·오류도 기대 결과와 일치하면 진단 `passed`이며 전체 통과 시 CLI 종료 코드는 0이다. 정확한 명령과 결과는 [README](../README.md#단계-4-b-1-오프라인-slack-http-계약-진단)를 따른다.

## 검증 결과

| 항목 | 결과 | 근거 또는 미실행 사유 |
| --- | --- | --- |
| `pnpm lint` | passed | 오류 없음 |
| `pnpm typecheck` | passed | 오류 없음 |
| `pnpm test` | passed | 324개, 실패·취소·건너뜀 0. 기존 301개 + 신규 23개 |
| `pnpm build` | passed | TypeScript 빌드 완료 |
| 고정 합성 설정·intent hash·모드·기존 승인 재사용 거부 | passed | 재해시한 모드/정책/대상/본문/설정 변조, 추가 필드, 진단 만료, 숫자로 바꾸지 않은 timestamp·편집 revision·부분 응답 검증 |
| 기본 disabled 호출 0·identity/문맥/만료 post 전 차단 | passed | 기본 포트 호출 0, workspace/bot/user 대조, 변경/새 reply/부분/만료 차단. 기본 all 15개 fixture 예상 상태·호출 수 일치 |
| 요청 JSON·정확한 receipt·미전송/불확실 결과·retry 0 | passed | URL/헤더/JSON 옵션, 각 receipt 필드 및 기존 timestamp 충돌, 알려진 거부·서버 오류·불확실 응답·동일 인스턴스 중복 진단과 자동 재시도 0 검증 |
| 250ms·16KiB·redirect·원시 오류 비노출 | passed | auth/thread/post timeout, 선언/stream 바이트 초과와 지연 응답, redirect, 취소, 성공 증거가 섞인 오류·원시 오류 차단 |
| 제한 worker·비공개 보고서·본문/토큰 비보관·CLI | passed | 실제 CLI 7개: 엄격 옵션·최소 환경/권한·비공개 보고서·symlink/hardlink/기존 파일 보존·lease·보고서/표준 출력 본문 비복사 |
| 기존 조사·수신·실행·4-A 승인과 DB 경계 | passed | 기존 301개 회귀와 새 CLI의 기존 DB 바이트 전후 비교, 새 진단 경로가 기존 Task·승인·Run을 열거나 생성하지 않음 |
| 실제 Slack 전송·계정·token/scope·수신 문맥 경합·live 승인 소비 | not_run | 합성 HTTP 진단 범위에 연결하지 않음 |
| 실제 AI·회사 저장소·Git 원격 작업·회사 자료/보관/보안 검토 | not_run | 실제 자료·계정·외부 서비스 사용 없음 |

수용 15·16의 실제 외부 전송 차단·비밀 비유입과 신규 45~51의 HTTP 계약 진단 기준을 구분한다. 신규 23개는 정책/진단 5개·HTTP 어댑터 11개·CLI 7개다. `all`의 15개 합성 시나리오는 예상한 차단·오류도 일치하면 진단 통과로 판정한다. 같은 어댑터 인스턴스의 메모리 중복 차단을 영속 승인 소비나 실제 전달의 중복 방지로 설명하지 않는다.

검증 환경은 macOS arm64·Node 26.12.1·pnpm 12.18.0이다. 최종 전체 테스트 로그는 이 로컬 환경의 `/private/tmp/work-assistant-harness-stage4b1-final-tests.log`에 남겼다. 실제 Slack·Docker·외부 모델과 회사 저장소에는 연결하지 않았다.

후속으로 `pnpm harness slack-post-check`를 직접 실행해 종료 코드 0과 15개 시나리오 전부 `passed`를 확인했다. verification ID는 `811c560d-d50f-4bdc-b01b-22b6da761713`이며 기본 OS 사용자 데이터 디렉터리의 `slack-post-checks/<verificationId>/report.json`도 대조했다. 결과는 `OFFLINE_CONFIRMED` 1개·`BLOCKED` 6개·`NOT_SENT` 2개·`UNKNOWN` 6개로 기대값과 일치했다. 보고서 권한은 `0600`, 작업 디렉터리는 `0700`이며 `liveEnabled: false`와 실제 외부 전송 `not_run`을 유지했다. 이 로컬 보고서와 런타임 데이터는 Git에 포함하지 않는다.

## 남은 범위와 다음 최소 작업

실제 Slack 쓰기 기능·계정·scope·본문/감사 보관·수신과 전송의 lease 조정·실문맥 경합·새 live 승인 생성/소비·중복·crash 복구는 구현·검증하지 않는다. 기존 4-A 모의 승인이나 4-B-1 intent·성공 보고서를 실전송 권한으로 재사용할 수 없다. 합성 진단 통과는 실제 Slack 전달이나 회사 보안 검토 통과가 아니다.

다음 최소 작업은 4-B-2의 상세 정책과 승인된 테스트 환경을 확정하는 것이다. 회사/계정 승인, 자격증명 보관·최소 scope, 정확한 workspace/channel/thread/bot, 실제 본문·감사·게시 후 보관/삭제, 수신 lease와 새 reply/편집/삭제 경합·문맥 최신성, 실전송 승인 소비와 불확실 결과 복구를 정한 뒤 고정 시험 문구의 단건 전송을 검증한다. push/PR·Gmail/Calendar/Drive는 각각 독립 후속 범위다.
