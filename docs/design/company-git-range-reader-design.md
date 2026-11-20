# 회사 원본 저장소의 Git 선택 읽기 설계

2026-11-17. **1차 codec와 2차 합성 파일 판독기의 기록을 보존하며, 3차는 별도 회사 준비 v2에 정책 gate·안전 발췌·보관·CLI·부모 supervisor를 통합한다. 구현과 검증에는 합성 자료만 사용하고 실제 회사 원본 적용은 미실행이다.** 회사 레포를 복사하지 않고 지정한 원본 경로에서 읽기 전용 조사를 준비하는 방향이다. [4-C-16 사본 실험](../history/stage-4c16-result.md)은 보존하지만 사본 생성기는 더 개발하지 않는다. 조사에는 작업 브랜치가 필요하지 않다. 대상 코드 변경을 위한 브랜치·수정·검사 실행은 이후 별도 범위다.

현재 순수 parser와 files/source 모듈이 실제 positioned I/O·경로/FD 검사·공유 예산을 연결한다. 기존 metadata 전용 source API는 유지하며 새 v2 source는 고정 안전 수집기를 내부에서 호출해 발췌와 proof만 반환한다. 회사 자료 접근, 실제 인증·native·모델 호출은 없다. 아래 수치는 1차의 **고정 profile을 그대로 적용**하며 해당 회사 레포의 호환성이나 OS 자원 격리를 보증하지 않는다. [codec 결과](../history/stage-4c17-codec-result.md)와 [2차 reader 결과](../history/stage-4c17-reader-result.md)는 당시 기록이며 현재 통합 검사와 미검증 범위는 [3차 결과](../history/stage-4c17-integration-result.md)를 따른다.

## 1. 바꿔야 하는 이유와 계약

현재 `personal-readonly-repository.ts`는 Git 파일 전체를 읽어 파일당 8MiB·관찰별 누적 64MiB를 적용한다. pack/index의 객체 수는 4,096개 이하이고 pack 전체 checksum·전체 객체의 압축/델타 구조를 검증한다. 회사 v1은 이 판독기를 재사용한다. 설치된 `isomorphic-git`의 Node 구현도 pack 전체를 읽으므로 FS 어댑터의 옵션만 바꾸는 방식으로 부분 읽기를 구현할 수 없다.

새 방식은 `.idx`를 제한된 크기로 모두 검사한 뒤, 필요한 객체의 pack 구간만 위치를 지정해 읽는 **회사 전용 판독기**다. 기존 개인/회사 v1의 코드·입력·출력·hash·한도는 그대로 둔다. 다음 차이는 새 계약에 드러내야 한다.

| 구분 | 기존 v1 | 새 설계 |
| --- | --- | --- |
| pack 크기 | 전체 파일 8MiB 이하 | 물리적 파일 크기와 실제 읽을 구간/총량을 별도로 제한 |
| pack 객체 수 | 전체 검사 대상 4,096개 이하 | 큰 index의 metadata를 검사하고 필요한 객체·의존 그래프만 복원 |
| 내용 무결성 | 읽은 pack 전체 checksum과 모든 객체 구조 검사 | 전체 index checksum, 선택 구간 CRC·SHA-256, 선택 객체·의존 객체의 복원 OID 검사 |
| 미조회 영역 | 읽은 pack 전체를 검사 | pack 전체 checksum·미조회 객체는 `not_checked` |
| 원본 감시 | 전체 Git 파일 hash와 선택 작업 파일 | 작은 Git 파일 전체를 덮는 읽기 구간 hash, pack metadata·선택 구간 proof와 작업 파일 hash |
| 읽기 예산 | 내부 observation마다 새 계수 | 준비 요청 전체에서 공유하는 계수, 재검증도 포함 |

이것은 기존 검증과 동등한 최적화가 아니다. CRC는 손상 탐지용이고 pack trailer와 index에 적힌 checksum 값의 일치는 전체 pack checksum 계산을 대신하지 않는다. 현재 source는 commit→tree→선택 blob과 작업 파일/index의 일치를 검사하지만 전체 pack·저장소의 무결성, 작성자/서명/원격 출처의 진위는 보증하지 않는다. 순수 객체 codec 단독의 type/OID 검사와 source의 본문·경로 연결 검사는 구분한다.

## 2. 접근 범위와 지원 형식

순수 codec/parser는 전달받은 바이트만 처리하고, 별도 FS/source 모듈이 제한된 경로를 읽는다. 내부 `company-git-range-source-v1`은 version·고정 profile hash·원본 경로·기준 commit·선택 경로를 받으며 회사 승인이나 등록 형식을 대신하지 않는다. 3차 준비 경로는 별도 `company-readonly-registration-v2`와 정책 선언을 받아 이 판독기에 연결한다.

