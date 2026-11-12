# 단계 4-C-5 합성 다중 파일 읽기 전용 조사 결과

검증일: 2026-11-12. 사용자 요청에 따라 실제 모델 호출을 제외한 오프라인 구현과 수용 검증을 수행했다. 등록된 합성 자료와 고정 응답 모델만 사용한다.

## 구현 범위

정책은 `synthetic-readonly-investigation-v1`, schema는 `readonly-report-v1`, 모델은 `fixed-readonly-v1`, 목적지는 `local:fixed-response`, 인증 방식은 `none`이다. 기존 조사·제안·실행 승인과 별도로 `readonly-investigations.sqlite`를 사용한다.

- 고정 Git commit으로 준비한 `flow` fixture의 README·controller·service·settings 네 파일을 조사한다. 준비를 마치면 파일 0444·디렉터리 0555로 고정하고 파일/Git/부모 identity를 기록한다. 이후 코드 import·대상 검사·추가 commit·브랜치 생성은 하지 않는다.
- 읽기 파일/줄은 `readAllowedFiles`·`readRanges`, 전송 근거는 `transferEvidenceIds`·정확한 `inputHash`로 결합한다. `writeAllowedFiles=[]`, `testCommandIds=[]`, `executionAllowed=false`를 강제한다. `--selection all --transfer controller`는 네 파일의 로컬 근거 중 controller 한 개만 전달한다.
- 승인 전 호출은 0회다. 명시적 TTL 1~60분과 소유자·계획 hash를 확인하고 승인 소비·단일 attempt를 먼저 저장한다. dispatch 직전 실제 시각·입력·generation을 확인하며 실패/취소/중단 뒤 자동 재시도나 소비 복원이 없다.
- 모의 worker는 승인한 직렬화 입력만 stdin으로 받는다. 호스트 환경은 LANG/TZ만 전달하고 하네스의 고정 모듈만 읽는다. Node permission으로 임의 파일 읽기·쓰기·네트워크·추가 프로세스·worker를 제한한다. 저장소·DB·credential 경로를 worker에 주지 않는다.
- JSON 추가/중복 키, 미전송 근거, 존재하지 않는 경로, 범위 밖 줄, 비밀, 과대 출력, 실행용 필드를 거부한다. 결과는 `REPORTED` 로컬 보고서로 끝나고 `mode: mock`, `semanticAccuracyVerified: false`, 실제 모델/외부 전송 `not_run`을 명시한다.
- 취소·무효화는 generation으로 늦은 결과를 막는다. 실제 worker 종료를 기다리며 정리 불확실은 `BLOCKED`다. 재시작은 `RUNNING`을 보존하고 명시 `recover`만 원본 identity와 신뢰하는 프로세스 기록을 확인한다. 원본 변조·만료 payload·종료 증거 부재는 `BLOCKED`, 확인된 종료는 `INTERRUPTED`로 기록한다.
- 내용은 24시간 payload, 본문 없는 감사는 최초 terminal 전환부터 30일, 최소 ID/소비 marker는 DB 수명으로 나눈다. 명령 시작과 `prune`가 만료 내용을 제거한다. 합성 원본/Git/실패 작업물은 자동 삭제하지 않는다. 본문은 명시적인 plan/inspect/run 결과에만 포함하며 일반 오류·승인 snapshot·프로세스 종료 기록에는 넣지 않는다.

## 검증 명령과 결과

