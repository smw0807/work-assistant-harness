# 단계 3-A 구현 결과

## 범위와 상태

2026-11-10에 합성 변경 요청의 **로컬 승인·취소와 SQLite 승인 기록**을 구현했다. lint·typecheck·전체 138개 테스트와 별도 build를 통과했다. 단계 3 전체의 완료나 실제 격리 실행의 완료를 뜻하지 않는다.

실제 Slack·AI·회사 저장소를 연결하지 않고 의존성을 추가하지 않는다. `ExecutionPort`의 항상 거부 동작을 유지하며 `run` 명령은 구현하지 않는다. 대상 제품 저장소의 코드 수정·설치·검사·빌드와 외부 메시지·Git 원격 작업은 수행하지 않는다.

## 구현 범위

- NestJS와 외부 어댑터에서 분리한 승인 규칙, OS UID 기반 `os-user:<uid>` 소유자 확인. UID 미지원 환경은 거부한다.
- 계획 스냅샷·해시·요청 revision·저장소·기준 커밋·소유자·만료·취소·사용 기록을 가진 별도 SQLite 승인 테이블. Task 계획이 제거돼도 불변 승인 스냅샷은 보존한다.
- 필수 TTL 1~1440분의 로컬 `approve`, 승인 대기·승인됨 변경 요청의 `cancel`, 최신순 1개 페이지로 나눈 `inspect`의 승인 이력 조회.
- 승인 INSERT와 `APPROVED` 전환, 취소와 `CANCELLED` 전환, 만료 조정과 `AWAITING_APPROVAL` 복귀의 트랜잭션 처리. 활성 승인 중복을 거부한다.
- Slack 요청 편집·삭제의 기존 Task 무효화와 동일 트랜잭션에서 승인 취소.
- `executionPolicy: approval-only-v1`, `usedAt: null`인 승인 기록. 후속 실제 실행 정책에서 재사용하지 않는다. 승인 소비·Run 생성은 이번 범위 밖이다.

## 변경 파일과 책임

| 경로 | 구현 |
| --- | --- |
| `src/domain/approval.ts`, `src/domain/types.ts`, `src/domain/state.ts` | 기존 계획 해시와 호환되는 검증, 승인 계약·무효화 규칙, `APPROVED`와 취소·재승인 상태 전이 |
| `src/ports/index.ts`, `src/adapters/denied-actions.ts` | 교체 가능한 승인 저장 포트와 거부 어댑터, 실행 포트의 항상 거부 유지 |
| `src/adapters/sqlite-task-store.ts` | 기존 DB에 승인·취소 이력 테이블 추가, 활성 승인 유일성, 원자적 승인·취소·만료 조정과 이력 페이지 |
| `src/adapters/sqlite-slack-inbox.ts` | 요청 무효화와 동일 트랜잭션에서 승인 취소, 불변 스냅샷 보존 |
| `src/application/approve.ts`, `src/application/investigate.ts` | 승인·취소와 로컬 보고서 동기화, 공통 계획 해시와 정확한 실행 미실행 안내 |
| `src/cli/main.ts`, `src/cli/harness.module.ts`, `src/cli/worker.ts`, `src/cli/slack-worker.ts` | 명령별 인자 제한, OS UID 확인, 기존 권한·잠금 유지, 재시작 시 승인 조정과 보고서 복구 |
| `tests/approval.test.ts`, `tests/approval-cli.test.ts`, `tests/approval-report.test.ts` | 도메인·SQLite 19개, 실제 제한 CLI 7개, 보고서 쓰기 실패 후 복구 2개 |
| `tests/cli.test.ts`, `tests/workflow.test.ts` | 기존 승인 명령·포트 계약의 회귀 검증 갱신 |
| `README.md`, `docs/implementation-plan.md`, `docs/architecture.md`, `docs/security-and-approval.md` | 실제 명령과 단계 3-A~3-D의 구현·검증 경계 |

패키지 설정·의존성·lockfile은 변경하지 않았다. 승인 이력은 최신순 한 건씩 조회하여 전체 스냅샷 누적으로 CLI 출력 한도를 넘지 않게 한다. 저장된 Task·Approval은 각각 256,000바이트 이하로 읽고 승인 저장 시에도 한도를 확인하며, worker 출력은 최대 1MiB로 제한한다.

## 로컬 명령

```sh
pnpm harness replay --fixture change --data-dir /private/tmp/harness-demo-data
pnpm harness inspect <task-id> --data-dir /private/tmp/harness-demo-data
pnpm harness approve <task-id> --plan-hash <sha256> --base-commit <sha1> --expires-in-minutes 30 --data-dir /private/tmp/harness-demo-data
pnpm harness inspect <task-id> --data-dir /private/tmp/harness-demo-data
pnpm harness inspect <task-id> --approval-offset 1 --data-dir /private/tmp/harness-demo-data
pnpm harness cancel <task-id> --data-dir /private/tmp/harness-demo-data
```