- 내부 API는 입력 형식·고정 profile·선택 경로 제한을 대상 metadata 접근 전에 확인한다. 회사 준비 v2는 정책의 읽기·보관 선언을 등록 파일보다 먼저 확인한 뒤 선택 줄 범위·등록/profile과 경로 분리를 검증한다. 이 선언은 회사 승인의 인증이 아니다. 기존에 확인한 정책은 재확인하지 않고 추가되거나 미확인인 범위만 확인한다.
- 읽을 수 있는 내용은 HEAD/해당 ref/필요한 packed-refs, Git index, 제한된 pack index들, 선택 commit·경로의 tree·선택 blob과 **그 복원에 필요한 delta base**다. base는 선택하지 않은 파일이나 과거 내용일 수 있다. 이 부수 접근을 선택 소스 파일 8개 제한과 같은 의미로 설명하지 않는다.
- SHA-1 OID, 일반 `.git` 디렉터리, index v2, pack v2/v3와 일반 loose 객체를 첫 지원 대상으로 한다. 작업 파일용 Git index는 기존 v2/v3·선택 항목 검증을 유지한다. OFS_DELTA와 같은 pack 안의 REF_DELTA만 허용한다.
- offset은 32-bit 표만 지원한다. 후보 pack 최대 512MiB에는 충분하다. 64-bit offset 표, 외부 base/thin pack, alternate object store, 별도 worktree의 `.git` 파일, Git config/hooks·원격·자동 fetch·사용자 filter는 지원하지 않는다. 미지원 형식은 명시적 실패로 끝낸다.
- 원본을 쓰거나 복사/repack하지 않는다. Git CLI·대상 코드 import·설치·테스트·빌드·쉘 실행과 네트워크를 제공하지 않는다. 경로·소유자·단일 링크·부모 identity·비밀 파일 제한은 계속 적용한다.
- tree와 commit은 검증 중 원문 metadata를 메모리에서 읽으며 delta base에도 민감 내용이 있을 수 있다. raw 객체·pack 구간·전체 index를 보고서/DB/임시 파일에 보관하지 않는다. metadata 전용 source API는 그대로 유지한다. v2의 고정 수집 경로는 선택 원문을 내부 메모리에서만 안전 view로 변환하고 등록한 발췌와 proof를 반환하며, 임의 callback이나 raw Buffer 반환은 제공하지 않는다.

인증 환경·키체인·명시적인 인증 파일을 열거나 로그인/refresh하는 기능은 없다. 다만 Git 객체에 내장된 민감값을 메모리에서도 전혀 읽지 않는다는 보증은 할 수 없다. 실제 적용 전 이 의존 객체 접근 범위를 기존 회사 자료 허용/인증정보 제외 범위와 대조해야 하며, 이번 합성 구현만으로 새로운 부수 접근을 허용한 것으로 해석하지 않는다.

## 3. 고정 자원 profile과 후속 실환경 검증

MiB/KiB는 각각 1,048,576/1,024바이트다. 아래 값은 깊게 불변인 `company-git-range-reader-v1` profile과 hash다. 판독기는 실제 파일 크기와 I/O 요청·할당을 이 예산에 등록하고 크기 검사와 예약 뒤 읽는다. 3차는 별도 부모 supervisor와 worker old-space 설정을 연결하며, 관리 Buffer 계수나 RSS 측정 목표를 OS 메모리 강제 상한으로 바꾸지 않는다. 한 항목의 최대값을 허용한다고 다른 항목까지 동시에 최대값으로 처리할 수 있다는 뜻은 아니다.

