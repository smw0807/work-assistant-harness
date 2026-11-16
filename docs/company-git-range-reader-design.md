# 회사 원본 저장소의 Git 선택 읽기 설계

2026-11-16. **설계만 완료한 후속 제안이며 미구현이다.** 회사 레포를 복사하지 않고 지정한 원본 경로에서 읽기 전용 조사를 준비하는 방향으로 전환한다. [4-C-16 사본 실험](stage-4c16-result.md)은 보존하지만 사본 생성기는 더 개발하지 않는다. 조사에는 작업 브랜치가 필요하지 않다. 대상 코드 변경을 위한 브랜치·수정·검사 실행은 이후 별도 범위다.

이번 변경은 문서뿐이다. 새 판독기·등록·계획·DB·CLI는 없고 회사 자료 접근, 실제 인증·native·모델 호출도 없다. 아래 수치는 구현과 합성 성능 검증에 사용할 **초기 후보값**이며 현재 실행 가능한 설정이나 해당 회사 레포의 호환성 보증이 아니다.

## 1. 바꿔야 하는 이유와 계약

현재 `personal-readonly-repository.ts`는 Git 파일 전체를 읽어 파일당 8MiB·관찰별 누적 64MiB를 적용한다. pack/index의 객체 수는 4,096개 이하이고 pack 전체 checksum·전체 객체의 압축/델타 구조를 검증한다. 회사 v1은 이 판독기를 재사용한다. 설치된 `isomorphic-git`의 Node 구현도 pack 전체를 읽으므로 FS 어댑터의 옵션만 바꾸는 방식으로 부분 읽기를 구현할 수 없다.

새 방식은 `.idx`를 제한된 크기로 모두 검사한 뒤, 필요한 객체의 pack 구간만 위치를 지정해 읽는 **회사 전용 판독기**다. 기존 개인/회사 v1의 코드·입력·출력·hash·한도는 그대로 둔다. 다음 차이는 새 계약에 드러내야 한다.

| 구분 | 기존 v1 | 새 설계 |
| --- | --- | --- |
| pack 크기 | 전체 파일 8MiB 이하 | 물리적 파일 크기와 실제 읽을 구간/총량을 별도로 제한 |
| pack 객체 수 | 전체 검사 대상 4,096개 이하 | 큰 index의 metadata를 검사하고 필요한 객체·의존 그래프만 복원 |
| 내용 무결성 | 읽은 pack 전체 checksum과 모든 객체 구조 검사 | 전체 index checksum, 선택 구간 CRC·SHA-256, 선택 객체·의존 객체의 복원 OID 검사 |
| 미조회 영역 | 읽은 pack 전체를 검사 | pack 전체 checksum·미조회 객체는 `not_checked` |
| 원본 감시 | 전체 Git 파일 hash와 선택 작업 파일 | 작은 Git 파일 전체 hash, pack metadata·실제 읽은 구간의 proof와 선택 작업 파일 |
| 읽기 예산 | 내부 observation마다 새 계수 | 준비 요청 전체에서 공유하는 계수, 재검증도 포함 |

이것은 기존 검증과 동등한 최적화가 아니다. CRC는 손상 탐지용이고 pack trailer와 index에 적힌 checksum 값의 일치는 전체 pack checksum 계산을 대신하지 않는다. 새 방식에서도 commit→tree→선택 blob의 내용 일치는 확인하지만 전체 pack·저장소의 무결성, 작성자/서명/원격 출처의 진위는 보증하지 않는다.

## 2. 접근 범위와 지원 형식

