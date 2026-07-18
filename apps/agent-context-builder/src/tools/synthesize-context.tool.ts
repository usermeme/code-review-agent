import { FunctionTool } from '@google/adk';
import { Gemini } from '@google/adk';
import { z } from 'zod';
import { STATE } from '../constants/state-keys.constant.js';
import { generateText } from '../services/generate.service.js';

export interface CreateSynthesizeContextToolPayload {
  model: string;
}

export function createSynthesizeContextTool({
  model,
}: CreateSynthesizeContextToolPayload) {
  const llm = new Gemini({ model });

  return new FunctionTool({
    name: 'synthesize_context',
    description:
      'Synthesizes chunk summaries into the final repository context document, patching the existing baseline if provided.',
    parameters: z.object({}),
    execute: async (_input, ctx) => {
      const summaries = ctx.state[STATE.chunkSummaries] as string[] | undefined;
      const overflow = ctx.state[STATE.overflowPaths] as string[] | undefined;
      const agentDocs = ctx.state[STATE.agentDocs] as string | undefined;
      const existingContext = ctx.state[STATE.existingContext] as
        | Record<string, string>
        | undefined;

      if (!summaries || summaries.length === 0) {
        if (existingContext) {
          return JSON.stringify(existingContext);
        }
        throw new Error(
          'No chunk summaries found. Did you call summarize_chunks?',
        );
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

      // Parse the markdown into sections
      const sections = splitSections(text);

      return JSON.stringify(sections);
    },
  });
}

const SECTION_KEYS: Record<string, string> = {
  Architecture: 'architecture',
  Modules: 'modules',
  'Internal Patterns & Conventions': 'patterns',
  'Error Handling & Testing': 'errorHandling',
  'Agent Docs (verbatim)': 'agentDocs',
};

function splitSections(markdown: string): Record<string, string> {
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
