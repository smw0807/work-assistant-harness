# 단계 4-C-10 개인 시험 저장소 읽기 전용 조사 준비

사용자가 지정한 개인 시험 저장소 한 개와 질문 한 개를 등록하는 경로를 추가했다. 이번 범위는 하네스 구현·로컬 검증·비공개 검토 자료 생성까지다. 실제 개인 자료의 인증·모델·외부 전송은 승인 대기이며 대상의 설치·테스트·빌드·스크립트·수정·거래 API·Git 변경은 실행하지 않는다. 기준은 [구현 계획](../implementation-plan.md#단계-4-c-10-개인-시험-저장소의-읽기-전용-조사-준비)과 [보안 경계](../security-and-approval.md#개인-시험-저장소의-로컬-준비-경계)다.

## 구현 범위

- `src/domain/personal-readonly.ts`, `src/policy/personal-readonly-policy.ts`: private 등록·질문·기준 commit·선택 근거와 전송 subset을 `personal-readonly-investigation-v1`·`personal-readonly-input-v1`의 새 계획에 결합한다. 실제 개인 자료용 지시문은 선택 발췌를 전체 저장소라고 설명하지 않고 누락된 호출 연결을 불확실성으로 표시하도록 요구한다. sourceRoot·Git/부모 inode 명세는 모델 입력과 승인 snapshot에 넣지 않는다.
- `src/adapters/personal-readonly-repository.ts`: 일반 SHA1 Git 저장소의 선택 파일·index·commit blob을 제한된 읽기 FS로 대조한다. Git CLI·target import·config/hooks·alternate object store·쓰기·네트워크를 제공하지 않는다. 선택 파일과 실제 사용한 Git metadata의 hash/identity 및 부모 경로를 동기 재검증한다. 전체 작업 트리 clean 검사는 수행하지 않는다.
- `src/ports/personal-readonly.ts`, `src/application/investigate-personal-readonly.ts`, `src/adapters/sqlite-personal-readonly-store.ts`: 별도 DB·테이블·승인 namespace, plan24h·명시TTL1~60분·단건 원자 소비/dispatch·취소·무효화·복구·보관을 구현한다. 미승인 작업은 binary readiness 전에 거부하고, 승인 전과 인증/전송 직전의 source 변경을 차단한다. private payload 저장 크기는2MiB로 제한한다.
- `src/adapters/personal-readonly-codex.ts`와 기존 broker/native의 작은 입력 검증 포트 확장: 개인 adapter만 고정된 개인 입력 validator를 선택한다. 기존 synthetic default validator·v9/relay-v1/v2 profile/config/body/hash·4MiB/최종16KiB·EOF/인증 반사·단건/종료 계약은 유지한다. 등록·대상 코드·모델은 validator나 endpoint를 선택하지 못한다.
- `src/cli/personal-readonly.ts`, `src/cli/main.ts`, `config/personal-readonly.example.json`: 기존 `pnpm harness`에8개 새 명령과 private 등록 예시를 추가한다. 실제 명령은 [모델 relay 가이드](../guides/model-relay.md#단계-4-c-10-개인-시험-저장소-읽기-전용-조사)에 기록했다. target와 runtime 경로의 중첩·symlink alias는 mkdir/lease/DB 생성 전에 거부한다.
- `tests/personal-readonly-{repository,policy,workflow,adapter,cli}.test.ts`: 모두 별도 합성 저장소·가짜 credential/응답을 사용한다. 실제 개인 저장소 코드·등록·인증값을 fixture나 Git에 복제하지 않는다.

Git reader는 파일8MiB·누적 읽기64MiB·읽기2048회와 객체/pack 한도를 적용한다. pack은 최대4096객체·개별 해제1MiB·누적 해제16MiB·delta chain32로 제한하고 checksum·offset·선택 commit/tree/blob OID를 확인한다. linked worktree·submodule·SHA256·index v4/split index·thin/external delta pack과 제한 초과는 지원하지 않는다. 선택 source 파일32KiB·근거64KiB·입력128KiB·8파일/16범위/범위당200줄은 유지한다. 원래 파일 전체의 민감/binary 검사를 줄 선택으로 우회하지 않는다.

## 검증과 확인한 경계

초기 통합 검증에서 미승인 run이 binary readiness를 먼저 확인하는 순서를 발견해 새 개인 service에서 조기 승인 guard로 고쳤다. CLI의 runtime alias가 target 아래 디렉터리를 만들 수 있는 경로도 생성 전 canonical parent 검사로 차단했다. reader의 혼합 대소문자 정렬, blob 요청/반환 OID와 packed-ref의 해석 경로 변경 검사를 보강했다. 초기 실패·수정 이력과 최종 통과 기록을 비공개 검토 자료에 나눠 보존한다.

실제 개인 저장소는 로컬에서 선택 후보를 검사했다. 첫 자료는 허용된5개 파일·6개 범위이며 선택 파일이 기준 commit과 index에 일치하는지 확인했다. 후보 두 개는 기존 파일32KiB 한도 초과와 민감정보 패턴 거부로 제외했다. 민감 패턴 거부가 실제 비밀정보의 존재를 확정하는 것은 아니다. 이 때문에 전체 시작→주문 호출 연결과 API-client 내부 검사는 첫 근거에서 빠져 있으며 모델의 추정이나 완전한 조사 결과로 표시할 수 없다. 구체 파일·줄·질문·제외 사유는 private `registration.json`, `scope-limitations.json`과 정확한 본문에서 검토한다.

검토 디렉터리: [stage4c10-personal-readonly-rgd92sss](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c10-personal-readonly-rgd92sss). 개인 자료·등록·runtime DB·검토용 본문과 원본 metadata는0700 디렉터리의0600 파일에 저장하며 Git에 넣지 않는다. 하네스 DB의24h payload/30d terminal 감사/DB 수명 소비 marker와 사용자가 export한 검토 파일의 보관 정책은 구분한다.

## 최종 로컬 검증과 새 계획

| 항목 | 결과 |
| --- | --- |
| lint / typecheck / build |passed |
| 고정 native 포함 전체 하네스 회귀 |1176 passed /0 failed /0 skipped,84.28초 |
| 신규 검사 |51개: reader16·policy8·workflow23·adapter/CLI4 |
| native 개인 adapter 통합 |합성 자료·가짜 credential/upstream으로 최종 인용/두 hash/EOF·단건·guardian/child/PGID/scratch 종료 passed |
| 기준 소스 보존 |279개 중276개 불변, 기존 broker/codex/main의 연결부3개만 확장 |
| 최종 검증 소스 / 코드·빌드 |293개 /853개 hash 고정 |
| 실제 대상 보존 |metadata1666관찰/1341고유경로와 HEAD/index/ref3개 hash 무변경, 선택5파일·사용한 Git13개·부모22개 재검증 |
| 과거 relay 검토/실행 기록 |v1/v2 기존 artifact/actual manifest 보존 passed |
| 실제 개인 인증/모델/전송 |not_run /0회 |

기존 relay-v2의 profile hash는 `09aa8924e4e79384230b26292ea05d06920f115f3fd782454738d36e837f4afd`, config hash는 `8ce433107f0304be33c3ec78402a9c4eebf0b688d3a3395ce7dfbfbdab11e438`로 이전 성공 계획과 같다. 구형8897byte 본문의 hash·synthetic 기본 판정과 기존 회귀도 유지한다. 개인 입력은 구형 synthetic broker에서 거부되고, 새 개인 validator와 새 계획을 통해서만 연결된다. package/lock·기존 v9·relay 정책/profile/helper는 바꾸지 않았다.

| 새 검토 계획 | 값 |
| --- | --- |
| Task | `47ce7725-4836-45ca-9b90-fa0d1efe19cd` |
| 상태 | `AWAITING_APPROVAL` |
| planHash | `9266fa4f6cc3f7673bffe37d328cc92944b6ec2a291308f17c643db0e8b05db7` |
| 생성 UTC / KST |2026-11-15T00:10:54.683Z /2026-11-15 09:10:54 |
| 만료 UTC / KST |2026-11-16T00:10:54.683Z /2026-11-16 09:10:54 |
| 선택 범위 |5파일·6범위·전달 근거8983byte |
| 정확한 wire body |18,634byte |
| body hash | `496f7a791e33dc896b1d8ddfc8fd60f0d48b79f5b41295b7f9df82fb14dcdc9d` |
| envelope hash | `fed034a21baab201cc0e11565488abbf3f981964b68f6a4359f8e0c4725511ee` |
| input hash | `4df949db4a33f3d8515ac5ea87cb9e171a9826685967eec2bc4597a1286d2584` |
| registration hash | `e05d003af401e1303179b1247b5aa1265e0bfc4a411ddc958a3856370bd94351` |
| 승인/사용/소비/attempt/dispatch |각0, 승인 TTL 미시작 |
| writeAllowedFiles / testCommandIds / executionAllowed |[] /[] /false |

private `review.txt`·등록·정확한 input/body·payload/plan·profile/envelope·설정·한계·원본 관찰·검증 로그와 manifest47개를 고정했다. DB는 가변 상태이므로 고정 파일과 분리해 승인0 계수를 확인하며, 실제 run 디렉터리와 보고서는 없다. 준비 과정에 개인 자료를 모델로 전송하거나 인증 파일·로그인 상태를 조회하지 않았다. 기존 승인·소비를 복원하지 않았고 추가 실제 호출·대상 명령·commit/push도 수행하지 않았다.

독립 준비 감사23항목도 passed/blocker0이다. 계획/입력/명세/hash·원본/Git·고정47개·코드/빌드853개·검증 소스293개·private 권한·승인/사용/소비/attempt/dispatch0을 확인했다. `registrationHash`는 raw 파일의 바이트 hash가 아니라 범위 sort/merge와 전송 경로 정렬을 적용한 canonical 등록의 hash이며 독립 정규화로도 일치했다. 이 비교 기준을 잘못 적용했던 초기 감사 checker draft는 정정 이유와 함께 별도로 보존했다. `independent-readiness-audit.json`이 최종 감사 기록이고 `final-readiness-artifact-hashes.json`으로 원래47개 manifest와 최종 감사/요약을 추가 고정한다. 감사 중 실제 인증·native·모델·네트워크 호출과 DB 변경은0이다.

다음 최소 작업은 `review.txt`와 정확한 전송 본문, 특히 제외된 근거와 불완전한 호출 연결을 검토하는 것이다. 이후 실제 조사를 원하면 이 개인 계획에 대한 명시적 TTL·최대1회·자동 재시도0 승인이 필요하다. 의미 정확성·실제 개인 자료의 공급자 호환성·회사 보안 검토는 미검증이다.
