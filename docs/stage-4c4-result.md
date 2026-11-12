# 단계 4-C-4 결과 — 실제 Codex 제안과 별도 실행 승인

검증일: 2026-11-12. [구현 계획](implementation-plan.md)의 수용 91~102에 해당한다.

## 구현 범위

고정 합성 입력의 실제 Codex 제안을 검증하여 새 승인·작업 브랜치·Docker 검사에 연결했다. 모델 호출 승인은 `synthetic-codex-proposal-v1`·`codex-proposals.sqlite`, 코드 실행 승인은 `synthetic-codex-execution-v1`·`codex-execution.sqlite`로 분리한다. 기존 승인과 정책은 재사용하지 않는다.

```text
고정 합성 입력·모델·인증·한도 계획 → 호출 승인 → 한 번의 Codex 호출
  → JSON 검증 → READY → 한 번의 EXPORTED
  → 정확한 patch·브랜치·Docker 계획 → 새 실행 승인
  → 독립 브랜치 → 승인 patch → Docker 검사 → 실제 diff·원본 보존 보고
```

- `codex-proposal-{plan,approve,run,inspect,cancel,recover}`와 `codex-execution-{plan,approve,run,inspect,cancel,invalidate,recover}`를 추가했다. 실제 명령·옵션은 [README](../README.md)의 4-C-4 절을 따른다.
- 입력은 합성 `src/message.mjs` 하나와 고정 요청이다. 응답은 `path`·`content`만 허용하며 중복/추가 키·잘못된 JSON·비허용 경로·과대 출력·비밀 패턴·잘못된 Unicode를 거부한다. 모델은 승인·브랜치·검사 명령을 결정하지 않는다.
- 사용자 선택에 따라 기존 ChatGPT 로그인을 부모에서만 읽었다. refresh·로그인 파일 복제·변경은 하지 않는다. API 키 방식도 제공하지만 이번 실제 연결은 ChatGPT 인증으로만 검증했다. 자식에는 작업별 난수 broker capability만 전달한다.
- native Codex 0.154.0과 실행 파일 SHA-256을 고정했다. 빈 HOME/CODEX_HOME, 기능 비활성화와 외부 macOS SBPL을 함께 사용한다. 같은 profile 생성기의 파일/쓰기/추가 실행/TCP/Unix socket 차단을 모델 호출 전에 진단한다.
- 부모 broker가 고정 입력·모델·schema·`tools: []`·`store: false`로 요청을 새로 구성한다. 자식의 임의 body·도구·URL은 전달하지 않는다. upstream은 작업당 최대 한 번이며 redirect·자동 재시도가 없다.
- 제공자의 완성 JSON 또는 SSE 완료 응답에서 도구 없는 assistant text 한 건만 검증해 CLI용 SSE로 전달한다. 중계용 usage 0은 실제 토큰 사용량이나 과금 근거가 아니다. 원시 오류는 저장하지 않고 제한된 실패 코드만 기록한다.
- 호출은 60초, 모델 JSON은 16KiB, 내용은 8KiB, CLI stdout/stderr는 합계 128KiB, broker 입력과 upstream 응답은 각각 256KiB다. guardian은 부모 IPC 단절·취소·시간 초과 시 자식 그룹을 종료하고 정상 경로도 종료 확인 후 반환한다.
- source·main·불변 Git 증거와 기존 Docker 제한을 유지한다. 실패·취소·중단·export 뒤 계획 생성 실패는 소비한 승인을 복원하지 않는다. 제안 코드의 호스트 실행·회사 자료·회사 저장소·Slack 요청·결과 commit·push·PR/MR은 연결하지 않는다.

주요 변경 파일은 `src/domain/codex-*`, `src/policy/codex-*`, `src/ports/codex-proposal.ts`, `src/adapters/codex-*`, `src/adapters/sqlite-codex-proposal-store.ts`, `src/application/propose-codex.ts`, `src/cli/codex-proposal.ts`와 기존 실행 정책·store·workspace·service·CLI다. 새 의존성이나 package script는 추가하지 않았다.

## 검증 결과

| 검사 | 결과 | 근거 |
| --- | --- | --- |
| `pnpm lint` | passed | 전체 src/tests |
| `pnpm typecheck` | passed | Node 26.12.1·pnpm 12.18.0 |
| `pnpm build` | passed | 실제 CLI와 테스트 산출물 컴파일 |
| `HARNESS_NATIVE_CODEX_PROBE=1 pnpm test` | passed | 전체 530개, 실패·skip 0 |
| 제안 정책·SQLite·서비스 | passed | 신규 16개: 승인/claim 원자성·변경/만료·취소·늦은 응답·복구·일회 export |
| 새 실행 정책·기존 정책 분리 | passed | 신규 12개: 네 유형·비고정 patch·Git 변조·취소·복구·기존 고정 제한 |
| CLI 경계 | passed | 신규 10개: 인증 누락·설정 변경·별도 승인·DB 분리·symlink·export 실패 보존 |
| broker·인증·출력 | passed | 신규 8개: 고정 요청·도구 제거·병렬/반복 거부·JSON/SSE 완료 검증·원시 오류 비노출 |
| 실제 macOS guardian/self-exec | passed | 신규 3개: 무출력·지속 출력 중 부모 SIGKILL 후 하위 PID/그룹 정리, self-exec 차단 |
| native Codex + 합성 upstream | passed | 실제 CLI와 긴 작업 경로에서 전체 어댑터·격리 진단·단건 응답 검증 |
| 실제 ChatGPT 인증 Codex → 새 승인 → Docker | passed | 아래 성공 작업 및 로컬 증거 |
| 실제 API 키 인증 연결 | not_run | 사용자가 기존 Codex 로그인을 선택함. 키 방식은 합성 transport 테스트만 수행 |
| 인증된 외부 모델 호출 도중 취소·강제 종료 | not_run | 합성 port/통신 취소와 실제 로컬 guardian 종료를 별도로 검증. 추가 외부 호출로 재현하지 않음 |
| 회사 자료·회사 GitLab·결과 commit·원격 작업 | not_run | 이번 합성 범위 밖 |

