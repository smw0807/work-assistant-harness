# 단계 4-C-7 다중 파일 모델 연결 준비 결과

검증일: 2026-11-12. 메모리 가짜 전송기만 사용해 수용 135~150을 오프라인으로 검증했다. 실제 모델 호출·인증정보 접근·외부 서비스 전송은 0회다.

## 구현 범위

- 새 `synthetic-readonly-model-preflight-v1` 정책과 `readonly-model-preflights.sqlite`, 승인/attempt/process namespace를 구현했다. 기존 4-C-4/5/6 계약·해시·승인은 변환하지 않는다.
- 로컬 `codex-broker.ts`의 경로/내용 hash를 참고 근거로 고정한 `responses-candidate-json-v1`/`responses-candidate-sse-v1` profile을 추가했다. 실제 공급자 규격이나 인증 방식의 호환성을 주장하지 않는다. 모델은 합성 ID이며 `https://model.invalid/v1/responses`는 접속하지 않는 시험 명세 문자열이다.
- 선택 근거를 `input`에, 조사 schema를 `text.format`에 담고 `tools=[]`, `store=false`, profile의 `stream`을 고정한다. 인증 없는 method/URL/headers/body/redirect/retry 명세에 `connectionProfileHash`·`requestEnvelopeHash`를 추가하고 기존 context/input/body hash와 함께 승인·예약·복구에 결합했다.
- 필수 fake broker는 검증한 명세를 복제·동결하여 한 번 전달한다. 전달 예약을 먼저 commit하고 별도 DB 트랜잭션 안에서 실제 동기 fake 호출을 시작해 취소 writer와 직렬화한다. 네트워크 전송 기본값·인증 공급자·외부 SDK/CLI는 없다.
- HTTP 상태/중복 헤더/MIME/encoding을 검사하고 JSON/SSE에서 완료된 assistant text 한 건만 추출한다. SSE는 incremental UTF-8, LF/CRLF, 여러 data 줄, frame 크기/개수, 순서·ID·delta/최종 text를 검증한다. 주석/빈 frame은 계수 후 무시하고 `[DONE]`, `usage`, 도구/refusal·추가 출력은 이 후보 계약에서 거부한다. 기존 비밀 판별 규칙을 완화하지 않았다.
- 근거 64KiB·입력 128KiB·본문/응답 body 각 256KiB·명세 272KiB·요청/응답 헤더 각 8KiB/16개·SSE frame 64KiB/2,048개·최종 JSON 16KiB·stderr 16KiB를 적용한다. 전달/응답 55초와 정리 5초 상한, 전달 최대 1회·재시도 0회다. iterator가 타이머 실행을 지연시켜도 작업/정리 후 단조 시각으로 기한을 다시 확인한다.
- 제한 worker는 고정 하네스 모듈 외 읽기·쓰기·네트워크·추가 프로세스/worker를 차단하고 LANG/TZ 외 사용자 환경을 전달하지 않는다. 부모 IPC 단절 시 종료하며 lifecycle은 본문/profile/명세 hash와 소유 프로세스 증거만 남긴다. 실제 인증 경로의 존재 확인도 하지 않는다.
- 취소·timeout·늦은 응답·부모 강제 종료 후 명시 복구·private 보관을 구현했다. payload 24시간, 최초 terminal 감사 30일, 소비 marker는 DB 수명 동안 보존한다. raw/부분/거부 응답은 보관하지 않고 원본/Git을 자동 정리하지 않는다.
- `readonly-model-preflight-{plan,inspect,approve,run,cancel,invalidate,recover,prune}` 8개 명령과 `--profile json|sse`를 제공한다. `liveReady=false`와 실제 모델/인증/외부 전송/공급자 호환성/live 격리/의미 정확성 `not_run`을 보고한다.

## 검증 명령과 결과

