import type {
  DecisionAnswer,
  DecisionModel,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
} from './decision-model.js';

export type DecisionResponder = (
  id: string,
  question: DecisionQuestion,
  request: DecisionRequest,
) => DecisionAnswer | undefined;

/** A choice answer that puts `probability` on `choice` and splits the rest evenly. */
export function choiceAnswer(
  question: DecisionQuestion,
  choice: string,
  probability = 0.9,
): DecisionAnswer {
  const options =
    question.type === 'choice' ? Object.keys(question.criteria) : [];
  const others = options.filter((option) => option !== choice);
  const rest = others.length > 0 ? (1 - probability) / others.length : 0;
  return {
    type: 'choice',
    choice,
    confidence: probability,
    probabilities: Object.fromEntries([
      [choice, probability],
      ...others.map((option) => [option, rest]),
    ]),
  };
}

/** A yes/no answer with P(true) = `noul`. */
export function noulAnswer(noul: number): DecisionAnswer {
  return { type: 'noul', noul, confidence: Math.max(noul, 1 - noul) };
}

/** The most cautious answer: the last choice option, or "false". */
function defaultAnswer(question: DecisionQuestion): DecisionAnswer {
  if (question.type === 'choice') {
    return choiceAnswer(question, Object.keys(question.criteria).at(-1) ?? '');
  }
  if (question.type === 'noul') return noulAnswer(0.05);
  return {
    type: 'score',
    score: 0,
    confidence: 1,
    probabilities: { '0': 1 },
    legend: { '0': question.criteria[0] ?? '' },
  };
}

/**
 * Test double for {@link DecisionModel}. `respond` answers each question; a
 * question it leaves `undefined` gets the most cautious answer (last choice
 * option, or "false").
 */
export class MockDecisionModel implements DecisionModel {
  readonly requests: DecisionRequest[] = [];

  constructor(
    private readonly respond: DecisionResponder = () => undefined,
    readonly model = 'mock-decision',
  ) {}

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    this.requests.push(request);
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        this.respond(id, question, request) ?? defaultAnswer(question),
      ]),
    );
    return {
      answers,
      usage: {
        calls: 1,
        promptTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        thoughtsTokens: 0,
      },
    };
  }
}
