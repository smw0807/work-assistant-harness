# 4-C-18 회사 모의 조사·승인·보고서 연결 결과

2026-11-17. 회사 준비 v3의 다음 단계로 별도 모의 조사 계약과 CLI를 연결했다. 이번 작업은 합성 자료만 사용했다. 실제 회사 자료·인증정보·native Codex·모델·Slack·외부 네트워크에 접근하지 않았다.

## 구현한 흐름

`유효한 v3 준비 → 새 회사 조사 계획 → 별도 모의 승인 → 단건 소비/예약 → 고정 응답 → 근거 검증 → 로컬 보고서`

- `company-investigation-plan-v1`은 준비 계획·정책/등록/원본/근거 hash, runtime binding, 정확한 입력 hash와 기존 실행 예산을 결합한다. 목적지/모델/인증은 local fixed response로 고정하고 전송·실행 권한은 false다.
- 준비 v3의 원래 `AWAITING_APPROVAL`과 실제 전송 권한은 그대로다. 새 조사 승인도 모의 실행에만 유효하며 기존 개인/relay 승인이나 payload로 전환하지 않는다.
- 계획·승인·호출 직전과 완료 시 기존 준비와 v3 source를 확인한다. 매 검증은 새 두 pass와 기존 판독 한도를 사용하며 source proof·안전 근거 일치 및 정리 완료가 필요하다.
- 별도 SQLite는 위치·소유자·스키마·row/payload/report hash를 확인한다. 동일 준비의 재계획은 기존 기록을 반환한다. 승인 소비와 dispatch 예약은 각각 트랜잭션으로 확정하고 한 번만 허용한다.
- 취소·만료 이후 늦은 결과를 보관하지 않는다. 중단/정리 불확정은 `BLOCKED`이며 승인 소비를 복원하거나 자동 재호출하지 않는다.
- 모의 모델 출력에 기존 strict JSON·민감정보·근거 ID/줄 검증을 재사용한다. `responseHash`는 검증 결과의 canonical JSON hash이며 raw 모델 응답 hash가 아니다.
- 본문과 보고서의 만료는 최초 준비의 `expiresAt`, 감사는 `auditExpiresAt`을 그대로 따른다. 새 계획/승인으로 기한을 늘리지 않는다. 정리는 명령 기반이며 예약 삭제나 물리적 완전 삭제를 보증하지 않는다.
- 준비 취소는 이후 조사 작업을 차단하지만 이미 만든 별도 조사 DB의 본문을 자동 연쇄 삭제하지 않는다. 즉시 제거하려면 조사 작업도 취소해야 하며, 그 전에는 원래 준비에서 상속한 만료를 따른다.

## 실행 경계

`plan/approve/run`은 명시적인 `--mode mock`만 수용한다. `inspect/cancel/recover/prune`를 별도로 제공한다. Nest context의 제한 worker에 fixed response만 연결한다. 실제 인증·native·live relay는 이 회사 계약을 수용하도록 변경하지 않았다.

DB 사전검사도 제한 child에서 처리한다. 최소 LANG/TZ 환경, V8 old-space128MiB, 네트워크·추가 child/worker·addon·WASI·inspector 거부를 적용한다. 쓰기는 새 조사 store와 필요한 기존 준비 store로 한정한다. source를 비롯한 읽기 범위는 신뢰하는 하네스 코드로 제한하며 OS 읽기 격리가 아니다.

사전검사 이후 새 runtime을 생성하기 전에 대상/하네스/runtime 중첩을 차단한다. 사전검사는 최대30초·출력8KiB·SIGKILL이고, 본 worker까지의 전체 기한은 run125초/그 외30초다. 비동기 supervisor는 출력/시간 실패 시 SIGTERM과250ms 뒤 SIGKILL을 요청하며 close 확인 전 성공하지 않는다. 부모 생존·OS 신호 처리에 의존하며 독립 guardian과 OS RSS 강제 상한을 제공하지 않는다.

stdout에는 상태·식별자·hash·기한·모의 호출 예약 수만 표시한다. private SQLite에 검토 입력과 보고서를 보관하며 파일 export/검토 UI는 아직 없다. `runStatus:succeeded`는 명령 완료이고, 모의 조사 성공은 `status:REPORTED`·소비 승인·시도/예약1회·보고서 존재를 함께 확인한다. 출력 유실은 `unknown`이며 같은 ID 조회를 사용하고 자동 재시도하지 않는다.

## 검증

설치된 pnpm12.16.1·Node26.12.1을 사용했다. 패키지 매니저 버전 고정·설치·다운로드·의존성/lockfile 변경은 없다.

| 검사 | 결과 |
| --- | --- |
| lint / typecheck | passed |
| build | passed — 전체 `test`의 선행 `tsc` 포함 |
| 회사 집중 회귀 | 499 passed / 0 failed |
| 최종 전체 회귀 | 1794개 중1758 passed / 0 failed / native opt-in36 skipped |
| 신규 합성 사례 | 56 passed — 마지막 독립 CLI 동시 실행 사례는 최종 전체 회귀에 포함 |
| 실제 회사 자료·인증·native·모델·Slack·외부 공급자 호출 | not_run — 이번 범위에서 제외 |

전체 회귀의 첫 sandbox 실행은 localhost `listen EPERM`과 관련 broker 초기화 실패로33개가 실패했다. 허용받은 로컬 테스트 실행 환경에서 동일한 최소 환경·오프라인 설정·native opt-in 부재로 다시 실행해 전체를 통과했다. 모의 전송 테스트는 loopback과 가짜 포트를 사용하며 실제 제공자 호출 성공으로 해석하지 않는다.

신규 검사는 계획/입력/모의 권한 변조, 기존 준비와 조사 기한 상속, 제공하지 않은 근거와 중복 JSON 키, 승인 전/직전/중간의 source 변경, 별도 준비 취소, 만료, 두 CLI 프로세스의 동시 소비 경쟁, 취소/늦은 결과, 중단 복구, private DB/스키마/행 변조/링크, source 정리 실패를 포함한다. CLI는 본문 없는 출력, 환경 canary 제거, preflight/main worker의 권한·기한, 결과 유실 후 같은 ID 조회, 원본 파일/metadata 보존을 확인했다.

기존481파일과 비교해474파일이 그대로이며 변경7파일은 공통 순수 검사/예산 getter·CLI 라우팅·문서다. 신규18파일은 회사 조사 구현·테스트·결과 문서다. 구형 회사 판독기/등록/보관·개인/relay 입력 계약·수치 한도와 lockfile은 보존했다. private 원문 자료나 실행 DB는 Git에 넣지 않았다.

## 남은 범위

회사용 실제 AI 전송·native/인증 연결은 구현·실행하지 않았다. 회사가 허용한 제공자·계정·전송 내용·보관 조건을 반영한 별도 실행 계획과 승인, 실제 어댑터 연결·단건 검증이 필요하다. 이번 모의 승인과 보고서를 그 승인/성공 증거로 재사용하지 않는다. source reader의 일시적인 조상 경로 변경 관찰 한계, 전체 pack checksum/미조회 객체 미검증, 보고서 의미 정확성 미검증도 유지한다.
