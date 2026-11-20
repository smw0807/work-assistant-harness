# 단계 4-C-17 1차: 메모리 기반 Git 검증과 공통 예산

2026-11-16. [회사 Git 선택 읽기 설계](../design/company-git-range-reader-design.md)의 첫 구현으로, 합성 바이트만 처리하는 핵심 모듈과 테스트를 추가했다. 원본 레포를 복사하지 않고 직접 조사하는 후속 경로를 준비하는 작업이며 실제 파일 판독기나 회사 조사 성공을 뜻하지 않는다.

## 변경 범위

- `src/domain/company-git-range.ts`: 새 profile·예산 snapshot·소유권 token 타입.
- `src/policy/company-git-range-budget.ts`: 두 pass가 공유하는 자원 예약·차감, 실패 후 중단과 소유권 해제.
- `src/policy/company-git-range-index.ts`: index v2 전체 검증, 숫자 offset 기준 선택 span 조회, pack header/trailer 정합성.
- `src/policy/company-git-range-object-codec.ts`: packed/loose 객체, 정확한 압축 stream 끝, CRC/OID, 같은 pack의 OFS/REF delta 복원.
- `src/policy/company-git-range-proof.ts`: 선택 객체·의존 관계·무결성 범위를 기록하는 metadata proof의 엄격한 parser와 hash.
- `tests/company-readonly-git-range-*.test.ts` 5개 파일: 순수 예산·index·객체·proof 및 교차 모듈 테스트 총 44개.
- README·구조·보안·구현 계획·인수인계·설계에 구현된 부분과 후속 범위를 구분했다.

기존 소스·계약·한도·설정·의존성·lockfile·실행 스크립트는 변경하지 않았다. 새 모듈은 기존 source port나 CLI에서 호출되지 않는다. 기존 v1 실패 시 자동 전환하지 않는다.

## 합성 검증 범위

| 영역 | 확인한 조건 |
| --- | --- |
| 공통 예산 | inspect/verify 순서, 합산 읽기·해제·복원량, 호출·객체·의존 깊이, 관리 buffer·cache·FD 한도, 만료와 실패 이후 재개 거부, 위조/중복 token과 view 소유권 |
| index | 전체 checksum·fanout·OID 정렬·CRC·숫자 offset, 최대 131,072객체, pass당 합계 262,144객체, 동일 바이트 후보도 parse마다 별도 계수, 비허용 offset·span·header/trailer 거부 |
| 객체 | 일반 Git 객체 framing과 OID, loose header, 정확한 zlib EOF, 압축 폭탄·변조·SharedArrayBuffer·resizable buffer·접근자/위조 객체 거부 |
| delta | 같은 pack의 OFS/REF, 누락 base·cycle·깊이 초과·잘못된 copy/insert·결과 OID 거부, 복원 출력 차감, 실패 시 임시 소유권 해제 |
| proof | 중복 JSON key·추가 필드·hash/범위/의존 관계 변조 거부, profile 고정과 `not_checked` 보존 |
| 통합 | 메모리에서 생성한 pack/index의 선택 객체를 두 pass에서 새로 해제하여 같은 content proof를 만들고 누적 예산이 증가함을 확인. 미조회 span을 손상시켜 전체 pack checksum이 달라도 선택 검증만 통과하는 한계를 명시적으로 확인 |

독립 코드 검토에서 발견한 공개 decoder의 객체 수 누락, 동일 내용 index 후보의 합계 누락, 빈 객체 실패 시 1바이트 해제 예약 불일치를 수정하고 회귀 테스트를 추가했다. 재검토에서 새 중대 결함은 발견되지 않았다.

## 검증 기록

설치된 pnpm 12.16.1과 Node 26.12.1을 사용했다. 버전 고정·전환·설치·다운로드 없이 비어 있는 도구 설정과 최소 환경으로 실행했으며 실제 인증 환경이나 native opt-in을 상속하지 않았다. 원시 로그·실행 인자·hash와 집계는 허용된 소유자 전용 로컬 위치에 보관한다.

| 검사 | 결과 |
| --- | --- |
| lint | passed |
| typecheck | passed |
| 빌드 | passed — 회사 집중/전체 검사에 포함 |
| 회사 집중 검사 | 90 passed, 0 failed, 0 skipped — 신규 44개 포함 |
| 전체 회귀 | 1,348 passed, 0 failed, 36 skipped, 총 1,384 |
| 기존 파일 보존 | passed — 기존 소스·테스트·설정·의존성 352파일 hash 동일 |
| 최종 검증 중 소스 보존 | passed — 신규 10파일 포함 362파일 hash 동일 |
| 문서 로컬 링크·diff 공백 | passed — 변경 문서 7개의 로컬 링크 227개 확인 |
| 회사 자료·실제 인증·native Codex·실제 모델·외부 서비스 | not_run — 이번 구현에서 제외 |

초기 lint/typecheck에서 발견한 타입 선언·미사용 변수·정규식 lint 문제는 수정했다. 전체 회귀의 첫 실행은 샌드박스에서 loopback 모의 서버를 열지 못해 33개가 실패했고, 허용된 동일 최소 환경의 재실행에서는 모두 통과했다. 실패한 시도의 로그도 로컬에 보존한다. 36개 skip은 기존 native opt-in 검사이며 이번 범위에서 실행하지 않았다.

새 44개 테스트는 메모리 기반이며 파일 시스템이나 Git 명령을 사용하지 않는다. 기존 전체 합성 회귀의 임시 fixture·loopback 모의 서버·Node 자식 프로세스 실행과 구분한다.

## 보증하지 않는 범위와 다음 작업

현재 budget은 논리 계수다. 호출자가 단조 시간, I/O, 메모리 할당과 cache 분류를 올바르게 등록해야 한다. 전달된 입력의 기존 할당과 등록되지 않은 JavaScript/native 내부 메모리를 통제하지 않으며 32MiB 관리 buffer 한도가 프로세스 RSS 한도인 것은 아니다. 출력이나 view를 보유하는 동안 lease를 유지해야 한다. 실제 30초 supervisor, 128MiB old-space 설정, 256MiB RSS 측정 목표는 아직 연결·검증하지 않았다.

Byte proof는 metadata 정합성 검사다. 실제 파일 관찰·회사 승인·출처를 인증하지 않으며 전체 pack checksum과 미조회 객체는 `not_checked`다. 내용 proofHash와 누적 예산 snapshot은 분리돼 있고, 향후 repository proof가 파일 identity·관찰값·예산을 함께 결합해야 한다. 같은 OID 검증도 작성자 진위나 회사 출처의 인증은 아니다.

이 1차 결과 시점의 후속 범위는 commit/tree payload·working index 해석과 합성 positioned reader·경로/FD/부모 guard·최종 재검증이었다. 해당 작업의 이후 구현·검증은 [2차 결과](stage-4c17-reader-result.md)를 따른다. 부모 supervisor와 별도 등록/준비 v2·DB·CLI 연결은 계속 남아 있다. 기존 회사 입력에 새 profile을 사용할 수 없으며 실제 회사 적용 시점은 후속 통합 검증 이후다. 설계의 전체 수용 조건 R1~R10을 이번 순수 모듈 테스트로 충족했다고 표시하지 않는다.
