# 단계 4-C-27: 실제 브라우저의 합성 기능 검증

2026-11-20. 앞서 적용한 기능을 실제 Chromium과 기존 pager로 검증했다. 합성 데이터·가짜 완료 API를 사용한 최종 검사25개가 통과했다. 회사 코드의 추가 수정은 없으며, 적용했던7파일의 hash와 작업 브랜치가 보존됨을 다시 확인했다. commit·push는 수행하지 않았다.

## 입력과 실행 범위

기존 v3 계약으로 변경되지 않은 관련 파일의 새 읽기 준비를 수행했다. 이미 승인·적용된 소스4파일은 현재 작업 파일을 제한적으로 다시 읽고 적용 당시 hash 및 민감정보 검사와 대조했다. 이 읽기를 clean Git 준비로 표현하지 않는다. 이전에 만료된 회사 본문을 재사용하지 않았다.

소스5파일은 공개 compiler로 정적으로 변환했다. 호스트에서는 제품 setup이나 저장소 스크립트를 실행하지 않았다. 브라우저에는 이 변환 결과, 로컬 Vue runtime, 합성 서비스·이미지·주변 UI와 별도 스타일만 제공했다. 회사 레포 전체, Git, 환경 설정, 실제 인증정보와 사용자 브라우저 프로필은 연결하지 않았다.