- 입력은 고정 원본 경로·기준 commit·선택 파일/줄이다. 회사 읽기·보관 선언과 새 버전/고정 profile 확인을 대상 metadata 접근보다 먼저 수행한다. 기존에 확인한 정책은 재확인하지 않고 추가되거나 미확인인 범위만 확인한다.
- 읽을 수 있는 내용은 HEAD/해당 ref/필요한 packed-refs, Git index, 제한된 pack index들, 선택 commit·경로의 tree·선택 blob과 **그 복원에 필요한 delta base**다. base는 선택하지 않은 파일이나 과거 내용일 수 있다. 이 부수 접근을 선택 소스 파일 8개 제한과 같은 의미로 설명하지 않는다.
- SHA-1 OID, 일반 `.git` 디렉터리, index v2, pack v2/v3와 일반 loose 객체를 첫 지원 대상으로 한다. 작업 파일용 Git index는 기존 v2/v3·선택 항목 검증을 유지한다. OFS_DELTA와 같은 pack 안의 REF_DELTA만 허용한다.
- offset은 32-bit 표만 지원한다. 후보 pack 최대 512MiB에는 충분하다. 64-bit offset 표, 외부 base/thin pack, alternate object store, 별도 worktree의 `.git` 파일, Git config/hooks·원격·자동 fetch·사용자 filter는 지원하지 않는다. 미지원 형식은 명시적 실패로 끝낸다.
- 원본을 쓰거나 복사/repack하지 않는다. Git CLI·대상 코드 import·설치·테스트·빌드·쉘 실행과 네트워크를 제공하지 않는다. 경로·소유자·단일 링크·부모 identity·비밀 파일 제한은 계속 적용한다.
- tree와 commit은 검증 중 원문 metadata를 메모리에서 읽으며 delta base에도 민감 내용이 있을 수 있다. raw 객체·pack 구간·전체 index를 보고서/DB/임시 파일에 보관하지 않는다. 선택된 안전 발췌만 기존 수집 정책으로 처리한다.

인증 환경·키체인·명시적인 인증 파일을 열거나 로그인/refresh하는 기능은 없다. 다만 Git 객체에 내장된 민감값을 메모리에서도 전혀 읽지 않는다는 보증은 할 수 없다. 실제 적용 전 이 의존 객체 접근 범위를 기존 회사 자료 허용/인증정보 제외 범위와 대조해야 하며, 이번 문서 설계만으로 새로운 부수 접근을 허용한 것으로 해석하지 않는다.

## 3. 고정 자원 profile 후보

MiB/KiB는 각각 1,048,576/1,024바이트다. 파일에 적힌 크기를 믿고 먼저 할당하지 않는다. 모든 제한을 함께 적용하며 하나라도 넘으면 준비를 거부한다. 한 항목의 최대값을 허용한다고 다른 항목까지 동시에 최대값으로 처리할 수 있다는 뜻은 아니다.

| 항목 | 후보 상한 | 계수/의미 |
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
| 열린 파일 descriptor | 동시에 32개 | 실패·취소 시 모두 닫음 |
| 판독기 관리 메모리 | 살아 있는 buffer/typed array 32MiB | 압축/해제 버퍼·index·정렬용 배열·객체 cache 포함 |
| 복원 객체 cache | 8MiB | 관리 메모리 32MiB 안에 포함, 별도 추가 허용량이 아님 |
| worker V8 old-space | 128MiB | 전체 JS heap/Buffer/native 메모리/RSS 강제 상한이 아님 |
| worker RSS | 256MiB 이하를 합성 측정 목표로 사용 | OS 강제 격리/상한을 제공한다고 표시하지 않음 |
| 준비 wall-clock | 30초 | 부모 supervisor 종료 정책. deadline을 단계마다 연장하지 않음 |
| 종료 유예 | 250ms | deadline 후 종료 요청, 미종료면 강제 종료하고 종료 확인 전 성공 처리 금지 |

읽기 요청 전에 요청 길이 전부를 예산에서 차감한다. 짧게 읽거나 실패해도 차감액을 환급하지 않고 실제 반환 바이트도 별도 집계한다. 첫 pass는 32MiB 안에서 끝나야 하며 final pass에 새 64MiB를 주지 않는다. 메모리·출력·횟수도 부수 작업과 재검증에서 공유한다. 관리 메모리 계수는 참조된 backing buffer를 중복 계산하지 않되 cache/view가 참조하면 해제됐다고 계산하지 않는다. GC·zlib 내부 메모리·Node 런타임까지 이 계수로 강제했다고 주장하지 않는다.

