import { generateJson } from '@code-review-agent/llm';
import type { RepoContextSections } from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';

import { synthesizeBaselinePrompt } from '../prompts/synthesize-baseline.prompt.js';
import { synthesizeUpdatePrompt } from '../prompts/synthesize-update.prompt.js';
import { repoContextSectionsSchema } from '../repo-context.schema.js';

/** Output budget for the merged document; a truncated reply fails schema validation loudly. */
const SYNTHESIZE_MAX_OUTPUT_TOKENS = 32_000;

export function synthesizeBaseline(params: {
  llm: BaseLlm;
  summaries: string[];
  overflowPaths: string[];
}): Promise<RepoContextSections> {
  return generateJson(params.llm, {
    prompt: synthesizeBaselinePrompt(params),
    schema: repoContextSectionsSchema,
    maxOutputTokens: SYNTHESIZE_MAX_OUTPUT_TOKENS,
  });
}

export function synthesizeUpdate(params: {
  llm: BaseLlm;
  existing: RepoContextSections;
  summaries: string[];
  deletedPaths: string[];
}): Promise<RepoContextSections> {
  return generateJson(params.llm, {
    prompt: synthesizeUpdatePrompt(params),
    schema: repoContextSectionsSchema,
    maxOutputTokens: SYNTHESIZE_MAX_OUTPUT_TOKENS,
  });
}