기존 481개에 신규 49개를 추가했다. 일반 `pnpm test`에서는 native opt-in 3개가 skip이며 위 최종 실행은 opt-in을 켜 모두 통과했다. 로그는 `/private/tmp/work-assistant-harness-stage4c4-final-tests.log`다. 최초 전체 검사에서 새 CLI 테스트의 잘못된 Docker fixture 경로로 4개가 실패했고, 허용된 고정 경로로 수정한 뒤 전체를 다시 검증했다.

## 실제 성공 작업

- 증거 root: `/private/tmp/harness-stage4c4-live-DdkCGz/`
- 제안·실행 작업 ID: `89165ba9-6f72-49b2-ae6c-f120bfcc0a06`
- 모델·CLI: `gpt-6.1-sol`, native `codex-cli 0.154.0`, macOS arm64
- CLI SHA-256: `4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc`
- 모델 결과: `READY`, 해당 작업 upstream 1회, 호출 승인 소비 1회
- 실행 결과: `SUCCEEDED`, `fix/task-89165ba9-6f72-49b2-ae6c-f120bfcc0a06`
- 기준 commit: `710f4b3301702c91b41bc90f32285d7d07d8ccab`
- 실제 diff: `export const message = 'before';` → `export const message = 'approved';` (줄바꿈 포함)
- Docker: Engine 28.3.3, Node 24.22.2, image `sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`
- 등록 검사 `synthetic-check-v1`: exit 0, container 정지·제거 확인

`call-plan.json`, `call-approval.json`, `call-result.json`, `execution-plan.json`, `execution-approval.json`, `execution-result.json`, 작업별 SQLite와 `call-report.json`·`report.json`이 근거다. `verification.json`에서 source 전후 hash, source/main·작업 main·HEAD·작업 ref, container 정리와 호출 승인 소비를 대조했다. 이 root의 파일 123개에서 현재 로그인 토큰과의 정확한 일치가 0건임을 확인했으며 토큰 값은 결과에 기록하지 않았다.

앞선 실패 작업도 지우거나 재사용하지 않았다. `/private/tmp/harness-stage4c4-live-AaZp9W/`는 외부 호출 전 macOS Unix socket 경로 길이 제한에서 실패했다. `/private/tmp/harness-stage4c4-live-RjvkfD/`와 `/private/tmp/harness-stage4c4-live-gkyhxn/`는 각각 upstream 1회 이후 응답 처리에서 실패했고, 후자는 HTTP 200의 완성 JSON을 SSE로만 받던 호환 문제를 확인했다. 요청 헤더·응답 정규화를 수정하고 새 계획·새 승인으로 성공 작업을 만들었다. 최종 성공 작업의 1회 호출을 개발 중 전체 호출 수로 표현하지 않는다.

실제 CLI와 합성 upstream 검증은 `/private/tmp/harness-codex-native-8cmSvA/`에 남겼다. 일반 테스트의 fixed port 응답, native CLI 합성 응답, 인증된 실제 응답을 구분한다.

## 한계와 다음 최소 작업

현재 지원은 macOS arm64·Codex 0.154.0·고정 합성 과제/파일 하나다. Codex·하네스 controller·동일 OS 사용자·시스템 library·Docker daemon/VM/kernel을 신뢰한다. SBPL의 시스템 metadata 읽기와 runtime library 접근까지 모두 차단한 환경은 아니며 worktree만으로 격리되었다고 주장하지 않는다. 직접 작업 트리 수정이나 임의 저장소·명령을 제공하지 않는다.

빈 HOME에서 private model catalog를 복제하지 않으므로 지정 모델의 정확한 metadata fallback 경고만 허용한다. 모델 metadata 완전성·최적 성능·다른 CLI 버전 호환성을 검증한 것이 아니다. 모델 코드의 무해함이나 회사 보안 검토 통과를 JSON 검증·합성 검사 성공으로 대체하지 않는다. 로컬 취소는 이미 보낸 요청이나 제공자 측 처리를 되돌리지 않는다.

다음 최소 작업은 대상 저장소에서 모델에 제공할 읽기 전용 문맥과 허용 파일 범위, 자료 전송 승인 기준을 별도 계획으로 정하는 것이다. 회사 자료를 연결하기 전에는 합성 다중 파일 사례로 그 경계를 검증하고, 직접 수정 방식·commit·push는 각각 별도 범위로 유지한다. PR/MR 생성 제외 규칙을 유지한다.

공식 연결 근거: [비대화형 Codex](https://learn.chatgpt.com/docs/non-interactive-mode), [설정 항목](https://learn.chatgpt.com/docs/config-file/config-reference), [ChatGPT 인증 gateway](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway).
