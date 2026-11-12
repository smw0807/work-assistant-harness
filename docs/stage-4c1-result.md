# 단계 4-C-1 구현 결과

## 상태와 범위

2026-11-12에 대상 저장소의 작업 유형별 브랜치 규칙을 **오프라인 계획·별도 승인·모의 결과**로 검증하는 경로를 구현했다. 이는 하네스가 Codex에 맡길 대상 저장소 작업의 계약이며, 현재 하네스 저장소의 개발 브랜치 규칙 변경이 아니다. PR/MR 생성은 제공하지 않는다. 상세 계약과 수용 63~70은 [4-C-1 계획](implementation-plan.md#단계-4-c-1-오프라인-브랜치-계획승인모의-검증)을 따른다.

실제 Codex·모델·회사 GitLab·제품 저장소는 연결하지 않는다. 실제 Git 브랜치 생성·파일 수정·commit·push는 `not_run`이다. 계획의 source 커밋과 diff hash는 고정 합성 identity이며 실제 저장소 검사 결과가 아니다.

## 데이터 흐름

```text
branch-plan --type <type> → 고정 source·<type>/synthetic-<task-id>·계획 hash → AWAITING_APPROVAL
branch-approve → OS 소유자·hash·필수 TTL → APPROVED
branch-simulate → 승인 소비+SIMULATING+시도 원자 저장 → 고정 모의 adapter
  → SIMULATED / FAILED(NOT_CREATED) / UNKNOWN
branch-cancel / branch-invalidate → 승인 취소·무효화, 진행 중 시도는 UNKNOWN
branch-inspect → 영속 기록 조회, 자동 재실행 없음
branch-recover → 중단된 SIMULATING을 UNKNOWN으로 확정
```

## 변경 파일

| 파일 | 역할 |
| --- | --- |
| `src/domain/branch.ts`, `src/ports/branch.ts`, `src/policy/branch-policy.ts` | 합성 계획·작업 유형·브랜치·hash·소유자·유효기간 계약 |
| `src/adapters/mock-branch-workspace.ts` | 실제 Git 효과 없는 고정 성공·충돌·불확실 모의 결과 |
| `src/adapters/sqlite-branch-store.ts`, `src/application/simulate-branch.ts` | 별도 DB·원자 승인 소비·작업당 시도 한 번·제어·명시 복구 |
| `src/cli/branch.ts`, `src/cli/branch-worker.ts`, `src/cli/main.ts` | 필수 유형·TTL·명령별 입력, 제한 worker·전역 lease·정적 오류 |
| `tests/branch-policy.test.ts`, `tests/branch-store.test.ts`, `tests/branch-cli.test.ts` | 정책·변조·저장 실패·경합·CLI·권한·실제 강제 종료 후 복구 |
| `README.md`, `docs/implementation-plan.md`, `docs/architecture.md`, `docs/security-and-approval.md`, 이 문서 | 실제 명령·단계 경계·수용 조건·검증 결과 |

## 구현 계약

- 정책은 `synthetic-branch-v1`·`offline`·`simulate-branch`다. 기존 조사·실행·답장·live 승인과 DB를 재사용하지 않으며 별도 `branches.sqlite`에 저장한다.
- 계획 생성에 `feature|fix|chore|refactor` 유형이 필요하다. 브랜치명·기준·diff·source·owner·fixture·만료를 hash에 고정하고 임의 경로·원격·브랜치·명령·모델 출력을 받지 않는다.
- 계획 유효기간은 24시간, 승인 TTL은 기본값 없는 정수 1~60분이다. OS UID 소유자와 정확한 hash를 검증하며 승인 만료는 취소 이력과 대기로, 계획 만료는 차단으로 조정한다.
- 승인 소비·시도·작업 상태를 한 트랜잭션으로 저장한 뒤 모의 adapter를 호출한다. task와 approval에 시도 중복 제약을 두고 실패·중단 뒤에도 소비를 복원하거나 같은 작업에 재승인하지 않는다.
- 합성 제어는 이벤트 ID·payload 멱등성과 revision 순서를 검사한다. 진행 중 무효화는 `UNKNOWN`으로 확정하고 늦은 완료를 거부한다. 완료 결과는 유지한다.
- 새 프로세스의 조회는 `SIMULATING`을 보존한다. 중단 상태의 명시 복구는 `UNKNOWN`으로 바꾸며 반복 복구는 멱등이다. 조회는 최신 승인 한 건과 다음 offset, 시도 한 건을 반환한다.
- 모든 명령은 전역 lease와 private DB/sidecar 검사를 사용한다. worker는 네트워크·child·추가 worker·상속 토큰 없이 비공개 데이터 디렉터리만 쓴다. 원시 오류는 출력하지 않는다.

## 검증 결과

최종 회귀 **397개(기존 367개 + 신규 30개)**가 모두 통과했다. 신규 검사는 정책·모의 adapter 8개, store/service 13개, CLI 9개다. 실패·취소·건너뜀은 0개다.

| 검사 | 상태 | 근거/사유 |
| --- | --- | --- |
| lint | passed | `pnpm lint` 종료 코드 0 |
| typecheck | passed | `pnpm typecheck` 종료 코드 0 |
| build | passed | `pnpm build`와 전체 회귀의 TypeScript 컴파일 통과 |
| 단위·통합·CLI·전체 회귀 | passed | `pnpm test` 종료 코드 0, 397개 통과 |
| 문서·변경 공백 검사 | passed | `git diff --check`, 변경 문서의 로컬 링크 대상 확인 |
| 수용 63~64: 합성 계획·별도 승인 | passed | 네 작업 유형·정확한 hash·source 고정·추가 필드/악성 입력·OS 소유자·TTL·만료·immutable snapshot·승인 페이지 검증 |
| 수용 65~66: 원자 소비·모의 결과 | passed | 독립 worker 2개의 claim 경쟁, 시도 INSERT 실패 rollback과 adapter 호출 0, task당 시도 한 번, 충돌/불확실 결과·정적 오류 검증 |
| 수용 67~68: 제어·중단·복구 | passed | event 멱등/충돌·역순 revision·취소 경합·늦은 finish 거부, 실제 child SIGKILL 뒤 새 프로세스의 SIMULATING 보존과 UNKNOWN 명시 복구 |
| 수용 69~70: CLI·경계·회귀 | passed | private DB/sidecar 링크·권한, lease 중 DB 무변경, worker의 넓은 읽기 권한·추가 옵션·상속 토큰 거부, 실제 Node 파일/child/worker/network 차단과 합성 대상/기존 DB hash 보존 |
| 실제 Codex·모델·회사 GitLab·제품 저장소 연결 | not_run | 합성 계약 범위 밖 |
| 실제 브랜치 생성·수정·commit·push·PR/MR | not_run | 어댑터·명령 제공 없음 |

검증 환경은 macOS arm64·Node 26.12.1·pnpm 12.18.0이다. 기본 shell의 다른 버전 대신 이미 설치된 고정 버전 실행 경로를 사용했으며 의존성·lockfile은 변경하지 않았다. 최종 로그는 이 로컬 환경의 `/private/tmp/work-assistant-harness-stage4c1-final-tests.log`에 남겼다. 파일/Git 상태 비교는 별도 임시 합성 canary와 기존 DB 대역 파일을 사용했으며 회사 자료나 실제 대상 저장소를 검사하지 않았다.

## 한계와 다음 최소 작업

브랜치 충돌과 기준 변경은 합성 fixture/제어로만 검증한다. 실제 Git 참조의 동시 변경·worktree 격리·원격 권한·회사 자료 처리는 검증하지 않았다. `SIMULATED`는 실제 작업 완료나 회사 보안 검토 통과를 뜻하지 않는다.

합성 계획·승인 snapshot·모의 receipt·제어 이력은 DB 수명 동안 보관하고 자동 정리하지 않는다. 기존과 같이 같은 OS 사용자와 신뢰하는 하네스 코드를 전제로 하며 악성 호스트로부터의 격리가 아니다. 수신과 모든 브랜치 명령은 전역 lease로 직렬화한다. 취소·실패·복구는 실제 Git 되돌리기나 실행 재개를 수행하지 않는다.

다음 최소 작업은 별도 합성 저장소에서 실제 브랜치 생성·기준 브랜치 보존·충돌·재시작을 검증하는 후속 범위를 계획하는 것이다. 실제 Codex 연결과 commit·push는 새 정책·승인·격리 조건을 별도로 검토한다. PR/MR 생성은 계속 제외한다.
