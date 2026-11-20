# Slack 본인 멘션·스레드 자동 분석 연결 결과

작성일: 2026-11-20. 기준 commit: `75effca`. 사용자가 실제 회사 파일 적용 단계를 건너뛰고 요청한 본인 멘션 감지 → 멘션과 해당 스레드의 AI 분석을 연결했다. 분석 범위와 기존 Codex 연결/native 실행 허용을 확인했으며 회사 코드 조사·수정·Slack 답장은 포함하지 않았다.

## 구현

- `slack-listen --env` 또는 `--env-file <private-env>`로 workspace·본인 사용자·채널 ID와 연결을 설정한다. 채널 ID는 쉼표로 구분한다. 기존 `--config` JSON과 계약은 유지하며 세 모드는 상호 배타적이다. `.env` 자동 탐색과 누락 값의 다른 환경 fallback은 없다.
- private env reader는 소유자·0600·regular file·symlink/hardlink·canonical 경로·UTF-8·크기·읽기 전후 identity를 검사한다. 필요한 Slack 키만 선택하며 전체 파일을 환경에 주입하지 않는다. 원래 수신 기본값과 한도를 유지한다.
- `SLACK_ANALYSIS_ENABLED=true`와 `SLACK_ANALYSIS_CODEX_CONFIG`로 기존 private relay 설정을 선택한다. 기존 native 바이너리의 버전/hash, `gpt-6.1-sol`, ChatGPT 인증, v1/v2/v3 profile과 예산은 변경하지 않는다. 회사/합성 승인이나 입력을 Slack 요청으로 가장하지 않고 새 `slack-mention-analysis-v1` 계약을 사용한다.
- 부모는 runtime lease 아래 분석 controller의 설정/바이너리 정적 준비 완료를 기다린 뒤 수신 worker를 시작한다. Slack 토큰은 수신 worker에만 주고 분석 controller에는 LANG/TZ/PATH만 전달한다. 수신·ACK·스레드 수집은 모델 응답을 기다리지 않는다. native의 실제 인증·네트워크는 기존 신뢰하는 relay/broker 경로를 사용한다.
- 읽기 전용 inbox 연결은 이번 세션에 받은 완전한 문맥만 분석 후보로 선택한다. 새 SQLite 원장은 같은 메시지/revision의 재실행을 막고, source/scope hash·상태·로컬 보고서를 기록한다. 같은 timestamp의 다른 문자열 표현도 중복으로 취급한다. 요청당 한 번, 동시 한 건, runtime별 UTC 하루 20시도가 추가 자동 분석 한도다. 불완전/잘못된 입력의 차단도 시도에 포함한다.
- credential 접근 전·전송 전·응답 후 현재 source·기간·연결·RUNNING 상태를 확인한다. 편집·삭제·멘션 제거·공백은 진행 중 호출을 취소하고 늦은 결과를 게시하지 않는다. 같은 revision의 실패는 자동 재시도하지 않는다. 과거 수신 기록과 재연결 이전 문맥도 자동 전송하지 않는다.
- 모델은 Slack 본문만 근거로 한국어 요약·사실·가설·답변 초안·추가 질문·한계를 반환한다. 고정 schema, timestamp 근거 ID와 줄 범위, 민감정보 검사를 적용하고 수정 제안은 빈 배열이어야 한다. 도구·회사 레포·명령·코드 변경·메시지 전송을 허용하지 않는다.
- `slack-list`는 본문 없는 분석 상태, `slack-inspect`는 로컬 결과를 보여 준다. 조회는 모델 설정이나 Codex 인증 없이 기존 결과를 현재 수신 자료와 대조한다. `slack-analysis.sqlite`는 원래 Slack 본문을 복제하지 않는다. 보고서 본문은 원본 TTL과 시작 후24시간 중 짧은 기한에 제거하고 최소 중복 marker는 보존한다.
- native 호출의 durable active marker는 확정 종료 뒤 자기 inode만 제거한다. hard kill·정리 불확실·알 수 없는 오류는 marker를 보존하고 다음 시작을 차단한다. SQLite의 `INTERRUPTED` 상태만으로 native 종료를 증명하지 않는다. supervisor는 두 controller의 close를 기다리며, 종료 요청 후 6.5초가 지나면 남은 controller에 KILL을 요청한다. native의 기존 guardian과 예산도 유지한다.

## 실행 진입점 보완

