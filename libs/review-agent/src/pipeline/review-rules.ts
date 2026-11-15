import { createPathMatcher } from '@code-review-agent/agent-tools';
import type { PRMeta, ReviewRoute } from '@code-review-agent/shared-types';

/**
 * Paths that always get a deep review, without asking triage. Override with
 * the comma-separated `DEEP_REVIEW_PATHS` env var.
 */
export const DEFAULT_DEEP_REVIEW_PATHS = [
  '**/auth/**',
  '**/security/**',
  '**/migrations/**',
  '**/*.sql',
  '.github/workflows/**',
  '**/Dockerfile',
  '**/*.tf',
];

/** Files whose changes cannot alter runtime behavior. */
const NON_CODE_PATHS = [
  '**/*.md',
  '**/*.mdx',
  '**/*.rst',
  '**/*.txt',
  'docs/**',
  'LICENSE*',
  '**/__snapshots__/**',
  '**/*.snap',
  '**/*.generated.*',
];

const SKIP_MARKER = /\[(?:skip|no)[ -]review\]/i;

type Matcher = (path: string) => boolean;

function compileMatchers(patterns: string[]): Matcher[] {
  return patterns.map((pattern) => createPathMatcher(pattern));
}

const NON_CODE_MATCHERS = compileMatchers(NON_CODE_PATHS);

function matchesAny(path: string, matchers: Matcher[]): boolean {
  return matchers.some((matches) => matches(path));
}

function skip(reason: string): ReviewRoute {
  return { tier: 'skip', reason, source: 'rule' };
}

function hasSkipMarker(meta: PRMeta): boolean {
  return SKIP_MARKER.test(meta.title) || SKIP_MARKER.test(meta.body ?? '');
}

function isNonCodeChange(changedFiles: string[]): boolean {
  return changedFiles.every((path) => matchesAny(path, NON_CODE_MATCHERS));
}

/**
 * Free, deterministic checks that run before any model call. Returns a skip
 * route when the PR should not be reviewed, or `null` to continue. A
 * `/review` comment (`manual_trigger`) bypasses every rule.
 */
interface SkipRule {
  applies: (meta: PRMeta, changedFiles: string[]) => boolean;
  reason: string;
}

/** Checked in order; the first rule that applies wins. */
const SKIP_RULES: SkipRule[] = [
  {
    applies: (meta) => Boolean(meta.isDraft),
    reason: 'Draft PR; it is reviewed once marked ready.',
  },
  {
    applies: (meta) => meta.author.endsWith('[bot]'),
    reason: 'Opened by a bot account.',
  },
  {
    applies: (meta) => hasSkipMarker(meta),
    reason: 'The PR asks to skip review.',
  },
  {
    applies: (_meta, changedFiles) => isNonCodeChange(changedFiles),
    reason: 'Only documentation or generated files changed.',
  },
];

export function evaluateSkipRules(
  meta: PRMeta,
  changedFiles: string[],
): ReviewRoute | null {
  if (meta.action === 'manual_trigger') return null;
  const rule = SKIP_RULES.find((r) => r.applies(meta, changedFiles));
  return rule ? skip(rule.reason) : null;
}

/** Returns a deep route when any changed file matches a deep-review path. */
export function evaluateDeepReviewPaths(
  changedFiles: string[],
  deepReviewPaths: string[],
): ReviewRoute | null {
  const matchers = compileMatchers(deepReviewPaths);
  const match = changedFiles.find((path) => matchesAny(path, matchers));
  if (!match) return null;
  return {
    tier: 'deep',
    reason: `Changes a path that always gets a deep review (${match}).`,
    source: 'rule',
  };
}
