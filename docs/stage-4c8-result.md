# 단계 4-C-8 합성 다중 파일 실제 모델 조사 결과

기록일: 2026-11-13. **전체985개 검증 코드의 response 진단을 별도 승인해1회 실행했으나 SSE created 내부 response의 엄격한 키 검사에서 실패했다.** 필수 누락0·미등록 추가 필드5개(array1·nonnegative-integer2·null1·object1)·overflow 없음을 확인했으며 이름·의미는 미확인이다. 이전 v8의 origin 단정 불가 정정은 유지하고 이번 결과를 소급 적용하지 않는다. 격리·인증 접근 passed와 cleanupConfirmed=true를 확인했고 독립 사후 감사에서 원본/Git33개·부모7개 identity·HEAD/base 보존과 관련 프로세스·sandbox 종료를 확인했다. 누적 upstream14회 실패·별도 전송 전 실패1회·소비 승인15개·자동 재시도0회를 보존하며 유효 보고서는 없다. 별도 v9 추가 JSON 호환 정책은 구현과 전체1005개·집중121개 검증을 마쳤다. 기존 v1~v8 계약·profile·hash는 보존한다. 새 v9 계획 준비를 마쳤으며 추가 승인을 기다린다. 새 계획의 승인·attempt·전송은0회다.

## 구현 범위

- 새 `synthetic-readonly-live-v1` 정책과 `readonly-live.sqlite`를 사용하며 기존 4-C-4/5/6/7 명령·계약·해시·승인을 유지한다.
- 새 합성 `flow` 원본의 허용 파일/줄과 선택한 전송 근거만 사용한다. `writeAllowedFiles=[]`, `testCommandIds=[]`, `executionAllowed=false`다.
- 고정 `gpt-6.1-sol`·기존 ChatGPT 로그인·설정/profile을 별도 승인에 결합한다. 각 구형 계약을 유지하며 v2 이후 응답 헤더 한도, v3 metadata/SSE·Set-Cookie 폐기를 v4도 유지한다. HTTP 헤더 형식·상세 정적 오류 보완은 v4 설정/profile/decoder에 적용한다. v5는 `Content-Type`이 없을 때에만 제한된 JSON/SSE 본문 식별을 추가하며 구형 계약과 해시를 바꾸지 않는다. 승인한 최종 본문과 인증 없는 명세를 검토할 수 있다.
- `readonly-live-{plan,inspect,approve,run,cancel,invalidate,recover,prune}`를 추가한다. plan/approve/run은 필수 `--config`, 승인 TTL은 필수 1~60분이다. 설정 예제는 비활성이다.
- 인증은 승인된 run의 adapter에서만 지연 접근한다. 부모 broker 메모리 외 인증값을 전달·저장하지 않고 refresh·로그인 파일 변경은 하지 않는다.
- 단일 소비·전달 예약·generation·원본 재검증·격리 프로세스 정리·명시 복구·private 보관을 적용한다. 실패·취소·중단 뒤 재호출·승인 복원은 없다.
- HTTP 직전 동기 원본 검사와 비동기 준비 뒤 승인·generation 재검사, 완료 직전 승인 만료 검사로 늦은 전달·결과를 차단한다. 전달 예약 뒤 `CANCELLED` 상태에서 중단돼도 recover는 종료 증거를 확인하며 불확실하면 `BLOCKED`로 남긴다.
- 자식 종료 뒤 소유 모델 임시 디렉터리와 빈 HOME/CODEX_HOME만 inode/dev를 확인해 제거한 다음 종료 증거를 남긴다. 루트 symlink·다른 inode를 거부하고 하위 symlink 대상은 보존한다. 합성 원본/Git·DB·감사·실패 작업물은 이 정리 대상이 아니다. 강제 중단 시 제거가 불확실한 잔류 내용은 보존하고 `BLOCKED`로 기록한다.
- guardian은 stderr 16KiB와 stdout/stderr 합계 128KiB를 강제한다. 원문·부분·잘못된 응답을 보고서/DB에 저장하지 않는다.
- 실제/합성 연결 증거를 보고서에서 구분한다. 회사 자료·실제 저장소·Slack·대상 코드 실행·브랜치/patch·commit/push·PR/MR·실행 export는 연결하지 않는다.

## 검증 상태

| 검사 | 결과 | 근거 또는 미실행 이유 |
| --- | --- | --- |
| TypeScript typecheck | passed | response 정적 진단 보완 후 최종 `pnpm typecheck` |
| lint | passed | response 정적 진단 보완 후 최종 `pnpm lint` |
| build | passed | Node 26.12.1·pnpm 12.18.0에서 최종 `pnpm build` 및 `pnpm test`의 `tsc` |
| 귀속 진단 호출 당시 전체 회귀 | passed | 고정 바이너리 경로를 지정한 `HARNESS_NATIVE_CODEX_PROBE=1 HARNESS_NATIVE_CODEX_PATH=<pinned-path> pnpm test` 전체915개 통과·실패0·skip0, 약67.9초. 기존726개·신규189개. 후속 집계 진단 이전 코드의 기록 |
| 일치 집계 당시 CLI 계획·승인·제어·설정·구형 승인 분리 | passed | 12개 통과. v1~v5 profile·한도·본문/요청 헤더 불변·승인 분리·구형 기록 조회/취소/복구, 합성 설정·임시 HOME·승인 전 원본 보존 |
| 일치 집계 당시 profile·요청/응답·상태·취소·복구 | passed | policy 19개·protocol 62개·lifecycle 44개. 구형 hash 보존·v4 헤더 정규화/상세 정적 오류·v5 누락 MIME 본문 식별·금지 경계, 동시성·만료·취소·중단·보관·응답 표시 검사 |
| 일치 집계 당시 native Codex·합성 upstream·OS 격리·정리 | passed | broker 18개·readonly-live-process 10개와 기존 codex-process 3개를 전체 회귀에 포함, 모두 통과. 합성 upstream 통합·SIGKILL·정리·canary 검사이며 실제 외부 모델·실제 인증값 사용 없음 |
| 별도 승인된 v1·v2·v3 실제 모델 조사 | failed | 세 작업 모두 `FAILED`·`READONLY_LIVE_CALL_FAILED`. 진단은 각각 `READONLY_LIVE_HEADER_LIMIT`, `READONLY_LIVE_INVALID_RESPONSE`, `READONLY_LIVE_INVALID_RESPONSE_HTTP_HEADERS`. 각 upstream 1회, 총 3회·자동 재시도 0 |
| v1·v2·v3 시도의 인증 접근·OS 격리·정리 | passed | 세 시도 모두 `credentialAccess=passed`, `isolation=passed`, `cleanupConfirmed=true`. 공급자 인증·추론 성공을 뜻하지 않음 |
| 기존 v1·v2·v3 실제 기록 보존 | passed | 기존 실제 기록을 `assertPlan`·`validatePayload`·원본 identity로 검증, 계획·승인·payload/hash 호환 보존 확인 |
| v3 응답 계약·진단·구형 호환 | passed | 새 설정/profile/decoderVersion, nullable·추가 metadata, 정적 단계별 오류, Set-Cookie 폐기와 CLI 경계 검증 |
| v4 HTTP 헤더 계약·진단·구형 호환 | passed | HTTP 형식 정규화·거부 조건별 정적 오류·구형 세 버전 CLI 경계 검증 |
| 실행 파일 부재로 종료한 v4 진단 실행 | failed | `FAILED`·`READONLY_LIVE_CALL_FAILED`, phase `preflight`. 승인된 0.154 실행 파일 경로의 `lstat`가 `ENOENT`, 승인 소비 유지 |
| 실행 파일 부재 v4 시도의 외부 전송·인증·격리 | not_run | upstream 0·HTTP 관찰 없음·credentialAccess/isolation `not_run`, `cleanupConfirmed=true` |
| 실행 파일 준비 검사 보완 | passed | 공식 0.154.0 바이너리 SHA-256 일치, 소비 전 검증·만료·취소 회귀 5개와 복구한 바이너리의 native 합성 upstream 통과 |
| 고정 바이너리 v4의 별도 승인 진단 호출 | failed | `READONLY_LIVE_INVALID_RESPONSE_DECODE_CONTENT_TYPE_MISSING`, HTTP 200·헤더 35개·3,133바이트, upstream 1회. 이 응답의 `Content-Type` 누락 확인 |
| 고정 바이너리 v4의 인증 접근·OS 격리·정리 | passed | `credentialAccess=passed`, `isolation=passed`, `cleanupConfirmed=true`. 조사 보고서 없음·승인 소비 유지 |
| v5 누락 MIME 본문 식별과 구형 회귀 | passed | v5만 JSON/SSE 본문 식별을 추가하고 v1~v4 해시·승인 분리를 유지. 전체 886개 회귀를 통과한 코드로 실제 1회 실행 |
| 별도 승인한 v5 실제 호출 | failed | `READONLY_LIVE_INVALID_RESPONSE_JSON`, HTTP 200·헤더 35개·3,135바이트, upstream 1회. 헤더 검사 통과 뒤 JSON 처리 실패, 세부 원인 미확인 |
| v5 인증 접근·OS 격리·정리·독립 감사 | passed | `credentialAccess=passed`, `isolation=passed`, `cleanupConfirmed=true`. 원본/Git 33개 항목과 부모 경로 7개 identity 보존·관련 프로세스 종료 확인 |
| 별도 승인한 JSON 진단 실제 호출 | failed | `READONLY_LIVE_INVALID_RESPONSE_JSON`, `origin=sse`, `reason=sensitive-content`. HTTP 200·헤더 35개·3,127바이트, upstream 1회. 민감정보 검사 거부 확인·해당 필드 미확인 |
| JSON 진단 호출의 인증 접근·OS 격리·정리 | passed | `credentialAccess=passed`, `isolation=passed`, `cleanupConfirmed=true`. `report=null`, `responseHash=null`, 승인 소비 유지 |
| 후속 민감정보 패턴·영역 진단 | passed | 기존 수용 조건·오류·승인 hash 유지. focused77개 및 전체907개 통과, 실패/skip0. 895개는 직전 실제 호출 코드의 기록 |
| 민감정보 진단 호출 전 준비 | passed | 기존 v5 본문/설정/profile/명세 동일, verifyReady·계획/payload·원본33개·부모7개·HEAD·DB 보존 확인. 준비 당시 승인0·attempt0·소비0. 최종 빌드로 과거7개·신규1개 계획/payload/hash 보존 및 새 원본·verifyReady 재확인 passed |
| 별도 승인한 민감정보 패턴·영역 진단 호출 | failed | `READONLY_LIVE_INVALID_RESPONSE_JSON`, `origin=sse`, `reason=sensitive-content`. `pattern=credential-assignment`, `area=other`, usage 두 값은 `not-applicable`. HTTP 200·헤더 35개·3,131바이트, upstream 1회. 정확한 필드·오탐 여부 미확인 |
| 패턴·영역 진단 호출의 인증 접근·OS 격리·정리 | passed | `credentialAccess=passed`, `isolation=passed`, `cleanupConfirmed=true`. `report=null`, `responseHash=null`, 승인 소비 유지 |
| 후속 귀속 진단의 로컬 검증 | passed | 기존 `json`·`sensitive` 보존, `sensitiveAttribution` 열 고정 enum·정확한 일치 범위·다른 경로 복수 분류·미등록 값 차단. focused 92개 및 전체 915개 통과·실패/skip 0 |
| 귀속 진단 호출 전 준비 | passed | 이전 본문 8,897바이트·config/profile/명세 동일, 원본33개·부모7개·HEAD·DB·verifyReady 확인. 최신 빌드로 과거8개·신규1개 총9개 계획/payload/hash 보존 재검증. 준비 당시 승인0·attempt0·소비0·전송0 |
| 별도 승인한 귀속 진단 실제 호출 | failed | HTTP200·헤더35개·3,133바이트, `sse`/`sensitive-content`, `credential-assignment`/`other`. `created`/`response`/`in-progress`, reason·matchExtent·field·valueType `multiple`, usageValidation `invalid-shape`, providerError/Parameter `none`. upstream1회·정확한 일치 필드 미확인 |
| 귀속 진단 호출의 인증 접근·OS 격리·정리 | passed | `credentialAccess=passed`, `isolation=passed`, `cleanupConfirmed=true`. `report=null`, `responseHash=null`, 승인 소비 유지 |
| 후속 일치 집계 진단 최종 검증 | passed | event 경계 보완 후 native 포함 전체924개 통과·실패0·skip0, 약68.1초. 기존726개·신규198개. 직전915개 대비 protocol2개·민감정보 단위7개 추가 |
| 새 일치 집계 계획 준비 | passed | 과거9개·신규1개 총10개 계획/payload 유효, 본문8,897바이트·config/profile/명세 동일. 원본33개·부모7개·HEAD·DB·verifyReady 확인, 승인0·attempt0·소비0·전송0 |
| 별도 승인한 일치 집계 실제 진단 | failed | tool_usage 영역의 text-tokens 정수2곳·입력/출력 상세 객체 각1곳에 credential 정규식 일치. HTTP200·헤더35개/3,139바이트, upstream1회, 유효 보고서 없음 |
| 일치 집계 호출 인증·격리·정리·독립 감사 | passed | 승인/소비/attempt/upstream 각1회, 원본33개·부모7개·HEAD 보존, controller/guardian/child 종료·sandbox 부재. 원문 미보관 |
| v6 제한된 tool_usage 호환성 수정 | passed | 전체935개(신규209개)·집중81개·lint/typecheck/build, 실패/skip0, 66.6326초. 공식 형태와 경로·zero 집계만 지원, 비정상/비밀/도구/구형 계약 회귀 |
| v6 계획 준비 | passed | 과거10개·신규1개 총11개 계획/payload/hash, 동일 본문8,897바이트·요청 헤더, 새 응답 계약 hash, 원본33개·부모7개·HEAD·DB·verifyReady |
| v6 실제 모델 검증 | failed | 별도 승인·upstream 각1회. HTTP200·헤더35개·3,125바이트, 헤더·JSON·민감정보 검사 뒤 SSE_EVENT 실패·정확한 조건 미확인 |
| v7 SSE 호환성·정적 진단 최종 검증 | passed | native 포함 전체946개·집중89개·lint/typecheck/build 통과, 실패0·skip0, 약70.2초. 첫 sequence0/1과 이후 연속성·고정 진단·구형 계약 유지 |
| v7 계획 준비 | passed | 과거11개·신규1개 총12개 계획/payload/hash, 동일 본문8,897바이트, 원본33개·부모7개·HEAD·DB·verifyReady 확인 |
| v7 실제 모델 검증 | failed | 별도 승인·upstream 각1회. HTTP200·헤더35개·3,128바이트, SSE_EVENT 진단 created/envelope/zero/first. 순번 검사 뒤 엄격한 envelope 키 검사 거부·세부 키 미확인 |
| envelope 정적 진단 최종 검증 | passed | native 포함 전체960개·집중80개·lint/typecheck/build 통과, 실패0·skip0, 전체69.1514초. 기존 v3~v7 수용 조건·오류·hash 유지 |
| envelope 진단 계획 준비 | passed | 최신 빌드로 총13개 계획/payload/hash, 과거 안전 아티팩트142개 hash, 원본33개·부모7개·HEAD/base·DB·verifyReady 확인 |
| envelope 진단 실제 모델 검증 | failed | 별도 승인·upstream 각1회. HTTP200·헤더35개·3,132바이트, created/envelope/zero/first. missing0·other/boolean/count1·총1개/overflow 없음, 필드명·의미 미확인 |
| v8 제한 호환 정책 최종 검증 | passed | native 포함 전체971개·집중99개·lint/typecheck/build 통과, 실패0·skip0, 전체66.4974초. 제한된 created boolean 확장·기존 엄격 검사·구형 계약 보존 |
| v8 새 계획 준비 | passed | 최신 빌드로 총14개 계획/payload/hash, 과거 안전 아티팩트158개 hash, 원본33개·부모7개·HEAD/base·DB·verifyReady 확인 |
| v8 실제 모델 검증 | failed | 별도 승인·upstream 각1회. HTTP200·헤더35개·3,134바이트, RESPONSE_FIELDS 실패. 직접 JSON/SSE origin·구체 필드/조건 미확인 |
| response 정적 진단 최종 검증 | passed | native 포함 전체985개·집중88개·lint/typecheck/build 통과, 실패0·skip0, 전체70.7316초. origin·거부 경계의 고정 분류와 v8 수용 조건·오류·hash 유지 |
| v9 추가 JSON 호환 정책 검증 | passed | native 포함 전체1005개·집중121개·lint/typecheck/build 통과, 실패0·skip0, 전체68.5384초. 새 수용 정책이며 실제 추가 호출은 없음 |
| v9 새 계획 준비 | passed | 최신 빌드로 총16개 계획/payload/hash·과거 안전 아티팩트188개 hash·원본33개·부모7개·HEAD/base·고정 바이너리·DB 승인/attempt/소비0 확인. 추가 승인 대기 |
| response 진단 계획 준비 | passed | 최신 빌드로 총15개 계획/payload/hash, 과거 안전 아티팩트173개 hash, 원본33개·부모7개·HEAD/base·DB·verifyReady 확인 |
| response 진단 실제 모델 검증 | failed | 별도 승인·upstream 각1회. created/envelope, 필수 누락0·other의 array1/nonnegative-integer2/null1/object1, 총5개·overflow 없음. 이름/의미 미확인 |
| v3 실제 호출 후 독립 검증 | passed | 합성 파일 4개·Git 파일 11개를 포함한 33개 항목/identity/HEAD 보존, controller·guardian·child/그룹 종료와 모델 임시 디렉터리 부재 |
| v2 실제 HTTP 관찰 | passed | HTTP 200, 응답 헤더 35개·3,124바이트. 이후 응답 검증 실패이며 완성 응답·추론 성공은 미확인 |
| v3 실제 HTTP 관찰 | passed | HTTP 200, 응답 헤더 35개·3,131바이트. HTTP 헤더 검사 실패이며 정확한 조건·완성 응답·추론 성공은 미확인 |
| 실제 응답의 근거 인용·불확실성 내용 검토 | not_run | 실제 upstream14회 모두 유효한 조사 보고서가 없음. 최신 response 진단도 report/responseHash null이며 완성 본문·추론 성공은 미확인 |
| 인증된 외부 호출 중 취소·강제 종료 | not_run | 추가 외부 호출을 자동 수행하지 않음. 합성/로컬 중단 검사와 구분 |
| 회사 자료·실제 저장소·Slack·대상 실행·Git 원격 | not_run | 이번 합성 읽기 전용 범위 밖 |

