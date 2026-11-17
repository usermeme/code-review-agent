import { createPathMatcher } from '@code-review-agent/agent-tools';
import type {
  FindingSeverity,
  ReviewContextMetrics,
  ReviewRule,
  TokenUsage,
} from '@code-review-agent/shared-types';

/** Soft cap on each rules section of a prompt. */
export const MAX_RULES_SECTION_CHARS = 8_000;

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
};

/**
 * The review context handed to the pipeline. `rules` is null when it could
 * not be resolved; prompts then fall back to the raw repository guidelines.
 */
export interface ResolvedReviewContext {
  rules: ReviewRule[] | null;
  metrics: Omit<ReviewContextMetrics, 'selectedRules'>;
  usage?: TokenUsage;
}

/**
 * Rules for one review. Repo-wide rules are the same for every PR, so they
 * go into the cacheable system instruction; path-scoped ones that match
 * this PR go into the user prompt.
 */
export interface SelectedRules {
  global: ReviewRule[];
  scoped: ReviewRule[];
}

function matchesAnyFile(rule: ReviewRule, changedFiles: string[]): boolean {
  return rule.appliesTo.some((glob) => {
    const matches = createPathMatcher(glob);
    return changedFiles.some(matches);
  });
}

export function selectRules(
  rules: ReviewRule[],
  changedFiles: string[],
): SelectedRules {
  return {
    global: rules.filter((rule) => rule.appliesTo.length === 0),
    scoped: rules.filter(
      (rule) => rule.appliesTo.length > 0 && matchesAnyFile(rule, changedFiles),
    ),
  };
}

export function countSelectedRules(selected: SelectedRules): number {
  return selected.global.length + selected.scoped.length;
}

function formatSourceRef(rule: ReviewRule): string {
  const { path, startLine, endLine } = rule.source;
  if (startLine === undefined) return path;
  const end =
    endLine !== undefined && endLine !== startLine ? `-L${endLine}` : '';
  return `${path}#L${startLine}${end}`;
}

function formatRule(rule: ReviewRule): string {
  const scope =
    rule.appliesTo.length > 0
      ? ` Applies to: ${rule.appliesTo.map((glob) => `\`${glob}\``).join(', ')}.`
      : '';
  return `- [${rule.severity.toUpperCase()}] ${rule.rule}${scope} (source: \`${formatSourceRef(rule)}\`)`;
}

/**
 * One line per rule, most severe first, cut at `maxChars` so a huge rule
 * set cannot crowd out the diff.
 */
export function formatRuleList(
  rules: ReviewRule[],
  maxChars = MAX_RULES_SECTION_CHARS,
): string {
  const ordered = [...rules].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const lines: string[] = [];
  let used = 0;
  for (const rule of ordered) {
    const line = formatRule(rule);
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