합성 검사에서 현재 Node가 스크립트 뒤 `--env-file`까지 먼저 처리해 파일의 `NODE_OPTIONS`를 부트스트랩에 적용하는 동작을 확인했다. `package.json`의 `harness`를 `tsc && node -- dist/src/cli/main.js`로 바꿔 Node 옵션 해석을 명시적으로 끝냈다. 직접 실행도 `node -- dist/src/cli/main.js ...`가 필요하다. 이 경계를 적용한 실제 pnpm 실행에서 파일 내부 실행 옵션을 무시하는 것을 검증했다. 이미 부모 Node를 시작할 때 지정된 실행 옵션을 하네스가 사후에 취소한다는 뜻은 아니다.

의존성·lockfile·설치된 pnpm은 바꾸지 않았다. 기존 relay profile/예산/hash 정의는 그대로이며 공유 코드 변경은 Slack trusted 입력 계약 추가와 근거 검사 인자 타입의 공통화다. 기존 회사 코드 적용 기능과 승인에는 연결하지 않는다.

## 검증

현재 설치된 pnpm 12.16.1, Node 26.12.1을 사용했다. 최소 환경·빈 npm 설정·offline 설정으로 검증했으며 native opt-in을 제거했다.

| 검사 | 결과 | 범위 |
| --- | --- | --- |
| lint·typecheck·build | passed | 통합 소스와 실제 package scripts |
| 신규 합성 검사 | passed | 환경14·감독8·정책11·서비스13·원장16·active marker7, 총69개 |
| Slack/relay 집중 회귀 | passed | 292개 중282 passed, 0 failed, native opt-in10 skipped |
| 전체 회귀 | passed | 2,314개 중2,278 passed, 0 failed, native opt-in36 skipped |
| 실제 pnpm env-file smoke | passed | package script 실행·수신2/중복1·파일 내부 NODE_OPTIONS 무시·종료0 |
| 영속 분석 smoke | passed | 실제 수신/inbox/source/store와 가짜 relay1회, REPORTED, DB 재열기 뒤 추가 호출0, 편집 무효화·본문 제거·실제 inspect 확인 |
| 실제 Slack·인증·native Codex·모델·회사 레포 | not_run | 실제 연결 값이 아직 제공되지 않아 이번 작업은 합성 검증으로 수행 |

처음 검사에서 드러난 변경 자료 오류 분류와 Node env-file 진입점 충돌을 수정하고 재검증했다. native 정리 불확실 오류가 이미 무효화된 상태에서도 다음 호출을 차단하는지, controller를 실제 SIGKILL한 뒤 marker가 보존되는지도 합성 프로세스로 확인했다. 초기 실패 로그를 삭제하거나 성공으로 바꾸지 않았다.

## 현재 사용 상태와 보관

멘션 감지 → 스레드 수집 → 기존 Codex 분석 → 로컬 조회의 구현은 연결됐다. 실제 수신 프로세스를 시작하거나 Slack 앱 설정을 바꾸지는 않았다. 사용자는 [.env.example](../.env.example)의 Slack 값과 기존 private Codex 설정 경로를 채운 뒤 [README 실행 명령](../README.md#slack-본인-멘션-자동-분석)을 사용할 수 있다. 연결 시작과 첫 분석에서 현재 로그인·바이너리·Slack 앱 권한이 실제로 유효한지 확인한다. 합성 통과를 실제 모델 호환성·Slack 운영·회사 검토 통과로 표현하지 않는다.

실행 중 수신하지 못한 Slack 변경을 알아내거나 이미 전송한 내용을 되돌릴 수는 없다. 보고서는 관찰한 문맥에 대한 검토용 결과이며 의미적 정확성은 보장하지 않는다. 기록 보관은 논리적 삭제이고 백업·디스크의 물리적 삭제 보증은 아니다. 일일 한도에 아직 진입하지 못한 요청은 같은 세션의 다음 UTC 날짜에 다시 선택될 수 있으며, 실패/소비된 revision의 재시도와는 구분한다.

허용된 `/private/tmp` 아래 새 0700 위치에 baseline·검사 로그·결과·영속 합성 smoke와 완료 audit를 보관했다. 보고/설정/로그는0600이며 테스트 자식의 합성 fixture는 별도 umask022를 사용한다. 실제 회사 경로·메시지·토큰을 공유 문서나 Git에 넣지 않았다. 검증 완료 시점에는 이번 변경을 아직 커밋하지 않은 상태였다.
