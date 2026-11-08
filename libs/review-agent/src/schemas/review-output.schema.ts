import type {
  PriorFinding,
  ReviewCommentPayload,
} from '@code-review-agent/shared-types';
import { z } from 'zod';

export const reviewFindingSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Repo-relative file path from the PR diff (no leading slash).'),
  line: z
    .number()
    .int()
    .positive()
    .describe(
      '1-based NEW-side ending line number taken from the L<num> | prefix in the annotated PR diff.',
    ),
  startLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Optional 1-based NEW-side start line for a multi-line comment (must be <= line and within the same diff hunk).',
    ),
  severity: z
    .enum(['critical', 'major', 'minor'])
    .describe(
      'Defect severity: critical (security/crash/data loss), major (broken behavior/race condition/contract break), minor (localized bug/guideline violation).',
    ),
  title: z
    .string()
    .min(1)
    .describe('Short, specific title summarizing the defect.'),
  comment: z
    .string()
    .min(1)
    .describe(
      'Concise explanation of the defect, its impact, and how to fix it.',
    ),
  suggestion: z
    .string()
    .optional()
    .describe(
      'Optional exact replacement code for the anchored line range (raw code without surrounding markdown fences).',
    ),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const submitReviewSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe('Concise markdown summary of the PR changes and review outcome.'),
  findings: z
    .array(reviewFindingSchema)
    .describe(
      'List of high-confidence findings anchored to NEW-side diff lines. Pass an empty array if no defects are found.',
    ),
});

export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildFindingKey(finding: ReviewFinding): string {
  const startLine = finding.startLine ?? finding.line;
  return `${finding.path.trim()}::${startLine}-${finding.line}::${normalizeTitle(finding.title)}`;
}

function isSameIssueAtOverlappingLines(
  finding: ReviewFinding,
  prior: PriorFinding,
): boolean {
  if (finding.path.trim() !== prior.path.trim()) {
    return false;
  }
  if (normalizeTitle(finding.title) !== normalizeTitle(prior.title)) {
    return false;
  }
  const start = finding.startLine ?? finding.line;
  return start <= prior.endLine && finding.line >= prior.startLine;
}

function shouldSkipFinding(
  finding: ReviewFinding,
  key: string,
  seenKeys: Set<string>,
  priorFindings: PriorFinding[],
): boolean {
  if (seenKeys.has(key)) {
    return true;
  }
  return priorFindings.some((prior) =>
    isSameIssueAtOverlappingLines(finding, prior),
  );
}

/**
 * Removes findings that duplicate prior findings from earlier PR commits or
 * duplicate another finding within the same batch.
 */
export function deduplicateFindings(
  findings: ReviewFinding[],
  priorFindings: PriorFinding[] = [],
): ReviewFinding[] {
  const seenKeys = new Set<string>();
  const result: ReviewFinding[] = [];

  for (const finding of findings) {
    const key = buildFindingKey(finding);
    if (!shouldSkipFinding(finding, key, seenKeys, priorFindings)) {
      seenKeys.add(key);
      result.push(finding);
    }
  }

  return result;
}

function sanitizeSuggestion(raw: string): string {
  return raw
    .trim()
    .replace(/^```[\w-]*\r?\n?|\r?\n?```$/g, '')
    .trim();
}

/**
 * Formats a finding into the markdown body posted as a GitHub PR review comment.
 */
export function formatFindingComment(finding: ReviewFinding): string {
  const header = `### [${finding.severity.toUpperCase()}] ${finding.title.trim()}`;
  const body = finding.comment.trim();
  const rawSuggestion = finding.suggestion?.trim();

  if (!rawSuggestion) {
    return `${header}\n\n${body}`;
  }

  const suggestion = sanitizeSuggestion(rawSuggestion);
  if (!suggestion) {
    return `${header}\n\n${body}`;
  }

  return `${header}\n\n${body}\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
}

/**
 * Converts a validated `ReviewFinding` into a `ReviewCommentPayload` for the git adapter.
 */
export function toReviewCommentPayload(
  finding: ReviewFinding,
  resolvedAnchor: { line: number; startLine?: number },
): ReviewCommentPayload {
  return {
    path: finding.path.trim(),
    position: resolvedAnchor.line,
    line: resolvedAnchor.line,
    ...(resolvedAnchor.startLine !== undefined
      ? { startPosition: resolvedAnchor.startLine }
      : {}),
    body: formatFindingComment(finding),
  };
}

/**
 * Converts a `ReviewFinding` into a `PriorFinding` record for PR state persistence.
 */
export function toPriorFinding(
  finding: ReviewFinding,
  resolvedAnchor: { line: number; startLine?: number },
): PriorFinding {
  return {
    path: finding.path.trim(),
    startLine: resolvedAnchor.startLine ?? resolvedAnchor.line,
    endLine: resolvedAnchor.line,
    severity: finding.severity,
    title: finding.title.trim(),
  };
}
