# 회사 Git 읽기 단위 검사와 별도 실행 방식 비교 설계

2026-11-17. **권고안은 A: 기존 Node worker 안에서 읽기 단위의 경계를 명시한 새 판독 계약을 구현·검증하는 것이다.** 기존 판독기와 같은 검증 강도라고 주장하지 않는다. B의 별도 OS helper는 실행 권한과 배포·격리·정리 체계까지 추가해야 하므로 이번 구현 우선순위에서 제외한다.

이 문서는 비교 당시의 설계안이다. 그때의 결과물은 test-only 합성 실험과 [설계 검증 결과](stage-4c17-read-unit-design-result.md)다. 이후 새 profile·내부 판독기·proof의 합성 구현은 [읽기 단위 구현 결과](stage-4c17-read-unit-result.md)에서 구분한다. 이후 회사 등록·CLI·DB·worker의 U8 연결은 [회사 준비 v3 통합 결과](stage-4c17-company-v3-result.md)에 기록한다. 기존 회사 준비 v2는 계속 기존 `company-git-range-reader-v1`을 사용한다. 실제 회사 자료·인증·native Codex·모델·외부 서비스는 사용하지 않는다.

## 1. 선택지와 결정 근거

| 항목 | 현재 방식 | A: 읽기 단위 경계 검사 | B: 별도 descriptor-relative 실행기 |
| --- | --- | --- | --- |
| 부모 경로 전체 검사 | 각64KiB 이하 읽기 전후 | 열기·읽기 단위 전후·pass 최종 | OS별 경로 결합 검증을 새로 설계해야 함 |
| leaf/FD 검사 | 각 읽기 전후 | 각 읽기 전후 유지 | 별도 구현과 계수 필요 |
| 수치 상한 | 현재 고정값 | 모든 고정값 유지 | 동일 상한 목표이나 여러 프로세스 합계 강제 필요 |
| 새 실행 권한 | 없음 | 없음 | 고정 helper 실행·IPC·OS 격리와 종료 책임 추가 |
| 현재 공개 Node API | 구현됨 | 구현 가능한 조합 | 부모 FD에 상대적인 자식 open/stat API가 없음 |
| 중요한 한계 | 원자적 snapshot 아님 | 단위 내부의 일시적인 조상 변경·복원을 놓칠 수 있음 | 열린 디렉터리 FD도 원래 이름의 경로 보존을 보증하지 않음 |
| 이번 결정 | 그대로 보존 | 별도 계약으로 우선 검증 | 보류, 실제 실행/권한 추가 없음 |

현재 방식의 단순 캐시/검사 제거와 A를 혼동하지 않는다. A는 검사 간격이 달라지는 새 계약이다. 실행 권한을 늘리지 않고 효과와 위험을 합성 환경에서 검증할 수 있다는 점을 권고 근거로 삼는다. 실제 회사 준비가8192회 안에 성공할지는 이번 합성 실험만으로 확정하지 않는다.

## 2. A의 읽기 단위

읽기 단위는 고정 판독기가 정한다. 등록·CLI·환경변수가 범위나 상한을 선택하거나 늘릴 수 없다. 파일을 크게 묶거나 서로 다른 객체를 합쳐 읽지 않는다.

| 대상 | 한 읽기 단위 | 기존 상한 |
| --- | --- | --- |
| pack index | index 파일 전체 | 파일당8MiB, pass 전체8MiB 및 객체 수 제한 유지 |
| HEAD/ref/packed-refs/작업 index/loose 객체 | 해당 Git 파일 전체 | 파일당8MiB; 별도 형식/객체/출력 제한도 유지 |
| 선택 작업 파일 | 파일 전체 | 64KiB |
| pack의 선택 객체 | index가 검증한 encoded span 하나 | 2MiB |
| pack에 저장된 delta base | 각 base의 encoded span 하나 | 2MiB 및 깊이/해제/누적 한도 유지 |
| pack header / trailer | 각각12바이트 / 20바이트 | 두 개의 별도 작은 단위 |

delta base는 기존 `loadPacked`와 같이 같은 pack/index 안에서만 찾는다. loose 객체나 다른 pack으로 base를 찾는 fallback은 추가하지 않는다. 512MiB pack 전체를 읽기 단위로 취급하지 않는다. 각 단위도64KiB 이하 chunk로 읽고, 실제 read 호출 수와 예약/반환 바이트를 그대로 계수한다. 빈 파일도 기존0바이트 read·guard·proof 계수를 유지한다. 최초 pass와 최종 pass는 같은 공유 예산을 쓰고 재검증 때 새로 읽는다. 초기 읽기 단위 구현은 tree/blob/base 캐시나 공통 경로 묶음 순회를 추가하지 않았다. 후속 [공통 경로 순회 개선](stage-4c17-tree-traversal-result.md)은 같은 pathname prefix의 요청을 한 tree 읽기에서 해석하며 각 pass의 새 읽기·단위 guard를 유지한다. 작은 OID/mode metadata만 남기고 본문을 해제하므로 본문 캐시는 계속 사용하지 않는다.

