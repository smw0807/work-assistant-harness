# 단계 4-C-32: 합성 적용 CLI와 중단 복구

## 구현 범위

단계 4-C-31의 합성 적용 엔진을 `6bf4b65`로 로컬 커밋한 뒤, 세 번째 묶음인 프로세스 간 합성 등록·CLI·중단 관찰과 복구를 연결했다. `synthetic-change-init/plan/approve/apply/inspect/cancel/recover` 일곱 명령을 제공한다. 실제 명령·인자는 [합성 작업 가이드](../guides/synthetic-workflows.md#합성-레포의-다중-파일-적용-엔진)를 따른다.

실제 회사 경로 등록·회사 자료·인증정보·native Codex·실제 모델·제품 검사·외부 전송·Git 원격 작업은 연결하지 않았다. 기존 회사 읽기/relay·검토 전용 승인·합성 실행 계약과 숫자 상한·정책 hash를 유지한다. 4-C-31의 기존 SQLite schema를 그대로 사용하며 복구용 메서드만 별도 port subtype으로 추가했다.

## 합성 등록과 CLI

`init`은 canonical 임시 경로의 private 부모 아래 새 runtime만 만든다. 기존 runtime 덮어쓰기와 회사 경로·harness 경로 중첩을 거부한다. 이 runtime에는 `store/`, `control/`, `reports/`, 합성 factory 디렉터리, `synthetic-workspace.json`, 고정 합성 `example-draft.json`을 둔다. 디렉터리는 0700, metadata·예제·보고서는 0600이다.

등록 receipt는 본문 없이 고정 fixture commit·초기 tree 경로/metadata/hash, OS 소유자·runtime 위치·factory 디렉터리 identity를 결합하며 최대 128KiB다. 다음 프로세스는 검증된 receipt에서만 runtime 바로 아래의 합성 레포 경로를 파생한다. 사용자가 임의의 회사 레포 root를 등록하는 경로는 없다. 같은 OS 사용자가 만든 hash는 전자서명이나 독립된 인증 수단이 아니다.

정상 계획·승인·적용에는 원본 Git baseline과 실제 source 관찰 hash의 최신성 검사를 유지한다. 재개방 자체는 부분 적용된 트리를 허용하되 그 상태로 정상 적용을 이어가지 않는다. 복구 관찰에서만 현재 HEAD·ref·파일을 판정한다. 기존 레포 사본이나 worktree는 만들지 않고 합성 원본에서 새 브랜치를 사용한다.

CLI의 승인·적용은 명시적인 draft 파일을 다시 읽고 계획 hash와 본문을 대조한다. `recover`는 draft를 받거나 읽지 않는다. 표준 출력은 상태·ID·hash·개수·기한·고정 오류와 경계만 제공하고 본문을 출력하지 않는다. `inspect/recover`는 `reports/<task>.json`에 최신 snapshot과 선택적 복구 관찰, 생성 시각을 보관한다. 이 보고서는 최신 조회 자료이며 불변 journal은 SQLite에 있다. 적용 자체가 `FAILED`면 CLI도 실패 종료 코드를 반환한다.

보고서는 최대 64KiB, reports 디렉터리는 임시 파일을 포함해 최대 256 entries다. 게시용 임시 파일 자리까지 확보하고 자신의 임시 파일 identity를 확인한 뒤 atomic rename한다. hard-kill로 남은 관리 형식의 임시 파일은 metadata를 확인하고 보존한다. 사용자 입력 원본·예제·등록·감사 기록과 잔여물은 자동 정리하지 않는다.

## 동시 실행과 복구

모든 CLI 명령은 별도 `synthetic-company-change-control.sqlite`의 `BEGIN EXCLUSIVE` lease를 전체 명령 동안 유지한다. 별도 namespace·위치/owner binding·정확한 schema·private 파일/조상 검증, 100ms busy timeout을 사용한다. 살아 있는 controller가 lease를 보유하면 다른 적용·복구는 거부된다. PID 조회로 죽었다고 추정하거나 기존 lock 파일을 훔치지 않으며 프로세스 사망 시 SQLite 잠금은 해제된다.

복구 서비스는 정확한 task/계획 hash와 소비된 승인을 가진 `APPLYING`만 받아 현재 상태를 읽는다. 파일별 `before/after/absent/other/unsafe`, 기준·대상·다른 브랜치, index·기준 ref 보존 여부, 잔여 lock/temp 개수를 기록한다. `complete:true`는 안전한 bounded 관찰을 완료했다는 뜻이다. unsafe 경로·변조·한도·관찰 중 경합은 `complete:false`, 미확인 상태와 null 계수로 남긴다. 원문을 보고서에 넣지 않는다.

그 뒤 기존 소비 승인과 journal을 그대로 둔 채 `FAILED / SYNTHETIC_COMPANY_CHANGE_INTERRUPTED`를 저장한다. 파일이 모두 after 상태여도 복구가 `APPLIED`를 만들어내지 않는다. 같은 복구를 다시 요청하면 현재 상태를 새로 관찰할 수 있으나 기록한 중단 시각·소비·journal은 바뀌지 않는다. 이미 완료가 commit된 `APPLIED`는 `inspect`로 확인하며 복구·재적용하지 않는다.

실행 중의 workspace/Git 잠금, 임시 파일, 부분 적용한 파일·브랜치는 삭제·수정·rollback하지 않는다. 같은 승인을 재사용하거나 중단된 적용을 재개하지 않는다. 복구 보고서 게시에 실패하거나 응답을 잃으면 결과는 unknown이며 같은 task를 먼저 조회한다. 전체 DB·Git·파일 변경의 원자적 transaction이나 전원 장애 시 물리적 완전 복구를 주장하지 않는다.

## 실행 경계와 한계

새 CLI worker는 최소 환경의 신뢰하는 controller이며 Nest application context로 서비스를 호출한다. `--no-addons`, `--disable-proto=throw`, V8 old-space 128MiB, 부모의 30초 종료 요청·250ms 뒤 강제 종료 요청, 출력 합계 16KiB·close 확인을 적용한다. 임의 명령·제품 코드 실행·인증·모델·네트워크 호출을 수행하는 경로는 없다.

기존 적용 엔진의 fsync와 전체 조상 검사를 수행하므로 이 worker는 Node permission mode를 사용하지 않는다. 기존 제한 worker를 완화한 것이 아니며 새 controller를 OS 파일/네트워크 격리로 표현하지 않는다. V8 old-space는 hard RSS 제한이 아니고 부모가 죽으면 독립 guardian도 없다. 부모 종료 시 살아 있는 worker가 있다면 그 worker의 제어 lease가 다른 CLI 진입을 막는다. 같은 OS 사용자의 일시적 경로 경합은 완전히 차단하지 못한다.

이 runtime은 초기 고정 합성 baseline의 적용 검증 단위다. 실제 업무 레포를 등록해 연속 작업하는 실행기는 아직 제공하지 않는다. 다음 합성 실험은 새 runtime에서 시작한다.

## 검증 기록

현재 설치된 pnpm 12.16.1과 Node 26.12.1을 사용했다. 새 pin·설치·lockfile 변경 없이 빈 전용 npm 설정·최소 환경에서 native opt-in 변수를 제거했다. 전체 회귀의 로컬 모의 서버·Node 자식 프로세스·합성 강제 종료에 필요한 sandbox 예외만 승인받아 실행했다.

| 검사 | 결과 | 근거 |
| --- | --- | --- |
| 신규 저장소 복구 | passed | 5개: active claim 거부·소비/journal 보존·상태/owner/hash·저장 실패 |
| 신규 제어 lease | passed | 7개: live controller 차단·SIGKILL 후 해제·schema/경로 변조·GC 뒤 수명 보유 |
| 신규 등록·복구 workspace | passed | 11개: 재개방·고정 fixture/receipt·link canary·부분/unsafe 관찰·무변경 |
| 신규 중단 복구 통합 | passed | 7개: SIGKILL 시점별 보존·완료 응답 유실·관찰 변조·실제 CLI 복구와 재적용 거부 |
| 신규 CLI | passed | 11개: 별도 프로세스 workflow·경로/입력/환경/한도·취소·복구·본문 없는 출력 |
| 합성 적용 집중 검사 | passed | 기존 52개 + 신규 41개, 총 93개 통과·실패 0개 |
| lint·typecheck·build | passed | 실제 `package.json`의 기존 스크립트 |
| 전체 회귀 | passed | 총 2,142개 중 2,106개 통과·실패 0개·native opt-in 36개 미실행 |
| 실제 회사 적용·제품 검사·native/model·OS 격리 적용 | not_run | 이번 구현·실행 범위 밖 |

초기 집중 검사는 81개 중 80개 통과·1개 실패였다. 테스트용 자식이 반환된 lease 해제 함수를 더 이상 참조하지 않아, 살아 있는 프로세스에서도 GC가 SQLite 연결을 닫을 수 있었다. 별도 합성 진단에서 참조 유무에 따라 잠금 해제와 `CONTROL_BUSY`를 재현했고, 종료 handler에서 참조를 유지한 뒤 두 차례 이벤트 루프·강제 GC 후에도 잠금이 유지되는 회귀검사로 수정했다. 실제 CLI worker는 이미 `finally`에서 해제 함수를 보유하고 있었다. 이후 최종 집중·전체 검사는 실패 0개다.

기존 추적 파일 601개 중 의도한 9개 외 592개가 그대로임을 확인했다. 패키지/lockfile, 기존 실행·검토 계약/한도·정책 파일과 제한 worker는 바뀌지 않았다. 이번 변경은 기존 문서·adapter·route·port·테스트 9개와 새 제어 lease·복구 서비스·CLI·관찰 타입·검사·결과 문서 12개, 총 21개 파일이다. 이 구현·검증 기록은 단계 4-C-32 변경을 커밋하기 전에 작성했으며 push는 수행하지 않았다.

검증 로그·commit 기준 hash·보존 감사는 소유자 전용 `/private/tmp/harness-synthetic-change-cli-w7v3q98f`에 보관한다. 실제 회사 자료나 인증정보는 포함하지 않으며 자동 삭제하지 않는다. 공유 가능한 이 문서에는 집계·구현 경계만 기록한다.

## 다음 최소 작업

합성 실행기 세 묶음의 다음은 실제 회사 적용을 위한 등록·쓰기 범위·OS 격리 환경을 구체화하고, 해당 범위를 합성 canary로 먼저 검증하는 작업이다. 제품 검사 profile과 실제 회사 적용 검증은 별도이며 이 CLI 통과로 회사 적용이나 자동 업무 처리 완료를 선언하지 않는다.
