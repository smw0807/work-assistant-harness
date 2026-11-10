# 단계 1 구현 결과

## 범위와 기준

2026-11-09 기준 [전체 계획](implementation-plan.md)의 단계 1을 구현했다. 시작 시 코드와 패키지 설정이 없었으므로 단계 0의 최소 기반을 포함한다. 단계 2 이후의 연결·실행 기능은 포함하지 않는다. 패키지 매니저는 사용자 선택에 따라 pnpm 하나로 고정했다.

## 변경 파일과 책임

| 경로 | 구현 |
| --- | --- |
| `src/cli/` | NestJS application context, 명령 파싱, 비공개 데이터 경로와 프로세스 잠금, 제한된 조사 프로세스 |
| `src/domain/` | 외부 서비스와 독립적인 작업·근거·계획 타입과 상태 전이 |
| `src/ports/` | MessageSource, ModelPort, RepoReadPort, ApprovalPort, ExecutionPort, ReportSink, TaskStore |
| `src/application/investigate.ts` | 정규화·중복·분류·읽기·계획·보고 흐름과 모델 제한 시간 |
| `src/adapters/` | 가짜 이벤트, 고정 모델, 읽기 전용 Git reader, SQLite, 로컬 JSON 보고, 항상 거부하는 승인·실행 포트 |
| `src/policy/` | 입력 필터, strict JSON 스키마, 비밀 패턴 처리, 파일·경로·출력 제한 |
| `fixtures/events/` | 정상 흐름과 경계·오류·악성 입력을 재현하는 합성 이벤트 24개 |
| `config/local.example.json`, `.env.example` | 합성 ID와 토큰 불필요 안내 |
| `tests/` | 도메인·모델·저장소·상태 복구·실제 CLI·프로세스 권한 검증 |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.node-version`, `tsconfig.json`, `eslint.config.mjs` | 고정 의존성과 개발 명령 |

## 데이터 흐름과 완료 조건

로컬 이벤트 배열에서 허용 workspace/channel과 `<@U_OWNER>`를 먼저 검사한다. SQLite의 `(workspace_id, event_id)` 유일성 제약으로 중복을 막고 원문을 저장하지 않는다. 모델 입력은 비밀 패턴을 마스킹한다. 고정 모델의 분류와 요약은 크기 제한 및 JSON 스키마로 검증한다.

문의는 full SHA·repoId·파일 경로·줄 범위를 가진 근거와 초안을 만든다. 변경 요청은 근거로 확인한 파일에 한정된 계획과 해시를 만들고 `AWAITING_APPROVAL`에서 멈춘다. 불명확한 요청은 파일을 읽지 않고 질문을 남긴다. JSON 오류와 미확인 근거는 `FAILED`, 읽기 정책 위반은 `BLOCKED`로 남긴다.

Git 자료는 커밋 객체에서 읽으며 합성 대상의 스크립트를 실행하지 않는다. 조사 프로세스의 쓰기 범위를 SQLite·보고서 디렉터리로 제한하고 네트워크·child process·worker 권한을 차단한다. 전체 대상 파일과 `.git`, 미추적 파일, mode, symlink 대상을 조회 전후 비교한다. runtime DB·저널의 dangling symlink/hardlink도 거부한다.

SQLite 상태가 보고서의 원본이다. 보고서 파일의 누락은 재생성하고, 중단된 조사 상태는 자동 실행 없이 `BLOCKED`로 복구한다. 보고서는 고유한 임시 파일과 rename으로 교체한다. 전원 손실 때 JSON 파일 자체의 디스크 반영까지 보장하지는 않으며 DB에 남은 자료로 복구한다.

## 검증 결과

최종 검증 결과는 아래에 기록한다. 테스트는 실제 외부 자료가 없는 macOS/Node 26.12.1 환경에서 실행한다.

| 검사 | 결과 | 설명 |
| --- | --- | --- |
| `pnpm lint` | passed | ESLint 오류 없음 |
| `pnpm typecheck` | passed | strict TypeScript 검사 통과 |
| `pnpm test` | passed | 전체 60개, 실패 0개·미실행 0개 |
| `pnpm build` | passed | 최신 소스와 테스트 컴파일 통과 |
| 대상 설치·테스트·빌드 | not_run | 읽기 단계의 금지 동작 |
| 실제 Slack·AI·회사 저장소 연결 | not_run | 이번 범위 밖 |
| 승인 만료·위조·소비 및 격리 수정 | not_run | 단계 3 미구현 |

계획서 수용 항목 01~05, 09~11, 13의 실패/미실행 구분, 14의 로컬 재시작 복구, 15~16의 외부 전송 차단·합성 비밀 패턴을 초기 범위에서 검증한다. 항목 06~08, 12, 실행 중인 수정의 취소·복구는 구현·검증하지 않았다.

전체 테스트 후 추가한 불명확 JSON 조건과 악성 README 근거 확인 assertion은 `pnpm build` 후 `node --test dist/tests/ingestion-model.test.js dist/tests/workflow.test.js`로 관련 21개를 다시 실행해 모두 통과했다. CLI 실행 중 보고서 쓰기 실패 후 SQLite에 남은 결과가 다음 실행에서 중복 분석 없이 복구되는 것도 확인했다.

## 남은 한계와 다음 최소 작업

- CLI는 합성 저장소만 준비하며 실제 저장소 경로를 받지 않는다. reader도 loose 객체만 지원한다. pack 지원은 별도 제한과 테스트가 필요하다.
- 고정 모델 시나리오는 자연어 이해나 실제 조사 품질 평가가 아니다. 근거 인덱스 존재 검증은 설명의 의미적 정확성을 보장하지 않는다.
- 비밀 패턴 검사는 보수적인 방어이며 모든 형태의 비밀을 판별하는 데이터 정책 엔진은 아니다. 실제 회사 자료는 연결하지 않았다.
- Node 권한 모델과 파일 검사에는 신뢰하는 하네스 코드·같은 OS 사용자라는 전제가 있다. 악성 코드 실행용 보안 격리는 아니다.
- 편집·삭제 이벤트는 무시한다. 계획 취소·승인 무효화, 데이터 보관 기간, 명시적 재처리와 실환경 운영 정책은 미구현이다.
- Windows·Linux 실행, 실제 네트워크 연결과 회사 보안 검토는 미검증이다.

2026-11-10 후속 작업은 [단계 2 계획](implementation-plan.md#단계-2-slack-읽기-연결)의 수신 어댑터·오프라인 복구 검증부터 진행한다. 위 한계는 단계 1 완료 시점의 기록이며 후속 변경은 [단계 2 구현 결과](stage-2-result.md)를 따른다. 승인 모델·로컬 승인 명령과 격리 실행기는 단계 3 기능이다. 실행 연결 없는 만료·취소·1회 소비·계획 및 커밋 불일치 테스트는 선택적 선행 보강이며 단계 2 시작의 필수 조건이 아니다. 실제 Slack 수신과 격리 실행은 해당 단계의 별도 권한·보안 조건을 확인한 후 검증한다.
