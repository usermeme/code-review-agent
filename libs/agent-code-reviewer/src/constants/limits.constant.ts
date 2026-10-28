/** Hard guardrail limits enforced in code (not just in prompts). */
export const LIMITS = {
  /** Findings below this confidence are dropped before publishing. */
  confidenceThreshold: 0.75,
  /**
   * Runaway guard on findings published per review. Not an editorial cap —
   * every valid finding should survive — but a runaway model output must not
   * translate into hundreds of inline PR comments. The list is ranked by
   * severity/confidence before the cap, so the most important survive.
   */
  maxFindingsPerReview: 50,
  /**
   * Upper bound on LLM calls for a single review, shared by the orchestrator
   * and every sub-agent (runaway guard). ADK's RunConfig.maxLlmCalls alone
   * does not reach sub-agents: each AgentTool call starts a fresh Runner
   * with the default of 500.
   */
  maxLlmCalls: 40,
  /**
   * Hard wall-clock limit per review. Timeout budget chain: the Pub/Sub push
   * ack deadline is 600s and the Cloud Run request timeout is 900s, so the
   * TOTAL request wall-time (diff fetch + baseline resolution + review) must
   * stay safely under the ack deadline — target <= 540s — or the event is
   * redelivered mid-review and the whole review (and its LLM spend) runs
   * twice. 480s leaves that headroom; hosts may lower it via the
   * REVIEW_TIMEOUT_MS env (validated <= 540_000).
   */
  reviewTimeoutMs: 8 * 60_000,
  /** Total diff size (chars) after filtering — the diff is re-sent on every reviewer turn. */
  maxDiffChars: 120_000,
  /** Per-file diff cap (chars) before the file is truncated. */
  maxFileDiffChars: 20_000,
  /** Per-file cap (chars) on repository rule files (AGENTS.md, CLAUDE.md, ...). */
  maxRuleFileChars: 8_000,
  /** Combined cap (chars) on rule text staged into state for reviewers. */
  maxTotalRuleChars: 20_000,
  /** Repository lookups (searchRepositoryCode / fetchRepositoryFile) per reviewer sub-agent. */
  maxSubAgentRepoToolCalls: 3,
  /** Dispatches of the reviewer tool per review (one retry for failed reviewers). */
  maxSubAgentCalls: 2,
  /**
   * Concurrency cap for LLM-backed work dispatched in parallel (reviewer
   * sub-agent runs here; per-chunk context summaries use the matching cap in
   * agent-context-builder). Kept in the 4–6 range: enough to cut wall-time
   * well below the Pub/Sub ack deadline without provoking Gemini 429 storms.
   * Rate-limit retries with exponential backoff + jitter live in the LLM
   * wrapper (see @code-review-agent/llm RetryingLlm).
   */
  maxLlmConcurrency: 5,
  /** Maximum number of repository skill bodies staged for reviewers. */
  maxLoadedSkills: 5,
  /** Per-skill body cap (chars) when staging SKILL.md bodies for reviewers. */
  maxSkillBodyChars: 20_000,
  /** Combined cap (chars) across all staged skill bodies. */
  maxTotalSkillChars: 48_000,
  /** Hard cap (chars) on a published finding body — longer bodies are truncated. */
  maxFindingBodyChars: 700,
  /** Maximum SKILL.md files fetched to build the repository skills catalogue. */
  maxSkillCatalogueEntries: 20,
} as const;
