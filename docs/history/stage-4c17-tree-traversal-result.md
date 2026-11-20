# 공통 Git tree 경로 순회 개선 결과

2026-11-17. 회사 준비 v3의 metadata 한도 실패 후, 회사 자료를 다시 읽지 않고 독립 합성 저장소에서 원인을 조사했다. 여러 선택 파일이 공통 상위 tree를 파일마다 다시 읽던 흐름을 경로별로 묶었다. 구현 변경은 `src/adapters/company-git-range-unit-source.ts` 하나이며 기존 회사 v1/v2, reader-v1, unit Files, profile/guard/budget/proof, CLI/DB·의존성/lockfile은 변경하지 않았다.

## 변경과 검사 의미

각 pass에서 최대8개 선택 파일·경로 깊이16의 prefix를 묶어 처리한다. 한 tree를 consume하는 동안 요청한 자식 이름마다 기존 `findCompanyGitTreeEntry`가 전체 tree를 검사하고 작은 OID/mode 정보만 반환한다. tree 본문과 codec 복사본을 모두 해제한 뒤 다음 tree로 내려간다. 전체 tree를 저장하거나 body/parsed-tree cache로 재사용하지 않는다. 서로 다른 pathname prefix가 같은 OID를 가리켜도 각각 읽는다.

blob과 작업 파일은 원래 정렬된 선택 경로 순서로 처리한다. 실행 비트·원문 비교·working index·최종 파일/부모/부재/pack 목록 guard·두 pass의 새 읽기와 proof/safe-view 대조·실패 정리는 유지한다. 각 실제 read unit의 open-before/open-after/unit-before/unit-after/pass-final과 chunk leaf/FD 검사는 기존 Files가 수행한다. 반복 I/O 자체가 줄어드는 만큼 syscall 순서와 일시적 변경을 우연히 관찰할 기회까지 동일하다고 주장하지 않는다. 연속적 경로 동일성·원자적 snapshot·단위 내부 일시적 조상 변경 탐지는 여전히 보증하지 않는다.

고정 profile hash `6d222ffbf013f3f96eb18c72e62df6774b53027de6b05e07fd4d5bd7270d7a6a`와 guard hash `53b83bf31d858132ff3e732ef705ba6b5a9431e35f2aed74c7807287de6e6f13`는 동일하다. metadata8192회·전체읽기64MiB·pass32MiB·관리buffer32MiB·cache8MiB·inflate16MiB·FD32·기한30초/유예250ms 등 수치 한도도 그대로다. 실제 적은 I/O 계수에 따라 새 준비의 budgetHash/planHash는 달라질 수 있으며 기존 저장 계획을 수정하지 않는다.

## 독립 합성 비교

회사 경로·본문·객체 ID·질문을 fixture에 사용하지 않았다. 공유 가능한 규모 집계만 참고해 pack/index4쌍·92,000객체·8선택파일·7tree·선택 의존22객체·delta 깊이7을 독립 인코딩했다. CRC/pack/index/working index는 production codec으로 생성하지 않았고, 선택 chain/tree22개와 pack별 padding8개를 isomorphic-git으로 대조했다. index 합계는2,580,288바이트다.

기준 커밋 `9ab75f8`의 컴파일된 source를 로컬 비교용으로 보존했고 상대 import 위치만 변경 없는 같은 하네스 모듈로 연결했다. **각 비교 쌍은 같은 합성 저장소와 같은 절대 경로 깊이**를 사용했다. 실제 filesystem API 관찰 합계가 budget.metadataCalls와 일치함도 확인했다. 원문·메타데이터 전후 상태는 동일했다.

| 사례 | 변경 전 | 개선 후 | 비교 범위 |
| --- | --- | --- | --- |
| 작은 합성 사례, 두 쪽 모두 완료 | metadata2558·read28·inflate14 | metadata2436·read26·inflate12 | 최종 observation/근거 hash 동일, 두 pass 완료 |
| 4-pack/8파일, root 절대깊이4 | metadata8192에서 verify/git_object 실패, 완료pass1 | metadata7128·완료pass2 | 최초 observation/근거 hash 동일; 구형 전체 성공 비용은 미측정 |
| 같은 규모, root 절대깊이6 | metadata8192에서 verify/git_object 실패 | metadata8192에서 verify/final_guard 실패 | 양쪽 실패 보존; 깊이가 다른 성공과 직접 성능 비교하지 않음 |

깊이4의 개선 후 전체는 read160회·5,165,246바이트·inflate44회·방문22객체·delta peak깊이7·관리buffer peak3,961,360바이트·FD peak5개였다. 실제 v3 CLI→제한 worker→DB 저장→같은 ID 조회가 `AWAITING_APPROVAL`로 완료됐고 진단은 completed/failure:null, 캐시 사용0이었다. 회사 집중 검사에서 worker RSS peak는140,197,888바이트였으며 V8 old-space128MiB와 별개인 관찰값이다. OS RSS 강제 상한은 아니다.

fixture는 POSIX `/tmp`의 정규 경로 아래에 새 소유자 전용 임시 폴더를 만든다. runner의 중첩 TMPDIR 때문에 경로 깊이가 달라지는 것을 피하며, 위 측정은 macOS의 root 절대깊이4에 해당한다. Linux에서는 기본 깊이3이다. 별도 회귀는 추가depth3(Mac7/Linux6)에서 기존8192 한도에 도달하면 원문/부분 결과 없이 거절하고 자원을 정리하는지 확인한다. 모든 크기·깊이 조합의 성공이나 실제 회사 레포 성공을 보증하지 않는다.

## 검증

| 검사 | 상태 | 결과 |
| --- | --- | --- |
| lint | passed | 오류0 |
| build | passed | 오류0 |
| typecheck | passed | 오류0 |
| 회사 집중 회귀 | passed | 444개·실패0·skip0 |
| 전체 회귀 | passed | 1738개 중1702 passed·실패0·native opt-in36 skipped |

설치된 Node26.12.1과 현재 pnpm12.16.1을 최소 환경·빈 인증 설정·오프라인 옵션으로 사용했다. 설치·버전 전환·의존성 변경은 없다.

신규 테스트는 공통 tree 실제 open 횟수1회/pass, 부모 본문 lease의 하위 진입 전 해제, 다른 prefix의 동일 OID 독립 읽기, slash/dot 정렬, 파일/디렉터리 충돌·누락·symlink/gitlink/디렉터리 leaf·잘못된 뒤쪽 tree entry 거절, blob 처리 중 기존 tree 변경의 최종 거절을 포함한다. 대형 사례의 end-to-end 성공과 더 깊은 사례의 한도 거절도 포함한다. full 회귀의 loopback은 로컬 합성 broker만 사용하며 native opt-in은 활성화하지 않는다.

상세 baseline·비교 계수·로그·전후 hash는 허용된 비공개 로컬 위치에 보관한다. 회사 자료/기존 등록 재접근, 실제 회사 준비 재시도, 실제 인증/native Codex/모델/Slack·외부 전송은 모두 `not_run`이다. 다음 최소 작업은 이 개선으로 기존 허용 범위의 회사 준비를 별도 명시적 1회 검증하는 것이다.
