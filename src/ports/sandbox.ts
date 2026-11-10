import type {
  SandboxBackendIdentity, SandboxProbeId, SandboxProbeInput, SandboxProbeResult,
} from '../domain/sandbox.js';

/** 고정 합성 probe 전용이며 대상 저장소 코드나 임의 명령을 받지 않는다. */
export interface SandboxVerificationPort {
  preflight(): Promise<SandboxBackendIdentity>;
  runProbe(probe: SandboxProbeId, input: SandboxProbeInput, signal?: AbortSignal): Promise<SandboxProbeResult>;
}
