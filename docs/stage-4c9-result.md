# 단계 4-C-9 로그인 유지 relay 로컬 검증

2026-11-14 사용자가 ChatGPT 로그인 유지 방향을 선택했다. 비공개 응답 metadata의 개별 허용값을 계속 추가하는 대신, 고정 Codex가 응답을 해석하는 relay의 로컬 가능성을 확인한다. 구현 순서와 수용 기준은 [기준 계획](implementation-plan.md#단계-4-c-9-chatgpt-로그인-유지와-codex-응답-해석으로-전환)에 둔다.

**최신 상태:** 전체 응답 예산4MiB의 별도 relay-v2 계획 `5fa7b107-3486-44b0-bed4-482bb77da5cd`을 사용자 승인 TTL10분으로 실제1회 실행해 `REPORTED`와 유효 조사 보고서를 얻었다. HTTP200·362,095byte·1162frame·EOF를 확인했고 승인·사용·소비·attempt·dispatch·upstream 각1회·자동 재시도0이다. 로컬1125개 회귀와 원본/Git·코드/검토 자료 보존·로컬 프로세스 종료를 확인했다. v9와 relay-v1 계약·hash·기존 실패 이력은 보존하며 아래 승인 대기 자료는 당시 준비 이력이다. 누적 upstream18회 중 성공1회·실패17회, 소비 승인19개다. 수용178은 새 v2의 구체 단건에서 통과했으며 기존 v9의 수용162는 미완료다.

## 첫 probe의 구현과 검증 이력

고정 Codex 0.154.0은 합성 `access_programs: {cyber: "standard"}`와 추가 metadata가 포함된 SSE를 부모의 metadata 투영 없이 직접 처리했고, 등록된 조사 JSON을 반환했다. 합성 데이터에서 relay 경로의 로컬 가능성을 확인한 결과다. 실제 로그인·공급자 응답 호환성을 검증한 것은 아니다.

- `src/adapters/readonly-login-relay-probe.ts`: 등록 fixture만 받는 loopback capability broker, 고정 요청의 단일 fake dispatch, 원시 바이트 중계·한도·취소·종료 관찰, pinned native 실행과 합성 최종 JSON 검사.
- `src/adapters/codex-cli-contract.ts`, `src/adapters/codex-cli.ts`: argv와 기존 event parser를 순수 모듈로 분리하고 기존 API에서 reexport한다. 두 함수 본문이 HEAD 원본과 바이트 단위로 같음을 확인했다.
- `tests/readonly-login-relay-probe.test.ts`: 신규13개. runtime 의존 분리·옵션 getter/override 거부·정확한 바이트·단건/동시성·크기/조기 close·취소·중복 JSON 키/잘못된 Unicode·도구/추가 turn/복수 최종/미완성 출력과 native 정상/실패/timeout/외부 취소를 검사한다.
- README·구조·보안·기준 계획에는 실제 구현과 후속 live 미구현 범위, 보증 책임 변경을 구분했다. 새 CLI 명령·live 설정·DB/승인 연결은 추가하지 않았다.

| 검증 | 결과 | 근거와 범위 |
| --- | --- | --- |
| lint·typecheck·build | passed | 최종 코드 기준 기존 pnpm 스크립트 |
| 신규 선택 검사 | passed | native opt-in13개·실패0·skip0. 정상 raw relay와 실패/종료 경로. 최종 취소 검사 보강 후13개를 다시 확인(5.324초), 실제 spawned 관측 및 guardian/child/PGID 부재 확인 |
| 전체 회귀 | passed | native opt-in `pnpm test`: 기존1020개+신규13개=1033개·실패0·skip0, runner74.154초 |
| 기존 계약 보존 | passed | v9 domain/policy/protocol/broker/adapter/service/store와 package/lockfile 등 기준9개 SHA 동일, 추출 함수 본문 동일 |
| offline 의존 분리 | passed | 고정 guardian 진입점2개를 포함한 프로젝트12개 파일의 runtime 의존 검토. 실제 credential loader/외부 transport/live adapter/DB 도달 없음 |
| 실제 로그인·모델·외부 전송 | not_run | probe에 연결하지 않았으며 실제 호출0 |
| 실제 공급자 호환성·의미 정확성 | not_run | 합성 응답과 고정 JSON 일치만 확인 |
| 새 live adapter·새 승인 계획 | not_run | 후속 미구현. 실제 호출 가능한 `AWAITING_APPROVAL` 작업은 아직 없음 |

검토 자료는 [로컬 review 디렉터리](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c9-login-relay-rk2v70y2)에 보존한다. `baseline-contracts.json`, `interim-contract-audit.json`, `full-native-test-result.json`, `agent-relay-validation.json`, `final-review-audit.json`과 `logs/`에 기준 hash·정적 비교·실행 결과를 분리했다. 전체1033개 통과 후 테스트의 실제 spawned 관측·종료 확인 assert만 보강했으며 제품 동작 변경은 없고, 최종 build·선택13개·lint로 확인했다. 최초 lint/TypeScript 오류 정정 전 로그도 보존하며 최종 passed 기록과 구분한다. 실제 인증값·공급자 원문은 포함하지 않는다.

프로브의 operation 한도는55초이고 native 취소 대기와 broker active-handler 대기는 각각 최대5초다. 파일 I/O까지 포함하는 전체60초 정리 보장을 검증하지 않았다. fixture 전체를256KiB 이하로 메모리에 준비하고8KiB씩 쓰므로 일반 upstream의 지연 iterator·거대 chunk·느린 수신에 대한 종단 backpressure는 미검증이다. `responseBodyHash`는 합성 fixture 전체의 hash이고 `relayCompleted`와 전송 바이트를 별도로 기록해 부분 중계를 완료로 표시하지 않는다.

## 첫 probe에서 확인한 경계

합성 `access_programs` 객체와 metadata는 로컬 fixture이며 실제 응답을 보존하거나 재현한 자료가 아니다. 실제 필드의 형태·내용·의미와 pinned Codex의 공급자 호환성은 미확인이다. 하네스는 metadata로 고정 요청·목적지·환경·OS 허용 권한·단건 전달 한도를 변경하지 않는다. Codex 내부의 metadata 해석과 그 효과는 별도의 미검증 범위다.

opaque relay의 비공개 metadata/sequence/tool_usage·원시 전체 민감정보 검사와 부모/CLI text 비교는 구형 계약과 동등하지 않다. 첫 probe에서는 부모 인증값의 upstream 반사 방어와 범용 최종 조사 검증이 미구현이었다. 아래 후속 구현에서 제한적인 반사 방어·최종 JSON/인용·민감정보 검증과 별도 보고서/승인 계약을 추가했다. 임의 인코딩·변형 전반의 비노출이나 공급자 도구 활동0을 보증하지 않는다. 구체 호출 계획의 별도 승인 전에는 실제 모델을 호출하지 않는다.

## 새 relay 계약·adapter와 승인 대기 준비 이력

2026-11-14 후속 요청의 첫 작업으로 기존 probe 변경을 `a8ccbdd2c65df291c1f5b2a5043b156ca3bc2ed2` (`feat(relay): 로그인 유지 로컬 검증 추가`)로 main에 커밋·푸시하고 원격 일치를 확인했다. 그 이후의 새 구현은 아래 source/build manifest로 식별한다.

- `src/domain/readonly-relay.ts`, `src/ports/readonly-relay.ts`, `src/policy/readonly-relay-policy.ts`: 새 정책·profile·설정·요청/승인·응답 보증 계약. 동일 근거의8897byte 요청은 v9와 같지만 profile/명세/계획 hash는 새 계약이다.
- `src/application/investigate-relay.ts`, `src/adapters/sqlite-readonly-relay-store.ts`: 별도 DB·승인 소비·dispatch·두 시점 TTL/source/generation guard·근거 보고·취소/복구·24h/30d 보관. 새 DB basename과 정확한 보고서/두 response hash·미검증5키를 확인한다.
- `src/policy/readonly-relay-protocol.ts`, `src/adapters/readonly-relay-broker.ts`, `src/adapters/readonly-relay-codex.ts`: 고정 목적지·본문·부모 인증, 전체 EOF/일반 JSON·SSE/인증 반사 검사 후 원시 중계, 단일 CLI 결과와 최종 인증 반사 검사. native idle wait만 새 경로에서55초로 설정한다.
- `src/adapters/readonly-relay-{lifecycle,runner,process}.ts`: 별도 실행 namespace·guardian·공유 정리 예산과 child/guardian/PGID/scratch 확인. 취소·stream 정리 불확실을 `BLOCKED`로 보존한다.
- `src/cli/readonly-relay.ts`, `src/cli/main.ts`, `config/readonly-relay.example.json`: 8개 명령과 기본 비활성 예시. 실제 명령·옵션은 [README](../README.md#단계-4-c-9-별도-relay-계약과-승인)에 기록했다.
- `tests/readonly-relay-{policy,workflow,protocol,cli,lifecycle,adapter}.test.ts`: 신규63개. 구현한 범위와 실패·격리·복구를 검사한다.

| 검증 | 결과 | 범위 |
| --- | --- | --- |
| lint·typecheck·build | passed | 최종 source 기준 pnpm 스크립트. 계획 CLI도 같은 코드로 재컴파일 |
| core 집중 | passed | 정책/workflow19개. 만료/혼용/위조 보고/동시1회/보관/복구 |
| protocol 집중 | passed | 16개. EOF/형식/한도/escaped·분할 반사/취소·불확실 정리 |
| CLI·lifecycle 집중 | passed | 18개(native4개 포함). 인증 경로 차단하의 비실행 명령·구형 DB 보존·강제 종료/새 프로세스 복구 |
| broker·native adapter 집중 | passed | 10개. 정상 실제 바이너리+가짜 응답, 두 guard·단건·반사·허구 인용·잘못된 결과·stream 정리 불확실 BLOCKED |
| 전체 회귀 | passed | native opt-in1096개(기존1033+신규63), 실패0·skip0, runner83.519초 |
| 구형 계약·시험 코드 보존 | passed | 새 명령 등록 main.ts 외 기존 source/test/config249개 SHA 동일. 테스트한 source·빌드782개 고정 |
| 실제 로그인·모델 전송·공급자 호환성 | not_run | 새 검토 작업은 승인0·run0·upstream0. 가짜/native 검증으로 대체하지 않음 |

최초 adapter 집중6passed/3failed는 string 기반 가짜 Response의 자동 `text/plain` 때문에 의도한 MIME 부재 사례가 되지 못한 fixture 문제였다. Buffer 기반 fixture로 정정한 뒤 새 불확실 정리 경로까지 포함한10개와 전체1096개가 통과했다. 거부 결과를 성공으로 바꾸거나 응답 허용 조건을 완화하지 않았다. 로그 이력은 보존한다.

### 실제 호출 전에 고정한 검토 자료와 계획

검토 디렉터리: [stage4c9-relay-live-3akw1dbz](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c9-relay-live-3akw1dbz). 디렉터리0700·설정/DB/자료0600이며 합성 source 디렉터리0555·파일0444를 유지한다.

| 항목 | 값 |
| --- | --- |
| 상태 | `AWAITING_APPROVAL` |
| 조사 ID | `472396eb-cf23-4e7a-9f57-c401cef52aa7` |
| planHash | `2ea997a6318ce49de3ffa7797ea627123fb97e0aa1446fe35f7f20e12e0cd619` |
| 생성 | 2026-11-14T11:38:24.399Z / 한국시간11월14일20:38:24.399 |
| 계획 만료 | 2026-11-15T11:38:24.399Z / 한국시간11월15일20:38:24.399 |
| 모델·인증 | `gpt-6.1-sol`·기존 ChatGPT 로그인·부모 지연 접근 |
| 설정/profile | `readonly-relay-codex-v1` / `codex-chatgpt-relay-v1` |
| 선택/전송 | README1~8, controller1~6, service1~10, settings1~3의 합성 근거4개 |
| 수정·검사·실행 | `writeAllowedFiles=[]`, `testCommandIds=[]`, `executionAllowed=false` |
| 기준 commit | `771f50f53f04fedb1a043c50654c0236e42cdd06` |
| requestBodyHash | `bc834b6f60ecaf7d697c7bb279f307e48e16e63a5aabcb2eeaf5aaf327176bbe`(8897byte·v9와 동일) |
| connectionProfileHash | `58420cd2fc191e27db95ce6056d97f08dfc6e1697a07ccfc372a58737d8ce679` |
| requestEnvelopeHash | `688d78d4b50ffd3898533ac8ae5eb181c944ab76c6242d6c9ee0639ca61ac7ad` |
| configHash | `03e365ee13fdcb01c75cc19cae1b266597c5d2ddd5fbc347a33e0f9bb7d346f0` |
| native SHA-256 | `4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc` |
| 승인·사용·소비·attempt·dispatch | 모두0(새 DB의 Task만1개) |

`review.txt`와 정확한 `request-body.json`, `input.txt`, `plan.json`, `payload.json`, `connection-profile.json`, `request-envelope.json`, `relay-config.json`을 검토한다. `readiness.json`, `preparation-summary.json`, source/Git33개·부모11개 manifest와782개 code/build manifest, 기존249개·테스트 source hash와 검사 로그를 분리해 보존한다. 검토 설정의 `enabled=true`는 새 계획 hash에 고정한 실행 준비 값이며 승인·소비0 상태를 우회하지 않는다. 승인 TTL은 아직 시작하지 않았다.

독립 읽기 전용 감사 `independent-readiness-audit.json`은 passed/blocker0이다. 닫힌 DB를 ro+immutable로 조회해 Task1개·승인/소비/attempt/dispatch0과 DB hash 불변을 확인했고 정확한 본문·정책 hash, 기존249개·시험 source262개·code/build782개·원본/Git33개·부모11개와 private 권한·만료를 대조했다. 감사 중 실제 인증 경로·CLI·native probe·네트워크는 실행하지 않았다. 최종 root 감사와 `artifact-hashes.json`으로 검토 파일을 고정한다. 승인 후 변경될 DB 자체는 불변 artifact 목록에서 제외하고 승인 대기 시점의 계수·hash를 감사 기록으로 보존한다.

하네스의 DB·로그에 원시 응답을 보관하지 않으며 native 임시 영역은 종료 확인 후 제거한다. 강제 중단·정리 불확실 시 잔류 내용을 완전히 제거했다고 주장하지 않는다. 위 검토 자료·계수0과 `not_run`은 승인 전 준비 시점의 기록이다. 이후 사용자의 별도 승인으로 아래 단건 실행을 완료했으며 소비된 승인을 복원하거나 재사용하지 않는다.

## 승인된 relay 실제 단건 호출과 사후 감사

2026-11-14 사용자가 이 정확한 계획에 대해 TTL10분·실제1회·자동 재시도0을 승인했다. 호출 전에 고정31개 artifact·코드/빌드782개·기존249개·시험 source262개·원본/Git33개·부모11개와 본문8897byte·모든 hash·native SHA·미소비 DB를 root와 독립 감사자가 재확인했다. 모델 호출 전에 코드·설정·응답 한도를 변경하지 않았다.

| 항목 | 결과 |
| --- | --- |
| 승인 ID | `211da1e5-1050-4e72-bd16-7480e09948e5` |
| 승인 구간 UTC | 2026-11-14T11:56:02.714Z ~ 12:06:02.714Z(정확600초) |
| 승인 구간 한국시간 | 11월14일20:56:02.714 ~ 21:06:02.714 |
| 사용·attempt 시작 | 2026-11-14T11:57:02.464Z(한국시간20:57:02.464) |
| 전달 예약 | 2026-11-14T11:57:02.477Z |
| attempt 종료 | 2026-11-14T11:57:22.179Z(한국시간20:57:22.179) |
| attempt ID | `36b8895e-fba7-480f-b619-c278b36a1a10` |
| Task/공개 오류 | `FAILED` / `READONLY_RELAY_CALL_FAILED` |
| adapter 오류 | `READONLY_RELAY_RESPONSE_LIMIT` |
| HTTP 관찰 | 200·헤더35개·3134byte |
| 승인·사용·소비·attempt·dispatch·upstream | 각각1회 |
| CLI run invocation·자동 재시도 | 1회·0회 |
| 완성 보고서·relay 결과·두 response hash | 모두없음/null |
| isolation·credentialAccess·cleanupConfirmed | passed·passed·true |

HTTP 응답 본문을 수신하다가 고정262144byte 상한을 초과해 거부했다. 실제 전체 크기·SSE/metadata 형태·최종 답변 내용은 보존하거나 확인하지 않았으며, 답변 자체의 크기나 추론 성공 여부로 해석하지 않는다. EOF 전 실패했으므로 전체 frame/JSON·인증 반사 검사와 native 최종 조사 결과 검증도 완료하지 못했다. HTTP200은 유효 조사 보고서의 증거가 아니다. 원시/부분/거부 응답을 DB·일반 로그에 저장하지 않았다.

root 사후 감사는2026-11-14T12:01:23.805Z에 passed를 기록했다. 원본/Git33개·부모11개·기존249개·시험 source262개·코드/빌드782개·고정31개 검토 파일이 보존됐고 source HEAD/main/base도 같다. controller72067·guardian72091·native child72092·native PGID-72092와 launcher71998·PGID-71998·wrapper71478은 모두ESRCH다. lifecycle/child는closed이며 sandbox와 빈 HOME이 없다. 로컬 종료/HTTP 정리가 원격 추론 중지를 보증하지는 않는다.

독립 사후 감사도2026-11-14T12:02:41.722Z에 passed/blocker0을 기록했다. DB의 단건 소비·실패 상태·정확한 계획/본문 hash와 고정 파일 보존, 프로세스/그룹 부재·compiled cleanup verifier=true를 읽기 전용으로 확인했다. 감사 과정의 추가 인증·CLI/recover·native probe·네트워크·모델 호출·DB 변경은0이다. 실제 실행 후 source 변경은 없고 문서만 갱신했다. 전체 회귀 재실행은 not_run(고정1096개 통과 코드의 hash 보존)이며 문서 diff 검사는 passed다.

새 실행 자료는 같은 review 디렉터리의 `pre-call-validation.json`, `pre-call-independent-audit.json`, `approval-result.json`, `run-invocation.json`, `run-invocation-result.json`, `run-result.json`, `post-run-audit.json`, `post-run-independent-audit.json`, `post-run-final-summary.json`과 `data/readonly-relay-runs/<task-id>/{call-report,lifecycle,child}.json`에 분리한다. `run-invocation.json`은 배타 생성으로 단건 CLI 실행을 표시하고 기존 승인 전 artifact는 덮어쓰지 않았다. `actual-call-artifact-hashes.json`으로 새 실행 자료를 고정하며 원시 응답·실제 인증값을 추가하지 않았다.

수용178의 실제 실행/단건·보존·로컬 종료 확인은 수행했지만 유효 보고서가 없어 최종 조사 성공은 failed/미완료다. 수용162도 미완료로 유지한다. 기존4-C-8의upstream16회·소비17개에 이번 relay1회·소비1개를 더해 누적 실제 upstream17회가 모두 실패했고 소비 승인은18개다(전송 전 실패1개 포함). 이번 승인·작업을 재사용하거나 자동 재시도하지 않는다. 다음 최소 작업은 응답 수집 경계의 오프라인 검토이며 추가 실제 호출은 수행하지 않았다.

## 응답 예산 보완의 로컬 구현과 검토 자료

256KiB 실패 뒤 별도 요청으로 `readonly-relay-codex-v2`·`codex-chatgpt-relay-v2`를 추가했다. v2 전체 응답 예산은4MiB이며 최종 조사 JSON16KiB·frame64KiB/2048개·깊이16·CLI128KiB/stderr16KiB·operation55초+공유 정리5초·EOF/인증 반사 검사 전 자식 전달0은 유지한다. v9와 relay-v1의 설정/profile/본문/계획 hash·기본256KiB 판정은 보존한다. 같은 합성 선택의 wire 본문은8897byte로 같다.

변경 파일은 `src/domain/readonly-relay.ts`, `src/policy/readonly-relay-{policy,protocol,reception-diagnostics,capacity-fixtures}.ts`, `src/adapters/readonly-relay-{broker,codex,capacity-probe}.ts`, 비활성 예시 `config/readonly-relay-budget.example.json`과 예산·수신 진단·capacity·native 통합 테스트다. 기존 잘못된 버전 거부 fixture는 새 유효 v2 대신 v3를 거부하도록 갱신했다. package/lock·기존 v9·승인 저장소·CLI 명령은 바꾸지 않았다.

수신 chunk 배열 대신 상한 크기의 단일 초기화 버퍼와 실제 길이 view를 사용한다.128chunk마다 event loop에 양보하고 현재 read/yield 하나에만 취소 waiter를 붙인다. 초기 단일byte 시험에서 공유 미해결 Promise의 handler 누적으로 RSS 증가148.75MiB가 선택 기준96MiB를 넘었다. 실패 측정과 수정 전 소스를 보존하고 waiter를 수정한 뒤 동일 시험의 RSS 증가24.88MiB·elapsed121.43ms를 확인했다. 이는 로컬 관찰이며 OS 메모리 상한 보장이 아니다.

최종 합성 행렬은 정상 corpus4개×1/2/4MiB의12행과 보완8행이다. 정상 body는18,931/588,150/1,654,598/2,874,461byte이며 가장 큰 case는1100delta·1191frame·최종3406byte다. 모든 corpus를 수용하고 정한 자원 기준을 통과한 최소 후보는4MiB다. 정상 case 최대elapsed69.74ms·CPU107.45ms·RSS 증가61.0MiB, 취소 관찰1.11ms 이하였다. 이 합성 반복 metadata는 실제 응답 분포나 이전 실패 응답의 크기를 추정하는 자료가 아니다.

v2의 수신 진단은 숫자8개와 `eof`·`termination`·`failedLimit`의 고정11키다. received/buffered/inspected 바이트를 구분하고 inspected는 wire prefix 관찰량으로 한정한다. 원문·필드명·값·ID·offset·임의 오류 문자열을 저장하지 않는다. observer 예외·transport가 재생한 과거 오류가 현재 진단 출처나 기존 판정을 바꾸지 않는지 검사했다. v1 call-report에는 새 필드를 넣지 않았다.

| 검증 | 결과 |
| --- | --- |
| lint / typecheck / build | passed |
| 고정 native 포함 전체 회귀 |1125 passed /0 failed /0 skipped |
| 원형 v1 차등 비교 |56 vectors·collector310비교·CLI4비교, 불일치0 |
| 용량 행렬 |20행 기대 결과·자원 기준 passed, 최소4MiB |
| 큰 합성 SSE native 통합 |v2 유효 보고서·EOF/두 hash/정리 passed, v1 동일 응답 상한 거부·기존 보고서 형식 보존 |
| 준비 시점 실제 인증/모델/전송 |not_run /0회 |

검토 디렉터리는 [stage4c9-relay-budget-jt1xn91r](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c9-relay-budget-jt1xn91r)다. 디렉터리0700·자료/설정/DB0600, 합성 source0555·파일0444를 유지한다. 계획 `5fa7b107-3486-44b0-bed4-482bb77da5cd`은2026-11-14T13:16:00.827Z에 생성됐고24시간 유효하다. 계획 hash는 `1408fd46d2933bfb8f0598e31b9cc3e3ee48314b086f6b16b5fd8825a0a2a101`이다. source/Git33개·부모11개·검증 소스279개·코드/빌드813개와 검토 자료41개를 고정했다. 기준270개 중264개가 불변이고 허용한 기존 relay 소스/테스트6개만 바뀌었다.

정식 독립 승인 전 감사23항목이 passed였고 DB의 task1·승인/사용/소비/attempt/dispatch0과 `AWAITING_APPROVAL`을 확인했다. 잠정 감사의 첫 checker는 DB payload wrapper를 직접 비교해 잘못된 실패를 기록했으며 수정된 감사로 정정하고 두 파일을 모두 보존했다. `pre-call-artifact-hashes.json`은 원래38개 manifest와 정정 감사·단건 실행 wrapper까지41개를 고정한다. 초기 실패 측정·감사 checker 오류와 수정 후 통과 자료를 덮어쓰지 않았다.

## 응답 예산 보완의 승인된 실제 단건 호출

사용자가 새 응답 상한 개선 계획에 TTL10분·실제1회·자동 재시도0을 별도 승인했다. 위 고정 코드·자료·원본을 다시 확인한 뒤 정확한 새 planHash로 승인1개를 만들고 단건 invocation marker를 배타 생성했다. 실행 중 예산·모델·설정·계약을 바꾸지 않았다.

| 항목 | 실제 결과 |
| --- | --- |
| Task / CLI 종료 코드 | `REPORTED` /0 |
| 승인 ID | `bc0670fc-661d-42f1-9180-dcfc116a4d05` |
| 승인 생성~만료 UTC |2026-11-14T13:25:40.496Z~13:35:40.496Z, 정확600초 |
| 승인 생성~만료 KST |2026-11-14 22:25:40~22:35:40 |
| 사용 / dispatch UTC |13:25:52.387Z /13:25:52.396Z, TTL 이내 |
| 완료 UTC / KST |13:26:17.617Z /22:26:17 |
| attempt | `0d485997-51d2-470f-9c63-13f03c47b643` |
| 승인/사용/소비/attempt/dispatch/upstream |각1회, 자동 재시도0 |
| HTTP |200, 헤더35개/3126byte |
| received / buffered / inspected |각362,095byte |
| chunk / 최대 chunk |229개 /16,378byte |
| frame / 최대 frame / 잔여 frame |1162개 /9313byte /0byte |
| EOF / 종료 / 한도 실패 |true /eof /none |
| raw response hash | `605e4725f90f8bbaa612fe3608bd292eb9a12d45b53974f60195e17f6f841ab9` |
| final text hash | `83b23801370feb2ec3eef130853d20c30bae63592ec8da7ef814fa53717b09f7` |
| 격리 / 부모 인증 접근 / 정리 |각passed |
| 원시 응답 보관 / 강제 종료 |없음 /없음 |

이번 관측 응답362,095byte는256KiB를 넘었고 새4MiB 전체 예산 이내였다. 일반 SSE/JSON·인증 반사·고정 CLI 해석·최종 schema/인용 검증을 통과해 `classification=question`·근거 사실5개의 조사 보고서를 얻었다. 보고서는 controller의 `createRequest(id)` 반환과 service의 신규201·중복409 흐름을 설명한다. 의미 정확성은 `not_run`이며 회사 자료·실제 대상 저장소·Slack·대상 코드 실행·Git 변경/외부 게시를 검증한 것은 아니다. 공급자 metadata/sequence/tool_usage 미검사와 원문 전체 민감정보/부모 text 비교 미수행도 그대로다. 한 번의 성공을 향후 모든 응답의 예산·호환성 보장으로 확대하지 않는다.

root 사후 감사에서 source/Git33개·부모11개·검증 소스279개·코드/빌드813개·검토41개와 하네스 HEAD/index/main3개 hash 보존을 확인했다. controller56956·guardian56961·child56963·native PGID-56963·launcher56899·PGID-56899·wrapper56395가 모두ESRCH이며 lifecycle/child는closed, sandbox와 빈 HOME은 없다. 로컬 프로세스 종료는 원격 추론 종료 확인과 구분한다. 실행 후 제품 소스 변경과 회귀 재실행은 not_run이며 고정 통과 코드 hash를 보존하고 결과 문서만 갱신한다.

독립 사후 감사20항목도 passed다. DB 원자 소비·기간 내 사용/전송/완료·저장 보고서 schema/근거/비밀/실행 필드와 reportHash 재계산·두 응답 hash의 보고서/attempt/call 간 일치·수신 숫자·고정 파일/원본/Git·프로세스/그룹 부재와 임시 영역 제거를 재확인했다. 폐기한 원시 wire와 원래 CLI 최종 text의 hash를 사후 직접 재계산한 것은 아니며, 생성 시 검증과 기록 간 일치를 확인한 것이다. 감사 중 추가 인증·모델·외부 네트워크·승인·run·DB 변경은0이다.

실행 자료는 같은 review의 `approval-result.json`, `run-invocation.json`, `run-launcher.json`, `run-invocation-result.json`, `run-result.json`, `post-run-audit.json`, `post-run-independent-audit.json`, `post-run-final-summary.json`과 실행 디렉터리의 `call-report.json`, `lifecycle.json`, `child.json`에 남기고 `actual-call-artifact-hashes.json`으로 고정한다. 소비 승인은 복원하지 않는다. 누적 실제upstream18회 중 성공1회·실패17회, 소비 승인19개이며 전송 전 실패1개를 포함한다. 수용178·186은 이 새 v2 단건에서 통과했고 기존 v9의 수용162는 미완료로 보존한다. 다음 최소 작업은 검토한 구현·실행 결과의 커밋이며 추가 호출은 수행하지 않는다.
