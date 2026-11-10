# 단계 3-B 구현 결과

## 범위와 상태

2026-11-10에 고정 합성 probe만 실행하는 **로컬 Docker 격리 진단 경로**를 구현했다. 아래 지원 환경에서 실제 probe 5개를 실행해 수용 기준 33을 통과했다. 대상 제품 코드의 실행 기능과는 분리한다.

실제 Slack·AI·회사 저장소를 연결하지 않는다. `ExecutionPort`는 항상 거부하고 `run` 명령은 제공하지 않는다. `approval-only-v1` 승인 소비·Run 생성·patch 적용·대상 설치·검사·빌드·외부 메시지·Git 원격 작업은 이번 범위 밖이다. 진단이 통과해도 `executionEnabled: false`이며 이후 실행의 승인이나 영속 허가로 재사용하지 않는다.

## 지원 backend와 고정 정책

| 항목 | 지원·검증한 값 |
| --- | --- |
| 호스트 | macOS `darwin/arm64` |
| backend | 로컬 Unix socket의 Docker Desktop Linux daemon |
| Engine·플랫폼 | `29.4.3`, Linux `aarch64`, cgroup v2, 기본 seccomp |
| Docker 실행 파일 | `/usr/local/bin/docker` |
| 진단 이미지 | 공식 `node:24.22.2-alpine3.23`, Linux arm64 |
| 이미지 전체 ID | `sha256:0efee1e068d21f6edcab7fa8c962fc4ecd50d4e28727bc23963379b63ee318ab` |
| 컨테이너 Node | `24.22.2` — 하네스의 Node 26.12.1과 구분 |
| 정책 버전 | `docker-probe-v1` |
| 기본 설정 | `enabled: false`, socket·image ID는 사용 불가능한 자리표시자 |

공식 이미지는 backend 준비 과정에서 다운로드했다. 하네스 진단 명령은 image pull·build·설치를 자동 실행하지 않는다. 설정에 명시한 Engine 버전·이미지 ID·Node 버전이 실제 환경과 다르면 실패한다. 지원 밖 OS나 다른 daemon을 허용하는 fallback도 없다.

## 구현 범위와 변경 파일

| 경로 | 책임 |
| --- | --- |
| `src/domain/sandbox.ts` | 설정·backend identity·probe·보고서 계약, 고정 정책 버전·자원 한도 |
| `src/policy/sandbox-policy.ts` | 정확한 설정 스키마·실행 파일·image ID와 지원 호스트 검증 |
| `src/ports/sandbox.ts` | 임의 명령을 받지 않는 `SandboxVerificationPort` |
| `src/adapters/docker-sandbox.ts` | 최소 환경·private Docker 설정, daemon·image preflight, 고정 container 생성·유효 정책 검사·종료·제거 |
| `src/adapters/sandbox-probes.ts` | `boundary`, `pids`, `memory`, `timeout`, `output` 고정 합성 코드 |
| `src/application/verify-sandbox.ts` | 합성 canary 준비·probe 결과 검증·전후 해시·지연 child 확인, 실행 권한 없는 보고서 |
| `src/cli/sandbox.ts`, `src/cli/main.ts` | NestJS application context 기반 `sandbox-check`, 제한된 옵션·잠금·신호 처리·비공개 보고서 |
| `config/sandbox.example.json`, `.gitignore` | 기본 비활성 예제와 로컬 설정 커밋 제외 |
| `tests/docker-sandbox.test.ts`, `tests/sandbox-probes.test.ts` 및 관련 진단 테스트 | mock 어댑터·정책·고정 코드·검증 서비스·CLI 회귀 검사 |
| `README.md`, `docs/architecture.md`, `docs/security-and-approval.md`, `docs/implementation-plan.md`, 이 문서 | 명령·지원 환경·실증과 실제 실행의 경계·남은 작업 |

패키지 매니저·직접 의존성·lockfile은 변경하지 않는다. 기존 조사 worker의 네트워크·하위 프로세스 권한과 수신·승인 경계도 유지한다. Docker를 호출하는 진단 controller는 신뢰하는 하네스 코드다.

## 로컬 명령과 결과 보존

