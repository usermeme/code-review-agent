import type {
  FileDiffStat,
  RepoWorkspace,
} from '@code-review-agent/agent-tools';
import { emptyTokenUsage, generateJson } from '@code-review-agent/llm';
import type {
  PRMeta,
  ReviewRoute,
  TokenUsage,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import { z } from 'zod';

import { formatIncrementalNote } from '../review-agent.js';

const MAX_TRIAGE_DIFF_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_FOCUS_FILES = 10;

export const triageDecisionSchema = z.object({
  tier: z
    .enum(['skip', 'light', 'deep'])
    .describe('How much review the PR needs.'),
  reason: z
    .string()
    .min(1)
    .max(300)
    .describe('One sentence explaining the choice.'),
  focusFiles: z
    .array(z.string())
    .max(MAX_FOCUS_FILES)
    .describe('Changed files most likely to contain defects, riskiest first.'),
});

export type TriageDecision = z.infer<typeof triageDecisionSchema>;

const TRIAGE_INSTRUCTION = `You triage pull requests for an automated code reviewer. Pick how much review each PR needs:

- "skip": no runtime behavior can change. Comment or typo fixes, formatting, renames with no semantic effect.
- "light": a small change contained in one area, with no change to public APIs, shared types, security, authentication, concurrency, persistence, or money handling. Test-only changes.
- "deep": anything else, including cross-file contract changes, error-handling paths, data migrations, large diffs, and any case you are unsure about.

When in doubt, choose "deep". List the changed files most likely to contain defects in "focusFiles", riskiest first.`;

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

function keepChangedFiles(files: string[], workspace: RepoWorkspace): string[] {
  const changed = new Set(workspace.getPrDiff({ maxChars: 0 }).changedFiles);
  return files.filter((file) => changed.has(file));
}

/** The route used whenever triage cannot answer: today's full review. */
function fallbackRoute(error: string): ReviewRoute {
  return {
    tier: 'deep',
    reason: `Triage unavailable (${error}); reviewing at full depth.`,
    source: 'fallback',
  };
}

/**
 * Asks the triage model how deep a PR's review should be. Fails open: any
 * error or timeout routes the PR to a deep review.
 */
export async function runTriage(
  llm: BaseLlm,
  input: TriageInput,
  timeoutMs: number,
): Promise<TriageResult> {
  if (timeoutMs <= 0) {
    return {
      route: fallbackRoute('no time left'),
      focusFiles: [],
      usage: emptyTokenUsage(),
    };
  }
  const result = await generateJson(llm, {
    systemInstruction: TRIAGE_INSTRUCTION,
    prompt: buildTriagePrompt(input),
    schema: triageDecisionSchema,
    timeoutMs,
  });
  if (!result.ok) {
    return {
      route: fallbackRoute(result.error),
      focusFiles: [],
      usage: result.usage,
    };
  }
  const { tier, reason, focusFiles } = result.value;
  return {
    route: { tier, reason, source: 'triage' },
    focusFiles: keepChangedFiles(focusFiles, input.workspace),
    usage: result.usage,
  };
}
