# 단계 4-C-17 2차: 합성 저장소의 Git 구간 읽기

2026-11-17. [1차 codec](stage-4c17-codec-result.md)을 실제 위치 지정 파일 읽기와 연결했다. 테스트가 새로 만든 합성 저장소만 사용했으며 회사 레포·회사 자료·실제 인증·native Codex·실제 모델·외부 서비스에는 접근하지 않았다. 전체 설계와 한도는 [Git 선택 읽기 설계](company-git-range-reader-design.md)를 따른다.

## 변경 범위

- `src/policy/company-git-range-payload.ts`: commit의 root tree, tree 항목과 작업 index v2/v3 해석. 선택 파일의 정확한 OID/mode·stage를 대조한다.
- `src/adapters/company-git-range-files.ts`: 64KiB 이하 위치 지정 읽기, 실제 I/O 예산, 경로/FD/부모 identity, 파일 부재와 pack 목록 관찰, 읽기 구간 hash.
- `src/adapters/company-git-range-source.ts`: 입력 snapshot, HEAD/ref 확인, index와 선택 객체·같은 pack의 delta base 읽기, 선택 작업 파일 대조, inspect→verify의 새 읽기와 proof 비교.
- `tests/company-readonly-git-range-fixture.ts`: 기존 저장소를 입력받지 않고 독립 합성 객체로 OFS/REF pack 또는 loose 저장소를 생성한다. 설치된 Git 라이브러리로 fixture의 객체 집합·내용과 checksum을 별도로 확인한다.
- 신규 테스트 파일 3개에 parser 12개·파일 판독기 18개·source 흐름 11개, 총 41개를 추가했다.
- 기존 object codec에는 발급된 객체/lease만 받는 delta 적용 함수를 추가했다. 기존 pack header의 magic은 상위 비트를 제거하는 ASCII 변환 대신 정확한 바이트로 비교하도록 고쳤고 회귀를 보완했다. 새 working index parser도 정확한 magic을 확인한다.
- README·구조·보안·설계·구현 계획·인수인계와 결과 문서에 현재 구현 및 남은 연결을 기록했다.

기존 회사/개인 v1의 adapter·application·CLI·입력 형식·수집 profile/hash·한도·의존성·lockfile은 유지한다. `company-git-range-source-v1`은 내부 입력 형식이며 회사 등록 v2나 승인 확인 기능이 아니다. 기존 명령에서 이 판독기를 선택하거나 실패 시 자동 전환하는 경로는 없다.

## 실제 합성 읽기에서 확인한 결과

| 영역 | 검증 범위 |
| --- | --- |
| Git 내용 | commit 필수 항목·tree 정렬/이름/유형·작업 index checksum/구조/선택 stage·OID/mode, 정상 OFS/REF와 loose 객체, local/packed branch ref |
| 선택 읽기 | 8MiB·4,096객체를 넘는 유효 pack에서 전체 pack 읽기 없이 선택 파일과 필요한 과거 delta base를 검증 |
| 두 pass | cache 재사용 없이 처음과 마지막에 새로 읽고 같은 content/metadata proof를 대조. 실제 반복 읽기·해제·복원량은 한 요청에서 합산 |
| 경로와 변경 | symlink·hardlink·비정규 파일, 부모 권한/identity, 파일 교체·pack 목록/부재 변화, HEAD/index/선택 원문/실행 비트 변화 거부 |
| 자원과 실패 | 짧은 read·read 실패의 예약량 유지, deadline 공유, 호출/메모리/FD 상한, 고정 오류, 정상·일반 실패 시 자원 해제, close 불확정은 계수 유지·자동 재시도 없음 |
| 관찰 보존 | 정상 실행 전후 합성 Git/작업 파일 hash·metadata 동일. 공격 테스트의 의도적인 변조와 구분. 성공 반환에 raw source/commit/tree/base 본문 없음 |

회사 집중 검사 3차의 큰 fixture 관찰값이다. 새로 만든 로컬 fixture의 단발 실행이며 실제 회사 저장소 성능이나 차가운 디스크 캐시 환경을 보증하지 않는다.

| 측정 | 값 |
| --- | ---: |
| pack 물리 크기 / 객체 수 | 9,071,475바이트 / 4,106개 |
| index 전체 크기 | 116,040바이트 |
| pass당 pack proof의 중복 제거 구간 합 | 453바이트 |
| 두 pass 요청 전체 실제/예약 읽기량 | 233,778바이트 |
| 읽기 API / metadata API 호출 | 30회 / 2,526회 |
| 방문 객체 / 압축 해제 | 6개 / 14회 |
| 최고 관리 buffer 계수 | 281,096바이트 |
| 실제 단조 시각 경과 | 약 19.5ms |

