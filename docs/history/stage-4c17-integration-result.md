# 4-C-17 회사 준비 v2 통합 결과

2026-11-17. 새 Git 구간 판독기를 회사 정책·등록 v2, 안전 발췌, 전용 SQLite 보관과 CLI에 연결했다. 검증에는 합성 저장소만 사용했다. 회사 원본·실제 인증·native Codex·실제 모델·외부 서비스에는 접근하지 않았다. 실제 회사 적용과 호환성은 아직 검증하지 않았다.

## 구현한 흐름

`company-readonly-v2-plan`은 기존 회사 정책의 읽기·보관 선언을 먼저 확인한다. 미확인 상태에서는 등록 파일이나 대상 metadata에 접근하지 않는다. 새 등록의 version·고정 Git profile hash·줄 범위·경로 분리를 확인한 뒤 준비 ID를 정하고, 본문 없는 시작 기록을 파일과 디렉터리 항목에 fsync한다.

제한 worker는 원본을 두 번 읽는다. 첫 pass에서 확인한 선택 원문은 내부 메모리에서 기존 안전 view·발췌로 변환한 뒤 해제하며, 별도의 collect 읽기는 없다. 두 번째 pass에서는 새 원문 hash·파일/Git proof·안전 view를 대조한다. source 종료까지 성공해야 새 plan/payload를 원자 저장하며 상태는 `AWAITING_APPROVAL`이다. 승인 생성·전송·실행과 회사 정책 인증 여부는 모두 false다.

새 runtime은 `store/company-readonly-v2.sqlite`와 `runs/`로 나눈다. worker는 `store/`에만 쓸 수 있다. 소유자·위치·단일 링크·부모 identity·파일/디렉터리 권한을 검증한다. DB가 생성되기 전 실패한 경우에도 시작 기록의 runtime 위치 hash가 이동·복사 후 조작을 차단한다. 기존 v1 DB를 열거나 마이그레이션하지 않는다.

`inspect`, `cancel`, `prune`은 원본을 다시 열지 않는다. 취소·만료는 발췌 payload를 삭제하며 감사 기한에는 기록도 정리한다. 감사 기록과 payload의 hash를 검증해 손상을 단순 부재로 처리하지 않는다. payload 삭제 뒤에도 같은 ID의 정확한 재사용은 취소·만료를 되돌리지 않는다. 새 명시적 plan은 새 ID를 사용하고 자동 재실행은 없다.

## 불확정 결과와 프로세스 종료

DB 저장과 부모에게 응답 전달은 별개다. 시작 ID는 worker 실행 전에 남고 결과는 다른 파일에 한 번 기록한다. 저장 후 응답 유실, 시간 초과 또는 결과 파일 부재는 `unknown`이다. 같은 ID의 명시적 조회로 저장 상태·hash·기간 또는 부재를 확인하며, 조회 자체는 원래 worker의 종료를 증명하지 않는다.

부모 supervisor는 시작 시점의 30초 기한에 SIGTERM, 250ms 유예 뒤 SIGKILL을 요청한다. 유효 응답만으로 성공하지 않고 child close와 정상 exit를 확인한다. stdout/stderr는 각각 64KiB로 제한한다. worker에는 V8 old-space 128MiB, 최소 환경과 Node 권한 제한을 적용한다.

이 종료 정책은 부모 프로세스 생존과 OS 신호 처리에 의존한다. 독립 guardian은 없으므로 부모 자체가 강제 종료된 뒤의 고아 프로세스 방지·30초 종료 보장은 제공하지 않는다. 관리 Buffer 계수, V8 old-space 설정, RSS 측정 목표는 서로 다르며 OS RSS 강제 상한이 아니다.

## 검증 결과