공식 Playwright 이미지 한 개의 반입을 별도 승인받고 ARM64 manifest digest와 로컬 이미지 identity를 고정했다. 실제 확인한 런타임은 Chromium156.0.8078.80·Node26.13.0·Docker Engine28.3.3이다. 회사 자료를 다운로드 요청에 포함하지 않았으며, 추가 패키지 설치나 pnpm 버전 전환은 없었다. 이미지 출처와 일반적인 컨테이너 사용 조건은 [공식 Docker 안내](https://playwright.dev/docs/docker)를 참조했다.

## 별도 승인한 브라우저 환경

기존 하네스의 합성 실행 계약과 ExecutionPort는 변경하지 않았다. 사용자는 브라우저 전용 메모리512MiB·PID128·CPU1·attach60초·임시공간256MiB·출력16KiB를 먼저 허용했다. 실제 차단 근거를 제시한 뒤 아래 항목도 각각 확인했다.

- namespace용 `clone/setns/unshare`, 이어서 Chromium sandbox에 필요한 `chroot` 호출.
- 프로세스당 파일 핸들128→1,024개.
- cgroup의 PID 제한 도달을 확인한 뒤 PID128→256개. CPU 사용 범위는 추가로 한 CPU에 한정했다.
- PNG 단건 검사에만 파일당4MiB→16MiB. 이 예외는 해당 합성 입력 hash에 결합했다.

기본 seccomp 규칙31개를 보존한 후보에 허용 규칙만 추가하고 hash를 고정했다. 기반은 [Moby28.3.3 기본 설정](https://raw.githubusercontent.com/moby/moby/v28.3.3/profiles/seccomp/default.json)과 [Playwright의 namespace 설정](https://raw.githubusercontent.com/microsoft/playwright/v1.64.1/utils/docker/seccomp_profile.json)이다. `chroot`는 [Chromium sandbox 구현](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/sandbox/linux/services/credentials.cc)의 파일시스템 접근 제한 경로와 실제 실패 기록을 대조했다.

network none·nonroot·root/입력 읽기 전용·capability 전부 제거·권한 상승 금지·private cgroup·IPC none을 유지했다. Chromium sandbox 비활성화, host IPC, 관리자 capability 추가는 하지 않았다. 서비스는 컨테이너 내부 loopback에서 고정 파일만 제공하며 실제 API는 메모리 가짜 함수다. 호스트 controller는 신뢰 영역이며 이를 OS 읽기·쓰기 격리로 주장하지 않는다.

controller는 승인·입력·이미지·환경·mount·한도를 시작 전에 대조한다. attach 기한/출력 초과 때 검증한 container ID에 KILL을 요청하고 종료·제거를 재확인한다. 60초는 attach 호출 기한이며 별도 정리 시간이 있다. controller 자체의 강제 종료까지 견디는 독립 guardian은 아니다.

## 최종 결과

| 범위 | 결과 |
| --- | --- |
| 합성 브라우저 기동·격리 검사 | passed |
| 첫 호출부의 기본 동작 | passed — 8개 |
| 두 번째 호출부의 기본 동작 | passed — 8개 |
| 첫 호출부의 실제 탭 전환·RTL·합성 화면 | passed — 4개 |
| 두 번째 호출부의 실제 탭 전환·RTL·합성 화면 | passed — 3개 |
| 독립 PNG 표시·완료 검사 | passed — 2개 |
| 최종 브라우저 검사 합계 | passed — 25개, 중복 재실행 제외 |
| 제품 보존 | passed — 적용7파일 hash·작업 브랜치 보존, 추가 쓰기0 |
| 생성한 컨테이너 정리 | passed — 시도23건의 완료 기록에서 종료·제거 확인 |
| 전체 제품 lint/typecheck/build·실제 API | not_run |
| 실제 인증·native Codex·모델 호출·외부 회사 자료 전송 | not_run |

브라우저의 실제 시간·IntersectionObserver·신뢰된 visibilitychange를 사용했다. 노출 중단과 복귀 후 남은 시간의 하한·상한, 콘텐츠 교체, 중복, 빈/단일 콘텐츠와 종료를 확인했다. 관측 기록은 사례·관측 세대·이벤트 시각을 구분하며 초과를 성공으로 취급하지 않는다. RTL에서는 이미지 로드·가시 영역을 확인하고 합성 화면 캡처를 직접 검토했다.

실패16건도 보존했다. 여기에는 실행 전 로컬 기록 권한/inspect 표현 검증 실패, 진단 파이프 처리 실패, sandbox·파일 핸들·PID 제한과 attach timeout, 파일 크기 제한에 의한 브라우저 종료가 포함된다. 실패를 성공으로 바꾸거나 동일 검사를 여러 번 합산하지 않았다. 한 초기 합성 화면은 RTL 중앙 정렬 스타일이 빠져 있어 테스트용 스타일과 이미지 가시성 판정을 보완했다. 제품 스타일을 수정한 것이 아니다.

PNG 검사는 작은 화면에서도 `SIGXFSZ`로 종료됐다. 정확한 임시 파일은 특정하지 못했다. 별도 승인한 파일당16MiB의 단건 검사에서 통과했으며, 전체 임시공간256MiB와 다른 제한은 유지했다. 최종 추가 검사들의 메모리·PID 제한 도달/OOM은 관찰되지 않았다. 앞선 별도 시도의 메모리 회수 압력 기록은 그대로 남겼다.

## 보관과 남은 범위

비공개 자료는 `/private/tmp/harness-company-browser-check-c9ikpqmz`에 있다. 원문·변환 결과·상세 실행 기록의 가장 이른 만료는2026-11-20 02:02:19.170Z이며, 요약·감사 기록은2026-11-21 01:02:19.170Z까지다. 명시적 정리/prune가 필요하며 백그라운드 삭제를 보장하지 않는다. 적용된 제품 파일·브랜치는 임시 자료 정리 대상이 아니다.

이번 결과는 제한된 합성 환경에서의 실제 브라우저 검증이다. 주변 UI·스타일은 합성이므로 전체 제품 테마의 시각적 동일성, 실제 완료 API 연동이나 회사 보안 검토 통과를 뜻하지 않는다. 다음 최소 작업은 현재 브랜치의 변경 검토와, 기존 업무 환경에서 전체 제품 화면·실제 API를 사용할 수 있는 범위의 최종 확인이다. 별도 요청 전 commit·push는 하지 않는다.
