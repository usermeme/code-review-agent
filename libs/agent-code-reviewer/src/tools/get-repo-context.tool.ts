import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { STATE } from '../constants/state-keys.constant.js';

export interface RepoContextTarget {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
}

export type ContextLoader = (
  key: string,
) => Promise<Record<string, string> | null>;

export interface GetRepoContextToolDependencies {
  contextLoader?: ContextLoader;
}

export function createGetRepoContextTool(
  deps: GetRepoContextToolDependencies = {},
) {
  return new FunctionTool({
    name: 'getRepoContext',
    description:
      'Loads the cached whole-repository context (architecture, modules, internal patterns, ' +
      'error-handling/testing conventions, agent docs). Sections are made ' +
      'available to the reviewer sub-agents automatically; returns a short digest.',
    parameters: z.object({
      provider: z.string().optional().describe('Git provider (e.g. github)'),
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
    }),
    execute: async (args, toolContext) => {
      const target = (args || {}) as Partial<RepoContextTarget>;
      const meta = toolContext?.state?.get<Partial<RepoContextTarget>>(
        STATE.prMeta,
      );

      const provider = target.provider || meta?.provider || 'github';
      const owner = target.owner || meta?.owner || '';
      const repo = target.repo || meta?.repo || '';

      if (!owner || !repo) {
        throw new Error(
          'Owner and repository name are required to fetch repository context.',
        );
      }

      const prKey = `${provider}:${owner}:${repo}:0`;
      const directContext = toolContext?.state?.get<
        string | Record<string, string>
      >('baselineContext');
      let sections: Record<string, string> = {};

      if (directContext) {
        if (typeof directContext === 'object') {
          sections = directContext;
        } else {
          try {
            sections = JSON.parse(directContext);
          } catch {
            sections = { architecture: directContext };
          }
        }
      } else if (deps.contextLoader) {
        const loaded = await deps.contextLoader(prKey);
        if (loaded) {
          sections = loaded;
        }
      }

      const state = toolContext?.state;
      state?.set(STATE.ctxArchitecture, sections['architecture'] ?? '');
      state?.set(STATE.ctxModules, sections['modules'] ?? '');
      state?.set(STATE.ctxPatterns, sections['patterns'] ?? '');
      state?.set(STATE.ctxErrorHandling, sections['errorHandling'] ?? '');
      state?.set(STATE.ctxAgentDocs, sections['agentDocs'] ?? '');

      return {
        digest: (sections['architecture'] ?? '').slice(0, 2000),
        sections: Object.keys(sections),
      };
    },
  });
}
