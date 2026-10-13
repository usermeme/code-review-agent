import type { RepoContextSections } from '@code-review-agent/shared-types';

import { SECTIONS_SPEC } from './sections.js';
import { UNTRUSTED_REPO_CONTENT_WARNING, wrapUntrusted } from './untrusted.js';

export function synthesizeUpdatePrompt(params: {
  existing: RepoContextSections;
  summaries: string[];
  deletedPaths: string[];
}): string {
  return `You update an existing repository context document after a pull request was merged.
${SECTIONS_SPEC}

Start from the existing document and keep everything the change does not affect. Reflect the
changed files described in the summaries, and remove or correct anything that referred to deleted
files. Do not drop sections or shorten unaffected content.

${UNTRUSTED_REPO_CONTENT_WARNING}

Existing context document:
${wrapUntrusted(JSON.stringify(params.existing, null, 2))}

Summaries of the files changed by the merged PR:
${wrapUntrusted(params.summaries.join('\n\n') || '(no summarizable file changes)')}

Files deleted by the merged PR:
${wrapUntrusted(params.deletedPaths.join('\n') || '(none)')}`;
}
