# 단계 4-C-31: 합성 원본 레포의 새 브랜치·다중 파일 적용

## 범위와 데이터 흐름

단계 4-C-30의 계획·검토 전용 승인 기능을 `40446ff`로 로컬 커밋한 뒤, 회사 수정 실행기의 두 번째 묶음인 합성 적용 엔진을 구현했다. 이번 구현은 application API이며 새 실행 CLI는 제공하지 않는다. 기존 `company-change-*`의 `review-only` 승인, 기존 단일 파일 합성 실행 계약·상한과 실제 회사 읽기/relay 계약은 유지한다.

`createSyntheticCompanyChangeWorkspace`는 canonical 임시 경로 아래 소유자 전용 디렉터리에 새 합성 Git 원본 레포를 생성한다. 기존 레포 경로를 받아 여는 API는 없다. 복제·worktree를 만들지 않고 이 원본에서 새 브랜치로 전환한 뒤 여러 파일을 적용한다. 초기 fixture 생성에만 기존 `isomorphic-git`를 사용하며 명시적인 합성 작성자로 commit을 만든다. 적용 결과를 자동 commit하거나 Git CLI·hooks·제품 스크립트를 실행하지 않는다.

`SyntheticCompanyChangeService`는 `prepare`, `approve`, `apply`, `inspect`, `cancel`을 제공한다. 생성·승인·적용 과정은 workspace lease로 직렬화한다. 순수 정책과 별도 저장 포트, metadata 전용 SQLite 어댑터, factory 전용 workspace 어댑터를 분리했다. 모델·인증·전송·제품 검사 포트는 없다.

## 계획과 별도 실행 승인

`synthetic-company-change-apply-v1` 계획은 실제 관찰한 원본 root/전체 tree hash, 기준 브랜치·commit·index hash, 새 브랜치·요청 revision, 파일별 `replace/create`·전후 hash·크기, 전체 제안 hash, 소유자·원래 기한·정책 hash를 결합한다. 제안은 기존 strict UTF-8 입력 검증을 통과해야 하며, 선언한 기준과 실제 관찰이 일치해야 한다. 원본 hash에는 파일 내용과 identity·metadata가 포함된다.

새 `synthetic-apply` 승인은 OS 소유자·정확한 계획 hash·명시한 1~60분 기한에 묶는다. 승인과 적용 직전에 원본을 재관찰한다. 동일 활성 승인 재요청은 기한을 늘리지 않으며, 만료·취소·사용된 승인으로 다시 시작하지 못한다. 기존 검토 승인에는 소비 경로가 없고 이번 실행 승인으로 변환하지 않는다.

새 계약의 계획 유효기간은 24시간이다. 제안 본문은 이 DB에 저장하지 않는다. 승인·적용 호출자는 같은 본문을 다시 제공해야 하며 hash·descriptor를 다시 검증한다. 경로·hash·승인·journal 등 본문 없는 metadata는 DB 수명 동안 보존하고, 자동 보관 정리 기능은 아직 없다. 이것을 회사의 보관 기간 정책으로 간주하지 않는다.

## 적용 순서와 보존

SQLite에서 승인 소비와 `APPLYING` 전환을 commit한 뒤 브랜치 `INTENT`를 기록한다. 새 ref와 HEAD를 갱신해 작업 브랜치를 먼저 선택하고 `DONE`을 기록한다. 각 파일도 `INTENT → 파일 적용 → DONE` 순서로 기록한다. journal의 경로와 순서는 계획의 descriptor와 정확히 대응해야 한다. SQLite는 `synchronous=FULL`, 별도 트랜잭션과 hash 검증을 사용한다.

최대 8파일, 파일당 새 본문 64KiB, 새 본문 합계 128KiB, 입력 JSON 256KiB, 계획 JSON 16KiB를 허용한다. 합성 원본 관찰은 전체 tree 1MiB·256 entries, journal은 최대 18 entries, SQLite busy timeout은 100ms다. 기존 계약의 한도를 변경하지 않았다. 이 값은 합성 엔진의 입력·관찰 한도이며 회사 적용 worker의 CPU·RSS·wall-clock 격리 예산이 아니다.

기존 부모 디렉터리 아래 일반 파일의 `replace/create`만 허용한다. 새 브랜치는 `<feature|fix|chore|refactor>/<단일 이름>`으로 제한한다. 경로 탈출·비밀 경로·대소문자 충돌·symlink·hardlink·실행 중 Git 상태·잠금·원본 변조를 거부한다. 선택한 기존 파일은 초기 합성 commit의 본문과 일치해야 하며 새 파일은 없어야 한다. 기존 브랜치·index·비선택 작업을 보존하고 일반 파일 mode를 유지한다.

파일은 같은 부모에 독점 임시 파일을 만들어 본문·mode를 확인하고 sync한 뒤 게시한다. create는 기존 파일을 덮어쓰지 않으며 replace는 관찰한 대상 metadata를 다시 확인한다. 게시 후 부모 디렉터리 sync와 전체 상태 비교를 수행한다. 자기 identity가 확인된 임시 파일과 잠금만 정리하고 외부 잠금을 가져가거나 지우지 않는다.

