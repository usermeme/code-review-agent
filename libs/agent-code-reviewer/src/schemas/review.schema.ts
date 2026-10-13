import { z } from 'zod';

export const findingSchema = z.object({
  title: z.string(),
  severity: z.enum(['critical', 'major', 'minor']),
  path: z.string().describe('Repo-relative file path'),
  startLine: z
    .number()
    .int()
    .describe('First line on the NEW side of the diff'),
  endLine: z.number().int().describe('Last line on the NEW side of the diff'),
  body: z.string().describe('Explanation of the problem and why it matters'),
  confidence: z.number().min(0).max(1),
  suggestion: z
    .string()
    .optional()
    .describe('Replacement code for the flagged lines, if applicable'),
});
export type Finding = z.infer<typeof findingSchema>;

export const findingsReportSchema = z.object({
  findings: z.array(findingSchema),
});
export type FindingsReport = z.infer<typeof findingsReportSchema>;

export const ticketRequirementSchema = z.object({
  requirement: z.string(),
  status: z.enum(['implemented', 'partial', 'missing']),
  evidence: z.string().describe('Where in the diff this is (not) addressed'),
});

export const ticketReportSchema = z.object({
  ticketFound: z.boolean(),
  tickets: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      requirements: z.array(ticketRequirementSchema),
    }),
  ),
  summary: z.string(),
});
export type TicketReport = z.infer<typeof ticketReportSchema>;

export const reviewPlanSchema = z.object({
  summary: z.string().describe('Overall review verdict paragraph in markdown'),
  ticketCoverage: z
    .string()
    .optional()
    .describe('Markdown section on ticket completeness'),
  findings: z.array(findingSchema),
});
export type ReviewPlan = z.infer<typeof reviewPlanSchema>;
