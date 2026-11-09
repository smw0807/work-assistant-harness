# 코딩 컨벤션

## 적용 범위와 기준

이 문서는 `work-assistant-harness` 자체를 개발할 때 적용할 개인 코딩 기준이다. 하네스가 조사하거나 수정하는 회사·제품 저장소에는 해당 저장소의 기존 지침과 팀 컨벤션을 우선한다. 이 문서를 근거로 대상 저장소의 스타일을 일괄 변경하지 않는다.

코드를 읽고 의도와 흐름을 분석하는 시간도 비용이다. 짧게 쓰는 것보다 다른 사람이나 나중의 내가 적은 설명으로 이해할 수 있는 코드를 지향한다.

아래 TypeScript 코드는 작성 방식의 예시다. 특정 기능·의존성·lint 설정이 이미 존재한다는 뜻이 아니며, 예시의 타입이나 파일 구조를 그대로 도입할 필요는 없다. 보안·승인·실행 범위는 `AGENTS.md`와 관련 문서를 따른다.

## 이름으로 의도를 드러낸다

- 변수와 함수 이름은 `camelCase`를 사용한다.
- 이름만 읽어도 무엇을 담는지, 어떤 일을 하는지 알 수 있게 쓴다.
- 문맥을 다시 추적하게 만드는 모호한 이름과 불필요한 축약을 피한다. 길이보다 전달되는 의미를 기준으로 판단한다.
- 클래스·타입 이름 등은 TypeScript와 NestJS의 관례 및 기존 코드 스타일을 따른다.

```ts
type Job = {
  id: string;
  status: 'queued' | 'running' | 'completed';
};

// 무엇을 조회하는지 호출부에서도 알 수 있다.
const getQueuedJobIds = (jobs: Job[]): string[] => {
  return jobs
    .filter((job) => job.status === 'queued')
    .map((job) => job.id);
};
```

예를 들어 `getData`, `process`, `result2`보다 실제 역할을 나타내는 `getQueuedJobIds`, `createReport`, `queuedJobCount`가 이해하기 쉽다. 예시 이름을 모든 상황에 맞는 고정 규칙으로 사용하지 않는다.

## 함수는 하나의 책임에 집중한다

함수의 목적을 한 문장으로 설명할 수 있게 만든다. 서로 다른 이유로 바뀌는 일을 한 함수에 섞지 않는다. 입력을 읽는 일, 값을 계산하는 일, 외부에 저장하는 일을 구분하면 흐름과 변경 범위를 이해하기 쉽다.

단일 책임을 맞추려고 모든 줄을 별도 함수로 나누지는 않는다. 분리한 이름이 의미를 더하는지, 호출을 따라 이동하는 비용보다 이해하기 쉬워지는지가 판단 기준이다. 하나의 목적을 수행하는 연속된 계산은 함께 둘 수 있다.

```ts
type LineItem = {
  unitPrice: number;
  quantity: number;
};

const calculateSubtotal = (lineItems: LineItem[]): number => {
  return lineItems.reduce((subtotal, lineItem) => {
    return subtotal + lineItem.unitPrice * lineItem.quantity;
  }, 0);
};
```

이 함수의 책임은 소계 계산이다. 이 정도 계산을 곱셈 함수와 덧셈 함수로 나눌 필요는 없다. 파일 읽기나 결과 저장이 필요하다면 호출하는 쪽에서 별도로 구성한다. 함수 길이만으로 분리 여부를 결정하지 않는다.

## 독립 함수는 함수 표현식을 기본으로 한다

클래스 밖에 정의하는 독립 함수는 함수 선언식보다 함수 표현식을 기본으로 한다. 일반적인 경우에는 `const`에 화살표 함수를 할당한다.

```ts
const formatJobLabel = (jobId: string, jobStatus: string): string => {
  return `${jobId}: ${jobStatus}`;
};
```

위처럼 `const formatJobLabel = ...` 형태를 기본으로 사용한다. 프레임워크나 기존 코드의 구조상 다른 형태가 필요하면 그 맥락을 따른다. 이 기준을 적용하려고 관계없는 기존 코드를 전부 바꾸지는 않는다.

## NestJS 클래스는 일반적인 메서드 문법을 따른다

NestJS 서비스·컨트롤러·프로바이더 등에서는 프레임워크의 클래스·의존성 주입 관례를 따른다. 독립 함수의 표현식 선호를 클래스 메서드까지 강제하지 않는다.

```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class JobLabelService {
  formatJobLabel(jobId: string, jobStatus: string): string {
    return `${jobId}: ${jobStatus}`;
  }
}
```

이 예시는 메서드 문법을 보여 주기 위한 것이다. 단순한 함수도 반드시 서비스로 감싸라는 뜻은 아니다. 상태나 프레임워크 의존성이 없는 계산·변환은 독립 함수로 두고, 클래스가 필요한 곳에서는 NestJS 방식에 맞게 작성한다.

## 주석은 역할과 이유를 보완한다

- 이름과 코드만으로 충분히 전달되지 않는 역할, 처리 이유, 제약을 설명한다.
- 사용 방법이 헷갈릴 때는 입력·출력 또는 짧은 호출 예시를 덧붙인다.
- 단순하고 자명한 내부 함수에는 주석을 생략할 수 있다.
- 코드를 그대로 읽어 주는 주석보다, 코드를 읽어도 알기 어려운 배경을 남긴다. 변경할 때 주석과 예시도 함께 맞춘다.

```ts
/**
 * 합성 이벤트의 라벨 입력을 쉼표 기준으로 분리한다.
 * 빈 입력 항목이 라벨로 저장되지 않도록 공백과 빈 항목을 제거한다.
 *
 * @example
 * parseLabels(' bug, , urgent ') // ['bug', 'urgent']
 */
const parseLabels = (input: string): string[] => {
  return input
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
};
```

위 예시는 역할·처리 이유·사용법을 함께 보여 준다. 모든 함수에 같은 형식의 설명을 반복할 필요는 없다. 반대로 이름이 명확한 단순 내부 함수는 다음처럼 작성해도 충분하다.

```ts
const isEmpty = (items: unknown[]): boolean => items.length === 0;
```

## 변경을 검토할 때

다음 질문으로 가독성을 확인한다.

- 이름만 읽어도 데이터의 의미와 함수의 일을 알 수 있는가?
- 함수에 서로 다른 책임이 섞이지 않았는가?
- 함수를 나누면서 오히려 흐름을 따라가기 어려워지지 않았는가?
- 독립 함수는 함수 표현식을 기본으로 사용하고, NestJS 클래스는 일반적인 메서드 문법을 따르는가?
- 주석이 필요한 역할·이유·사용법을 설명하며 현재 코드와 맞는가?
- 대상 회사·제품 저장소의 기존 규칙을 개인 취향으로 덮어쓰지 않았는가?

검사 명령은 실제 저장소에 정의된 스크립트와 설정을 확인해 사용한다. 이 문서만으로 ESLint·formatter·typecheck가 설정되어 있다고 가정하지 않는다.
