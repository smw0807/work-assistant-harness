# 단계 4-C-33 결과: 회사 쓰기 등록 계약과 OS 격리 적용의 합성 검증

작성일: 2026-11-20. 기준 commit: `12e8b2e`. 사용자가 승인한 다음 작업 1·2번, 즉 회사 쓰기 등록 계약과 격리된 적용 경로를 구현하고 합성 데이터로 검증했다. 실제 회사 저장소·회사 자료·인증정보·native Codex·모델·Slack·외부 전송·Git 원격 작업은 수행하지 않았다.

## 구현 결과

- `company-write-registration-v1`: private JSON에 `sourceRoot`, repo ID, 기준 브랜치·commit·index hash, 정확한 쓰기 허용 파일과 허용 선언을 둔다. `.env` 등록은 필요하지 않으며 환경에서 회사 경로를 자동 탐색하지 않는다. tracked 예시는 비활성·미확인과 가짜 경로만 포함한다. 순수 등록 검사는 filesystem canonical/identity 관찰을 대신하지 않는다.
- `company-write-plan-v1`과 `company-write-approval-v1`: 등록·draft·원본 identity/hash·새 브랜치·소유자·TTL·한도를 결합한다. 계획 24시간, 승인 1~60분, 이번 scope는 `synthetic-validation`이다. 기존 검토 승인과 `synthetic-apply` 승인은 혼용할 수 없다.
- 원본 adapter: HEAD·index·기준 loose ref와 선택 파일만 제한적으로 읽는다. 원본 레포에서 새 브랜치로 전환한 다음 파일을 순서대로 replace/create하며 index·기준 ref·미선택 본문을 수정하지 않는다. 각 파일은 같은 부모의 단건 temp를 fsync한 뒤 rename 또는 no-overwrite link로 게시한다. 전체 파일·Git 변경이 하나의 원자적 transaction이라는 뜻은 아니다.
- 별도 worker/guardian: 최소 환경·고정 Node 옵션, macOS SBPL exact path 허용을 사용한다. 선택 경로·temp·Git guard lock·명시한 private 실행 journal/시작 marker 외 쓰기, 미선택 파일 본문 읽기, TCP/Unix, 추가 프로그램과 Node 재실행을 차단한다. 필요한 디렉터리 fsync 권한은 이름 열거를 허용할 수 있다. 신뢰하는 하네스 코드와 OS runtime 읽기 범위는 별도로 허용한다.
- 단건·중단: 부모가 exclusive claim을 먼저 fsync하고 worker도 exclusive 시작 marker를 남긴다. 본문 없는 JSONL journal에 branch/file INTENT·DONE과 최종 결과를 순서·hash chain으로 기록한다. 부분 실패와 SIGKILL 뒤 소비·변경·불확실 INTENT·남은 lock을 보존하며 재실행·rollback·이전 lock 제거를 하지 않는다. 정상 종료에서 자신이 만든 inode로 확인된 lock/temp만 정리한다.
- `pnpm harness company-write-check --data-dir <새 private 임시 경로>`: 새 합성 fixture를 만들고 합성 변경만 승인·소비·격리 적용한다. 회사 경로·외부 draft·승인을 받는 옵션은 없다. 별도 회사 적용 CLI와 제품 검사·모델 연동을 개방하지 않았다.

## 한도와 지원 범위

기존 파일/정책 hash·승인·SQLite schema·package/lockfile을 변경하지 않았다. 새 계약도 파일 8개·파일별 65,536byte·선택 총합 131,072byte·draft JSON 262,144byte를 유지한다. 순차 적용 도중의 선택 파일 총합도 같은 상한으로 사전 검사한다. 새 등록/계획 JSON은 각각 16,384byte, index 1MiB, Git text 1KiB, worker 입력 327,680byte로 제한한다.

worker는 30초, TERM 뒤 250ms KILL 요청, stdout+stderr 합계 16,384byte와 Node old-space 128MiB를 사용한다. 이는 전체 RSS/CPU의 강제 상한이나 정확히 30.25초 안의 OS 종료 보증이 아니다. 부모 사망을 살아 있는 guardian이 처리하는 경로를 실제 검증했다. worker의 EOF·자체 watchdog과 mutation 사이 이벤트루프 양보도 보강했지만 이미 발행된 syscall 취소나 guardian까지 동시에 강제 종료되는 모든 시나리오를 보장하지 않는다.