index당 131,072개는 32-bit offset 형식에서 `1,072 + 28 × 131,072 = 3,671,088`바이트다. 구조 검증과 파일당/전체 바이트 상한을 모두 검사한다. index 합계 8MiB와 작업 index 8MiB를 두 번 읽으면 32MiB가 들고, 나머지 파일·구간 읽기도 같은 64MiB 예산을 사용한다. delta chain이 32노드 미만이어도 누적 해제 16MiB를 넘으면 거부한다.

소스 64KiB·전체 안전 view 64KiB·발췌 32KiB·근거 64KiB·입력 128KiB, 선택 파일 8개·범위 16개·범위당 200줄·마스킹 128개는 기존 수집 v2 값과 hash를 유지한다. relay/모델 예산과 실행 권한은 변경하지 않는다. 위 Git profile은 임의 CLI/env/등록 값으로 높일 수 없고 고정 상수와 profile hash로 결합한다. 성능 목표 미달을 자동 상향·재시도로 해결하지 않는다.

## 4. 최초 읽기와 최종 재검증

기존 회사 v1의 `inspect/collect/assertUnchanged`를 겹쳐 호출하면 내부 guard마다 재읽기와 계수가 중복된다. 새 회사 전용 source session은 정확히 **두 번의 content pass**와 그 사이의 순수 변환으로 구성한다. 기존 개인 수집기에서는 경로/민감 검사·안전 view 변환과 한도만 재사용하고, 구형 source guard를 새 session 안에 숨겨 호출하지 않는다.

| 단계 | 내용 읽기 | 검증 책임 |
| --- | --- | --- |
| 입력 gate | 없음 | 정책 선언·버전/profile·소유자·경로 분리·등록/범위를 고정 |
| pass 1: inspect | 작은 Git 파일, 모든 후보 index, pack header/trailer, 필요한 객체 구간, 선택 작업 파일 | 아래 형식·내용 검증 후 첫 proof와 source bytes를 메모리에서 고정 |
| collect | 추가 파일 읽기 없음 | 고정 source bytes로 기존 안전 view/발췌·입력 구성. 외부 callback·실행 없음 |
| pass 2: final guard | pass 1에서 사용한 작은 파일·index·header/trailer·객체 구간·작업 파일을 새로 읽음 | 새 metadata·CRC/OID·raw hash·source view를 재검증하고 최초 proof와 비교 |
| 저장 | 추가 원본 내용 읽기 없음 | final guard 완료 후 외부 작업을 끼우지 않고 새 계획/payload를 원자 저장. 저장 확정과 부모에게 결과 전달을 구분 |

pass 내부 동일 객체의 cache hit는 I/O를 절약할 수 있지만 두 번째 pass의 새 읽기를 대체하지 않는다. 읽기 전후 같은 FD의 `fstat`, 경로 `lstat`, 부모 identity, HEAD/ref와 index를 확인한다. 전체 후보 목록과 pack/index 짝이 바뀌거나 재압축·교체가 관찰되면 내용 OID가 같아도 실패한다. content pass 마지막에는 경로/부모 metadata와 아직 열린 FD를 다시 대조하고 descriptor를 정리한다. 이미 닫은 FD를 계속 감시했다고 표시하지 않는다.

각 파일의 identity 비교는 여러 파일의 원자적 snapshot을 만들지 않는다. 최종 관찰 이후 변경, 미조회 pack 영역, 악성 동시 사용자·침해된 호스트까지 방어한다고 표시하지 않는다. 지원 신뢰 모델은 기존과 같은 단일 OS 사용자와 신뢰하는 하네스 코드다. 30초 종료 정책도 OS 스케줄링/프로세스 종료의 절대 시간 보장은 아니다.

## 5. 객체와 index 검증 순서

