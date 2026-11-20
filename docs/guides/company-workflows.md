# 회사 저장소의 준비·조사·파일 적용

회사 장비 점검부터 선택 파일 준비, 모의 조사, 별도 모델 전송과 승인된 원본 파일 적용까지의 상세 안내입니다. 회사 경로는 환경변수가 아닌 비공개 등록 JSON으로 지정합니다.

회사 정책과 각 명령의 승인 범위는 구분합니다. 읽기 준비·검토 전용 승인·모델 전송·파일 적용은 서로 다른 계약이며 자동으로 다음 권한을 만들지 않습니다. `company-apply-*`의 파일 적용 완료도 제품 검사나 Git 원격 작업의 완료를 뜻하지 않습니다.

[문서 목록](../README.md) · [보안과 승인](../security-and-approval.md)

- [회사 환경 이전용 오프라인 점검](#회사-환경-이전용-오프라인-점검)
- [회사 저장소의 오프라인 읽기 전용 준비](#회사-저장소의-오프라인-읽기-전용-준비)
- [원본 회사 레포의 승인된 파일 적용](#원본-회사-레포의-승인된-파일-적용)

## 회사 환경 이전용 오프라인 점검

`pnpm harness migration-check --config /absolute/path/to/private-migration/migration-check.json`으로 실행 환경과 기존 계약의 정적 준비 상태를 확인합니다. [설정 템플릿](../../config/migration-check.example.json)과 [실행 가이드](../migration-guide.md)에 경로·권한·설치 준비 및 결과 해석을 설명합니다.

native Codex 실행 파일을 지정하지 않을 때는 [부분 진단 템플릿](../../config/migration-check.partial.example.json)을 새 비공개 위치의 `migration-check.json`으로 복사하고 `runtimeDirectory`만 지정한 뒤 같은 명령을 사용합니다. 별도 입력 `offline-migration-partial-check-v1`은 `enabled:false`와 런타임 경로만 받습니다. 정상 시 7개 확인 항목은 `passed`, native·sandbox 파일 검사와 범위 밖 8개는 `not_run`입니다. `scope:partial`과 `partialStatus:passed`여도 전체 `status:blocked` 및 종료 코드 1을 유지하며, `remainingChecks`와 `nextActions`에 남은 정적 점검을 표시합니다. native·sandbox 파일 경로를 조회하지 않고 기존 전체 진단 입력의 필수 필드를 생략하는 방식으로 전환하지 않습니다.

회사 장비의 새 대화에서 이어갈 때는 [오프라인 검증 인수인계](../company-offline-handoff.md)를 사용합니다. 현재 구현·개인 검증 상태, 회사에서 확인할 조건, 실행 범위와 순서, 짧은 시작 문구를 포함합니다.

이 명령의 전체 진단은 명시한 비활성 진단 설정과 고정 native 파일만 제한적으로 읽고, 저장 디렉터리와 `sandbox-exec`는 메타데이터만 확인합니다. 회사 저장소 등록·인증 접근·네트워크·바이너리 실행·DB 생성은 하지 않습니다. 진단 자체는 파일을 쓰지 않으며 `pnpm harness`의 선행 TypeScript 빌드는 `dist`를 씁니다. 현재 지원은 macOS ARM64이고, pnpm 버전 관찰은 실행기가 제공한 미검증 메타데이터입니다. `passed`여도 `liveReady=false`·`executionAllowed=false`·`approvalCreated=false`이며 회사 승인이나 실제 호출 권한이 되지 않습니다. 전체 진단의 초기 구현·검증 기록은 [4-C-14 결과](../history/stage-4c14-result.md)를 따릅니다.

## 회사 저장소의 오프라인 읽기 전용 준비

`company-readonly-*`는 회사 정책에 따라 선택한 파일의 로컬 검토 자료를 준비하는 별도 경로입니다. v1의 검증 기록은 합성 저장소 기준이며, 실제 회사 자료를 읽기 전 회사의 읽기·보관 허용 범위를 확인해야 합니다. 기존 개인용 승인이나 오프라인 장비 진단 통과로 이를 대신하지 않습니다. 검증 집계와 남은 범위는 [4-C-15 결과](../history/stage-4c15-result.md)를 따릅니다.

큰 Git pack의 제한에 대응한 사본 실험은 [4-C-16 기록](../history/stage-4c16-result.md)에 보존합니다. 사본 생성 기능은 구현하지 않았으며 원본 레포를 직접 조사하는 [회사 Git 선택 읽기 설계](../design/company-git-range-reader-design.md)와 별도 회사 준비 v2/v3를 사용합니다. 기존 v1 명령과 한도는 유지하고 실패 시 자동 전환하지 않습니다.

[정책 예제](../../config/company-readonly-policy.example.json)는 `unconfirmed`와 미정 보관 기간으로 차단된 상태입니다. 정책 파일을 저장소 밖의 소유자 전용 `0700` 디렉터리에 `company-readonly-policy.json`이라는 이름의 `0600` 파일로 준비합니다. 회사의 실제 결정에 맞춰 읽기·보관 확인, 비밀값 없는 정책 참조 식별자, 본문 보관 시간(1~24시간)·감사 보관 기간(1~30일)을 기록합니다. `enabled:false`는 계속 유지하며 실제 전송을 활성화하는 옵션이 아닙니다. 이 설정은 운영자가 확인한 정책의 선언이며 하네스가 회사 승인을 인증했다는 뜻은 아닙니다. 미확인 조건은 등록 파일이나 대상 경로를 읽기 전에 거부합니다.

[등록 예제](../../config/company-readonly-registration.example.json)는 `company-readonly-registration.json`이라는 별도 `0600` 파일로 준비합니다. 저장소 하나의 절대 경로·기준 commit·질문·읽을 파일/줄과 로컬 검토에 포함할 `reviewPaths`를 명시합니다. 실제 회사 경로·코드·정책 참조를 Git에 넣지 않습니다. 데이터 디렉터리는 하네스·대상과 겹치지 않는 전용 위치이고 그 부모도 소유자 전용 `0700`이어야 합니다. 설정·대상·보관 경로는 정규화된 POSIX 절대 경로이며 현재 경로 구성에는 영문·숫자·공백·`_-.`만 허용하고 인증/비밀 경로와 링크는 거부합니다.

```sh
pnpm harness company-readonly-plan --policy /private/review/company-readonly-policy.json --registration /private/review/company-readonly-registration.json --data-dir /private/review/company-runtime
pnpm harness company-readonly-inspect --task <uuid> --data-dir /private/review/company-runtime
pnpm harness company-readonly-cancel --task <uuid> --data-dir /private/review/company-runtime
pnpm harness company-readonly-prune --data-dir /private/review/company-runtime
pnpm test:company
```

준비는 기존 수집 v2의 Git·경로·민감정보 검사와 원본64KiB/안전 view64KiB/발췌32KiB·8파일/16범위·범위당200줄·근거64KiB/입력128KiB 한도를 재사용합니다. 회사 출처와 새 준비 hash를 별도로 기록하며 기존 개인·relay·실행 예산 계약을 변경하지 않습니다. 원문 전체·비밀 매치는 저장하지 않고 선택한 안전 근거와 원본/view hash를 비공개 `company-readonly.sqlite`에 보관합니다. CLI는 내용·경로 없이 상태·식별자·hash·보관 기한만 출력합니다.

준비 결과는 `AWAITING_APPROVAL`이며 승인 생성·전송·실행 권한은 모두 `false`입니다. 이 읽기 준비 명령군에는 `approve`·`run`이 없습니다. 이 로컬 자료는 모델·목적지·실제 전송 본문이 확정된 실행 승인 계획이 아니므로 후속 전송에 그대로 사용할 수 없습니다. 같은 등록·정책·원본·검토 내용의 재준비는 기존 기록을 반환하며 취소·만료를 되돌리지 않습니다. 취소 시 본문을 제거하고 보관 기한에 따라 inspect/prune 등에서 만료 본문·감사 기록을 정리합니다. 실행 중인 보관 스케줄러나 디스크의 물리적 완전 삭제를 보장하지 않습니다.

수집은 인증 환경을 물려받지 않는 Node 권한 worker에서 수행하고 대상 쓰기·추가 프로세스·네트워크를 허용하지 않습니다. 기존 수집기의 모든 부모 경로 재검증을 유지하기 위해 worker의 파일 읽기 권한은 전체로 열고, 실제 읽을 파일과 크기는 수집기 코드로 제한합니다. 따라서 파일 읽기의 OS 격리나 악성 코드 실행 격리를 제공하지 않습니다. 대상 설치·테스트·빌드·스크립트·Git 명령, native Codex, 실제 인증·모델과 Slack 연결은 이 경로에 포함되지 않습니다.

### 구간 판독기를 사용하는 회사 준비 v2

v2는 아래 별도 명령과 [새 등록 예제](../../config/company-readonly-registration-v2.example.json)를 사용합니다. 등록 파일 이름은 `company-readonly-registration-v2.json`, `version`은 `company-readonly-registration-v2`이며 `gitProfileHash`가 현재 고정 Git profile hash와 정확히 일치해야 합니다. 나머지는 `repoId`, `sourceRoot`, `baseCommit`, `question`, `readRanges`, `reviewPaths`입니다. 기존 정책 파일의 읽기·보관 선언, 기간과 `enabled:false`는 그대로 사용합니다. 미확인 정책은 등록 파일·대상 metadata보다 먼저 차단하며, 이미 확인한 사항을 반복 승인받지 않습니다. 실제 적용 전에는 선택 파일과 그 복원에 필요한 비선택·과거 delta base 접근이 기존 허용 범위에 포함되는지 추가·미확인 범위만 대조합니다.

```sh
pnpm harness company-readonly-v2-plan --policy /private/review/company-readonly-policy.json --registration /private/review/company-readonly-registration-v2.json --data-dir /private/review/company-runtime-v2
pnpm harness company-readonly-v2-inspect --task <uuid> --data-dir /private/review/company-runtime-v2
pnpm harness company-readonly-v2-cancel --task <uuid> --data-dir /private/review/company-runtime-v2
pnpm harness company-readonly-v2-prune --data-dir /private/review/company-runtime-v2
```

자원 한도 실패의 세부 계수가 필요하면 `plan`과 `prune`에만 선택 옵션 `--diagnostics-dir /private/review/company-diagnostics-v2`를 추가합니다. 진단 위치와 부모는 `0700`이어야 하며 하네스·원본·설정·runtime과 겹치면 거부합니다. 부모 프로세스가 별도 `diagnostic-<uuid>.json`을 `0600`으로 한 번 저장합니다. 원문·원본 경로·객체 ID·임의 오류 문자열은 포함하지 않고, 최초 한도 실패의 단계·한도명·현재 사용량·거절된 요청량·상한·정리 전 계수를 기록합니다. `current + requested > maximum`은 요청을 수행하기 전에 거절했다는 뜻이며, timeout은 경과 시간을 기록합니다.

진단은 기존 `auditExpiresAt`을 따르며, 같은 옵션을 준 `plan` 시작 또는 `prune`에서 만료 기록을 삭제합니다. 별도 타이머가 자동 삭제하지는 않습니다. 기존 stdout·계획/payload·DB·시작/결과 기록 형식과 한도/hash는 유지합니다. 진단 저장 실패는 `unknown`이며 같은 ID의 `inspect`로 저장 상태를 확인합니다. 강제 종료·일반 오류·손상된 진단은 `failure:null`일 수 있으므로 원인을 추정하지 않습니다. 진단은 승인이나 재시도를 만들지 않으며 과거 실패의 상세 계수를 복원하지 않습니다. 합성 검사와 남은 한계는 [진단 보완 결과](../history/stage-4c17-diagnostic-result.md)를 따릅니다.

설정 파일은 소유자 전용 `0600`, 설정의 부모·runtime과 그 부모는 `0700`이어야 합니다. runtime은 하네스·원본·설정·v1 보관 위치와 분리합니다. v2는 `store/company-readonly-v2.sqlite`에 안전 발췌·검증 metadata를, `runs/`에 본문 없는 시작·결과 기록을 둡니다. 두 하위 디렉터리는 `0700`, 파일은 `0600`이며 worker의 쓰기 권한은 `store/`에만 부여합니다. 시작 기록도 runtime 위치 hash에 결합하므로 DB 생성 전 실패한 기록을 이동·복사한 경우에도 조작을 거부합니다. 대상 원문·전체 안전 view·commit/tree/base 본문은 디스크에 보관하지 않습니다. 같은 공유 예산 안에서 두 번 읽으며 첫 읽기의 선택 원문은 내부 메모리에서만 안전 발췌로 변환한 후 해제합니다. 최종 읽기는 원문 hash와 안전 view를 다시 비교하며 추가 collect 읽기는 없습니다. `AWAITING_APPROVAL`, 승인 생성·전송·실행 false와 기존 수집 한도는 유지합니다.

`plan`은 시작 전에 새 ID를 정하고 `runs/run-<uuid>.json` 및 디렉터리 항목을 fsync한 뒤 worker를 시작합니다. 결과는 별도 `result-<uuid>.json`에 한 번 기록하며 시작 기록을 덮어쓰지 않습니다. 저장 직후 응답 유실·timeout·부모 종료 등으로 결과를 확정하지 못하면 `unknown`입니다. 시작 기록만 있고 결과 기록이 없어도 같은 ID로 `inspect`해 저장된 상태·hash·기한 또는 부재를 확인합니다. 이 조회는 원래 worker의 종료 확인을 대신하지 않습니다. 자동 재시도는 없으며 새로 명시한 `plan`은 새 ID의 작업입니다. 취소·만료된 자료는 재사용으로 되살리지 않습니다.

부모 supervisor는 원래 시작 시각의 30초 기한에 `SIGTERM`, 250ms 뒤에도 종료되지 않으면 `SIGKILL`을 요청하고, child의 `close`를 관찰해야 `exitConfirmed:true`로 표시합니다. 유효 응답만으로 성공 처리하지 않습니다. 이 종료 정책은 부모 생존과 OS 신호 처리에 의존하며, 부모 자체의 강제 종료를 견디는 독립 guardian이나 고아 프로세스 방지를 제공하지 않습니다. worker에는 V8 old-space 128MiB를 설정하지만 관리 Buffer 32MiB 계수 및 RSS 256MiB 합성 측정 목표와는 다릅니다. RSS의 OS 강제 상한을 제공하지 않습니다. 읽기 권한은 부모 metadata 검증 때문에 전체로 열고 실제 읽기는 고정 판독기로 제한하므로 OS 읽기 격리로 설명하지 않습니다.

전체 pack checksum·미조회 객체는 계속 `not_checked`이고, 선택 객체 OID가 맞아도 작성자·서명·회사 출처를 인증하지 않습니다. v2 준비와 진단의 합성·실제 실행 이력은 [통합 결과](../history/stage-4c17-integration-result.md)와 [진단 결과](../history/stage-4c17-diagnostic-result.md)에서 구분합니다. 읽기 준비가 실제 인증·native·모델 연결의 성공을 뜻하지 않습니다.

### 읽기 단위 판독기를 사용하는 회사 준비 v3

`company-readonly-v3-*`는 [읽기 단위 판독기](../design/company-git-range-read-unit-design.md)를 등록·정책 확인·로컬 보관·제한 worker에 연결한 별도 명령입니다. [등록 예제](../../config/company-readonly-registration-v3.example.json)를 `company-readonly-registration-v3.json`이라는 소유자 전용 `0600` 파일로 준비합니다. `version: company-readonly-registration-v3`, 고정 `gitProfileHash`와 `guardPolicyHash`가 모두 일치해야 합니다. 기존 정책 파일의 읽기·보관 선언과 기간, `enabled:false`를 그대로 사용하며 이미 확인한 정책을 다시 승인받지 않습니다.

```sh
pnpm harness company-readonly-v3-plan --policy /private/review/company-readonly-policy.json --registration /private/review/company-readonly-registration-v3.json --data-dir /private/review/company-runtime-v3 --diagnostics-dir /private/review/company-diagnostics-v3
pnpm harness company-readonly-v3-inspect --task <uuid> --data-dir /private/review/company-runtime-v3
pnpm harness company-readonly-v3-cancel --task <uuid> --data-dir /private/review/company-runtime-v3
pnpm harness company-readonly-v3-prune --data-dir /private/review/company-runtime-v3 --diagnostics-dir /private/review/company-diagnostics-v3
```

진단 옵션은 `plan/prune`에서만 선택할 수 있습니다. 기존 v1/v2와 분리한 새 runtime·진단 위치를 사용하며 부모와 디렉터리는 `0700`, 파일은 `0600`이어야 합니다. 보관은 `store/company-readonly-v3.sqlite`, 시작/결과는 `runs/`, 진단은 별도 위치의 `diagnostic-v3-<uuid>.json`을 사용합니다. 구형 등록·DB·작업 기록·진단을 변환하거나 자동 선택하지 않습니다. stdout에는 내용·경로 없이 상태·식별자·hash와 보관 정보만 출력합니다. 결과가 불확실하면 `unknown`으로 남기고 같은 ID의 `inspect`로 확인하며 자동 재시도하지 않습니다.

진단을 켠 v3 준비는 일반 worker 실패의 허용된 고정 코드를 `workerFailureCode`로도 보관합니다. 새 코드가 있는 기록만 `company-readonly-v3-diagnostic-record-v2`를 사용하고, 기존 v1 기록의 형식과 hash는 유지합니다. 새 reader는 두 기록을 읽고 정리하지만 구버전 reader가 v2 기록을 읽는 호환은 제공하지 않습니다. 작업 ID가 맞는 단일 완결 프레임과 worker의 종료 코드 1을 확인한 경우에만 저장하며, timeout·출력 초과·강제 종료·스트림 오류는 코드로 원인을 덮어쓰지 않습니다. 원문·경로·stack은 저장하지 않고 미등록 오류는 고정 fallback으로 처리합니다. 과거 실패 원인을 복원하거나 자동 재시도하지 않습니다. [일반 오류 진단 결과](../history/stage-4c21-result.md)를 참고하세요.

`COMPANY_GIT_RANGE_INVALID_SOURCE`는 Git 객체뿐 아니라 안전 view와 발췌 거부도 포함하므로 코드만으로 원본 손상을 단정하지 않습니다. 판독기가 직접 발행한 해당 오류는 새 진단 record-v3의 `sourceFailureReason`으로 HEAD/ref·delta base·객체 조회/타입·tree 선택·원본 크기·safe view·excerpt·unexpected 중 고정 분기 하나를 구분합니다. 경로·OID·본문·행번호를 기록하지 않고 기존 오류 코드와 한도를 유지합니다. 기존 record-v1/v2는 그대로 읽고 정리하며, 새 record-v3는 최신 reader가 필요합니다. [소스 거부 분기 검증](../history/stage-4c22-result.md)을 참고하세요.

회사 준비 명령의 `v3`는 `company-git-range-reader-v2`를 선택하며, 위 회사 준비 `v2`는 계속 `company-git-range-reader-v1`을 사용합니다. 새 방식은 부모 경로를 열기·읽기 단위 경계·최종 pass에 검사하고 chunk마다 leaf/FD를 검사합니다. **단위 내부의 일시적 조상 변경 후 복원을 놓칠 수 있으며 구형과 동등한 검증은 아닙니다.** 이 차이는 별도 guard hash와 로컬 검토 자료에 포함됩니다. 수집·읽기·metadata·메모리·시간 한도는 높이지 않았습니다.

v3 준비 명령은 `AWAITING_APPROVAL`까지만 제공하며 승인 생성·전송·실행은 `false`입니다. 준비 명령 자체에는 `approve/run`이 없습니다. worker 권한, 30초·250ms 종료 정책, RSS 관찰 목표, 본문 최대24시간·감사 최대30일과 명시적 정리는 v2와 같습니다. [v3 통합 결과](../history/stage-4c17-company-v3-result.md)는 당시 합성 검증 기록이며, 이후 별도로 허용된 실제 준비에서 8파일·2pass·metadata7816/8192·같은 ID 조회와 검토 대기 저장을 확인했습니다. 이는 실제 AI 답변 생성 성공이 아닙니다.

현재 판독기는 선택 경로들의 공통 상위 Git tree를 각 pass에서 한 번 해석하고, 필요한 자식의 OID·mode만 남긴 뒤 본문을 해제합니다. 본문 캐시·서로 다른 경로의 OID 합치기·guard 생략·한도 상향은 없습니다. 동일 경로 깊이의 독립 합성 4-pack/8파일 사례에서 기존 구현은 metadata8192회에 중단됐고 개선 구현은7128회로 검토 자료 보관까지 완료했습니다. 더 깊은 경로는 여전히 한도에 걸릴 수 있으며 실제 회사 성공을 보증하지 않습니다. [공통 경로 순회 개선 결과](../history/stage-4c17-tree-traversal-result.md)를 따릅니다.

### 회사 준비를 사용하는 별도 모의 조사

`company-investigation-*`는 유효한 회사 준비 v3에서 **새 모의 조사 계획**을 만들고, 별도 승인 후 고정 응답 보고서를 로컬에 보관합니다. 실제 AI 연결은 없으며 `--mode mock`만 받습니다. 모델·목적지·인증 방식은 `company-fixed-response-v1`·`local:fixed-response`·`none`으로 고정됩니다. 기존 준비의 검토 대기 상태나 개인용 승인은 호출 승인이 아닙니다.

```sh
pnpm harness company-investigation-plan --mode mock --preparation-task <preparation-uuid> --preparation-data-dir /private/review/company-runtime-v3 --data-dir /private/review/company-investigation
# 새 계획의 taskId·planHash와 비공개 로컬 입력을 검토한 뒤 모의 실행만 승인
pnpm harness company-investigation-approve --mode mock --task <investigation-uuid> --plan-hash <sha256> --expires-in-minutes 10 --preparation-data-dir /private/review/company-runtime-v3 --data-dir /private/review/company-investigation
pnpm harness company-investigation-run --mode mock --task <investigation-uuid> --plan-hash <sha256> --preparation-data-dir /private/review/company-runtime-v3 --data-dir /private/review/company-investigation
pnpm harness company-investigation-inspect --task <investigation-uuid> --data-dir /private/review/company-investigation
pnpm harness company-investigation-cancel --task <investigation-uuid> --data-dir /private/review/company-investigation
pnpm harness company-investigation-recover --task <investigation-uuid> --data-dir /private/review/company-investigation
pnpm harness company-investigation-prune --data-dir /private/review/company-investigation
```

두 runtime은 서로, 하네스와 대상 저장소로부터 분리합니다. 새 runtime과 부모는 소유자 전용 `0700`이며 파일은 `0600`입니다. 질문·발췌·보고서 본문은 새 `store/company-investigation.sqlite`의 private payload에만 보관하며 stdout에는 상태·hash·기한·승인/시도/호출 예약 집계만 표시합니다. `inspect`는 `reportAvailable`을 제공하고 본문을 출력하지 않습니다. 이 단계에는 보고서 파일 export나 검토 UI가 없으며 비공개 DB의 입력/보고서 열람이 필요합니다.

계획·승인·호출 직전·완료 시 기존 준비의 취소/만료 여부와 source를 다시 확인합니다. 각 재검증은 기존 v3 판독기의 새 2pass/동일 한도를 사용합니다. 같은 준비를 다시 계획해도 기존 상태를 반환하고, 승인 소비/dispatch는 한 번뿐이며 자동 재시도하지 않습니다. source 변경, 잘못된 JSON, 미제공 근거, 취소/만료 이후 결과는 성공 보고서가 되지 않습니다. 중단 불확정은 `recover`로 `BLOCKED` 처리하며 소비를 복원하지 않습니다.

payload·보고서·감사의 만료는 원래 준비 시각을 상속합니다. 모의 승인 TTL은1~60분이지만 원래 본문 만료를 넘지 않습니다. 취소/실패/만료는 본문을 제거하며 `prune` 등 명령 실행 시 정리합니다. DB 사전검사와 실행 worker 모두 최소 환경/old-space128MiB/네트워크·추가 프로세스 금지를 적용합니다. 전체 작업 기한은 사전검사를 포함해 run125초, 나머지30초이며 OS RSS 상한·독립 guardian은 아닙니다. 기존 reader의 일시적 경로 변경 관찰 한계도 유지합니다.

원래 준비를 취소하면 이후 조사 계획·승인·호출이 차단됩니다. 이미 별도 조사 DB에 보관한 입력/보고서까지 즉시 제거하려면 해당 조사에도 `company-investigation-cancel`을 호출합니다. 두 DB 사이의 자동 연쇄 삭제는 제공하지 않습니다.

`REPORTED`는 **고정 응답의 형식·근거 검증과 보관 성공**입니다. 보고서의 실제 모델·인증·native·외부 전송은 모두 `not_run`, 의미 정확성은 미검증입니다. 이 모의 명령에는 실제 모델 전송을 연결하지 않습니다. 별도 전송 계약은 다음 절을 따릅니다. 구현·합성 검증과 남은 범위는 [4-C-18 결과](../history/stage-4c18-result.md)를 따릅니다.

### 회사 전송 계획과 비공개 로컬 검토

`company-relay-*`는 별도 전송 계획·승인·DB를 사용합니다. 기존 모의 승인을 승격하지 않습니다. 이 경로의 초기 검증은 합성 자료로 수행했으며 실제 회사 자료·인증·native Codex·모델 호출 검증과 구분합니다. [4-C-19 결과](../history/stage-4c19-result.md)에 검증 범위를 기록합니다.

[설정 예시](../../config/company-relay-authorization.example.json)는 기본 비활성입니다. 사용 전 미확인인 회사 전송·제공자/계정 조건을 확인하고, 실제 호출 제외를 해제하는 별도 승인이 필요합니다. 예시의 0 hash와 경로는 가짜 값입니다. 승인된 native 경로/기존 hash와 허용된 계정 ID의 UTF-8 SHA-256을 사용하며 토큰은 설정에 넣지 않습니다. 설정은 소유자 전용 디렉터리(`0700`)의 `company-relay-authorization.json`(`0600`)으로 보관합니다. 다음은 구현한 명령의 사용법이며 실행 승인을 대신하지 않습니다.

```sh
pnpm harness company-relay-plan --mode live --preparation-task <preparation-uuid> --authorization /private/review/company-relay-authorization.json --preparation-data-dir /private/review/company-runtime-v3 --data-dir /private/review/company-relay
pnpm harness company-relay-review --task <relay-uuid> --data-dir /private/review/company-relay
# reviews/<relay-uuid>.json에서 정확한 요청 본문·계정 hash·목적지·한도·기한을 검토한 뒤 해당 계획만 승인
pnpm harness company-relay-approve --mode live --task <relay-uuid> --plan-hash <sha256> --expires-in-minutes 10 --authorization /private/review/company-relay-authorization.json --preparation-data-dir /private/review/company-runtime-v3 --data-dir /private/review/company-relay
pnpm harness company-relay-run --mode live --task <relay-uuid> --plan-hash <sha256> --authorization /private/review/company-relay-authorization.json --preparation-data-dir /private/review/company-runtime-v3 --data-dir /private/review/company-relay
pnpm harness company-relay-inspect --task <relay-uuid> --data-dir /private/review/company-relay
# 완료 후 같은 review 명령으로 검증된 보고서도 열람
pnpm harness company-relay-review --task <relay-uuid> --data-dir /private/review/company-relay
pnpm harness company-relay-cancel --task <relay-uuid> --data-dir /private/review/company-relay
pnpm harness company-relay-recover --task <relay-uuid> --data-dir /private/review/company-relay
pnpm harness company-relay-prune --data-dir /private/review/company-relay
```

전송은 기존 relay-v3의 고정 모델·ChatGPT endpoint·계정 인증·단건 호출·재시도 0을 사용합니다. 실제 인증을 읽은 뒤 계정 hash가 일치해야 전송 예약을 확정합니다. 원본/준비·설정·본문 변경, 만료·취소·사용 승인은 호출을 차단합니다. 본문·보고서·검토 사본은 원래 준비의 `expiresAt`, 감사는 `auditExpiresAt`을 상속합니다. 새 승인으로 기간을 연장하지 않으며 백그라운드 삭제가 아닌 명령 기반 정리입니다.

stdout은 상태와 집계만 표시합니다. 검토 파일은 `reviews/<task-id>.json`에 `0600`으로 보관하며 `requestEnvelope.body`가 정확한 전송 문자열입니다. 로컬 source root·파일 identity·토큰·원시 응답은 복사하지 않습니다. `REPORTED`와 `verification:live`가 실제 호출 결과이고, `verification:fake`는 합성 검증입니다. `dispatchReservations`는 전송 예약 수이므로 중단 시 실제 공급자 호출 수로 단정하지 않습니다. `unknown`이면 같은 ID를 조회하고 재실행하지 않습니다.

준비/승인/검토/정리는 제한된 Node worker에서 실행합니다. 명시적 `run`은 기존 relay와 같은 신뢰하는 controller로 실행하며 OS 권한을 가집니다. 현재 Node 제한 모드에서 fsync가 차단되어 승인·native 수명 기록의 내구성을 보존하기 위한 구분입니다. native child는 기존 OS sandbox를 사용하며, 회사 전송 경로의 실제 실행 검증 여부는 결과 기록을 따릅니다. 모든 worker는 최소 환경·128MiB old-space, `run` 전체125초(작업120초+정리5초)를 유지합니다. 이를 RSS 상한이나 controller의 OS 읽기/쓰기 격리로 해석하지 않습니다.

정상 종료한 native 감사 파일만 기한 후 제거합니다. `preservedUncertainArtifacts`가 0보다 크면 남은 scratch·불확정 종료·변조 자료를 수동 확인해야 하며, 이를 안전하게 재귀 삭제하지 않습니다. 설정 파일 수정은 다음 명령부터 반영됩니다. 진행 중 실행은 `cancel`로 중지하며 원격 처리의 철회는 보장하지 않습니다.

relay-v3의 인증 반사 실패에는 `call-report.json`의 선택적 `reflectionDiagnostic`으로 전체 문자열 일치·decoded 문자열 일치·순서 조각 일치와 인증 종류를 구분합니다. 원문은 보관하지 않고 기존 차단 규칙과 한도는 유지합니다. 조각 일치가 곧 오탐이라는 뜻은 아니며, 과거 기록에는 이 진단이 없습니다. [합성 재현·진단 결과](../history/stage-4c20-result.md)를 참고하세요.

### 회사 수정안의 로컬 계획·검토·승인 기록

`company-change-*`는 파일 수정 실행기의 첫 묶음입니다. 입력한 `replace/create` 수정안을 별도 계획으로 보관하고 정확한 내용을 로컬에서 검토·승인합니다. **현재 승인은 `review-only`이며 파일 적용 권한이 없습니다.** 레포 ID·기준 commit/index hash·브랜치는 입력한 선언일 뿐 실제 저장소를 열거나 검증하지 않습니다. `sourceVerification:not_run`, `executionAllowed:false`, `transmissionAllowed:false`를 유지합니다.

[합성 수정안 예시](../../config/company-change-draft.example.json)는 가짜 레포 식별자·기준 hash와 일반 텍스트 파일 두 개를 사용합니다. 입력 JSON은 소유자 전용 디렉터리(`0700`)의 파일(`0600`)로 준비하고, runtime은 그 입력 및 하네스와 분리된 전용 위치를 사용합니다. 다음 경로는 예시이며 실제 회사 자료의 읽기·보관 허가를 대신하지 않습니다.

```sh
pnpm harness company-change-plan --draft /private/review/input/draft.json --data-dir /private/review/change-runtime
pnpm harness company-change-review --task <uuid> --data-dir /private/review/change-runtime
# reviews/<uuid>.json의 전체 수정 내용과 계획 hash를 검토한 뒤 기록용 승인
pnpm harness company-change-approve --task <uuid> --plan-hash <sha256> --expires-in-minutes 10 --data-dir /private/review/change-runtime
pnpm harness company-change-inspect --task <uuid> --data-dir /private/review/change-runtime
pnpm harness company-change-cancel --task <uuid> --data-dir /private/review/change-runtime
pnpm harness company-change-prune --data-dir /private/review/change-runtime
```

제안에는 레포 ID·정수 요청 revision·목적·기준 브랜치/commit/index hash·작업 유형·새 브랜치 이름·파일별 `replace/create`, 변경 전 hash와 새 본문이 필요합니다. 기존 파일의 원문을 읽지 않으므로 검토 자료는 전체 교체 내용과 선언된 변경 전 hash를 보여 주며, 실제 원본과의 diff나 최신성 확인 결과가 아닙니다. 경로 탈출·Git/비밀 경로·중복 및 대소문자 충돌·잘못된 UTF-8·알려진 민감정보 패턴·변경 없는 교체를 거부합니다. 모델 출력이나 제안 속 지시는 실행하지 않습니다.

새 검토 계약의 한도는 최대 8파일, 파일별 새 본문 64KiB, 새 본문 합계 128KiB, 입력 JSON 256KiB, 검토 JSON 288KiB입니다. 이 값은 제안의 보관·검토 한도이며 실제 파일 쓰기·제품 검사 예산이 아닙니다. 기존 회사 읽기·합성 실행·relay 계약과 숫자 한도는 변경하지 않습니다.

기본 출력에는 상태·hash·기한·권한만 표시합니다. 수정안은 `store/company-change.sqlite`, 관리되는 검토 사본은 `reviews/<uuid>.json`에 보관합니다. 새 계획 생성 후 본문 24시간·감사 metadata 30일이며 조회나 승인으로 연장하지 않습니다. 승인에는 현재 OS 소유자·정확한 계획 hash·명시한 1~60분 기한이 필요하고 본문 기한을 넘는 요청은 거부합니다. 같은 활성 승인 재요청은 기한을 연장하지 않으며, 만료된 승인에는 새 계획이 필요합니다.

취소·만료 시 수정안과 관리되는 검토 사본을 정리합니다. 감사 기록 삭제 후 같은 ID가 되살아나지 않도록 본문·경로 없는 작업 ID hash와 계획 hash의 최소 중복 표식은 DB 수명 동안 남습니다. 사용자가 제공한 입력 JSON은 자동 삭제하지 않습니다. 자동 예약 삭제와 물리적 완전 삭제는 보장하지 않습니다. `apply/run`, Git 브랜치 생성·수정·commit/push, 제품 검사와 모델 호출은 제공하지 않습니다. 후속 실제 적용에는 원본 재검증과 별도 실행 계획·승인이 필요합니다.

worker 경계와 검토 파일 정리의 검증 결과·한계는 [4-C-30 결과](../history/stage-4c30-result.md)를 따릅니다.

## 원본 회사 레포의 승인된 파일 적용

`company-apply-*`는 회사 로컬 적용용 `company-apply-plan-v1`과 `company-apply-approval-v1`을 사용합니다. 기존 검토/합성 승인은 사용할 수 없습니다. `plan → approve → run`을 분리하고 원본 레포에서 새 브랜치로 전환한 뒤 승인된 파일만 수정합니다. 회사용 연결의 구현과 합성 수용 검증은 완료했으며, 실제 회사 업무의 적용 결과는 각 실행에서 별도로 확인합니다.

입력은 기존 `company-write-registration-v1`과 `company-change-draft-v1` JSON입니다. 회사가 허용한 private 위치에 저장하고 파일 0600·직접 부모 0700·canonical 경로를 사용합니다. 실제 경로는 등록의 `sourceRoot`에 두며 `.env`는 필요하지 않습니다. `enabled:true`·읽기/쓰기 허용 선언은 확인된 정책을 기록하는 조건이고 단건 실행 승인을 대신하지 않습니다. 실제 수정할 파일의 정확한 허용 목록·현재 기준 브랜치/commit/index hash와 before hash, 새 본문을 먼저 검토합니다. 입력 파일·runtime·대상 레포·하네스 경로는 겹칠 수 없습니다.

```sh
# 회사가 허용한 private 부모 아래 준비한 registration.json과 draft.json을 사용합니다.
pnpm harness company-apply-plan --registration /private/tmp/company-task/registration.json --draft /private/tmp/company-task/draft.json --data-dir /private/tmp/company-task/runtime
pnpm harness company-apply-inspect --task <task-id> --data-dir /private/tmp/company-task/runtime
pnpm harness company-apply-approve --task <task-id> --plan-hash <plan-hash> --expires-in-minutes 10 --registration /private/tmp/company-task/registration.json --draft /private/tmp/company-task/draft.json --data-dir /private/tmp/company-task/runtime
pnpm harness company-apply-run --task <task-id> --plan-hash <plan-hash> --registration /private/tmp/company-task/registration.json --draft /private/tmp/company-task/draft.json --data-dir /private/tmp/company-task/runtime
pnpm harness company-apply-cancel --task <task-id> --data-dir /private/tmp/company-task/runtime
```

`plan`만 새 runtime을 만들 수 있고 결과는 `AWAITING_APPROVAL`입니다. 계획에는 본문 대신 원본/Git proof·등록/draft hash·파일별 전후 hash·소유자·기간을 보관합니다. 상세 계획은 `runtime/tasks/<task-id>/plan.json`에서 입력 draft와 함께 검토합니다. `approve`와 `run`은 같은 등록/수정안과 현재 원본을 재검증합니다. `inspect`와 `cancel`에는 회사 경로나 입력 파일이 필요 없습니다. 출력에는 상태·hash·파일 수만 포함합니다.

수정할 기존 파일은 기준 commit blob·index stage 0·현재 bytes/mode가 같아야 합니다. 이미 수정하거나 staged한 대상 파일은 거부합니다. 새 파일은 기준 tree·모든 index stage·현재 작업 파일에 없어야 하며 대소문자/상하위 경로 충돌도 거부합니다. 선택하지 않은 작업과 index bytes는 보존하며 레포 전체가 clean하다고 판정하지 않습니다. `packed-refs`와 loose ref 양쪽의 새 브랜치 충돌을 검사하고 packed-only 기준 ref도 지원합니다. 기준 ref의 부모와 대상 파일의 부모 디렉터리는 이미 존재해야 합니다. worktree·submodule·merge/rebase 등의 미지원 상태는 계속 거부합니다.

`run`은 현재 macOS `sandbox-exec`에서 실행을 지원합니다. 동일한 OS 허용 경로의 별도 worker에서 합성 canary 읽기/쓰기·추가 exec·TCP 차단을 확인한 후 승인을 한 번 소비합니다. 적용 worker가 Git proof를 다시 확인하고 branch/file INTENT·DONE을 fsync합니다. index 1MiB·packed-refs 1MiB·파일 8개/개별64KiB/합계128KiB, 기존 Git 판독기의 고정 공유 예산과 worker 30초·250ms 종료 유예·출력16KiB·old-space128MiB를 유지합니다. 원본 Git 명령·hooks·repack·제품 코드·모델·원격 작업은 실행하지 않습니다.

`APPLIED`는 승인된 파일 적용의 완료이며 제품 검사 상태는 `not_run`입니다. 중간 실패는 이미 게시한 변경을 보존합니다. claim/journal이 부분 기록되거나 손상된 경우, 또는 강제 종료 후 최종 journal 기록이 없으면 `UNKNOWN`과 승인 소비 상태를 표시하며 같은 task를 재실행할 수 없습니다. 계획·승인·위치 binding 손상은 고정 오류로 거부합니다. 오류 후에는 `inspect`로 확인하고 남은 파일/잠금은 로컬에서 검토합니다. 자동 rollback·resume·기존 잠금 삭제는 없습니다. controller가 control lease를 유지하는 동안 같은 runtime의 다른 명령은 진입하지 않으며 취소는 적용 전에만 가능합니다.

runtime에는 private control DB와 task별 본문 없는 계획·위치 binding·승인·claim·journal·worker marker를 보관합니다. 단건 적용 기한은 계획24시간/승인1~60분이고 기록을 자동 삭제하지 않습니다. 파일/위치 hash는 로컬 일관성 검사이며 OS 사용자 본인의 악의적 변조에 대한 서명이 아닙니다. 선택 Git 객체의 부수 delta base 읽기·전체 pack checksum 미검증과 경합/종료 보증의 한계는 [4-C-34 결과](../history/stage-4c34-result.md)를 따릅니다.
