# 단계 4-C-14 회사 환경 이전용 오프라인 점검 결과

회사 환경으로 옮기기 전에 실행 장비와 비활성 설정의 정적 조건을 확인하는 `migration-check`를 구현했다. 설정 템플릿과 실행 가이드를 준비했고, 현재 개인 macOS ARM64 장비에서 정적 검사 9개와 로컬 회귀 검증을 통과했다. **회사 자료·실제 인증정보 접근과 실제 모델 호출은 0회**다. 이 결과는 회사 장비에서 실행한 결과나 회사 자료 처리 승인이 아니다.

## 구현과 사용

- [설정 템플릿](../../config/migration-check.example.json): 기존 비활성 relay v3 설정과 별도 런타임 경로를 담는 `offline-migration-check-v1` 입력이다. 회사 저장소·질문·인증값·임의 명령 필드는 없다.
- [실행 가이드](../migration-guide.md): 승인된 소프트웨어 반입, 새 비공개 설정/저장 경로 준비, 명령 실행, 결과 보관과 미검증 범위를 설명한다.
- `src/domain`, `src/policy`, `src/application`, `src/ports`, `src/adapters`, `src/cli`의 `migration-check.ts`: 순수 판정, 환경 관찰 포트, 제한된 파일 읽기, 별도 Nest application context를 분리했다. 기존 CLI에는 명령 분기와 사용법만 추가했다.

```sh
pnpm harness migration-check --config /absolute/path/to/private-migration/migration-check.json
```

점검은 명시한 진단 설정과 고정 native 파일의 내용만 제한적으로 읽는다. `sandbox-exec`와 런타임 디렉터리는 메타데이터만 확인한다. 디렉터리 내용 열거·쓰기 시험·DB 생성·승인 생성·로그인 확인·바이너리 실행·네트워크 연결은 하지 않는다. `pnpm harness`의 선행 TypeScript 빌드는 하네스 `dist`를 쓰며, 사용자가 stdout을 파일로 저장하는 동작도 진단 자체와 구분한다.

## 로컬 검증

| 검사 | 결과 |
| --- | --- |
| `pnpm lint` | passed |
| `pnpm typecheck` | passed |
| `env -u HARNESS_NATIVE_CODEX_PROBE -u HARNESS_NATIVE_CODEX_PATH pnpm test` | passed: 전체 1,270개 중 1,234 passed, 0 failed, 36 skipped. 선행 `tsc` 빌드 포함 |
| 신규 정책·파일 adapter·CLI 검사 | 29 passed, 전체 회귀에 포함 |
| 현재 장비의 `migration-check` | passed, 종료 코드 0. 정적 9 passed, 범위 밖 8 not_run |
| 기존 파일 보존 | 기준 커밋 `3c23c6c9bfaae3613671e30eab632f4def1dcc3f`의 377개 중 372개 동일. 변경 5개는 README, 구조·보안·계획 문서와 CLI 분기/사용법 |
| 로컬 진단 입력·저장 경로·고정 바이너리 | 설정 hash, 런타임 metadata/빈 상태, native metadata 전후 동일 |
| 독립 정적 검토 | 구현·문서의 경계 검토에서 blocker 없음 |

신규 검사에는 활성 설정·알 수 없는 필드·중복 JSON 키·잘못된 UTF8·민감 경로 거부, 권한·소유자·링크·경로 겹침·파일 교체 검사, 미지원 호스트와 누락된 실행기 선언의 후속 접근 생략, 원시 경로/환경/오류 비출력, 합성 canary 보존을 포함한다. CLI 검증은 Node permission과 추가 파일/네트워크/프로세스 관찰 장치를 사용했다. 그 검증 장치나 worktree를 회사 코드 실행의 보안 격리로 주장하지 않는다.

