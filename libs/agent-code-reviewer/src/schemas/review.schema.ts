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

const ticketRequirementSchema = z.object({
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
