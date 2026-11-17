# 회사 준비 v3와 읽기 단위 판독기 통합 결과

2026-11-17. [읽기 단위 구현](stage-4c17-read-unit-result.md)의 후속 U8이다. 새 판독기를 회사용 등록·정책 확인·비공개 SQLite·CLI·제한 worker·supervisor·진단에 연결했다. 실제 회사 자료를 읽거나 기존 회사 작업을 재시도하지 않고 독립 합성 자료로 검증한다. 기존 v1/v2·수집/전송/실행 계약과 의존성·lockfile은 유지한다.

## 구현 범위

- `company-readonly-v3-plan/inspect/cancel/prune`을 기존 `pnpm harness`에 등록했다. `plan/prune`만 선택 `--diagnostics-dir`을 받는다. 새 패키지 스크립트나 pnpm 버전 고정은 없다.
- 등록은 `company-readonly-registration-v3`이며 reader profile hash와 guard policy hash를 모두 요구한다. 별도 준비 v3·worker input·summary·시작 기록·runtime binding에 결합한다. 정책은 기존 `company-readonly-policy-v1`의 읽기/보관 확인과 기간, `enabled:false`를 유지하며 미확인 정책은 등록/원본 접근 전에 거부한다.
- 최종 두 pass와 safe-view 대조, source 정리 성공 뒤에만 저장한다. 최초 reader 실패와 정리 실패가 겹쳐도 최초 실패 진단을 보존한다. 부모는 worker 시작 전 ID/시작 기록을 fsync하고 worker는 app/DB 정리 뒤에만 성공 응답을 보낸다.
- `store/company-readonly-v3.sqlite`는 별도 application ID·schema·table과 owner/runtime binding을 사용한다. 구형 DB를 새 이름으로 복사해도 거부하며 변환하지 않는다. 취소 즉시 payload 제거, 본문 최대24시간·감사 최대30일, 만료 시 inspect/prune 정리는 유지한다.
- 결과 전달/보관 실패나 종료 불확실은 `unknown`으로 남긴다. 같은 ID의 inspect로 보관 상태를 확인하고 자동 재시도하지 않는다. stdout·시작/결과 기록은 원문·경로를 포함하지 않는다.
- 선택 진단은 별도 `diagnostic-v3-<uuid>.json`에 고정 실패 분류·계수와 hash만 보관한다. failure-v2의 독립 엄격 parser를 쓰며 구형 frame/record/filename 혼용을 거부한다. audit 기한과 명시적 plan/prune 정리를 적용한다.
- 설정/보관/진단의 부모와 디렉터리 `0700`, 파일 `0600`을 요구한다. worker의 쓰기는 `store/`에만 허용하고 환경은 `LANG/TZ`만 전달한다. 네트워크·추가 자식/worker·addon·WASI·inspector와 실제 모델/인증/native 기능은 부여하지 않는다.

