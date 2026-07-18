import { FunctionTool } from '@google/adk';
import { STATE } from '../constants/state-keys.constant.js';

export interface RepoContextTarget {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
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
      // We always fetch the baseline repository context (prNumber = 0)
      const prKey = `${target.provider}:${target.owner}:${target.repo}:0`;

      const response = await fetch(
        `${gatewayUrl}/api/v1/context/${prKey}`,
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
      let sections: Record<string, string> = {};
      if (doc.summary) {
         try {
            sections = JSON.parse(doc.summary);
         } catch {
            sections = { legacy: doc.summary };
         }
      }

      state.set(STATE.ctxArchitecture, sections['architecture'] ?? '');
      state.set(STATE.ctxModules, sections['modules'] ?? '');
      state.set(STATE.ctxPatterns, sections['patterns'] ?? '');
      state.set(STATE.ctxErrorHandling, sections['errorHandling'] ?? '');
      state.set(STATE.ctxAgentDocs, sections['agentDocs'] ?? '');

      return {
        digest: (sections['architecture'] ?? '').slice(0, 2000),
        sections: Object.keys(sections),
      };
    },
  });
}
