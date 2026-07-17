import { FunctionTool } from '@google/adk';
import { STATE } from '../constants/state-keys.constant.js';
import type { RepoContextBuilder } from '../../context/repo-context-builder.service.js';

export interface RepoContextTarget {
  repo: string; // "owner/name"
  ref: string;
  cloneUrl: string;
  token?: string;
}

/**
 * Fetches (or builds) the whole-repo context. The full sections go into
 * session state — where child agents read them — and only a short digest is
 * returned into the orchestrator's context window.
 */
export function createGetRepoContextTool(
  builder: RepoContextBuilder,
  target: RepoContextTarget,
) {
  return new FunctionTool({
    name: 'getRepoContext',
    description:
      'Loads the cached whole-repository context (architecture, modules, internal patterns, ' +
      'error-handling/testing conventions, agent docs), building it if needed. Sections are made ' +
      'available to the reviewer sub-agents automatically; returns a short digest.',
    execute: async (_args, toolContext) => {
      const doc = await builder.getOrBuild(target);
      const state = toolContext!.state;
      state.set(STATE.ctxArchitecture, doc.sections['architecture'] ?? '');
      state.set(STATE.ctxModules, doc.sections['modules'] ?? '');
      state.set(STATE.ctxPatterns, doc.sections['patterns'] ?? '');
      state.set(STATE.ctxErrorHandling, doc.sections['errorHandling'] ?? '');
      state.set(STATE.ctxAgentDocs, doc.sections['agentDocs'] ?? '');
      return {
        digest: (doc.sections['architecture'] ?? '').slice(0, 2000),
        sections: Object.keys(doc.sections),
        builtAt: doc.builtAt,
        headSha: doc.headSha,
        model: doc.model,
      };
    },
  });
}
