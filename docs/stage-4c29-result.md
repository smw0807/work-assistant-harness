# 단계 4-C-29: 만료 자료 정리와 본문 조회 없는 v3 prune

2026-11-20. 사용자가 지정한 만료 파일107개와 준비 DB5곳의 정리를 완료했다. 파일107개·빈 디렉터리36개를 제거하고 DB의 만료 payload5개를 삭제했다. 감사 record5개는 기존 기한까지 보존했다. 회사 레포와 실제 인증정보에 접근하지 않았으며 native Codex·실제 모델·외부 서비스 호출은 없었다.

## 만료 파일 정리

[4-C-28](stage-4c28-result.md)에서 작성한 목록의 유효한 감사 기한과 각 자료의 만료를 확인했다. 고정한 두 임시 경로에서107파일의 device/inode·소유자·권한·link 수·크기·수정 시각을 metadata로 대조했다. 본문을 열거나 hash를 다시 계산하지 않았다.

별도 일회용 helper는 디렉터리 FD를 기준으로 허용된 상대 경로만 처리하며 symlink·hardlink·식별자 불일치를 거부한다. 읽기 전용 임시 디렉터리에는 삭제에 필요한 소유자 쓰기 권한만 일시적으로 추가한다. 목록 밖 파일은 삭제하지 않고 디렉터리는 비어 있을 때만 제거한다. 삭제 의도와 확인 결과를 기록하며, 실패 시 부분 결과와 권한 복원 상태를 남긴다. 같은 OS 사용자의 모든 파일시스템 경합을 원자적으로 차단한다는 보장은 아니다.

합성7사례로 정확한 삭제, 변경 파일·symlink·hardlink 보존, 새로 생긴 목록 밖 파일 보존, 부분 실패 후 권한 복원, 미만료 자료 거부를 확인했다. 실제 삭제 전107파일 모두 기존 식별자와 같았다. 삭제 후107경로의 부재, 빈 디렉터리36개 제거와 남는 부모 디렉터리1곳의 원래 권한 복원을 확인했다. 제거한 파일의 metadata상 합계는1,878,845B다.

## v3 정리 경로 보완

기존 `company-readonly-v3-prune`은 store 생성자와 transaction의 전체 검증 과정에서 만료 payload도 조회·hash·JSON 해석한 뒤 삭제했다. 이 경로를 그대로 실행하지 않고 prune 전용 store를 추가했다.

- `SqliteCompanyReadonlyV3Store.openForPrune()`는 기존 DB만 열고, schema·경로·소유자·record hash·상태·기한과 payload의 만료/hash metadata를 검증한다.
- 전용 경로는 `payload_json`의 조회·길이 계산·hash·JSON 해석을 하지 않는다. 만료 payload를 삭제하고 감사 기한이 남은 record는 `EXPIRED`로 보존한다.
- 미만료 payload는 본문 유효성 판정 없이 그대로 둔다. 전용 객체의 create/inspect/cancel과 본문 읽기는 거부한다.
- 일반 store의 기존 전체 본문 검증은 유지했다. DB schema, 기존 CLI 이름과 출력 계약, 수집·실행 한도와 승인 권한은 변경하지 않았다.

합성 검사에서는 SQLite authorizer로 `payload_json` column의 READ를 거부한 상태에서 생성자·transaction·prune을 실행했고 읽기 시도는0이었다. 손상된 만료 본문 삭제와 미만료 본문 보존, 정확한 TTL 경계, owner/schema/record/payload metadata 변조 거부, 실패 rollback과 일반 모드의 손상 본문 거부를 확인했다. 이는 SQL 본문 조회·해석을 막는 보장이며 SQLite 내부 페이지 접근을 없앤다는 뜻은 아니다.

## 실제 DB 정리와 검증

현재 설치 pnpm으로 기존 `company-readonly-v3-prune`을5곳에 순차 실행했다. 각각 payload1개·record0개·run0개를 제거했고 worker 종료를 확인했다. 전후 관찰은 본문 column READ를 차단한 읽기 전용 연결에서 metadata만 조회했다. 이후 payload0개, 감사 record5개와 기존 owner·plan hash·보관 기한 보존을 확인했다. 모든 실행의 승인 생성·전송·실행 권한은 계속 `false`다.

| 항목 | 결과 |
| --- | --- |
| 파일 정리 helper 합성 검사 | passed — 7개 |
| v3 store·CLI·application 집중 검사 | passed — 39개, 전체 회귀에 포함 |
| lint / typecheck / build | passed — build는 전체 test 스크립트에 포함 |
| 전체 회귀 최종 결과 | passed — 총2,002개 중1,966 passed, 0 failed, native opt-in36 skipped |
| 실제 만료 파일 정리 | passed — 107파일·빈 디렉터리36개 제거, 남는 디렉터리 권한1곳 복원 |
| 실제 DB5곳 정리 | passed — payload5개 제거, 남은 payload0개·감사 record5개 보존 |
| 기존 package·lockfile·수집 profile/한도 | unchanged |
| 회사 레포·실제 인증·native·모델·외부 서비스 | not_run |

첫 전체 회귀는 비공개 로그용 `umask 077`이 테스트 fixture에 전달돼 권한 관련11개가 실패했다. [인수인계](company-offline-handoff.md)의 `umask 022`를 테스트 자식에 적용하고 비공개 로그 권한은0600으로 유지한 재실행에서 모두 통과했다. 이를 해결하려고 테스트 assertion이나 보안 규칙을 변경하지 않았으며 첫 실패 기록도 보존했다. pnpm 버전 고정·자동 전환·의존성 설치는 하지 않았다.

## 보관과 범위

실행 감사와 공유용 집계는 `/private/tmp/harness-company-expired-cleanup-bbr93go3`에 있으며, 이전 목록에서 이어받은 가장 이른 감사 기한인2026-11-20 23:55:45Z를 유지한다. 삭제 대상은 승인된107파일과 DB5곳의 만료 자료로 한정했다. 나중에 만료될 최종 검토 자료, 아직 기한이 남은 감사 자료, 회사 코드·브랜치·커밋·복구한 Git 객체는 정리 대상이 아니다.

파일 unlink와 SQLite 삭제를 확인한 결과이며 백업·저장장치의 물리적 완전 삭제나 모든 임시 경로의 정리 완료를 뜻하지 않는다. 실제 제품 화면·API 확인은 계속 별도 미실행 범위다. 위 정리·검증 결과는 하네스 변경을 커밋하기 전에 기록했으며 push는 수행하지 않았다.
