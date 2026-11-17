# 4-C-17 읽기 단위 계약의 합성 구현 결과

2026-11-17. [읽기 단위 설계](company-git-range-read-unit-design.md)의 A를 별도 내부 판독기로 구현했다. 기존 회사 준비 v2는 기존 reader-v1을 계속 사용한다. **회사 기능 전환이나 실제 회사 준비 성공을 뜻하지 않는다.**

## 구현과 경계

- `company-git-range-unit` domain/policy: 불변 guard 정책·reader-v2 profile, 기존과 동일한 수치 상한, 독립 budget/lease/실패 identity와 byte-proof-v2. 새 profile과 guard hash를 요청·관찰·budget·byte proof에 결합한다.
- `company-git-range-unit-files`: 고정 단위 종류/범위를 확인한 뒤 열린 FD로64KiB 이하 chunk를 읽는다. 전체 경로는 열기·단위 전후·pass 최종, leaf/FD는 각 chunk 전후 검사한다. 단위 결과 buffer와 chunk를 동시에 예약하며, 끝 guard가 성공한 뒤에만 본문과 chunk proof를 전달한다. 빈 파일의0바이트 read, pack 목록·부재/alternate store·최종 guard·불확정 close 처리는 유지한다.
- `company-git-range-unit-source`: 전체 Git/index/선택 파일, 검증한 pack 객체 span,12바이트 header와20바이트 trailer를 단위로 연결한다. 같은 pack 안의 delta base, 선택 코드/실행 비트/작업 index 대조, 두 pass의 새 읽기와 proof·safe-view 비교를 포함한다. metadata 전용 API에는 원문이 없고 collection API에는 고정 안전 발췌와 검증 metadata만 반환한다.
- 기존 index/object/payload codec 세 파일은 public budget 연산을 받는 TypeScript 타입만 변경했다. 해석·CRC/OID·메모리 예약·소유권 로직은 그대로다. 버전별 budget/files/source/proof는 독립적으로 두었으므로 이후 공통 오류 수정 시 양쪽 회귀를 함께 검사해야 한다.

기존 source/files/budget/proof, 회사 등록/정책/CLI/DB/worker, 수집 profile, 숫자 한도, 설정/의존성/lockfile은 유지한다. README와 구조·보안 문서는 회사 준비 버전과 판독 계약 버전을 구분하도록 갱신했다. 내부 새 source는 회사 승인 gate나 OS 읽기 격리가 아니며 합성 테스트에서만 호출했다. 새 회사 준비 v3 명령·보관·supervisor 경로는 없다.

고정한 새 reader profile hash는 `6d222ffbf013f3f96eb18c72e62df6774b53027de6b05e07fd4d5bd7270d7a6a`, guard hash는 `53b83bf31d858132ff3e732ef705ba6b5a9431e35f2aed74c7807287de6e6f13`다. 기존 reader-v1 hash `8fc98736b72781db4567c808f6dca086b8b9ec1a4f97eb5e551d8ee0c3f210b6`은 보존한다.

## 계약 차이와 검증 범위

단위 내부의 일시적인 조상 symlink/권한 변경이 복원되면 새 방식이 놓칠 수 있다. 합성 반례에서 기존 reader-v1의 거부와 새 방식의 통과를 분리해 확인한다. 원자적 snapshot·연속 경로 보존·전체 pack checksum·미조회 객체·회사 출처 인증을 보증하지 않는다. `packChecksum`과 `unvisitedObjects`는 계속 `not_checked`다.

| 설계 항목 | 이번 구현/검증 범위 |
| --- | --- |
| U1 계약 분리 | 기존 hash/limits 회귀, 새 profile·guard hash, v1/v2 요청·proof 양방향 혼용 거부, 외래 budget/lease/error 거부, 기존 회사 등록의 새 hash 거부 |
| U2 실제 계수 | 단위별 실제 FS API/read 호출·바이트와 budget 대조, 전체 source의 두 pass 및 합성 대형 index 비교; OS syscall/속도 배수로 해석하지 않음 |
| U3 지속적 변경 | 부모/파일 교체·symlink/hardlink·권한·내용·크기와 최종 목록/부재 변경 거부, 실패한 단위 결과/proof 미전달. FD 소유자 불일치는 합성 fstat 반환값으로 검증하며 실제 chown은 하지 않음 |
| U4 관찰 차이 | 일시적 조상 symlink/권한 변경 후 복원 반례를 유지 |
| U5 실패/정리 | short read·원래 기한·한도·최초 실패·미확정 close 계수·부분 결과/원문 미반환 |
| U6 전체 해석 | OFS/REF/loose, commit/tree/작업 index, HEAD/ref, 같은 pack base, pack inventory/부재/final guard, 원문·safe-view의 두 pass 대조 |
| U7 자원 경계 | 개별 단위 상한, 전체 단위+chunk 동시 예약,64KiB 선택 파일8개의 수집/재검증과9번째 파일의 접근 전 거부,32MiB 관리 buffer/FD32/공유64MiB 읽기/8192 metadata/깊이32/해제16MiB 등 기존 한도 및 일부 조합 거부. 모든 최대값의 동시 성공이나 OS RSS 상한은 주장하지 않음 |
| U8 회사 준비 연결 | not_run — 새 정책 gate·등록/계획·전용 DB·unknown/같은 ID 조회·제한 worker/supervisor는 다음 단계 |