## 3. 검사 순서와 결과 전달

1. 입력·정책·등록·경로 allowlist를 확인한다. 열기 전에 모든 조상의 identity·canonical path·symlink 부재와 leaf 파일 유형·소유자·단일 링크·크기를 확인한다. 파일은 기존 no-follow/nonblock 조건으로 열고 열린 FD가 관찰한 파일과 일치하는지 확인한다.
2. 단위 시작에 전체 부모/경로와 leaf/FD를 다시 검사한다. 단위 결과 버퍼를 먼저 예산에 예약한다.
3. 각 chunk 전후에 leaf `lstat`와 FD `fstat`를 확인한다. leaf/FD의 device/inode/mode/uid/gid/link/size/mtime/ctime 조건은 기존과 동일하다. read 예약은 요청 길이 전부 차감하며 short read·실패에도 환급하지 않는다. 실제 metadata API 호출을 각각 계수한다.
4. 단위 종료에 전체 부모/경로와 leaf/FD를 확인한다. 성공한 뒤에만 단위 버퍼를 신뢰하는 parser로 전달한다. 도중 실패는 부분 버퍼를 반환하거나 임시파일에 저장하지 않는다.
5. 기존 index checksum·CRC/OID·delta·작업 index/선택 원문·safe-view 검증은 유지한다. pack 목록, 관찰했던 부재 경로와 파일/부모를 pass 최종 단계에서도 확인한다. 완료되지 않은 단위의 중간 proof를 성공 증거로 사용하지 않는다.
6. 두 번째 pass도 새로 열고 같은 순서로 읽으며 관찰 proof·원문 hash·안전 view를 비교한다. 최종 guard와 정리까지 성공한 뒤에만 계획/payload를 저장한다. 종료 실패·응답 유실의 unknown과 같은 ID 조회, 자동 재시도 없음은 그대로다.

메모리는 단위 결과 버퍼·chunk·codec 복사/해제·안전 변환이 동시에 살아 있는 양을 모두 포함한다. 각 수치 상한뿐 아니라 관리 buffer32MiB/해제16MiB/FD32개/읽기 총64MiB/metadata8192회/30초·250ms 종료 정책을 유지한다. OS RSS 강제 상한이나 부모 강제 종료 후 guardian은 이 설계에 추가되지 않는다.

부모 경로 성분 수를D, 한 단위의 chunk 수를N이라 하면 read 단계의 현재 metadata API 비용은 `N × (4D + 4)`다. A가 단위 양끝에도 FD를 확인하면 `(4D + 4) + 4N`이며 open·열거·pass 최종 검사는 별도다. 큰 파일에서 줄일 여지가 있지만 한 chunk 단위에는4회가 추가된다. 경로 깊이·다른 파일·codec·전체 guard 작업을 포함한 실측 없이 전체 준비의 성공이나 속도 향상 배수를 예측하지 않는다.

## 4. 관찰 차이와 위협 모델

**A는 단위 내부의 조상 경로 상태를 연속해서 관찰하지 않는다.** 예를 들어 첫 chunk 뒤에 조상 디렉터리를 같은 원래 파일로 향하는 symlink로 바꿨다가 단위 끝 전에 복원하면, leaf와 열린 FD는 계속 일치할 수 있다. A가 이를 통과하더라도 각 chunk에서 전체 경로를 검사하는 기존 방식은 그 시점의 변경을 발견할 수 있다. 조상 권한 변경 후 복원도 같은 종류의 차이다.

지속적인 부모/leaf 교체·symlink·소유권/권한/크기 변경은 지정한 경계에서 거부해야 한다. 같은 내용의 다른 inode를 허용하지 않는다. 단위 전후 검사와 두 pass 비교는 변경 관찰을 보완하지만 단위 내부의 일시적 변경 탐지를 복원하지 않는다. 최종 hash가 같다고 이 차이를 지우지 않는다.

내용 읽기는 검증한 열린 FD로만 수행하며, 단위 중간에 경로를 다시 열어 읽거나 다른 저장소로 fallback하지 않는다. 그래도 원자적 파일시스템 snapshot, 적대적인 동시 사용자·침해된 호스트 방어, 원래 경로의 연속적 보존을 보증하지 않는다. 기존 single-user/trusted-harness 전제에 더해 이 관찰 차이를 새 계약의 검토 항목으로 명시한다.

## 5. 버전·hash·보관 분리

아래 식별자는 비교 당시 정한 설계 이름이다. 내부 profile/source/proof의 후속 구현 상태는 별도 결과 문서를 따른다. 새 회사 명령이나 등록/DB 지원을 뜻하지 않는다.

