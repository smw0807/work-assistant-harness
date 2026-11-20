# 4-C-17 자원 실패 진단 보완 결과

2026-11-17. 자원 한도 오류의 정확한 항목과 실패 시점의 사용량을 로컬에 기록하는 기능을 추가했다. 이번 구현·검증은 합성 저장소만 사용했다. 회사 원본·Slack·실제 인증정보·native Codex·실제 모델에 접근하거나 이전 회사 준비를 재실행하지 않았다.

## 배경과 범위

앞서 별도로 허용된 회사 읽기 준비 1회는 `COMPANY_GIT_RANGE_LIMIT`로 중단됐고 같은 ID 조회에서 계획 부재를 확인했다. 당시 단일 오류 코드만 남아 어떤 동적 제한에 걸렸는지는 알 수 없다. 물리 파일 크기·개수·index 크기가 한도 안이라는 관찰만으로 누적 조회·읽기·해제·깊이·메모리 제한 중 원인을 선택하지 않는다. 이번 합성 재현은 진단 기능 검증이며 과거 회사 실패 원인의 증명이 아니다.

## 구현 내용

budget은 최초 한도 거절 때 `company-git-range-failure-v1`을 오류 객체 identity에 결합한다. 고정 phase/stage·한도명·current/requested/maximum과 실패 직전 계수만 포함한다. 원본 경로·파일명·객체 ID·원문·임의 오류 문자열·stack은 포함하지 않는다. 정리 후 계수로 덮어쓰지 않으며 후속 cleanup 실패도 첫 오류를 보존한다. 닫힘이 불확실한 descriptor는 계수를 남긴다.

`current`는 거절 직전까지 사용한 양, `requested`는 거절된 추가량이다. 파일 크기 gate는 current 0과 관찰 크기를 requested에 기록한다. 요청을 수행해 실제 초과 사용했다는 뜻이 아니다. timeout은 경과 시간을 기록한다. `inflationOutputBytes`는 기존 objectBytes+looseHeaderBytes 상한의 진단용 이름이며 새 예산이 아니다.

`company-readonly-v2-plan/prune`에 선택 `--diagnostics-dir`을 추가했다. worker에는 고정 진단 version만 전달하고 별도 경로나 쓰기 권한을 주지 않는다. worker가 생성한 bounded stderr frame을 부모가 task·profile·정확한 schema·숫자 범위로 검증한다. 중복·잘림·잘못된 UTF-8·임의 필드·task 불일치는 진단으로 인정하지 않는다. stdout/stderr 기존 64KiB 제한과 정상 종료 확인은 유지한다. valid failure와 성공 응답이 충돌해도 성공 처리하지 않는다.

부모는 runtime 밖의 별도 0700 디렉터리에 `diagnostic-<id>.json`을 0600으로 한 번 생성한다. task/owner/runtime/진단 위치 hash, 기존 `auditExpiresAt`과 내용 hash를 검증하며 파일은 최대8192바이트, 디렉터리는 최대8192파일이다. 링크·공개 권한·이동/복사·변조를 거부한다. 같은 옵션을 준 plan 시작 또는 prune에서 만료 기록을 삭제하며 자동 삭제 타이머는 없다. 기존 run/result 파일과 DB에 진단을 섞지 않는다.

일반 오류·강제 종료·잘못된 frame에는 `failure:null`일 수 있다. 진단을 저장하지 못하면 unknown을 반환하며, 이미 DB에 저장된 계획은 같은 ID의 inspect로 확인한다. 자동 재시도·다른 입력 재실행·한도 확대는 없다.

## 검증 결과

설치된 pnpm **12.16.1**과 Node **26.12.1**을 사용하며 버전 고정·자동 전환·설치·다운로드는 하지 않았다. 비어 있는 인증 설정과 최소 환경으로 검사하고 실제 native/model opt-in은 제공하지 않았다. 전체 회귀의 네트워크 사용은 기존 합성 loopback 테스트다.

