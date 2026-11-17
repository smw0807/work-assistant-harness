# 4-C-17 반복 경로 검사 대체 방식의 합성 검증

2026-11-17. 현재 Node 공개 API에서 디렉터리 FD를 기준으로 자식에 접근하는 방식은 지원되지 않으며, 열린 FD의 identity 확인만으로 기존 경로 검사를 대체할 수 없다는 반례를 확인했다. **이번 결과는 최적화의 적용 가능성 검증이며 자원 한도 오류를 해결한 구현이 아니다.** 생산 코드는 변경하지 않는다.

## 범위와 실행 환경

Git profile `8fc98736b72781db4567c808f6dca086b8b9ec1a4f97eb5e551d8ee0c3f210b6`과 metadata8192회·읽기 chunk64KiB·열린 FD32개 등 기존 한도·계수 의미를 유지한다. 회사 원본/질문/입력 재조회, 실제 인증정보·native Codex·실제 모델·외부 서비스 호출은 없다. 모든 파일 실험은 새 합성 fixture에서 수행한다.

실제 Node26.12.1/darwin의 공개 `node:fs` 및 `node:fs/promises` export에 `openat`, `openatSync`, `fstatat`, `fstatatSync`, `readlinkat`, `dirfd`, `fchdir`가 없음을 확인했다. 설치된 `@types/node`26.6.6의 `PathLike`는 string/Buffer/URL이고 `open/openSync`에는 부모 FD 인자가 없다. `Dir`은 목록 읽기/닫기, `FileHandle.stat`과 `fstatSync`는 이미 열린 객체의 상태 확인 기능이며 부모 FD에 상대적인 자식 접근을 제공하지 않는다.

이 관찰은 현재 공개 Node API에 한정하며 OS 자체의 기능 부재를 뜻하지 않는다. 내부 binding, FFI/addon, 외부 helper/child, `/dev/fd` 경로로 우회하지 않았다. 현재 worker의 addon·child·network 금지 조건도 유지한다.

## 반복 조회 비용

같은64KiB 합성 파일을 한 번 읽으면서 lstatSync/realpathSync/fstatSync 호출을 관찰했다. 예산에서 차감한 metadataCalls와 실제 관찰한 API 호출 합계가 일치했다. OS syscall 수를 측정한 것은 아니다.

| 부모 경로 성분 수 D (루트 포함) | 읽기 요청/바이트 | lstat | realpath | fstat | metadata 합계 |
| --- | --- | ---: | ---: | ---: | ---: |
| 8 | 1회 / 65536 | 18 | 16 | 2 | 36 |
| 11 | 1회 / 65536 | 24 | 22 | 2 | 48 |

현 read의 호출당 비용은 `4D + 4`이며 open·목록 조회·최종 guard 비용은 별도다. 실제 작업을 수행하고도 계수만 줄이거나 chunk/상한을 높이는 방법은 현재 계약에 맞지 않는다.

## 합성 반례와 후보별 결정

`tests/company-readonly-git-range-guard-equivalence.test.ts`에 네 가지 반례를 추가했다. 각 실험은 먼저 정상 관찰을 확인한 뒤 자기 fixture만 변경하며 기존 판독기의 `COMPANY_GIT_RANGE_SOURCE_CHANGED` 거부를 검사한다.

1. 상위 디렉터리를 이동하고 원래 경로에 같은 내용의 새 파일을 만든다. 기존 하위 디렉터리/file FD의 identity와 바이트는 그대로지만 원래 경로는 다른 객체다. 기존 read 및 별도 session의 final guard는 이를 거부한다.
2. 유효한 이름의 pack/index 쌍을 추가한다. 디렉터리 identity가 같아도 기존 최종 목록 검사는 이를 거부한다. fixture 본문을 유효 Git pack으로 주장하지 않는다.
3. 관찰 당시 없던 선택적 객체 파일을 생성한다. 부모 identity가 같아도 부재 조건이 깨지며 기존 final guard는 이를 거부한다.
4. 상위 경로를 기존 디렉터리로 향하는 symlink로 바꾼다. 열린 FD와 따라간 경로의 내용은 같아도 기존 부모 경로 검사는 이를 거부한다.

