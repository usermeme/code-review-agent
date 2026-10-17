/** Hard guardrail limits enforced in code (not just in prompts). */
export const LIMITS = {
  /** Maximum number of findings published per review. */
  maxFindings: 15,
  /** Findings below this confidence are dropped before publishing. */
  confidenceThreshold: 0.75,
  /** Diff tokens included in the orchestrator's own view (reviewers get the full diff via state). */
  maxDiffTokensInOrchestratorPrompt: 2_500,
  /** Upper bound on LLM calls for a single review invocation (runaway guard). */
  maxLlmCalls: 40,
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
