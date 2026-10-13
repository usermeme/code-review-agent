import type { AgentDoc } from '@code-review-agent/shared-types';

import type { RepoFile } from './file-walker.js';

const DOC_NAMES = new Set([
  'agents.md',
  'claude.md',
  '.cursorrules',
  'contributing.md',
]);

function isAgentDoc(path: string): boolean {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  if (DOC_NAMES.has(base)) return true;
  return path.startsWith('.claude/') && path.endsWith('.md');
}

/**
 * Convention docs (AGENTS.md, CLAUDE.md, skills, cursor rules) are already
 * distilled guidance — they go into the context verbatim, never summarized.
 */
export function collectAgentDocs(files: RepoFile[]): AgentDoc[] {
  return files
    .filter((file) => isAgentDoc(file.path))
    .map((file) => ({ path: file.path, content: file.content }));
}

/**
 * Applies a PR's changes to the baseline docs: changed docs replace their
 * previous version, deleted paths are dropped, untouched docs are kept.
 */
export function mergeAgentDocs(
  existing: AgentDoc[],
  changed: AgentDoc[],
  deletedPaths: string[],
): AgentDoc[] {
  const byPath = new Map(existing.map((doc) => [doc.path, doc]));
  for (const path of deletedPaths) byPath.delete(path);
  for (const doc of changed) byPath.set(doc.path, doc);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
