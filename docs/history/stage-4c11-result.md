# 단계 4-C-11 개인 자료의 수집 한도와 안전 view 분리

최신 실제 결과는 사용자가 TTL10분·최대1회·자동 재시도0으로 승인한 개인 수집 v2의 `FAILED / PERSONAL_READONLY_TIMEOUT`이다. HTTP200 응답의 EOF에 도달하지 못해 유효 조사 보고서는 없다. 승인·사용·소비·attempt·dispatch·upstream은 각1회이고 원본/Git·고정 자료 보존과 로컬 프로세스 종료·임시 영역 제거를 확인했다. [실제 단건 결과](#개인-수집-v2의-승인된-실제-단건-호출)를 따른다.

첫 개인 조사에서 제외된 핵심 파일 두 개를 수집할 수 있도록 별도 계약을 추가했다. 하나는 기존32KiB보다 큰 파일이고 다른 하나는 기존 민감 패턴 검사에서 거부된 파일이다. 아래 구현·로컬 검증·검토 자료는 당시 `AWAITING_APPROVAL`·실제 인증/모델/외부 전송0회로 고정한 준비 이력이다. 실제 호출 기록과 소비 승인을 덮어쓰거나 복원하지 않는다.

## 변경 범위와 계약

- `src/domain/personal-readonly-collection.ts`, `src/policy/personal-readonly-collection.ts`: 별도 `personal-readonly-collection-v2` profile과 고정 변환기를 추가했다. 원본 파일64KiB·full safe view64KiB·개별 발췌32KiB·전체 근거64KiB를 구분한다. 기존8파일·16범위·범위당200줄·입력128KiB는 유지한다.
- `src/policy/personal-readonly-collection-policy.ts`: registration/input/plan v2, collection profile/hash와 sourceViewsHash를 정확한 입력·전송 본문·승인 계획에 결합한다. 기존 relay-v2 profile은 `unchanged-transport-component`이며 기존 `fileBytes: 32768`을 새 원본64KiB 수집 권한으로 설명하지 않는다.
- `src/adapters/personal-readonly-collection-repository.ts`와 기존 reader의 내부 연결부: 같은 제한 Git/FS reader에 별도 고정 수집 한도를 적용한다. 기존 개인-v1의32KiB·민감 거부 판정은 유지한다. 대상 Git CLI·설정/hooks·프로그램·설치/검사 스크립트·거래 API·수정/쓰기/네트워크는 실행하지 않는다.
- `src/policy/personal-readonly-contract.ts`, 기존 service/store/ports/CLI/개인 adapter: 명시 버전별 고정 validator만 선택한다. 알 수 없는 계약·accessor·v1/v2 혼용은 거부한다. 공통 개인 DB의 승인·원자 소비/dispatch·TTL·취소·복구·보관은 유지한다. v2 보고서는 collection policy/profileHash/sourceViewsHash/evidenceOrigin의4필드를 필수로 저장하며 v1 보고서는 기존 shape를 유지한다. 구형 binary는 v2 row를 거부할 수 있어 같은 DB의 rollback 호환은 보장하지 않는다.
- `config/personal-readonly-collection.example.json`, 신규 테스트4개와 README/구조/보안/구현 계획: 합성 예시와 실제 구현한 명령·수용195~199·한계만 기록한다. 기존 명령을 그대로 사용하며 임의 수집 상한이나 변환기를 사용자 옵션으로 받지 않는다.

원본 전체의 기존 UTF8/binary·민감 검사를 먼저 수행한다. 민감 거부만 새 계약의 고정 패턴 마스킹 대상으로 삼으며 원본의 `rejected` 상태를 유지한다. 매치 전체를 줄 보존 마커로 바꾼 뒤 **full view 전체가 같은 기존 검사를 통과해야** 선택 줄을 수집한다. 경로·Git·크기·binary 오류는 마스킹으로 우회하지 않는다. 겹친 매치·CRLF·미완성 private-key 블록·마스크 한도·변환 후 잔존도 검증한다.

`evidence.fileHash`는 전체 안전 view의 hash다. 원본 hash·민감 거부·원본/view 바이트와 줄 수·마스킹 줄은 private proof에 보관하고 모델 입력에는 view hash·마스킹 고지·sourceViewsHash와 선택한 안전 발췌만 넣는다. 원시 매치·비밀값·전체 원본/view buffer는 저장하거나 전송하지 않는다. 마스킹이 없는 view는 원본과 같아 hash값도 같다. 원본이 바뀌어 같은 view가 되더라도 raw identity/hash와 재생성 proof/발췌 비교로 승인·인증·전송·완료·복구를 차단한다.

기존 개인-v1 순수 정책·등록 예시·공통 민감 검사와 v9/relay-v1/v2 정책/profile/config/기본 synthetic 본문·4MiB 응답/최종16KiB·EOF/인증 반사·단건/종료 계약은 보존했다. package/lock·런타임 요구사항도 바꾸지 않았다. 기존 relay-v2 profile hash는 `09aa8924e4e79384230b26292ea05d06920f115f3fd782454738d36e837f4afd`, config hash는 `8ce433107f0304be33c3ec78402a9c4eebf0b688d3a3395ce7dfbfbdab11e438`로 같다.

## 실제 로컬 수집과 검증

새 자료에는7파일·11범위·근거33,911byte가 포함된다. 기존에 제외된35,074byte 파일은 새64KiB 원본 한도에서 통과했다. 다른 파일은 원본22,986byte/417줄·민감 거부를 유지한 채5개 credential-assignment 매치를 마스킹했고, 파생 view22,892byte/417줄은 전체 재검사를 통과했다. 패턴 매치가 실제 비밀값의 존재를 확정하지 않는다. 마스킹 줄은 이번 client 선택 범위 밖이지만 전체 view의 마스킹 고지를 모델 입력에 포함한다.

최종 계획 준비에서 선택 발췌가 빈 줄로 끝나면 재검사기가 그 줄을 파일 EOF로 해석해 거부하는 오류를 발견했다. 새 수집 정책의 발췌 재검사만 수정했다. 별도 줄 수/hash/32KiB 검증과 전체 텍스트 민감 검사는 유지하며, 후행 빈 줄1개/2개·완전히 빈 발췌의 payload/dispatch 회귀를 추가했다. 초기 실패는 작업 저장 전에 발생해 task/승인/attempt0이었고 초기 로그도 보존했다.

| 검증 | 결과 |
| --- | --- |
| lint / typecheck / build | passed |
| 최종 전체 하네스 회귀 | 1207 passed /0 failed /0 skipped, compile 포함87.11초 |
| 신규 검사 | 31개: 변환/reader14·policy9·workflow6·adapter/CLI2 |
| pinned native 통합 | 합성 저장소·가짜 credential/upstream으로 인용·두 hash·EOF·단건·프로세스/PGID/guardian/scratch 종료 passed |
| 기존 소스 보존 | 기준293개 중286개 불변, 공통 연결부7개 변경 |
| 최종 검증 소스 / 코드·빌드 | 303개 /881개 hash 고정 |
| 개인 대상 보존 | metadata388관찰/311고유경로·HEAD/index/ref3개 hash 무변경; 선택7파일·사용한 Git15개·부모24개 guard passed |
| 과거 개인-v1 검토 자료 | 원래47개와 최종 보완5개 보존 passed |
| 독립 코드 검토 | blocker0, 추가 finding 없음 |
| 실제 개인 인증 / 모델 / 전송 | not_run /0회 |

이 자료는 선택한 근거이며 전체 전이 호출 그래프·전체 작업 트리 clean·거래 안전성·의미 정확성을 확인한 결과가 아니다. 마스킹된 내용과 선택 밖 연결은 불확실하다. 기존 공급자 응답에 대한 provider metadata/sequence/tool_usage의 `not_inspected`, rawSensitiveScan/parentTextComparison의 `not_performed` 표시도 유지한다. 이 응답 보증 범위와 이번 source/view의 전체 민감 검사는 구분한다.

## 새 검토 자료와 승인 대기

비공개 디렉터리: [stage4c11-personal-collection-52yfz1u8](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c11-personal-collection-52yfz1u8). 구체 대상·질문·줄 범위는 [review.txt](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c11-personal-collection-52yfz1u8/review.txt), `registration.json`, 정확한 `input.txt`·`request-body.json`에서 검토한다. 개인 코드·등록·검토 본문·DB는 Git에 포함하지 않는다.

| 계획 | 값 |
| --- | --- |
| Task | `4e09b5c5-9f2b-4d41-8df6-0da04ae21eb2` |
| 상태 | `AWAITING_APPROVAL` |
| planHash | `1271ee47caac3ebf8bad29693c84a0245713ea3438555df32ec84f21b1264582` |
| 생성 UTC / KST | 2026-11-15T03:18:56.681Z /2026-11-15 12:18:56 |
| 만료 UTC / KST | 2026-11-16T03:18:56.681Z /2026-11-16 12:18:56 |
| collectionProfileHash | `8acdca9effe323a36b322589bec24367b51c8e3c6268c09d5672787b07fd7033` |
| sourceViewsHash | `bbe29fa62acd2669d7a2f268dac64a54e12dec7a6fca7b2dc01070cccb24af90` |
| input / wire body | 44,865byte /49,683byte |
| inputHash | `f71b52ac3f4121617515766921dead844edddeddf6eadda6114b2c833459f3a4` |
| body hash | `56523fda9f3119e642114559d85c839050f0f575636424ec9377305662800192` |
| envelope hash | `b991bc6c7cfc51e07d76ed7d63be8d85fd91f8057a717bad0b8d4700a75b4e77` |
| canonical registration hash | `37ab816de258b99c3d115b267d7e3e783ea3955ef151d1a25a10e328019aac69` |
| 승인 / 사용 / 소비 / attempt / dispatch | 각각0, 승인 TTL 미시작 |
| writeAllowedFiles / testCommandIds / executionAllowed | [] /[] /false |

plan/payload·source/view proof·정확한 입력/본문·두 profile·설정·원본 metadata·소스/빌드·검사 로그는0700 디렉터리의0600 파일로 보관한다. 가변 DB는 고정 artifact manifest에서 제외하고 readonly 조회로 task1/승인0/사용0/소비0/attempt0/dispatch0을 확인했다. 실제 run 디렉터리와 결과 보고서는 없다. export한 검토 파일의 보관은 DB의24h payload/30d terminal 감사 정책과 구분한다.

독립 준비 감사26항목이 모두 passed/blocker0이다. 순수 plan/payload/dispatch 검증과 원본/view 재생성 guard, 고정 artifact48개·코드/빌드881개·검증 소스303개·기존 계약·DB0 계수·원본/Git·과거 자료·private 권한을 확인했다. `independent-readiness-audit.json`이 최종 감사 기록이며 원래48개 manifest와 최종 감사·개인정보/문서 검토·요약·문서 hash를 `final-readiness-artifact-hashes.json`으로 추가 고정했다. 원래 고정된 로컬 검증 파일의 `pending-at-freeze`는 고정 시점의 상태이고 최종 결과는 감사/요약 파일을 따른다. 현재 준비 범위에서 실제 인증 파일·로그인 상태·refresh·모델·공급자 전송·대상 명령·commit/push는 실행하지 않았다.

다음 최소 작업은 새 검토 자료와 정확한 입력·마스킹 고지를 검토하는 것이다. 실제 조사를 원하면 이 새 계획에 명시적 TTL·최대1회·자동 재시도0의 별도 승인이 필요하다. 이전 개인-v1·relay·v9 승인은 재사용하지 않는다.

## 개인 수집 v2의 승인된 실제 단건 호출

사용자가 위 계획을 TTL10분·실제1회·자동 재시도0으로 승인해 정확한 입력과 기존 collection-v2/relay-v2 계약으로 한 번 호출했다. 실행 전 독립 점검에서 계획·본문·원본/view·고정 바이너리·코드/빌드·준비 자료의 hash와 승인/소비/시도0을 다시 확인했다. 코드·한도·입력·profile/config를 변경하거나 새 계획으로 대체하지 않았다.

| 실제 단건 | 결과 |
| --- | --- |
| Task / planHash | 위 `4e09b5c5-9f2b-4d41-8df6-0da04ae21eb2` / `1271ee47caac3ebf8bad29693c84a0245713ea3438555df32ec84f21b1264582` |
| 승인 | `c5af63ba-61d0-442b-bd11-10044cafa3c5` |
| 승인 생성 / 만료 KST | 2026-11-15 12:54:21.890 /13:04:21.890, 정확히600초 |
| 사용·attempt 시작 / dispatch UTC | 2026-11-15T03:54:25.036Z /03:54:25.078Z |
| 종료 UTC / KST | 2026-11-15T03:55:20.112Z /12:55:20.112 |
| attempt 경과 | 55.076초 |
| 상태 / 공개 실패 code | `FAILED` / `PERSONAL_READONLY_TIMEOUT` |
| adapter/broker 기록 | phase=`request`, `READONLY_RELAY_CANCELLED` |
| 승인 / 사용 / 소비 / attempt / dispatch / upstream | 각각1회, run1회·자동 재시도0회 |
| 실제 HTTP / 격리 / 인증 접근 | 200 /passed /passed |
| 수신 prefix | 730,090byte·499chunk, max chunk4,614byte |
| wire 경계 진단 | completedFrames2490·maxFrameBytes4482·partialFrameBytes0 |
| 종료 진단 | EOF=false·termination=`cancelled`·failedLimit=`none` |
| 유효 보고서 / responseHash / finalTextHash | 없음 /null /null |
| 최종 schema·근거 인용·의미 정확성 | not_run |

service의55초 operation 제한이 abort를 일으켜 최종 `PERSONAL_READONLY_TIMEOUT`을 기록했다. 부모 abort를 받은 adapter/broker는 `CANCELLED`를 남길 수 있으며 call-report는 broker 실패 code를 우선 표시한다. HTTP200과730,090byte 수신은 완성 응답이나 조사 성공을 뜻하지 않는다. EOF와 검사가 끝나기 전에는 수신 본문을 자식에게 전달하지 않는 기존 경계를 유지했고 relay 결과도null이다. 원시/부분 응답·인증값·쿠키·헤더값을 보관하거나 불완전한 출력을 보고서로 채택하지 않았다.

`completedFrames2490`은 관찰한 prefix의 빈 줄 종결 경계 수이며 검증된 SSE/data 이벤트나 모델 응답 수가 아니다. 실제 frame64KiB/2048 검사는 EOF 뒤 UTF8·원문 credential 반사 검사 다음에 실행된다. 이번에는 EOF 이전 취소이므로 실패 원인을 frame 초과로 바꾸지 않는다. 다만 동일 prefix가 정상 UTF8로 이어져 EOF 검사를 받으면 기존2048 경계 한도도 통과할 수 없으며, 다른 검사에서 먼저 거부될 수도 있다. 시간만 늘리면 성공한다는 근거는 없다. 전체 응답 크기·남은 시간·최종 출력 유효성이나 공급자 이벤트의 내용은 현재 숫자 기록으로 알 수 없다.

사후 보존·종료 검사와 독립 감사21항목은 passed/blocker0이다. 선택7파일·사용한 Git15개·부모24개와 원본/view proof·발췌를 재생성해 일치시켰다. metadata388관찰/311고유경로와 HEAD/index/ref3개 hash 변화도0이다. 기존 준비48개+보완6개·검증 소스303개·코드/빌드881개와 고정 native hash를 보존했다. 준비 당시 문서5개의 사본도 private 실제 기록에 보관한 뒤 이 결과 문서를 갱신한다.

controller94680·guardian94695·child94696·native 프로세스 그룹-94696·pnpm run94630·approve94544는 모두 `ESRCH`이고 lifecycle/child는 `closed`다. `cleanupConfirmed=true`와 소유 sandbox/HOME 부재를 확인했다. DB·감사·원본/Git와 보존용 canary는 삭제하지 않았다. 로컬 종료는 원격 추론이 중지됐다는 보증과 구분한다.

구체 실행·승인·종료 snapshot, 숫자 진단과 사후 검사는 [actual-collection-v2-once](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c11-personal-collection-52yfz1u8/actual-collection-v2-once)에0600 파일로 보관했다. [실제 결과](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c11-personal-collection-52yfz1u8/actual-collection-v2-once/result.txt), `independent-post-actual-audit.json`과 `actual-artifact-hashes.json`을 따른다. DB는 가변 상태여서 고정 manifest와 분리하며 현재 `FAILED`, 승인/사용/소비/attempt/dispatch 각1회·보고서null을 readonly 조회했다. 승인 TTL이 남아 있어도 소비된 승인은 재사용하지 않는다.

실제 호출 동안 구현을 변경하지 않아 기존1207개 로컬 회귀 결과와 code/build hash를 유지했다. 이번에는 실제1회와 사후 읽기 검사만 진행했으며 대상 설치·테스트·빌드·쉘/Git CLI·거래 API·코드 수정·Slack·회사 자료·commit/push는 실행하지 않았다. 다음 최소 작업은 이 숫자 진단과 합성 자료로 시간·frame 제약을 오프라인 분석하는 것이다. 계약 변경이나 추가 실제 호출에는 새 검토 자료와 별도 승인이 필요하다.