1. 후보 index를 크기/소유권/link/경로 검사를 거쳐 읽는다. v2 magic/version, 정확한 길이, 전체 index checksum, fanout의 단조성 및 각 첫 바이트별 실제 개수, OID의 정렬/중복, offset의 중복·범위를 검사한다. 비어 있지 않은 pack의 최초 offset은 header 다음인 12여야 한다. 지원하지 않는 64-bit 표나 잘못된 정수를 읽기 전에 거부한다. index와 pack의 선언 객체 수도 대조한다.
2. pack 파일은 크기와 고정 header/trailer만 읽는다. format/version·객체 수·index의 pack checksum 값과 trailer 값의 일치를 검사한다. 전체 pack checksum을 계산한 것으로 기록하지 않는다. 파일 이름의 hash도 출처 인증으로 사용하지 않는다.
3. index의 OID 목록에서 필요한 객체를 찾고, 모든 offset을 숫자로 정렬한 별도 제한 배열에서 다음 offset 또는 trailer 시작을 찾아 구간을 정한다. 여러 pack에 같은 OID가 있으면 고정 정렬 순서로 선택한다. 잘못된 index를 무시하고 다른 pack으로 자동 재시도하지 않는다.
4. 구간이 header/trailer 밖으로 나가거나 2MiB를 넘으면 읽기 전에 거부한다. 정확한 구간의 CRC32를 index와 대조하고 SHA-256을 관찰 proof에 기록한다. 객체/offset varint의 과도한 길이·정수 overflow와 예약 type을 거부한다. zlib 종료와 소비량이 구간의 압축 본문 끝과 정확히 일치해야 한다. 남은 바이트를 무시하거나 다음 객체까지 해제하지 않는다.
5. 일반 객체는 type·선언 크기·실제 길이·`SHA1(type + length + NUL + content)`가 index OID와 일치해야 한다. OFS base는 같은 pack의 앞쪽 유효 offset과 해당 index OID로, REF base는 같은 pack의 OID로 확인한다. 모든 base에도 CRC/OID 검증을 적용한다. 외부 base·cycle·초과 깊이는 실패다.
6. delta의 source/target 길이, copy offset/길이, insert 길이와 결과 크기를 적용 전에 검사하고 opcode 0을 거부한다. 공통 예산에 부수 base·반복 해제·재구성 출력을 모두 포함한다. 최종 type과 OID를 확인하며 base만 검증하고 결과를 신뢰하지 않는다.
7. 기준 commit OID부터 각 선택 경로의 원본 tree와 blob을 따라간다. 필요한 tree의 정확한 형식·이름/유형·경로 연결을 검사하고 선택 작업 파일 원문/실행 비트 및 Git index 선택 항목과 대조한다. untracked/staged/dirty 상태를 전체 저장소 단위로 판정하지 않는다.

loose 객체는 index OID 대신 파생한 파일명 OID와 대조한다. 압축 파일 크기 8MiB 상한, 정확한 `type size\0` header, 선언/실제 내용 길이 1MiB 상한, zlib EOF와 전체 압축 바이트의 정확한 소비량을 검사한다. header에는 별도 128바이트 상한을 두고 해제 출력/메모리 합계에도 포함한다. header와 내용을 재구성한 SHA-1이 파일명 OID와 같아야 하며 전체 압축 파일의 SHA-256과 identity도 proof에 기록한다. 공통 예산을 그대로 사용하고 pack 실패를 loose 재시도로 감추지 않는다.

## 6. 새 증거 형식과 비활성 연결

후보 이름은 `company-git-range-reader-v1` profile, `company-readonly-registration-v2`, `company-readonly-preparation-v2`다. 현재 parser가 이 입력을 수용한다는 뜻은 아니다. 기존 v1 실패 시 새 방식으로 자동 전환하지 않고, 사용자에게 검토 가능한 새 준비 입력/계획에서 명시적으로 선택한다. 기존 승인/계획/DB를 자동 변환하거나 재사용하지 않는다.

