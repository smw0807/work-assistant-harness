# 문서 안내

처음 실행한다면 루트 [README](../README.md)에서 설치와 Slack 멘션 분석을 시작합니다. 이 폴더는 사용 가이드, 개발 기준, 상세 설계, 과거 검증 기록으로 나뉩니다.

## 사용 가이드

| 하려는 작업 | 읽을 문서 | 범위 |
| --- | --- | --- |
| 본인 멘션과 스레드 분석 | [Slack](guides/slack.md) | 앱 권한, env·Codex JSON, 수신·조회·보관 |
| 모의 실행과 로컬 데이터 확인 | [로컬 실행·데이터](guides/local-runtime.md) | fixture, DB·보고서, 재시작, 개발 검증 |
| 회사 저장소를 조사하거나 파일 적용 | [회사 작업](guides/company-workflows.md) | 읽기 준비, 모델 전송, 검토 기록과 별도 적용 승인 |
| 모델 연결·개인 저장소 조사 | [모델 relay](guides/model-relay.md) | 기존 계약별 호출·수집·예산·승인 |
| 합성 자료로 승인·실행 흐름 검증 | [합성 작업](guides/synthetic-workflows.md) | 로컬 승인, Docker, 답장·브랜치·파일 적용 시험 |
| 회사 장비의 오프라인 점검 준비 | [회사 반입 인계](company-offline-handoff.md) | 미확인 회사 정책, 반입·보관·접근 범위 |
| 설치된 환경의 정적 이전 점검 | [이전 점검](migration-guide.md) | `migration-check`와 결과 해석 |

Slack 자동 분석과 회사 저장소 작업은 서로 다른 경로입니다. Slack 분석 설정을 켜도 회사 레포 조사·수정·답장이 연결되지는 않습니다. 회사 경로는 해당 가이드의 private 등록 JSON과 별도 계획·승인을 사용합니다.

## 개발 기준과 상세 설계

[AGENTS.md](../AGENTS.md)가 지정한 네 문서는 기존 경로를 유지합니다.

| 문서 | 역할 |
| --- | --- |
| [구조와 흐름](architecture.md) | 구성 요소, 데이터 흐름, 구현 경계 |
| [코딩 컨벤션](coding-conventions.md) | 하네스 코드의 이름·책임·주석 기준 |
| [보안과 승인](security-and-approval.md) | 행위별 승인, 자료 접근, 전송, 실행과 복구 조건 |
| [구현 계획](implementation-plan.md) | 단계별 설계와 상세 수용 기준. 현재 사용법은 위 가이드를 참조 |
| [Git 선택 읽기 설계](design/company-git-range-reader-design.md) | 제한된 Git 구간 읽기의 설계·지원 범위 |
| [Git 읽기 단위 설계](design/company-git-range-read-unit-design.md) | 원본 읽기 단위와 검증 계약 |

문서 정리는 기존 계약·한도·승인을 변경하지 않습니다. 명령의 실제 인자는 `pnpm harness --help`와 각 가이드에서 확인합니다. 계획서의 제안이나 이력의 실행 예시를 새 실행 권한으로 해석하지 않습니다.

## 검증 결과와 과거 기록

- [Slack 분석 연결 결과](history/slack-mention-analysis-result.md): 현재 버전의 합성 검증과 실제 서비스 미실행 범위.
- [단계별 개발 이력](history/README.md): 각 시점의 구현·실패·승인·검증 근거.

`history/`의 결과는 작성 당시의 상태입니다. 과거 테스트 수치를 현재 회귀 결과로 사용하거나, 과거 호출의 승인을 재사용하지 않습니다. 중단한 Git 사본 설계도 [당시 결과](history/stage-4c16-result.md#당시-사본-설계)에 통합해 보존합니다.

실제 env·인증정보·회사 자료·원본 로그는 문서와 Git에 넣지 않습니다. 비공개 설정과 결과 위치는 실행 환경에서 별도로 관리합니다.
