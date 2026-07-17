import { FunctionTool } from '@google/adk';
import { STATE } from '../constants/state-keys.constant.js';

export interface RepoContextTarget {
  repo: string; // "owner/name"
  ref: string;
}

export function createGetRepoContextTool(gatewayUrl: string) {
  return new FunctionTool({
    name: 'getRepoContext',
    description:
      'Loads the cached whole-repository context (architecture, modules, internal patterns, ' +
      'error-handling/testing conventions, agent docs). Sections are made ' +
      'available to the reviewer sub-agents automatically; returns a short digest.',
    execute: async (args, toolContext) => {
      const target = args as RepoContextTarget;

      const response = await fetch(
        `${gatewayUrl}/api/context?repo=${encodeURIComponent(target.repo)}&ref=${encodeURIComponent(target.ref)}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      if (!response.ok) {
        throw new Error(
          `Failed to fetch repo context from gateway: ${response.statusText}`,
        );
      }

      const doc = await response.json();
      const state = toolContext.state;
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
      };
    },
  });
}
