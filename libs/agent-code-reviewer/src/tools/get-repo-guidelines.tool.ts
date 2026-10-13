import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { STATE } from '../constants/state-keys.constant.js';
import type { RepoScope } from './repo-scope.js';

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
  scope: RepoScope;
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
  deps: GetRepoGuidelinesToolDependencies,
) {
  // Rules come from the base branch: the PR's own edits to AGENTS.md/CLAUDE.md
  // are part of the change under review, not instructions for reviewing it.
  const { gitAdapter, owner, repo, baseRef: ref } = deps.scope;

  return new FunctionTool({
    name: 'getRepoGuidelines',
    description:
      'Fetches the repository agent rules (e.g. AGENTS.md, CLAUDE.md) and discovers available repository skills (e.g. in .agents/skills). Returns rules and a skills catalogue.',
    parameters: z.object({}),
    execute: async (_input, ctx): Promise<GetRepoGuidelinesResult> => {
      // 1. Fetch candidate rule files
      const collectedRules: string[] = [];
      const ruleSources: string[] = [];

      for (const fileName of CANDIDATE_RULE_FILES) {
        try {
          const res = await gitAdapter.getFileContent(
            owner,
            repo,
            fileName,
            ref,
          );
          if (res?.content && res.content.trim()) {
            collectedRules.push(`### ${fileName}\n\n${res.content.trim()}`);
            ruleSources.push(fileName);
          }
        } catch {
          // File does not exist, continue
        }
      }

      // 2. Discover available repository skills
      const skills: RepoSkillSummary[] = [];

      try {
        const searchResult = await gitAdapter.searchCode(
          owner,
          repo,
          'filename:SKILL.md',
        );

        const skillFiles = (searchResult?.items || []).filter((item) =>
          item.path.endsWith('SKILL.md'),
        );

        for (const file of skillFiles) {
          try {
            const skillContent = await gitAdapter.getFileContent(
              owner,
              repo,
              file.path,
              ref,
            );
            const { name, description } = parseSkillFrontmatter(
              skillContent.content,
            );
            const skillName =
              name || file.path.split('/').slice(-2, -1)[0] || file.name;
            skills.push({
              name: skillName,
              path: file.path,
              description: description || 'No description provided.',
            });
          } catch {
            // Failed to fetch specific skill file, skip
          }
        }
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