설치된 pnpm **12.16.1**과 Node **26.12.1**을 사용했다. pnpm 버전 고정·자동 전환·설치·다운로드는 하지 않았고 의존성·lockfile을 변경하지 않았다. 검사 프로세스에는 비어 있는 인증 설정과 최소 환경을 제공했다. 전체 회귀의 네트워크 사용은 기존 합성 loopback 테스트다.

| 검사 | 결과 |
| --- | --- |
| `pnpm lint` | passed |
| `pnpm typecheck` | passed |
| `pnpm build` | passed |
| `pnpm test:company` | passed — 190개, 실패·미실행 0 |
| `pnpm test` | passed — 총 1,484개 중 1,448개 통과, 실패 0, native opt-in 36개 미실행 |
| 실제 회사 원본·인증·native·모델·외부 연결 | not_run — 요청 범위에서 제외 |

초기 타입 검사와 lint에서 새 코드의 타입 연결·테스트 표현 오류를 발견해 수정했다. 수정 후 검사 결과가 위 표이며 초기 실패 로그도 비공개 로컬 위치에 보존했다. 독립 검토에서 발견한 위조 Date 판정과 DB 없는 runtime의 위치 검증 누락도 회귀 테스트와 함께 보완했다.

추가한 합성 검사는 59개다. 정책 12개, 고정 수집 9개, 보관 13개, application 6개, supervisor/protocol 8개, private 파일 4개, CLI 7개로 구성된다. 주요 검증은 다음과 같다.

- 미확인 정책·v1 혼용·잘못된 profile은 원본 접근과 worker 생성 전에 차단한다. getter·Proxy·중복 JSON key·잘못된 UTF-8와 임의 필드도 거부한다.
- 민감값 마스킹과 악성 지시의 데이터 취급, 범위·발췌·총량 한도, 같은 안전 view를 만드는 원문 변경 거부, 두 pass의 읽기/메모리 예산 공유를 확인했다.
- 원본 변경·proof 불일치·source close 실패는 준비 저장 0으로 끝난다. plan INSERT 뒤 payload INSERT 실패도 transaction 전체를 되돌린다.
- 소유자·위치·권한·링크·DB/sidecar 교체·schema/본문/hash 변조, ID 충돌·취소·만료·감사 삭제·재시작을 검증했다. DB 없는 runtime 이동·복사도 대상 변경 없이 거부한다.
- 실제 정상 worker가 DB에 저장한 뒤 부모의 stdout 수신만 합성으로 차단했다. 부모는 unknown을 반환했고, 같은 ID 조회는 `AWAITING_APPROVAL`을 확인했다. 자동 재실행은 0이었다.
- 별도 합성 무응답 child가 SIGTERM을 무시하게 해 고정 30초/250ms 정책의 SIGKILL과 실제 close를 확인했다. DB는 생성되지 않았고 같은 ID 조회는 `NOT_FOUND`였다.
- 제한 worker에는 `LANG`, `TZ`만 전달됐으며 쓰기 범위는 store 디렉터리였다. 출력·시작/결과 기록에는 질문·선택 코드·원본 경로가 포함되지 않았다. 정상 및 실패 시 합성 원본의 전후 snapshot이 같았다.

SQL COMMIT 명령의 모든 시점에 실제 SIGKILL을 주입하는 내구성 시험, OS 중단·디스크 장애, 부모 자체 종료 후 자식 정리는 이번 검증에 포함하지 않았다.

## 합성 측정

별도 합성 측정과 집중/전체 회귀의 관찰값이다. 회사 저장소 측정이나 모든 허용 최대값을 동시에 적용한 부하 결과가 아니다.

