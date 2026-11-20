# 구현·검증 이력

이 폴더는 각 단계에서 구현한 범위, 실제로 실행한 검사와 실패, 당시 승인과 보관 조건을 보존한다. 문서의 ‘현재’·‘다음 작업’·승인 대기 표현은 작성 시점의 기록이며 오늘의 작업 지시나 새 접근·실행 권한이 아니다. 과거 검사 통과를 현재 장비·설정·회사 정책의 검증으로 대신하지 않는다.

현재 사용법은 [루트 README](../../README.md), 권한 조건은 [보안과 승인](../security-and-approval.md), 전체 구성은 [구조와 흐름](../architecture.md)을 따른다. 기술 설계는 [Git 선택 읽기](../design/company-git-range-reader-design.md)와 [읽기 단위 검사](../design/company-git-range-read-unit-design.md)에서 확인한다.

## Slack 본인 멘션 자동 분석

[멘션·스레드 분석과 현재 Codex 호환성 결과](slack-mention-analysis-result.md)는 수신·분석 연결, private 설정 준비와 native 합성 검증을 기록한다. **실제 Slack 멘션을 받아 실제 인증·모델로 자동 분석한 검증은 `not_run`이다.** 다른 단계의 실제 단건 호출 기록이나 합성 검사 통과로 이 상태를 바꾸지 않는다.

## 로컬 조사·Slack 수신·승인·합성 실행

| 단계 | 기록 |
| --- | --- |
| 1 | [합성 자료의 읽기 전용 조사와 로컬 보고](stage-1-result.md) |
| 2 | [Slack 수신과 오프라인 수집 검증](stage-2-result.md) |
| 3-A | [로컬 소유자 승인·취소 기록](stage-3a-result.md) |
| 3-B | [Docker 격리 진단](stage-3b-result.md) |
| 3-C | [독립 합성 저장소의 실행](stage-3c-result.md) |
| 3-D | [합성 실행 취소·중단 복구](stage-3d-result.md) |
| 4-A | [답장 계획·별도 승인·모의 전송](stage-4a-result.md) |
| 4-B-1 | [오프라인 Slack HTTP 계약 진단](stage-4b1-result.md) |
| 4-B-2 | [고정 시험 문구의 승인된 단건 전송](stage-4b2-result.md) |
| 4-C-1 | [오프라인 브랜치 계획·승인·모의 결과](stage-4c1-result.md) |
| 4-C-2 | [독립 합성 Git 브랜치 생성](stage-4c2-result.md) |
| 4-C-3 | [합성 브랜치의 고정 수정·Docker 검사](stage-4c3-result.md) |

## Codex 조사·relay·개인 저장소 검증

| 단계 | 기록 |
| --- | --- |
| 4-C-4 | [고정 합성 입력의 Codex 제안과 별도 실행 승인](stage-4c4-result.md) |
| 4-C-5 | [합성 다중 파일의 고정 응답 조사](stage-4c5-result.md) |
| 4-C-6 | [가짜 전송기로 모델 연결 준비](stage-4c6-result.md) |
| 4-C-7 | [인증 없는 HTTP·JSON/SSE 계약 검증](stage-4c7-result.md) |
| 4-C-8 | [초기 실제 모델 조사와 v1~v9 실패·진단 이력](stage-4c8-result.md) |
| 4-C-9 | [로그인 유지 relay와 응답 예산 검증](stage-4c9-result.md) |
| 4-C-10 | [개인 시험 저장소의 읽기 전용 조사 준비](stage-4c10-result.md) |
| 4-C-11 | [개인 자료의 수집 한도와 안전 view](stage-4c11-result.md) |
| 4-C-12 | [시간·프레임 실행 예산과 승인된 단건 검증](stage-4c12-result.md) |
| 4-C-13 | [조사 보고서의 정확성과 누락 범위 검토](stage-4c13-result.md) |

4-C-8은 여러 버전의 준비·실패·진단을 누적한 기록이다. 이후 relay 경로의 성공을 기존 계약의 실패나 미완료 수용 기준에 소급 적용하지 않는다. 각 실제 호출은 해당 입력·버전·단건 승인 범위의 근거다.

