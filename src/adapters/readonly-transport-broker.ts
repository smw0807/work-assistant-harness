import { createHash } from 'node:crypto';
import { HarnessError } from '../domain/errors.js';
import { assertReadonlyTransportRequestBody } from '../policy/readonly-transport-policy.js';
import type { ReadonlyTransportPort } from '../ports/readonly-transport.js';

interface ApprovedRequest { requestBody: string; requestBodyHash: string }

/** 네트워크 기본값이 없는 중계 계층. 저장된 승인 본문을 한 번만 그대로 전달한다. */
export class ReadonlyTransportBroker {
  private consumed = false;

  constructor(private readonly port: ReadonlyTransportPort) {
    this.assertFakePort();
  }

  async transmit(request: ApprovedRequest, signal: AbortSignal): Promise<Uint8Array> {
    this.assertFakePort();
    if (!request || Object.keys(request).sort().join(',') !== 'requestBody,requestBodyHash'
      || typeof request.requestBody !== 'string' || Buffer.byteLength(request.requestBody) > 256 * 1024
      || !/^[a-f0-9]{64}$/.test(request.requestBodyHash)
      || createHash('sha256').update(request.requestBody).digest('hex') !== request.requestBodyHash) {
      throw new HarnessError('READONLY_TRANSPORT_INVALID_REQUEST');
    }
    assertReadonlyTransportRequestBody(request.requestBody);
    if (signal.aborted) throw new HarnessError('READONLY_TRANSPORT_CANCELLED');
    if (this.consumed) throw new HarnessError('READONLY_TRANSPORT_ALREADY_DISPATCHED');
    this.consumed = true;
    // 본문을 다시 직렬화하지 않으며 실패 뒤에도 consumed를 복원하지 않는다.
    let response: Uint8Array;
    try { response = await this.port.transmit(request.requestBody, signal); }
    catch (error) {
      const known = ['READONLY_TRANSPORT_CANCELLED', 'READONLY_TRANSPORT_TIMEOUT', 'READONLY_TRANSPORT_RESPONSE_LIMIT',
        'READONLY_TRANSPORT_PROCESS_FAILED', 'READONLY_TRANSPORT_LIFECYCLE_UNSAFE', 'READONLY_TRANSPORT_OUTPUT_LIMIT'];
      if (error instanceof HarnessError && known.includes(error.code)) throw error;
      throw new HarnessError('READONLY_TRANSPORT_CALL_FAILED');
    }
    if (signal.aborted) throw new HarnessError('READONLY_TRANSPORT_CANCELLED');
    if (!(response instanceof Uint8Array) || response.byteLength > 256 * 1024) {
      throw new HarnessError('READONLY_TRANSPORT_RESPONSE_LIMIT');
    }
    return response;
  }

  private assertFakePort(): void {
    if (!this.port || this.port.mode !== 'offline' || this.port.transport !== 'fake'
      || typeof this.port.transmit !== 'function') throw new HarnessError('READONLY_TRANSPORT_FAKE_REQUIRED');
  }
}
