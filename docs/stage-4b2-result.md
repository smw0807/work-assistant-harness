# 단계 4-B-2 구현 결과

## 상태와 범위

2026-11-11의 후속 구현 범위는 **개인 테스트 workspace의 원래 스레드에 고정 합성 문구를 별도 live 승인 후 한 번 전송하는 경로**다. 구현과 수용 52~61의 합성 검증을 완료했다. 전체 회귀 367개와 lint·typecheck·build가 통과했다. 수용 62의 실제 Slack 계획 생성·별도 승인·고정 문구 단건 게시도 개인 테스트 workspace에서 완료했다. 회사 운영·업무 자료·AI·실제 업무 자동 답장은 `not_run`이다. 상세 설계와 수용 52~62는 [4-B-2 계획](implementation-plan.md#단계-4-b-2-고정-시험-문구의-slack-단건-전송)을 따른다.

실제 workspace/channel/thread/bot ID·token·원문·런타임 DB·승인 기록은 이 문서나 fixture·Git에 넣지 않는다. 회사 자료·모델 답변·대상 제품 저장소·자동 업무 답장·DM·Git 원격 작업은 연결하지 않는다. 기존 4-A 모의 전송과 4-B-1 오프라인 진단은 보존한다.

## 데이터 흐름

```text
slack-live-plan → auth.test + conversations.replies → live 계획
slack-live-inspect → 대상·해시·고정 시험 문구 검토
slack-live-approve → auth/thread 재확인 → OS UID·해시·필수 TTL → 새 live 승인
slack-live-send → auth/thread 재확인·5초 최신성
  → 승인 소비 + SENDING 원자 저장 → chat.postMessage 최대 1회
  → SENT / FAILED(NOT_SENT) / UNKNOWN
slack-live-recover → 중단된 SENDING을 UNKNOWN으로 확정, 재전송 없음
```

## 변경 파일

| 파일 | 역할 |
| --- | --- |
| `src/domain/live-slack.ts`, `src/policy/live-slack-policy.ts`, `src/ports/live-slack.ts` | 별도 live 계약·고정 본문·계획/문맥/소유자·최신성·claim 검증 |
| `src/adapters/live-slack.ts` | 고정 Slack 인증/스레드/단건 POST, scope·identity·receipt·결과 분류 |
| `src/adapters/sqlite-live-slack-store.ts`, `src/application/live-slack.ts` | 별도 DB·승인 원자 소비·대상 중복·복구·보관과 흐름 조합 |
| `src/cli/live-slack.ts`, `src/cli/live-slack-worker.ts`, `src/cli/main.ts` | 명령 라우팅·숨김 입력·제한 worker·전역 lease·본문 출력 경계 |
| `tests/live-slack-store.test.ts`, `tests/live-slack-adapter.test.ts`, `tests/live-slack-cli.test.ts` | 합성 store/service·HTTP·CLI/TTY·권한·실제 강제 종료 후 복구 수용 검증 |
| `.env.example` | 실제 값을 포함하지 않는 별도 전송 token 환경변수 이름 안내 |
| `README.md`, `docs/implementation-plan.md`, `docs/security-and-approval.md`, `docs/architecture.md`, 이 문서 | 실제 명령·상세 수용 52~62·한계와 검증 상태 |

## 구현 계약

| 영역 | 계약 |
| --- | --- |
| 권한과 상태 | `slack-live-test-v1`, 별도 `live-replies.sqlite`, 기본 live 비활성. 기존 코드/실행/mock 승인과 diagnostic intent 재사용 금지 |
| 허용 원문과 전송 본문 | root 원문 `하네스 전송 테스트` 한 개·reply 없음. 전송은 코드의 `하네스 Slack 단건 전송 테스트입니다. (4-B-2)` 일반 텍스트 한 번 |
| 계획과 승인 | OS UID 소유자·설정을 포함한 계획 hash·목적지·source/bot identity·본문 hash·최대 24h 계획. 필수 정수 TTL 1~60분·계획 만료 이내 |
| 문맥 | plan/approve/send마다 auth/thread 조회, raw revision·문맥 hash·5초 이내 관측·완전성 확인. 편집/삭제/new reply/불일치는 차단 |
| 중복과 복구 | 승인 소비+SENDING 원자 저장. SENT/UNKNOWN 대상 marker로 다른 task ID의 새 계획도 차단. 중단은 UNKNOWN, 자동 재시도·승인 소비 복원 없음 |
| 자격증명과 HTTP | `SLACK_SEND_TOKEN` 환경 또는 TTY 숨김 입력. plan/approve/send worker만 token/network. 고정 3 API·10초·32KiB·redirect 거부·재시도 0 |
| 비저장과 보관 | Slack 원문·고정 본문·token DB 저장 없음. metadata만 유지하고 검토 본문은 코드 상수 재구성. terminal 감사 30일 정리·대상 marker DB 수명 유지 |

## 검증 결과

| 검사 | 상태 | 근거/사유 |
| --- | --- | --- |
| lint | passed | `pnpm lint` 종료 코드 0 |
| typecheck | passed | `pnpm typecheck` 종료 코드 0 |
| 단위·통합·CLI·전체 회귀 | passed | `pnpm test` 종료 코드 0, 367개 통과·실패 0·건너뜀 0 |
| build | passed | `pnpm build` 통과와 전체 회귀의 TypeScript 컴파일 통과 |
| 문서/변경 공백 검사 | passed | `git diff --check` 통과 |
| 기본 경로 수동 조회 | passed | `pnpm harness slack-live-list` 종료 코드 0, 빈 tasks·maintenance 0·`mode: live-test`·`liveEnabled: false` 확인. token·네트워크 없이 조회 |
| 수용 52: 기본 거부·정책/DB 분리 | passed | 비활성·다른 정책·추가 키·외부 본문·argv token·다른 소유자는 네트워크/전송 전에 거부. 기존 DB와 승인 재사용 없음 |
| 수용 53~55: identity·문맥·OS 승인/TTL | passed | scope/팀/bot/user·raw revision·문맥·5초 최신성·계획 hash·TTL·승인 snapshot 변조 거부, 미승인 POST 0 |
| 수용 56~58: 원자 소비·receipt·중복/중단 복구 | passed | 동시 send 단건·저장 실패 rollback·정확한 receipt·NOT_SENT/UNKNOWN 분리. 실제 child 강제 종료 후 새 프로세스 recover, 대상 timestamp 표현 차이로 중복 우회 불가 |
| 수용 59~61: 비저장·보관·worker/파일/lease·회귀 | passed | DB 원문/본문/token 비저장·30일 감사 정리 후 marker 유지·private/link/lease·제한 worker·숨김 TTY/no-echo 복원·raw 적용 실패 거부. 변조된 DB receipt/승인 row는 조회부터 거부 |
| 수용 62: 실제 Slack 계획·승인·단건 게시·receipt·게시 후 확인 | passed | 사용자가 구체 계획의 별도 승인과 send를 실행. 로컬 작업·시도 한 개 SENT·승인 소비 한 번과 Slack UI의 원래 스레드 댓글 한 개·고정 본문·bot 표시·receipt 일치 확인 |
| 회사 보안 검토·업무 자료·모델·제품 저장소·자동 업무 답장 | not_run | 개인 고정 단건 시험 범위 밖 |

신규 43개는 `live-slack-store.test.ts`의 정책/store/service 18개, `live-slack-adapter.test.ts`의 합성 HTTP 15개, `live-slack-cli.test.ts`의 CLI/TTY 10개다. 기존 324개를 포함한 최종 실행 로그는 이 로컬 환경의 `/private/tmp/work-assistant-harness-stage4b2-final-tests.log`에 남겼다. 검증 환경은 macOS arm64·Node 26.12.1·pnpm 12.18.0이며 의존성·lockfile은 변경하지 않았다.

자동 회귀 검사는 합성 HTTP 응답을 사용했고, 실제 단건 시험은 그 뒤 사용자가 구체 계획에 별도로 승인하여 실행했다. 앞선 읽기 진단의 성공을 이 live 계획·승인·게시의 근거로 대신하지 않았다. Git 원격 작업은 수행하지 않았다.

## 실제 단건 시험의 관찰 근거

전송 완료 시각은 **2026-11-11 14:06:06.267 UTC (한국 시각 23:06:06.267)**다. 사용자가 댓글 생성을 확인한 뒤 로컬 inspect에서 작업 `SENT`, 전송 시도 한 개의 `SENT`, 소유자 승인 소비 한 번과 실제 receipt를 확인했다.

Slack UI에서는 원래 root의 고정 시험 원문과 댓글 한 개, 앱이 게시한 정확한 고정 전송 본문을 확인했다. 게시 링크의 channel·thread·message timestamp가 로컬 receipt와 일치했다. 실제 개인 식별자·계획 해시·승인 기록·receipt 원문은 비공개 로컬 자료로 유지하고 이 문서에 복제하지 않는다.

endpoint별 실제 호출 횟수는 직접 계측하지 않았다. 단건 결과는 저장된 전송 시도 한 개와 UI의 댓글 한 개를 대조해 확인했으며 추가 게시·재시도·삭제는 수행하지 않았다. 이 시험은 개인 고정 문구의 단건 전송 확인이며 회사 보안 검토·자료 처리·모델 연결·실제 업무 자동 답장의 통과를 뜻하지 않는다.

## 한계와 다음 최소 작업

전역 lease는 같은 데이터 디렉터리의 실시간 수신과 live 명령을 직렬화한다. 수신 이벤트의 누락 없는 감지나 Slack 조회와 POST의 원자성은 제공하지 않는다. 마지막 5초 이내 조회와 실제 게시 사이 외부 편집·삭제·새 reply를 완전히 막을 수 없다. Node 권한과 고정 API 검사는 호스트별 OS 네트워크 격리나 악성 코드용 sandbox가 아니다.

만료·terminal 감사 정리는 명령 실행 시 수행하므로 중지 중 자료는 다음 실행까지 남는다. SQLite 논리 삭제는 백업·디스크의 물리적 완전 삭제를 보장하지 않으며 DB 폐기 후에는 과거 대상 중복 차단도 보장하지 않는다. 게시 메시지는 Slack workspace 보관 정책을 따르고 자동 수정·삭제 API는 제공하지 않는다.

4-B-2의 개인 고정 단건 시험은 완료했다. 다음 최소 작업은 구현 변경을 검토하고 사용자 요청이 있으면 커밋·push를 진행하는 것이다. 후속 확장은 4-C의 원격·브랜치·diff·PR 정보와 행위별 승인을 별도 계획으로 검토한다. 이번 성공을 다른 대상·본문의 전송이나 회사 운영·자동 답장 승인으로 재사용하지 않는다.

**2026-11-12 후속 범위 변경:** 위 문단은 4-B-2 완료 당시의 다음 작업 제안이다. 이후 사용자 결정에 따라 하네스가 Codex에 대상 저장소 수정을 지시할 때 PR/MR 생성을 제외하고 `feature/`, `fix/`, `chore/`, `refactor/` 등 작업 유형별 브랜치를 사용하도록 계획을 변경했다. 이는 하네스 저장소 자체의 개발 규칙 변경이 아니며 아직 구현되지 않았다. 현재 후속 범위는 [4-C 계획](implementation-plan.md#후속-단계의-별도-범위)을 따른다.
