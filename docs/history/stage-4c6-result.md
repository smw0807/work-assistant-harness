# 단계 4-C-6 합성 다중 파일 모델 연결 준비 결과

검증일: 2026-11-12. 실제 모델 호출·인증정보 접근·외부 전송을 제외하고 가짜 전송기로 오프라인 검증했다. 등록 합성 fixture의 새 문맥만 사용하며 기존 4-C-5 승인을 재사용하지 않는다.

## 구현 범위

- 정책 `synthetic-readonly-transport-v1`, `mode: offline`, `transport: fake`, `responseOrigin: synthetic`, 모델 `synthetic-investigator-v1`, 목적지 `local:readonly-transport`, 인증 `none`을 고정했다. 별도 `readonly-transports.sqlite`와 프로세스 기록을 사용한다.
- 등록된 `flow` fixture에서 새 ID로 문맥을 수집한다. `contextHash`는 전체 근거, `inputHash`는 선택 근거와 지시문/요청/schema, `requestBodyHash`는 모델과 tools/store/stream까지 감싼 최종 요청 바이트를 식별한다. 읽기·전달을 분리하고 수정/대상 명령은 빈 목록이다.
- 최종 본문을 표시·보관한 뒤 OS 소유자의 명시적 TTL 승인으로 한 번 전달한다. broker는 필수 fake port와 본문 해시를 검사하고 저장된 문자열을 그대로 보낸다. 실제 transport 기본값·fetch·credential loader·모델 CLI는 이 경로에 연결하지 않는다.
- `synthetic-json-v1`은 단일 JSON envelope, `synthetic-stream-v1`은 로컬 NDJSON의 시작·순서 있는 delta·완료 이벤트를 사용한다. 이는 합성 프로토콜이며 실제 공급자 API/SSE 호환성 검증이 아니다.
- 제한 Node worker는 최종 요청만 stdin으로 받고 고정 하네스 모듈 외 읽기·쓰기·네트워크·추가 프로세스/worker 권한을 갖지 않는다. 환경은 LANG/TZ만 전달하며 macOS가 주입하는 표시 인코딩 힌트는 제거한다. 실제 토큰이나 로그인 파일에 접근하지 않는다.
- 4-C-5 수집 한도와 입력128KiB를 유지하고 최종 요청/전체 응답 각각256KiB, 최종 조사 JSON16KiB, worker stderr16KiB, 전체60초, 전달 최대1회·재시도0회를 적용한다. envelope/stream·최종 JSON·근거를 검증하며 invalid raw/부분 응답은 보관하지 않는다.
- 승인 소비·attempt·전달 예약을 영속화하고 세 hash와 configHash·generation을 묶는다. 취소/timeout은 종료를 확인하며 늦은 성공을 거부한다. 원본 변조 또는 정리 불확실은 BLOCKED다. 재시작 후 명시 recover만 원본·본문 hash·프로세스 종료 증거를 확인해 INTERRUPTED/BLOCKED로 기록한다.
- private 내용 payload는 계획 생성 후24시간, 본문 없는 감사는 최초 terminal부터30일, 최소 중복 marker는 DB 수명으로 구분한다. 만료 내용은 다음 명령/prune에서 정리하며 원본/Git/잔여 작업물을 자동 삭제하지 않는다.

## 검증 명령과 결과