등록 예제와 정확한 옵션은 [README](../README.md#읽기-단위-판독기를-사용하는-회사-준비-v3)와 [합성 등록 예제](../config/company-readonly-registration-v3.example.json)를 따른다. 예제는 실행 가능한 실제 회사 등록이 아니며 새 실제 실행에 맞춰 저장소 밖 비공개 파일로 준비한다.

## 보존한 계약과 보증 경계

| 항목 | 값 |
| --- | --- |
| 기존 reader-v1 profile hash | `8fc98736b72781db4567c808f6dca086b8b9ec1a4f97eb5e551d8ee0c3f210b6` |
| 새 reader-v2 profile hash | `6d222ffbf013f3f96eb18c72e62df6774b53027de6b05e07fd4d5bd7270d7a6a` |
| 새 guard policy hash | `53b83bf31d858132ff3e732ef705ba6b5a9431e35f2aed74c7807287de6e6f13` |
| metadata / 전체 read / pass read | 8192회 / 64MiB / 32MiB |
| 관리 buffer / cache / inflate / FD | 32MiB / 8MiB / 16MiB / 32개 |
| 부모 deadline / TERM 후 KILL 유예 | 30초 / 250ms |
| V8 old-space / RSS | 128MiB / 256MiB 관찰 목표, OS RSS 강제 상한 아님 |

새 판독기는 부모 전체를 열기·단위 경계·pass 최종에 확인하고 chunk별 leaf/FD 검사는 유지한다. **단위 내부의 일시적 조상 변경 후 복원을 놓칠 수 있으므로 reader-v1과 동등하지 않다.** 이 한계는 guard 계약과 비공개 검토 입력에 포함된다. 원자적 snapshot·적대적 동시 사용자·침해된 호스트 방어를 보증하지 않는다. 두 pass의 hash 일치가 이 차이를 없애지 않는다.

worker의 파일 읽기 권한은 부모 metadata 확인을 위해 전체로 열며 실제 파일/바이트 범위는 고정 판독기가 제한한다. OS 읽기 격리로 설명하지 않는다. 종료 확인은 child close를 실제 관찰한 경우이며 부모 강제 종료에 견디는 독립 guardian은 없다. 전체 pack checksum·미방문 객체는 계속 `not_checked`다. 등록/정책 선언은 회사 정책의 진위를 인증하지 않는다.

## 검증

Node `26.12.1`과 현재 PATH의 pnpm `12.16.1`을 사용했다. 최소 환경·빈 패키지 인증 설정·오프라인 옵션을 적용했고 버전 전환·설치·다운로드는 하지 않았다. 전체와 회사 집중 검사는 각 스크립트의 `tsc` 빌드를 포함한다.

| 검사 | 상태 | 결과 |
| --- | --- | --- |
| lint | passed | 최종 소스 기준 오류0 |
| typecheck | passed | 오류0 |
| 회사 집중 회귀 | passed | 435개, 실패0, skip0 |
| 전체 회귀 | passed | 1729개 중1693 passed, 실패0, native opt-in36 skipped |
| 원본 계약 보존 | passed | 기준450파일 중442개 hash 동일; 의도한8파일만 변경 |

기준 파일의 변경8개는 README/문서6개, CLI router1개, 기존 독립 대형 fixture의 v3 통합 경로 추가1개다. 기존 v1/v2 구현·profile/hash·예산·설정·package.json·lockfile은 동일하다. 신규 v3 파일은 별도 추가한다.

초기 lint의 정리 경로 오류2건은 최초 실패를 보존하는 정리 helper로 수정했다. 첫 회사 검사419개 중2건은 유효해진 새 진단 버전과 undefined guard의 엄격 복사 단계 오류를 잘못 기대한 테스트였으며 수정 후 최종435개가 통과했다. 최초 전체 검사는 sandbox에서 기존 로컬 broker 연결33건이 거절되어1660 passed/33 failed/36 skipped였다. 이 실패는 통과로 덮어쓰지 않고 별도 로그를 보관하며 허용된 로컬 loopback 재실행에서1693 passed/0 failed/36 skipped를 확인했다.

합성 검증은 등록/정책 gate, 신규 hash/버전 및 구형 DB/worker/진단 혼용 거부, 안전 발췌·두 pass, source 전후 내용/metadata 보존, 권한/링크/경로 겹침, 취소/만료/원자성, 실패 후 동일 ID 조회, 출력 유실·진단 저장 실패, 실제 합성 child의 30초 기한과 강제 종료를 포함한다. 독립 생성한 9만 객체 index의 깊은 경로도 v3 CLI→제한 worker→전용 DB까지 검증했다.

해당 합성 index는2,521,072바이트, pack은3,960,054바이트이며 선택 경로의 객체4개와 원거리 표본을 포함한7개를 독립 라이브러리로 읽어 대조했다. 같은 깊은 경로에서 기존 reader-v1은 metadata8192회에 도달해 최종 검증을 마치지 못했고, 새 reader와 v3 CLI는 metadata3862회·두 pass를 완료해 `AWAITING_APPROVAL`로 보관했다. 전체96회 읽기·5,043,094바이트·객체 방문4개·관리 buffer peak5,762,144바이트·FD peak2개를 유지했다. 회사 집중 검사에서 v3 CLI의 RSS peak는143,556,608바이트였으며 이는 관찰값이다. 이 결과는 실제 회사 레포의 성공이나 처리 속도 배수·구형과 동등한 검증을 보증하지 않는다.

세부 로그·실행 환경 기록·전후 hash·검증 결과는 허용된 비공개 로컬 위치에 보관하고 이 문서에는 집계만 남긴다. 회사 저장소·실제 질문/등록·인증정보·Slack·native Codex·실제 모델/외부 전송은 `not_run`이다.

## 다음 최소 작업

다음은 구현 설계를 추가하는 단계가 아니라 **기존 허용 범위의 회사 레포에서 v3 읽기 준비를 명시적으로 1회 적용**하는 단계다. 새 검사 의미를 명시하고 기존 확인 정책을 재사용하며, 회사 자료가 합성 검증에 사용된 것으로 소급하지 않는다. 성공은 로컬 안전 근거의 `AWAITING_APPROVAL` 준비까지다. 회사용 approve/run·자동 답장·코드 변경·실제 모델 사용은 이번 기능에 포함되지 않는다.
