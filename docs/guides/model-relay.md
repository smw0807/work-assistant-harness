# 읽기 전용 모델 호출과 relay

기존 합성 live 조사, ChatGPT 로그인 relay, 개인 시험 저장소 수집과 실행 예산의 명령·계약을 정리합니다. Slack 자동 분석의 설정은 [Slack 안내](slack.md)를 따릅니다.

각 버전의 설정·계획·승인은 분리됩니다. 이 문서의 기존 조사 경로는 Codex 0.154.0을 사용하며, Slack relay-v3의 Codex 0.167.2 지원을 자동으로 적용하지 않습니다. 실제 호출은 해당 계획에 대한 별도 승인이 필요합니다.

[문서 목록](../README.md) · [보안과 승인](../security-and-approval.md)

- [단계 4-C-8 합성 다중 파일의 실제 모델 읽기 전용 조사](#단계-4-c-8-합성-다중-파일의-실제-모델-읽기-전용-조사)
- [ChatGPT 로그인 유지 relay 검토](#chatgpt-로그인-유지-relay-검토)
- [단계 4-C-9 별도 relay 계약과 승인](#단계-4-c-9-별도-relay-계약과-승인)
- [단계 4-C-10 개인 시험 저장소 읽기 전용 조사](#단계-4-c-10-개인-시험-저장소-읽기-전용-조사)
- [개인 저장소 수집 v2와 마스킹 근거](#개인-저장소-수집-v2와-마스킹-근거)
- [시간·프레임 실행 예산 계약](#시간프레임-실행-예산-계약)

## 단계 4-C-8 합성 다중 파일의 실제 모델 읽기 전용 조사

`readonly-live-*`는 등록된 합성 `flow` fixture에서 승인한 근거만 고정 모델에 전달합니다. 기존 4-C-5/6/7 명령과 승인은 유지합니다. 실제 호출 실패와 후속 relay 전환 이력은 [4-C-8 결과](../history/stage-4c8-result.md)에 보존합니다.

`config/readonly-live.example.json`은 기본 비활성인 설정 예제입니다. 저장소 밖 현재 OS 사용자 소유의 비공개 `0600` 설정 파일에 native Codex 경로·SHA-256을 고정합니다. v1~v8의 기존 설정/profile 계약은 보존합니다. v2 이후 요청 헤더32개·8KiB, 응답 헤더64개·16KiB, 모델 `gpt-6.1-sol`, 인증 `chatgpt`, 호출60초·최종 JSON16KiB는 고정입니다. 비활성 설정으로 계획은 검토할 수 있지만 승인·실행은 거부합니다. 버전·`enabled`를 포함한 설정 변경은 새 계획과 승인을 요구합니다. 기존 로그인은 승인된 run adapter에서만 읽고 계획·승인·조회·취소·복구·정리는 인증에 접근하지 않습니다.

v3 profile은 decoder `readonly-live-response-v2`와 `discard-set-cookie-v1` 정책을 고정합니다. 응답 `Set-Cookie`는 중복을 허용하되 모든 항목을 헤더 수·바이트 한도와 문자 검사에 포함한 뒤 즉시 버립니다. 쿠키를 저장·전달·재사용하지 않으며 다른 중복 헤더는 거부합니다. 이 보완이 앞선 실제 실패의 원인이었다는 증거는 없습니다.

v4는 v3 metadata/SSE 계약을 유지하며 decoder `readonly-live-response-v3`와 `http-token-discard-set-cookie-v1`을 결합합니다. HTTP token 헤더 이름, ASCII·HTAB 값, MIME 공백·따옴표 UTF-8과 identity 대소문자 정규화를 보완하고 거부 조건별 정적 오류를 구분합니다. 비ASCII·압축·Location·Retry-After 거부와 쿠키 폐기는 유지합니다. 로컬 검증을 완료했으나 실제 실패 원인이 해결됐다고 단정하지 않습니다.

v5는 `Content-Type` 헤더가 없는 경우에만 제한된 본문 접두어로 JSON 또는 SSE를 선택합니다. 선택 뒤에는 기존 완료 응답·도구 차단·조사 schema·근거·크기 검증을 그대로 적용하며 파서 실패 시 다른 형식으로 재시도하지 않습니다. 명시된 잘못된 MIME·압축·HTML·미완성 응답은 계속 거부합니다. decoder `readonly-live-response-v4`와 `responseFormatPolicy=content-type-or-bounded-body-v1`을 새 승인 해시에 결합하고, v1~v4 계약은 변경하지 않습니다.

새 `response` 진단은 direct-response/created/in-progress/completed 경로와9종 거부 경계를 고정 enum으로 구분합니다. 키 검사 실패 때만 누락·예상 밖 필드의 고정 분류·8종 값 형태·횟수·overflow를 기록하며 원문 키·값·ID는 저장하지 않습니다. 필수5개·기존 선택28개와 관찰용8개 이름은 구분하고, 관찰 사전에 이름을 추가해도 응답을 허용하지 않습니다.

추가된 `metadata={event,field,reason}` 진단은 `RESPONSE_METADATA` 거부에서만 현재 decoder의 첫 실패 경계를 기록합니다. 경로4개·소스에 등록된 field39개·검사 사유6개만 허용하며 원문 키·값·응답 조각·ID·offset은 보관하지 않습니다. `shape/value/integer/number/text/size`는 실패한 검사 경계이고 원문 값의 확정된 형태 설명이 아닙니다. 정확한 own data property3개와 enum만 복사·동결하고 getter·symbol·추가 속성을 거부합니다. 내부 등록과 현재 decode 검증 경로를 확인하므로 transport/stream의 위조 오류와 과거 진짜 오류의 재생은 진단 증거가 되지 않습니다. v1/v2의 generic 오류와 `OUTPUT_LIMIT`·`TOOL_USAGE_ACTIVITY`, 기존 response 진단·profile/config/본문/명세 hash를 유지합니다. 이전 실제 실패의 필드·origin을 소급 확인한 것은 아닙니다. 이번 진단을 사용한 실제1회 결과는 최신 실행·감사 기록을 따릅니다.

추가한 `sseEnvelope`는 필수 키 누락의 고정 분류와 예상 밖 root 속성의 고정 필드·값 형태·횟수만 기록합니다. 최대128개 root 속성·32개 조합까지 집계하고 초과는 overflow로 표시합니다. 미등록 이름은 other로 분류하며 원문 키·값·ID는 보관하지 않습니다. 기존 v3~v7 응답 허용 조건·오류 code와 profile/config/body/envelope hash는 그대로입니다.

v8는 첫 `response.created`의 root에 추가 필드가 정확히1개이고 boolean이며 이름이 ASCII 식별자1~64자인 경우에만 그 필드를 검증용 사본에서 제외합니다. 알려진 SSE·제어·prototype 키는 제외할 수 없습니다. 기존 필수3키 검증과 원본 전체 민감정보 검사·sequence·내부 response·도구·완결성·크기 제한은 유지하고 추가 필드는 동작에 사용하지 않습니다. 이는 [공식 API의 이벤트 속성 추가 호환 정책](https://developers.openai.com/api/reference/overview#backwards-compatibility)을 참고한 제한적 정책이며 ChatGPT endpoint의 확정 schema 보장은 아닙니다. 실제 필드명·의미·ASCII 형태는 여전히 미확인입니다. 구형 v1~v7 계약은 그대로 두고 새 v8 profile·계획·승인을 요구합니다.

v9는 response의 알려진 필드를 기존대로 검사하고, 추가 JSON 필드만 최대8개·root 이름 ASCII 식별자64자·canonical UTF-8 합계16KiB·256노드·깊이8로 제한해 검증용 사본에서 제외합니다. 유한한 JSON 값만 받으며 제어/prototype root 키는 거부합니다. 제외할 원본 자료에도 숫자 별칭 없는 민감정보 검사를 적용하고 추가 자료는 보고서·상태·동작에 사용하지 않습니다. 새 `bounded-inert-json-v1` 정책과 한도를 profile에 결합하므로 새 계획·승인이 필요합니다. 이 버전의 합성 검증과 실제 실패 이력은 [4-C-8 결과](../history/stage-4c8-result.md)에 구분합니다.

v6는 공식 `tool_usage`의 정확한 경로·객체 형태를 검사한 숫자 집계만 민감정보 검사용 별칭으로 투영합니다. `tools=[]` 경계를 위한 하네스의 추가 정책으로 모든 수치를0으로 제한하고, 0이 아닌 집계는 정적 `TOOL_USAGE_ACTIVITY` 오류로 차단합니다. 실제 도구 호출·이벤트·출력은 계속 거부하며 v1~v5는 변경하지 않습니다. 공식 문서에서 집계0이나 선택 필드 생략은 도구 미실행의 증명이 아니므로 그렇게 해석하지 않습니다.

v7는 [공식 생성 이벤트 예시](https://developers.openai.com/api/reference/resources/responses/streaming-events)의 시작 sequence1을 지원하도록 첫 값을0 또는1로 받고 이후 연속성 검사는 유지하는 보완입니다. 원문 없는 정적 SSE 진단도 구현했습니다. 이번 v6 실패가 sequence 때문이었다고 확정한 것은 아니며, 구형 계약과 도구·출력·완료·근거·크기 검증은 유지합니다.

`readonly-live-run`은 승인 소비 전에 고정 바이너리의 존재·안전성·SHA-256을 확인합니다. 준비 검사 실패는 승인과 attempt를 소비하지 않으며, 준비 뒤 시간·취소·계획을 다시 검사합니다. 실행 직전의 바이너리 재검증도 유지합니다. native 합성 회귀에서 같은 0.154.0 바이너리를 별도 경로에 보관했다면 `HARNESS_NATIVE_CODEX_PROBE=1 HARNESS_NATIVE_CODEX_PATH=/absolute/path/to/codex pnpm test`로 지정할 수 있습니다. 이 환경변수는 테스트에만 적용되고 고정 SHA-256·버전 검사를 바꾸지 않습니다. 실제 CLI 실행 경로는 검토한 비공개 config에 명시해야 합니다.

```sh
pnpm harness readonly-live-plan --fixture flow --selection all --transfer controller --request flow-question --config /absolute/path/to/private-readonly-live.json --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-inspect --task <uuid> --data-dir /private/tmp/harness-readonly-live-data
# payload.inputText·requestBody·requestEnvelope와 설정, 다섯 hash·planHash를 검토한 뒤 승인
pnpm harness readonly-live-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 10 --config /absolute/path/to/private-readonly-live.json --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-run --task <uuid> --plan-hash <sha256> --config /absolute/path/to/private-readonly-live.json --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-inspect --task <uuid> --data-dir /private/tmp/harness-readonly-live-data

pnpm harness readonly-live-cancel --task <uuid> --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-invalidate --task <uuid> --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-recover --task <uuid> --data-dir /private/tmp/harness-readonly-live-data
pnpm harness readonly-live-prune --data-dir /private/tmp/harness-readonly-live-data
```

plan/approve/run은 `--config`가 필수입니다. plan의 `--selection all|controller|service`는 읽기 범위, `--transfer all|controller|service`는 그중 전송 근거를 선택하며 기본값은 `all`입니다. `--request flow-question|change-request`의 기본값은 `flow-question`입니다. profile은 설정 버전에 결합되며 임의 URL·모델·헤더·인증·저장소·본문·profile 옵션은 없습니다. v1~v7 실제 실패 이력과 로컬 검증 통과를 구분합니다. 변경 요청도 읽기 전용 보고서만 만들며 수정 파일·대상 검사 목록은 빈 배열입니다.

계획·내용은 생성부터 24시간, 승인 TTL은 명시적 1~60분입니다. 승인 소비와 단일 전달 예약 이후 원본·기간·설정·generation을 다시 확인하고 최대 한 번 전송합니다. 인증은 부모 broker 메모리에만 두며 Codex에는 빈 HOME/CODEX_HOME과 단건 capability만 제공합니다. 승인된 최종 본문을 고정 endpoint에 전달하고 retry·redirect·다른 모델 fallback을 하지 않습니다. 실패·취소·중단은 승인 소비를 복원하지 않으며, HTTP 취소를 원격 미접수나 서버 측 추론 종료 증거로 간주하지 않습니다.

응답은 완성된 조사 JSON과 전송한 근거 인용을 검증한 뒤 로컬에 보관합니다. schema 통과는 내용의 의미 정확성을 보증하지 않습니다. 실제 연결 증거와 합성 port 검증을 분리하고 수행하지 않은 검사는 `not_run`으로 남깁니다. 내용은 24시간, 본문 없는 감사는 최초 terminal부터 30일, 최소 소비 marker는 DB 수명 동안 보존합니다. 자식 종료 후 새로 만든 모델 임시 디렉터리와 빈 HOME/CODEX_HOME만 identity를 확인해 제거합니다. 합성 원본/Git·DB·감사 및 실패 작업물은 보존하며, 프로세스 종료나 임시 디렉터리 제거가 불확실하면 `BLOCKED`로 남깁니다.

inspect·cancel·invalidate는 전역 lease 중에도 동작하며 나머지는 lease를 요구합니다. inspect는 `--approval-offset <0..1000000000>`을 지원합니다. run은 `REPORTED`일 때만 종료 코드 0입니다. recover는 인증·모델·네트워크 없이 종료·원본·명세 증거를 확인하며 불확실하면 `BLOCKED`로 남깁니다. 회사 자료·실제 저장소·Slack·대상 코드 실행·브랜치/patch·commit/push·PR/MR과 실행 계획 export는 제공하지 않습니다. 기존 대상 작업 브랜치 규칙은 하네스 자체의 개발 규칙으로 확대하지 않습니다.

## ChatGPT 로그인 유지 relay 검토

relay는 ChatGPT 로그인을 유지하고 공급자 응답 해석을 고정 Codex에 맡기는 경로입니다. 기존 `readonly-live-*` v1~v9 명령과 승인은 유지하며 공개 API 키 전환이나 `access_programs` 개별 허용 추가와 구분합니다.

relay의 원시 metadata·도구 집계 검증과 최종 보고서 검증은 보증 범위가 다릅니다. [전환 계획](../implementation-plan.md#단계-4-c-9-chatgpt-로그인-유지와-codex-응답-해석으로-전환)과 [합성·실제 단건 검증 결과](../history/stage-4c9-result.md)에 차이와 실행 이력을 기록합니다.

## 단계 4-C-9 별도 relay 계약과 승인

`synthetic-readonly-relay-v1`·`codex-chatgpt-relay-v1`은 기존 ChatGPT 로그인과 고정 native Codex를 사용하는 새 계약입니다. `readonly-live-*`의 v1~v9 정책·DB·승인·hash는 유지하며 새 `readonly-relay.sqlite`와 `readonly-relay-runs/`를 사용합니다. 설정 예시 [readonly-relay.example.json](../../config/readonly-relay.example.json)은 기본 비활성입니다. 복사한 private 설정의 native 경로·SHA-256을 실제 검증한 값으로 지정해야 합니다. enabled 변경도 계획 hash가 달라지므로 새 계획이 필요합니다.

전체 응답 예산을 보완한 `readonly-relay-codex-v2`·`codex-chatgpt-relay-v2`는4MiB와 `readonly-relay-reception-v1` 진단 정책을 별도 profile/hash에 고정합니다. [readonly-relay-budget.example.json](../../config/readonly-relay-budget.example.json)도 기본 비활성이고 명령은 아래와 같습니다. v1의256KiB·config/profile/본문/계획 hash와 v9 경로를 보존하며 v1/v2 계획·payload·설정·승인을 서로 바꿔 쓰지 못합니다. 같은 선택의 요청 본문은 유지하지만 새 profile·config·planHash에 대한 별도 승인이 필요합니다.

```sh
pnpm harness readonly-relay-plan --fixture flow --config /private/path/relay.json --selection all --transfer all --request flow-question --data-dir /private/path/relay-data
pnpm harness readonly-relay-inspect --task <uuid> --data-dir /private/path/relay-data
# 정확한 payload·profile·명세·설정과 planHash를 검토하고 별도 승인한 뒤에만 사용
pnpm harness readonly-relay-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 10 --config /private/path/relay.json --data-dir /private/path/relay-data
pnpm harness readonly-relay-run --task <uuid> --plan-hash <sha256> --config /private/path/relay.json --data-dir /private/path/relay-data
pnpm harness readonly-relay-cancel --task <uuid> --data-dir /private/path/relay-data
pnpm harness readonly-relay-invalidate --task <uuid> --data-dir /private/path/relay-data
pnpm harness readonly-relay-recover --task <uuid> --data-dir /private/path/relay-data
pnpm harness readonly-relay-prune --data-dir /private/path/relay-data
```

plan/approve/run은 `--config`가 필수입니다. fixture는 `flow`, selection/transfer는 `all|controller|service`, request는 `flow-question|change-request`만 허용합니다. inspect는 `--approval-offset <0..1000000000>`을 지원합니다. inspect/cancel/invalidate 외 명령은 전역 lease를 사용하고, run은 `REPORTED`일 때만 종료 코드0입니다. 다른 URL·모델·헤더·인증·도구·실행 export 옵션은 없습니다.

부모는 승인 본문 바이트만 최대1회 전송하며 인증 조회 직전과 네트워크 전송 직전에 승인 기간·generation·원본을 재검증합니다. 로그인 파일은 승인된 run의 부모만 읽고 refresh·복제·변경하지 않습니다. 자식은 빈 HOME과 단건 capability만 받습니다. retry/redirect/fallback은0이고 실패·중단 뒤 소비를 복원하지 않습니다.

응답은 v1에서256KiB, v2에서4MiB의 전체 상한을 적용해 EOF까지 부모 메모리로 수신한 뒤 UTF8·SSE frame64KiB/2048개·일반 JSON 문법/중복 키/깊이16·인증값 반사를 검사합니다. 전체 wire 예산과 최종 조사 JSON16KiB는 독립된 한도입니다. 수신은 상한 크기의 단일 초기화 버퍼를 쓰고 실제 길이만 hash·검증·전달합니다. 이 버퍼 한도가 프로세스 전체 메모리 상한은 아닙니다. 통과 전 자식 전달은0입니다. 원문·Unicode escape·순서 있는 JSON 문자열 조각과 최종 CLI JSON의 실제 token/account 반사를 검사하되, 임의 인코딩·암호화·변형 전반의 탐지는 보증하지 않습니다. upstream 헤더·쿠키·오류 본문은 자식에 중계하거나 저장하지 않습니다.

v2의 `call-report.json.reception`에는 수신/보관/계수 관찰 바이트·chunk·frame 계수와 EOF·고정 종료/한도 enum만 남깁니다. `inspectedBytes`는 제한된 wire prefix의 계수 관찰량이며 JSON·반사 검증 완료량이 아닙니다. 상한 초과를 일으킨 chunk 전체가 `receivedBytes`에 잡혀도 모두 버퍼에 저장하지 않습니다. 원시 본문·필드명·값·ID·오류 문자열은 이 진단에 넣지 않으며 observer 실패는 원래 판정을 바꾸지 않습니다.

Codex가 응답 의미를 해석하고 하네스는 단일 완료 turn·최종 조사 JSON16KiB·전달 근거/줄·비밀/실행 필드를 검증합니다. 보고서의 `responseHash`는 원시 바이트, `finalTextHash`는 최종 text를 식별합니다. `contractVerified.cliOutput`과 `unverifiedResponseChecks`를 분리하며 private metadata·공급자 sequence/tool_usage·원시 전체 민감정보 검사·부모 text 비교를 통과했다고 표시하지 않습니다. `tools=[]`·OS 격리·CLI 도구 결과 거부는 유지하지만 공급자 도구 활동0을 보증하지 않습니다. operation55초와 공유 정리 대기5초를 적용하고 종료 불확실은 `BLOCKED`로 남깁니다. 하네스 DB·일반 로그에 원시/부분/거부 응답을 저장하지 않습니다. native 임시 영역은 종료 확인 후 제거하며 정리 불확실 시 잔류 내용의 제거를 보증하지 않습니다. 내용24h·terminal 감사30d·DB 수명 소비 marker를 유지합니다.

## 단계 4-C-10 개인 시험 저장소 읽기 전용 조사

`personal-readonly-*`는 개인 시험 저장소 한 개의 고정 commit·질문·선택 파일을 조사하는 별도 경로입니다. [등록 예시](../../config/personal-readonly.example.json)를 저장소 밖 현재 OS 사용자 소유0600 파일로 복사해 정확한 root·commit·질문·읽기 줄과 전송할 파일을 지정합니다. 모델 입력과 승인 snapshot에는 로컬 root나 inode 명세를 넣지 않습니다. 실제 자료·입력·계획·승인은 기존 합성 경로와 분리하며 `personal-readonly.sqlite`를 사용합니다.

```sh
pnpm harness personal-readonly-plan --registration /private/path/registration.json --config /private/path/relay-v2.json --data-dir /private/path/personal-data
pnpm harness personal-readonly-inspect --task <uuid> --data-dir /private/path/personal-data
# 정확한 질문·전송 본문·범위·planHash를 검토하고 별도로 승인한 뒤에만 사용
pnpm harness personal-readonly-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 10 --config /private/path/relay-v2.json --data-dir /private/path/personal-data
pnpm harness personal-readonly-run --task <uuid> --plan-hash <sha256> --config /private/path/relay-v2.json --data-dir /private/path/personal-data
pnpm harness personal-readonly-cancel --task <uuid> --data-dir /private/path/personal-data
pnpm harness personal-readonly-invalidate --task <uuid> --data-dir /private/path/personal-data
pnpm harness personal-readonly-recover --task <uuid> --data-dir /private/path/personal-data
pnpm harness personal-readonly-prune --data-dir /private/path/personal-data
```

별도 패키지 스크립트 없이 기존 `pnpm harness`에서 위 명령을 사용합니다. plan은 `--registration`과 `--config`, approve/run은 `--config`가 필수입니다. 설정은 기존 `readonly-relay-codex-v2`만 받고 profile·모델·목적지·4MiB/최종16KiB·단건/EOF/반사/종료 한도는 유지합니다. plan24h·승인TTL1~60분·inspect의 `--approval-offset`과24h/30d 보관도 유지합니다. run은 `REPORTED`일 때만 종료 코드0입니다. 변경된 등록이나 전송 범위에는 새 계획과 승인이 필요합니다.

reader는 대상 프로그램·Git CLI·설정·hooks를 실행하거나 import하지 않고 필요한 Git 객체와 선택 파일을 읽습니다. 일반 `.git`·SHA1 저장소와 제한된 pack만 지원하며 linked worktree·submodule·thin pack·한도 초과는 거부합니다. 선택 파일이 기준 commit과 index에 일치하는지, HEAD/index/ref·파일·부모 identity가 바뀌지 않았는지 확인합니다. 관찰 범위 밖 파일의 내용이나 전체 작업 트리 clean 상태는 검증하지 않습니다. 파일32KiB·근거64KiB·입력128KiB·8파일/16범위/범위당200줄 한도를 유지하며 선택 파일 전체의 비밀·binary 검사는 부분 줄 선택으로 우회할 수 없습니다. 대상 root와 runtime/data 경로는 겹칠 수 없습니다.

개인 v1의 초기 수집·합성 native 검증 범위는 [4-C-10 기록](../history/stage-4c10-result.md)에 남겨 두었습니다. 실제 개인 자료의 인증·모델·외부 전송은 구체적인 새 계획의 승인을 따릅니다. 대상 코드의 설치·테스트·빌드·스크립트·수정·거래 API 호출·자동 답장·Git 변경은 제공하지 않습니다. 구체 결과와 누락 근거는 [4-C-10 결과](../history/stage-4c10-result.md)를 따릅니다.

## 개인 저장소 수집 v2와 마스킹 근거

[새 등록 예시](../../config/personal-readonly-collection.example.json)는 `version: personal-readonly-registration-v2`와 `collectionPolicy: personal-readonly-collection-v2`를 명시합니다. 위 `personal-readonly-*` 명령을 그대로 사용하지만 새 입력/계획 v2와 수집 profile/hash로 승인을 분리합니다. 기존 개인 v1·relay-v2의 설정/profile/본문/hash·원문 민감 거부와 소비 기록은 유지합니다. 기존 계획을 자동 승격하지 않습니다.

새 수집 계약은 **원본 파일64KiB·전체 안전 view64KiB·개별 전송 발췌32KiB·근거 합계64KiB**를 구분합니다. 기존 relay-v2 profile은 변경 없는 전송 구성 요소이며, 그 안의 legacy `fileBytes: 32768`을 새 원본 수집 권한으로 해석하지 않습니다. 실제 원본 읽기/변환 권한은 별도로 승인하는 `collectionProfile`과 hash에 고정합니다. 입력128KiB·8파일/16범위/범위당200줄·전송 수신4MiB·최종16KiB는 유지합니다.

원본 전체를 기존 UTF8/binary·민감 검사로 먼저 검사합니다. 민감 거부를 무시해 원문을 허용하지 않으며, 명시된 새 계약에서만 고정 패턴의 매치 전체를 줄 보존 마커로 바꿉니다. 그 전체 view가 동일 민감 검사에 다시 통과해야 선택 줄을 근거로 쓸 수 있습니다. 경로·Git·크기·binary 오류는 마스킹 대상이 아닙니다. 원문이 거부되고 view만 통과한 상태, 마스크 개수·줄수와 원본/view hash를 구분합니다. 원시 매치·비밀값이나 원문/전체 view 본문은 DB·보고서에 복제하지 않습니다.

새 근거의 `fileHash`는 안전한 전체 view의 hash이며 원본 파일 hash는 private provenance에 둡니다. 모델에는 선택한 안전 발췌와 view hash·변환 고지만 전달합니다. 줄 번호는 보존되지만 변환된 자료이므로 가려진 코드를 추정하거나 완전한 원본으로 표시하면 안 됩니다. 새 보고서는 `collection.evidenceOrigin: line-preserving-derived-view`와 수집/근거 hash를 필수로 기록합니다. 원본이 달라지면 view가 같아도 승인·인증·전송·완료 단계에서 차단합니다.

v1/v2는 같은 개인 DB의 lifecycle을 공유하며 계약별로 검증합니다. v2 작업이 있는 DB를 구형 실행 파일로 열면 알 수 없는 계약으로 거부될 수 있습니다. 개인 v2의 준비·실제 호출·원본/Git 보존과 종료 검증 이력은 [4-C-11 결과](../history/stage-4c11-result.md)에 기록합니다. 추가 실제 호출에는 새 계획과 별도 승인이 필요합니다.

## 시간·프레임 실행 예산 계약

새 실행 예산은 기존 relay-v2·개인 수집 v2를 보존하고 별도 `readonly-relay-codex-v3` 설정과 개인 등록/입력/계획 v3로 연결합니다. [새 설정 예시](../../config/readonly-relay-execution-budget.example.json)와 [개인 등록 예시](../../config/personal-readonly-budget.example.json)를 private 경로에서 작성해 `personal-readonly-*`의 기존8개 명령을 사용합니다. 임의 timeout/frame 옵션이나 실행 중 자동 상한 증가는 제공하지 않습니다. 설정의 전체 timeout과 operation·native idle·collector·broker·guardian의 예산, 정리 상한을 하나의 고정 `readonly-relay-execution-budget-v1` 명세에서 가져옵니다.

현재 relay-v3의 고정 예산은 작업120초·정리5초·전체125초·최대8192프레임입니다. 전체 응답4MiB·frame64KiB·최종16KiB·native 출력 합계128KiB/stderr16KiB·EOF/민감정보/인증 반사 검사와 단건·재시도0을 유지합니다. 이전 후보 비교와 55초 초과 native 합성 검증은 [4-C-12 기록](../history/stage-4c12-result.md)에 보존하며, 실제 공급자의 완료시간을 예측하는 보장은 아닙니다.

새 개인 계획은 기존 수집 v2의 안전 view와 원본 provenance를 재사용하고 별도 실행 예산/hash를 입력·계획·보고서에 결합합니다. 구형 등록·계획·승인을 자동 변환하지 않으며 unknown/mixed 계약을 거부합니다. 로컬 준비와 별도 승인된 실제 단건 호출의 `REPORTED`·원본 보존·종료 검증은 [4-C-12 결과](../history/stage-4c12-result.md)를 따릅니다. 추가 실제 호출에는 새 계획과 별도 승인이 필요합니다.