여기서 디렉터리 identity는 현재 계약의 device/inode/mode/uid/gid다. timestamp까지 동일하다고 주장하지 않는다. 이 반례는 FD identity만으로 guard를 대체하는 후보를 기각하며 모든 가능한 판독 방식의 불가능성을 증명하지는 않는다.

| 후보 | 검토 결과 |
| --- | --- |
| 디렉터리 FD에 상대적인 열기/조회 | 현재 공개 Node API로 지원되지 않음 |
| 부모 검사 결과 캐시·FD identity만 재검사 | 경로/링크/목록/부재 변경을 놓치는 반례가 있어 적용하지 않음 |
| 선택 경로 trie·tree/blob/base 재사용 | pass 내 중간 fresh read와 guard가 줄어듦. 기존 v1과 동등한 국소 최적화로 처리하지 않음 |
| header/trailer 묶기·0바이트 read 제거 | span·읽기 계수 또는 guard 시점이 바뀜 |
| Buffer 복사·문자열 계산 개선 | 실제 경로 조회 수가 그대로여서 이번 한도 문제의 해결책으로 확인되지 않음 |

현 proof는 중복 span/object 관찰을 Map으로 합친다. 기존 테스트도 중복 read3회를 실제로 계수하되 proof에는2개 span만 남는 경우를 검증한다. 최종 proofHash가 같다는 사실만으로 중간 관찰을 제거한 구현의 검증 강도가 같다고 말할 수 없다. trie 방식의 차이는 코드 검토이며 새 trie backend를 구현하거나 실험한 결과가 아니다.

## 검사 결과와 보관

| 검사 | 결과 |
| --- | --- |
| 공개 API 지원/합성 읽기 비용 probe | passed — 제한된 Node 프로세스, network/child/worker/addon 권한 없음 |
| pnpm lint / pnpm typecheck | passed |
| pnpm test:company (TypeScript 빌드 포함) | passed — 251개 통과, 실패·미실행0; 신규 반례4개 포함 |
| 전체 회귀 | not_run — 생산 코드·기존 테스트·설정·의존성은 그대로이고 이번 변경은 독립 합성 테스트와 문서 |
| 회사 준비·native·실제 모델·외부 연결 | not_run — 이번 범위에서 제외 |

현재 설치된 pnpm12.16.1과 Node26.12.1을 사용했으며 특정 버전 고정·자동 전환·다운로드는 하지 않았다. 비어 있는 인증 설정과 최소 환경으로 검증하고 native/model opt-in은 제공하지 않았다. 상세 probe·검사 로그와 파일 hash는 새 비공개 로컬 위치에 디렉터리0700/파일0600으로 보관하고 공유 문서에는 합성 집계만 남긴다. 새 테스트·이 결과·구현 계획만 변경하며 자동 커밋하지 않는다.

## 남은 작업

**현재 한도와 기존 관찰 시점을 모두 유지하면서 metadataCalls를 줄이는 국소 수정은 확인하지 못했다.** 지원되지 않는 backend를 연결하거나 검사를 완화해 준비 성공으로 표시하지 않는다.

다음 최소 설계는 기존 v1을 그대로 둔 상태에서 변경 가능한 관찰 범위를 명시하는 별도 판독 계약과, 더 강한 파일 접근 기능을 제공하는 별도 실행 기반을 비교하는 것이다. 전자는 검사 시점이 달라질 수 있고 후자는 worker 실행/권한 경계가 달라질 수 있다. 각 방식의 변경점·위협 모델·합성 수용 기준을 먼저 제시해야 하며 이번 검증만으로 어느 쪽도 승인되거나 구현된 것으로 취급하지 않는다. 실제 회사 레포의 준비 성공 시점은 아직 확정하지 못한다.
