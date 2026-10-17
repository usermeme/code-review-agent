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
} as const;