| 항목 | 1차 profile 상한 | 계수/의미 |
| --- | ---: | --- |
| pack 물리적 파일 크기 | 512MiB | `stat` 크기 기준. 전체를 읽도록 허용하는 값이 아님 |
| pack 디렉터리 항목 | 64개 | 제한된 열거. 후보 `.idx/.pack` 쌍은 최대 8개 |
| pack index 파일 | 파일당 8MiB | 1회 pass에서 후보 index 바이트 합계도 8MiB 이하 |
| pack/index 선언 객체 수 | pack당 131,072개 | 후보 index 전체 항목 합계 262,144개 이하 |
| 기타 Git 파일 | 파일당 8MiB | HEAD/ref/packed-refs/작업 index/loose 객체 등 |
| 작업 파일용 Git index | 65,536항목 | 기존 상한. 파일 바이트 제한도 별도 적용 |
| 위치 지정 읽기 chunk | 64KiB | chunk로 나눠도 아래 요청 전체 예산은 초기화하지 않음 |
| pack 객체의 encoded 구간 | 2MiB | 객체 header·delta 참조·zlib stream을 합한 길이 |
| 해제된 객체·delta 명령·복원 결과 | 각각 1MiB | 할당·해제 전에 크기를 검사, 실제 결과도 재검사 |
| 의존 경로 | 32개 노드 | 최종 객체 포함, 최대 31개 delta edge. cycle 거부 |
| 방문한 고유 객체 | 256개 | commit/tree/blob/base 전부 포함. 다른 offset도 별도 계수 |
| 전체 해제 횟수 / 출력 합계 | 512회 / 16MiB | 두 pass의 반복 해제와 delta 재구성 출력도 포함 |
| 한 content pass의 예약 읽기량 | 32MiB | Git metadata·index·pack 구간·선택 작업 파일 포함 |
| 준비 요청 전체 예약 읽기량 | 64MiB | 최초 조회와 최종 재검증, probe·짧은 읽기·반복 읽기 포함 |
| 판독기의 읽기 API 요청 | 4,096회 | `fs.read` 등에 대한 판독기 호출 수. OS syscall 수가 아님 |
| metadata API 요청 | 8,192회 | `lstat/fstat/open/realpath/readdir` 등 명시 목록의 호출 수. `close`는 예산 소진 후에도 수행 |
| 열린 파일 descriptor | 동시에 32개 | 종료 시 닫기를 시도. close 결과가 불확정이면 계수를 유지하고 실패 처리 |
| 판독기 관리 메모리 | 살아 있는 buffer/typed array 32MiB | 압축/해제 버퍼·index·정렬용 배열·객체 cache 포함 |
| 복원 객체 cache | 8MiB | 관리 메모리 안의 상한. 현재 source는 cache를 사용하지 않음 |
| worker V8 old-space | 128MiB | v2 worker의 고정 실행 옵션. 전체 heap/RSS 상한이 아님 |
| worker RSS | 256MiB 이하를 합성 측정 목표로 사용 | peak RSS 관찰값을 결과에 기록. OS 강제 격리/상한이 아님 |
| 준비 wall-clock | 30초 | 단조 시각의 작업 경계 검사와 별도 부모 supervisor 기한. 부모 생존·OS 신호 처리 조건 |
| 종료 유예 | 250ms | 기한에 SIGTERM, 유예 뒤 SIGKILL 요청. child close 관찰로만 종료 확인 |

읽기 요청 전에 요청 길이 전부를 예산에서 차감한다. 짧게 읽거나 실패해도 차감액을 환급하지 않고 실제 반환 바이트도 별도 집계한다. 첫 pass는 32MiB 안에서 끝나야 하며 final pass에 새 64MiB를 주지 않는다. 메모리·출력·횟수도 부수 작업과 재검증에서 공유한다. 관리 메모리 계수는 참조된 backing buffer를 중복 계산하지 않되 cache/view가 참조하면 해제됐다고 계산하지 않는다. GC·zlib 내부 메모리·Node 런타임까지 이 계수로 강제했다고 주장하지 않는다.

`CompanyGitRangeBudget` 자체는 호출자가 제공한 단조 시각과 등록한 작업만 검증한다. source는 기본 `performance.now()`를 I/O·codec 등 작업 경계에서 샘플링하며 이 검사만으로 동기 작업을 선점하지 않는다. 3차의 별도 부모 supervisor가 worker 종료 신호를 요청한다. 부모 자체가 강제 종료되면 독립 guardian이 없으므로 30초 강제 종료나 고아 프로세스 방지를 보증하지 않는다. backing buffer의 `memoryLease`를 유지하고 codec 및 고정 안전 수집기의 복사·반환 Buffer 공간을 예약/해제하지만, 반환된 발췌 문자열·metadata 객체·미등록 JavaScript 작업·GC·zlib 내부 메모리·OS RSS까지 통제하는 기능은 아니다. 발췌와 metadata에는 기존 개수/바이트 제한을 적용한다. cache는 없고 공유 예산은 반복 읽기와 반복 해제를 모두 계수한다.

index당 131,072개는 32-bit offset 형식에서 `1,072 + 28 × 131,072 = 3,671,088`바이트다. 구조 검증과 파일당/전체 바이트 상한을 모두 검사한다. index 합계 8MiB와 작업 index 8MiB를 두 번 읽으면 32MiB가 들고, 나머지 파일·구간 읽기도 같은 64MiB 예산을 사용한다. delta chain이 32노드 미만이어도 누적 해제 16MiB를 넘으면 거부한다.

