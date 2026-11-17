import { z } from 'zod';

export const MAX_CONTEXT_RULES = 100;
const MAX_RULE_CHARS = 400;
const MAX_GLOBS_PER_RULE = 10;

// Line numbers use min(1), not positive(): positive() becomes
// `exclusiveMinimum`, which the Gemini API rejects.
const extractedRuleSchema = z.object({
  id: z.string().min(1).max(80).describe('Short kebab-case slug.'),
  rule: z
    .string()
    .min(1)
    .max(MAX_RULE_CHARS)
    .describe(
      'One imperative sentence that quotes or closely paraphrases the source.',
    ),
  appliesTo: z
    .array(z.string())
    .max(MAX_GLOBS_PER_RULE)
    .describe(
      'Path globs the source limits the rule to; [] for the whole repository.',
    ),
  severity: z
    .enum(['critical', 'major', 'minor'])
    .describe(
      'critical: security/data loss; major: broken behavior/contracts; minor: conventions.',
    ),
  source: z.object({
    path: z.string().min(1).describe('File path exactly as shown.'),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  }),
});

export const extractedRulesSchema = z.object({
  rules: z.array(extractedRuleSchema).max(MAX_CONTEXT_RULES),
});

export type ExtractedRule = z.infer<typeof extractedRuleSchema>;
