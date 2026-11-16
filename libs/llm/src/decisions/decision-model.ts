import type { TokenUsage } from '@code-review-agent/shared-types';
import type { Decisions, GoogleGenAI } from '@google/genai';

import { emptyTokenUsage } from '../usage/token-usage.js';

export type DecisionQuestion = Decisions.Question;
export type DecisionAnswer = Decisions.Answer;
export type ChoiceAnswer = Decisions.ChoiceAnswer;
export type NoulAnswer = Decisions.NoulAnswer;

/** The most questions one Decisions API request may carry. */
export const MAX_DECISION_QUESTIONS = 1000;

export interface DecisionRequest {
  /** Shared context every question is evaluated against. */
  input: string;
  /** Questions keyed by caller-chosen ids; answers come back under the same ids. */
  questions: Record<string, DecisionQuestion>;
  abortSignal?: AbortSignal;
}

export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;
  usage: TokenUsage;
}

/**
 * A model that answers structured questions with calibrated probabilities
 * instead of generating text (Gemini Decisions API, e.g. `gemini-decision-1`).
 */
export interface DecisionModel {
  readonly model: string;
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}

type DecisionsUsage = NonNullable<Decisions.CreateDecisionResponse['usage']>;

/** Decisions are billed on input tokens only; one request is one call. */
function decisionUsage(usage: DecisionsUsage = {}): TokenUsage {
  const tokens = (value: number | undefined) => value ?? 0;
  return {
    ...emptyTokenUsage(),
    calls: 1,
    promptTokens: tokens(usage.total_input_tokens),
    cachedTokens: tokens(usage.total_cached_tokens),
    outputTokens: tokens(usage.total_output_tokens),
    thoughtsTokens: tokens(usage.total_thought_tokens),
  };
}

function assertNotBlocked(response: Decisions.CreateDecisionResponse): void {
  const feedback = response.prompt_feedback;
  if (!feedback?.block_reason) return;
  const detail = feedback.block_reason_message ?? 'no details';
  throw new Error(
    `Decision input blocked (${feedback.block_reason}): ${detail}`,
  );
}

function resourceName(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

/** {@link DecisionModel} backed by the Gemini Decisions API (`POST /decisions`). */
export class GeminiDecisionModel implements DecisionModel {
  constructor(
    private readonly client: Pick<GoogleGenAI, 'decisions'>,
    readonly model: string,
    private readonly apiVersion: string,
  ) {}

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const response = await this.client.decisions.create(
      {
        api_version: this.apiVersion,
        model: resourceName(this.model),
        input: request.input,
        questions: request.questions,
      },
      { signal: request.abortSignal },
    );
    assertNotBlocked(response);
    return {
      answers: response.answers ?? {},
      usage: decisionUsage(response.usage),
    };
  }
}
