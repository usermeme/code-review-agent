import { Gemini } from '@google/adk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GeminiDecisionModel } from '../decisions/decision-model.js';
import { RetryingLlm } from '../providers/retrying.llm.js';
import {
  DEFAULT_TRIAGE_MODEL,
  modelConfigSchema,
} from '../schemas/model-config.schema.js';
import { createAgentModels, GEMINI_API_VERSION } from './agent-models.js';

const BASE_CONFIG = {
  REVIEWER_MODEL: 'gemini-4-hydrogen',
  VERIFIER_MODEL: 'gemini-4-argon',
  GEMINI_API_KEY: 'test-key',
};

describe('createAgentModels', () => {
  it('creates a decision model for triage and a retry-wrapped Gemini per agent', () => {
    const models = createAgentModels(
      modelConfigSchema.parse({ ...BASE_CONFIG, TRIAGE_MODEL: 'triage-x' }),
    );

    expect(models.triage).toBeInstanceOf(GeminiDecisionModel);
    for (const llm of [models.reviewer, models.verifier]) {
      expect(llm).toBeInstanceOf(RetryingLlm);
      expect((llm as RetryingLlm).inner).toBeInstanceOf(Gemini);
    }
    expect(models.triage.model).toBe('triage-x');
    expect(models.reviewer.model).toBe('gemini-4-hydrogen');
    expect(models.verifier.model).toBe('gemini-4-argon');
  });
});

describe('Gemini API version', () => {
  const ENV_KEY = 'GOOGLE_GENAI_API_VERSION';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  /** The API version ADK's own genai client resolves on its first request. */
  function resolvedApiVersion(llm: unknown): string {
    const gemini = (llm as RetryingLlm).inner as unknown as {
      apiClient: { apiClient: { getApiVersion(): string } };
    };
    return gemini.apiClient.apiClient.getApiVersion();
  }

  it('pins the agents to v1beta instead of the genai 3 default (v1)', () => {
    const models = createAgentModels(modelConfigSchema.parse(BASE_CONFIG));

    for (const llm of [models.reviewer, models.verifier]) {
      expect(resolvedApiVersion(llm)).toBe(GEMINI_API_VERSION);
    }
  });

  it('keeps an explicit GOOGLE_GENAI_API_VERSION from the environment', () => {
    process.env[ENV_KEY] = 'v1';
    const models = createAgentModels(modelConfigSchema.parse(BASE_CONFIG));

    expect(resolvedApiVersion(models.reviewer)).toBe('v1');
  });
});

describe('modelConfigSchema', () => {
  it('defaults TRIAGE_MODEL to the decision model', () => {
    const config = modelConfigSchema.parse(BASE_CONFIG);
    expect(config.TRIAGE_MODEL).toBe(DEFAULT_TRIAGE_MODEL);
  });

  it.each(['REVIEWER_MODEL', 'VERIFIER_MODEL'])(
    'requires %s to be set by infra',
    (key) => {
      const config: Record<string, string> = { ...BASE_CONFIG };
      delete config[key];
      expect(modelConfigSchema.safeParse(config).success).toBe(false);
    },
  );

  it('rejects blank model ids', () => {
    const result = modelConfigSchema.safeParse({
      ...BASE_CONFIG,
      REVIEWER_MODEL: '   ',
    });
    expect(result.success).toBe(false);
  });
});
