import { createHash } from 'node:crypto';

import { isIndexableFilePath } from '@code-review-agent/agent-tools';
import type {
  RepoTreeFile,
  ReviewContextSourceKind,
} from '@code-review-agent/shared-types';

/**
 * Bump when the builder prompt, schema or validation changes: the version
 * is part of every source hash, so stored contexts are rebuilt.
 */
export const REVIEW_CONTEXT_BUILDER_VERSION = 1;

/** Lowercased basenames of every file that can be a context source. */
export const CONTEXT_SOURCE_BASENAMES = [
  '.cursorrules',
  'agents.md',
  'claude.md',
  'copilot-instructions.md',
  'skill.md',
];

const GUIDELINE_BASENAMES = new Set(['.cursorrules', 'agents.md', 'claude.md']);
const COPILOT_INSTRUCTIONS_PATH = '.github/copilot-instructions.md';

/** A context source on the base branch, before its content is fetched. */
export interface ContextSourceRef {
  path: string;
  kind: ReviewContextSourceKind;
  blobSha: string;
}

/** A context source with its content. */
export interface LoadedContextSource extends ContextSourceRef {
  content: string;
}

/**
 * Guideline files count at any depth (a nested `AGENTS.md` scopes its rules
 * to its folder); a skill is a `SKILL.md` inside a folder named after it.
 */
export function classifyContextSource(
  path: string,
): ReviewContextSourceKind | null {
  if (!isIndexableFilePath(path)) return null;
  const segments = path.toLowerCase().split('/');
  if (isGuidelinePath(segments)) return 'guideline';
  return isSkillPath(segments) ? 'skill' : null;
}

function isGuidelinePath(segments: string[]): boolean {
  const basename = segments[segments.length - 1] ?? '';
  return (
    GUIDELINE_BASENAMES.has(basename) ||
    segments.join('/') === COPILOT_INSTRUCTIONS_PATH
  );
}

function isSkillPath(segments: string[]): boolean {
  return segments.length >= 2 && segments[segments.length - 1] === 'skill.md';
}

/** Keeps the tree files that are context sources, sorted by path. */
export function selectContextSources(
  files: RepoTreeFile[],
): ContextSourceRef[] {
  const sources: ContextSourceRef[] = [];
  for (const file of files) {
    const kind = classifyContextSource(file.path);
    if (kind) sources.push({ path: file.path, kind, blobSha: file.blobSha });
  }
  return sources.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Content hash of a set of sources: the builder version plus every
 * (path, blob SHA) pair, independent of input order. Computed from the git
 * tree alone, so a cache lookup needs no file contents.
 */
export function hashContextSources(sources: ContextSourceRef[]): string {
  const lines = sources
    .map((source) => `${source.path}\0${source.blobSha}`)
    .sort();
  return createHash('sha256')
    .update(`v${REVIEW_CONTEXT_BUILDER_VERSION}\n${lines.join('\n')}`)
    .digest('hex');
}
