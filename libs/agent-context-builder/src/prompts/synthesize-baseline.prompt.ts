import { SECTIONS_SPEC } from './sections.js';
import { UNTRUSTED_REPO_CONTENT_WARNING, wrapUntrusted } from './untrusted.js';

export function synthesizeBaselinePrompt(params: {
  summaries: string[];
  overflowPaths: string[];
}): string {
  return `You merge per-chunk codebase summaries into one repository context document.
${SECTIONS_SPEC}

${UNTRUSTED_REPO_CONTENT_WARNING}

Per-chunk summaries:
${wrapUntrusted(params.summaries.join('\n\n'))}

Files that exist but were not summarized (budget overflow):
${wrapUntrusted(params.overflowPaths.join('\n') || '(none)')}`;
}