환경은 macOS arm64, Node v26.12.1이다. 기존 설치 의존성을 로컬로 사용했으며 패키지·lockfile을 바꾸거나 설치하지 않았다. 검증 중 실제 모델 호출·실제 인증정보 접근·외부 서비스 전송은 0회다.

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src tests
node node_modules/typescript/bin/tsc
HARNESS_NATIVE_CODEX_PROBE=1 node --test dist/tests/*.test.js
```

최종 결과: **전체 642개 통과(신규59개 + 기존583개), 실패0·skip0. 타입 검사·lint·빌드 통과.**

기존 macOS guardian/self-exec 검사3개는 실제 모델이나 로그인 정보 없이 로컬 프로세스 종료·격리를 검사한다. 기존 broker 회귀의 loopback 가짜 서버와 신규 가짜 IPC는 외부 서비스 전송과 구분한다. 새 worker에는 실제 네트워크 권한이 없으며 수용 검사는 합성 canary와 로컬 프로세스만 사용한다.

## 수용 기준 119~134

`정책`은 `readonly-transport-policy.test.ts`, `상태`는 `readonly-transport-lifecycle.test.ts`, `broker`는 `readonly-transport-broker.test.ts`, `worker`는 `readonly-transport-worker.test.ts`, `CLI`는 `readonly-transport-cli.test.ts`, `계약 분리`는 `readonly-transport-isolation.test.ts`를 뜻한다.

| 기준 | 결과 | 검증 근거 |
| --- | --- | --- |
| 119 오프라인 전용 | passed | 필수 fake port 누락/legacy/live 거부, 실제 adapter/credential loader가 없는 의존 그래프, CLI 임의 모드/모델/URL/인증 옵션 거부 |
| 120 계약·권한 분리 | passed | 같은 UUID·owner의 기존 mock/제안 승인으로 전달0회, 상호 Plan 거부, 기존 DB 승인 미소비, 새 fixture와 빈 수정/명령 범위 |
| 121 최종 본문·해시 | passed | 정책·상태·broker·CLI의 세 hash와 canonical 요청 바이트 일치, 문맥/본문/직렬화 순서·재계산한 payload hash 변조 거부 |
| 122 입력 최소화 | passed | 네 파일 로컬 근거 중 controller만 전달, 미선택 근거/절대 경로/Git 제외, 자료 지시문과 worker의 임의 주소/도구 필드 거부 |
| 123 한도 | passed | 입력128KiB·escaping 후 요청256KiB·전체 응답256KiB·최종JSON16KiB 경계/초과, 멀티바이트·분할 delta 검사, 기존 수집 한도 회귀 |
| 124 승인·TTL | passed | 명시 TTL1~60분·최대24h, owner/hash/config/profile/schema/serializer/mode 결합, stale clock dispatch, mock/구형/live 혼용 거부 |
| 125 단일 소비·DB 실패 | passed | 동시 run 한 번, claim/예약 저장 실패 시 fake 전달0회, 예약 후 실패는 소비 유지, 재시도·승인 복원 없음 |
| 126 broker 계약 | passed | 부모가 승인한 최종 본문만 전달, 포트 필수·한 번 소비, caller model/tools/URL/header/schema 거부, 합성 지연/오류 후 재전달 없음 |
| 127 envelope·stream | passed | UTF8·중복/추가 키·redirect·도구·다른 profile·불완전/중복/순서 위반·복수 응답 거부, raw/부분 실패 본문이 DB/로그에 없음 |
| 128 보고서·근거 | passed | 전송 ID/줄만 인용, raw/decoded 비밀·허구 경로·실행 필드 거부, offline/fake/synthetic·의미 검증 false·제외 항목 not_run 표시 |
| 129 취소·timeout | passed | 전달 전/후 generation 경합·가상 시각60초 제한·늦은 성공 차단, uncertain cleanup BLOCKED, 취소와 원본 변조 동시 발생 시 최초 terminal 보존 |
| 130 중단·복구 | passed | 실제 부모 SIGKILL·worker 종료, 새 CLI RUNNING 보존 후 INTERRUPTED, 본문 hash·source·프로세스 증거 변조/부재/만료는 BLOCKED, 재호출 없음 |
| 131 격리·인증 경계 | passed | 실제 Node permission으로 host canary 읽기/쓰기·TCP·child 거부, 확장 권한/상속 env/부모 IPC 부재 거부, credential/실제 transport import 없음 |
| 132 보관 | passed | private 권한/링크·저장 레코드 변조 검사, payload24h·최초 terminal+30d 감사 정리, marker 유지·late payload 부활 거부·원본 자동 삭제 없음 |
| 133 회귀·문서 | passed | 기존583개와 신규 검사, 타입/lint/빌드, 구현 CLI와 문서 일치, 기존 계약 원문 유지 |
| 134 종단 완료 | passed | 문의/변경 요청·json/stream·일부 전달·실패/취소/복구에서 대상/Git 무변경, fake 최대1회·재시도0, 실제 모델/인증 접근/외부 서비스/대상 명령0 |

## 결과 해석과 제외 범위

이 결과는 요청 구성·승인·전달·응답 검증·복구 경계를 검증한다. 가짜 응답은 실제 모델 추론의 정확성을 평가하지 않는다. schema와 인용 범위 검사도 의미 정확성을 증명하지 않는다. 보고서에는 `semanticAccuracyVerified: false`, `excludedOperationsReason: offline-fake-only`와 실제 모델·인증 접근·외부 전송·공급자 호환성 `not_run`을 저장한다.

실제 모델 adapter·live 인증·공급자 프로토콜 호환성 실증·회사 저장소/Slack 자료·대상 코드 실행·Git 원격은 이번 범위 밖이다. 신규 오프라인 승인과 결과를 그 권한으로 전환하는 경로는 없다. 향후 실제 연결은 별도 계획·구체 입력 검토·새 승인·독립 격리 검증이 필요하다.
