import { Ajv, type JSONSchemaType, type ValidateFunction } from 'ajv';
import { HarnessError } from '../domain/errors.js';
import type { ModelSummary, TriageDecision } from '../domain/types.js';
import type { ModelOutputValidator } from '../ports/index.js';
import { containsSensitiveText } from './redaction.js';

const maxOutputBytes = 32_768;
const shortText = { type: 'string', minLength: 1, maxLength: 2_000 } as const;
const textItems = { type: 'array', maxItems: 20, items: shortText } as const;

const triageSchema: JSONSchemaType<TriageDecision> = {
  type: 'object', additionalProperties: false, required: ['kind', 'objective', 'reads', 'questions'],
  properties: {
    kind: { type: 'string', enum: ['inquiry', 'change', 'unclear'] },
    objective: shortText,
    reads: {
      type: 'array', maxItems: 10,
      items: {
        type: 'object', additionalProperties: false, required: ['repoId', 'path', 'startLine', 'endLine'],
        properties: {
          repoId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
          path: { type: 'string', minLength: 1, maxLength: 1_024, pattern: '^[^\\u0000-\\u001f]+$' },
          startLine: { type: 'integer', minimum: 1, maximum: 1_000_000 },
          endLine: { type: 'integer', minimum: 1, maximum: 1_000_000 },
        },
      },
    },
    questions: textItems,
  },
};

const summarySchema: JSONSchemaType<ModelSummary> = {
  type: 'object', additionalProperties: false,
  required: ['facts', 'hypotheses', 'answerDraft', 'proposedChanges', 'risks'],
  properties: {
    facts: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false, required: ['evidenceIndex', 'text'],
        properties: { evidenceIndex: { type: 'integer', minimum: 0, maximum: 9 }, text: shortText },
      },
    },
    hypotheses: textItems,
    answerDraft: { type: 'string', maxLength: 4_000 },
    proposedChanges: textItems,
    risks: textItems,
  },
};

export class JsonModelOutputValidator implements ModelOutputValidator {
  private readonly validateTriage: ValidateFunction<TriageDecision>;
  private readonly validateSummary: ValidateFunction<ModelSummary>;

  constructor() {
    const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, removeAdditional: false });
    this.validateTriage = ajv.compile(triageSchema);
    this.validateSummary = ajv.compile(summarySchema);
  }

  triage(output: string): TriageDecision {
    const value = this.parse(output);
    if (!this.validateTriage(value)) throw new HarnessError('MODEL_INVALID_TRIAGE');
    if (value.reads.some((read) => read.endLine < read.startLine || read.endLine - read.startLine >= 100)) {
      throw new HarnessError('MODEL_INVALID_TRIAGE');
    }
    if (value.kind === 'unclear' && (value.questions.length === 0 || value.reads.length !== 0)) {
      throw new HarnessError('MODEL_INVALID_TRIAGE');
    }
    return value;
  }

  summary(output: string, evidenceCount: number): ModelSummary {
    const value = this.parse(output);
    if (!this.validateSummary(value)) throw new HarnessError('MODEL_INVALID_SUMMARY');
    if (!Number.isSafeInteger(evidenceCount) || evidenceCount < 0 || evidenceCount > 10
      || value.facts.some((fact) => fact.evidenceIndex >= evidenceCount)) {
      throw new HarnessError('MODEL_UNVERIFIED_EVIDENCE');
    }
    return value;
  }

  private parse(output: string): unknown {
    if (Buffer.byteLength(output, 'utf8') > maxOutputBytes) throw new HarnessError('MODEL_OUTPUT_TOO_LARGE');
    if (containsSensitiveText(output)) throw new HarnessError('MODEL_SENSITIVE_OUTPUT');
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new HarnessError('MODEL_INVALID_JSON');
    }
  }
}
