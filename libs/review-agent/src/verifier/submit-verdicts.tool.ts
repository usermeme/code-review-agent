import { type Context, FunctionTool } from '@google/adk';
import { z } from 'zod';

export const findingVerdictSchema = z.object({
  id: z
    .number()
    .int()
    .nonnegative()
    .describe('The candidate finding id from the prompt.'),
  verdict: z
    .enum(['keep', 'drop'])
    .describe(
      'keep: a real, actionable defect. drop: false positive, nitpick, already handled, or not verifiable.',
    ),
  severity: z
    .enum(['critical', 'major', 'minor'])
    .optional()
    .describe('Corrected severity, only when the reviewer got it wrong.'),
  reason: z
    .string()
    .min(1)
    .describe('One sentence on the evidence behind the verdict.'),
});

export const submitVerdictsSchema = z.object({
  verdicts: z
    .array(findingVerdictSchema)
    .describe('One verdict per candidate finding.'),
  summary: z
    .string()
    .optional()
    .describe(
      'Rewritten review summary, only if dropped findings make the original summary wrong.',
    ),
});

export type FindingVerdict = z.infer<typeof findingVerdictSchema>;
export type SubmitVerdictsInput = z.infer<typeof submitVerdictsSchema>;

export interface SubmitVerdictsToolBundle {
  tool: FunctionTool<typeof submitVerdictsSchema>;
  getSubmission(): SubmitVerdictsInput | undefined;
}

/** Creates the `submit_verdicts` tool; the first call ends the verifier session. */
export function createSubmitVerdictsTool(): SubmitVerdictsToolBundle {
  let submission: SubmitVerdictsInput | undefined;
  const tool = new FunctionTool({
    name: 'submit_verdicts',
    description:
      'Submit your keep/drop verdict for every candidate finding. Call it exactly once, when you are done.',
    parameters: submitVerdictsSchema,
    execute: (input: SubmitVerdictsInput, toolContext?: Context) => {
      submission ??= input;
      if (toolContext) toolContext.actions.skipSummarization = true;
      return { accepted: true };
    },
  });
  return { tool, getSubmission: () => submission };
}
