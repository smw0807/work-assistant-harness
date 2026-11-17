import type { CompanyInvestigationModelPort } from '../domain/company-investigation.js';
import { HarnessError } from '../domain/errors.js';
import type { ReadonlyEvidence, ReadonlyReport } from '../domain/readonly-investigation.js';
import { canonicalReadonlyJson, READONLY_LIMITS } from '../policy/readonly-investigation-policy.js';
import { parseReadonlyTransportJson } from '../policy/readonly-transport-protocol.js';

/** A local deterministic response: no credential, native, network or repository capability is held. */
export class FixedCompanyInvestigationModel implements CompanyInvestigationModelPort {
  readonly mode = 'mock' as const;

  async investigate(inputText: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new HarnessError('COMPANY_INVESTIGATION_CANCELLED');
    if (typeof inputText !== 'string' || Buffer.byteLength(inputText) > READONLY_LIMITS.inputBytes) {
      throw new HarnessError('COMPANY_INVESTIGATION_INPUT_LIMIT');
    }
    const input = parseReadonlyTransportJson(inputText) as { version: string; mode: string; question: string; evidence: ReadonlyEvidence[] };
    if (input.version !== 'company-investigation-input-v1' || input.mode !== 'mock'
      || typeof input.question !== 'string' || !Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new HarnessError('COMPANY_INVESTIGATION_INVALID_INPUT');
    }
    const result: ReadonlyReport = {
      classification: 'insufficient-evidence',
      summary: 'Local fixed-response check of the explicitly selected company preparation evidence.',
      facts: input.evidence.map(item => ({ text: 'The supplied excerpt is available for review.',
        references: [{ evidenceId: item.evidenceId, startLine: item.startLine, endLine: item.endLine }] })),
      hypotheses: [], answerDraft: 'This mock response verifies the investigation workflow only. It does not answer the business question.',
      questions: ['A separately authorized real investigation is required to answer the question.'], suggestions: [],
      limitations: ['mode: mock; fixed response with no real model or native execution.',
        'Schema and evidence citation checks do not prove semantic accuracy.'],
    };
    return canonicalReadonlyJson(result);
  }
}