새 repository proof는 작은 파일의 전체 hash와 pack의 부분 관찰을 별도 타입으로 둔다. pack 기록에는 identity/size, index hash, header/trailer 관찰, `(offset, length, sha256)` 구간 목록과 `(type, OID, base dependency)`를 결합한다. 기존 `gitEntries.hash`에 부분 hash를 넣지 않는다. proof에는 `integrityScope: selected-object-chain`, `packChecksum: not_checked`, `unvisitedObjects: not_checked`, profile hash와 실제 자원 계수를 포함한다. 전체 raw 객체나 전체 tree metadata는 저장하지 않는다.

등록·profile·proof·안전 view·입력·기간을 새 plan hash에 결합하고 private payload 검증에도 같은 버전을 요구한다. 저장 경로는 기존 v1 DB와 분리하는 것을 첫 구현 기준으로 한다. 기존 정책의 읽기/보관 선언, 기본 비활성, `AWAITING_APPROVAL`, 승인 생성·전송·실행 권한 false, `companyPolicyVerified:false`와 보관 상한은 유지한다. 이 설계로 회사용 approve/run이나 모델 연결을 추가하지 않는다.

실패는 형식/미지원, 자원 초과, 원본 변화, 민감 검사 등 고정 분류와 집계로 남긴다. 원본 경로·파일명·원시 예외·commit/tree/base 본문은 일반 출력에 넣지 않는다. 예산 초과/timeout/원본 변화에는 자동 재시도나 확대 읽기가 없다. 종료 시 descriptor·메모리 cache를 정리하며 raw 디스크 cache는 만들지 않는다.

supervisor는 시작 전에 준비 ID를 정하고 내용 없는 비공개 실행 기록에 남긴다. final guard 이전 실패는 계획/payload를 만들지 않는다. 반면 DB commit 직후 결과 전달 전에 timeout/프로세스 종료가 일어나면 저장이 완료됐을 수 있으므로 결과는 `unknown`으로 기록한다. 이를 성공이나 payload 부재로 단정하거나 새 ID로 재시도하지 않는다. 명시적 상태 확인에서 같은 ID의 소유자·새 버전/profile·plan/payload hash·기한을 검증해 저장된 `AWAITING_APPROVAL/CANCELLED/EXPIRED` 또는 부재/손상을 구분한다. 취소/만료에 따른 payload 부재와 DB 손상을 혼동하지 않는다. 부재 확인도 자동 재실행 권한이 아니다. 유효하게 저장됐어도 전송/실행 권한은 false이며 원본의 현재 상태를 다시 조사한 결과는 아니다.

실행 환경은 최소 상속 환경과 runtime 밖 쓰기·네트워크·추가 child 거부를 유지한다. 현재 Node 권한 모델의 부모 metadata 재검증 때문에 읽기 권한 자체가 넓게 열려 있다면 실제 경로·구간 제한은 신뢰하는 판독기 코드가 강제한다는 사실을 명시한다. 이를 OS 읽기 격리나 악성 코드 sandbox로 설명하지 않는다.

## 7. 구현 순서와 합성 수용 기준

1. **순수 codec와 예산:** index/pack header/span/delta 검증, 한 요청의 공유 계수와 새 proof/profile schema를 구현한다. 고정 합성 바이트만 사용하며 아직 대상 경로를 받지 않는다.
2. **합성 positioned reader:** 테스트가 만든 큰 pack을 FD의 위치 지정 읽기로 처리하고 실제 읽은 구간/바이트·메모리·시간을 관찰한다. 전체 pack read나 구형 라이브러리 fallback이 없는지 검사한다.
3. **회사 준비 v2 연결:** source session의 두 pass, 기존 safe-view, 새 계획/전용 보관과 부모 supervisor를 연결한다. 구형 계약과 테스트 결과가 달라지지 않는지 회귀를 수행한다.
4. **원본 읽기 전용 적용:** 합성 검증을 마친 구체 구현·profile과 회사에 이미 확인된 범위를 대조한 후 지정된 원본/질문으로 새 준비를 실행한다. 구현 전 회사 pack을 추가로 읽거나 지원 성공을 추정하지 않는다.

