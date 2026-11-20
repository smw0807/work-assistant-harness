# 단계 4-C-12 시간·프레임 실행 예산 공동 관리

최신 실제 결과는 사용자가 TTL10분·최대1회·자동 재시도0으로 승인한 시간·프레임 실행 예산 계획의 **`REPORTED`**다.84.074초에1,216,800byte·3936프레임의 EOF와 유효 개인 조사 보고서를 확인했다. 승인·사용·소비·attempt·dispatch·upstream은 각1회이고 원본/Git·고정 자료 보존과 로컬 프로세스 종료·임시 영역 제거를 확인했다. [실제 단건 결과](#시간프레임-실행-예산의-승인된-실제-단건-호출)를 따른다.

별도 실행 예산 계약의 선택값은 **operation120초·공유 정리5초·전체125초·8192프레임**이다. 아래 구현·로컬 검증·검토 계획은 전체1241개 회귀와55초 초과 pinned native 모의 검사를 통과한 뒤 `AWAITING_APPROVAL`·실제 인증/모델/공급자 전송0으로 고정했던 준비 이력이다. 실제 호출 기록과 소비 승인을 덮어쓰거나 복원하지 않는다.

이전 개인 수집 v2 실제1회의 `PERSONAL_READONLY_TIMEOUT`과 소비 기록은 [4-C-11 결과](stage-4c11-result.md)에 보존한다. 당시2490은 EOF 이전 wire 경계 관찰이며 frame 초과 종료로 재분류하지 않는다. 이번 합성 검증은 실제 응답 재생이나 다음 호출 성공의 증거가 아니다.

## 구현과 보존 범위

- `src/domain/readonly-relay-budget.ts`, `src/policy/readonly-relay-budget-policy.ts`: 고정 `readonly-relay-execution-budget-v1`의11필드 snapshot/hash를 추가했다. 별도 `readonly-relay-codex-v3` config와 `codex-chatgpt-relay-v3` profile이 예산을 결합한다. v1/v2 경로는 기존 helper에 위임하고 구형 profile/config/hash·55초/2048 판정을 유지한다. 기존 순수 relay 정책 파일은 수정하지 않았다.
- `src/policy/readonly-relay-protocol.ts`: 새 collector opt-in은 정확한 고정 tuple만 수용한다. EOF 후 UTF8·인증 반사·SSE 검사 순서를 유지하고 새 경로의8192-frame·120초 work·5초 cleanup을 전달한다. 기본2048·55초와 기존 수신 진단11필드는 유지한다. 후보 framing helper는4096/8192의 순수 메모리 검사만 제공하며 transport·인증·임의 실행 예산을 갖지 않는다.
- 공통 `readonly-relay-{codex,broker,runner,process}.ts`: adapter deadline/total/정리·broker 응답 socket·collector·native idle·guardian의 시간은 검증한 config의 budget에서 파생한다. guardian IPC도 정확한 등록 tuple만 허용한다. request/header 수신5초와 응답 대기는 구분하며 binary/credential 검증의 구형 식별 설정을 실제 확장 실행 권한으로 사용하지 않는다. 기존 호출의 기본 argv와 구형 call-report shape는 보존한다.
- `src/domain/personal-readonly-budget.ts`, `src/policy/personal-readonly-budget-policy.ts`, `src/adapters/personal-readonly-budget-repository.ts`: 명시적인 개인 등록/입력/계획 v3에 기존 수집 v2와 새 실행 예산을 결합한다. source 전용 projection은 기존 reader·view 변환·proof 재생성을 재사용하며 승인/전송 계약의 변환으로 쓰지 않는다. 원본이 달라져 같은 view가 나와도 guard에서 거부한다.
- 기존 dispatcher·개인 adapter·service/store/ports·CLI: v1/v2/v3를 정확한 validator로 분기한다. 등록/config 혼용은 reader·task 생성 전에 거부한다. 새 보고서는 기존 collection provenance와 추가 `executionBudget`의 정확한4키(policy/profileHash/workTimeoutMs/frames)를 필수로 저장한다. 같은 DB의 원자 승인/소비/dispatch·TTL·취소·재시작/복구·보관과 구형 보고서 shape를 유지한다. 구형 binary의 새 row 지원은 보장하지 않는다.
- [새 relay 설정 예시](../../config/readonly-relay-execution-budget.example.json), [개인 등록 예시](../../config/personal-readonly-budget.example.json)와 테스트7파일을 추가했다. package/lock·런타임 요구사항과 기존8개 `personal-readonly-*` 명령은 그대로다. 임의 timeout/frame CLI 옵션·실행 중 자동 증가·재시도·승인 승격은 제공하지 않는다.

응답4MiB·개별 frame64KiB·JSON 깊이16·최종16KiB·native 출력 합계128KiB/stderr16KiB·EOF/인증 반사 완료 전 자식 본문 전달0은 유지한다. 개인 수집 v2의 원본64KiB·전체 view64KiB·개별 발췌32KiB·근거 합계64KiB·입력128KiB·8파일/16범위/범위당200줄과 원문 민감 거부/동일 전체 view 재검사도 유지한다. 수집 profile/hash는 새 실행 예산을 승인하지 않으며 새 전송 profile과 예산 hash가 확장 권한을 식별한다.

## 후보 비교와 실제 시간 모의 검사

등록 corpus는6144프레임·1,044,480byte·논리 EOF110,000ms다. 이전55초 cutoff와2490 prefix 경계보다 큰 합성 capacity 목표이며, 실제 공급자 내용이나 미관찰 전체 응답을 추정해 만들지 않았다. 시간 행렬은 정확한 논리 스케줄의 수용 범위다. 프레임 후보는 생산 collector와 같은 순수 SSE 검사 코어에서 실제로 파싱했고 선택값은 production collector의 EOF/본문 바이트 일치로도 확인했다.

| 후보 | 논리 EOF110초 | 6144-frame 파싱 | 선택 |
| --- | --- | --- | --- |
| 90초 /4096 | 불충족 | FRAME_LIMIT | 제외 |
| 90초 /8192 | 불충족 | passed | 제외 |
| 120초 /4096 | 충족 | FRAME_LIMIT | 제외 |
| 120초 /8192 | 충족 | passed | 최소 통과 후보 |

각 후보는 fresh Node worker에서 관찰했다. module loading 이후를 baseline/elapsed/CPU 시작으로 삼고 fixture 생성은 포함했다. 강제 GC는 없으며 OS maxRSS에는 startup이 포함되고 delta는 post-import RSS를 뺀 관찰값이다. heap/external은 sample로서 정확한 peak가 아니다. 최종 compiled 행렬의 최대 wall80.511ms·CPU125.293ms·RSS 증가65,093,632byte는5초/CPU4초/RSS 증가96MiB 기준 안이다. 무한 empty-chunk 취소는4.943ms에 관찰했고5초 종료 기준을 통과했다. 이 관찰은 프로세스 전체 OS 자원 강제 상한이 아니다.

별도의 pinned0.154.0 native 시험은 가짜 credential/upstream만 사용해 **실제 EOF60,502.368ms·2503프레임·72,292byte**를 처리했다. 최종 schema/근거·두 합성 응답 hash·단건1회·EOF·cleanupConfirmed와 guardian/child/PGID 종료·sandbox 부재를 확인했다. 테스트 전체62.480초와 upstream EOF 지연60.502초를 구분한다. 논리 행렬을110초 wall-clock 검사라고 표현하지 않으며 native fake의 성공도 실제 공급자 호환성이나 개인 조사 성공으로 확대하지 않는다.

## 최종 로컬 검증

| 항목 | 결과 |
| --- | --- |
| lint / typecheck / build | passed |
| 전체 하네스 회귀 | 1241 passed /0 failed /0 skipped, compile 포함106.494초 |
| 신규 검사 | 34개: budget policy/protocol/capacity15·transport3·개인 policy9/workflow6/CLI1 |
| 구형 정책·민감 검사 | 핵심 순수 정책/reader/변환기/수신 진단9개 바이트 보존, 구형 profile/config/hash·예산 기본 회귀 passed |
| 기준 소스 | 303개 중290개 불변, 공통 연결부13개 변경 |
| 최종 검증 소스 / 코드·빌드 | 317개 /919개 hash 고정 |
| 독립 코드 교차 검토 | 새 개인 binding·budget policy/protocol blocker0 |
| 원본 보존 | metadata388관찰/311고유경로와 Git3개 hash 변화0; 선택7파일·사용한 Git15개·부모24개 및 원본/view/근거 재생성 passed |
| 이전 비공개 검토·실제 실패 자료 | 48개+보완6개+실제 기록37개 보존 passed |
| 실제 인증 / 모델 / 공급자 전송 | not_run /0회 |

이전과 같은7파일·11범위·근거33,911byte를 수집했다. 원문 민감 거부1개·마스크5개·파생 view 통과 상태와 수집 profile/sourceViews hash도 그대로다. 패턴 매치가 실제 비밀값의 존재를 확정하는 것은 아니다. 원시 매치·원문/전체 view는 저장하지 않고 선택한 안전 발췌와 private proof를 보관한다. model input과 승인 snapshot에는 sourceRoot가 없으며 원본 hash 필드는 private에 둔다. clean view는 원문과 같아 hash값도 같다.

계획·예산·profile·설정·등록·입력·본문·envelope hash는 compiled validator 외에 별도 Python canonical 계산으로도 확인했다. 등록은 sort/merge와 전송 경로 정렬, envelope hash는 body를 requestBodyHash로 바꾼 canonical metadata에 적용한다. raw JSON 파일의 SHA와 논리 계약 hash를 혼동하지 않는다.

## 새 검토 계획과 승인 대기

비공개 검토 디렉터리: [stage4c12-relay-execution-budget-f2ixa7he](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c12-relay-execution-budget-f2ixa7he). 구체 질문·대상·범위·변환 고지·한계는 [review.txt](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c12-relay-execution-budget-f2ixa7he/review.txt), 정확한 전송 내용은 `input.txt`·`request-body.json`을 따른다. 개인 자료·등록·본문·DB는 Git에 넣지 않는다.

| 새 계획 | 값 |
| --- | --- |
| Task | `06ac00d4-95fe-4524-95dd-af6eb8eaf71f` |
| 상태 | `AWAITING_APPROVAL` |
| planHash | `5159d16107a32cd4ae5556ec96d731c7e824ddfea9b820735b9120e300ecc99f` |
| 생성 UTC / KST | 2026-11-15T05:04:43.516Z /2026-11-15 14:04:43 |
| 만료 UTC / KST | 2026-11-16T05:04:43.516Z /2026-11-16 14:04:43 |
| 실행 예산 hash | `00b7a09da8cfaf6d13e0d5e478496a832af792bef0f06eed25d584cc593f2a53` |
| 전송 profile hash | `33428483a0f5c49085c620c9f0799696d5d256287ff4392e191e97b099df640d` |
| config hash | `7a23adbd3514784e2dcf0d5c157b070c4b9a4d8f2f9d7157f64228c5997af0be` |
| 수집 profile hash | `8acdca9effe323a36b322589bec24367b51c8e3c6268c09d5672787b07fd7033` |
| sourceViewsHash | `bbe29fa62acd2669d7a2f268dac64a54e12dec7a6fca7b2dc01070cccb24af90` |
| input / wire body | 45,355byte /50,328byte |
| input hash | `cee4043d2b54e5fe760c09c612f07b447b3642f7a818d254d3ebff201f5448e2` |
| body hash | `6f5f1c9d345de069b71a7885bc8a01f9cb25c30314624970b2a46bd72706f0a7` |
| envelope hash | `d6a6062b04a3aa18c10873d90b2380b4d577b5f5d17430870966b5d727b14bed` |
| canonical registration hash | `7719ce03acc0871d3a0315801aa32f5377c7309b126e3d8df6291b6c0be40dd9` |
| 승인 / 사용 / 소비 / attempt / dispatch | 각각0, 승인 TTL 미시작 |
| writeAllowedFiles / testCommandIds / executionAllowed | [] /[] /false |

private 파일은0700 디렉터리의0600 파일로 보관하고 가변 DB는 artifact hash 고정에서 제외한다. DB는 readonly 조회로 task1/승인0/사용0/소비0/attempt0/dispatch0·보고서null을 확인했으며 실제 run 디렉터리는 없다. DB의24h 내용/30d terminal 감사/소비 marker와 사용자 export 파일의 보관은 구분한다.

독립 준비 감사27항목이 모두 passed/blocker0이다. 고정 자료50개·소스317개·코드/빌드919개·구형 정책/자료·계획/본문/예산 hash·원본/view·private 권한과 DB0 계수를 확인했다. 개인정보/문서 검토에서도 실제 개인 코드·등록·대상 경로·비밀값의 Git 유입은 발견하지 않았다. 최종 기록은 `independent-readiness-audit.json`과 `independent-privacy-document-review.json`이며 원래50개 manifest와 최종 감사·요약·문서 hash를 `final-readiness-artifact-hashes.json`으로 추가 고정했다. 고정한 로컬 검증 파일의 `pending-at-freeze`는 당시 시점이고 최종 감사 상태는 이 별도 감사/요약 파일을 따른다.

현재 범위에서 실제 credential/status/refresh·모델·provider 전송·대상 설치/테스트/빌드/쉘/Git CLI·거래 API·코드 수정·Slack·회사 자료·commit/push는0이다. 전체 전이 호출 그래프·거래 안전성·의미 정확성·실제 공급자 완료시간은 미검증이다. 기존 공급자 응답 metadata/sequence/tool_usage의 `not_inspected`, rawSensitiveScan/parentTextComparison의 `not_performed`도 유지하며 source/view의 전체 민감 검사와 구분한다.

다음 최소 작업은 정확한 입력과 범위·변환 고지·확장 예산을 검토하는 것이다. 실제 조사를 원하면 이 새 계획에 대한 명시 TTL·최대1회·자동 재시도0 승인이 필요하다. 기존 소비 승인과 실패 기록은 재사용하지 않는다.

## 시간·프레임 실행 예산의 승인된 실제 단건 호출

사용자가 위 계획을 TTL10분·실제1회·자동 재시도0으로 승인해 정확한 입력·설정·기존 실행 예산으로 한 번 호출했다. 실행 직전 독립 검사28항목에서 고정 자료·source/view·native pin·코드/빌드와 승인/사용/소비/attempt/dispatch0을 확인했다. 모델·본문·계약·한도를 변경하거나 호출을 재시도하지 않았다.

| 실제 단건 | 결과 |
| --- | --- |
| Task / planHash | 위 `06ac00d4-95fe-4524-95dd-af6eb8eaf71f` / `5159d16107a32cd4ae5556ec96d731c7e824ddfea9b820735b9120e300ecc99f` |
| 승인 | `c001bccf-ff0e-4f2c-baad-3207c964cd4f` |
| 승인 생성 / 만료 KST | 2026-11-15 14:23:54.154 /14:33:54.154, 정확히600초 |
| 사용·attempt 시작 / dispatch UTC | 2026-11-15T05:23:57.396Z /05:23:57.443Z |
| 종료 UTC / KST | 2026-11-15T05:25:21.470Z /14:25:21.470 |
| attempt 경과 | 84.074초 |
| 상태 / 실패 code | `REPORTED` /null |
| 승인 / 사용 / 소비 / attempt / dispatch / upstream | 각각1회, run1회·자동 재시도0회 |
| 실제 HTTP / 격리 / 인증 접근 | 200 /passed /passed |
| 수신 본문 | 1,216,800byte·782chunk, max chunk16,378byte |
| 수신 framing | 3936 경계·max frame23,885byte·partial0, EOF=true |
| 종료 진단 | termination=`eof`·failedLimit=`none`·phase=`completed` |
| 응답 hash | `ec52eb9036ced87b1720f6b0dfdc184dfc524443d73d66001c2c7dae43c1b6b8` |
| native 최종 text hash | `7ad5aabf021df5e67b84719975ad73252e5f493896205f38497528bf0453653a` |
| 저장 보고서 hash | `e94b02e6265d38aeaab2b847157a308bc5cdddb6f46de273b42a31b990a514f5` |
| 최종 결과 | question·허용 근거 인용 facts11·추가 질문2·가설0·수정 제안0 |
| 최종 schema / 근거 인용 / 민감정보·반사 검사 | passed |
| 의미 정확성 / 대상 코드 실행 | not_run /not_run |

EOF 이후 UTF8·일반 SSE/JSON·frame/깊이·실제 인증값 반사 검사와 native의 최종 출력·개인 조사 schema/인용/민감정보 검사를 통과했다. 이번3936은 EOF framing 검사를 통과한 수신의 경계 수이며 모델 응답 개수나 provider metadata의 의미 검증을 뜻하지 않는다. 최초 본문을 자식에게 전달하기 전에 EOF와 검사를 완료했고 단일 native 최종 text만 채택했다. 수집 v2 collection provenance와 실행 예산4키가 보고서에 정확히 결합돼 있다.

두 응답 hash는 attempt·보고서·call-report 간 일관성을 확인했다. 원시 응답과 native 최종 text 원문은 비보관이므로 사후 원문 재계산을 수행했다고 표시하지 않는다. 저장 보고서 hash는 기존 store의 compact `JSON.stringify(report)` 삽입순서 UTF8 SHA이며 canonical plan/profile hash와 구분해 재계산했다. 원시/부분 upstream 본문·인증값·쿠키·헤더값을 하네스 파일에 보관하지 않는다. 구체 조사 내용과 추가 질문은 private 보고서에만 보관하며 Git 문서로 복제하지 않는다.

사후 독립 감사24항목은 모두 passed/blocker0이다. 선택7파일·사용한 Git15개·부모24개와 source/view proof·발췌를 재생성해 일치시켰다. metadata388관찰/311고유경로와 HEAD/index/ref3개 hash 변화0, 준비50개+보완7개·검증 소스317개·코드/빌드919개·고정 native와 이전48+6+37개 검토/실패 자료의 hash 보존도 확인했다. 준비 당시 문서5개의 사본을 private 실제 기록에 보관한 뒤 이번 실제 결과를 갱신했다.

controller37151·guardian37166·child37167·native 프로세스 그룹-37167·pnpm run37100·approve37012는 모두 `ESRCH`이고 lifecycle/child는 `closed`다. `cleanupConfirmed=true`와 소유 sandbox/HOME 부재를 확인했다. 원본/Git·DB·감사·보존 canary는 임시 정리 대상으로 삭제하지 않았다. 로컬 종료는 원격 추론 중지를 독립 확인했다는 의미가 아니다.

실행·승인·종료 snapshot, 숫자 진단·보고서·감사는 [actual-execution-budget-once](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c12-relay-execution-budget-f2ixa7he/actual-execution-budget-once)에0700/0600으로 보관했다. [실행 결과](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c12-relay-execution-budget-f2ixa7he/actual-execution-budget-once/result.txt)와 [개인 조사 보고서](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c12-relay-execution-budget-f2ixa7he/actual-execution-budget-once/report.txt), `independent-post-actual-audit.json`·`actual-artifact-hashes.json`을 따른다. 가변 DB는 고정 manifest에서 제외하며 readonly 조회로 `REPORTED`·승인/사용/소비/attempt/dispatch 각1회와 보고서 존재를 확인했다. 승인 만료 전이라도 소비된 승인은 재사용하지 않는다.

이번 호출은 이 개인 자료·고정 입력의 구체 단건 성공이다. 일반 공급자 호환성·다른 입력의 완료시간·전체 전이 호출 그래프·거래 안전성·의미 정확성·원격 추론 중지는 미검증이다. 기존 provider metadata/sequence/tool_usage의 `not_inspected`, rawSensitiveScan/parentTextComparison의 `not_performed`도 유지한다. 모델 출력은 자료이며 추가 읽기·명령·수정·승인을 만들지 않는다.

실제 호출 동안 구현을 변경하지 않아1241개 로컬 회귀의 소스/빌드 hash를 유지했다. 대상 설치·테스트·빌드·쉘/Git CLI·거래 API·코드 수정·Slack·회사 자료·commit/push는 실행하지 않았다. 다음 최소 작업은 private 보고서의 인용·불확실성·누락 범위를 검토하는 것이다. 추가 모델 호출이나 대상 실행/수정에는 별도 계획과 승인이 필요하다.