```sh
pnpm harness sandbox-check --data-dir /private/tmp/harness-sandbox-data
pnpm harness sandbox-check --config /absolute/path/to/private-sandbox.json --data-dir /private/tmp/harness-sandbox-data
```

첫 명령은 예제의 `enabled: false`를 사용해 Docker 접속 없이 `blocked`를 기록한다. 활성화하려면 예제를 저장소 밖의 비공개 설정으로 복사하고 정확한 로컬 socket·버전·이미지 ID와 `enabled: true`를 지정한다. `--config`와 `--data-dir` 이외 임의 probe·명령·대상 저장소·task 옵션은 없다. 예제의 0으로 채운 image ID와 socket 자리표시자로는 활성 검증을 할 수 없다.

결과는 `<data-dir>/sandbox-checks/<verificationId>/report.json`에 저장한다. 보고서의 `status`는 `passed`, `failed`, `blocked`이고 개별 검사는 `passed`, `failed`, `not_run`과 이유를 가진다. backend identity·적용 한도·probe별 종료 유형과 코드·OOM 여부·container 이름·정지와 제거 여부·보호 영역 전후 해시도 기록하며 원시 Docker 오류·probe 출력은 싣지 않는다. 성공은 종료 코드 0, 실패·차단은 1이다.

진단이 생성한 container만 고유 이름·label·전체 ID로 소유권 확인 후 종료·제거한다. 생성 응답을 잃고 현재 부재만 확인한 경우에는 뒤늦은 생성 가능성을 배제할 수 없으므로 `SANDBOX_CLEANUP_UNCONFIRMED`와 이름을 남기고 정리 성공으로 보고하지 않는다. 합성 workspace·보호 파일·빈 private Docker 제어 디렉터리·보고서는 검토를 위해 남긴다. 자동 commit·push와 사용자 작업 정리는 하지 않는다.

## 격리 검사

workspace만 쓰기 마운트하고 보호 파일은 그 밖에 둔다. 보호 파일의 값은 전부 합성이며 실제 호스트 자격증명·회사 코드·승인 DB·공유 Git을 사용하지 않는다.

| probe | 기대 결과 |
| --- | --- |
| `boundary` | workspace 쓰기 성공, 합성 호스트·원본·승인 DB·공유 Git의 절대경로·`..`·symlink·`/proc/1/root` 접근 실패, root 쓰기·Docker socket 접근 차단, 최소 환경·nonroot·capability 제거·권한 상승 금지·seccomp 확인, loopback만 존재·외부 TCP/DNS 실패, cgroup 한도 확인 |
| `pids` | PID 64개 한도 안에서 프로세스 생성이 `EAGAIN`으로 거부됨 |
| `memory` | 128MiB 메모리·swap 0 한도를 넘는 합성 할당이 OOM 종료되고 종료 코드 137 확인 |
| `timeout` | detached child 시작 파일 확인, 1.5초 상한으로 CLI 종료 후 container kill·코드 137·OOM 아님·정지·제거, 지연 child marker 미생성 |
| `output` | detached child 시작 파일 확인, stdout/stderr 합계 16KiB 초과로 CLI 종료 후 container kill·코드 137·OOM 아님·정지·제거, 지연 child marker 미생성 |

CPU 0.5개 한도는 cgroup `cpu.max`의 quota/period 값으로 검증한다. 성능 벤치마크나 실제 업무 코드의 시간 보장은 아니다. 보호 파일은 probe 실패 후에도 가능한 범위에서 전후 전체 해시를 비교하며 변경을 성공으로 보고하지 않는다. container 시작 전 inspect로 mount·환경·명령·네트워크·권한·자원·log driver 등 유효 정책을 다시 검증한다. 고정 probe에는 7.5초 자체 watchdog도 둔다. 이 보조 장치를 범용 실행기의 crash 복구로 해석하지 않는다.

## 검증 결과