## 실패와 아직 제공하지 않는 기능

전체 Git·파일시스템 변경을 하나의 원자적 트랜잭션으로 주장하지 않는다. 중간 실패는 `FAILED`와 소비된 승인·부분 journal을 보존하며 이미 적용된 파일·브랜치를 자동으로 되돌리지 않는다. 마지막 상태 기록까지 실패하면 호출이 `OUTCOME_UNKNOWN`으로 끝날 수 있으므로 먼저 `inspect`로 확인해야 한다. lease 해제 실패도 이미 저장된 `APPLIED`/`FAILED` 뒤에 호출 오류로 나타날 수 있으므로 같은 조회 절차를 따른다. 이를 재시도 권한으로 취급하지 않는다.

재개방한 저장소의 `APPLYING` 기록은 조회만 가능하다. 같은 store 인스턴스에서 성공적으로 claim한 controller만 후속 journal과 완료를 기록할 수 있다. 중단 후 자동 재실행·잠금 탈취·적용 재개는 없다. workspace를 기존 경로에서 다시 여는 기능, hard-kill 이후 잔여 파일 판정과 명시적 복구 CLI는 다음 묶음이다.

승인 기한은 claim과 새 mutation을 시작하기 전에 다시 확인한다. 이미 시작한 파일 작업의 완료나 최종 검증이 기한을 넘었다고 파일을 되돌리지는 않는다. 현재 API에는 독립 프로세스 guardian이나 hard wall-clock/RSS 제한이 없다. canonical 경로·identity 검사도 같은 OS 사용자의 모든 일시적 경합을 차단하는 OS 격리가 아니다.

`APPLIED`는 새 브랜치와 승인 파일의 최종 hash 및 보존 상태를 검증했다는 뜻이다. 제품 검사 `checks`는 항상 `not_run`, 전송 권한은 false다. 실제 회사 레포 등록·적용, 제품 검사 profile, native Codex·실제 모델, Slack, 외부 전송, push·PR·병합·배포를 연결하지 않았다.

## 검증 기록

현재 설치된 pnpm 12.16.1과 Node 26.12.1을 사용했다. 패키지 매니저를 새로 고정하거나 설치하지 않았고 `package.json`·lockfile·기존 실행 계약을 변경하지 않았다. 빈 전용 npm 설정·최소 환경에서 native opt-in 변수를 제거해 검증했다. 전체 회귀의 로컬 모의 서버와 자식 프로세스에 필요한 sandbox 예외만 승인받아 실행했다.

| 검사 | 결과 | 근거 |
| --- | --- | --- |
| 신규 정책 | passed | 12개: 정확한 계약·hash·경로·한도·소유자·TTL·검토 승인 분리 |
| 신규 저장소 | passed | 19개: 일회 소비·journal 순서·실패 commit·변조·재개방 후 재사용 거부 |
| 신규 workspace | passed | 12개: 새 브랜치·다중 파일·기준/index/작업 보존·경로/링크/충돌·부분 실패·잠금 정리 |
| 신규 application | passed | 9개: 승인 전 무변경·최신성 재검증·순서·만료·취소·경합·불확실한 결과 유지 |
| lint·typecheck·build | passed | 실제 `package.json`의 기존 스크립트 |
| 전체 회귀 | passed | 총 2,101개 중 2,065개 통과·실패 0개·native opt-in 36개 미실행 |
| 실제 회사 적용·제품 검사·native/model | not_run | 이번 구현·실행 범위 밖 |
| hard-kill 후 잔여물 판정·복구 CLI | not_run | 다음 묶음에 구현·검증 |

초기 통합 build는 workspace의 TypeScript null narrowing 오류로 실패했고, 명시적인 함수 타입으로 수정한 뒤 최종 build·typecheck를 통과했다. 독립 검토에서 발견한 잠금 정리 중 FD 누락 두 경로도 보완하고 회귀 검사에 포함했다. 최종 52개 신규 검사와 전체 회귀는 모두 실패 0개다.

기존 추적 파일 590개를 비교해 문서 4개 외 586개가 그대로임을 확인했다. 변경은 기존 문서 4개와 새 코드·테스트·결과 문서 11개, 총 15개 파일이다. 이 구현·검증 기록은 단계 4-C-31 변경을 커밋하기 전에 작성했으며 push는 수행하지 않았다. 검증 로그·기준 hash·보존 감사는 소유자 전용 `/private/tmp/harness-synthetic-change-apply-qvzb0cz7`에 보관한다. 실제 회사 자료·인증정보는 포함하지 않으며 자동 삭제하지 않는다.

## 다음 최소 작업

세 번째 묶음은 이번 엔진의 중단 상태 관찰·복구와 로컬 CLI 연결이다. source 등록·격리 worker·실제 회사 적용은 별도 검증 후 연결하며, 합성 통과를 회사 적용 완료로 표시하지 않는다.