`<task-id>`, `<sha256>`, `<sha1>`은 `replay`·`inspect` 결과에서 확인한다. `--data-dir`는 선택이며 동일한 작업에는 같은 데이터 디렉터리를 사용한다. `inspect`의 `--approval-offset <0..1000000000>`는 기본 0이며 최신순으로 승인 1개를 `result.approvals`에 반환한다. `result.approvalPage { offset, total, nextOffset }`의 `nextOffset`이 있으면 그 값으로 다음 페이지를 조회한다. `approve`·`cancel`도 최신 1개 페이지를 반환하며 만료·취소 이력을 포함한 전체 기록은 DB에 보존한다. worker stdout은 최대 1MiB다. `pnpm harness run <task-id>`는 `UNKNOWN_COMMAND`로 거부된다.

## 검증 결과

| 항목 | 결과 | 근거 또는 사유 |
| --- | --- | --- |
| `pnpm lint` | passed | ESLint 오류 없음 |
| `pnpm typecheck` | passed | strict TypeScript 검사 통과 |
| `pnpm test` | passed | 기존 110개와 신규 28개, 전체 138개·실패 0개·미실행 0개 |
| `pnpm build` | passed | 전체 테스트 후 별도 컴파일 통과 |
| 승인 입력·OS 소유자·TTL·불변 계획 검증 | passed | hash·base·repo·revision 불일치, 내용 변조·unknown field·owner 옵션 및 환경변수 주입 거부 |
| 원자적 승인·활성 중복 거부·만료와 취소 | passed | TTL 경계·유일성 제약·재시작, Task 갱신 실패 시 승인 INSERT 및 취소 rollback |
| 요청 편집·삭제와 승인 취소의 원자성 | passed | 같은 수신 트랜잭션의 Task 취소·approval revoke, 원래 계획 스냅샷 보존 |
| 실행 거부·승인 이력·잠금·대상 무변경 | passed | `run` 거부·미소비, lease 경합, 전후 해시, 다국어 승인 이력의 페이지 조회 |
| 승인·취소 commit 후 보고서 쓰기 실패 | passed | DB 상태와 승인 이력을 보존하고 재시작 후 보고서 복구·중복 승인 거부 |
| 승인 소비·Run 생성 | not_run | `approval-only-v1`은 기록 전용이며 후속 실행 승인으로 재사용하지 않음 |
| 실제 격리 backend·patch·대상 설치·테스트·빌드 | not_run | 단계 3-B~3-D 미구현 |
| 실제 Slack·AI·회사 저장소·외부 전송 | not_run | 별도 권한과 환경 검증이 필요한 범위 밖 기능 |

macOS·Node 26.12.1·pnpm 12.18.0에서 검증했다. 기존 수신 권한 테스트의 Node 실험적 `--allow-net` 경고 1건은 실패가 아니며 실제 네트워크 연결도 수행하지 않는다. 모의 테스트 통과는 실제 Slack 권한·회사 보안 검토·격리 실행의 검증을 대신하지 않는다.

## 한계와 다음 최소 작업

- 로컬 OS 사용자와 비공개 런타임 디렉터리가 신뢰 경계다. 같은 OS 계정 공유나 호스트 침해를 방어하는 원격 인증 서비스가 아니다.
- 현재 기준 커밋 검증은 Task·불변 계획·CLI 입력과 이번 명령이 준비한 합성 저장소의 고정 커밋 일치 검사다. 명령마다 새 합성 저장소를 준비하며, 실제 대상 저장소·worktree identity의 영속화와 실행 직전 상태 확인은 후속 단계다.
- 승인·취소는 기존 전역 lease를 사용하므로 같은 데이터 디렉터리의 실시간 Slack 수신 중에는 거부된다. 수신을 멈춘 구간의 편집·삭제 감지는 보장하지 않는다. 실제 실행 전에는 잠금 재설계 또는 명시적 직렬화와 무효화 경합 검증이 필요하다.
- 승인 스냅샷은 감사 자료이며 자동 보관 기간·삭제 정책을 추가하지 않았다. 실제 회사 자료를 처리하기 전에 보관 정책을 별도로 정해야 한다.
- 다음 최소 작업은 단계 3-B의 실제 격리 backend 하나를 선정하고 호스트·원본·승인 DB·공유 Git 메타데이터·네트워크·자원·하위 프로세스 제한을 실패 테스트로 실증하는 것이다. 이를 마친 뒤 고정 합성 patch와 등록 명령 사양, 새 실행 승인을 단계 3-C로 연결한다.

전체 기준과 이후 순서는 [단계 3 계획](implementation-plan.md#단계-3-승인-후-코드-변경), 권한 경계는 [보안과 승인](security-and-approval.md)을 따른다.
