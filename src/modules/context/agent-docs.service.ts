import type { RepoFile } from './chunker.service.js';

const DOC_NAMES = new Set(['agents.md', 'claude.md', '.cursorrules', 'contributing.md']);

/**
 * Convention docs (AGENTS.md, CLAUDE.md, skills, cursor rules) are already
 * distilled guidance — they go into the context verbatim, never summarized.
 */
export function collectAgentDocs(files: RepoFile[]): string {
  const docs = files.filter((file) => {
    const base = file.path.split('/').pop()!.toLowerCase();
    if (DOC_NAMES.has(base)) return true;
    return file.path.startsWith('.claude/') && file.path.endsWith('.md');
  });
  if (docs.length === 0) return '';
  return docs.map((doc) => `### ${doc.path}\n\n${doc.content}`).join('\n\n---\n\n');
}
