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
} as const;

export interface PrMeta {
  repo: string; // "owner/name"
  number: number;
  title: string;
  body: string;
  branch: string;
  author: string;
  headSha: string;
}
