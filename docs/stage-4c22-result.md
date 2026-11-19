# 단계 4-C-22: 선택 범위 합성 재현과 소스 거부 분기

2026-11-19. 앞선 일반 오류 진단을 `9cf8b87`로 커밋한 뒤 진행한 후속 작업이다. `COMPANY_GIT_RANGE_INVALID_SOURCE`는 HEAD/객체/tree 검증 외에 안전 view·발췌 오류도 합쳐지는 코드였다. 코드 하나로 Git 자료 손상이나 구체 실패 위치를 단정하지 않도록 실제 거부 분기만 구분한다.

## 구현

독립 합성 저장소의 선택4파일·9범위, 최대34,528B·합계47,224B로 정상 두 pass와 보관을 검증한다. 1,079행 파일의 여섯 발췌에 누락·중복이 없는지 비교하고, 실제 마지막 행을 넘기는 요청은 부분 보관 없이 거부한다. 회사 파일 내용이나 경로를 복제하지 않았다.

판독기가 직접 발행한 일반 오류에 `head_ref`, `delta_base`, `object_lookup`, `object_type`, `tree_selection`, `source_size`, `safe_view`, `excerpt`, `unexpected` 중 하나를 WeakMap으로 결합한다. 오류의 공개 code/message와 기존 거부 조건은 그대로다. 외부 property·getter·proxy·message·stack은 분기 정보가 되지 않는다.

분기가 있을 때만 worker failure frame-v2와 diagnostic record-v3를 사용한다. 기존 frame-v1과 record-v1/v2의 필드·hash는 유지하고 새 reader는 세 기록 버전의 혼합 보관·정리를 지원한다. 다른 code와 분기를 조합하거나 새 프레임과 구형 프레임을 함께 보내면 거부한다. 종료 code1·signal 없음·close와 기존 기한/출력/stream 우선순위를 유지한다. 경로·OID·본문·행번호는 진단에 포함하지 않는다.

source guard/profile/hash, 파일·발췌·metadata·메모리·시간 한도, 승인·전송·실행 권한과 의존성은 변경하지 않았다. pnpm은 현재 설치 버전을 사용한다.

## 검증

| 검사 | 결과 |
| --- | --- |
| lint·typecheck | passed |
| 전체 회귀 | 1,991개 중 1,955 passed, 0 failed, native opt-in 36 skipped |
| 신규 회귀 | 37개 passed |
| 기존 계약·한도·의존성 파일 11개 hash | unchanged |
| 실제 인증·native·외부 모델 호출 | not_run — 합성 검증에서 제외 |

Node v26.12.1, 현재 pnpm 12.16.1을 사용했다. 먼저 실행한 `test:company`는 633 passed·1 failed였으며 실패는 샌드박스의 localhost 모의 broker 검사였다. 추가 저장 회귀까지 포함한 최종 전체 검사를 허용된 실행 환경에서 수행해 위 결과를 확인했다. 코드나 검사를 완화하지 않았다.

신규 회귀는 정상4파일·9범위 준비, EOF 초과·HEAD/ref·객체 조회/타입·tree 선택·blob 크기·예상 밖 오류와 오류 identity, frame-v1/v2 혼합 거부, record-v1/v2/v3의 hash·TTL·엄격한 버전/코드/분기 조합과 종료 우선순위를 확인했다. 기존 안전 view/발췌 실패 검사에도 분기 확인을 추가했다. 분기 이름만 직렬화하며 fixture 본문·경로·OID는 진단에 들어가지 않았다. 독립 정적 검토에서 추가 결함은 발견하지 못했다.

소유자 전용 합성 로그와 집계는 `/private/tmp/harness-source-rejection-aRdvGj`에 보관한다. 합성 성공 자체가 실제 회사 원본의 거부 분기나 제품 동작을 증명하지는 않는다.

합성 검증 뒤 기존 허용4파일에 새 읽기 전용 준비를 별도1회 적용했다. 만료된 보고서·등록 본문은 읽지 않고, 남은 범위 감사 메타데이터와 현재 원본 상태를 대조해 새 등록을 만들었다. 새 진단은 `object_lookup`, 같은 ID 조회는 `NOT_FOUND`였다. 선택 원본/Git 메타데이터13개 전후 일치, worker/CLI 종료와 실행 중 하네스 파일 hash 일치를 확인했다. 실제 인증·native·모델 호출·대상 코드 변경·대상 스크립트 실행은 없었다. 상세 식별자·경로와 감사는 비공개 로컬 위치에 보관한다.

## 다음 최소 작업과 한계

이번 새 실행에서는 판독기가 지원하는 loose object와 연 pack index들에서 요청한 Git 객체를 찾지 못했다. 이 관찰만으로 객체 종류, 저장소의 객체 누락 여부 또는 판독기의 조회 제약 중 무엇 때문인지 확정하지 않는다. 과거 실패가 같은 원인이었다고 소급 단정하지 않는다.

다음 최소 작업은 객체 조회와 가용성을 독립 합성 index/pack 사례로 검증하는 것이다. 이전 실패 자동 재시도·한도 확대·네트워크 fetch·대상 reset/repack은 하지 않는다. 대상 제품 코드 구현은 아직 진행하지 않았다.