초기 제한된 도구 sandbox에서 broker/process 검사를 실행했을 때 loopback listener 권한 때문에 5개가 실패했다(3개 통과·native 2개 skip). 필요한 로컬 OS 권한으로 native 검사를 포함해 다시 실행한 결과는 당시 10개 모두 통과였다. 이후 첫 전체 회귀도 819개 통과했다. 임시 디렉터리 정리 보호 검사를 한 개 추가한 실행은 819개 통과·1개 실패였으며, canary 보호 검사는 통과했지만 테스트 자체가 빈 디렉터리에 `rmSync(path)`를 사용해 `EISDIR`가 발생했다. 정리 코드를 `rmdirSync`로 수정한 최초 실제 호출 전 회귀는 820개 모두 통과했다. 실제 실패 뒤 v2 보완에서는 전체 실행 820개 통과·6개 skip과 별도 native 실행을 합해 고유 826개를 검증했고, v3 보완은 native 포함 841개 모두 통과했다. v4 최초 lint에서 정규식의 `\x09` 표기 한 건을 지적받아 같은 탭 문자 의미의 `\t`로 바꾼 뒤 lint가 통과했다. v4 최종 전체 회귀는 native 포함 852개 모두 통과했다. 로컬 재검증은 실제 공급자·인증 연결 시험이 아니다.

합성 upstream의 부분·잘못된 응답과 조사 schema/전송 근거 검증을 실제 native Codex 및 서비스·저장소와 연결해 검사했다. 이때 응답의 출처는 합성 검증 증거로 남기며 실제 모델 호출·실제 인증 접근·외부 전송을 `passed`로 바꾸지 않는다.

## 수용 기준 151~162

| 기준 | 현재 결과 |
| --- | --- |
| 151 새 live 계약과 기존 단계 보존 | passed — 정책·DB·설정·구형 승인 분리, 기존 실제 기록 보존과 v1~v8 승인 분리 |
| 152 합성 읽기·전송·수정 범위 | passed — 선택한 합성 근거와 빈 수정·검사 범위 |
| 153 검토 본문과 실제 전송 일치 | passed — 로컬에서 정확한 바이트 검증. 동일 본문 hash로 각기 별도 승인한 upstream 총14회, 각 작업 최대1회 |
| 154 승인·TTL·소비·동시성 | passed — 원자 소비·전달 예약·전송/완료 시 만료·generation 검사 |
| 155 인증 지연 접근과 비노출 | passed — 합성 loader·로컬 명령 검사와 승인된 실제 시도의 credentialAccess 확인. 공급자 인증 성공은 미확인 |
| 156 실제 연결 격리와 종료 | passed — native OS 격리·guardian·임시 디렉터리 정리의 로컬 실증 |
| 157 공급자 응답과 조사 검증 | passed — 로컬 합성 JSON/SSE·schema·근거·v8와 진단 보완 검증. 최신 실제 response 진단은 created 내부 response의 추가 필드5개로 거부·이름/의미 미확인 |
| 158 단건 전달·취소·timeout | passed — 로컬 단건·취소·시간 제한·종료 검사. 원격 취소 완료는 미검증 |
| 159 중단과 재시작 복구 | passed — 실제 로컬 SIGKILL·소비 유지·취소 후 복구·불확실 BLOCKED |
| 160 private 보관과 보고 사실성 | passed — 링크/권한·내용/감사/marker·합성 검증의 not_run 표시 |
| 161 CLI·기존 회귀 | passed — v9의 native 포함 전체1005개·집중121개·lint/typecheck/build 통과·실패0·skip0. 직전 response 진단 실제 호출 당시985개 검증 이력 보존 |
| 162 구체 승인된 실제 단건 조사 | 미완료 — 실제 upstream14회 모두 failed. 실행 파일 부재 v4의 upstream0회 실패는 별도 기록. 소비 승인15개·조사 보고서 없음·자동 재시도0 |

## v1 승인한 실제 1회 결과

작업 `06b4c0da-132c-48ac-839d-eaf040df6672`는 사용자 승인 뒤 실제 1회 실행했다. 계획 hash는 `732d73e524122a0df7b22bfa96243f06377ce4007b1602d5e10e3d6a37c4f3ea`, 본문 hash는 `bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe`다. 본문 UTF-8 8,897바이트에는 합성 `README.md` 1~8줄·`src/controller.ts` 1~6줄·`src/service.ts` 1~10줄·`src/settings.ts` 1~3줄만 포함했다.

| 항목 | 기록 |
| --- | --- |
| 승인 ID | `bb1d983a-60b1-4271-ba62-697199d0dca5` |
| 승인 유효 기간 | `2026-11-13T01:55:44.487Z` ~ `2026-11-13T02:05:44.487Z` (10분) |
| attempt ID | `36f21741-a004-4507-9804-24ac7832e375` |
| 시작·전달 예약·종료 | UTC `01:56:07.209` · `01:56:07.215` · `01:56:09.619` |
| 최종 작업 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED` |
| 호출 진단 | `READONLY_LIVE_HEADER_LIMIT`, `upstreamCalls=1` |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |
| 승인 소비·보고서 | 승인 사용됨, 유효 조사 보고서 없음, 재호출 없음 |

첫 호출에서는 원시 응답 헤더·HTTP status를 보관하지 않았다. 따라서 기존 한도인 헤더 32개 초과인지 총 8KiB 초과인지, 공급자가 어떤 HTTP status를 반환했는지 구분할 수 없다. 인증 접근·upstream 1회 기록만으로 공급자 인증이나 추론이 성공했다고 주장하지 않는다. 실패 승인은 복원하지 않으며 기존 작업은 다시 실행하지 않는다.

## v2 보완과 별도 승인한 실제 1회 결과

요청 헤더 한도 32개·8KiB와 본문을 유지하면서 v2 응답 헤더 한도를 별도 64개·16KiB로 분리했고, 원시 값 없이 헤더 count/bytes·HTTP status 진단을 추가했다. 기존 v1 설정/profile/한도/hash를 보존해 실패 작업과 승인을 계속 조회할 수 있다. 보완은 새 `readonly-live-codex-v2`/`codex-chatgpt-sse-v2`에만 적용하며 버전 간 승인 재사용을 거부한다. 로컬 회귀와 기존 실제 v1 DB 보존 검증을 완료한 뒤 새 v2 계획에 별도 승인을 받아 실제 1회 실행했다.

| 항목 | v2 기록 |
| --- | --- |
| 작업 ID | `fc36b731-be6e-477a-be31-e7de897c5a06` |
| 계획 hash | `eeb8490452a33e4110dde211e39a66f8c99e70b93439d59d55fcedcb1699c2c1` |
| profile hash | `3001f75dfa704ff87074d84dd67fd8e9019e3e76a8f89b1d3c414f1dd6a97f57` |
| 본문 hash·크기 | `bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe`, 8,897바이트로 v1과 동일 |
| 읽기·전송 범위 | 합성 README 1~8줄·controller 1~6줄·service 1~10줄·settings 1~3줄로 동일 |
| 계획 만료 | `2026-11-14T02:09:38.633Z` |
| 승인 ID | `ebaf3000-bac9-4472-ad4c-55b45c5e92b6` |
| 승인 유효 기간 | `2026-11-13T02:17:51.189Z` ~ `2026-11-13T02:27:51.189Z` (10분) |
| 승인 사용 시각 | `2026-11-13T02:18:19.636Z` |
| attempt ID | `68eeaf7c-5a00-4f47-89c2-37912c44c363` |
| 시작·전달 예약·종료 | UTC `02:18:19.636` · `02:18:19.643` · `02:18:20.794` |
| 최종 작업 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE`, `upstreamCalls=1` |
| HTTP 관찰 | status `200`, headerCount `35`, headerBytes `3124` |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |
| 승인 소비·보고서 | 승인 사용됨, 유효 조사 보고서 없음, 자동 재시도 없음 |

HTTP 200은 전송 계층에서 관찰한 status이며 완성 응답·추론 성공을 뜻하지 않는다. 원시 응답을 보관하지 않았으므로 v2의 정확한 거부 단계와 원인은 확인하지 못했다. v2 종료 시점까지 실제 호출은 서로 다른 계획·승인으로 총 2회·자동 재시도 0회였으며 두 실패 승인은 소비 상태를 유지한다. 고유 826개 회귀 결과는 이 v2 실제 호출에 사용한 코드의 기록이며 이후 v3 보완 검증을 대신하지 않는다.

## v3 로컬 보완과 별도 승인한 실제 1회 결과

공식 응답 계약과 기존 decoder의 metadata 허용 형식 차이를 로컬에서 재현했다. 검토 대상은 `access_programs`·`reasoning`·`metadata`의 null, 숫자 `cache_write_tokens`, `text.format.description`과 reasoning 세부 필드 형식이다. 이것이 두 실제 실패의 원인이었다고 단정하지 않는다. 원시 응답 없이 확인할 수 있는 재현 범위만 보완한다.

새 `readonly-live-codex-v3`/`codex-chatgpt-sse-v3`와 decoder `readonly-live-response-v2`에만 보완을 적용하며, v1·v2 설정/profile/계획 hash는 유지한다. 원시 응답 값 없이 단계별 오류를 남기고 metadata마다 정확한 타입·한도를 검사한다. 요청 본문과 v2 한도는 유지한다. 설정 예제를 v3로 바꾸고 v1·v2 조회·취소·복구 보존 및 교차 승인 거부 CLI 검사, 전체 841개 회귀를 통과했다. 기존 실제 v1·v2 계획·payload·원본 identity 검사도 통과했다. 이 코드로 새 v3 계획에 별도 승인을 받아 실제 1회 실행했다.

