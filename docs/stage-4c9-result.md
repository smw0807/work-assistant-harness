# 단계 4-C-9 로그인 유지 relay 로컬 검증

2026-11-14 사용자가 ChatGPT 로그인 유지 방향을 선택했다. 비공개 응답 metadata의 개별 허용값을 계속 추가하는 대신, 고정 Codex가 응답을 해석하는 relay의 로컬 가능성을 확인한다. 구현 순서와 수용 기준은 [기준 계획](implementation-plan.md#단계-4-c-9-chatgpt-로그인-유지와-codex-응답-해석으로-전환)에 둔다.

현재 범위는 실제 인증·외부 transport·live 승인 DB와 분리된 합성 probe다. `liveReady=false`이며 실제 로그인 접근·모델 호출·외부 전송은 `not_run`이다. 이전 upstream16회 실패·소비 승인17개·수용162 미완료 기록은 그대로다.

## 구현과 검증

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

## 남은 경계

합성 `access_programs` 객체와 metadata는 로컬 fixture이며 실제 응답을 보존하거나 재현한 자료가 아니다. 실제 필드의 형태·내용·의미와 pinned Codex의 공급자 호환성은 미확인이다. 하네스는 metadata로 고정 요청·목적지·환경·OS 허용 권한·단건 전달 한도를 변경하지 않는다. Codex 내부의 metadata 해석과 그 효과는 별도의 미검증 범위다.

opaque relay의 비공개 metadata/sequence/tool_usage·원시 전체 민감정보 검사와 부모/CLI text 비교는 구형 계약과 동등하지 않다. 부모의 의도적인 인증 제공을 제한해도 upstream 본문에 인증값이 반사될 때 자식 비노출까지 보증하지는 못하므로 실제 연결 전에 별도 차단·검증해야 한다. 최종 JSON·인용·민감정보 검증, `tools=[]`·OS 차단과 프로세스 종료는 별도로 검증한다. 로컬 검증 완료 후의 최소 후속 작업은 책임 변경을 표시하는 새 live 계약·보고서·승인 저장소 구현이며, 구체 호출 계획과 별도 승인 전에는 실제 모델을 호출하지 않는다.