필수 수용 기준은 다음과 같다. 아래는 **미실행 테스트 명세**이며 기존 4-C-16의 통과 결과를 대신 쓰지 않는다.

| ID | 확인할 내용 |
| --- | --- |
| R1 | 정책·버전/profile 미확정/위조 시 대상 metadata 접근 0. v1 입력·hash·실패 판정과 수집 profile 보존, 자동 fallback 0 |
| R2 | 8MiB/4,096객체를 넘고 새 후보 상한 안인 유효 합성 pack에서 같은 선택 객체/근거 도출. pack 전체가 읽히지 않으며 두 pass의 실제 구간과 예약/반환량 일치 |
| R3 | index checksum·fanout·OID 순서/중복·offset 중복/범위·개수·길이·미지원64-bit·pack header/trailer 불일치, loose header/길이/파일명 OID·zlib 소비량 불일치 거부 |
| R4 | 선택 span CRC·OID·zlib 소비량·type/길이·cutoff 변조 거부. 미조회 span 손상은 전체 pack 검증 성공으로 표시하지 않고 선택 영역 검증의 한계를 드러내는 대조 사례 포함 |
| R5 | 정상 OFS/REF chain, base/결과 OID 위조, 외부 base·cycle·copy 범위·폭탄·깊이/해제량 초과 거부. 비선택 base 본문이 로그/DB/근거에 남지 않음 |
| R6 | 모든 예산의 경계/경계+1, 짧은 read/실패 차감, collect와 final guard의 계수 공유, cache hit 뒤 final reread, 개별 상한 안이어도 합계 초과 거부 |
| R7 | HEAD/ref/index/선택 원문·안전 view와 FD/경로/부모·pack/index 목록의 변경, rename·symlink/hardlink·동시 repack 거부. 성공 전후 합성 원본 파일/Git 동일 |
| R8 | guard 이전 실패의 계획/payload 0, commit 전후·결과 전달 전 종료 경쟁의 `unknown` 처리와 같은 ID 상태 확인, 자동 재실행 0 및 자원 정리. 관리 버퍼 한도와 old-space 설정, RSS 측정 목표·종료 지연 관찰을 각각 기록 |
| R9 | runtime 밖 쓰기·추가 child·네트워크·인증 환경/키체인/명시적 인증파일 접근·login/refresh/native/model 호출 0. Git 의존 객체의 내장 민감값 부수 접근과 구분. inspect는 집계만 반환하고 raw pack/tree/base 디스크 보관 0 |
| R10 | 기존 lint/typecheck/회사 집중/전체 회귀 통과. 설치된 pnpm 유지. 미지원 형식과 미조회 전체 pack 보증 부재를 결과/문서에 표시 |

지원 판단은 후보값 아래에서 합성 테스트를 실제 실행한 뒤 내려야 한다. 한도나 보증 범위 변경이 필요하면 실패 근거와 변경안을 먼저 기록하고 profile 버전을 갱신한다. 숫자만 높여 기존 계획을 통과시키지 않는다.

## 8. 이번 설계의 검증 상태

기준은 하네스의 현재 판독기·회사 준비 service/정책·설치된 `isomorphic-git` 1.44.12 구현이다. 독립 기술/경계 검토에서 지적한 loose 객체 검증, 저장 직후 결과 유실의 `unknown` 처리와 의존 객체의 민감값 접근 범위를 반영했다. 문서 정합성·로컬 파일 링크·변경 범위/코드 보존 확인을 수행하며, 결과와 상세 기록은 허용된 비공개 로컬 위치에 보관한다.

판독기 구현·성능 측정·lint/typecheck/테스트 재실행·회사 적용은 `not_run`이다. 문서만 변경했으므로 이전 회귀를 반복 실행하거나 새 설계의 통과 결과로 인용하지 않는다. 다음 최소 구현은 고정 합성 바이트를 사용하는 순수 codec·공유 예산·새 proof/profile 검증이며 실제 회사 접근은 포함하지 않는다.