| 항목 | 결과 | 근거 또는 미실행 사유 |
| --- | --- | --- |
| `pnpm lint` | passed | 오류 없음 |
| `pnpm typecheck` | passed | 오류 없음 |
| `pnpm test` | passed | 171개 통과, 실패·건너뜀 0. 기존 138개와 신규 33개(adapter 15·probe 문법 3·정책/서비스/CLI 15). mock 결과와 실제 backend 검증은 별도 판정 |
| `pnpm build` | passed | TypeScript 빌드 완료 |
| 기본 disabled CLI·Docker 접속 0회 | passed | 호출 횟수 단위 검사와 실제 CLI의 `SANDBOX_DISABLED`, probe 0개·종료 코드 1 |
| 로컬 이미지 준비 실패 거부 | passed | 존재하지 않는 전체 image ID로 실제 preflight가 `SANDBOX_METADATA_COMMAND_FAILED`, probe 0개·자동 pull 없음·종료 코드 1 |
| 실제 backend의 `boundary` | passed | 23개 필수 검사 모두 참, 종료 코드 0, workspace 양성 대조군 확인 |
| 실제 backend의 PID·메모리 한도 | passed | PID 생성 `EAGAIN`·종료 코드 0, 메모리 `oomKilled: true`·종료 코드 137 |
| 실제 backend의 시간·출력·하위 프로세스 종료 | passed | 각각 `timeout`·`output_limit`, child 시작 증거, 코드 137·OOM 아님, 3.25초 후 지연 marker 없음 |
| 실제 backend의 container 정리 | passed | 5개 모두 정지·제거 확인. 별도 label 필터 전체 목록에서도 잔존 0개 |
| 실제 backend의 보호 파일 전후 hash | passed | 아래 전체 해시 동일 |
| 수용 기준 33 | passed | 지정한 macOS arm64·Docker 29.4.3·고정 이미지와 정책의 실제 probe 결과 |
| 승인 소비·Run·patch·대상 설치·검사·빌드 | not_run | 단계 3-C 이후 범위 |
| 실제 Slack·AI·회사 저장소·외부 전송 | not_run | 별도 승인·자료 정책·환경 검증이 필요한 범위 밖 기능 |

최종 실제 검증 ID는 `dcd97e27-2503-4465-ba73-5dd0b764ce75`다. 보고서와 합성 작업물은 이 개발 환경의 `/private/tmp/harness-stage3b-XamURv/data/sandbox-checks/dcd97e27-2503-4465-ba73-5dd0b764ce75/`에 보존했다. 보호 파일 전체의 `beforeHash`와 `afterHash`는 모두 `5eb486932d20007f11141ff8362725032fb8474ac9a6c5fd9f3b66c29b19c454`다. 이미지 준비 실패 검증 ID는 `5362da88-6efe-40e8-b127-e78bb1f285d7`, disabled 검증 ID는 `d1d7349f-7289-4ec8-b7b6-0f0dab3b8b71`이다. 임시 경로의 증거는 이 로컬 환경에 한정되며 Git에 포함하지 않았다.

## 한계와 다음 최소 작업

- Docker daemon·Desktop VM·Linux 커널과 로컬 OS 사용자를 신뢰한다. 같은 계정의 제어 경로 변조와 container escape를 완전히 방어한다고 주장하지 않는다.
- 고정 합성 코드만 검증한다. 범용 실행기와 실제 대상 코드의 요구 자원·명령·설치·네트워크·디스크 quota는 후속 정책이 필요하다.
- mock 단위·회귀 검사 통과는 수용 33의 실제 backend 실증이나 회사 보안 검토를 대신하지 않는다. 새 환경·이미지·정책을 쓰면 해당 환경에서 다시 검증해야 한다.
- 승인·취소의 기존 전역 lease 한계와 실시간 수신 중단 구간의 변경 감지 한계는 남아 있다. 진단의 container 종료 검증을 대상 작업의 취소·crash 복구 구현으로 확대하지 않는다.
- 다음 최소 작업은 단계 3-C의 고정 합성 patch 계약·등록 명령 사양·새 실행 승인과 원자적 1회 소비를 연결하는 것이다. 단계 3-A의 기록 전용 승인은 재사용하지 않는다.

정책과 공식 근거는 [보안과 승인](security-and-approval.md#단계-3-b의-합성-docker-진단), 전체 후속 순서는 [단계 3 계획](implementation-plan.md#단계-3-승인-후-코드-변경)을 따른다.