- guard 정책: `company-git-range-read-unit-guard-v1`. 단위 종류/상한, 전체 경로 검사 경계, chunk별 leaf/FD 검사, 결과 전달 시점과 일시적 조상 변경의 관찰 한계를 고정한다.
- 판독 profile: `company-git-range-reader-v2`. 기존과 같은 수치 limits 및 수집 profile hash에 새 guard 정책을 결합해 새 hash를 만든다. 숫자가 같아도 v1 hash를 재사용하지 않는다.
- 내부 요청/관찰: `company-git-range-source-v2`, `company-git-range-source-observation-v2`. byte proof와 budget snapshot도 새 profile에 결합하는 별도 검증 경로가 필요하다. 기존 byte-proof-v1 parser에 새 profile을 끼워 넣지 않는다.
- 실제 회사 기능 연결: 기존 회사 준비 v2와 분리한 등록/계획/payload/전용 DB 버전을 사용한다. 후속 U8의 확정 이름은 `company-readonly-registration-v3`, `company-readonly-preparation-v3`다. 기존 CLI·설정·작업·승인은 변환하거나 자동 fallback하지 않는다. 비교 설계 당시에는 새 명령을 추가하지 않았고, 후속 U8에서 별도 `company-readonly-v3-*` 명령을 연결한다.

향후 등록은 정확한 새 profile hash를 요구하고 계획 hash에는 guard 의미·관찰/proof·budget·safe-view·정책·보관 기간을 결합한다. 버전/profile 혼용은 대상 metadata와 DB 접근 전에 거부한다. 현재 회사의 읽기/보관 정책과 기간, private 권한, 승인/전송/실행 false를 유지한다. 새 관찰 의미를 회사 적용에 사용하기 전에는 기존 자료 접근 허용과 구분하여 적용 범위를 명시적으로 결정한다. 기존 회사 준비 승인으로 변경된 검증 의미까지 자동 승인됐다고 처리하지 않는다.

## 6. B를 보류하는 이유와 재검토 조건

B는 OS가 제공하는 descriptor-relative 기능을 고정 실행 파일로 노출하는 별도 후보이며 native Codex와는 다른 구성 요소다. 이번에는 어느 바이너리도 설치·빌드·실행하지 않는다. Node 내부 binding/FFI/addon 또는 /dev/fd 우회도 사용하지 않는다.

추후 검토한다면 상위 controller가 고정 helper를 시작하는 별도 구조가 필요하다. 기존 worker의 child 금지를 조용히 해제하지 않는다. 실행 파일 hash/소유권·최소 환경·고정 bounded IPC·no arbitrary path/command·OS별 읽기/쓰기/네트워크/하위 실행 제한·인증 경로 제외·부모 종료/timeout·전체 FD/메모리/작업 계수와 종료 확인을 함께 설계해야 한다. Node permission 모델이 외부 helper에도 적용된다고 주장하지 않는다.

`openat`류가 있어도 기존 이름의 경로가 교체되지 않았다는 보증은 별개다. 중간 symlink와 부모 경로 연결·부재·pack 목록을 검증해야 하고, helper 요청 하나를 metadata1회로 계산하면 안 된다. 새 OS operation을 각각 계수하고 기존 budget 단위와의 대응을 명시해야 한다. 이 기반 없이는 B의 성능·검증 강도·격리를 A보다 우월하다고 판정하지 않는다.

## 7. 합성 수용 기준과 구현 순서

| ID | 후속 구현의 수용 기준 |
| --- | --- |
| U1 | 기존 v1 profile/hash/계수/결과 회귀 보존, 새 버전·profile·proof·DB 혼용 거부 |
| U2 | 같은 합성 범위의 chunk·readCalls·읽기 바이트 유지, 실제 metadata API 호출과 budget 정확히 일치; 부분 baseline과 완료 후보의 속도 배수 비교 금지 |
| U3 | 단위 시작/중간/끝의 지속적 부모/파일 교체, symlink/hardlink, owner/mode/size 변경 거부; 원문/부분 결과 전달0 |
| U4 | 일시적 조상 symlink/권한 변경 후 복원 시 기존 방식과 A의 판정 차이를 명시적으로 검증 |
| U5 | short read·timeout·한도 초과·close 오류의 최초 실패·예약량·정리/불확정 FD 계수 보존 |
| U6 | 전체 index/객체 codec, pack 목록·부재 경로·final guard, 새 두 번째 pass·proof/safe-view 비교 통합 |
| U7 | 단위 버퍼/chunk/decoder 동시 메모리, 최악 허용 크기·깊이·파일 수와 공유 예산 검증; 각 한도 최대값의 동시 성공을 가정하지 않음 |
| U8 | 새 회사 준비의 정책 gate/보관/unknown/동일 ID 조회·supervisor 통합. 실제 회사 자료는 별도 명시적 적용 단계에서만 사용 |

이번 비교 실험은 guard 계층의 비용과 일부 U2~U5만 검증한다. Git parser·객체 provenance·새 profile/CLI/DB·전체 수용을 구현한 것이 아니다. 다음 구현은 **A의 새 불변 profile/guard 계약·혼용 거부와 단위 reader를 합성 환경에만 추가하는 한 묶음**으로 시작한다. 이후 U1~U7과 기존 회귀를 통과시킨 뒤 회사 준비 연결 U8을 별도 수행한다. 실제 회사 자료나 모델 호출로 합성 검증의 빈틈을 메우지 않는다.