새 진단은 내부 `company-git-range-failure-v2` 오류 identity로만 제공한다. 기존 CLI stderr 진단 frame/보관 parser는 이 형식을 받아들이지 않으며 새 외부 진단 보관 경로는 아직 없다.

## 실측과 검사

독립 encoder로90000개 객체의 합성 pack3960054바이트와 index2521072바이트를 한 번 만들었다. 별도 라이브러리로 선택 객체와 멀리 떨어진 추가 객체7개를 읽어 대조했다. 모든 객체의 독립 감사라고 주장하지 않는다. 초기화·부재·최종 검사 일부를 제외했던 이전 test-only 실험과 달리 이번 source 비교는 전체 reader 경로를 실행했다.

| 동일 합성 범위의 두 pass | 기존 reader-v1 | 새 reader-v2 |
| --- | ---: | ---: |
| 기본 경로 metadata | 5526 | 2566 |
| 완료 pass | 2 | 2 |
| 실제 읽기 호출 | 96 | 96 |
| 읽기 예약/반환 바이트 | 5043094 | 5043094 |
| 압축 해제 횟수 / 방문 객체 | 8 / 4 | 8 / 4 |
| 관리 buffer 최고 / 열린 FD 최고 | 5762144 / 2 | 5762144 / 2 |

선택 내용/hash, 실제 읽은 구간과 FS 관찰, 객체/codec 계수는 같고 새 profile·byte proof·최상위 proof hash는 구분된다. 회사 자료나 실제 작업의 성공을 예측한 수치는 아니다.

같은 합성 fixture만 경로6단계 아래로 이동한 경우 기존 reader는 두 번째 pass 중metadata8192회에서 거부됐고 완료pass는1이었다. 새 reader의 고정 safe-view 수집은metadata3862회로2pass를 완료했다. 양쪽의 읽기96회/5043094바이트는 같았지만 기존 검증은 완료되지 않았다. 부분 실행과 완료 실행의 총량으로 속도 배수나 검증 동등성을 주장하지 않는다. 별도의4106객체·9071475바이트 pack 검사에서도 필요한 span만 읽고 전체 pack 읽기는 하지 않았다.

| 검사 | 결과 |
| --- | --- |
| pnpm lint / pnpm typecheck | passed |
| pnpm test:company | passed — 308개, 실패·미실행0; 이번 신규49개 포함 |
| 전체 회귀 (TypeScript 빌드 포함) | passed — 전체1602개 중1566개 통과, 실패0, native opt-in 필요36개 미실행 |
| 실제 회사 자료·인증·native Codex·실제 모델·외부 서비스 | not_run — 이번 범위에서 제외 |

초기 통합 중 fixture 변수의 Buffer 추론 오류와 불필요 초기 할당 lint3건을 수정한 뒤 다시 검사했다. 독립 검토에서는 `.pack`/`.idx`로 끝나는 브랜치 ref의 오분류를 수정하고 회귀 검사를 추가했다. 전체 회귀의 최초 샌드박스 실행에서는 기존 loopback broker 테스트33개가 실패했다. 같은 최소 환경과 native opt-in 없는 조건으로 실행 승인을 받아 재검사한 결과 모두 통과했다. 마지막 전체 회귀에는 경로6단계 실험과 최종 수정까지 포함된다.

현재 설치된 pnpm12.16.1/Node26.12.1을 사용하고 버전을 고정·전환하거나 설치하지 않았다. 인증 설정을 비운 최소 환경과 새 비공개 로컬 위치에 검사 로그·실측·보존 hash를 남긴다. 상세 자료는 디렉터리0700/파일0600, 공유 요약은 합성 집계로 제한한다. 이전 미커밋 변경은 보존하며 자동 커밋하지 않는다.

## 다음 최소 작업

새 판독 계약을 선택하는 회사 준비 v3의 정책 gate·등록/계획·전용 보관과 제한 worker/supervisor를 합성 환경에 연결한다. 기존 회사 준비 v2를 자동 전환하거나 승인·DB를 재사용하지 않는다. 실제 회사 자료 적용과 변경된 관찰 의미의 채택은 그 연결 검증 이후 별도로 범위를 정한다.