| 검사 | 결과 |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | passed |
| `pnpm build` | passed |
| `pnpm test:company` | passed — 247개, 실패·미실행0 |
| `pnpm test` | passed — 총1541개 중1505개 통과, 실패0, native opt-in 36개 미실행 |
| 회사 원본·Slack·실제 인증·native·모델 재접근 | not_run — 이번 범위에서 제외 |

추가 합성 검사는57개다. budget7개·source4개·wire/parser6개·private 보관26개·supervisor8개·CLI6개이며 주요 검증은 다음을 포함한다.

- 실제 예산 실패 18종, 두 pass 누적 읽기·fractional timeout, 최초 실패 동결과 위조 오류/getter/Proxy 거부.
- 허용 크기 안인 합성 working index를 위치 지정으로 읽다가 metadataCalls 8192 이후 추가1회를 거절하고 working_index 단계·계수 보존. pack/index 크기, 후보/디렉터리 항목, 513번째 inflation 거절도 확인.
- 실제 제한 worker에서 sparse pack 크기 gate 실패, 본문 없는 private 진단, 계획/payload 0과 같은 ID NOT_FOUND. 원본 파일의 전후 상태 보존.
- 정상 opt-in과 기본 실행의 stdout/run/result/DB schema 일치, 진단 저장 실패 후 DB commit 보존과 같은 ID inspect 복구, 자동 재실행0.
- 정책/옵션/위치 gate, private 권한·링크·hash·이동/복사·불변 생성·파일 수/크기·만료 삭제, supervisor 종료·deadline·출력 제한과 진단 충돌.

초기 lint/typecheck에서 새 코드의 정리 처리와 테스트 반환 경로를 수정했고, 집중 검사에서 신규 테스트의 비UUID 작업 ID를 유효 UUID로 수정했다. 초기 실패 로그도 최종 로그와 함께 비공개 로컬 위치에 보존한다.

## 변경 파일과 계약 보존

- `src/domain/company-git-range-diagnostic.ts`, `src/policy/company-git-range-diagnostic.ts`, 기존 budget/files/source/index/object-codec: 별도 실패 schema와 기존 한도 판정 지점의 계측.
- `src/cli/company-readonly-v2-diagnostic-*.ts`, 기존 v2 parent/worker/protocol/supervisor: 선택 진단 전달·로컬 보관과 실패 처리.
- 신규 진단 테스트 5파일과 기존 supervisor 테스트, README/handoff/구현 계획/선택 읽기 설계/이 결과 문서.

직전 커밋의 기존 코드·테스트·설정·의존성 기준선387파일 중10파일이 변경됐고377파일은 바이트가 같다. Git profile hash `8fc98736b72781db4567c808f6dca086b8b9ec1a4f97eb5e551d8ee0c3f210b6`과 기존 수집/회사v1/개인/relay·plan/payload/DB 계약, 오류 코드·한도·의존성·lockfile은 유지한다. 기본 stdout·run/result 형식도 유지한다.

상세 검사 로그·호출 설정·코드 기준선 비교·최종 hash manifest는 허용된 비공개 로컬 위치에 보관하고 공유 문서에는 합성 집계만 둔다. 디렉터리는0700, 기록 파일은0600이다. 검사 프로세스는 종료됐으며 합성 fixture는 정리됐고 전용 Node compile cache만 같은 비공개 위치에 남긴다. 이번 작업을 자동 커밋하지 않는다.

## 남은 한계와 다음 최소 작업

과거 실패의 상세 계수는 복원할 수 없다. 다음 최소 작업은 기존 승인 범위와 현재 입력을 대조해 이 진단 옵션으로 회사 읽기 준비를 명시적으로1회 실행하는 것이다. 이번에 자동 실행하지 않는다. 실패 항목을 확인한 다음 구현 최적화·지원 범위를 판단하며 한도를 임의로 높이지 않는다.

현재 기능은 로컬 검토 준비이며 실제 모델 답변이나 회사 코드 수정 기능의 완료가 아니다. 부모 강제 종료 후 독립 guardian, OS RSS 강제 상한, 전체 pack checksum·미조회 객체 검증은 추가되지 않았다. 합성 통과를 회사 조사 성공·호환성 또는 회사 보안 검토 통과로 표현하지 않는다.