소스 64KiB·전체 안전 view 64KiB·발췌 32KiB·근거 64KiB·입력 128KiB, 선택 파일 8개·범위 16개·범위당 200줄·마스킹 128개는 기존 수집 v2 값과 hash를 유지한다. relay/모델 예산과 실행 권한은 변경하지 않는다. 위 Git profile은 임의 CLI/env/등록 값으로 높일 수 없고 고정 상수와 profile hash로 결합한다. 성능 목표 미달을 자동 상향·재시도로 해결하지 않는다.

## 4. 최초 읽기와 최종 재검증

기존 회사 v1의 `inspect/collect/assertUnchanged`를 겹쳐 호출하면 내부 guard마다 재읽기와 계수가 중복된다. 새 source는 `inspect → verify` 순서의 **두 content pass**를 같은 예산으로 수행하고 관찰 proof hash를 비교하며 v1 source guard를 중첩 호출하지 않는다. 3차는 첫 pass의 선택 원문을 private memory lease로 잠시 유지해 기존 고정 안전 view/발췌 변환을 수행하고 해제한다. 추가 collect 읽기나 raw source body 반환은 없다.

| 단계 | 내용 읽기 | 검증 책임 |
| --- | --- | --- |
| 입력 gate | 없음 | 회사 읽기/보관 선언, 새 등록/profile·선택 범위·설정/원본/runtime 경로 분리 |
| pass 1: inspect | 작은 Git 파일, 모든 후보 index, pack header/trailer, 필요한 객체 구간, 선택 작업 파일 | 형식·내용/실행 비트·작업 index 검증 후 원문을 내부 lease로 유지하고 관찰 proof 생성 |
| collect | 추가 파일 읽기 없음 | 고정 안전 view/발췌 변환. 임시 복사 공간 예약, 원문과 전체 view 해제, 발췌/proof만 반환 |
| pass 2: verify | 작은 파일·index·header/trailer·객체 구간·작업 파일을 새로 읽음 | metadata·CRC/OID·원문 hash 및 다시 만든 안전 view/발췌를 첫 결과와 비교 |
| 저장 | 추가 원본 내용 읽기 없음 | final guard·자원 정리 뒤 새 계획/payload 원자 저장. 저장 확정과 부모 결과 수신을 구분 |

현재 cache가 없어 같은 객체도 다시 읽는다. 읽기 전후 같은 FD의 `fstat`, 경로 `lstat`, 부모 identity를 비교하고 각 pass에서 HEAD/ref와 index를 검사한다. 후보 목록과 pack/index 짝이 바뀌거나 재압축·교체가 관찰되면 내용 OID가 같아도 실패한다. content pass 마지막에는 경로/부모 metadata와 아직 열린 FD를 다시 대조하고 descriptor를 정리한다. 이미 닫은 FD를 계속 감시했다고 표시하지 않는다. close 실패는 닫힘을 증명하지 못하므로 FD 계수를 유지하고 같은 descriptor 번호로 재시도하지 않는다. v2는 이 실패 상태를 저장하지 않으며 부모는 worker의 `close`를 관찰해야 종료가 확인됐다고 표시한다.

각 파일의 identity 비교는 여러 파일의 원자적 snapshot을 만들지 않는다. 최종 관찰 이후 변경, 미조회 pack 영역, 악성 동시 사용자·침해된 호스트까지 방어한다고 표시하지 않는다. 지원 신뢰 모델은 기존과 같은 단일 OS 사용자와 신뢰하는 하네스 코드다. 30초 종료 정책도 OS 스케줄링/프로세스 종료의 절대 시간 보장은 아니다.

## 5. 객체와 index 검증 순서

1차 codec은 전달받은 index/header/span/loose 객체·delta의 바이트 구조와 CRC/OID를 검증한다. 2차 source/files는 이를 실제 파일 metadata 검사·후보 탐색·구간 읽기·경로 연결에 사용한다. `company-git-range-payload.ts`는 commit/tree 본문과 작업 파일용 index v2/v3를 순수 메모리에서 검사한다. source 연결에 필요한 delta apply 함수를 공개했고 pack header와 작업 index magic은 ASCII 변환으로 상위 비트를 무시하지 않고 정확한 바이트로 검사한다. 고정 profile·기존 v1 계약/한도/hash는 변경하지 않는다.

