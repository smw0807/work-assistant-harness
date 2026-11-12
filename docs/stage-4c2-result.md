# 단계 4-C-2 구현 결과

## 상태와 범위

2026-11-12의 범위는 **별도 승인 후 독립 합성 Git 저장소에 작업 유형별 ref 하나를 생성하고 보존·충돌·취소·중단 복구를 검증하는 경로**다. 구현과 검증을 완료했으며 전체 회귀 442개와 lint·typecheck·build가 통과했다. 상세 계약과 수용 71~80은 [4-C-2 계획](implementation-plan.md#단계-4-c-2-합성-git-브랜치-생성관찰복구)을 따른다. 기존 4-C-1의 오프라인 모의 경로와 결과는 유지한다.

이 기능은 하네스가 Codex에 맡길 대상 저장소 작업의 준비 경계를 합성 자료로 검증한다. 현재 하네스 저장소의 개발 브랜치 규칙을 바꾸지 않으며 실제 Codex·회사 저장소·회사 GitLab·코드 실행을 연결하지 않는다. source/workspace를 준비할 때 고정 초기 commit을 각각 만들지만, 승인 후 작업 결과 commit·checkout·코드 수정·push·PR/MR 기능은 제공하지 않는다.

## 데이터 흐름

```text
git-branch-plan → 고정 합성 source/workspace·owner manifest → 계획/hash → AWAITING_APPROVAL
git-branch-approve → OS owner·hash·TTL·소유/기준/ref 부재 확인 → APPROVED
git-branch-create → 재검증 → 승인 소비+RUNNING+claimed 원자 commit
  → writing 기록 → 동기 generation guard·배타적 ref 생성·O_SYNC 쓰기
  → created 기록·관찰 → finished / SUCCEEDED 또는 실패 상태
git-branch-inspect → 저장 상태 조회, 자동 재개 없음
git-branch-cancel → 대기 승인 취소 또는 RUNNING generation fence
git-branch-recover → 소유 작업 영역 관찰 → INTERRUPTED / CANCELLED / BLOCKED
```

## 변경 파일

| 파일 | 역할 |
| --- | --- |
| `src/domain/local-branch.ts`, `src/ports/local-branch.ts`, `src/policy/local-branch-policy.ts` | 별도 정책·계획/승인/관찰 계약과 hash·소유·기한 검증 |
| `src/adapters/local-branch-workspace.ts` | 독립 합성 Git 초기화·동결·고정 트리 관찰·배타적 ref 생성 |
| `src/adapters/sqlite-local-branch-store.ts`, `src/application/local-branch.ts` | 별도 DB·원자 claim·영속 단계·generation guard·취소·명시 복구 |
| `src/cli/local-branch.ts`, `src/cli/local-branch-worker.ts`, `src/cli/main.ts` | 명령별 입력·제한 worker·전역 lease·정적 오류 |
| `tests/local-branch-policy.test.ts`, `tests/local-branch-workspace.test.ts`, `tests/local-branch-store.test.ts`, `tests/local-branch-service.test.ts`, `tests/local-branch-cli.test.ts` | 계획/파일/DB/서비스/CLI 경계·실제 ref·강제 종료/복구 수용 검증 |
| `README.md`, `docs/implementation-plan.md`, `docs/architecture.md`, `docs/security-and-approval.md`, 이 문서 | 실제 명령·설계·수용 조건·검증 범위 |

## 구현 계약

- `local-synthetic-branch-v1`·`local-synthetic`·`create-branch`와 별도 `git-branches.sqlite`를 사용한다. 4-C-1 및 기존 조사·실행·Slack 계획과 승인은 재사용하지 않는다.
- 작업 유형 `feature|fix|chore|refactor`는 필수이며 브랜치는 `<type>/task-<task-id>`다. 실제 저장소·원격·브랜치명·코드·명령은 입력으로 받지 않는다. 작업당 전용 root에 소유 token·manifest와 source/workspace를 배타적으로 준비한다.
- 고정 파일·작성자·시각에서 실제 기준 commit을 각각 만들고 Git 객체나 hardlink를 공유하지 않는다. source는 동결하고 workspace는 refs/heads와 새 유형 디렉터리만 쓰기 가능하다. HEAD/main 및 기존 코드·Git metadata는 유지한다.
- 계획은 owner·root/token·기준 commit·source/workspace hash·브랜치·24시간 기한에 결합한다. 승인은 정확한 hash와 기본값 없는 TTL 1~60분으로 만들고 매 단계의 실제 파일 경계를 다시 확인한다.
- 승인 소비+RUNNING+claimed는 원자적이며 writing/created/finished와 시각·관찰을 영속화한다. generation guard 안에서 ref 하나만 배타적으로 생성하고 `O_SYNC`로 동기 쓰기를 요청한다. 같은 OID의 기존 ref도 덮어쓰지 않으며 실패 뒤 재시도·소비 복원은 없다.
- RUNNING 취소는 fence만 남기며 이미 생성한 ref를 제거하지 않는다. 중단된 RUNNING은 inspect로 재개하지 않는다. 명시 recover는 현재 ref 관찰과 함께 INTERRUPTED/CANCELLED/BLOCKED를 기록하며 생성 사실만으로 성공 판정을 복원하지 않는다.
- 제한 worker와 전역 lease·private DB/sidecar·고정 파일 tree·link/mode/size 검사를 사용한다. 네트워크·child·상속 토큰·원시 오류 출력이 없으며 합성 작업물·감사 metadata를 자동 정리하지 않는다.

## 검증 결과

macOS에서 고정된 Node.js 26.12.1·pnpm 12.18.0으로 검증했다. `pnpm test`는 **442 passed, 0 failed, 0 cancelled, 0 skipped**이며 약 56초가 걸렸다. 기존 397개에 정책 8개·workspace 9개·store 13개·service 7개·CLI 8개를 추가했다. 전체 실행 로그는 로컬 `/private/tmp/work-assistant-harness-stage4c2-final-tests.log`에 남겼다.

| 검사 | 상태 | 근거/사유 |
| --- | --- | --- |
| lint·typecheck·build | passed | `pnpm lint`, `pnpm typecheck`, `pnpm build` 종료 코드 0 |
| 단위·통합·CLI·전체 회귀 | passed | `pnpm test` 442/442, 실패·취소·건너뜀 0 |
| 문서·변경 공백 검사 | passed | `git diff --check`, 변경 파일 공백 검사, 로컬 문서 링크 98개 확인 |
| 수용 71~72: 준비·독립성·네 유형 ref·원본 보존 | passed | 실제 Git ref 조회·네 유형 CLI 실행·원본/기존 파일 hash와 mode·HEAD/main 보존 확인 |
| 수용 73~75: 승인·충돌·파일/경로/한도 | passed | 이전 모의 승인 거부, hash/TTL/취소 검증, 같은 OID 충돌·변조·추가 비밀 파일·링크·한도 차단 |
| 수용 76~78: 원자 claim·취소·강제 종료 복구 | passed | 동시 claim·SQL rollback·생성 후 DB 실패·generation/TTL fence, 쓰기 전후 실제 child SIGKILL 후 새 프로세스 복구 |
| 수용 79~80: worker·lease·기존 기능 회귀 | passed | 실제 제한 worker의 외부 파일/명령/worker/네트워크 거부, 환경·옵션·DB·lease, 기존 DB 보존과 전체 회귀 |
| 실제 Codex·회사 GitLab·제품 저장소·코드 실행 | not_run | 독립 합성 ref 생성 범위 밖 |
| checkout·작업 결과 commit·push·PR/MR | not_run | 실행 포트·명령 제공 없음. 고정 초기 commit은 fixture 준비에만 사용 |

## 한계와 다음 최소 작업

검증 대상은 새로 만든 고정 합성 저장소다. 실제 회사 저장소의 Git 설정·hooks·submodule·LFS·대용량 자료·다른 OS/파일시스템은 다루지 않는다. source의 파일 권한과 소유 manifest는 같은 OS 사용자 및 하네스 코드를 신뢰하는 경계이며 악성 호스트/코드용 sandbox가 아니다.

Node 26 제한 worker에서 `fsyncSync`가 허용되지 않는 것을 확인하고 권한 확장 없이 `O_SYNC`를 사용한다. 실제 검증 범위는 프로세스 중단과 새 프로세스 복구다. 디렉터리 fsync·OS 또는 전원 장애 뒤의 디스크 내구성을 검증하거나 보장하지 않는다.

CLI는 전체 data directory의 전역 lease로 직렬화한다. 내부 generation fence가 있어도 별도 CLI cancel이 진행 중 명령의 lease를 우회하지 않으므로 실시간 인터럽트로 설명하지 않는다. 중단·취소·복구는 관찰만 보존하며 작업물의 수리·ref 삭제·자동 재실행을 하지 않는다. 초기화 도중 중단된 합성 작업물도 자동 정리하지 않는다.

다음 최소 작업은 실제 Codex·코드 수정 연결에 필요한 새 정책·소유자 승인·실행 격리·자료 처리 조건과 수용 기준을 후속 계획으로 확정하는 것이다. 이번 합성 승인을 실제 대상 작업에 재사용하지 않으며 PR/MR 생성은 계속 제외한다.
