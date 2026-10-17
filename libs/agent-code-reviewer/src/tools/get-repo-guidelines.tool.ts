import type { GitAdapterContract } from '@code-review-agent/shared-types';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

import { LIMITS } from '../constants/limits.constant.js';
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
      'Fetches the repository agent rules (e.g. AGENTS.md, CLAUDE.md) and discovers available repository skills (e.g. in .agents/skills). Returns rules and a skills catalogue.',
    parameters: z.object({}),
    execute: async (_input, ctx): Promise<GetRepoGuidelinesResult> => {
      const meta = ctx?.state?.get<PrMeta>(STATE.prMeta);
      // Owner/repo/ref are fixed to the PR under review (state/deps only) —
      // a prompt-injected agent cannot point this tool at another repository.
      const owner = meta?.owner || deps.defaultOwner || '';
      const repo = meta?.repo || deps.defaultRepo || '';
      const ref = meta?.branch;

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
        collectedRules.push(
          `### ${result.fileName}\n\n${truncate(result.content, LIMITS.maxRuleFileChars, result.fileName)}`,
        );
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

        // Cap the fetch fan-out: a repo with hundreds of SKILL.md files must
        // not turn catalogue discovery into hundreds of adapter round-trips.
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
          .slice(0, LIMITS.maxSkillCatalogueEntries);

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

      // Capped: the rules are returned to the orchestrator, whose history is
      // re-sent on every later turn.
      const combinedRules = truncate(
        collectedRules.join('\n\n---\n\n'),
        LIMITS.maxTotalRuleChars,
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
        rules: combinedRules || '(no agent rules found in repository)',
        ruleSources,
        skills,
      };
    },
  });
}