v3 profile에는 `responseHeaderPolicy=discard-set-cookie-v1`을 결합한다. 중복 Set-Cookie는 정상 응답에서 가능하므로 모든 항목을 헤더 수·바이트 한도와 문자 검사에 포함한 다음 즉시 버린다. 쿠키 저장·전달·재사용은 없으며 다른 중복 헤더는 모두 거부한다. Set-Cookie 중복이 실제 v2 실패의 원인이었다는 증거는 없다. [Node.js 응답 헤더의 중복 처리](https://nodejs.org/download/release/v26.2.0/docs/api/http.html#messageheaders)를 계약 검토 근거로 사용한다.

| 항목 | v3 기록 |
| --- | --- |
| 작업 ID | `a165d3e4-8cd3-4b64-9e7c-669a09731cda` |
| 계획 hash | `e51cb5efc54b09f21214e833864592df6b64aa92400933b0a64e23473b3bdc90` |
| profile hash | `7db314ddc980093a9b83a60e8e93c60ca535f6bd760556ce5452df7b57f9b784` |
| 명세 hash | `da7f8d03e4a39387c4158d39370526a48243523c9bcdfddbc0d4baea4e082fae` |
| 본문 hash·크기 | `bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe`, 8,897바이트로 v1·v2와 동일 |
| 읽기·전송 범위 | 합성 README 1~8줄·controller 1~6줄·service 1~10줄·settings 1~3줄로 동일 |
| 계획 만료 | `2026-11-14T02:28:45.945Z` |
| 승인 ID | `5525bec5-72f1-43ca-bda8-03b30806589d` |
| 승인 유효 기간 | `2026-11-13T02:49:38.720Z` ~ `2026-11-13T02:59:38.720Z` (10분) |
| 승인 사용 시각 | `2026-11-13T02:50:02.566Z` |
| attempt ID | `34ed21ee-f5bb-4de8-a448-ab87bc9bf373` |
| 시작·전달 예약·종료 | UTC `02:50:02.566` · `02:50:02.573` · `02:50:03.790` |
| 최종 작업 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, `report=null` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE_HTTP_HEADERS`, `upstreamCalls=1` |
| HTTP 관찰 | status `200`, headerCount `35`, headerBytes `3131` |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |
| 승인 소비·보고서 | 승인 사용됨, 유효 조사 보고서 없음, 자동 재시도 없음 |

`run-result.json`과 `call-report.json`에서 위 상태·오류·시각을 확인했다. 이번 정적 오류로 거부 범위가 HTTP 헤더 검사임을 확인했지만 정확한 조건은 아직 미확인이다. HTTP 200을 완성 응답이나 추론 성공으로 해석하지 않는다. v1·v2·v3 각각 별도 승인 1회씩 총 실제 호출은 3회이며 자동 재시도는 0회다.

독립 사후 검증에서 합성 원본 파일 4개·Git 파일 11개를 포함한 총 33개 항목과 identity·HEAD가 그대로임을 확인했다. controller PID 9431, guardian PID 9446, child PID 9447과 프로세스 그룹의 종료 및 모델 임시 디렉터리 부재도 확인했다. 승인·실패 감사 기록과 합성 원본/Git은 보존했다. 이 실행은 841개 회귀를 통과한 v3 코드 그대로 수행했고 이후 v4 보완에 대한 검증은 별개다. 이 시점까지 추가 실제 호출은 없었다.

## v4 진단 승인과 외부 전송 전 실패

HTTP 헤더 형식과 거부 조건별 정적 진단을 새 `readonly-live-codex-v4`/`codex-chatgpt-sse-v4`에서 보완했다. decoder는 `readonly-live-response-v3`, 헤더 정책은 `http-token-discard-set-cookie-v1`이며 v3 metadata/SSE를 유지한다. HTTP token 헤더 이름, ASCII·HTAB 값, MIME OWS·따옴표 UTF-8과 identity 대소문자를 정규화하고 비ASCII·압축·Location·Retry-After는 계속 거부한다. Set-Cookie는 한도·문자 검사 뒤 폐기하고 다른 중복 헤더는 거부한다. 원시 응답이나 헤더 값은 보관하지 않는다.

본문·모델·요청 헤더·한도와 v1·v2·v3 기존 계약은 유지한다. v4 설정 예제와 구형 세 버전의 조회·취소·복구/교차 승인 거부 CLI 검사를 추가했고 당시 전체 852개 회귀와 lint·typecheck·build를 통과했다. 이후 진단·실제 송신 경로 회귀를 보완해 872개 검증을 완료했다. 사용자가 이 진단 실행을 승인했지만 실행 파일 부재로 외부 전송 전에 실패했으므로 실제 헤더 조건에 대한 새 관찰은 없다.

최종 빌드로 실제 v1·v2·v3와 새 v4의 계획·payload·원본 identity를 다시 검증했다. 네 계획의 기존 해시가 유효하고 원본이 보존됐으며, 요청 본문은 모두 같은 8,897바이트와 `bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe` 해시를 유지한다.

| 항목 | v4 기록 |
| --- | --- |
| 작업 ID | `d3abd1f0-61ec-42a7-9e5d-0f67b13dc30e` |
| 계획 hash | `973168f3a62b048789d75ee0853ac3dfa1b748094e3bbd2ceb11d115e9bfdc9d` |
| profile hash | `6934ef0ecd1af16065406405a40056a699981df7b5ff1f0123c9c6d6048e7b30` |
| 명세 hash | `75d9ee40462afdbef86be9bf74c49685f5ee2cfea97bb3f81324aabaaa3a19d0` |
| 본문 hash·크기 | `bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe`, 8,897바이트로 이전과 동일 |
| 읽기·전송 범위 | 합성 README 1~8줄·controller 1~6줄·service 1~10줄·settings 1~3줄로 동일 |
| 계획 만료 | `2026-11-14T03:02:28.232Z` |
| 승인 ID | `f213ebfc-7620-471c-a967-5beb7b6b2113` |
| 승인 유효 기간 | `2026-11-13T04:27:16.189Z` ~ `2026-11-13T04:37:16.189Z` (10분) |
| 승인 사용 시각 | `2026-11-13T04:27:43.524Z` |
| attempt ID | `f77eb0e5-a2f7-4944-a319-53c037d0010a` |
| 시작·전달 예약·종료 | UTC `04:27:43.524` · `04:27:43.531` · `04:27:43.557` |
| 최종 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, phase `preflight` |
| 전송·인증·격리 | `upstreamCalls=0`, `http=null`, `credentialAccess=not_run`, `isolation=not_run` |
| 정리·승인 소비 | `cleanupConfirmed=true`, 승인 사용됨·복원/재사용 없음 |

확인된 로컬 원인은 승인에 고정한 Codex 0.154 실행 파일 경로가 없어 `lstat`가 `ENOENT`로 실패한 것이다. `/opt/homebrew/Caskroom/codex/0.167.2`만 남아 있었고 2026-11-13 13:26(KST)의 업데이트를 확인했으나 누가 수행했는지는 확인하지 못했다. DB의 `dispatchedAt`은 전달 예약 시각이며 실제 HTTP 송신의 증거가 아니다. 이번 시도는 승인 소비 뒤 준비 단계에서 종료됐고 인증 조회·격리 실행·외부 전송은 하지 않았다. 앞선 헤더 오류와 별개의 로컬 차단이며 이 시점의 누적 실제 upstream은 3회다.

현재 설치된 0.167.2를 변경하지 않고 [공식 0.154.0 배포](https://github.com/openai/codex/releases/tag/rust-v0.154.0)의 바이너리를 `/private/tmp/harness-codex-0.154-pinned-4gvtwabs/codex`에 확보했다. 배포 archive SHA-256과 원래 바이너리 SHA-256 `4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc`의 일치를 확인했다. `verifyReady`를 claim 전에 호출하고 이후 최신 시간·상태를 재검사하도록 보완했다. 실행 직전 기존 검사는 유지한다. 파일 삭제·변조·symlink·권한 거부와 검사 중 취소·만료에서 승인 미소비·attempt 없음·인증/전송 0회를 검증했다. 고정 바이너리의 native 합성 upstream을 포함한 전체 877개가 통과했고 로그는 `/private/tmp/work-assistant-harness-stage4c8-readiness-tests.log`다. 기존 v4 소비 승인은 재사용하지 않는다. 사후 독립 검증은 원본·Git 33개 항목/identity·HEAD 보존, controller 종료·child 미생성·sandbox 부재·artifact 10개 불변을 확인했다.

## 고정 바이너리 v4의 별도 승인 호출과 원인 확인

준비 검사를 통과한 고정 바이너리 경로로 새 계획을 만들고 별도 승인을 받아 1회 실행했다. 기존 v4 응답 계약과 본문은 유지하며 실행 파일 경로 변경을 새 config/profile/명세·계획 hash에 결합했다. 아래 기록은 `/private/tmp/harness-stage4c8-pinned-review-dHediB/run-result.json`과 해당 작업의 `call-report.json`에서 확인했다.

| 항목 | 고정 경로 v4 기록 |
| --- | --- |
| 작업 ID | `72435220-e085-45a0-b92d-b01917e760c2` |
| 계획 hash | `1d77b320e3e4f1669f9b0a84d14537d5f4f2434294a26690c23b4e985b2ff92c` |
| profile hash | `2206443c30906607e370c98f00fc3b75a492c7fd79eedf356213f080f38df282` |
| 명세 hash | `241b4f18dbd36fb911f53eef1671a01915f9c9ac8573410e7b8c266723f32b32` |
| 본문 hash·크기 | `bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe`, 8,897바이트로 이전과 동일 |
| 승인 ID | `638b7113-6bce-46cc-80fe-0747afd91ef7` |
| 승인 유효 기간 | `2026-11-13T04:50:42.896Z` ~ `2026-11-13T05:00:42.896Z` (10분) |
| 승인 사용 시각 | `2026-11-13T04:51:08.912Z` |
| attempt ID | `25281b4c-2ddc-422b-8c2d-c74b3a553827` |
| 시작·전달 예약·종료 | UTC `04:51:08.912` · `04:51:08.919` · `04:51:10.238` |
| 최종 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, `report=null` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE_DECODE_CONTENT_TYPE_MISSING`, phase `request`, `upstreamCalls=1` |
| HTTP 관찰 | status `200`, headerCount `35`, headerBytes `3133` |
| 형식 진단 | `mediaType=missing`, `contentEncoding=missing`, `cookieCount=3` |
| 나머지 헤더 진단 | 이름·이전 이름 규칙·값 위반, 탭 값, 쿠키 이외 중복 모두 0. Location·Retry-After 없음 |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |
| 승인 소비·보고서 | 승인 사용됨, 유효 조사 보고서 없음, 자동 재시도 없음 |

이번 응답에서 `Content-Type`이 없었고 v4 decoder가 이를 필수로 요구해 거부했다는 원인은 정적 오류와 MIME 분류로 확인했다. 헤더 개수·바이트 초과나 이름·값 문법 위반으로 실패한 것이 아니다. 쿠키 3개는 검사 후 폐기 대상이며 이 실패의 원인으로 관찰되지 않았다. 원시 응답 본문은 보관하지 않았으므로 본문이 완성된 정상 JSON/SSE였는지, 추론이 성공했는지는 확인하지 못했다. 이 증거를 MIME 진단이 없었던 v1·v2·v3의 정확한 실패 원인으로 소급하지 않는다.

이 시점의 실제 upstream은 이전 3회에 이번 1회를 더해 총 4회다. 실행 파일 부재로 종료한 앞선 v4의 upstream 0회 시도까지 포함하면 당시 소비된 승인은 다섯 개이며 모두 별도 계획·승인에 속한다. 소비 승인은 복원하거나 재사용하지 않는다.

## 4-C-4 성공 경로와 비교한 증거 한계

| 경계 | 4-C-4 성공 경로 | 4-C-8 경로 |
| --- | --- | --- |
| 목적지·인증 | 기존 ChatGPT 로그인과 고정 Codex URL | 같은 목적지·인증 방식 |
| HTTP 수신 | `fetch`가 응답을 처리하며 압축을 자동 해제 | `https`의 원시 응답을 직접 처리 |
| 응답 헤더 | 별도 엄격한 헤더 검증 없음 | 원시 헤더·MIME·encoding을 먼저 검증 |
| 본문 | JSON 또는 SSE 본문을 판독 | 헤더 통과 뒤 제한된 decoder와 조사 schema로 검증 |

따라서 4-C-4의 성공만으로 새 헤더 검사의 호환성을 증명할 수 없다. 기존 실제 기록에는 원시 헤더와 MIME/encoding 분류가 없으므로 세 실패의 정확한 조건을 사후 복원할 수 없다. HTTP 200·헤더 35개·3,131바이트라는 동일 요약값을 가진 정상 합성 응답이 통과하고, 별도 합성 사례에서는 원시 헤더의 HTAB 처리와 decoder의 underscore 헤더 이름 처리 실패가 각각 재현됐다. 서로 다른 검사 경계의 결과가 같은 요약값으로 나타날 수 있으므로 어느 사례가 실제 응답이었는지 단정하지 않는다.

v4 허용 범위를 유지하면서 `http.headerDiagnostics`에 고정 MIME/encoding 분류, 문법 위반·HTAB·중복·쿠키 개수, Location/Retry-After 존재 여부를 기록하도록 보완했다. broker는 정확한 키·타입·enum을 검증하고 복사하며 임의 문자열과 원시 이름/값은 거부한다. 실제 송신 함수의 native request 경계만 대체하여 callback → rawHeaders → Web Response → decoder 경로를 검사했다. 보완 목적은 향후 별도 승인한 한 번의 응답에서 거부 조건을 분류할 수 있게 하는 것이며, 기존 실패 원인을 알아냈다는 뜻이 아니다. 원시 헤더·응답·인증값은 보관하지 않는다. 추가한 20개 회귀를 포함한 전체 872개가 통과했고, HTTP 경로·진단 18개는 Node 네트워크·child process 권한이 없는 상태에서도 통과했다. 최초 별도 `--test` 실행은 runner의 child process 권한 부족으로 파일 실행 전 실패했으며, 권한을 추가하지 않고 같은 프로세스로 import한 뒤 18개 모두 통과했다. 전체 로그는 `/private/tmp/work-assistant-harness-stage4c8-header-diagnostics-tests.log`다. 요청·profile·허용 조건은 변경하지 않았고, 사용자 승인 전 점검 당시 v4 계획/hash/원본 유효성과 DB의 승인 0·attempt 0을 확인했다. 이후 승인된 시도는 위와 같이 외부 전송 전에 실패했다.

## v5 보완과 별도 승인한 실제 1회 결과

새 `readonly-live-codex-v5`/`codex-chatgpt-sse-v5`에만 decoder `readonly-live-response-v4`와 `responseFormatPolicy=content-type-or-bounded-body-v1`을 결합한다. `Content-Type`이 없을 때에만 제한된 응답 본문으로 JSON 또는 SSE 형식을 식별한 뒤 기존 엄격한 응답·조사 schema 검증을 적용한다. 헤더가 있으면 기존 MIME 검증을 유지한다. `responseHeaderPolicy=http-token-discard-set-cookie-v1`, 헤더·본문·시간 한도, 압축·리다이렉트·재시도·도구 거부와 쿠키 폐기는 그대로다. 모델·요청 본문·요청 헤더를 바꾸지 않으며 v1~v4의 계약·해시·실패 기록과 승인 분리를 보존한다.

CLI 회귀는 기존 테스트를 v5와 구형 네 버전으로 확장했다. 고정 합성 설정의 v1~v4 profile/config hash, v4 대비 본문·요청 헤더·한도 불변과 양방향 교차 버전 실행 거부 후 승인 미소비를 검사한다. v5 전체 회귀는 886개 통과·실패 0·skip 0, 약 66.0초였으며 lint·typecheck·build도 통과했다. 이전 877개에서 protocol 7개·policy 1개·HTTP 경로 1개가 추가됐다. 기존 CLI 12개는 테스트 수를 늘리지 않고 v5까지 확장했다.

검증 뒤 [v5 검토서](/private/tmp/harness-stage4c8-v5-review-nLHyau/review.txt)와 계획을 준비했다. `verifyReady`·원본·계획 검사를 통과하고 동일한 본문의 구체 승인을 받은 뒤 실제 1회 실행했다. 아래 승인·시각·상태와 진단은 같은 디렉터리의 `run-result.json` 및 해당 작업의 `call-report.json`에서 확인했다. 실행에 사용한 코드는 위 886개 검증을 통과한 v5다.

| 항목 | v5 실제 실행 기록 |
| --- | --- |
| 작업 ID | `aeb837f9-70f9-4ab0-a153-7eea6a3dfb6b` |
| 계획 hash | `6650d418c908f9bb7967f14ef761a9ad73a526d7cd826059491aa585e5a2b0dc` |
| profile hash | `4044fee610d59e273b7fee63b92100082f303e97b466c5c9ec013e7935f9bbda` |
| 명세 hash | `4cc72bf69635996f126dbf94c10c60d32401d8083ccfee25ca8f05cb6a1a5c21` |
| 본문 hash·크기 | `bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe`, 8,897바이트 |
| 계획 만료 | `2026-11-14T04:58:14.389Z` |
| 승인 ID | `6d02927d-eab8-4db7-b562-fc721f9617f4` |
| 승인 유효 기간 | `2026-11-13T05:28:39.940Z` ~ `2026-11-13T05:38:39.940Z` (10분) |
| 승인 사용 시각 | `2026-11-13T05:29:07.612Z` |
| attempt ID | `580e02de-1d93-4a68-8f35-0581e7b27ada` |
| 시작·전달 예약·종료 | UTC `05:29:07.612` · `05:29:07.622` · `05:29:09.057` |
| 최종 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, `report=null`, `responseHash=null` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE_JSON`, phase `request`, `upstreamCalls=1` |
| HTTP 관찰 | status `200`, headerCount `35`, headerBytes `3135` |
| 형식 진단 | `mediaType=missing`, `contentEncoding=missing`, `cookieCount=3` |
| 나머지 헤더 진단 | 이름·이전 이름 규칙·값 위반, 탭 값, 쿠키 이외 중복 모두 0. Location·Retry-After 없음 |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |
| 승인 소비·보고서 | 승인 사용됨, 유효 조사 보고서 없음, 자동 재시도 없음 |

이번에도 `Content-Type`은 없었지만 v5가 헤더 검사를 통과한 뒤 JSON 처리 단계에 도달했다. 관찰된 오류만으로 JSON 구문·구조 등의 세부 거부 원인을 구분할 수 없으며, 원시 응답을 보관하지 않아 정확한 본문을 사후 복원할 수 없다. HTTP 200이나 검사 단계의 진전만으로 정상 본문·추론 성공을 주장하지 않는다.

독립 사후 감사에서 원본/Git 33개 항목과 부모 경로 7개의 identity 보존, 관련 프로세스의 종료를 확인했다. 정리 확인과 승인 소비 상태도 유지한다. 이 시점의 누적 외부 upstream은 총 5회이며, 별도 upstream 0회 실패를 포함한 소비 승인은 총 6개다. 실패 승인은 복원하거나 재사용하지 않는다.

## JSON 진단 보완과 별도 승인한 실제 1회 결과

`readonly-live-protocol.ts`에 JSON 처리 위치 `response`/`sse`와 고정 원인 `syntax`/`depth`/`duplicate-key`/`unicode`/`sensitive-content`/`canonicalization`만 담는 진단을 추가했다. 원문·필드명·값·파서 오류 메시지는 포함하지 않는다. 정확한 own data property·키·enum 검증을 통과한 복사본만 반환하며 accessor·추가 키·잘못된 값은 거부한다. broker는 transport 오류와 분리한 로컬 decoder 오류에서만 진단을 취하고 `call-report.json`의 `json`에 기록한다. JSON 오류가 아니면 null이다.

기존 v1~v5의 응답 허용·거부 규칙, 공개 오류 코드, 민감정보 검사를 유지했다. 이전 실제 계획 6개의 계획·payload·설정·profile 해시 및 요청 본문을 현재 정책으로 재검증해 모두 통과했다. 진단 보완으로 과거 응답의 미기록 정보를 복원하거나 실제 세부 원인을 확정하지 않는다.

protocol 6개·broker 2개·native process 1개 회귀를 추가했다. focused 72개가 통과했고, 전체 회귀는 895개 통과·실패 0·skip 0, 약 75.2초였다. lint·typecheck·build·diff 검사도 통과했다. 합성 native 실패 응답의 정적 진단·단건 호출·인증 미접근·원본 보존·프로세스 정리를 확인했으며 이 로컬 검사에는 실제 모델을 사용하지 않았다. 로그는 `/private/tmp/work-assistant-harness-stage4c8-json-diagnostics-tests.log`다. 이 895개 검증을 통과한 코드로 아래의 별도 승인된 실제 진단 호출을 수행했다.

[진단 검토서](/private/tmp/harness-stage4c8-json-review-nfCdlk/review.txt)는 아래 계획을 설명한다. 기존 v5와 요청 본문·명세·profile/config를 그대로 유지하고 새 조사 ID·원본 identity·유효 기간을 결합했다. 준비 검사 뒤 구체 승인을 받아 실제 1회 실행했으며, 같은 디렉터리의 `run-result.json`과 해당 작업의 `call-report.json`에서 아래 안전한 진단 필드를 확인했다.

| 항목 | JSON 진단 실제 실행 기록 |
| --- | --- |
| 작업 ID | `2166a9b2-3769-4352-995e-87dc0c00a8c7` |
| 계획 hash | `35627d6253718d126f4cc790133eb100e1b208ac8c54c260e3d0a1f60fa696c8` |
| 본문·명세·profile | 직전 v5와 동일, 합성 파일 4개·요청 8,897바이트 |
| 모델·인증·목적지 | `gpt-6.1-sol`, 기존 Codex 로그인, `https://chatgpt.com/backend-api/codex/responses` |
| 계획 만료 | `2026-11-14T05:42:13.442Z` |
| 승인 ID | `e8e81995-aa47-4fdc-8bf7-0dad7a471904` |
| 승인 유효 기간 | `2026-11-13T05:46:52.899Z` ~ `2026-11-13T05:56:52.899Z` (10분) |
| 승인 사용 시각 | `2026-11-13T05:47:11.242Z` |
| attempt ID | `ca32f74e-1648-4e72-9a80-7a64c0407db8` |
| 시작·전달 예약·종료 | UTC `05:47:11.242` · `05:47:11.251` · `05:47:12.730` |
| 최종 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, `report=null`, `responseHash=null` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE_JSON`, phase `request`, `upstreamCalls=1` |
| JSON 진단 | `origin=sse`, `reason=sensitive-content` |
| HTTP 관찰 | status `200`, headerCount `35`, headerBytes `3127` |
| 형식 진단 | `mediaType=missing`, `contentEncoding=missing`, `cookieCount=3` |
| 나머지 헤더 진단 | 이름·이전 이름 규칙·값 위반, 탭 값, 쿠키 이외 중복 모두 0. Location·Retry-After 없음 |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |
| 승인 소비·보고서 | 승인 사용됨, 유효 조사 보고서 없음, 자동 재시도 없음 |

이번 오류는 SSE의 JSON 처리에서 민감정보 검사에 걸렸다는 뜻이다. `syntax`로 분류된 문법 오류가 아니며 어떤 필드·값이 검사에 걸렸는지는 원문을 보관하지 않아 확인하지 못했다. 실제 비밀이 포함됐는지 정상 metadata 등에 대한 오탐인지는 아직 구분할 수 없고, 완성 본문이나 추론 성공도 확인하지 못했다. 이 새 응답의 진단을 이전 v5 응답의 미기록 세부 원인으로 소급하지 않는다.

이 시점의 누적 실제 upstream은 총 6회이며 별도 upstream 0회 실패까지 소비 승인은 총 7개다. 모두 별도 승인에 따른 작업당 1회이고 자동 재시도는 0회다. 기존 소비 승인은 복원하거나 재사용하지 않는다.

## 민감정보 검사 범위 비교와 로컬 재현

4-C-4의 `normalizeCodexResponse`는 제공자 metadata를 보관·검사하지 않고 완성 assistant text를 추출하며, 후속 제안 정책에서 정확한 제안 schema와 content를 검사한다. 4-C-8은 구조 검증 전에 각 SSE JSON 전체를 canonical 문자열로 바꿔 민감정보 정규식을 적용하고 이후 개별 text도 검사한다. 두 경계가 다르므로 4-C-4 성공이 4-C-8의 metadata 검사 호환성을 증명하지 않는다.

네트워크 권한이 없는 합성 재현에서 기존 token counts와 실제 승인된 출력 schema echo는 양쪽 모두 통과했다. 반면 공식 usage의 `input_tokens_details.cache_write_tokens_details`가 null이거나 `ttl_12h_tokens`/`ttl_30m_tokens` 정수 객체인 경우 4-C-4 정규화는 통과하고 4-C-8은 `{origin:sse, reason:sensitive-content}`로 거부했다. [OpenAI 공식 usage 형식](https://developers.openai.com/api/reference/resources/responses/methods/create)에 있는 정상 메타데이터와 민감 패턴 검사가 충돌하는 재현이다. 일반 schema의 token 속성 및 token_count metadata에서도 같은 조건을 재현했지만 현재 승인 schema와는 다르다. 실제 거부 응답에 이 필드가 포함됐는지는 알 수 없으며, 이 사례를 실제 원인으로 단정하지 않는다.

[로컬 재현 기록](/private/tmp/harness-readonly-sensitive-nou0IO/findings.json)은 합성 분류 결과만 담는다. production 수용 조건은 변경하지 않았다. 이 재현 뒤 아래의 패턴·영역 진단과 새 계획을 준비했다. 실제 비밀정보와 숫자 메타데이터 오탐을 구별하기 전 임의 키를 허용하거나 민감정보 검사를 제거하지 않는다.

## 민감정보 패턴·영역 진단 구현과 별도 승인한 실제 1회 결과

기존 `call-report.json`의 `json={origin, reason}` 두 키를 유지하고 별도의 `sensitive`에 고정 enum 네 개만 기록한다. JSON 민감정보 거부가 아니거나 검증 가능한 진단이 없으면 null로 남긴다. 원문 필드명·값·일치한 문자열·위치 offset·파서 오류 메시지는 저장하지 않는다.

| 진단 키 | 고정 값 |
| --- | --- |
| `pattern` | `private-key-block`, `provider-key-prefix`, `bearer-token`, `credential-assignment`, `other`, `multiple` |
| `area` | `known-usage-counter`, `output-text`, `reasoning-text`, `instructions`, `schema`, `metadata`, `other`, `multiple` |
| `usageField` | `cache-write-details`, `cache-write-ttl`, `input-details`, `output-details`, `other`, `not-applicable`, `multiple` |
| `usageShape` | `null`, `integer`, `count-object`, `other`, `not-applicable`, `multiple` |

기존 민감정보 판정에 사용한 `canonical(redactionView(parsed))`에서 실제 정규식 일치 범위를 구한다. 같은 canonical 문자열에 매핑한 정적 영역 중 그 범위를 포함하는 영역에만 분류를 귀속한다. `known-usage-counter`는 공식 응답/SSE 경로와 허용한 정확한 usage 형태, 기존 redaction 투영의 일치까지 확인한 경우만 사용한다. 다른 위치의 같은 이름이나 비정상 형태는 known usage로 승격하지 않는다. 여러 패턴·영역이 섞이거나 귀속이 불확실하면 `multiple`/`other`로 남긴다. 정확한 키·own data property·enum 조합을 검사한 복사본만 broker와 호출 기록에 전달한다.

분류는 기존 민감정보 거부가 결정된 뒤 관찰에만 사용한다. 분류기 예외·실패에도 원래 민감정보 거부를 유지하며 응답 수용 조건·공개 오류 code·profile/config/body hash는 변경하지 않는다. 이 구현은 원인 분류 기능이며 앞선 실제 응답이 known usage 오탐이었다는 증거가 아니다. 이번 보완의 lint·typecheck·build와 전체 907개 회귀가 통과했다(실패0·skip0, 67.6808초). 기존 895개에서 민감정보 단위7개·protocol3개·broker1개·native process1개를 추가했고 focused77개도 통과했다. 직전 895개 결과는 이미 수행한 JSON 진단 호출에 사용한 코드의 이력으로 보존한다.

새 작업의 [준비 검사](/private/tmp/harness-stage4c8-sensitive-review-kaPDhL/readiness.json)와 [원본 기준 기록](/private/tmp/harness-stage4c8-sensitive-review-kaPDhL/pre-run-repository.json)을 작성했다. 이전 JSON 진단 계획과 요청 본문·설정·profile·명세가 동일하고, 고정 0.154 바이너리 경로·SHA와 `verifyReady`·`assertPlan`·`validatePayload`·원본 검사를 통과했다. 원본/Git 33개 항목의 바이트·identity, 부모 7개 identity, HEAD/main과 DB hash를 전후 비교해 보존을 확인했다. 준비 검사에는 인증·프로세스·모델·외부 전송을 사용하지 않았고 격리 실증은 `not_run`이다. 최종 빌드로 과거7개·신규1개 총8개 계획의 assertPlan/payload/hash 보존과 새 원본·verifyReady를 다시 확인했다. [최종 빌드 검증](/private/tmp/harness-stage4c8-sensitive-review-kaPDhL/final-build-validation.json)에 근거를 남겼다.

사용자 승인 후 이 계획으로 실제 1회를 실행했다. [실행 결과](/private/tmp/harness-stage4c8-sensitive-review-kaPDhL/run-result.json)와 [호출 진단](/private/tmp/harness-stage4c8-sensitive-review-kaPDhL/data/readonly-live-runs/5f6180cc-286d-47d1-a88e-7f1c8385ef36/call-report.json)의 안전한 필드만 아래에 기록한다.

| 항목 | 민감정보 패턴·영역 진단 실제 기록 |
| --- | --- |
| 작업 ID | `5f6180cc-286d-47d1-a88e-7f1c8385ef36` |
| 계획 hash | `0527d809cee30ff66333bb1f0fd16b8565a32c699266c89965bd7cc837c34e0a` |
| 설정·profile | 기존 `readonly-live-codex-v5` / `codex-chatgpt-sse-v5` |
| 본문·명세·profile hash | 직전 JSON 진단 계획과 동일, 합성 파일 4개·요청 8,897바이트 |
| 계획 만료 | `2026-11-14T05:56:19.966Z` |
| 호출 전 준비 상태 | 당시 `AWAITING_APPROVAL`, 승인0·attempt0·소비0·추가 전송0 |
| 호출에 사용한 코드 검증 | 전체907개·lint/typecheck/build 및 최신 빌드 준비 재확인 passed |
| 승인 ID | `ce815056-e0f4-48e3-be0b-4b06eb42ad46` |
| 승인 유효 기간 | `2026-11-13T06:13:28.080Z` ~ `2026-11-13T06:23:28.080Z` (10분) |
| 승인 사용 시각 | `2026-11-13T06:13:42.369Z` |
| attempt ID | `a7266d0a-b27d-4f1d-849a-789180f6c263` |
| 시작·전달 예약·종료 | UTC `06:13:42.369` · `06:13:42.378` · `06:13:43.717` |
| 최종 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, `report=null`, `responseHash=null` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE_JSON`, phase `request`, `upstreamCalls=1` |
| JSON 진단 | `origin=sse`, `reason=sensitive-content` |
| 민감정보 진단 | `pattern=credential-assignment`, `area=other`, `usageField=not-applicable`, `usageShape=not-applicable` |
| HTTP 관찰 | status `200`, headerCount `35`, headerBytes `3131` |
| 형식 진단 | `mediaType=missing`, `contentEncoding=missing`, `cookieCount=3` |
| 나머지 헤더 진단 | 이름·이전 이름 규칙·값 위반, 탭 값, 쿠키 이외 중복 모두 0. Location·Retry-After 없음 |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |
| 승인 소비·보고서 | 승인 사용됨, 유효 조사 보고서 없음, 자동 재시도 없음 |

이번 응답에서 거부한 패턴 종류는 `credential-assignment`로 좁혀졌지만 `area=other`여서 정확한 영역·필드는 확인하지 못했다. 이 값만으로 실제 자격증명이 포함됐거나 공식 usage의 정상 값이 오탐됐다고 판단할 수 없다. 원문·일치 문자열·offset을 보관하지 않았으며 분류 누락을 로컬에서 분석 중이다. 응답 수용 조건이나 기존 계약의 허용 범위는 변경하지 않았다.

이 시점의 누적 실제 upstream은 총 7회 모두 실패했고 별도 upstream 0회 실패까지 소비 승인은 총 8개다. 각 작업은 별도 승인한 1회 실행이며 자동 재시도·소비 승인 복원은 없다. 이후 추가 호출 없이 아래 귀속 진단과 새 계획을 준비했다.

## 민감정보 귀속 진단 구현과 별도 승인한 실제 1회 결과

`credential-assignment` 일치가 `other`로 남은 이유를 구분하기 위해 기존 `json` 두 키와 `sensitive` 네 enum을 유지하고 `sensitiveAttribution`에 다음 열 고정 enum을 추가했다. 원인 수정이나 응답 허용 조건 확대가 아닌 관찰 확장이다.

| 진단 키 | 고정 분류 범위 |
| --- | --- |
| `event` | 직접 응답, 등록 SSE 생명주기·오류·출력/추론 text·output item·content part, `missing`/`other` |
| `responseMarker` | `response`, `missing`, `null`, `other`, `not-applicable` |
| `responseStatus` | `in-progress`, `completed`, `failed`, `incomplete`, `cancelled`, `queued`, `missing`, `other`, `not-applicable` |
| `reason` | `attributed`, `event-gate`, `response-marker-gate`, `usage-shape`, `usage-projection`, `unmapped-property`, `text-content`, `parent-span`, `multiple`, `unresolved` |
| `matchExtent` | `property`, `parent`, `text`, `multiple`, `unresolved` |
| `field` | 고정 사전의 token count/detail·cache write·reasoning·max output·credential 속성 분류와 `other`/`not-property`/`multiple`/`unresolved` |
| `valueType` | `null`, `integer`, `number`, `string`, `boolean`, `object`, `array`, `multiple`, `unresolved` |
| `usageValidation` | `valid-known`, `missing`, `invalid-shape`, `invalid-projection`, `not-applicable` |
| `providerError` | 인증·권한·rate limit·잘못된 요청/schema·context 한도·모델 부재·서버 오류의 고정 분류와 `none`/`other` |
| `providerParameter` | model·instructions·input·text format·tools·stream·store·max output·authentication의 고정 분류와 `none`/`other` |

실제 판정 문자열 `canonical(redactionView(parsed))`에서 정규식 일치가 시작한 속성과 전체 일치 범위를 별도로 계산한다. 시작 속성은 고정 사전의 분류만 기록하고 전체 일치가 그 속성을 벗어나면 `parent`로 구분한다. 서로 다른 경로의 일치는 같은 enum 결과라도 `multiple`로 남긴다. event 조건과 usage 형태·투영 검사는 독립적으로 관찰한다. 미등록 code·parameter·status·경로는 `other`로 남기며, provider 분류는 해당 코드의 의미를 분류할 뿐 실제 공급자가 그 코드를 지원하거나 보냈다고 주장하지 않는다. 원문 키·값·경로·일치 문자열·offset은 보관하지 않는다. 정확한 키·own data property·enum 조합을 검증한 복사본만 기록하고 분류 실패에도 기존 민감정보 거부를 유지한다. 수용 조건·공개 오류 code·profile/config/body hash는 변경하지 않았다.

최종 focused 92개와 전체 915개 회귀가 통과했다(실패0·skip0, 전체 67.8525초). 직전 907개에서 protocol2개·민감정보 단위6개를 추가했으며 lint·typecheck·build도 통과했다. 중간 focused 실행의 1개 실패는 재빌드 전 dist의 이전 기대값 `event-gate`가 실행돼 발생했고, 최신 `text-content` 기대값으로 재빌드한 뒤 92개 모두 통과했다. 907개 결과는 직전 실제 호출에 사용한 코드의 검증 이력이다.

새 계획의 [준비 검사](/private/tmp/harness-stage4c8-attribution-review-6FvDzW/readiness.json)와 [원본 기준 기록](/private/tmp/harness-stage4c8-attribution-review-6FvDzW/pre-run-repository.json)은 이전 sensitive 계획과 본문·설정·profile·명세가 완전히 같음을 확인한다. `assertPlan`·`validatePayload`·원본 검증·고정 바이너리 `verifyReady`가 통과했고, 원본/Git33개·부모7개 identity·HEAD/main·DB hash를 보존했다. 준비 검사는 인증·프로세스·외부 호출 없이 수행했다. 최초 제한 권한의 준비 검사는 `/private` 부모 metadata 조회에서 저장 전에 중단됐고, 읽기 전용 검사로 다시 확인해 통과했다. 최신 빌드로 과거8개·신규1개 총9개 계획/payload/hash 및 새 원본·바이너리를 다시 확인했으며 [최종 빌드 검증](/private/tmp/harness-stage4c8-attribution-review-6FvDzW/final-build-validation.json)에 기록했다.

| 항목 | 귀속 진단 계획과 실제 기록 |
| --- | --- |
| 검토서 | [정확한 요청 본문과 호출 경계](/private/tmp/harness-stage4c8-attribution-review-6FvDzW/review.txt) |
| 작업 ID | `d3aa5d2d-7ed9-4a52-b904-1ada58a5a2c7` |
| 계획 hash | `3930f3cc5d85b9401e57994d7e618d1f686d3bc0535fda0800ce836f51adcdfe` |
| 설정·profile | 기존 `readonly-live-codex-v5` / `codex-chatgpt-sse-v5` |
| 본문·설정·명세·profile | 직전 sensitive 계획과 동일, 합성 파일4개·요청8,897바이트 |
| 계획 만료 | `2026-11-14T06:19:22.320Z` |
| 호출 전 준비 상태 | 당시 `AWAITING_APPROVAL`, 승인0·attempt0·소비0·전송0 |
| 최종 검사 | 전체915개·focused92개·lint/typecheck/build 및 최신 빌드 준비 재확인 passed |
| 승인 ID | `29fd13b0-399e-42e2-ab02-3436eb0db559` |
| 승인 유효 기간 | `2026-11-13T06:43:24.789Z` ~ `2026-11-13T06:53:24.789Z` (10분) |
| 승인 사용 시각 | `2026-11-13T06:43:43.910Z` |
| attempt ID | `c68d7de9-3912-4046-baee-e7c2db8f56da` |
| 시작·전달 예약·종료 | UTC `06:43:43.910` · `06:43:43.919` · `06:43:45.201` |
| 최종 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, `report=null`, `responseHash=null` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE_JSON`, phase `request`, `upstreamCalls=1` |
| JSON·민감정보 진단 | `origin=sse`, `reason=sensitive-content`; `pattern=credential-assignment`, `area=other`, usageField/usageShape `not-applicable` |
| 이벤트·응답 분류 | `event=created`, `responseMarker=response`, `responseStatus=in-progress` |
| 일치 귀속 | reason·matchExtent·field·valueType 모두 `multiple` |
| usage·공급자 분류 | `usageValidation=invalid-shape`, `providerError=none`, `providerParameter=none` |
| HTTP 관찰 | status `200`, headerCount `35`, headerBytes `3133` |
| 형식 진단 | `mediaType=missing`, `contentEncoding=missing`, `cookieCount=3` |
| 나머지 헤더 진단 | 이름·이전 이름 규칙·값 위반, 탭 값, 쿠키 이외 중복 모두0. Location·Retry-After 없음 |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |
| 승인 소비·보고서 | 승인 사용됨, 유효 조사 보고서 없음, 자동 재시도 없음 |

[실행 결과](/private/tmp/harness-stage4c8-attribution-review-6FvDzW/run-result.json)와 [호출 진단](/private/tmp/harness-stage4c8-attribution-review-6FvDzW/data/readonly-live-runs/d3aa5d2d-7ed9-4a52-b904-1ada58a5a2c7/call-report.json)의 안전한 필드만 기록했다. 이번에는 생성 이벤트와 진행 중 응답 표식은 확인했지만 복수 일치의 구체적인 경로·필드를 알 수 없다. `usageValidation=invalid-shape`는 로컬 분류기가 해당 usage를 등록된 형태로 확인하지 못했다는 뜻이며 공급자의 응답이 잘못됐다는 증거가 아니다. [공식 `response.created` 예제](https://developers.openai.com/api/reference/resources/responses/streaming-events)의 정상 `usage:null`도 당시 분류기에서는 `invalid-shape`가 될 수 있으므로 공급자 schema 불량으로 단정하지 않으며, 이번 실제 usage가 null이었다는 뜻도 아니다. `providerError=none`도 완성 응답·추론 성공을 뜻하지 않는다.

이 시점의 누적 upstream은8회 모두 실패했고 별도 upstream0회 실패까지 소비 승인은9개다. 각 작업의 별도 승인·단건 실행과 자동 재시도0회를 유지한다. 원문을 저장하거나 허용 조건을 바꾸지 않았으며 이후 추가 실행 없이 아래 집계 진단을 준비했다.

## 민감정보 일치 집계 구현과 새 계획

기존 `json`·`sensitive`·`sensitiveAttribution`을 유지하고 `sensitiveMatches={entries, observedMatches, overflow}`를 추가했다. 각 entry는 `pattern`·`region`·`reason`·`matchExtent`·`field`·`valueType` 여섯 고정 enum과 발생 횟수 `count`만 가진다. 서로 다른 원문 경로라도 같은 조합이면 합산하므로 count는 고유 필드나 경로의 개수가 아니다. 정규식 일치 시작 속성과 전체 범위에 따른 분류는 유지하되 복수 결과를 하나의 `multiple`로만 접지 않고 제한된 조합별 횟수로 관찰한다.

최대128회 일치·32개 고유 조합까지만 기록한다. 더 관찰할 일치나 조합이 있으면 `overflow=true`로 남겨 일부 집계임을 표시하며, 기록한 count 합계는 `observedMatches`와 같아야 한다. 고정 키·own data property·enum 조합·계수 한도·중복 조합을 검사하고 정렬한 복사본만 전달한다. 원시 키·값·경로·일치 문자열·offset은 보관하지 않는다. 분류 실패는 null로 남기고 기존 민감정보 거부를 유지한다.

`region`은 usage·reasoning 설정·schema·metadata·출력/추론 text·instructions·공급자 오류·prompt cache 진단·tool usage·응답 metadata·event root·other의 고정 분류다. `valueType`은 null·음수가 아닌 정수·음수 정수·그 외 number·string·boolean·object·array를 구분한다. 공식 cache 진단 및 image token metadata의 이름을 관찰 사전에 추가했지만 응답 수용 필드로 허용한 것은 아니다. 응답 수용 조건·공개 오류 code·profile/config/body hash는 변경하지 않았다.

첫 전체923개가 통과했다(실패0·skip0, 73.1388초). 이후 독립 리뷰에서 생명주기 외 이벤트의 가짜 `response.usage` 경로가 분류되는 경우를 찾아 guard와 회귀1개를 추가했다. 최종 전체924개가 native 포함 통과했다(실패0·skip0, 68.0528초). 직전915개 대비 protocol2개·민감정보 단위7개를 추가했으며 별도 focused 검사는 실행하지 않았다. 신규198개는 policy17·protocol55·lifecycle44·CLI12·broker18·process8·HTTP경로10·진단9·준비검사5·민감정보 단위20개다. [최종 전체 로그](/private/tmp/work-assistant-harness-stage4c8-matches-final-tests.log)에 기록했으며 최신 lint·typecheck·build도 통과했다. 이전915개 통과는 귀속 진단 실제 호출에 사용한 코드의 기록으로 유지한다.

새 계획의 [준비 검사](/private/tmp/harness-stage4c8-matches-review-kxr14h/readiness.json)와 [원본 기준 기록](/private/tmp/harness-stage4c8-matches-review-kxr14h/pre-run-repository.json)을 마련했다. 과거9개·신규1개 총10개 계획/payload가 유효하고 이전과 동일한 본문8,897바이트·설정·profile·명세를 확인했다. 원본/Git33개·부모7개 identity·HEAD/main·DB·verifyReady가 통과했다. [최종 빌드 검증](/private/tmp/harness-stage4c8-matches-review-kxr14h/final-build-validation.json)에 최신 코드와 준비 상태의 확인을 기록했다.

| 항목 | 새 일치 집계 진단 계획 |
| --- | --- |
| 계획·검토서 | [plan.json](/private/tmp/harness-stage4c8-matches-review-kxr14h/plan.json) · [정확한 요청 본문과 경계](/private/tmp/harness-stage4c8-matches-review-kxr14h/review.txt) |
| 작업 ID | `0bdce410-6dcb-41ee-bc80-6be4da1e57a3` |
| 계획 hash | `fff7160e52cd0fb31f0d2e0fcc295abcf3ab2a6be839269e2e7a28e18b7f72ee` |
| 설정·profile | 기존 `readonly-live-codex-v5` / `codex-chatgpt-sse-v5` |
| 본문·설정·명세·profile | 직전 귀속 진단 계획과 동일, 합성 요청8,897바이트 |
| 준비 당시 상태 | `AWAITING_APPROVAL`, 승인0·attempt0·소비0·전송0 |
| 최종 검사 | event 경계 보완 후 native 포함 전체924개·lint/typecheck/build passed·실패0·skip0 |
| 실제 실행 | 아래 별도 승인1회 실행 기록 참조. 승인 소비·upstream 각1회, FAILED |

이 준비 이후 구체 승인을 받아 아래 실제 집계 진단을1회 실행했다.

## 일치 집계 실제 진단과 확인된 거부 원인

준비한 계획에 대한 별도 승인으로 실제1회를 실행했다. [실행 결과](/private/tmp/harness-stage4c8-matches-review-kxr14h/run-result.json)와 [호출 진단](/private/tmp/harness-stage4c8-matches-review-kxr14h/data/readonly-live-runs/0bdce410-6dcb-41ee-bc80-6be4da1e57a3/call-report.json)의 고정 분류만 사용했다.

| 항목 | 실제 기록 |
| --- | --- |
| 승인 ID | `fc1e705c-1633-4ba0-af6f-e143ee78ad16` |
| attempt ID | `e1649eae-de37-4257-bf43-7ce89352a373` |
| 소비·dispatch·종료 | `2026-11-13T07:13:18.690Z` · `07:13:18.721Z` · `07:13:21.014Z` |
| 결과 | FAILED, `READONLY_LIVE_INVALID_RESPONSE_JSON`, `sse` / `sensitive-content` |
| HTTP | 200, 헤더35개·3,139바이트, MIME/encoding 누락, 쿠키3개, 형식 오류·중복0 |
| 이벤트·응답 | `created` / `response` / `in-progress` |
| 집계 | `observedMatches=4`, 조합3개, `overflow=false` |
| 인증·격리·정리 | 모두 passed, upstream1회, 자동 재시도0회 |
| 보고서 | `report=null`, `responseHash=null` |

| 영역 | 필드 분류 | 값 형태 | 범위·사유 | 횟수 |
| --- | --- | --- | --- | --- |
| tool-usage | text-tokens | nonnegative-integer | parent / parent-span | 2 |
| tool-usage | input-details | object | property / unmapped-property | 1 |
| tool-usage | output-details | object | property / unmapped-property | 1 |

원인은 `tool_usage`에 있는 숫자 집계와 상세 객체의 키가 넓은 credential-assignment 정규식에 걸리는 것이다. 전체 형태를 검증한 숫자 집계에 대한 예외가 없었고, 정규식 일부 일치는 부모 범위까지 이어졌다. 공식 형태의 합성 zero 집계로 동일한 네 일치와 v5 거부를 재현했다. 실제 응답 원문을 보관하지 않았으므로 실제 객체의 전체 schema·값이0인지 또는 이후 검증까지 통과할지는 이 진단만으로 단정하지 않는다.

독립 사후 감사에서 승인·소비·attempt·upstream 각1회, 원본/Git33항목·부모7개·HEAD 보존을 확인했다. controller20828·guardian21324·child21325 및 child group 부재, sandbox 부재와 cleanupConfirmed=true를 확인했다. 현재 안전 아티팩트13개와 과거62개 해시도 유지됐다. 누적 upstream9회 실패와 별도 upstream0회 실패를 포함해 소비 승인은10개다.

## v6 호환성 수정과 별도 승인한 실제 결과

[공식 응답 명세](https://developers.openai.com/api/reference/resources/responses/methods/create)의 `tool_usage`는 base model usage와 별도인 집계다. 객체가 있으면 `image_gen`과 `web_search`가 필수이며, image 입력·출력·총 토큰과 입력 상세가 필수다. cache 수·cache 상세·출력 상세는 선택이다. 선택 객체가 존재하면 내부 두 카운터는 필수이고 명시적 null은 정의되지 않았다. 사용 기록이 없는 family도0으로 포함될 수 있으므로 이 metadata가 존재한다는 사실만으로 도구 실행을 뜻하지 않는다.

v6는 직접 response 또는 등록된 created/in_progress/completed 이벤트의 response 경로에서 marker·model·status를 확인하고, 이 집계의 정확한 키와 안전한 음수 아닌 정수만 검증한 후 민감정보 검사에 숫자 별칭을 적용한다. 원래 파싱 객체와 응답 hash는 유지한다. 문자열·추가 키·null·다른 경로는 예외에 포함하지 않는다. 구조가 유효해도0이 아닌 수치는 `READONLY_LIVE_INVALID_RESPONSE_TOOL_USAGE_ACTIVITY`로 거부한다. exact keys·safe integer·zero 제한은 공식 schema보다 좁은 하네스 정책이다. 집계0·선택 cache 필드 생략은 실제 도구 미실행의 증명이 아니며, 실제 tool call/event/output 차단을 별도로 유지한다.

새 설정/profile은 `readonly-live-codex-v6` / `codex-chatgpt-sse-v6`, decoder는 `readonly-live-response-v5`, metadata 정책은 `zero-tool-usage-v1`이다. 구형 v1~v5 계약과 hash는 보존하고 승인 재사용을 거부한다. 요청 본문·헤더·모델·목적지·한도는 그대로이며 config/profile/envelope/plan hash만 새 계약에 맞게 변경했다.

전체935개(기존726개·신규209개) 통과, 실패0·skip0, 66.6326초다. 직전924개 대비 policy2개·protocol7개·native process2개를 추가했다. policy/protocol 집중81개와 lint·typecheck·build도 통과했다. 정상 집계의 native 모의 SSE는 REPORTED, nonzero 최종 집계는 정적 오류로 FAILED이며 원본·승인 소비·재호출 금지·격리·정리를 검증했다. 실제 인증이나 외부 모델을 사용한 검사가 아니다. [전체 검사 로그](/private/tmp/work-assistant-harness-stage4c8-v6-tests.log)에 기록했다.

| 항목 | v6 실제 검증 계획 |
| --- | --- |
| 검토서 | [정확한 요청 본문과 변경 계약](/private/tmp/harness-stage4c8-v6-review-hqu7pzua/review.txt) |
| 작업 ID | `c2c1a06e-3262-4569-bc95-9d8c341ad056` |
| 계획 hash | `20a446e5d537df63e04c4ab51a34de8f4a593b29e00fe22d34c91b57dd0c3449` |
| 본문 hash | `bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe` (동일8,897바이트) |
| profile hash | `95defad85ddf58a10e193a017c92b094763de75e6eb5c104af5997c780ba8ee5` |
| config hash | `b6b10dc06df419bff23466488af4c30b2fcfb76c990503ff4d3bbe2ed743a471` |
| 명세 hash | `87cbb397c1514eba6e54470a129de5d5f0ed29c4d20686747562eb273233e73c` |
| 준비 검사 | 과거10개·신규1개 총11개 계획/payload/hash, 원본33개·부모7개·HEAD·DB·고정 바이너리 verifyReady passed |
| 승인·실행 | 아래 별도 승인1회 실행 기록 참조. 승인·attempt·소비·upstream 각1회, FAILED |

[준비 검사](/private/tmp/harness-stage4c8-v6-review-hqu7pzua/readiness.json), [원본 기준 기록](/private/tmp/harness-stage4c8-v6-review-hqu7pzua/pre-run-repository.json), [최종 빌드 검증](/private/tmp/harness-stage4c8-v6-review-hqu7pzua/final-build-validation.json)을 보존한다. 인증 접근·격리 실행·실제 전송은 준비 검사에 포함하지 않았다.

이후 구체 승인을 받아 v6를1회 실행했다. 다음은 [실행 결과](/private/tmp/harness-stage4c8-v6-review-hqu7pzua/run-result.json)와 [호출 진단](/private/tmp/harness-stage4c8-v6-review-hqu7pzua/data/readonly-live-runs/c2c1a06e-3262-4569-bc95-9d8c341ad056/call-report.json)의 안전한 필드다.

| 항목 | v6 실제 실행 기록 |
| --- | --- |
| 승인 ID | `90147772-74ed-4c2b-9b56-6ec54f01fc27` |
| 승인 유효 기간 | `2026-11-13T07:27:38.224Z` ~ `2026-11-13T07:37:38.224Z` (10분) |
| 승인 사용 시각 | `2026-11-13T07:27:52.029Z` |
| attempt ID | `9418f803-3868-4a3d-8d80-c736356111bb` |
| 시작·전달 예약·종료 | UTC `07:27:52.029` · `07:27:52.038` · `07:27:53.307` |
| 최종 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, `report=null`, `responseHash=null` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT`, phase `request`, `upstreamCalls=1` |
| HTTP 관찰 | status200, headerCount35, headerBytes3125 |
| 형식 진단 | MIME/encoding 누락, 쿠키3개, 이름·값·탭·쿠키 외 중복 위반0, Location/Retry-After 없음 |
| JSON·민감정보 진단 | `json`, `sensitive`, `sensitiveAttribution`, `sensitiveMatches` 모두null |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |

이번 응답은 헤더·JSON·민감정보 검사를 지나 SSE 이벤트 검사에서 거부됐다. 원시 응답이나 세부 SSE 진단을 보관하지 않아 정확한 거부 조건은 확인할 수 없다. sequence·이벤트 형태 중 특정 조건을 실제 원인으로 단정하지 않으며, 앞선 응답의 전체 `tool_usage` 형태·수치를 소급 확인한 것으로 해석하지 않는다.

[독립 사후 감사](/private/tmp/harness-stage4c8-v6-review-hqu7pzua/post-run-audit.json)는 원본/Git33개·부모7개 identity·HEAD 보존, 승인·소비·attempt·upstream 각1회와 report/responseHash null을 확인했다. controller80771·guardian81211·child81212 및 해당 프로세스 그룹은 종료됐고 sandbox도 남지 않았다. 누적 upstream10회 모두 실패했으며 별도 upstream0회 실패까지 소비 승인은11개다. 자동 재시도는0이고 소비 승인은 복원하지 않는다.

## v7 SSE 호환성·정적 진단 구현과 검증

[공식 `response.created` 예시](https://developers.openai.com/api/reference/resources/responses/streaming-events)의 `sequence_number`는1이다. v7는 첫 sequence를0 또는1로 지원한 뒤 이후1씩 연속되는지 확인한다. 구형 v1~v6 계약은 그대로 두고 중복·역순·누락, 허용하지 않은 이벤트·도구·출력, 응답 완료·근거·크기·시간 검사를 유지한다. 이 호환성 차이가 이번 실제 실패의 원인이었다는 뜻은 아니다.

새 `readonly-live-codex-v7` / `codex-chatgpt-sse-v7`는 decoder `readonly-live-response-v6`와 `responseSequencePolicy=zero-or-one-start-contiguous-v1`을 결합한다. v6의 zero tool usage·누락 MIME 대응·헤더 정책·요청 본문·한도는 유지하며 구형 v1~v6 계약과 hash를 바꾸지 않는다.

원시 이벤트·본문·값 없이 `sse`의 네 고정 enum만 기록한다. v3 이상 decoder에서 발생한 `READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT`에만 붙이며 공개 오류 code는 그대로다. v1·v2 또는 다른 오류의 SSE 진단은 null이다.

| 필드 | 고정 분류 |
| --- | --- |
| `event` | created, in-progress, completed, output-item, content-part, output-text, reasoning-summary, missing, other |
| `reason` | event-type, event-name, sequence-missing, sequence-invalid, sequence-start, sequence-step, envelope, identity, state, order, index, text-consistency, unsupported-event |
| `sequence` | missing, invalid, zero, one, later |
| `position` | first, later |

원시 이벤트 이름·ID·본문·숫자 실제 값은 기록하지 않는다. 진단은 broker의 로컬 decoder가 만든 오류에서만 가져오며 고정 키·own data property·enum을 검사한 복사본을 사용한다. 내부 진단은 동결하고 getter를 실행하지 않으며 정적 분류가 응답 허용 권한을 만들지 않는다.

source 동결 후 protocol/policy 집중89개·lint·typecheck·build가 통과했다. 첫 집중 검사의1개 실패는 `type:null`과 tool usage가 함께 있는 fixture가 SSE 전에 JSON 민감정보 검사에서 거부돼 테스트의 기대 단계가 잘못된 경우였다. 순수 이벤트 fixture로 고친 뒤89개가 통과했다. 독립 리뷰에서 reasoning summary 경계의 진단 오분류1건을 수정하고 회귀를 추가했다.

첫 전체946개 중945개가 통과하고 broker SSE 진단 테스트1개가 실패했다. `new Response(string)`이 자동으로 `text/plain`을 설정해 SSE 전에 MIME 검사에서 거부된 fixture 문제였다. fixture를 byte buffer로 바꾸는 한 줄만 수정했고 production 코드는 변경하지 않았다. native v7 두 검사를 포함한 나머지945개는 통과했다. 수정 후 최종 전체946개가 모두 통과했다(실패0·skip0, 70.2157초). 직전935개 대비 policy2개·protocol6개·broker1개·native process2개를 추가해 신규220개다. 현재 policy21개·protocol68개·broker19개·process12개이며 나머지 검사 수는 유지한다. 집중89개·lint·typecheck·build도 통과했다. [최종 전체 로그](/private/tmp/work-assistant-harness-stage4c8-v7-final-tests.log)에 기록했고, 전체935개는 v6 실제 호출 당시 코드의 이력으로 보존한다.

새 계획의 [준비 검사](/private/tmp/harness-stage4c8-v7-review-sCNWSq/readiness.json), [원본 기준 기록](/private/tmp/harness-stage4c8-v7-review-sCNWSq/pre-run-repository.json), [최종 빌드 검증](/private/tmp/harness-stage4c8-v7-review-sCNWSq/final-build-validation.json)을 마련했다. 과거11개·신규1개 총12개 계획/payload/hash가 유효하고 본문8,897바이트는 이전과 같다. 원본33개·부모7개 identity·HEAD·승인0/attempt0 DB·verifyReady를 확인했으며 준비 검사 당시 인증 접근·실제 모델 호출·전송은0이었다. 최종 전체946개 통과 결과를 검토서에 반영한 뒤 별도 승인을 받아 아래 실제1회를 실행했다. 준비 당시 승인·attempt·소비·전송은0이었다.

| 항목 | 새 v7 계획 |
| --- | --- |
| 계획·검토서 | [plan.json](/private/tmp/harness-stage4c8-v7-review-sCNWSq/plan.json) · [정확한 요청 본문과 경계](/private/tmp/harness-stage4c8-v7-review-sCNWSq/review.txt) |
| 작업 ID | `cdb36c90-57ce-413a-8228-87c4e0031205` |
| 계획 hash | `525e1946fb04af6dd8cf2763ceffd80d53d9e0553ed8ae880f6c65c7ac2ce762` |
| 본문 hash | `bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe` (동일8,897바이트) |
| profile hash | `e6fd460ffe3e3da9cb63799934c4eba7159c683af1afc83860e16d71a3c86641` |
| config hash | `44b769e91b366cac95b812dd1a9a50e9dcca6f80ab57f1aa73a31f2bdd37486f` |
| 명세 hash | `47143ac8f8a43746a34d5791b151302956bcae84eba1d43057bb0ecdfce7f4e8` |
| 계획 만료 | `2026-11-14T07:39:10.663Z` |
| 현재 상태 | `FAILED`, 별도 승인·attempt·소비·upstream 각1회. 아래 실제 실행 기록 참조 |

준비한 v7 계획을 별도 승인받아 실제1회를 실행했다. [실행 결과](/private/tmp/harness-stage4c8-v7-review-sCNWSq/run-result.json)와 [호출 진단](/private/tmp/harness-stage4c8-v7-review-sCNWSq/data/readonly-live-runs/cdb36c90-57ce-413a-8228-87c4e0031205/call-report.json)의 안전한 필드만 기록한다. 실행에는 위 전체946개·집중89개·lint/typecheck/build 검증 코드를 사용했다.

| 항목 | v7 실제 실행 기록 |
| --- | --- |
| 승인 ID | `0beab778-72cc-4556-a5e8-7dc96c35a11a` |
| 승인 유효 기간 | `2026-11-13T07:44:13.116Z` ~ `2026-11-13T07:54:13.116Z` (10분) |
| 승인 사용 시각 | `2026-11-13T07:44:27.894Z` |
| attempt ID | `7aa0af84-7208-4991-9378-c14874732afd` |
| 시작·전달 예약·종료 | UTC `07:44:27.894` · `07:44:27.902` · `07:44:29.297` |
| 최종 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, `report=null`, `responseHash=null` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT`, phase `request`, `upstreamCalls=1` |
| SSE 진단 | `event=created`, `reason=envelope`, `sequence=zero`, `position=first` |
| HTTP 관찰 | status200, headerCount35, headerBytes3128 |
| 형식 진단 | MIME/encoding 누락, 쿠키3개, 이름·값·탭·쿠키 외 중복 위반0, Location/Retry-After 없음 |
| JSON·민감정보 진단 | `json`, `sensitive`, `sensitiveAttribution`, `sensitiveMatches` 모두null |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |

이번에는 첫 sequence가0이며 sequence 검사를 통과한 뒤 created envelope의 엄격한 필수 키 누락/추가 키 검사에서 거부된 것을 확인했다. 따라서 순번은 이번 v7 거부 원인이 아니다. 원문을 보관하지 않아 세부 키와 정상 완성 응답 여부는 미확인이다. 이 결과를 이전 v6 실패의 세부 조건으로 소급 적용하지 않는다. 승인·attempt·소비·upstream은 각1회이고 자동 재시도는 없다. 독립 사후 감사에서 원본/Git33개·부모7개 identity·HEAD/base 보존과 관련 프로세스·sandbox 종료를 확인했다. 누적 upstream11회 모두 실패했으며 별도 upstream0회 실패까지 소비 승인은12개다.

독립 감사는 DB의 승인1·소비1·attempt1·upstream1과 원본/Git33개·부모7개 identity·HEAD/base 보존을 확인했다. controller57884·guardian58337·child58338과 해당 프로세스 그룹은 모두 없고 sandbox도 제거됐으며 closed·cleanupConfirmed=true다. 현재13개·이전75개 아티팩트 hash도 보존됐다. 누적 승인/attempt는12개, 실제 upstream은11회이며 모두 별도 승인한 단건 실행이다.

이 실패 뒤 수용 조건·profile을 변경하지 않는 아래 envelope 정적 진단을 구현했다. 실제 세부 키는 아직 미확인이며 원시 응답·키·값을 보관하거나 추측으로 허용 조건을 넓히지 않는다.

## Envelope 정적 진단 구현과 새 계획

root eventObject의 엄격한 키 검사 실패에만 `sseEnvelope={missing, unexpected, observedUnexpected, overflow}`를 추가한다. `missing`은 등록된 필수 키의 고정 분류다. `unexpected`의 각 항목은 고정 사전의 `field` 또는 `other`, `valueType`, `count`만 가진다. `valueType`은 null·boolean·nonnegative-integer·negative-integer·number·string·array·object의8종이다. 같은 분류 조합은 합산하며 실제 값·키·ID·본문 조각을 기록하지 않는다.

정렬된 root 속성 최대128개·고유 조합32개까지 집계하고 초과는 `overflow=true`로 표시한다. 관찰 계수 합계와 `observedUnexpected`가 같아야 하며 overflow 결과를 완전한 관찰로 해석하지 않는다. accessor·symbol·등록되지 않은 필수 키 목록·부정확한 결과 shape를 거부하고 getter를 실행하지 않는 own data property 검사·깊은 복사·동결을 적용한다. broker가 로컬 decoder에서 발생한 진단만 받아 call report로 전달한다. 기존 v3~v7 응답 허용 조건·오류 code·profile/config/body/envelope hash는 바꾸지 않는다.

[집중 검사](/private/tmp/work-assistant-harness-stage4c8-envelope-focused.log)는80개 모두 통과했다(실패/skip0, 0.849565초). [최종 전체 검사](/private/tmp/work-assistant-harness-stage4c8-envelope-tests.log)는 native 포함960개 모두 통과했다(실패/skip0, 69.1514초). 기존726개·신규234개이며 직전946개에서14개를 추가했다. lint·typecheck·build도 통과했다. 독립 검토에서 blocker는 없었고 메모리 합성1000회와 helper accessor 실행0회를 확인했다. 실제 호출의 세부 키 원인을 확인한 결과는 아니며 직전946개는 v7 실제 실패 당시 코드의 검증 이력으로 보존한다.

같은 v7 설정/profile의 새 계획을 만들었다. [준비 검사](/private/tmp/harness-stage4c8-envelope-review-IdFD0J/readiness.json), [원본 기준 기록](/private/tmp/harness-stage4c8-envelope-review-IdFD0J/pre-run-repository.json), [최종 빌드 검증](/private/tmp/harness-stage4c8-envelope-review-IdFD0J/final-build-validation.json)을 보존한다. 최종 재검증은 `2026-11-13T07:57:39.525Z`에 통과했고 총13개 계획/payload/hash와 과거 안전 아티팩트142개 hash를 확인했다. 원본33개·부모7개 identity·HEAD/base·고정 바이너리 준비·승인0/attempt0/소비0 DB가 준비 당시 유효함을 확인했다. 이전 v7와 본문8,897바이트·설정·profile·명세 hash는 같다.

| 항목 | 새 envelope 진단 계획 |
| --- | --- |
| 계획·검토서 | [plan.json](/private/tmp/harness-stage4c8-envelope-review-IdFD0J/plan.json) · [정확한 요청 본문과 경계](/private/tmp/harness-stage4c8-envelope-review-IdFD0J/review.txt) |
| 작업 ID | `53eaee9e-81e3-4a1f-b34f-df450f2899bb` |
| 계획 hash | `19f78682d457b7f2b27060e3a5ca688eae1d57768224af57a3964df48514793b` |
| 설정·profile | 기존 `readonly-live-codex-v7` / `codex-chatgpt-sse-v7` |
| 본문·설정·profile·명세 | 직전 v7와 동일, 합성 요청8,897바이트 |
| 계획 만료 | `2026-11-14T07:55:47.952Z` |
| 현재 상태 | `FAILED`, 별도 승인·attempt·소비·upstream 각1회. 아래 실제 기록 참조 |
| 호출 경계 | 구체 승인 뒤 TTL10분·최대1회·자동 재시도0회 |
| 실제 실행 | 구체 승인 뒤1회 실행, SSE_EVENT로 실패. 추가 실행 없음 |

준비한 envelope 진단 계획을 별도 승인받아 실제1회를 실행했다. [실행 결과](/private/tmp/harness-stage4c8-envelope-review-IdFD0J/run-result.json)와 [호출 진단](/private/tmp/harness-stage4c8-envelope-review-IdFD0J/data/readonly-live-runs/53eaee9e-81e3-4a1f-b34f-df450f2899bb/call-report.json)의 안전한 필드만 기록한다. 실행에는 위 전체960개·집중80개·lint/typecheck/build 검증 코드를 사용했다.

| 항목 | envelope 진단 실제 기록 |
| --- | --- |
| 승인 ID | `2f97bcd2-fe3a-40ff-a7bd-8f21866ed200` |
| 승인 유효 기간 | `2026-11-13T08:01:16.824Z` ~ `2026-11-13T08:11:16.824Z` (10분) |
| 승인 사용 시각 | `2026-11-13T08:01:32.128Z` |
| attempt ID | `fa7370d3-6872-48c7-82d0-ba61ce155b75` |
| 시작·전달 예약·종료 | UTC `08:01:32.128` · `08:01:32.180` · `08:01:33.395` |
| 최종 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, `report=null`, `responseHash=null` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE_SSE_EVENT`, phase `request`, `upstreamCalls=1` |
| SSE 진단 | `event=created`, `reason=envelope`, `sequence=zero`, `position=first` |
| envelope 진단 | `missing=[]`, `unexpected=[{field:other,valueType:boolean,count:1}]`, `observedUnexpected=1`, `overflow=false` |
| HTTP 관찰 | status200, headerCount35, headerBytes3132 |
| 형식 진단 | MIME/encoding 누락, 쿠키3개, 이름·값·탭·쿠키 외 중복 위반0, Location/Retry-After 없음 |
| JSON·민감정보 진단 | `json`, `sensitive`, `sensitiveAttribution`, `sensitiveMatches` 모두null |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |

이번 created 이벤트에는 등록된 필수 키 누락이 없고 사전미등록 boolean 추가 필드가1개 있었다. 관찰 범위는 불완전하지 않지만 필드명·의미는 고정 진단만으로 확인할 수 없다. 특정 이름을 추측하거나 이전 응답에도 같은 키가 있었다고 소급 단정하지 않는다. HTTP200과 앞선 검사 통과는 유효한 조사 보고서·완성 응답·추론 성공을 뜻하지 않는다. 독립 사후 감사에서 원본/Git33개·부모7개 identity·HEAD/base와 관련 프로세스·sandbox 종료를 확인했다.

[독립 사후 감사](/private/tmp/harness-stage4c8-envelope-review-IdFD0J/post-run-audit.json)는 `2026-11-13T08:03:10.203Z`에 passed로 완료했다. 원본/Git33개·부모7개 identity·HEAD/base, DB 승인1·소비1·attempt1·upstream1을 확인했다. controller24455·guardian24902·child24903과 해당 프로세스 그룹은 없고 sandbox도 남지 않았으며 cleanupConfirmed=true를 유지한다. 현재14개·이전142개 아티팩트 hash를 보존했다. 감사 자체의 인증 접근·외부 호출·원시 응답 접근은 없었다.

승인·attempt·소비·upstream은 각1회이며 자동 재시도는0이다. 이 시점의 누적 upstream12회 모두 실패했고 별도 upstream0회 실패까지 소비 승인은13개였다. 이후 아래 v8의 제한된 호환 정책을 검증하고 새 계획을 별도 승인받아1회 실행했다.

## v8 제한된 created boolean 확장 호환 정책

확인된 실패는 엄격한 필수3키 envelope와 사전미등록 boolean 추가 필드1개의 충돌이다. 실제 필드명·의미·ASCII 형태는 여전히 미확인이다. [공식 API의 하위 호환 정책](https://developers.openai.com/api/reference/overview#backwards-compatibility)은 JSON 응답과 event data의 속성 추가를 호환 가능한 변경으로 분류한다. 이를 참고해 제한된 수용 정책을 명시적으로 추가했으며, 이 일반 API 문서가 ChatGPT endpoint의 확정 schema나 이번 실제 필드의 의미를 보장한다고 주장하지 않는다.

새 `readonly-live-codex-v8` / `codex-chatgpt-sse-v8`는 decoder `readonly-live-response-v7`과 `responseEnvelopePolicy=created-boolean-extension-v1`을 결합한다. 첫 `response.created` root의 추가 필드가 정확히1개·boolean·ASCII 식별자1~64자이며 등록된 SSE·제어·prototype 예약 키가 아닐 때에만 검증용 사본에서 제외한다. 필수 `type`·`sequence_number`·`response`는 그대로 엄격하게 검사하고 제외한 필드를 동작에 쓰지 않는다.

원본 전체 민감정보 검사·중복 키·원본 바이트/hash·source identity·sequence·내부 response·도구·완결성 검사는 유지한다. 중첩 response·직접 JSON 응답·다른 이벤트에는 이 예외를 적용하지 않으며 v1~v7 계약과 hash를 보존한다. 본문·요청 헤더·모델·목적지·한도는 같고 새 응답 계약을 config/profile/envelope/plan hash에 결합한다.

[집중 검사](/private/tmp/work-assistant-harness-stage4c8-v8-focused.log)는99개 모두 통과했다(실패/skip0, 0.858449초). [최종 전체 검사](/private/tmp/work-assistant-harness-stage4c8-v8-tests.log)는 native 포함971개 모두 통과했다(실패0·skip0, 66.4974초). 기존726개·신규245개이며 직전960개 대비 policy2개·protocol6개·native3개를 추가했다. lint·typecheck·build도 통과했고 독립 검토의 blocker는 없었다. 실제 호출의 성공을 확인한 검사는 아니며 960개는 직전 envelope 실제 실패 당시 코드의 검증 이력으로 보존한다.

새 v8 계획의 [준비 검사](/private/tmp/harness-stage4c8-v8-review-9nVnOZ/readiness.json), [원본 기준 기록](/private/tmp/harness-stage4c8-v8-review-9nVnOZ/pre-run-repository.json), [최종 빌드 검증](/private/tmp/harness-stage4c8-v8-review-9nVnOZ/final-build-validation.json)을 마련했다. 최종 재검증은 `2026-11-13T08:12:38.193Z`에 passed였다. 총14개 계획/payload/hash와 과거 안전 아티팩트158개 hash를 보존했고 원본33개·부모7개 identity·HEAD/base·고정 바이너리·승인0/attempt0/소비0 DB를 확인했다. 본문은 이전과 같은8,897바이트다.

| 항목 | 새 v8 계획 |
| --- | --- |
| 계획·검토서 | [plan.json](/private/tmp/harness-stage4c8-v8-review-9nVnOZ/plan.json) · [정확한 요청 본문과 변경 계약](/private/tmp/harness-stage4c8-v8-review-9nVnOZ/review.txt) |
| 작업 ID | `795239e9-a6e9-43b1-b6ab-aa1bf14576cd` |
| 계획 hash | `21ba0c363fde41431433879c2b39b282054fe09482a05b3627bcefcef854a4a8` |
| 본문 hash | `bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe` (동일8,897바이트) |
| profile hash | `849ac49fe26208d15759ede0a16afe080b7b85876b484fa7c378241a8f86f535` |
| config hash | `02f3e3cd3fa532e26e7615ce508b216a7b0330200032aa39dc5338594edb99d4` |
| 명세 hash | `2c5adc3f2d5fd2e32111ef278f04dbdeadf67823d134e9838c91b2b78beac6ea` |
| 계획 만료 | `2026-11-14T08:11:14.609Z` |
| 현재 상태 | `FAILED`, 별도 승인·attempt·소비·upstream 각1회. 아래 실제 기록 참조 |
| 실제 실행 | 구체 승인 뒤1회 실행, RESPONSE_FIELDS로 실패. 추가 실행 없음 |

준비한 v8 계획을 별도 승인받아 실제1회를 실행했다. [실행 결과](/private/tmp/harness-stage4c8-v8-review-9nVnOZ/run-result.json)와 [호출 진단](/private/tmp/harness-stage4c8-v8-review-9nVnOZ/data/readonly-live-runs/795239e9-a6e9-43b1-b6ab-aa1bf14576cd/call-report.json)의 안전한 필드만 기록한다. 실행에는 위 전체971개·집중99개·lint/typecheck/build 검증 코드를 사용했다.

| 항목 | v8 실제 실행 기록 |
| --- | --- |
| 승인 ID | `9d843477-80cd-4580-8606-c64db9526594` |
| 승인 유효 기간 | `2026-11-13T08:15:05.023Z` ~ `2026-11-13T08:25:05.023Z` (10분) |
| 승인 사용 시각 | `2026-11-13T08:15:18.803Z` |
| attempt ID | `d6c9525d-db28-44ce-b155-e00f6a55d089` |
| 시작·전달 예약·종료 | UTC `08:15:18.803` · `08:15:18.811` · `08:15:19.987` |
| 최종 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, `report=null`, `responseHash=null` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE_RESPONSE_FIELDS`, phase `request`, `upstreamCalls=1` |
| HTTP 관찰 | status200, headerCount35, headerBytes3134 |
| 형식 진단 | MIME/encoding 누락, 쿠키3개, 이름·값·탭·쿠키 외 중복 위반0, Location/Retry-After 없음 |
| JSON·민감정보·SSE 진단 | `json`, `sensitive`, `sensitiveAttribution`, `sensitiveMatches`, `sse`, `sseEnvelope` 모두null |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |

기록으로 확인할 수 있는 것은 RESPONSE_FIELDS 오류뿐이다. 당시 직접 JSON/SSE origin과 세부 response 거부 조건을 구분할 진단이 없으므로 실제 created envelope·boolean 호환 경계 통과를 단정할 수 없다. 앞서 이를 통과한 것으로 설명한 해석은 정정한다. 이전 추가 필드의 정확한 이름·의미를 알아낸 것도 아니며, 오류 code의 변화나 로컬 호환 검사 통과를 실제 경계 통과·완성 응답·유효 보고서·추론 성공으로 설명하지 않는다. 독립 사후 감사에서 원본/Git33개·부모7개 identity·HEAD/base 보존과 관련 프로세스·sandbox 종료를 확인했다.

[독립 사후 감사](/private/tmp/harness-stage4c8-v8-review-9nVnOZ/post-run-audit.json)는 `2026-11-13T08:16:45.902Z`에 passed로 완료했다. 원본/Git33개·부모7개 identity·HEAD/base, DB 승인1·소비1·attempt1·upstream1을 확인했다. controller85597·guardian86026·child86027과 해당 프로세스 그룹은 모두 없고 sandbox도 남지 않았으며 closed·cleanupConfirmed=true를 유지한다. 현재14개·이전158개 아티팩트 hash도 보존했다. 누적 승인·소비·attempt는14개, upstream은13회다.

승인·attempt·소비·upstream은 각1회이며 자동 재시도는0이다. 누적 upstream13회 모두 실패했고 별도 upstream0회 실패까지 소비 승인은14개다. 이 실패 뒤 v8 허용 조건을 유지하는 아래 response 정적 진단과 같은 계약의 새 계획을 준비했고 별도 승인1회를 실행했다. 준비 당시 승인·attempt·소비·전송은0이었다.

## Response 경로·거부 경계 진단과 새 계획

직전 v8 기록에는 response origin이 없으므로 직접 JSON과 SSE response 중 어느 경로가 실패했는지 알 수 없다. 이를 구분하도록 로컬 decoder의 RESPONSE_FIELDS 오류에서만 고정 `response={event, reason, envelope}` 진단을 생성한다. broker는 이 로컬 진단만 선택해 call report에 전달하며 기존 공개 오류 code와 v8 수용 조건·profile/config/body/envelope hash는 바꾸지 않는다.

| 필드 | 고정 분류 |
| --- | --- |
| `event` | direct-response, created, in-progress, completed |
| `reason` | envelope, object-marker, status, model, output-type, output-count, duplicate-item-id, assistant-count, response-id |
| `envelope` | reason=envelope일 때만 missing/unexpected/observedUnexpected/overflow, 그 외null |

필수5개 이름 `id`·`object`·`status`·`model`·`output`과 기존 선택28개, 관찰용8개를 분리해 총41개 고정 label을 사용한다. 관찰용 사전은 수용 필드를 추가하지 않는다. 미등록 이름은 other로 분류하며 실제 키·값·ID·응답 조각을 기록하지 않는다. root 최대128개·고유 조합32개,8종 값 형태와 count·overflow만 보관한다. own data property·고정 키·enum·계수 합계를 검사하고 accessor·symbol·부정확한 형태를 거부한다. getter를 실행하지 않고 깊은 복사·동결을 적용한다.

[집중 검사](/private/tmp/work-assistant-harness-stage4c8-response-focused.log)는88개 모두 통과했다(실패/skip0, 1.103369초). [최종 전체 검사](/private/tmp/work-assistant-harness-stage4c8-response-tests.log)는 native 포함985개 모두 통과했다(실패0·skip0, 70.7316초). 기존726개·신규259개이며 직전971개에서14개를 추가했다. lint·typecheck·build도 통과했고 독립 검토2건에서 blocker는 없었으며 메모리 합성1000회가 통과했다. 이는 실제 실패의 origin이나 필드를 확인한 결과가 아니며971개는 직전 v8 실제 호출 코드의 검증 이력으로 보존한다.

같은 v8 계약의 새 계획에 [준비 검사](/private/tmp/harness-stage4c8-response-review-R9ug7E/readiness.json), [원본 기준 기록](/private/tmp/harness-stage4c8-response-review-R9ug7E/pre-run-repository.json), [최종 빌드 검증](/private/tmp/harness-stage4c8-response-review-R9ug7E/final-build-validation.json)을 마련했다. 최종 재검증은 `2026-11-13T08:27:14.669Z`에 passed였다. 총15개 계획/payload/hash, 과거 안전 아티팩트173개 hash, 원본33개·부모7개 identity·HEAD/base·고정 바이너리·승인0/attempt0/소비0 DB를 확인했다. 설정·profile·본문·명세는 이전 v8와 완전히 같고 요청 본문은8,897바이트다.

| 항목 | 새 response 진단 계획 |
| --- | --- |
| 계획·검토서 | [plan.json](/private/tmp/harness-stage4c8-response-review-R9ug7E/plan.json) · [정확한 요청 본문과 경계](/private/tmp/harness-stage4c8-response-review-R9ug7E/review.txt) |
| 작업 ID | `ba17524b-fa52-42e3-8a60-1faa10cb0430` |
| 계획 hash | `b5f66182783789668bc3293304d8497b0faa9fa9b8b5d1a5450361879c8a33a9` |
| 설정·profile | 기존 `readonly-live-codex-v8` / `codex-chatgpt-sse-v8` |
| 본문·설정·profile·명세 | 직전 v8와 동일, 합성 요청8,897바이트 |
| 계획 만료 | `2026-11-14T08:25:50.092Z` |
| 현재 상태 | `FAILED`, 별도 승인·attempt·소비·upstream 각1회. 아래 실제 기록 참조 |
| 실제 실행 | 구체 승인 뒤1회 실행, RESPONSE_FIELDS로 실패. 추가 실행 없음 |

준비한 response 진단 계획을 별도 승인받아 실제1회를 실행했다. [실행 결과](/private/tmp/harness-stage4c8-response-review-R9ug7E/run-result.json)와 [호출 진단](/private/tmp/harness-stage4c8-response-review-R9ug7E/data/readonly-live-runs/ba17524b-fa52-42e3-8a60-1faa10cb0430/call-report.json)의 안전한 필드만 기록한다. 실행에는 위 전체985개·집중88개·lint/typecheck/build 검증 코드를 사용했다.

| 항목 | response 진단 실제 기록 |
| --- | --- |
| 승인 ID | `8d666df8-8eb8-4a85-91fa-4dbf4839bd9b` |
| 승인 유효 기간 | `2026-11-13T08:29:19.060Z` ~ `2026-11-13T08:39:19.060Z` (10분) |
| 승인 사용 시각 | `2026-11-13T08:29:32.512Z` |
| attempt ID | `c0dbc74c-e6df-428d-852a-eedbed82242e` |
| 시작·전달 예약·종료 | UTC `08:29:32.512` · `08:29:32.519` · `08:29:33.850` |
| 최종 상태 | `FAILED`, `READONLY_LIVE_CALL_FAILED`, `report=null`, `responseHash=null` |
| 호출 진단 | `READONLY_LIVE_INVALID_RESPONSE_RESPONSE_FIELDS`, phase `request`, `upstreamCalls=1` |
| response 진단 | `event=created`, `reason=envelope`, `missing=[]`, `observedUnexpected=5`, `overflow=false` |
| HTTP 관찰 | status200, headerCount35, headerBytes3134 |
| 형식 진단 | MIME/encoding 누락, 쿠키3개, 이름·값·탭·쿠키 외 중복 위반0, Location/Retry-After 없음 |
| JSON·민감정보·SSE 진단 | `json`, `sensitive`, `sensitiveAttribution`, `sensitiveMatches`, `sse`, `sseEnvelope` 모두null |
| 확인된 로컬 경계 | `isolation=passed`, `credentialAccess=passed`, `cleanupConfirmed=true` |

| 예상 밖 필드 분류 | 값 형태 | 횟수 |
| --- | --- | --- |
| other | array | 1 |
| other | nonnegative-integer | 2 |
| other | null | 1 |
| other | object | 1 |

이번 응답에서는 SSE created 내부 response의 필수 키 누락 없이 미등록 추가 필드5개가 엄격한 키 검사에서 거부됐음을 확인했다. 진단 overflow는 없지만 이름·의미는 확인할 수 없다. 앞선 v8 호출에는 origin 진단이 없었으므로 이번 결과를 그 호출에 소급 적용하지 않으며 이전 해석의 정정은 유지한다. 특정 필드명이나 값의 의미를 추측하지 않고 HTTP200·경로 확인을 완성 응답·추론 성공으로 해석하지 않는다. 독립 사후 감사에서 원본/Git33개·부모7개 identity·HEAD/base 보존과 관련 프로세스·sandbox 종료를 확인했다.

[독립 사후 감사](/private/tmp/harness-stage4c8-response-review-R9ug7E/post-run-audit.json)는 `2026-11-13T08:32:16.771Z`에 passed로 완료했다. 원본/Git33개·부모7개 identity·HEAD/base, DB 승인1·소비1·attempt1·upstream1을 확인했다. controller37983·guardian38423·child38424와 해당 프로세스 그룹은 모두 없고 sandbox도 남지 않았으며 closed·cleanupConfirmed=true를 유지한다. 현재14개·이전173개 아티팩트 hash도 보존했다. 누적 승인·소비·attempt는15개, upstream은14회다.

승인·attempt·소비·upstream은 각1회이고 자동 재시도는0이다. 누적 upstream14회 모두 실패했으며 별도 upstream0회 실패까지 소비 승인은15개다. 별도 v9 추가 JSON 호환 정책은 구현과 전체1005개·집중121개 검증을 마쳤다. 기존 v1~v8 계약·profile·hash는 보존한다. 새 v9 계획 준비를 마쳤으며 추가 승인을 기다린다. 새 계획의 승인·attempt·전송은0회다.

## v9 제한된 추가 JSON 호환 정책 구현

최신 실제 진단에서 확인한 것은 created 내부 response의 추가 필드5개와 값 형태뿐이다. 이름·의미를 확인한 것으로 표시하지 않고, 알려진 response 필드 검증은 유지하면서 제한된 추가 JSON을 별도 검증한 뒤 사용하지 않는 명시적 호환 정책을 구현했다. 기존 v1~v8 계약·hash는 변경하지 않으며 v9는 새 profile·계획·승인을 요구한다.

| 항목 | v9 구현 경계 |
| --- | --- |
| profile 결합 | decoder `readonly-live-response-v8`, `responseExtensionPolicy=bounded-inert-json-v1`, 공유된 불변 `responseExtensionLimits` |
| root 추가 필드 | 최대8개, 이름은 ASCII 식별자1~64자, 제어/prototype 예약 키 거부 |
| 묶음 전체 제한 | 키 포함 canonical UTF-8 16384바이트, 256노드, 깊이8. 추가 묶음 자체는 깊이0·노드1 |
| 값 검사 | 유한한 JSON 값과 own data property만 허용. accessor·symbol·비표준 객체·순환 참조·비유한 숫자 거부 |
| 민감정보 | 제외할 추가 원본을 숫자 별칭 없이 별도 검사해 정규화 충돌로 숨겨지는 자료도 거부 |
| 기존 경계 | 알려진 필드·원본 전체 민감정보·도구·sequence·완료 검증 유지. 추가 자료는 검증용 사본에서만 제외하고 보고서·상태·동작에 쓰지 않음 |
| 정적 진단 | 기존9종 reason에 `extension-key`, `extension-limit`, `extension-value`, `extension-sensitive`, `extension-control` 추가. 원문 키·값 미보관 |

[v9 최종 전체 검사](/private/tmp/work-assistant-harness-stage4c8-v9-tests.log)는 native 포함1005개 모두 passed였다(실패0·skip0, 68.538391초). [집중 검사](/private/tmp/work-assistant-harness-stage4c8-v9-focused-final.log)는121개 모두 passed였다(0.870720초). 직전985개에20개를 추가했으며 기존726개·신규279개다. build·typecheck·최종 lint도 모두 통과했다. 독립 검토2건의 blocker는 없었다. 최초 build에서 테스트 정규식 표기 오류(TS1508)가 발생해 수정 뒤 통과했다. 전체985개는 직전 response 진단 실제 호출 코드의 검증 이력으로 보존한다.

v9의 제한된 추가 JSON은 기존 v8보다 넓은 새 수용 정책이다. 실제 필드명·의미나 완성 응답의 성공을 확인한 것으로 표현하지 않으며 수용162는 미완료다. 새 v9 계획 준비를 마쳤으며 추가 승인을 기다린다. 새 계획의 승인·attempt·소비·전송은0회다.

새 v9 계획의 [검토서](/private/tmp/harness-stage4c8-v9-review-H1nOBT/review.txt), [준비 검사](/private/tmp/harness-stage4c8-v9-review-H1nOBT/readiness.json), [원본 기준 기록](/private/tmp/harness-stage4c8-v9-review-H1nOBT/pre-run-repository.json), [최종 빌드 검증](/private/tmp/harness-stage4c8-v9-review-H1nOBT/final-build-validation.json)을 마련했다. 최종 재검증은 `2026-11-13T08:49:14.211Z`에 passed였다. 총16개 계획/payload/hash, 과거 안전 아티팩트188개 hash, 원본33개·부모7개 identity·HEAD/base·고정 바이너리 준비와 DB 승인0/attempt0/소비0을 확인했다. 본문8,897바이트와 본문 hash·모델·목적지·요청 헤더·기존 전송 한도는 이전과 같으며 새 수용 정책을 config/profile/명세·계획 hash에 결합했다. 준비 검사에서 인증 접근·실제 호출은 하지 않았다.

| v9 새 계획 | 고정 값 |
| --- | --- |
| task | `8a41af34-19f0-4ab2-a1ef-0cd2ee0f31a0` |
| plan hash | `0a67b8ea2acb7f32dc9363eadffad11c2292a677a55c511cc9edfef35e362dfb` |
| config hash | `134bf276ae7075e51861c8796a3f0e2b28ffe257e1cce897637c379317cc2c60` |
| profile hash | `0e46bd87ba6d8e2bdc76f5a1174b01bdce2c2c4958cfd5d8f9209fd253c0684c` |
| envelope hash | `ef1184bafec49e02ed185b5434b95af662129e9498511122dcaa88d01bc5fe9e` |
| 현재 상태 | `AWAITING_APPROVAL`, 승인0·attempt0·소비0·전송0 |

## 결과 해석과 후속 범위

2026-11-13 사용자 요청으로 현재 구현·검증 기록을 커밋하고 후속 실제 검증을 보류한다. v9의 승인은 아직 발급하지 않았다. 재개할 때 `/private/tmp`의 검토 자료·고정 바이너리·원본 보존 상태와 계획 만료를 먼저 확인한다. 자료가 사라졌거나 계획·설정이 달라졌으면 새 계획을 준비하고, 유효한 구체 승인 후에만 실제 호출한다.

다음 최소 작업은 검토 준비를 마친 v9 새 profile·계획의 추가1회 승인을 받은 뒤 단건 실제 검증하는 것이다. 실제 필드명·의미는 미확인이고 이전 v8의 origin도 소급 확정하지 않는다. 기존 v1~v8 계약·profile·hash는 보존한다. 새 계획의 승인·attempt·전송은0회이며 추가 승인을 기다린다. 이전 소비 승인은 재사용하지 않는다. 유효 조사 보고서가 없어 수용162는 미완료다.

오프라인 계약·합성 adapter 검사·실제 호출 실패·응답 내용 미검증·회사 도입을 각각 구분한다. 이후 실제 단건 성공이 확인돼도 모든 모델/인증 조합의 호환성이나 일반적 의미 정확성, 회사 보안 검토 통과를 주장하지 않는다.

기존 대상 작업의 `feature/`, `fix/`, `chore/`, `refactor/` 규칙은 이 하네스 저장소의 개발 규칙으로 확대하지 않는다. 실제 저장소 읽기, 회사 자료 전송, Codex 직접 수정, commit·push는 각각 별도 후속 범위이며 PR/MR 생성은 제외한다.

연결 계약 검토 자료: [ChatGPT 인증 gateway](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway), [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). 공식 계약 확인과 이번 고정 조합의 실제 호출 성공은 별도의 검증 항목이다.