환경: macOS arm64, Node v26.12.1. 이미 설치된 의존성을 이용해 TypeScript·ESLint·Node test runner를 직접 실행했다. pnpm은 staging의 store 경로 차이로 자동 registry 확인을 시도해 중단했으며 의존성·lockfile 변경은 없다.

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src tests
node node_modules/typescript/bin/tsc
HARNESS_NATIVE_CODEX_PROBE=1 node --test dist/tests/*.test.js
```

최종 결과: **타입 검사·lint·빌드 통과, 전체 583개 테스트 통과(신규 53개 + 기존 530개), 실패 0·skip 0.**

기존 세 개의 macOS guardian/self-exec 검사는 로컬 프로세스 종료·격리 회귀이며 실제 Codex 모델이나 로그인 정보를 사용하지 않는다. 신규 실제 OS 검사는 Node permission 차단, FIFO 거부, 파일 교체 경합, 부모 SIGKILL·IPC 단절·새 프로세스 복구다. 로컬 테스트 서버와 sandbox-exec를 허용하는 환경에서 최종 회귀를 수행했다. 최초 제한 환경의 loopback/native 거부와 동시 컴파일 중 파일 읽기 오류는 최종 단독 빌드·검사와 구분한다.

## 수용 기준별 근거

`정책`은 `readonly-investigation-policy.test.ts`, `저장소`는 `readonly-repository.test.ts`, `상태`는 `readonly-lifecycle.test.ts`, `CLI`는 `readonly-investigation-cli.test.ts`, `worker`는 `readonly-model.test.ts`, `계약 분리`는 `readonly-contract-isolation.test.ts`를 뜻한다.

| 기준 | 결과 | 검증 근거 |
| --- | --- | --- |
| 103 합성 파일·기준 고정 | passed | 정책·저장소: 네 파일/고정 commit/manifest, 임의 fixture·root·추가 파일·Git ref·권한 변조 거부 |
| 104 권한 분리 | passed | 정책·상태·CLI: 네 파일 읽기/한 근거 전송, 변경 요청도 빈 수정·명령 범위, 누락/비어 있지 않은 권한 거부 |
| 105 경로·파일·교체 경합 | passed | 저장소·정책: 파일/부모 symlink, hardlink, 실제 FIFO, inode/부모 교체, 열린 파일 교체, 잘못된 UTF-8·제어문자 거부 |
| 106 비밀·합성 fixture | passed | 정책: 선택 줄 밖까지 전체 파일 검사, 실행 중 조합한 가짜 패턴, raw·decoded 출력 비밀 거부, 오류 원문 비노출 |
| 107 한도 | passed | 정책: 8파일·16구간·200줄·32KiB파일·64KiB근거·128KiB전체입력·16KiB출력 경계/초과, 겹친 구간 정규화 및 절단 거부 |
| 108 결정성·원본 보존 | passed | 저장소·상태·CLI: snapshot/hash 재현, 순서/줄/본문 변조, 정상/실패/취소 전후 파일/Git/권한/링크 보존 |
| 109 검토/전달 일치 | passed | 상태·정책·worker·CLI: 저장된 inputText와 실제 port 입력 byte/hash 일치, 미선택 근거·호스트 경로 제외 |
| 110 승인·TTL·정책 | passed | 상태·정책·계약 분리: 소유자/TTL/hash/24h, stale 시각 dispatch, 설정·payload 변조, 구형/live 계약 거부 |
| 111 단건 소비·실패 | passed | 상태: 동시 run 한 번, 승인 전 0회, DB rollback 시 0회, timeout·실패·중단·late reply 뒤 재호출 없음 |
| 112 악성 자료 | passed | 정책·저장소·worker: README/코드 지시는 데이터로 유지, canary 변경 없음, 추가 문맥은 질문에만 포함 |
| 113 보고서 검증 | passed | 정책: facts 필수 근거, 미전송 ID/범위 밖 줄/허구 경로/추가·중복·이스케이프 키/비밀/과대 출력 거부, 의미 정확성 미검증 표시 |
| 114 구형 계약·실행 차단 | passed | 계약 분리·CLI·기존 회귀: 같은 UUID의 기존 승인도 재사용 불가, 구형 hash/고정 입력 보존, export/실행 옵션 없음 |
| 115 취소·복구 | passed | 상태·worker·CLI: 전달 전/실행 중 generation 경합, 늦은 성공 차단, 실제 부모 SIGKILL 후 worker 종료와 새 CLI 복구, 원본/정리 불확실 BLOCKED |
| 116 보관·출력 경계 | passed | 상태·CLI·worker: private 권한·링크·payload/감사 변조, 24h 만료, 최초 terminal+30d 정리, marker 유지, RUNNING 자동 복구/원본 삭제 없음 |
| 117 CLI·회귀 | passed | CLI 8개 명령과 필수/허용 옵션, 신규 수용 및 기존 회귀, 문서·구현 상태 일치 |
| 118 필수 오프라인 경계 | passed | 정책·계약 분리·worker: live 옵션/포트/승인 거부, 정확한 snapshot 입력 전달과 실제 권한 차단 확인 |
| 118 선택 live 실증 | not_run | 사용자 요청에서 실제 모델 호출 제외. 신규 동적 snapshot용 live broker/외부 모델 adapter는 미구현이며 기존 4-C-4 broker를 재사용하지 않음 |

## 해석과 남은 범위

고정 응답은 실제 파일 간 의미를 추론하는 모델 평가가 아니다. schema와 인용 범위 검사는 응답의 의미적 정확성을 증명하지 않는다. 한도 중 등록 fixture보다 큰 8파일·16구간·200줄 등의 경계는 정책 단위 시험으로 검증했고 CLI는 등록된 네 파일의 고정 구간만 받는다. 만료 payload는 다음 명령에서 정리되며 중지 상태나 백업까지 즉시 물리 삭제하지 않는다.

실제 모델·회사 자료/저장소·Slack 전송·Git 원격·변경 실행은 이번 검증에서 `not_run`이다. 향후 live 연결은 신규 snapshot broker·고정 목적지·외부 격리·자격증명 보호를 구현하고 구체 입력에 대한 새 승인을 받아 별도로 검증해야 한다. 이번 조사 결과와 승인은 그 권한을 부여하지 않는다.
