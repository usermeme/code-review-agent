import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';

export interface ScriptedJudgment {
  verdict: 'fixed' | 'not_fixed' | 'accepted';
  reason: string;
}

/** Answers every comment-judge session with the configured verdict per thread. */
export class JudgeLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  /** Verdict given to every thread in the prompt. */
  answer: ScriptedJudgment = { verdict: 'fixed', reason: 'Resolved.' };

  constructor() {
    super({ model: 'mock-judge' });
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(request);
    const prompt = JSON.stringify(request.contents);
    const threadCount = (prompt.match(/## Thread \d+:/g) ?? []).length;
    const judgments = Array.from({ length: threadCount }, (_, thread) => ({
      thread,
      ...this.answer,
    }));
    yield {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: `judge_${this.requests.length}`,
              name: 'submit_judgments',
              args: { judgments },
            },
          },
        ],
      },
    };
  }

  override connect(): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('Not implemented'));
  }
}
