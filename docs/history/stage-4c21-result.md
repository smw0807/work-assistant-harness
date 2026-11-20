# 단계 4-C-21: 회사 준비 v3 일반 worker 오류 진단

2026-11-19. `worker_failed`이지만 자원 한도 진단이 없는 경우에는 worker가 출력한 일반 오류 코드가 보관되지 않았다. 이번 변경은 새 진단을 켠 실행에서 고정 코드만 구분하도록 하네스를 보완한다. 실제 회사 자료·인증·native·모델 호출 없이 합성 검증한다.

## 구현

- worker 옵션 검증 뒤 task ID를 확보하므로 receipt 이전의 권한·입력 실패도 진단할 수 있다. 옵션 파싱 자체가 실패하면 프레임을 만들지 않는다.
- `company-readonly-v3-worker-failure-v1` 프레임에는 version·taskId·code만 넣는다. 53개 exact allowlist와 고정 fallback을 사용하고 error의 own data code만 확인한다. 오류 message·stack·경로·원문은 읽거나 저장하지 않는다.
- 프레임 최대 1KiB와 기존 stderr 전체 64KiB 한도, strict UTF-8·JSON·중복 키·단일 완결 줄·같은 ID 검사를 적용한다. malformed·중복·타 작업 프레임은 코드가 되지 않는다.
- supervisor가 중단하지 않은 worker의 `close(1, null)`에서만 새 코드를 보관한다. deadline·출력 초과·스트림 오류·signal·다른 종료 코드는 기존 결과를 유지한다. 성공 summary와 실패 프레임이 함께 오면 `invalid_output`이다. 기존 budget 진단과 코드가 모순되면 새 코드를 버린다.
- 코드가 있는 경우에만 진단 record-v2를 생성한다. 코드가 없는 기존 record-v1의 정확한 필드와 hash는 그대로다. 새 reader는 두 버전의 보관·hash·정리를 검증한다. 구버전 reader에서 새 v2 기록을 읽는 호환은 제공하지 않는다.

기존 CLI 옵션과 stdout, 등록/계획/DB, source guard/profile/hash, 수집·metadata·시간·메모리 한도, 보관 기간과 자동 재시도 금지는 변경하지 않았다. 의존성이나 pnpm 버전을 고정·설치·교체하지 않았다.

## 검증

| 검사 | 결과 |
| --- | --- |
| lint | passed |
| typecheck | passed |
| 전체 회귀 | 1,954개 중 1,918 passed, 0 failed, native opt-in 36 skipped |
| 추가 회귀 | 28개 passed |
| 기존 계약·한도·의존성 파일 11개 hash | unchanged |
| 실제 인증·native·외부 모델 호출 | not_run — 이번 검증 범위에서 제외 |

Node v26.12.1과 현재 설치된 pnpm 12.16.1을 사용했다. 첫 전체 회귀는 1,877 passed·41 failed·36 skipped였으며, 샌드박스의 `127.0.0.1` listen `EPERM`으로 모의 broker 검사가 막혔다. 코드·검사를 완화하지 않고 허용된 실행 환경에서 같은 전체 회귀를 다시 실행해 최종 결과를 확인했다. 이를 제품 실패의 자동 재시도와 구분한다.

새 28개 회귀는 오류 getter/proxy·임의 값 배제, task ID·프레임/JSON 중복·완결성·크기 한도, 종료 코드/시그널/스트림/기한 우선순위, budget 충돌, record-v1/v2 혼합 읽기·hash·TTL 및 잘못된 버전/코드 조합 거절을 확인했다. 실제 제한 worker의 합성 작업 파일 불일치와 receipt 이전 권한 거절도 검증했다. 원본 보존, 같은 ID의 `NOT_FOUND`, 공개 결과 형식 유지가 통과했다. 독립 정적 검토에서 추가 문제는 발견하지 못했다.

검증 로그와 집계는 소유자 전용 `/private/tmp/harness-worker-failure-lnWGl1`에 보관한다. 실제 회사 파일이나 이전 회사 보고서를 합성 fixture로 사용하지 않았다.

## 한계와 다음 최소 작업

합성 검증 후 기존에 허용된 의존 파일 범위에서 별도의 새 읽기 전용 준비 1회를 실행했다. 새 고정 진단은 `COMPANY_GIT_RANGE_INVALID_SOURCE`, 같은 ID 조회는 `NOT_FOUND`였다. 원본/Git 메타데이터 전후 일치와 worker/CLI 종료를 확인했고 실제 인증·native·모델 호출·대상 코드 수정·대상 스크립트 실행은 없었다. 질문·경로·본문·식별자와 상세 감사는 허용된 비공개 로컬 위치에만 보관했다.

이번 새 실행이 Git 원본 검증에서 거부됐다는 구분은 확인했다. 정확한 거부 분기나 과거 실패 원인을 확정하지 않으며 회사 파일이 손상됐다고 단정하지 않는다. 다음 최소 작업은 `INVALID_SOURCE`의 거부 분기를 독립 합성 사례로 좁히는 것이다. 실패한 이전 ID의 자동 재시도·원본 reset/repack·한도 확대는 하지 않는다.
