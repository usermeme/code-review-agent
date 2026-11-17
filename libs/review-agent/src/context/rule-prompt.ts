import type { RepoWorkspace } from '@code-review-agent/agent-tools';

import { formatRuleList, type SelectedRules } from './select-rules.js';

const RULES_INTRO = `Rules extracted from this repository's guideline and skill files (base branch). Report a clear violation in the changed code as a finding, at the rule's severity unless the impact is clearly different. When a rule is unclear, read its source with \`read_file\`.`;

function formatGuidelinesSection(workspace: RepoWorkspace): string {
  const guidelines = workspace.getRepoGuidelines();
  if (!guidelines) return '';
  return `\n\n## Repository Guidelines\nFollow these project-specific conventions when reviewing:\n\n${guidelines}`;
}

function formatSkillsSection(workspace: RepoWorkspace): string {
  const index = workspace.getRepoSkillsIndex();
  return index ? `\n\n## Repository Skills\n${index}` : '';
}

function formatGlobalRulesSection(rules: SelectedRules): string {
  const list = formatRuleList(rules.global);
  return list ? `\n\n## Repository Rules\n${RULES_INTRO}\n\n${list}` : '';
}

/**
 * Repository section of a system instruction: the repo-wide rules when a
 * review context was resolved, otherwise the raw guidelines and the skills
 * index. Both are the same for every PR of a repository.
 */
export function formatRepositoryInstruction(
  workspace: RepoWorkspace,
  rules: SelectedRules | undefined,
): string {
  if (rules) return formatGlobalRulesSection(rules);
  return `${formatGuidelinesSection(workspace)}${formatSkillsSection(workspace)}`;
}

/** Per-PR section listing the path-scoped rules this PR's files match. */
export function formatScopedRulesSection(
  rules: SelectedRules | undefined,
): string {
  const list = rules ? formatRuleList(rules.scoped) : '';
  if (!list) return '';
  return `\n\n### Rules for the Changed Paths\nRepository rules that cover the files in this PR:\n${list}`;
}
