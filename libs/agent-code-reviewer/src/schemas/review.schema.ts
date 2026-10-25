import type { PriorFinding as SharedPriorFinding } from '@code-review-agent/shared-types';
import { z } from 'zod';

export const reviewerFocusInputSchema = z.object({
  focus: z
    .string()
    .describe('One-paragraph hint on what to pay special attention to'),
});

export const findingSchema = z.object({
  title: z.string(),
  severity: z.enum(['critical', 'major', 'minor']),
  path: z.string().describe('Repo-relative file path'),
  startLine: z
    .number()
    .int()
    .describe('First line on the NEW side of the diff'),
  endLine: z.number().int().describe('Last line on the NEW side of the diff'),
  body: z
    .string()
    .describe(
      'What is wrong and its concrete failure scenario — point at the problem, do NOT propose fix code',
    ),
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof findingSchema>;

export const findingsReportSchema = z.object({
  findings: z.array(findingSchema),
});

export const priorFindingSchema = z.object({
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  severity: z.enum(['critical', 'major', 'minor']),
  title: z.string(),
});
export type PriorFinding = z.infer<typeof priorFindingSchema>;

/**
 * Compile-time drift guard: the zod shape above and the shared contract in
 * `@code-review-agent/shared-types` (persisted as `PRState.publishedFindings`)
 * must stay mutually assignable. If either side gains/loses a field, one of
 * these assertions stops compiling.
 */
type AssertTrue<T extends true> = T;
export type PriorFindingContractCheck = [
  AssertTrue<SharedPriorFinding extends PriorFinding ? true : false>,
  AssertTrue<PriorFinding extends SharedPriorFinding ? true : false>,
];

/**
 * The orchestrator's final structured answer — the single delivery channel
 * for a review. There is no publish tool: the runtime parses this report,
 * applies the guardrails (see finalizeReview), and the host publishes the
 * resulting payload exactly once.
 */
export const reviewReportSchema = z.object({
  summary: z
    .string()
    .optional()
    .describe('One-paragraph overall verdict of the code review'),
  findings: z
    .array(findingSchema)
    .describe('Approved review findings to post inline'),
});
export type ReviewReport = z.infer<typeof reviewReportSchema>;