1. 후보 index를 크기/소유권/link/경로 검사를 거쳐 읽는다. v2 magic/version, 정확한 길이, 전체 index checksum, fanout의 단조성 및 각 첫 바이트별 실제 개수, OID의 정렬/중복, offset의 중복·범위를 검사한다. 비어 있지 않은 pack의 최초 offset은 header 다음인 12여야 한다. 지원하지 않는 64-bit 표나 잘못된 정수를 읽기 전에 거부한다. index와 pack의 선언 객체 수도 대조한다.
2. pack 파일은 크기와 고정 header/trailer만 읽는다. format/version·객체 수·index의 pack checksum 값과 trailer 값의 일치를 검사한다. 전체 pack checksum을 계산한 것으로 기록하지 않는다. 파일 이름의 hash도 출처 인증으로 사용하지 않는다.
3. index의 OID 목록에서 필요한 객체를 찾고, 모든 offset을 숫자로 정렬한 별도 제한 배열에서 다음 offset 또는 trailer 시작을 찾아 구간을 정한다. 여러 pack에 같은 OID가 있으면 고정 정렬 순서로 선택한다. 잘못된 index를 무시하고 다른 pack으로 자동 재시도하지 않는다.
4. 구간이 header/trailer 밖으로 나가거나 2MiB를 넘으면 읽기 전에 거부한다. 정확한 구간의 CRC32를 index와 대조하고 SHA-256을 관찰 proof에 기록한다. 객체/offset varint의 과도한 길이·정수 overflow와 예약 type을 거부한다. zlib 종료와 소비량이 구간의 압축 본문 끝과 정확히 일치해야 한다. 남은 바이트를 무시하거나 다음 객체까지 해제하지 않는다.
5. 일반 객체는 type·선언 크기·실제 길이·`SHA1(type + length + NUL + content)`가 index OID와 일치해야 한다. OFS base는 같은 pack의 앞쪽 유효 offset과 해당 index OID로, REF base는 같은 pack의 OID로 확인한다. 모든 base에도 CRC/OID 검증을 적용한다. 외부 base·cycle·초과 깊이는 실패다.
6. delta의 source/target 길이, copy offset/길이, insert 길이와 결과 크기를 적용 전에 검사하고 opcode 0을 거부한다. 공통 예산에 부수 base·반복 해제·재구성 출력을 모두 포함한다. 최종 type과 OID를 확인하며 base만 검증하고 결과를 신뢰하지 않는다.
7. 기준 commit OID부터 각 선택 경로의 원본 tree와 blob을 따라간다. 필요한 tree의 정확한 형식·이름/유형·경로 연결을 검사하고 선택 작업 파일 원문/실행 비트 및 Git index 선택 항목과 대조한다. untracked/staged/dirty 상태를 전체 저장소 단위로 판정하지 않는다.

commit parser는 tree/author/committer의 필수 구조·중복과 parent OID를 검사하고 선택 tree OID만 반환한다. 선택에 쓰지 않는 multiline 서명 metadata는 자료로만 처리한다. tree는 선택 항목 뒤까지 모든 항목의 mode·UTF-8 이름·Git 정렬·중복·경로 안전성을 검사하며 선택된 symlink/gitlink는 source에서 거부한다. 작업 index는 전체 SHA-1·v2/v3 구조·항목 수·이름 바이트 길이·padding·선택 항목의 stage 0/extended flag 부재/OID/mode와 optional extension의 경계를 검사한다. optional extension 본문은 근거로 사용하지 않으며 작성자·서명 인증은 하지 않는다.

loose 객체는 index OID 대신 파생한 파일명 OID와 대조한다. 압축 파일 크기 8MiB 상한, 정확한 `type size\0` header, 선언/실제 내용 길이 1MiB 상한, zlib EOF와 전체 압축 바이트의 정확한 소비량을 검사한다. header에는 별도 128바이트 상한을 두고 해제 출력/메모리 합계에도 포함한다. header와 내용을 재구성한 SHA-1이 파일명 OID와 같아야 하며 전체 압축 파일의 SHA-256과 identity도 proof에 기록한다. 공통 예산을 그대로 사용하고 pack 실패를 loose 재시도로 감추지 않는다.

## 6. 새 증거 형식과 비활성 연결

`company-git-range-reader-v1` profile과 `company-git-range-byte-proof-v1`의 순수 생성/검증을 구현했다. byte proof는 bounded JSON의 구조·hash·객체 의존 관계 등 전달받은 metadata의 일관성만 확인한다. 실제 pack을 관찰했다는 증명이나 파일 출처·FS provenance 인증이 아니며 직접 구성한 일관된 metadata도 입력될 수 있다.

