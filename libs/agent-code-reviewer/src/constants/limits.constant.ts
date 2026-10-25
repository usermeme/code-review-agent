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
  /** Hard wall-clock limit per review; kept below the Pub/Sub ack deadline (600s). */
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
  /** Calls per reviewer sub-agent (one retry for an unusable result). */
  maxSubAgentCalls: 2,
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