macOS arm64와 기존 설치된 Node v26.12.1·의존성을 사용했다. 패키지/lockfile을 변경하거나 설치하지 않았다. 원래 저장소 밖의 임시 검증 복사본에서 실행한 뒤 검증한 소스·문서·테스트만 원래 저장소에 반영했다.

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src tests
node node_modules/typescript/bin/tsc
HARNESS_NATIVE_CODEX_PROBE=1 node --test dist/tests/*.test.js
```

**최종 결과: 전체 726개 통과(기존 642개 + 신규 84개), 실패 0·skip 0. 타입 검사·lint·빌드 통과.** 전체 테스트 실행 시간은 약 56초였다.

신규 검사는 정책 13개, 상태/승인/보관 31개, broker 6개, worker 7개, CLI 7개, 구형 계약/의존 그래프 격리 2개, HTTP/JSON/SSE protocol 16개, 독립 시간 경계 재현 2개다. 요청 golden fixture와 응답 기대값은 테스트 대상 encoder/decoder로 생성하지 않았다.

첫 전체 실행은 임시 복사본의 node_modules symlink와 외부 sandbox 제한 때문에 기존 검사 67개가 실패했다(726개 중 659개 통과). 설치된 의존성을 임시 경로에 로컬 복사하고 기존 loopback 가짜 HTTP·로컬 OS 격리 검사를 실행 가능한 환경에서 다시 수행한 최종 결과가 위 726개 통과다. 신규 경로는 HTTP listener나 소켓을 사용하지 않는다. 기존 native 검사 3개와 loopback 회귀도 실제 모델·로그인 정보·외부 서비스 호출 없이 수행했다.

## 수용 기준 135~150

아래 `정책`, `상태`, `broker`, `worker`, `CLI`, `격리`, `protocol`, `독립 경계`는 각각 `tests/readonly-model-preflight-{policy,lifecycle,broker,worker,cli,isolation,protocol,protocol-review}.test.ts`를 뜻한다.

| 기준 | 결과 | 검증 근거 |
| --- | --- | --- |
| 135 오프라인·기존 계약 보존 | passed | 필수 fake/mode 검사, 같은 owner/UUID의 4-C-4/5/6 승인 혼용 거부, 이전 DB 파일 hash/승인 상태 불변, 실제 transport·credential 의존 경로 차단 |
| 136 profile 고정 | passed | 로컬 근거 파일 hash·profile/codec/schema/한도 결합, 반환 profile 변조가 새 profile에 영향 없음, 임의 profile/live/URL/모델/헤더 옵션 거부 |
| 137 권한·최소 입력 | passed | 네 파일 읽기 중 controller/service만 선택 전달, 미선택 근거/호스트 경로 제외, 빈 수정/명령 범위, 구형 실행/export 연결 거부 |
| 138 요청 encoder | passed | 독립 golden 바이트와 Unicode/escaping 비교, input/text.format·tools/store/stream 고정, 구형 schema·추가 이력/도구·중복 키·비정규 직렬화 거부 |
| 139 명세·다섯 hash | passed | 저장·승인·fake 포착 명세 일치, profile/URL/헤더/본문 변조 및 hash 재계산 공격 거부, 대소문자 중복/CRLF·인증/계정/proxy 필드 거부 |
| 140 승인·만료·재검증 | passed | 소유자·planHash·명시 TTL1~60분·24h·현재 dispatch 시각·revision/원본 검증, stale/취소/위조·다섯 hash/config 변경 거부 |
| 141 원자 소비·단건 전달 | passed | 동시 claim·DB 실패·예약 이후 중단·중복 dispatch 검사, commit 전 호출0·실제 fake 시작 직렬화·최대1회·소비 복원 없음 |
| 142 HTTP 처리 | passed | 3xx/401/403/429/5xx·Location/Retry-After·잘못된 헤더/MIME/encoding/body 거부, iterator 정리와 retry/refresh/redirect 없음 |
| 143 JSON 후보 decoder | passed | 독립 JSON fixture, 잘못된 UTF-8/중복 키·모델/ID/output·도구/refusal·복수 text 거부, 최종 조사 schema·인용/줄·비밀 검사 |
| 144 SSE frame·이벤트 | passed | 1바이트 chunk·CRLF·여러 data 줄, 응답/항목 ID·순서·최종 text 일치, 미지원/도구·잘린/중복/누락 완료·완료 뒤 data·[DONE] 거부 |
| 145 자원 한도 | passed | 입력/본문/명세/헤더/응답/최종 JSON·frame 크기/개수 경계와 초과, 주석/빈 frame·다국어 분할 계수, stdout/stderr·55초/5초 상한 |
| 146 취소·timeout | passed | claim/전달/응답/저장 generation 경합, abort 무시·끝나지 않는 return·늦은 결과 차단, 단조 시각의 작업/정리 기한 재현, 정리 불확실 BLOCKED |
| 147 중단·복구 | passed | 실제 부모 SIGKILL/IPC 단절 worker 종료 후 새 CLI의 INTERRUPTED, 증거 누락/변조·hash 불일치·만료·불확실 PID는 BLOCKED, 재호출0 |
| 148 격리·인증 비접근 | passed | 실제 Node 권한의 합성 canary read/write/TCP/child/worker 거부, 환경 비상속·확장 권한 거부, 의존 그래프 금지 경로와 fetch 호출0 |
| 149 보관·live 승격 차단 | passed | private DB/sidecar·24h/최초 terminal30일/소비 marker, raw/부분/거부 내용 비보관·원본 자동 삭제 없음, liveReady/제외 항목 변조 거부 |
| 150 CLI·회귀·종단 | passed | 문의/변경 요청·부분 전달·JSON/SSE·오류/취소/복구·원본/Git 무변경, 726개와 타입/lint/build 통과, 실제 모델/인증/외부 전송0 |

## 결과 해석과 남은 범위

이 결과는 합성 문맥의 요청/명세 변환과 승인·전달·응답 검증·중단/복구 계약에 대한 오프라인 검증이다. 가짜 응답이나 인용 schema 검사는 모델의 의미 정확성을 증명하지 않는다. `offlineContractVerified`가 모두 passed여도 `semanticAccuracyVerified=false`, `liveReady=false`다.

실제 endpoint/model/인증 방식·공급자 프로토콜 호환성·live OS 격리·회사 자료/실제 저장소/Slack 연결·대상 코드 실행·Git 원격 작업은 미구현 또는 미검증 후속 범위다. 이 단계의 승인·보고서를 live 설정이나 실행 권한으로 승격하는 경로는 없다.
