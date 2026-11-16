import type { TokenUsage } from '@code-review-agent/shared-types';

import { emptyTokenUsage } from '../usage/token-usage.js';
import {
  type ChoiceAnswer,
  type DecisionAnswer,
  type DecisionModel,
  type DecisionQuestion,
  MAX_DECISION_QUESTIONS,
  type NoulAnswer,
} from './decision-model.js';

export interface DecideOptions {
  input: string;
  questions: Record<string, DecisionQuestion>;
  timeoutMs: number;
}

/** Answers keyed by question id; every question has an answer of its own type. */
export interface DecisionAnswers {
  choice(id: string): ChoiceAnswer;
  noul(id: string): NoulAnswer;
}

export type DecideResult =
  | { ok: true; answers: DecisionAnswers; usage: TokenUsage }
  | { ok: false; error: string; usage: TokenUsage };

function answerReader(
  answers: Record<string, DecisionAnswer>,
): DecisionAnswers {
  function get<T extends DecisionAnswer['type']>(id: string, type: T) {
    const answer = answers[id];
    if (answer?.type !== type) {
      throw new Error(`No ${type} answer for question "${id}".`);
    }
    return answer as Extract<DecisionAnswer, { type: T }>;
  }
  return {
    choice: (id) => get(id, 'choice'),
    noul: (id) => get(id, 'noul'),
  };
}

/** Ids of questions the model did not answer, or answered with another type. */
function unanswered(
  questions: Record<string, DecisionQuestion>,
  answers: Record<string, DecisionAnswer>,
): string[] {
  return Object.entries(questions)
    .filter(([id, question]) => answers[id]?.type !== question.type)
    .map(([id]) => id);
}

function checkQuestionCount(count: number): string | undefined {
  if (count === 0) return 'No decision questions to ask.';
  if (count > MAX_DECISION_QUESTIONS) {
    return `Too many decision questions (${count} > ${MAX_DECISION_QUESTIONS}).`;
  }
  return undefined;
}

function describeError(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return 'Decision call timed out.';
  return error instanceof Error ? error.message : String(error);
}

async function callModel(
  model: DecisionModel,
  options: DecideOptions,
  abortSignal: AbortSignal,
): Promise<DecideResult> {
  const response = await model.decide({
    input: options.input,
    questions: options.questions,
    abortSignal,
  });
  const missing = unanswered(options.questions, response.answers);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Decision model left questions unanswered: ${missing.join(', ')}.`,
      usage: response.usage,
    };
  }
  return {
    ok: true,
    answers: answerReader(response.answers),
    usage: response.usage,
  };
}

/**
 * Asks a decision model a batch of questions about one shared input.
 * Never throws: callers use the `ok: false` branch to fail open.
 */
export async function decide(
  model: DecisionModel,
  options: DecideOptions,
): Promise<DecideResult> {
  const invalid = checkQuestionCount(Object.keys(options.questions).length);
  if (invalid) return { ok: false, error: invalid, usage: emptyTokenUsage() };

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), options.timeoutMs);
  try {
    return await callModel(model, options, abortController.signal);
  } catch (error: unknown) {
    return {
      ok: false,
      error: describeError(error, abortController.signal),
      usage: emptyTokenUsage(),
    };
  } finally {
    clearTimeout(timer);
  }
}
