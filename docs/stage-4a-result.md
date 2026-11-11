# 단계 4-A 구현 결과

## 범위와 상태

2026-11-11의 후속 요청으로 **합성 답장 계획·전송 전용 승인·모의 전송·취소·문맥 무효화·명시적 중단 복구·본문/감사 보관**을 구현했다. 사용자가 채택한 정책과 상세 수용 기준은 [단계 4-A 계획](implementation-plan.md#단계-4-a-합성-답장-계획별도-승인모의-전송)을 따른다. 최종 회귀 301개와 lint·typecheck·build가 통과했다. 아래 `not_run` 항목은 실제 외부 연결과 회사 검증의 미실행 상태다.

입력은 고정 합성 요청과 일반 텍스트 요약이며, `W_LOCAL`·`C_ALLOWED`의 원래 요청 스레드에 단건 답장하는 계획만 만든다. 실제 Slack 수신·조사 Task·AI·회사 저장소와 연결하지 않는다. 토큰·실제 Slack 쓰기 어댑터·임의 본문·DM·다른 채널·멘션·첨부·코드 전문은 범위 밖이다. 기존 단계 1·2·3-A~3-D 결과 문서는 당시 검증 기록으로 보존한다.

## 구현과 데이터 흐름

```text
reply-plan → 고정 합성 source·본문·목적지·보관 정책 → 계획 해시
reply-inspect → 유효 본문·대상·planHash·상태/승인/시도 검토
reply-approve → OS UID·계획·필수 TTL·유효 문맥 → 전송 전용 승인
reply-send → 동일 조건 재검증 → 승인 소비 + SENDING 시도 원자 commit
  → 가짜 어댑터 1회 호출 → SIMULATED / FAILED(NOT_SENT) / UNKNOWN
reply-cancel / reply-invalidate → generation·revision 갱신·미소비 승인 취소
reply-recover → 중단된 SENDING을 UNKNOWN으로 확정, 재전송 없음
reply-prune / 각 명령 시작 → 만료 본문·설정된 terminal 감사 기록 정리
```

| 변경 파일 | 책임 |
| --- | --- |
| `src/domain/reply.ts`, `src/ports/reply.ts` | 답장 계획·만료 본문·승인·시도·제어·보관·모의 전송 계약 |
| `src/policy/reply-policy.ts` | 고정 합성 입력·목적지·본문·해시·OS 소유자·필수 TTL·본문/source 만료·보관 정책 검증 |
| `src/adapters/sqlite-reply-store.ts` | 독립 `replies.sqlite`, 승인 생성/소비·시도·중복·제어·명시적 복구·본문/감사 정리 |
| `src/adapters/mock-reply-delivery.ts`, `src/application/send-reply.ts` | 토큰·네트워크 없는 가짜 전송과 확실한 미전송/불확실 결과 분리 |
| `src/cli/reply.ts`, `src/cli/reply-worker.ts`, `src/cli/main.ts` | 8개 명령·옵션·전역 lease·제한 worker·비공개 DB·본문 stdout 범위 |
| `tests/reply-policy.test.ts`, `tests/reply-store.test.ts`, `tests/reply-service.test.ts`, `tests/reply-cli.test.ts` | 정책·저장소·승인/전송/제어/보관·child process 중단·재시작·CLI 수용 검증 |
| `README.md`, `docs/implementation-plan.md`, `docs/architecture.md`, `docs/security-and-approval.md`, 이 문서 | 사용자 명령·채택 정책·구조·상세 수용 기준·검증 경계 |

의존성·패키지 매니저·lockfile은 변경하지 않았다. 기존 `ExecutionPort`의 항상 거부와 `run`의 `UNKNOWN_COMMAND`, 실제 외부 전송 차단은 유지한다. 코드 변경 승인·합성 실행 승인·답장 승인은 서로 재사용하지 않는다.

## 승인·상태·복구 계약

계획은 `policy: synthetic-reply-v1`, `mode: mock`으로 고정한다. `planHash`에는 OS 소유자, 합성 source identity·요청/문맥 revision·완전성·공백·만료, 정확한 목적지, 본문 해시/바이트 수, 생성·만료 시각·보관 정책과 fixture를 결합한다. 본문은 코드에 고정한 일반 텍스트 요약과 정확히 일치해야 하며 알려진 비밀/개인정보 패턴·멘션·코드·링크 형태를 추가 검사한다. 이 검사를 실제 회사 자료 처리 정책의 승인 근거로 쓰지 않는다.

승인자는 `process.getuid()`의 `os-user:<uid>`로 고정하고 UID 미지원 환경·다른 소유자·정확하지 않은 계획 해시를 거부한다. `--expires-in-minutes`는 기본값 없이 정수 1~60분이 필수이며 30분을 권장한다. 실제 만료는 신청 TTL과 본문/source 유효기한 중 짧은 값이다. 합성 source는 생성 후 24시간에 만료한다.

`replies.sqlite`는 기존 조사·실행·Slack 수신과 분리한다. 승인 INSERT와 `APPROVED` 전환, 승인 1회 소비와 `SENDING` 시도 생성/상태 변경은 각각 원자적이다. 소비한 승인 `usedAt`은 실패해도 되돌리지 않는다. 같은 승인·활성 시도를 중복 사용하지 않는다. 승인 이력은 최신순 1개씩 `--approval-offset`으로 조회하고 시도는 최신 20개와 전체 개수를 반환한다.

요청 편집·삭제·새 reply·수신 공백·불완전·만료는 합성 제어 이벤트로 무효화한다. 대기 중 소유자 취소는 `CANCELLED`, 나머지 문맥 무효화는 `BLOCKED`이며 `SENDING` 무효화는 불확실한 `UNKNOWN`이다. 같은 이벤트 ID·내용은 멱등 처리하고 다른 내용의 ID 재사용은 거부하며 오래된 revision은 상태를 되돌리지 않는다. 기존 본문·목적지·계획을 직접 변경해 기존 승인을 재사용할 수 없다. 실제 Slack 변경 감지는 연결하지 않는다.

가짜 전송 성공은 `SIMULATED`이며 실제 Slack 전송이 아니다. `NOT_SENT`는 Task `FAILED`로 남고 새 승인으로만 수동 재시도한다. `unknown` fixture와 어댑터 예외는 `UNKNOWN`으로 남기며 새 승인·재전송을 차단한다. 승인 소비 이후 DB 종료·프로세스 중단 등으로 남은 `SENDING`은 문맥이 유효하면 시작·조회 시 그대로 보존하고 명시적 `reply-recover`로 `UNKNOWN`을 확정한다. 별도 본문/source 만료·무효화도 진행 중 시도를 `UNKNOWN`으로 차단하며 자동 전송하지 않는다. 반복 복구는 전송을 만들거나 소비 승인을 복원하지 않는다.

## 본문·감사 보관과 접근 경계

본문은 별도 만료 payload에만 저장하며 계획·승인 snapshot·전송 시도·영속 보고서에 복제하지 않는다. `bodyRetentionHours`는 1~168시간·기본 24시간이다. 실제 본문·계획 만료는 설정 기한과 source의 24시간 기한 중 더 이른 값이다. `reply-plan`·`reply-inspect`만 유효 본문을 stdout에 표시하며 나머지 명령 출력에는 본문을 포함하지 않는다. 사용자가 redirect한 출력은 사용자의 보관 정책을 따른다.

`auditRetentionDays` 미지정 `null`은 본문 없는 합성 metadata를 DB 수명 동안 보관한다. 정수 1~3650일을 명시하면 terminal 작업의 마지막 상태 갱신부터 해당 기간 뒤 감사 metadata를 제거한다. terminal 본문 만료는 기존 상태·실패 코드·generation·갱신 시각을 보존하며 감사 보관 시계를 연장하지 않는다. 후속 제어로 상태를 갱신하면 감사 정리 시점은 늦어질 수 있다. 진행 중 작업은 삭제하지 않는다. 감사 정리 후 최소 task ID·계획 해시 중복 marker는 DB 수명 동안 유지하고 같은 task ID를 되살리지 않는다. 이 기본값은 회사 운영 보관 정책이 아니며 실제 도입 전 metadata·DB 폐기·백업 정책을 별도 확정해야 한다.

정리는 각 답장 명령 시작과 `reply-prune`에서 수행한다. 프로그램 중지 중에는 다음 실행까지 만료 자료가 남을 수 있으며 SQLite 논리 삭제는 디스크·백업의 물리적 완전 삭제를 보장하지 않는다.

모든 답장 명령은 기존 전역 lease를 사용해 같은 데이터 디렉터리의 실시간 Slack 수신과 직렬화한다. 답장 worker는 하네스 읽기와 비공개 데이터 디렉터리 쓰기만 허용하고 Node의 네트워크·하위 프로세스·worker·외부 native addon 권한을 주지 않는다. 환경은 `LANG`·`TZ`만 전달하고 토큰을 상속하지 않는다. macOS가 최소 환경에서도 자동 생성하는 `__CF_USER_TEXT_ENCODING`은 Darwin에서 문자 인코딩 메타데이터로만 허용한다. DB·저널의 소유 UID·비공개 권한·symlink/hardlink를 검사한다. 같은 OS 사용자와 하네스 코드를 신뢰하는 접근 제한이며 별도의 악성 코드 실행 sandbox를 뜻하지 않는다.

## 사용 가능한 명령

정확한 예제와 옵션은 [README](../README.md#단계-4-a-합성-답장과-전송-전용-승인)에 기록한다.

- `reply-plan [--fixture success|not-sent|unknown|incomplete|gap] [--body-retention-hours 1..168] [--audit-retention-days 1..3650]`
- `reply-inspect --task <uuid> [--approval-offset 0..1000000000]`
- `reply-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 1..60`
- `reply-send --task <uuid> --plan-hash <sha256>`
- `reply-cancel --task <uuid> [--event-id <synthetic-id>]`
- `reply-invalidate --task <uuid> --event edited|deleted|reply|gap|incomplete|expired --revision 2..1000000000 --event-id <synthetic-id>`
- `reply-recover --task <uuid>`
- `reply-prune`

모든 명령은 `pnpm harness` 뒤에 붙여 실행하고 같은 `--data-dir <private-directory>`를 지원한다. `reply-send`는 `SIMULATED` 이외 결과에서 JSON과 종료 코드 1을 반환한다. `reply-cancel`의 이벤트 ID 생략 시 새 UUID를 생성한다. 실제 이벤트 파일·본문·모델·저장소·Slack 토큰·소유자를 지정하는 옵션은 제공하지 않는다.

## 검증 결과

| 항목 | 결과 | 근거 또는 미실행 사유 |
| --- | --- | --- |
| `pnpm lint` | passed | 오류 없음 |
| `pnpm typecheck` | passed | 오류 없음 |
| `pnpm test` | passed | 301개, 실패·취소·건너뜀 0. 기존 271개 + 신규 30개 |
| `pnpm build` | passed | TypeScript 빌드 완료 |
| 합성 목적지·본문·계획·OS 소유자·TTL 정책 | passed | 정책 5개: 목적지/모드/정책/추가 필드 변조·비밀/개인정보/멘션·문맥·만료·보관 해시 |
| 승인 생성/소비 원자성·중복·만료·미전송 새 승인 | passed | 실제 SQLite rollback trigger, 별도 Worker 동시 claim, 새 승인 수동 재시도·과거 usedAt 보존 |
| 문맥 무효화·취소·이벤트 중복/역순·변조 | passed | 7종 제어·ID 재사용·오래된 revision·body/승인/task 변조. 새 reply 뒤 소유자 취소 회귀 포함 |
| 중단된 SENDING·새 프로세스·명시적 복구 | passed | 실제 child-process SIGKILL 뒤 조회 SENDING 유지·복구 UNKNOWN·소비 승인 유지·재전송 차단·반복 복구 멱등 |
| 본문 분리·만료·감사 정리·최소 중복 marker | passed | DB 전 테이블 본문 비복사, payload 제거·terminal 감사 시계 보존·감사 만료·tombstone 재생성 차단 |
| CLI·제한 worker·lease·private DB·기존 흐름 회귀 | passed | 실제 CLI 6개: 8개 명령·TTL/옵션·결과/exit·상속 토큰/광범위 권한 거부·파일/child/TCP 접근 차단·전역 lease·symlink/public DB |
| 실제 Slack 전송·토큰 권한·AI·회사 저장소·Git 원격 작업 | not_run | 합성 모의 전송 범위에 연결하지 않음 |
| 회사 자료 반출·보관·보안 검토 | not_run | 회사 자료를 사용하지 않았으며 별도 회사 승인이 필요 |

수용 15·16은 실제 외부 전송·Git 원격 작업 차단과 비밀 미유입을 유지하는 기준이며, 37~44는 이번 모의 답장 흐름의 상세 기준이다. 신규 30개는 정책 5개·저장소 15개·서비스 4개·CLI 6개다. 서비스 검증에는 실제 controller 강제 종료, 전송 중 삭제와 완료 경합, 원시 어댑터 오류의 정적 코드 치환을 포함한다. 저장소는 최신 20개 시도와 전체 개수를 구분하고 승인 이력을 한 건씩 조회한다.

검증 환경은 macOS arm64·Node 26.12.1·pnpm 12.18.0이다. 전체 회귀는 기존 조사 전후 상태·실행/Slack 수신 경계 테스트도 포함하며, 이번 단계에서 실제 Docker 또는 Slack에 연결하지 않았다. 최종 테스트 실행 로그는 이 로컬 환경의 `/private/tmp/work-assistant-harness-stage4a-final-tests.log`에 남겼다. 합성 검증을 실제 회사 자료·Slack 전송·회사 보안 검토의 통과로 해석하지 않는다.

## 남은 범위와 다음 최소 작업

실제 Slack 쓰기·인증·권한·업무 자료·모델·회사 저장소·수신과 답장 연결은 구현·검증 범위 밖이다. 합성 성공은 실제 전송 권한·메시지 전달 보장·회사 보안 검토 통과를 뜻하지 않는다. 불확실한 전송의 재시도나 수신 공백의 최신성 보장도 제공하지 않는다.

다음 최소 작업은 4-B의 실제 Slack 연결이 필요한지 정하고, 필요하다면 승인된 테스트 환경·최소 쓰기 권한·정확한 목적지·문맥 최신성 확인·불확실 전달 처리·회사 보관 정책을 별도 설계하는 것이다. push/PR·Gmail/Calendar/Drive는 각각 독립된 후속 범위다.
