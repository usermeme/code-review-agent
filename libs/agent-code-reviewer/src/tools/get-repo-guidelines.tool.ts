import {
  type CodeSearchItem,
  type GitAdapterContract,
} from '@code-review-agent/shared-types';
import { type Context, FunctionTool } from '@google/adk';
import { z } from 'zod';

import { LIMITS } from '../constants/limits.constant.js';
import { type PrMeta, STATE } from '../constants/state-keys.constant.js';
import {
  fetchCachedRepoFile,
  readPinnedCoordinates,
  type RepoFileFetcher,
  type RepoToolDependencies,
} from './repo-tool-context.util.js';

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

export type GetRepoGuidelinesToolDependencies = RepoToolDependencies;

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

function emptyGuidelinesResult(message: string): GetRepoGuidelinesResult {
  return {
    rules: '',
    ruleSources: [],
    skills: [],
    message,
  };
}

function validateGuidelinesRequest(
  deps: GetRepoGuidelinesToolDependencies,
  owner: string,
  repo: string,
): { error: string } | { gitAdapter: GitAdapterContract } {
  if (!deps.gitAdapter) {
    return { error: 'Git adapter is not configured.' };
  }

  if (!owner || !repo) {
    return { error: 'Owner and repo are required.' };
  }

  return { gitAdapter: deps.gitAdapter };
}

async function readRuleFile(
  fetcher: RepoFileFetcher,
  fileName: string,
): Promise<{ fileName: string; content: string } | null> {
  try {
    const content = await fetchCachedRepoFile(fetcher, fileName);
    if (content.trim()) {
      return { fileName, content: content.trim() };
    }
  } catch {
    // File does not exist, continue
  }
  return null;
}

function collectRuleResults(
  ruleResults: Array<{ fileName: string; content: string } | null>,
): { collectedRules: string[]; ruleSources: string[] } {
  const collectedRules: string[] = [];
  const ruleSources: string[] = [];
  for (const result of ruleResults) {
    if (!result) continue;
    collectedRules.push(
      `### ${result.fileName}\n\n${truncate(result.content, LIMITS.maxRuleFileChars, result.fileName)}`,
    );
    ruleSources.push(result.fileName);
  }
  return { collectedRules, ruleSources };
}

function selectSkillFiles(items: CodeSearchItem[]): CodeSearchItem[] {
  // Cap the fetch fan-out: a repo with hundreds of SKILL.md files must
  // not turn catalogue discovery into hundreds of adapter round-trips.
  // Repos often mirror the same skills for several agent tools
  // (.agents/, .opencode/, ...); fetch each skill directory name once.
  const seenSkillDirs = new Set<string>();
  return items
    .filter(
      (item) =>
        item.path.endsWith('SKILL.md') && !IGNORED_SKILL_DIRS.test(item.path),
    )
    .filter((item) => {
      const dir = item.path.split('/').slice(-2, -1)[0] ?? item.path;
      if (seenSkillDirs.has(dir)) return false;
      seenSkillDirs.add(dir);
      return true;
    })
    .slice(0, LIMITS.maxSkillCatalogueEntries);
}

function resolveSkillName(
  name: string | undefined,
  file: CodeSearchItem,
): string {
  return name || file.path.split('/').slice(-2, -1)[0] || file.name;
}

async function readSkillSummary(
  fetcher: RepoFileFetcher,
  file: CodeSearchItem,
): Promise<RepoSkillSummary | null> {
  try {
    const rawContent = await fetchCachedRepoFile(fetcher, file.path);
    if (!rawContent) return null;
    const { name, description } = parseSkillFrontmatter(rawContent);
    const skillName = resolveSkillName(name, file);
    return {
      name: skillName,
      path: file.path,
      description: description || 'No description provided.',
    } satisfies RepoSkillSummary;
  } catch {
    // Failed to fetch specific skill file, skip
    return null;
  }
}

async function discoverRepoSkills(
  fetcher: RepoFileFetcher,
): Promise<RepoSkillSummary[]> {
  try {
    const searchResult = await fetcher.gitAdapter.searchCode(
      fetcher.owner,
      fetcher.repo,
      'filename:SKILL.md',
    );
    const skillFiles = selectSkillFiles(searchResult?.items || []);

    const skillResults = await Promise.all(
      skillFiles.map((file) => readSkillSummary(fetcher, file)),
    );
    return skillResults.filter((s) => s !== null);
  } catch {
    // Code search not available or failed, continue with rules
    return [];
  }
}

function storeGuidelinesState(
  ctx: Context | undefined,
  combinedRules: string,
  skills: RepoSkillSummary[],
): void {
  const state = ctx?.state;
  if (state) {
    if (combinedRules) {
      state.set(STATE.ctxAgentDocs, combinedRules);
    }
    state.set(STATE.repoSkills, skills);
  }
}

export function createGetRepoGuidelinesTool(
  deps: GetRepoGuidelinesToolDependencies = {},
) {
  const fileCache = deps.cache ?? new Map<string, string>();

  return new FunctionTool({
    name: 'getRepoGuidelines',
    description:
      'Fetches the repository agent rules (e.g. AGENTS.md, CLAUDE.md) and discovers available repository skills (e.g. in .agents/skills). Returns rules and a skills catalogue.',
    parameters: z.object({}),
    execute: async (_input, ctx): Promise<GetRepoGuidelinesResult> => {
      const meta = ctx?.state?.get<PrMeta>(STATE.prMeta);
      const { owner, repo, ref } = readPinnedCoordinates(meta, deps);

      const validation = validateGuidelinesRequest(deps, owner, repo);
      if ('error' in validation) {
        return emptyGuidelinesResult(validation.error);
      }
      const fetcher: RepoFileFetcher = {
        gitAdapter: validation.gitAdapter,
        fileCache,
        owner,
        repo,
        ref,
      };

      // 1. Fetch candidate rule files (in parallel — this sits on the
      // critical path of every review)
      const ruleResults = await Promise.all(
        CANDIDATE_RULE_FILES.map((fileName) => readRuleFile(fetcher, fileName)),
      );
      const { collectedRules, ruleSources } = collectRuleResults(ruleResults);

      // 2. Discover available repository skills
      const skills = await discoverRepoSkills(fetcher);

      // Capped: the rules are returned to the orchestrator, whose history is
      // re-sent on every later turn.
      const combinedRules = truncate(
        collectedRules.join('\n\n---\n\n'),
        LIMITS.maxTotalRuleChars,
        'repository rules',
      );

      storeGuidelinesState(ctx, combinedRules, skills);

      return {
        rules: combinedRules || '(no agent rules found in repository)',
        ruleSources,
        skills,
      };
    },
  });
}
