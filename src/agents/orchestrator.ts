import { AgentTool, LlmAgent, type BaseTool, type ReadonlyContext } from '@google/adk';
import type { AppConfig } from '../config/schema.js';
import { resolveModel } from '../models/model-config.js';
import { estimateTokens } from '../util/tokens.js';
import { createProblemsAgent } from './problems-agent.js';
import { createQualityAgent } from './quality-agent.js';
import { createTicketAgent } from './ticket-agent.js';
import type { ReviewSkill } from './review-skill.js';
import { STATE, type PrMeta } from './state-keys.js';

const MAX_DIFF_TOKENS_IN_PROMPT = 50_000;

function instruction(cfg: AppConfig, skill: ReviewSkill) {
  return (ctx: ReadonlyContext): string => {
    const meta = ctx.state.get<PrMeta>(STATE.prMeta);
    let diff = ctx.state.get<string>(STATE.diff) ?? '';
    if (estimateTokens(diff) > MAX_DIFF_TOKENS_IN_PROMPT) {
      diff =
        diff.slice(0, MAX_DIFF_TOKENS_IN_PROMPT * 4) +
        '\n... [diff truncated for the orchestrator; sub-agents received it in full]';
    }
    return `You orchestrate the code review of a pull request and produce the final review plan.

This review philosophy governs which findings survive to the final plan — filter, rank, and write
the summary by it (severity taxonomy, what's worth a comment vs let go, don't cry wolf, the summary
leads with the verdict and the criticals):
${skill.core}

PR: ${meta?.repo}#${meta?.number} "${meta?.title}" by @${meta?.author} (branch ${meta?.branch})
PR description:
${meta?.body || '(empty)'}

Diff:
${diff}

Follow these steps IN ORDER:
1. Call getRepoContext to load the repository context (it is shared with the reviewer sub-agents automatically).
2. Call the three reviewer sub-agents — ticket_comparison_agent, code_problems_agent, code_quality_agent.
   They already see the diff and the repo context; pass each a one-paragraph "focus" hint tailored to
   this PR (e.g. which modules are touched, what looks risky).
3. For each candidate finding worth publishing, call getDiscussion with a short query describing it.
   Drop findings the team has previously discussed and explicitly rejected; where a past discussion
   supports a finding, mention it in the finding body.
4. Deduplicate and merge overlapping findings. Apply the review philosophy above: drop findings
   without a concrete failure scenario, drop what it says to let go, keep severities honest. When a
   finding's validity hinges on code you cannot see (a caller, a guard that might exist above the
   hunk), check with readFile/searchRepo when available — a few targeted calls, not a re-review.
   Keep at most ${cfg.triggers.maxFindings} findings, ordered by severity (critical first).
5. Reply with ONLY a fenced json code block containing the final review plan:
   {"summary": "<overall verdict paragraph, markdown>",
    "ticketCoverage": "<markdown section on ticket completeness, from the ticket agent's report>",
    "findings": [{"title", "severity": "critical"|"major"|"minor", "path", "startLine", "endLine",
                  "body", "confidence": 0..1, "suggestion"?}]}
   Line numbers must refer to the NEW side of the diff — the diff's left column shows exactly these
   numbers. "suggestion" must contain only replacement code for exactly the flagged lines. No text
   outside the json block.`;
  };
}

export interface OrchestratorTools {
  getRepoContext: BaseTool;
  getDiscussion: BaseTool;
  storeDiscussion: BaseTool;
  /** readFile/searchRepo over the PR head checkout; empty when the clone failed. */
  repoFiles: BaseTool[];
}

export function createOrchestrator(cfg: AppConfig, tools: OrchestratorTools, skill: ReviewSkill): LlmAgent {
  return new LlmAgent({
    name: 'core_review_agent',
    description: 'Parent agent orchestrating the full PR review.',
    model: resolveModel(cfg, cfg.models.agents.orchestrator),
    instruction: instruction(cfg, skill),
    tools: [
      tools.getRepoContext,
      tools.getDiscussion,
      tools.storeDiscussion,
      ...tools.repoFiles,
      new AgentTool({ agent: createTicketAgent(cfg), skipSummarization: true }),
      new AgentTool({
        agent: createProblemsAgent(cfg, skill),
        skipSummarization: true,
      }),
      new AgentTool({
        agent: createQualityAgent(cfg, skill),
        skipSummarization: true,
      }),
    ],
  });
}
