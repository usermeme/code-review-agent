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
      'Synthesizes all chunk summaries into the final repository context document. Call this after summarize_chunks.',
    parameters: z.object({}),
    execute: async (_input, ctx) => {
      const summaries = ctx.state[STATE.chunkSummaries] as string[];
      const overflow = ctx.state[STATE.overflowPaths] as string[];
      const agentDocs = ctx.state[STATE.agentDocs] as string;

      if (!summaries) {
        throw new Error(
          'No chunk summaries found. Did you call summarize_chunks?',
        );
      }

      const prompt = `You merge per-chunk codebase summaries into one repository context document.
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
${agentDocs}`;

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
