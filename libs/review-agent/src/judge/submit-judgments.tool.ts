import { type Context, FunctionTool } from '@google/adk';
import { z } from 'zod';

export const threadJudgmentSchema = z.object({
  thread: z
    .number()
    .int()
    .min(0)
    .describe(
      'The thread number from the prompt ("Thread 0", "Thread 1", ...).',
    ),
  verdict: z
    .enum(['fixed', 'not_fixed', 'accepted'])
    .describe(
      'fixed: the problem is gone at the head. not_fixed: still there, partly fixed, or moved. accepted: unchanged, with a concrete reason in a reply that holds up.',
    ),
  reason: z
    .string()
    .min(1)
    .max(1_200)
    .describe(
      'For not_fixed: what is still wrong, with file:line, at most three sentences (posted on the thread). Otherwise one sentence.',
    ),
});

export const submitJudgmentsSchema = z.object({
  judgments: z
    .array(threadJudgmentSchema)
    .describe('One judgment per thread in the prompt.'),
});

export type SubmittedJudgment = z.infer<typeof threadJudgmentSchema>;
export type SubmitJudgmentsInput = z.infer<typeof submitJudgmentsSchema>;

export interface SubmitJudgmentsToolBundle {
  tool: FunctionTool<typeof submitJudgmentsSchema>;
  getSubmission(): SubmitJudgmentsInput | undefined;
}

/** Creates the `submit_judgments` tool; the first call ends the session. */
export function createSubmitJudgmentsTool(): SubmitJudgmentsToolBundle {
  let submission: SubmitJudgmentsInput | undefined;
  const tool = new FunctionTool({
    name: 'submit_judgments',
    description:
      'Submit your verdict for every resolved thread. Call it exactly once, when you are done.',
    parameters: submitJudgmentsSchema,
    execute: (input: SubmitJudgmentsInput, toolContext?: Context) => {
      submission ??= input;
      if (toolContext) toolContext.actions.skipSummarization = true;
      return { accepted: true };
    },
  });
  return { tool, getSubmission: () => submission };
}
