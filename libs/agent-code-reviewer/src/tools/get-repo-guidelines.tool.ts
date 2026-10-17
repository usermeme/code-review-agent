import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { type PrMeta, STATE } from '../constants/state-keys.constant.js';

export interface RepoSkillSummary {
  name: string;
  path: string;
  description: string;
}

/**
 * What the orchestrator sees. The rules text itself only goes into session
 * state for the sub-agents: returning it here would put it in the
 * orchestrator's history and re-send it on every later turn.
 */
export interface GetRepoGuidelinesResult {
  rulesChars: number;
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

const MAX_RULE_FILE_CHARS = 8_000;
const MAX_TOTAL_RULES_CHARS = 20_000;
const MAX_SKILLS = 15;
const MAX_SKILL_DESCRIPTION_CHARS = 200;
const IGNORED_SKILL_DIRS = /(^|\/)(node_modules|vendor|dist)\//;

function truncate(text: string, max: number, label: string): string {
  return text.length > max
    ? `${text.slice(0, max)}\n... [${label} truncated: ${text.length} chars]`
    : text;
}

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
      'Fetches the repository agent rules (e.g. AGENTS.md, CLAUDE.md) and discovers available repository skills (e.g. in .agents/skills). Shares the rules with the reviewer sub-agents and returns the rule sources and a skills catalogue.',
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
          rulesChars: 0,
          ruleSources: [],
          skills: [],
          message: 'Git adapter is not configured.',
        };
      }

      if (!owner || !repo) {
        return {
          rulesChars: 0,
          ruleSources: [],
          skills: [],
          message: 'Owner and repo are required.',
        };
      }

      // 1. Fetch candidate rule files
      const collectedRules: string[] = [];
      const ruleSources: string[] = [];

      for (const fileName of CANDIDATE_RULE_FILES) {
        try {
          const res = await deps.gitAdapter.getFileContent(
            owner,
            repo,
            fileName,
            ref,
          );
          if (res?.content && res.content.trim()) {
            collectedRules.push(
              `### ${fileName}\n\n${truncate(res.content.trim(), MAX_RULE_FILE_CHARS, fileName)}`,
            );
            ruleSources.push(fileName);
          }
        } catch {
          // File does not exist, continue
        }
      }

      // 2. Discover available repository skills
      const skills: RepoSkillSummary[] = [];

      try {
        const searchResult = await deps.gitAdapter.searchCode(
          owner,
          repo,
          'filename:SKILL.md',
        );

        // Repos often mirror the same skills for several agent tools
        // (.agents/, .opencode/, ...); fetch each skill directory name once.
        const seenSkillDirs = new Set<string>();
        const skillFiles = (searchResult?.items || [])
          .filter(
            (item) =>
              item.path.endsWith('SKILL.md') &&
              !IGNORED_SKILL_DIRS.test(item.path),
          )
          .filter((item) => {
            const dir = item.path.split('/').slice(-2, -1)[0] ?? item.path;
            if (seenSkillDirs.has(dir)) return false;
            seenSkillDirs.add(dir);
            return true;
          })
          .slice(0, MAX_SKILLS);

        for (const file of skillFiles) {
          try {
            const skillContent = await deps.gitAdapter.getFileContent(
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
              description: (description || 'No description provided.').slice(
                0,
                MAX_SKILL_DESCRIPTION_CHARS,
              ),
            });
          } catch {
            // Failed to fetch specific skill file, skip
          }
        }
      } catch {
        // Code search not available or failed, continue with rules
      }

      const combinedRules = truncate(
        collectedRules.join('\n\n---\n\n'),
        MAX_TOTAL_RULES_CHARS,
        'repository rules',
      );

      const state = ctx?.state;
      if (state) {
        if (combinedRules) {
          state.set(STATE.ctxAgentDocs, combinedRules);
          state.set(STATE.repoRules, combinedRules);
        }
        state.set(STATE.repoSkills, skills);
      }

      return {
        rulesChars: combinedRules.length,
        ruleSources,
        skills,
        message: combinedRules
          ? 'Rules loaded and shared with the reviewer sub-agents.'
          : 'No agent rules found in repository.',
      };
    },
  });
}