`packed-refs`가 존재하는 저장소, worktree, submodule, merge/rebase 등의 진행 상태를 거부한다. 선택 파일은 현재 bytes와 identity에 결합하며 tracked/staged 상태나 기준 commit blob과의 일치를 증명하지 않는다. 같은 OS 사용자의 모든 순간 경합·비협조적인 변경을 막는다고 주장하지 않는다. claim과 hash는 private 위치의 일관성/재사용 검사이며 서명 또는 전역 승인 원장이 아니다.

## 검증

현재 설치된 pnpm 12.16.1과 Node 26.12.1을 사용했다. 설치·버전 변경은 하지 않았다. 검증 자식에는 실제 인증 환경·사용자 npm 설정·native opt-in을 전달하지 않았다.

| 검사 | 결과 | 범위 |
| --- | --- | --- |
| lint | passed | 첫 검사에서 새 테스트의 타입 전용 미사용 변수 2개를 제거한 뒤 통과 |
| typecheck·build | passed | 실제 package scripts 사용 |
| 신규 검사 | passed | 정책 14, workspace 14, 원장/적용/중단 7, OS 격리/guardian 6, CLI 2: 총 43개 |
| 전체 회귀 | passed | 2,185개 중 2,149 passed, 0 failed, native opt-in 36 skipped |
| 실제 SBPL 거부 검사 | passed | 합성 credential·미선택 본문/쓰기·TCP·Unix·추가 exec·Node 재실행 |
| 실제 종료 예산 | passed | 출력 초과·취소·부모 SIGKILL·고정 30초, TERM 저항 worker에 KILL·close·부분 파일 보존 |
| 파일 경계 SIGKILL | passed | 실제 합성 파일 1개 게시 직후 DONE 전 중단; INTENT·원본 변경·소비·잠금 보존, 재실행 거부. 이 검사는 application 경계 검사이며 별도 guardian/OS 검사와 구분 |
| 실제 CLI smoke | passed | 합성 3개 파일·branch-first·index/base/unselected 보존·journal 9개·종료 0·private 결과 저장 |
| 실제 회사·인증·native·모델·제품 검사 | not_run | 이번 범위에서 제외 |

첫 집중 검사는 외부 도구 sandbox의 localhost/sandbox-exec 제한과 새 원장의 디렉터리 nlink 비교 문제로 실패했다. 디렉터리에 파일을 만들 때 달라질 수 있는 nlink를 inode/소유자/모드 비교에서 분리하고 파일 hardlink 검사는 유지했다. 명시적으로 허용된 실제 macOS 검증에서 재실행해 통과했다. 최초 실패 로그도 보존했다.

## 보관과 다음 최소 작업

허용된 `/private/tmp` 아래 새 private 검증 디렉터리에 기준 manifest·검사 로그·실행 결과·합성 smoke 자료를 보관했다. 정확한 로컬 경로와 파일 hash는 private completion audit에 두고, 이 문서에는 회사 자료나 실제 경로를 넣지 않는다. 디렉터리는 0700, 보고/설정/원장/로그는 0600이다. 별도 보관 기간 지정이 없으므로 자동 삭제하지 않았다.

다음 회사 적용 단계에서는 승인된 범위에서 실제 Git 상태와 등록 항목의 적합성을 확인하고, 미지원 상태가 있으면 먼저 지원 범위 또는 작업 범위를 정해야 한다. 그 뒤 실제 회사용 계약/CLI를 별도로 활성화하고 정확한 소규모 변경 계획·새 승인으로 한 번 적용·로컬 검토한다. 이번 합성 통과를 회사 적용 완료나 일반 Git 호환성 검증으로 승격하지 않는다. 제품 테스트 실행과 외부 공유·commit/push도 각각 허용 범위에 따라 별도로 처리한다.

이 단계의 변경은 검증 완료 시점에 미커밋 상태다.
