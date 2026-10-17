import { type BaseLlm } from '@google/adk';

import { STATE } from '../constants/state-keys.constant.js';
import { generateText } from './generate.service.js';
import type { PipelineState } from './pipeline-state.js';

/**
 * Pipeline step 3: merge chunk summaries into the final context document.
 *
 * Returns the parsed sections object directly — the document never
 * round-trips through an orchestrating model (previously it was emitted as a
 * tool response and re-emitted verbatim by the LLM as the next tool's
 * arguments, doubling token cost and risking truncation/corruption).
 */
export async function synthesizeContext(
  llm: BaseLlm,
  state: PipelineState,
): Promise<Record<string, string>> {
  const summaries = state.get<string[]>(STATE.chunkSummaries);
  const overflow = state.get<string[]>(STATE.overflowPaths);
  const agentDocs = state.get<string>(STATE.agentDocs);
  const existingContext = state.get<Record<string, string>>(
    STATE.existingContext,
  );

  if (!summaries || summaries.length === 0) {
    if (existingContext && Object.keys(existingContext).length > 0) {
      return existingContext;
    }
    throw new Error('No chunk summaries found. Did summarizeChunks run?');
  }

  let prompt: string;

  if (existingContext && Object.keys(existingContext).length > 0) {
    prompt = `You are updating a repository context document incrementally based on recent file changes.
Output markdown with EXACTLY these top-level sections, in this order, using these exact headings:
## Architecture
## Modules
## Internal Patterns & Conventions
## Error Handling & Testing
## Agent Docs (verbatim)

Update the existing context where necessary using the new per-chunk summaries. If a module was removed or changed, reflect that. Keep the rest of the context intact.
Copy the provided agent docs into the last section unchanged.

Existing Context:
${JSON.stringify(existingContext, null, 2)}

New Per-chunk summaries (from changed files):
${summaries.join('\n\n')}

Overflow paths:
${(overflow || []).join('\n')}

Agent docs:
${agentDocs || ''}`;
  } else {
    prompt = `You merge per-chunk codebase summaries into one repository context document.
Output markdown with EXACTLY these top-level sections, in this order, using these exact headings:
## Architecture
## Modules
## Internal Patterns & Conventions
## Error Handling & Testing
## Agent Docs (verbatim)
Under "Modules", one short paragraph per module/directory. Under "Internal Patterns & Conventions",
list every convention a code reviewer should enforce, citing where it is established.
Copy the provided agent docs into the last section unchanged.

Per-chunk summaries:
${summaries.join('\n\n')}

Overflow paths:
${(overflow || []).join('\n')}

Agent docs:
${agentDocs || ''}`;
  }

  const text = await generateText(llm, { prompt });

  return splitSections(text);
}

const SECTION_KEYS: Record<string, string> = {
  Architecture: 'architecture',
  Modules: 'modules',
  'Internal Patterns & Conventions': 'patterns',
  'Error Handling & Testing': 'errorHandling',
  'Agent Docs (verbatim)': 'agentDocs',
};

export function splitSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let currentKey: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentKey && buffer.length > 0)
      sections[currentKey] = buffer.join('\n').trim();
    buffer = [];
  };

  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    const key = heading ? SECTION_KEYS[heading[1].trim()] : undefined;
    if (key) {
      flush();
      currentKey = key;
      continue;
    }
    if (currentKey) buffer.push(line);
  }
  flush();

  if (Object.keys(sections).length === 0) {
    sections['architecture'] = markdown.trim();
  }
  return sections;
}
