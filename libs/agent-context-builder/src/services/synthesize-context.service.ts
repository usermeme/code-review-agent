import { type BaseLlm } from '@google/adk';

import { STATE } from '../constants/state-keys.constant.js';
import { generateText } from './generate.service.js';
import type { PipelineState } from './pipeline-state.js';

interface SynthesisInput {
  summaries: string[];
  overflow?: string[];
  agentDocs?: string;
}

/** True when a stored baseline context exists and carries sections. */
function hasExistingSections(
  existingContext: Record<string, string> | undefined,
): existingContext is Record<string, string> {
  return Boolean(existingContext && Object.keys(existingContext).length > 0);
}

function buildIncrementalPrompt(
  existingContext: Record<string, string>,
  input: SynthesisInput,
): string {
  return `You are updating a repository context document incrementally based on recent file changes.
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
${input.summaries.join('\n\n')}

Overflow paths:
${(input.overflow || []).join('\n')}

Agent docs:
${input.agentDocs || ''}`;
}

function buildBaselinePrompt(input: SynthesisInput): string {
  return `You merge per-chunk codebase summaries into one repository context document.
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
${input.summaries.join('\n\n')}

Overflow paths:
${(input.overflow || []).join('\n')}

Agent docs:
${input.agentDocs || ''}`;
}

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
    if (hasExistingSections(existingContext)) {
      return existingContext;
    }
    throw new Error('No chunk summaries found. Did summarizeChunks run?');
  }

  let prompt: string;

  if (hasExistingSections(existingContext)) {
    prompt = buildIncrementalPrompt(existingContext, {
      summaries,
      overflow,
      agentDocs,
    });
  } else {
    prompt = buildBaselinePrompt({ summaries, overflow, agentDocs });
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

/** Section key for a `## Heading` line, or undefined for any other line. */
function sectionKeyForLine(line: string): string | undefined {
  const heading = /^## (.+)$/.exec(line);
  return heading ? SECTION_KEYS[heading[1].trim()] : undefined;
}

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
    const key = sectionKeyForLine(line);
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