첫 전체 실행에서는 민감 문자열을 담은 합성 설정의 예상 오류 코드 1건이 달랐다. 기존 JSON 민감 검사에서 먼저 거부한 정상 동작이므로 테스트 기대값만 수정했다. 초기 실패 로그를 보존하고, 모든 코드·테스트 수정을 끝낸 뒤 전체 검증을 순차 재실행하여 위의 최종 통과 결과를 얻었다.

기존 native/sandbox 실행 opt-in 검사 36개는 현재 작업의 오프라인 범위에 맞춰 미실행했다. 실제 Codex 실행, 로그인 유효성, 공급자 통신, 회사 기기에서의 실행과 회사 자료 처리는 `not_run`이다. 다른 OS 판정은 합성 관찰로 검증했으며 Windows/Linux의 실제 실행 지원을 추가하거나 검증하지 않았다.

로컬 보고서의 9개 통과 항목은 설정, OS/CPU, Node, pnpm 실행기 선언, UID, 경로 분리, sandbox 파일 metadata, native 고정 hash, 저장 디렉터리 metadata다. 인증·모델·회사 승인·회사 소스·네트워크·native 버전 실행·sandbox 동작·저장 쓰기 시험의 8개 항목은 `not_run`이고, `liveReady`, `executionAllowed`, `approvalCreated`는 모두 `false`다.

## 기존 계약과 한계

기존 relay-v2/v3, 개인 수집 v2, 실행 예산 v1, 민감정보 검사 구현과 상한은 수정하지 않았다. 의존성·lockfile도 그대로다. 진단의 별도 입력 버전은 실행/전송 계약을 변경하거나 기존 승인을 승격하지 않는다. 비활성 설정의 config/profile hash는 해당 설정으로 계산하며 이전 활성 설정의 hash와 같다고 주장하지 않는다.

| 유지한 계약 | 값 |
| --- | --- |
| 수집 profile hash | `8acdca9effe323a36b322589bec24367b51c8e3c6268c09d5672787b07fd7033` |
| 실행 예산 hash | `00b7a09da8cfaf6d13e0d5e478496a832af792bef0f06eed25d584cc593f2a53` |
| 실행 예산 v1 | 실행 120초·공유 정리 5초·총 125초·8192프레임 |
| 기존 relay-v2 예산 | 실행 55초·공유 정리 5초·총 60초·2048프레임 |
| 응답 | 4MiB·개별 frame 64KiB·최종 16KiB |
| 수집 v2 | 원본/전체 view 64KiB·개별 발췌 32KiB·근거 64KiB·입력 128KiB·8파일/16범위/범위당 200줄·마스크 128개 |

pnpm 관찰은 실행기가 제공한 미검증 선언이다. 파일 권한과 hash는 ACL·실제 쓰기 성공·용량·격리 동작이나 이후 무변경의 보증이 아니다. 알려진 민감 경로는 읽기 전에 거부하지만 허용된 설정/바이너리 이름으로 위장한 파일의 성격을 읽기 전에 완전히 판별하지는 못한다. 이 한계와 실제 호출 시 별도 재검증 조건을 가이드에 명시했다.

검증 로그·실제 로컬 설정·정적 보고서·전후 보존 기록·소스/빌드 및 자료 hash는 비공개 [검증 자료 디렉터리](/Users/songminwoo/.local/share/work-assistant-harness/reviews/stage4c14-offline-migration-fo_f5e0r)에 보관한다. 디렉터리는 `0700`, 파일은 `0600`이다. Git에는 합성 템플릿·구현·테스트·요약 문서만 둔다. 기존 개인 저장소·승인 DB·과거 조사 본문은 이번 작업에서 열지 않았다.

다음 최소 작업은 회사의 소프트웨어 반입 절차와 회사 장비 OS/CPU를 확인하고, 지원 환경에서 회사 자료·인증 없이 같은 오프라인 점검을 수행하는 것이다. 이후 합성 자료 검증과 회사 자료 접근/전송 계획을 분리한다. 이번 단계에서는 새 실제 호출 계획이나 승인 기록을 만들지 않았다.
