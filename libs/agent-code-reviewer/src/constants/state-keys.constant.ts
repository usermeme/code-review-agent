/**
 * Session-state keys shared between the orchestrator, its tools, and the
 * child agents. AgentTool seeds each child's session with a copy of the
 * parent's state, so anything written here is visible to the children —
 * that's the mechanism for passing repo-context slices without re-emitting
 * them through the LLM.
 */
export const STATE = {
  diff: 'review:diff',
  changedFiles: 'review:changedFiles',
  prMeta: 'review:prMeta',
  tickets: 'review:tickets',
  ctxArchitecture: 'repoctx:architecture',
  ctxModules: 'repoctx:modules',
  ctxPatterns: 'repoctx:patterns',
  ctxErrorHandling: 'repoctx:errorHandling',
  ctxAgentDocs: 'repoctx:agentDocs',
  repoRules: 'repo:rules',
  repoSkills: 'repo:skills',
} as const;

export interface PrMeta {
  provider: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body?: string;
  /** PR head branch. */
  branch: string;
  /** PR base branch. */
  baseRef?: string;
  author: string;
}