| 항목 | 관찰값 |
| --- | ---: |
| 합성 pack 크기 / 객체 수 | 9,071,475바이트 / 4,106개 |
| 선택 파일 / 근거 범위 | 2개 / 2개 |
| 두 pass의 실제 읽기 / 예약량 | 각각 233,778바이트 |
| 실제 읽기 호출 / metadata 호출 | 30회 / 2,526회 |
| pack의 중복 제거 읽기 구간 합계, pass당 | 453바이트 — 객체 구간 421 + header/trailer 32 |
| 방문 객체 / 압축 해제 | 6개 / 14회 |
| 관리 Buffer peak / 마지막 잔여 | 281,096바이트 / 0 |
| 열린 descriptor peak / 마지막 잔여 | 2개 / 0 |
| 계획 / payload / 검토 입력 크기 | 1,692 / 15,022 / 3,014바이트 |
| 두 pass와 순수 준비 생성 | 약 47.2ms |
| 실제 제한 worker peak RSS | 집중 122,372,096 / 전체 124,223,488바이트 |
| RSS 관찰 목표 | 268,435,456바이트 이하 — 두 관찰 모두 충족 |

집중 검사에서 무응답 child의 spawn 기준 SIGTERM은 약 30,000.8ms, SIGKILL은 약 30,252.9ms였다. CLI 전체 경과는 약 30,466.8ms이며 close signal은 SIGKILL, exitConfirmed는 true였다. 전체 회귀에서도 종료를 확인했다. 부모 기한은 사전 기록 작업을 포함한 원래 시작 시각을 기준으로 하므로 spawn 이후에 새 30초를 주지 않는다. 이 수치는 관찰이며 OS 절대 종료 시각의 보장이 아니다.

## 변경 파일과 기존 계약 보존

- `src/domain/company-readonly-v2.ts`, `src/policy/company-readonly-v2.ts`: 새 등록·계획·payload와 엄격한 검증.
- `src/adapters/company-git-range-source.ts`, `company-readonly-v2-source.ts`: 기존 metadata 전용 API를 유지한 고정 안전 수집 연결.
- `src/adapters/sqlite-company-readonly-v2-store.ts`, `src/application/prepare-company-readonly-v2.ts`: 전용 보관과 준비 수명.
- `src/cli/company-readonly-v2*.ts`, `src/cli/main.ts`: 별도 명령·private 파일·worker·supervisor·공유 가능한 요약.
- `config/company-readonly-registration-v2.example.json`, `tests/company-readonly-v2*.ts`: 새 예제와 합성 회귀.
- README, handoff, 구현 계획, 선택 읽기 설계 및 이 결과 문서.

직전 단계의 코드·테스트·설정·의존성 369파일 기준선에서 기존 파일 변경은 source 연결과 CLI 명령 라우팅 2파일이다. 나머지 367파일은 바이트가 같다. 기존 회사 v1·개인·relay·수집·실행 예산 계약과 Git profile/hash·한도·의존성·lockfile은 유지하며 자동 fallback·승격은 없다.

상세 로그·검사 호출 환경·측정·파일 hash·보존 비교는 허용된 비공개 로컬 임시 위치에 보관한다. 디렉터리는 0700, 기록 파일은 0600으로 관리하며 공유 문서에는 합성 집계만 남긴다. 합성 fixture는 검사 뒤 정리한다. SQLite 삭제는 논리 삭제이며 백업·디스크의 물리적 완전 삭제를 보장하지 않는다.

## 남은 범위와 다음 최소 작업

실제 회사 적용 전에 구체 v2 등록·profile·접근 범위를 기존에 확인한 회사 허용 범위와 대조해야 한다. 선택 경로 복원에 필요한 비선택·과거 delta base의 부수 접근 중 추가·미확인 사항만 확인하며 이미 확인한 정책은 다시 묻지 않는다. 전체 pack checksum과 미조회 객체는 `not_checked`이고 작성자·서명·회사 출처를 인증하지 않는다.

현재 구현은 로컬 검토 자료를 준비하는 기능이다. 실제 회사 원본의 읽기 전용 준비, 부모 종료를 견디는 독립 감시, 실제 모델 연결과 대상 기능 수정은 각각 별도 후속 범위다. 합성 통과를 회사 보안 검토나 해당 저장소의 호환성 해결로 표현하지 않는다.
