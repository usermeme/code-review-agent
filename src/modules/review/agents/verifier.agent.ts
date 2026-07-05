import { readFile } from 'node:fs/promises';
import type { BaseLlm } from '@google/adk';
import { Type, type Schema } from '@google/genai';
import PQueue from 'p-queue';
import { z } from 'zod';
import { renderWithLineNumbers } from '../../context/changed-files.service.js';
import { annotateDiff } from '../../../integrations/github/diff.service.js';
import type { PrFile } from '../../../integrations/github/pr.service.js';
import { generateJson } from '../../../integrations/model/generate.service.js';
import { logger } from '../../../core/logger/logger.service.js';
import { resolveInsideCheckout } from '../../../common/utils/safe-path.util.js';
import type { Finding } from '../schemas/review.schema.js';

const CONTEXT_LINES = 40;
const MAX_WINDOW_LINES = 220;

export const verdictSchema = z.object({
  verdict: z.enum(['confirm', 'refute']),
  reasoning: z.string(),
  correctedStartLine: z.number().int().positive().optional(),
  correctedEndLine: z.number().int().positive().optional(),
});
export type Verdict = z.infer<typeof verdictSchema>;

const verdictResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: ['confirm', 'refute'] },
    reasoning: {
      type: Type.STRING,
      description: 'Evidence-based justification citing specific lines',
    },
    correctedStartLine: {
      type: Type.INTEGER,
      description: 'Only when confirming a real finding whose startLine points at the wrong place',
    },
    correctedEndLine: {
      type: Type.INTEGER,
      description: 'Only when confirming a real finding whose endLine points at the wrong place',
    },
  },
  required: ['verdict', 'reasoning'],
};

const SYSTEM = `You are a skeptical staff engineer double-checking ONE code-review finding before it is
posted to the pull request. False positives erode the team's trust in the reviewer, but discarding a
real problem is worse.

Decide:
- "refute" ONLY when the actual code contradicts the finding: the alleged problem is already handled
  (a guard, catch, validation, or cleanup visible in the file), the finding misreads the code, the code
  the finding describes does not exist at or near the flagged lines, or the claim is speculation with
  no concrete support in the code.
- otherwise "confirm". When genuinely uncertain, confirm.

If the finding is real but startLine/endLine are slightly off, confirm and supply correctedStartLine /
correctedEndLine using the line numbers shown in the file content. Judge only this finding — do not
review anything else. Respond with JSON only.`;

export interface VerifyParams {
  llm: BaseLlm;
  checkoutDir: string;
  findings: Finding[];
  files: PrFile[];
  concurrency: number;
}

export interface VerificationResult {
  kept: Finding[];
  dropped: Array<{ finding: Finding; reason: string }>;
}

/**
 * Adversarial verification pass: each finding is re-checked against the real
 * file content at the PR head (not the diff) by a model prompted to refute
 * it. Refuted findings are dropped; confirmed ones may get corrected line
 * numbers. LLM failures keep the finding — verification only ever filters
 * with positive evidence.
 */
export async function verifyFindings(params: VerifyParams): Promise<VerificationResult> {
  const patchByFile = new Map(params.files.map((f) => [f.filename, f.patch]));
  const queue = new PQueue({ concurrency: params.concurrency });

  const outcomes = await Promise.all(
    params.findings.map((finding) =>
      queue.add(() => verifyOne(params.llm, params.checkoutDir, finding, patchByFile.get(finding.path))),
    ),
  );

  const kept: Finding[] = [];
  const dropped: VerificationResult['dropped'] = [];
  outcomes.forEach((outcome, index) => {
    const finding = params.findings[index]!;
    if (!outcome || outcome.keep) kept.push(finding);
    else dropped.push({ finding, reason: outcome.reason });
  });
  return { kept, dropped };
}

interface Outcome {
  keep: boolean;
  reason: string;
}

async function verifyOne(
  llm: BaseLlm,
  checkoutDir: string,
  finding: Finding,
  patch: string | undefined,
): Promise<Outcome> {
  const full = await resolveInsideCheckout(checkoutDir, finding.path);
  let content: string | null = null;
  if (full) {
    content = await readFile(full, 'utf8').catch(() => null);
  }
  if (content === null) {
    return {
      keep: false,
      reason: `file ${finding.path} does not exist in the PR head checkout`,
    };
  }

  const lines = content.split('\n');
  const start = Math.max(1, Math.min(finding.startLine, lines.length) - CONTEXT_LINES);
  const end = Math.min(
    lines.length,
    Math.max(finding.endLine, finding.startLine) + CONTEXT_LINES,
    start + MAX_WINDOW_LINES - 1,
  );
  const excerpt = renderWithLineNumbers(lines, { start, end });

  const prompt = [
    'Finding under review:',
    JSON.stringify(
      {
        title: finding.title,
        severity: finding.severity,
        path: finding.path,
        startLine: finding.startLine,
        endLine: finding.endLine,
        body: finding.body,
        ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
      },
      null,
      2,
    ),
    patch
      ? `What this PR changed in ${finding.path} (NEW-side line numbers prefixed):\n${annotateDiff(patch)}`
      : `(No patch available for ${finding.path} in this PR.)`,
    `Actual content of ${finding.path} at the PR head, around the flagged lines:\n${excerpt}`,
  ].join('\n\n');

  try {
    const verdict = await generateJson(llm, {
      system: SYSTEM,
      prompt,
      responseSchema: verdictResponseSchema,
      schema: verdictSchema,
    });
    if (verdict.verdict === 'refute') {
      return { keep: false, reason: verdict.reasoning };
    }
    applyCorrectedLines(finding, verdict, lines.length);
    return { keep: true, reason: verdict.reasoning };
  } catch (error) {
    logger.warn({ path: finding.path, title: finding.title, err: error }, 'verification call failed; keeping finding');
    return { keep: true, reason: 'verification unavailable' };
  }
}

function applyCorrectedLines(finding: Finding, verdict: Verdict, totalLines: number): void {
  const start = verdict.correctedStartLine;
  const end = verdict.correctedEndLine ?? start;
  if (!start || !end || start > end || end > totalLines) return;
  finding.startLine = start;
  finding.endLine = end;
}