## 회사 환경 준비와 Git 판독기

| 단계 | 기록 |
| --- | --- |
| 4-C-14 | [회사 환경 이전용 오프라인 점검](stage-4c14-result.md) |
| 4-C-15 | [회사 읽기 준비의 합성 검증](stage-4c15-result.md) |
| 4-C-16 | [검토용 사본 실험과 당시 설계](stage-4c16-result.md) — 사본 생성기 개발은 중단 |
| 4-C-17 codec | [메모리 기반 Git 검증과 공통 예산](stage-4c17-codec-result.md) |
| 4-C-17 reader | [합성 저장소의 Git 구간 읽기](stage-4c17-reader-result.md) |
| 4-C-17 integration | [회사 준비 v2 통합](stage-4c17-integration-result.md) |
| 4-C-17 diagnostic | [자원 실패 진단 보완](stage-4c17-diagnostic-result.md) |
| 4-C-17 guard | [반복 경로 검사 대체 후보의 반례](stage-4c17-guard-result.md) |
| 4-C-17 read-unit design | [읽기 단위 검사와 별도 실행 방식 비교](stage-4c17-read-unit-design-result.md) |
| 4-C-17 read-unit | [새 읽기 단위 계약의 합성 구현](stage-4c17-read-unit-result.md) |
| 4-C-17 company-v3 | [회사 준비 v3 연결](stage-4c17-company-v3-result.md) |
| 4-C-17 tree-traversal | [공통 Git tree 경로 순회 개선](stage-4c17-tree-traversal-result.md) |

## 회사 조사·개별 적용·자료 정리

| 단계 | 기록 |
| --- | --- |
| 4-C-18 | [회사 모의 조사·승인·보고서 연결](stage-4c18-result.md) |
| 4-C-19 | [회사 전송 계약·로컬 검토 연결](stage-4c19-result.md) |
| 4-C-20 | [인증 반사 검사의 합성 재현·진단](stage-4c20-result.md) |
| 4-C-21 | [회사 준비 v3 worker 오류 진단](stage-4c21-result.md) |
| 4-C-22 | [선택 범위 합성 재현과 소스 거부 분기](stage-4c22-result.md) |
| 4-C-23 | [Git 객체 조회 대조와 복구 조건](stage-4c23-result.md) |
| 4-C-24 | [승인된 단일 Git 객체 복구](stage-4c24-result.md) |
| 4-C-25 | [호출부·검사 범위 검토와 합성 격리 진단](stage-4c25-result.md) |
| 4-C-26 | [승인된 개별 구현·격리 검사·원본 적용](stage-4c26-result.md) |
| 4-C-27 | [실제 브라우저에서 합성 자료로 기능 검증](stage-4c27-result.md) |
| 4-C-28 | [적용 파일 최종 검토·제품 확인·로컬 커밋 인계](stage-4c28-result.md) |
| 4-C-29 | [만료 자료 정리와 본문 조회 없는 prune](stage-4c29-result.md) |

이 묶음의 회사 자료 접근과 개별 적용 기록은 당시 구체적으로 허용된 작업의 결과다. 일반적인 자동 수정·제품 검사·외부 전송 권한으로 확대하지 않는다.

## 회사 파일 적용 기능

| 단계 | 기록 |
| --- | --- |
| 4-C-30 | [수정안의 로컬 계획·검토·승인 기록](stage-4c30-result.md) |
| 4-C-31 | [합성 원본의 새 브랜치·다중 파일 적용 엔진](stage-4c31-result.md) |
| 4-C-32 | [합성 적용 CLI와 중단 복구](stage-4c32-result.md) |
| 4-C-33 | [회사 쓰기 등록·OS 격리 적용의 합성 검증](stage-4c33-result.md) |
| 4-C-34 | [원본 회사 레포의 승인된 파일 적용 CLI](stage-4c34-result.md) |

4-C-34의 CLI 구현·합성 검증과 실제 회사 업무 적용은 구분한다. 실행할 때는 현재 등록·변경 계획에 결합한 별도 승인이 필요하다.