3차 입력과 계획은 `company-readonly-registration-v2`, `company-readonly-preparation-v2`다. 새 등록에는 `gitProfileHash`가 필수이며 현재 고정 profile과 정확히 일치해야 한다. 전용 `company-readonly-v2-plan/inspect/cancel/prune` 명령을 사용한다. 기존 v1 실패 시 자동 전환하지 않고 기존 승인/계획/DB를 자동 변환하거나 재사용하지 않는다. 정확한 설정 형식과 명령은 [회사 작업 가이드](../guides/company-workflows.md#구간-판독기를-사용하는-회사-준비-v2)에 둔다.

현재 내부 source 결과는 `company-git-range-source-observation-v1`이다. 파일/부모 identity와 존재하지 않던 경로·pack 목록·실제 읽은 `(offset, length, sha256)` 구간, pack metadata/byte proof, loose 객체 hash, 선택 파일 hash/크기/mode/OID를 관찰 hash로 결합한다. `integrityScope: selected-object-chain`, `packChecksum: not_checked`, `unvisitedObjects: not_checked`와 profile hash를 명시한다. 실제 자원 계수는 별도 budget snapshot으로 확인한다. 같은 파일의 같은 offset/length는 proof에서 중복 제거하지만 I/O 예산은 반복 호출도 모두 차감한다. 기존 `gitEntries.hash`에 부분 hash를 넣지 않고 전체 raw 객체나 전체 tree 목록을 반환/저장하지 않는다.

관찰 결과 단독은 회사 승인이나 외부 출처 인증이 아니다. v2 계획은 관찰·예산·안전 view hash를 등록/정책과 함께 결합한다. 내부 FS metadata에는 경로가 포함되므로 그대로 일반 출력이나 공유 요약으로 내보내지 않는다. byte proof 단독은 여전히 전달된 metadata 일관성만 확인하며, 파일 관찰은 source/files의 별도 책임이다.

등록·profile·proof·예산·안전 view·입력·기간을 새 plan hash에 결합하고 private payload 검증에도 같은 버전을 요구한다. 기존 v1 DB와 분리한 runtime의 `store/company-readonly-v2.sqlite`를 사용하며 디렉터리/부모 `0700`, 파일 `0600`과 소유자·위치 binding을 검증한다. 기존 정책의 읽기/보관 선언, 기본 비활성, `AWAITING_APPROVAL`, 승인 생성·전송·실행 false, `companyPolicyVerified:false`와 보관 상한은 유지한다. 회사용 approve/run이나 모델 연결은 없다.

실패는 형식/미지원, 자원 초과, 원본 변화, 민감 검사 등 고정 분류와 집계로 남긴다. 원본 경로·파일명·원시 예외·commit/tree/base 본문은 일반 출력에 넣지 않는다. 예산 초과/timeout/원본 변화에는 자동 재시도나 확대 읽기가 없다. 종료 시 descriptor·메모리 cache를 정리하며 raw 디스크 cache는 만들지 않는다.

v2 부모는 시작 전에 준비 ID를 정하고 본문 없는 `runs/run-<id>.json`과 디렉터리 항목을 fsync한 뒤 worker를 시작한다. 시작 기록은 runtime 위치 hash에도 결합해 DB가 없는 상태의 이동·복사를 거부한다. 시작 기록은 덮어쓰지 않고 결과를 별도 `result-<id>.json`에 한 번 저장한다. final guard 이전 실패는 계획/payload를 만들지 않는다. DB commit 직후 결과 전달 전에 timeout/종료가 일어나면 저장됐을 수 있으므로 결과는 `unknown`이다. 부모 종료로 결과 파일이 없는 시작 기록도 `unknown`으로 해석한다. 같은 ID의 명시적 `inspect`에서 소유자·버전/profile·plan/payload hash·기한을 검증해 저장된 `AWAITING_APPROVAL/CANCELLED/EXPIRED` 또는 부재/손상을 구분한다. 이 상태 조회는 원래 worker 종료 확인을 대신하지 않는다. 취소/만료에 따른 payload 부재와 DB 손상을 혼동하지 않으며 자동 재시도는 없다. 새로 명시한 `plan`은 새 ID를 만들고 유효하게 저장돼도 전송/실행 권한은 false다.

v2 worker는 최소 환경을 사용하고 쓰기는 runtime의 `store/`에만 허용한다. 부모가 소유한 `runs/`·대상 쓰기·네트워크·추가 child는 허용하지 않는다. Node 권한 모델의 부모 metadata 재검증 때문에 읽기 권한은 전체로 열고 실제 경로·구간 제한은 신뢰하는 고정 판독기가 강제한다. 이를 OS 읽기 격리나 악성 코드 sandbox로 설명하지 않는다. supervisor는 기한에 SIGTERM과 250ms 뒤 SIGKILL을 요청하지만 `exitConfirmed:true`는 child의 `close`를 받은 경우에만 표시한다. 부모 생존·OS 신호 처리 조건이 필요하고 독립 guardian이나 부모 강제 종료 후 고아 프로세스 방지는 제공하지 않는다.

## 7. 구현 순서와 합성 수용 기준

1. **순수 codec와 예산 — 1차 구현:** index/pack header/span/loose/delta 검증, 한 요청의 공유 계수와 byte proof/profile 및 합성 테스트를 추가했다. 고정 합성 바이트만 사용했고 당시에는 대상 파일을 열지 않았다. 당시 검사 결과는 보존한다.
2. **본문 parser와 합성 positioned reader — 2차 구현:** commit/tree·작업 index parser, 제한된 FD 위치 지정 읽기와 실제 작업 계수, 두 pass의 source proof hash 재검증을 연결했다. 합성 큰 pack에서 필요한 구간만 읽으며 전체 pack 읽기나 구형 라이브러리 fallback은 없다. 실제 회사 접근·OS RSS 실험·강제 시간 종료 검증은 포함하지 않는다.
3. **회사 준비 v2 연결 — 3차 통합:** 회사 정책/새 등록 gate, 고정 safe-view, 새 계획/전용 보관·CLI와 부모 supervisor를 연결하고 합성 검증을 수행한다. 구형 계약과 테스트 결과가 달라지지 않는지 회귀를 확인하며 결과는 별도 기록한다.
4. **원본 읽기 전용 적용 — 별도 1회 중단:** 3차 통합 뒤 추가 의존 객체 접근까지 허용된 준비 1회는 `COMPANY_GIT_RANGE_LIMIT`로 중단됐으며 계획 부재를 확인했다. 당시 동적 계수는 없어 정확한 제한 항목은 미확인이다. 구현·profile은 그대로 유지한다.
5. **실패 진단 보완 — 합성 검증:** 최초 한도 실패의 단계·항목·현재/요청/최대량과 정리 전 공유 계수를 별도 진단으로 기록한다. 기존 오류·성공 snapshot·plan/payload/DB/stdout 계약은 유지한다. 회사 원본 재실행은 포함하지 않으며 합성 재현으로 과거 실패 원인을 단정하지 않는다.

전체 기능의 필수 수용 기준은 다음과 같다. 1차 순수 검사는 [codec 결과](../history/stage-4c17-codec-result.md), 2차 parser·파일 I/O/guard 검사는 [reader 결과](../history/stage-4c17-reader-result.md), 회사 준비·저장·CLI·supervisor 통합은 [3차 결과](../history/stage-4c17-integration-result.md)에 구분한다. 항목별 실제 검증과 한계를 기록하며 이전 단계나 4-C-16의 통과 결과로 전체 완료를 대신하지 않는다.

| ID | 확인할 내용 |
| --- | --- |
| R1 | 정책·버전/profile 미확정/위조 시 대상 metadata 접근 0. v1 입력·hash·실패 판정과 수집 profile 보존, 자동 fallback 0 |
| R2 | 8MiB/4,096객체를 넘고 새 후보 상한 안인 유효 합성 pack에서 같은 선택 객체/근거 도출. pack 전체가 읽히지 않으며 두 pass의 실제 구간과 예약/반환량 일치 |
| R3 | index checksum·fanout·OID 순서/중복·offset 중복/범위·개수·길이·미지원64-bit·pack header/trailer 불일치, loose header/길이/파일명 OID·zlib 소비량 불일치 거부 |
| R4 | 선택 span CRC·OID·zlib 소비량·type/길이·cutoff 변조 거부. 미조회 span 손상은 전체 pack 검증 성공으로 표시하지 않고 선택 영역 검증의 한계를 드러내는 대조 사례 포함 |
| R5 | 정상 OFS/REF chain, base/결과 OID 위조, 외부 base·cycle·copy 범위·폭탄·깊이/해제량 초과 거부. 비선택 base 본문이 로그/DB/근거에 남지 않음 |
| R6 | 모든 예산의 경계/경계+1, 짧은 read/실패 차감, collect와 final guard의 계수 공유, 개별 상한 안이어도 합계 초과 거부. 현재 cache 없음; 후속 cache 도입 시 hit 뒤에도 final reread 확인 |
| R7 | HEAD/ref/index/선택 원문·안전 view와 FD/경로/부모·pack/index 목록의 변경, rename·symlink/hardlink·동시 repack 거부. 성공 전후 합성 원본 파일/Git 동일 |
| R8 | guard 이전 실패의 계획/payload 0, commit 전후·결과 전달 전 종료 경쟁의 `unknown` 처리와 같은 ID 상태 확인, 자동 재실행 0 및 자원 정리. 관리 버퍼 한도와 old-space 설정, RSS 측정 목표·종료 지연 관찰을 각각 기록 |
| R9 | worker의 store/ 밖 쓰기·추가 child·네트워크·인증 환경/키체인/명시적 인증파일 접근·login/refresh/native/model 호출 0. Git 객체의 내장 민감값 부수 읽기와 구분. metadata 전용 API 유지, v2는 안전 발췌/proof만 반환하고 공유 출력은 집계만 제공. raw pack/tree/base 디스크 보관 0 |
| R10 | 기존 lint/typecheck/회사 집중/전체 회귀 통과. 설치된 pnpm 유지. 미지원 형식과 미조회 전체 pack 보증 부재를 결과/문서에 표시 |

회사 적용 판단은 현재 합성 I/O/guard 결과에 더해 회사 준비·자원·supervisor 통합 검증을 마친 뒤 내려야 한다. 한도나 보증 범위 변경이 필요하면 실패 근거와 변경안을 먼저 기록하고 profile 버전을 갱신한다. 숫자만 높여 기존 계획을 통과시키지 않는다.

## 8. 구현 기록과 남은 검증

설계 기준은 기존 판독기·회사 준비 service/정책·설치된 `isomorphic-git` 1.44.12 구현이다. 1차 domain/policy codec의 기록은 [4-C-17 codec 결과](../history/stage-4c17-codec-result.md)에 보존한다. 2차는 별도 payload parser·files/source 모듈과 합성 테스트를 추가하며 기존 판독기·등록·CLI·DB·수집 profile/hash·상한·의존성·lockfile은 유지한다. 실제 검사 결과와 미실행 사유는 [4-C-17 reader 결과](../history/stage-4c17-reader-result.md)에 기록하고 상세 로그는 허용된 비공개 로컬 위치에 보관한다.

3차는 회사 정책/등록 v2 gate와 고정 safe-view·계획/전용 보관·CLI·부모 supervisor를 연결한다. 검사 집계·RSS 관찰·저장 경쟁과 남은 한계는 [통합 결과](../history/stage-4c17-integration-result.md)를 따른다. 실제 회사 자료·인증·native·모델·외부 서비스 접근은 이번 범위에 없으며 회사 원본 적용은 미실행이다. 부모 강제 종료에 대한 독립 guardian과 OS RSS 강제 상한도 제공하지 않는다. 다음 실제 적용 판단은 구체 통합 결과와 기존 회사 허용 범위, 추가·미확인 의존 객체 접근을 대조한 뒤에만 한다. 합성 결과를 해당 회사 저장소의 호환성 해결이나 조사 성공으로 표시하지 않는다.

3차 기록은 당시 범위로 보존한다. 이후 별도 허용된 회사 준비의 자원 한도 중단을 계기로 [진단 보완 결과](../history/stage-4c17-diagnostic-result.md)를 추가한다. `company-git-range-failure-v1`은 실제 budget 오류의 identity에 결합하며, cleanup에서 최초 실패를 보존한다. worker의 고정 stderr frame은 기존 64KiB stderr 한도 안에서 최대 8192바이트 JSON으로 검증한다. task 불일치·중복·잘린 frame·임의 필드/값은 거부하고 원시 stderr는 보관하지 않는다. 강제 종료 시 진단이 없을 수 있으며 `failure:null`을 성공이나 특정 원인으로 해석하지 않는다.

선택 `--diagnostics-dir`을 준 plan/prune은 runtime과 분리된 부모·디렉터리0700/파일0600 위치를 사용한다. 부모만 `diagnostic-<id>.json`을 불변 생성하며 task/owner/runtime/진단 위치 hash와 기존 audit 만료를 검증한다. 최대8192바이트·8192파일이고 이동/복사·링크·권한·hash 변경은 거부한다. 같은 옵션의 plan 시작/prune에서만 만료 기록을 정리하며 별도 자동 정리 타이머는 없다. 상세 진단과 정상 run/result 형식을 섞지 않는다. 진단 저장 실패는 unknown이고 같은 ID inspect로 이미 저장됐을 수 있는 계획을 확인한다. 한도·조회 횟수·경로 guard·읽기 pass를 늘리거나 자동 재시도하지 않는다.
