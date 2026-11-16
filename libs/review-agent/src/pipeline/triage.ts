import type {
  FileDiffStat,
  RepoWorkspace,
} from '@code-review-agent/agent-tools';
import {
  type ChoiceAnswer,
  decide,
  type DecisionAnswers,
  type DecisionModel,
  type DecisionQuestion,
  emptyTokenUsage,
} from '@code-review-agent/llm';
import type {
  PRMeta,
  ReviewRoute,
  TokenUsage,
} from '@code-review-agent/shared-types';

import { formatIncrementalNote } from '../review-agent.js';

const MAX_TRIAGE_DIFF_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_FOCUS_FILES = 10;
/** Files asked about for focus, largest diffs first; one question each. */
const MAX_FOCUS_CANDIDATES = 50;
/** A file is a focus file when P(likely defect) reaches this. */
const MIN_FOCUS_PROBABILITY = 0.5;

type Tier = ReviewRoute['tier'];

/**
 * How sure the model must be before a cheaper tier replaces a deep review.
 * Skipping posts no review at all, so it needs the most certainty.
 */
const MIN_TIER_CONFIDENCE: Record<Exclude<Tier, 'deep'>, number> = {
  skip: 0.8,
  light: 0.6,
};

const TIER_CRITERIA: Record<Tier, string> = {
  skip: 'No runtime behavior can change: comment or typo fixes, formatting, renames with no semantic effect.',
  light:
    'A small change contained in one area, with no change to public APIs, shared types, security, authentication, concurrency, persistence, or money handling. Test-only changes.',
  deep: 'Anything else, including cross-file contract changes, error-handling paths, data migrations, large diffs, and any case where the right tier is unclear.',
};

/** How each tier reads in the route reason posted on the PR. */
const TIER_REASONS: Record<Tier, string> = {
  skip: 'No runtime behavior can change',
  light: 'Small change contained in one area',
  deep: 'Needs a full review',
};

const TIER_QUESTION: DecisionQuestion = {
  type: 'choice',
  instructions:
    'You triage pull requests for an automated code reviewer. How much review does this pull request need? When in doubt, choose "deep".',
  criteria: TIER_CRITERIA,
};

const TIER_QUESTION_ID = 'tier';
const FOCUS_QUESTION_PREFIX = 'focus_';

export interface TriageInput {
  prMeta: PRMeta;
  workspace: RepoWorkspace;
  /** Commit the last review covered, when the diff is only the new pushes. */
  incrementalSince?: string;
}

export interface TriageResult {
  route: ReviewRoute;
  focusFiles: string[];
  usage: TokenUsage;
}

function formatStats(stats: FileDiffStat[]): string {
  return stats
    .map((s) => `- \`${s.path}\` (+${s.added} / -${s.deleted})`)
    .join('\n');
}

export function buildTriagePrompt(input: TriageInput): string {
  const { prMeta, workspace } = input;
  const description = (prMeta.body ?? '')
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
  const { diff, truncated } = workspace.getPrDiff({
    maxChars: MAX_TRIAGE_DIFF_CHARS,
  });
  const truncationNote = truncated ? '\n(diff truncated)' : '';
  return `## ${prMeta.title}

${description || '_No description provided._'}${formatIncrementalNote(input.incrementalSince)}

### Changed files
${formatStats(workspace.getDiffStats())}

### Diff
\`\`\`diff
${diff}${truncationNote}
\`\`\``;
}

function focusCandidates(workspace: RepoWorkspace): string[] {
  return workspace
    .getDiffStats()
    .sort((a, b) => b.added + b.deleted - (a.added + a.deleted))
    .slice(0, MAX_FOCUS_CANDIDATES)
    .map((stat) => stat.path);
}

function focusQuestion(path: string): DecisionQuestion {
  return {
    type: 'noul',
    instructions: `Is \`${path}\` one of the changed files in this pull request most likely to contain a defect?`,
    criteria: {
      true_description:
        'Its changes are complex, risky, or likely to break callers.',
      false_description: 'Its changes are trivial, mechanical, or test-only.',
    },
  };
}

function buildQuestions(
  candidates: string[],
): Record<string, DecisionQuestion> {
  return {
    [TIER_QUESTION_ID]: TIER_QUESTION,
    ...Object.fromEntries(
      candidates.map((path, i) => [
        `${FOCUS_QUESTION_PREFIX}${i}`,
        focusQuestion(path),
      ]),
    ),
  };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function isTier(value: string): value is Tier {
  return value in TIER_CRITERIA;
}

/** Takes the model's tier only when it is sure enough; otherwise deep. */
function chooseRoute(answer: ChoiceAnswer): ReviewRoute {
  const tier = isTier(answer.choice) ? answer.choice : 'deep';
  const confidence = percent(answer.confidence);
  if (tier !== 'deep' && answer.confidence < MIN_TIER_CONFIDENCE[tier]) {
    return {
      tier: 'deep',
      reason: `Triage leaned ${tier} at ${confidence} confidence, below the ${percent(MIN_TIER_CONFIDENCE[tier])} needed; reviewing at full depth.`,
      source: 'triage',
    };
  }
  return {
    tier,
    reason: `${TIER_REASONS[tier]} (triage confidence ${confidence}).`,
    source: 'triage',
  };
}

/** Changed files the model rates most likely to hold a defect, riskiest first. */
function chooseFocusFiles(
  candidates: string[],
  answers: DecisionAnswers,
): string[] {
  return candidates
    .map((path, i) => ({
      path,
      p: answers.noul(`${FOCUS_QUESTION_PREFIX}${i}`).noul,
    }))
    .filter(({ p }) => p >= MIN_FOCUS_PROBABILITY)
    .sort((a, b) => b.p - a.p)
    .slice(0, MAX_FOCUS_FILES)
    .map(({ path }) => path);
}

/** The route used whenever triage cannot answer: today's full review. */
function fallbackRoute(error: string): ReviewRoute {
  return {
    tier: 'deep',
    reason: `Triage unavailable (${error}); reviewing at full depth.`,
    source: 'fallback',
  };
}

function fallback(error: string, usage = emptyTokenUsage()): TriageResult {
  return { route: fallbackRoute(error), focusFiles: [], usage };
}

/**
 * Asks the decision model how deep a PR's review should be and which files
 * to focus on, in one Decisions API call. Fails open: any error, timeout, or
 * low-confidence answer routes the PR to a deep review.
 */
export async function runTriage(
  model: DecisionModel,
  input: TriageInput,
  timeoutMs: number,
): Promise<TriageResult> {
  if (timeoutMs <= 0) return fallback('no time left');
  const candidates = focusCandidates(input.workspace);
  const result = await decide(model, {
    input: buildTriagePrompt(input),
    questions: buildQuestions(candidates),
    timeoutMs,
  });
  if (!result.ok) return fallback(result.error, result.usage);
  return {
    route: chooseRoute(result.answers.choice(TIER_QUESTION_ID)),
    focusFiles: chooseFocusFiles(candidates, result.answers),
    usage: result.usage,
  };
}
