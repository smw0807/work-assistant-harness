# 단계 4-C-13 조사 보고서의 정확성과 누락 범위 검토

기존 실제 성공 보고서의 사실 11개와 추가 질문 2개를 당시 수집한 7파일·11범위의 안전 발췌와 대조했다. **직접 근거 7개·보완 필요 4개**이며 선택 코드에서 명백히 반대되는 핵심 연결은 발견하지 않았다. 이는 제한된 정적 검토이며 전체 프로그램의 정확성·실행 결과·운영 안전성 검증이 아니다.

실제 성공 보고서·승인·소비 기록과 `semanticAccuracyVerified=false`는 그대로 보존했다. 정정 문구는 별도 로컬 검토 자료이며 새로운 모델 응답으로 기록하지 않았다. 후속 준비 과정에서 수집한 새 근거를 원래 보고서 판정에 소급 사용하지 않았다.

## 기존 보고서 검토

| 항목 | 결과 |
| --- | --- |
| 사실 1·2·3·5·7·9·10 | 기존 주장과 근거 일치. 조건의 괄호·콜백 전달·시간 제한의 적용 범위 등 설명 보완 포함 |
| 사실 4·8 | 내용은 기존 발췌에 있지만 원래 인용 범위가 핵심 줄을 포함하지 않음. 기존 근거로 인용 2건 보완 |
| 사실 6 | 계좌 동일 조건과 방향별 체결 조건을 명시하고, 오류 상태의 출처는 미확인으로 한정 |
| 사실 11 | 오류 처리를 특정 전송 호출의 catch 범위로 한정. 선행 검사나 저장 실패 모두에 대한 보장으로 확대하지 않음 |
| 질문 1·2 | 실제 누락을 짚지만 여러 목적을 함께 묶음. 이미 답할 수 있는 검사와 추가 구현이 필요한 부분을 분리 |
| 마스킹과 누락 | 기존 전체 view의 마스크 5개는 당시 선택 발췌와 겹치지 않음. 미수집 구현과 마스킹을 구분 |

원래 인용·표현의 보완에는 추가 모델 호출이 필요하지 않다. 구체 주장·조건·파일/줄·보완 답변은 비공개 [검토서](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c13-report-review-w1jn5g92/review.txt)와 [보완 답변 초안](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c13-report-review-w1jn5g92/reviewed-answer-draft.txt)에 둔다. 대상 코드·등록·질문 전문·모델 본문은 Git에 복제하지 않는다.

## 후속 조사 계획

이미 등록된 두 파일에서 누락된 호출 연결, 서비스 내부 진입, 차단·직렬화 구현을 확인하도록 범위를 좁혔다. 새 선택 범위의 답변 가능성도 별도로 검토했다. 외부 호출자, 다른 보조 함수 내부, 저장 내구성, 실제 외부 처리와 운영 결과는 계속 미제공 또는 미검증이다.

| 항목 | 값 |
| --- | --- |
| 상태 | `AWAITING_APPROVAL` |
| Task | `a1772750-23dd-4652-b1c2-2736a0e6ed92` |
| planHash | `57efe7d0a0ea1063c302af106b461fbc2547dc78d93131f024452f2137499e7a` |
| 계획 만료 | 2026-11-16T05:58:25.158Z / 2026-11-16 14:58:25.158 KST |
| 선택 범위 | 2파일·5범위·566줄 |
| 근거 / 입력 / 요청 body | 34,207 / 42,740 / 47,414바이트 |
| 원문·전체 view 민감 검사 | 2파일 모두 passed, mask 0 |
| 수집 계약 | 기존 `personal-readonly-collection-v2`, hash `8acdca9effe323a36b322589bec24367b51c8e3c6268c09d5672787b07fd7033` |
| 실행 예산 | 기존 `readonly-relay-execution-budget-v1`, hash `00b7a09da8cfaf6d13e0d5e478496a832af792bef0f06eed25d584cc593f2a53` |
| 승인 / 사용 / 소비 / attempt / dispatch / 실제 호출 | 각각 0, 승인 TTL 미시작 |
| 대상 쓰기 / 검사 실행 | 허용 목록 빈 배열, `executionAllowed=false` |

기존 개인 등록/입력/계획 v3와 전송 profile/config를 그대로 사용했다. 실행 120초·공유 정리 5초·총 125초·8192프레임, 응답 4MiB·개별 frame 64KiB·최종 16KiB를 유지한다. 수집의 원본/전체 view 64KiB·개별 발췌 32KiB·근거 64KiB·입력 128KiB·8파일/16범위/범위당 200줄도 바꾸지 않았다.

최초 로컬 초안은 함수 선언까지 포함하도록 범위를 보완하면서 `CANCELLED`로 전환했다. 초안·취소 기록을 보존한 뒤 새 계획을 만들었으며 두 계획 모두 승인·시도가 없다. DB에는 취소 초안 1개와 최종 승인 대기 1개가 있다. 정확한 질문/범위/본문/hash는 비공개 [후속 검토서](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c13-report-review-w1jn5g92/followup-review.txt)와 동일 디렉터리의 `registration.json`, `input.txt`, `request-body.json`을 따른다.

## 로컬 검증과 보존

- 기존 compiled plan/payload/source guard·계약 hash·정확한 입력·DB0 계수·실행 비허용·native 파일 identity의 7개 검사 passed. native 바이너리는 실행하지 않았다.
- `pnpm harness personal-readonly-plan`과 로컬 초안 취소 명령의 컴파일/실행 passed. approve/run·인증 상태 조회/refresh·실제 모델·외부 전송은 not_run/0회다.
- 기존 전체 회귀 1,241 passed 및 lint/typecheck/build 통과 기록의 소스 317개·코드/빌드 919개 hash를 유지했다. 런타임 코드·테스트·설정·lockfile 변경이 없어 전체 회귀 재실행은 not_run이다.
- 원본 metadata 388관찰/311고유경로와 Git 3개 hash, 선택 파일의 원본/view proof를 보존했다. 전체 대상 저장소가 clean하다고 판정한 것은 아니다.
- 기존 준비 50+7개와 실제 성공 37개의 고정 자료를 보존했다. 새 자료는 별도 0700 디렉터리와 0600 파일로 보관하며 가변 SQLite DB는 고정 manifest에서 제외한다.

다음 실제 호출은 이 정확한 새 계획의 별도 명시 승인 뒤에만 가능하다. 기존 소비 승인은 재사용하지 않는다. 계획 만료나 원본·본문·코드 변경 시에는 다시 검토해야 한다. 대상 설치·테스트·빌드·쉘/Git CLI·외부 업무 API·코드 수정과 commit/push는 이번 작업에 포함하지 않았다.
