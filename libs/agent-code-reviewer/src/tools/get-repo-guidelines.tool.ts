import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { type PrMeta, STATE } from '../constants/state-keys.constant.js';

export interface RepoSkillSummary {
  name: string;
  path: string;
  description: string;
}

export interface GetRepoGuidelinesResult {
  rules: string;
  ruleSources: string[];
  skills: RepoSkillSummary[];
  message?: string;
}

export interface GetRepoGuidelinesToolDependencies {
  gitAdapter?: GitAdapterContract;
  defaultOwner?: string;
  defaultRepo?: string;
}

const CANDIDATE_RULE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  'CONTRIBUTING.md',
];

export function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---/;
  const match = frontmatterRegex.exec(content);
  if (!match) return {};

  const lines = match[1].split('\n');
  let name: string | undefined;
  let description: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('name:')) {
      name = trimmed
        .slice(5)
        .trim()
        .replace(/^['"]|['"]$/g, '');
    } else if (trimmed.startsWith('description:')) {
      description = trimmed
        .slice(12)
        .trim()
        .replace(/^['"]|['"]$/g, '');
    }
  }

  return { name, description };
}

export function createGetRepoGuidelinesTool(
  deps: GetRepoGuidelinesToolDependencies = {},
) {
  return new FunctionTool({
    name: 'getRepoGuidelines',
    description:
      'Fetches the repository agent rules (e.g. AGENTS.md, CLAUDE.md) and discovers available repository skills (e.g. in .agents/skills). Returns rules and a skills catalogue.',
    parameters: z.object({
      owner: z.string().optional().describe('Repository owner'),
      repo: z.string().optional().describe('Repository name'),
      ref: z.string().optional().describe('Git branch or ref'),
    }),
    execute: async (input, ctx): Promise<GetRepoGuidelinesResult> => {
      const meta = ctx?.state?.get<PrMeta>(STATE.prMeta);
      const owner = input.owner || meta?.owner || deps.defaultOwner || '';
      const repo = input.repo || meta?.repo || deps.defaultRepo || '';
      const ref = input.ref || meta?.branch;

      if (!deps.gitAdapter) {
        return {
          rules: '',
          ruleSources: [],
          skills: [],
          message: 'Git adapter is not configured.',
        };
      }

      if (!owner || !repo) {
        return {
          rules: '',
          ruleSources: [],
          skills: [],
          message: 'Owner and repo are required.',
        };
      }

      // 1. Fetch candidate rule files (in parallel — this sits on the
      // critical path of every review)
      const ruleResults = await Promise.all(
        CANDIDATE_RULE_FILES.map(async (fileName) => {
          try {
            const res = await deps.gitAdapter?.getFileContent(
              owner,
              repo,
              fileName,
              ref,
            );
            if (res?.content && res.content.trim()) {
              return { fileName, content: res.content.trim() };
            }
          } catch {
            // File does not exist, continue
          }
          return null;
        }),
      );

      const collectedRules: string[] = [];
      const ruleSources: string[] = [];
      for (const result of ruleResults) {
        if (!result) continue;
        collectedRules.push(`### ${result.fileName}\n\n${result.content}`);
        ruleSources.push(result.fileName);
      }

      // 2. Discover available repository skills
      const skills: RepoSkillSummary[] = [];

      try {
        const searchResult = await deps.gitAdapter.searchCode(
          owner,
          repo,
          'filename:SKILL.md',
        );

        const skillFiles = (searchResult?.items || []).filter((item) =>
          item.path.endsWith('SKILL.md'),
        );

        const skillResults = await Promise.all(
          skillFiles.map(async (file) => {
            try {
              const skillContent = await deps.gitAdapter?.getFileContent(
                owner,
                repo,
                file.path,
                ref,
              );
              if (!skillContent) return null;
              const { name, description } = parseSkillFrontmatter(
                skillContent.content,
              );
              const skillName =
                name || file.path.split('/').slice(-2, -1)[0] || file.name;
              return {
                name: skillName,
                path: file.path,
                description: description || 'No description provided.',
              } satisfies RepoSkillSummary;
            } catch {
              // Failed to fetch specific skill file, skip
              return null;
            }
          }),
        );
        skills.push(...skillResults.filter((s) => s !== null));
      } catch {
        // Code search not available or failed, continue with rules
      }

      const combinedRules = collectedRules.join('\n\n---\n\n');

      const state = ctx?.state;
      if (state) {
        if (combinedRules) {
          state.set(STATE.ctxAgentDocs, combinedRules);
          state.set(STATE.repoRules, combinedRules);
        }
        state.set(STATE.repoSkills, skills);
      }

      return {
        rules: combinedRules || '(no agent rules found in repository)',
        ruleSources,
        skills,
      };
    },
  });
}
