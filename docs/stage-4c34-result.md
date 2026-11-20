# 단계 4-C-34 결과: 원본 회사 레포의 승인된 파일 적용 연결

작성일: 2026-11-20. 기준 commit: `b361383`. 앞선 등록 준비 점검에서 확인한 `packed-refs` 지원, 수정 대상의 기존 변경 보호, 회사 적용 CLI를 한 작업으로 구현했다. 이번 검증에는 합성 저장소만 사용했다. 실제 회사 저장소·자료·인증정보·native Codex·모델·Slack·원격 작업은 접근하거나 실행하지 않았다.

## 완료한 기능

- `company-apply-plan`, `company-apply-approve`, `company-apply-run`, `company-apply-inspect`, `company-apply-cancel`을 CLI에 연결했다. private 등록 JSON과 수정안을 받아 계획 생성 → 별도 승인 → 원본 새 브랜치의 선택 파일 적용 → 상태 확인으로 진행할 수 있다. 명령별 실제 옵션은 [README](../README.md#원본-회사-레포의-승인된-파일-적용)에 기록했다.
- 등록은 기존 `company-write-registration-v1`, 수정안은 `company-change-draft-v1`을 재사용한다. 회사 경로는 등록의 `sourceRoot`에 두므로 `.env`에 추가할 필요가 없다. 적용 계획/승인은 새 `company-apply-plan-v1`/`company-apply-approval-v1`, scope는 `company-local-write`이다. 이전 검토·합성 승인을 실제 적용에 사용할 수 없다.
- 기존 파일은 기준 commit blob·index stage 0·현재 bytes/mode 일치를 증명한 뒤 수정한다. 수정 대상에 사용자의 staged 또는 unstaged 변경이 있으면 거부한다. 새 파일은 기준 tree·모든 index stage·작업 경로에 없어야 하며 대소문자·상하위 경로 충돌을 거부한다. 미선택 작업 파일의 본문을 읽거나 덮어쓰지 않고 index bytes를 보존한다.
- 제한된 Git 판독기를 재사용해 loose/packed 객체와 loose/packed ref를 확인한다. `packed-refs` 내용·identity를 결합하고 새 브랜치의 대소문자·상하위 이름 충돌을 검사한다. packed-only 기준 ref도 지원하되 기존 ref를 정리하거나 loose ref로 가리지 않는다. 판독과 재검증 사이의 변화를 거부한다.
- `plan`은 `AWAITING_APPROVAL`에서 멈춘다. `approve`와 `run`은 동일한 등록·수정안·원본·계획 hash·소유자·유효기간을 다시 검증한다. `run`은 같은 허용 경로의 OS 격리 worker에서 합성 canary 읽기/쓰기·추가 exec·TCP 차단을 확인한 뒤 단건 claim을 소비한다. 적용 worker도 Git proof를 다시 확인한다.
- 원본에서 새 브랜치를 먼저 선택하고 승인된 파일을 순서대로 게시한다. branch/file INTENT·DONE과 최종 상태를 private journal에 fsync한다. controller가 control lease를 유지하는 동안 같은 runtime의 다른 명령은 거부하며 같은 task는 재실행할 수 없다. 중간 실패·강제 종료의 이미 게시한 변경, 소비 기록과 불확실 상태를 보존한다. 자동 rollback·resume·기존 잠금 삭제는 없다.
- 입력 파일은 0600, 직접 부모는 0700이어야 하며 경로·소유자·symlink/hardlink를 검사한다. runtime에는 전용 control DB, 본문 없는 계획·위치 binding·승인·claim·journal·worker marker를 보관한다. task 디렉터리를 다른 runtime에 복사해도 기존 계획을 사용할 수 없다. `inspect`와 적용 전 `cancel`은 회사 레포나 입력 본문 없이 수행한다.

## 계약·한도와 지원 범위

기존 승인 계약·Git 판독 profile/guard policy·SQLite schema·package/lockfile의 정의와 한도를 변경하지 않았다. 새 경로는 기존 등록 계약과 판독기를 조합하며 필요한 새 승인/저장 schema를 별도로 사용한다. 파일 8개·개별 64KiB·선택 합계 128KiB·draft JSON 256KiB·등록/계획 JSON 각각 16KiB·worker 입력 327,680byte·index 1MiB를 유지한다. 새 적용 경로의 `packed-refs` 상한은 1MiB이고 runtime은 task 디렉터리 256개까지 허용한다. 기존 판독기의 공유 자원 예산도 적용한다.

계획 유효기간은 24시간, 승인은 1~60분이다. 격리 확인과 적용에는 하나의 30초 기한을 공유하며 worker는 stdout/stderr 합계 16KiB, Node old-space 128MiB, TERM 뒤 250ms KILL 요청을 사용한다. old-space는 전체 RSS/CPU 상한이 아니며 OS 종료가 정확히 30.25초 안에 완료된다는 보증도 아니다. guardian은 부모 사망을 처리하고 종료를 확인하지만 guardian까지 동시에 강제 종료되는 모든 경우나 이미 발행한 syscall 취소를 보장하지 않는다.

일반 `.git` 디렉터리, 지원하는 SHA-1 Git 객체와 index v2/v3에 한정한다. worktree·submodule·merge/rebase 등의 진행 상태, 선택 파일의 실행 비트·symlink/hardlink와 미지원 index/객체 형식은 거부한다. 기준 ref와 선택 파일의 부모 디렉터리는 이미 존재해야 한다. 선택 Git 객체의 검증에는 부수 delta base 읽기가 필요할 수 있다. 전체 pack checksum·방문하지 않은 객체·저장소 전체의 clean 상태를 검증하지 않으며 일반 Git 전체 호환성을 주장하지 않는다.

실제 적용 실행은 현재 macOS `sandbox-exec`에서 지원한다. OS sandbox는 명시한 경로와 신뢰하는 하네스/OS runtime을 허용한다. 필요한 디렉터리의 fsync 허용은 이름 열거를 허용할 수 있다. 같은 OS 사용자의 악의적인 변조와 모든 순간 경합을 막는 서명/전역 승인 원장은 아니다. 파일별 게시는 원자적으로 수행하지만 전체 브랜치/파일 변경이 하나의 transaction은 아니다. `UNKNOWN`은 로컬 점검이 필요한 소비된 실행이며 그 표시만으로 모든 자식 프로세스의 종료를 증명하지 않는다. 부분/손상된 claim·journal과 달리 계획·승인·위치 binding 손상은 고정 오류로 거부한다.

## 검증 결과

현재 설치된 pnpm 12.16.1과 Node 26.12.1을 사용했고 설치·버전 고정·lockfile 변경을 하지 않았다. 검증에는 최소 환경과 빈 npm 인증/설정 파일을 사용하고 native opt-in을 제거했다.

| 검사 | 결과 | 확인 범위 |
| --- | --- | --- |
| lint·typecheck·build | passed | 최종 소스에서 실제 package scripts 실행 |
| 신규 검사 | passed | 정책 10·journal 7·Git 12·workspace 6·적용 7·격리 6·CLI 12, 총 60개 |
| 신규/기존 적용 집중 검사 | passed | 총 103개, 0 failed, 0 skipped |
| 전체 회귀 | passed | 총 2,245개 중 2,209 passed, 0 failed, native opt-in 36 skipped |
| CLI 전체 흐름 smoke | passed | 합성 packed ref 저장소에서 plan/approve/run/inspect, 재실행 거부, 승인 소비, 새 브랜치, 선택 replace/create 결과 확인 |
| 기존 작업 보존 | passed | 합성 index·기준 ref·packed-refs·미선택 사용자 변경 보존, 선택 대상의 staged/unstaged 변경과 새 파일 충돌 거부 |
| 격리·중단·저장 | passed | 실제 macOS SBPL, 추가 exec/네트워크 거부, 출력/시간/취소/부모 사망, 부분 변경과 journal 보존, runtime 동시 진입·복사 task 거부 |
| 실제 회사 적용·인증·native·모델·제품 검사·외부 전송 | not_run | 이번 구현/합성 검증의 범위에서 제외 |

첫 집중 검사에서는 외부 도구 sandbox의 localhost/sandbox-exec 제한으로 실패했고 허용된 실제 macOS 검증에서 재실행했다. 부모 사망 테스트의 준비 marker를 생성 직후 읽을 수 있는 경합도 발견했다. 기존/신규 격리 테스트 모두 완성된 준비 JSON 또는 기대 파일 내용이 확인된 후 중단하도록 수정했다. 초기 실패 로그도 보존했다.

전체 회귀 이후 독립 검토에서 `packed-refs` parser의 불필요한 backing buffer 복사를 제거했다. 동일 입력의 view를 사용해 기존 판독 예산 밖의 추가 복사를 만들지 않으며 계약/한도는 바뀌지 않았다. 이 최종 소스에서 lint·typecheck·build, 103개 집중 검사와 CLI smoke를 다시 통과했다.

## 보관과 실제 사용

허용된 `/private/tmp` 아래 새 0700 디렉터리에 기준 manifest·검사 로그·결과 JSON·합성 smoke·완료 audit를 보관했다. 보고/설정/로그는 0600으로 저장했다. 테스트 자식은 합성 파일 모드 검증을 위해 별도 umask 022를 사용하므로 모든 fixture 파일이 0600이라는 뜻은 아니다. 정확한 경로와 파일 hash는 private audit에 두고 공유 문서에는 회사 경로·브랜치·commit/index hash·본문을 기록하지 않는다. 별도 보관 기간이 없으므로 자동 삭제하지 않았다.

이번 구현으로 소규모 실제 업무의 수정안을 검토하고 승인받아 원본의 새 브랜치에 적용하는 CLI 연결은 완료했다. 실제 업무의 대상 파일과 수정안이 이번 요청에 주어지지 않았으므로 회사용 실행 등록·계획·승인·적용을 임의로 만들지 않았다. 다음 입력은 실제 수정할 업무 한 건이며, 그 범위의 현재 Git 상태·등록·수정안을 결합해 계획을 만들 수 있다. `APPLIED`는 파일 적용 완료이고 제품 검사 결과는 계속 `not_run`이다.

기존 미커밋 등록 준비 결과를 보존했으며 검증 완료 시점에는 이번 변경도 미커밋 상태였다. 회사 레포의 코드 수정·제품 명령·commit/push는 수행하지 않았다.