453바이트는 pack 구간 proof에서 동일 구간을 중복 제거한 합계다. index·HEAD/ref·작업 파일과 반복 읽기는 별도이며, 요청 전체 읽기량 233,778바이트에는 재검증과 반복 읽기가 모두 포함된다. 관리 buffer 계수는 프로세스 RSS가 아니다.

## 검증 기록

설치된 pnpm 12.16.1과 Node 26.12.1을 사용했다. 버전 고정·전환·설치·다운로드 없이 비어 있는 도구 설정과 최소 환경을 사용했다. native opt-in과 실제 인증 환경은 상속하지 않았다. 전체 합성 회귀의 허용된 loopback 모의 서버와 Node 자식 프로세스는 실제 외부 서비스나 native Codex 실행과 구분한다. 실행 인자·원시 로그·hash·집계는 소유자 전용 로컬 위치에 보관한다.

| 검사 | 결과 |
| --- | --- |
| lint·typecheck·빌드 | passed — 빌드는 회사 집중/전체 검사에 포함 |
| 회사 집중 검사 | 131 passed, 0 failed, 0 skipped — 신규 41개 포함 |
| 전체 회귀 | 1,389 passed, 0 failed, 36 skipped, 총 1,425 |
| 기존 파일 보존 | passed — 362파일 중 의도한 codec/index 회귀 3파일 외 359파일 hash 동일 |
| 최종 검증 중 코드 보존 | passed — 신규 7파일 포함 369파일 hash 동일 |
| 문서 링크·공백 | passed — 변경 문서 8개의 로컬 링크 238개 확인 |
| 회사 자료·실제 인증·native Codex·실제 모델·외부 서비스 | not_run — 이번 범위에서 제외 |

초기 typecheck의 타입 오류를 수정했다. 첫 회사 집중 검사는 권한 변조 테스트가 fixture의 디렉터리 실행 권한을 복구하지 않아 정리 hook에서 실패했다. 테스트를 수정했고, 그 실행에서 생성된 잔재만 권한 복구 후 제거했다. 원시 실패 기록은 보존한다. 독립 검토에서 발견한 시각 조회 예외의 원문 노출, 금지 경로 오류 분류, close 성공 미확인 계수와 ASCII magic 문제도 수정하고 검증했다. 전체 회귀의 36개 skip은 명시적 native opt-in을 요구하는 기존 검사다.

## 한계와 다음 작업

관찰은 단일 OS 사용자와 신뢰하는 하네스 코드에서 동작하며 여러 파일의 원자적 snapshot을 만들지 않는다. 닫힌 FD를 계속 감시하거나 최종 관찰 후 변경을 막았다고 표시하지 않는다. 전체 pack checksum·미조회 객체는 계속 `not_checked`이며 OID 검증은 작성자·서명·회사 출처 인증이 아니다. commit/tree는 엄격한 UTF-8 및 지원 형식만 처리하고 미지원 표현은 거부한다.

실제 단조 시각을 I/O·codec·pass 경계에서 검사하지만 동기 작업을 선점하지 않는다. close 오류로 닫힘을 확정할 수 없으면 FD 계수를 유지한 채 실패하며 같은 FD 번호를 자동으로 다시 닫지 않는다. 후속 worker supervisor의 종료 확인이 필요하다. 강제 30초 종료·128MiB old-space·256MiB RSS 측정 목표는 아직 연결·검증하지 않았다.

다음 최소 작업은 회사 정책 gate와 별도 등록/준비 v2에 이 판독기를 연결하고, 두 pass 사이에 기존 safe-view 수집을 넣는 것이다. 새 계획/proof와 전용 로컬 보관, CLI, 부모 supervisor, 저장 직후 결과 유실의 `unknown` 처리를 함께 검증해야 회사 원본에서 새 읽기 경로를 사용할 수 있다. 기존 회사 승인 범위와 대조할 때는 이미 확인된 사항을 재질문하지 않고 새 의존 객체 접근 등 추가·미확인 범위만 확인한다. 실제 전송·모델 호출·대상 코드 수정은 이 준비 기능의 범위에 포함되지 않는다.
