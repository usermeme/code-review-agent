import type { BaseLlm } from '@google/adk';
import PQueue from 'p-queue';
import { generateText } from '../../integrations/model/generate.service.js';
import { logger } from '../../core/logger/logger.service.js';
import { renderChunk, type Chunk } from './chunker.service.js';

const CHUNK_SYSTEM = `You are analyzing one chunk of a codebase to help build a whole-repo context document.
Summarize this chunk covering: architecture and responsibilities, internal patterns and conventions
(naming, structure, reusable utilities), error handling idioms, testing idioms, and notable utilities
other code should reuse instead of reimplementing. Be specific — name files, functions, and patterns.`;

const SYNTHESIS_SYSTEM = `You merge per-chunk codebase summaries into one repository context document.
Output markdown with EXACTLY these top-level sections, in this order, using these exact headings:
## Architecture
## Modules
## Internal Patterns & Conventions
## Error Handling & Testing
## Agent Docs (verbatim)
Under "Modules", one short paragraph per module/directory. Under "Internal Patterns & Conventions",
list every convention a code reviewer should enforce, citing where it is established.
Copy the provided agent docs into the last section unchanged.`;

export interface SynthesisResult {
  markdown: string;
  sections: Record<string, string>;
}

export async function summarizeChunks(llm: BaseLlm, chunks: Chunk[], concurrency: number): Promise<string[]> {
  const queue = new PQueue({ concurrency });
  const results = await Promise.all(
    chunks.map((chunk, index) =>
      queue.add(async () => {
        logger.debug({ chunk: chunk.label, index }, 'summarizing chunk');
        try {
          const text = await generateText(llm, {
            system: CHUNK_SYSTEM,
            prompt: renderChunk(chunk),
          });
          return `## Chunk: ${chunk.label}\n${text}`;
        } catch (error) {
          // One flaky chunk must not discard every other summary and fail the
          // whole build; drop it and synthesize from what succeeded.
          logger.warn({ chunk: chunk.label, index, err: error }, 'chunk summary failed; skipping');
          return null;
        }
      }),
    ),
  );
  const summaries = results.filter((r): r is string => typeof r === 'string');
  if (chunks.length > 0 && summaries.length === 0) {
    throw new Error('every chunk summary failed; cannot build repo context');
  }
  return summaries;
}

export async function synthesize(
  llm: BaseLlm,
  params: {
    chunkSummaries: string[];
    agentDocs: string;
    overflowPaths: string[];
  },
): Promise<SynthesisResult> {
  const prompt = [
    'Per-chunk summaries:',
    ...params.chunkSummaries,
    params.overflowPaths.length > 0
      ? `Files present but not summarized (tree only):\n${params.overflowPaths.join('\n')}`
      : '',
    'Agent docs to include verbatim in the last section:',
    params.agentDocs || '(none found)',
  ].join('\n\n');

  const markdown = await generateText(llm, {
    system: SYNTHESIS_SYSTEM,
    prompt,
  });
  return { markdown, sections: splitSections(markdown) };
}

export const SECTION_KEYS: Record<string, string> = {
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
    if (currentKey && buffer.length > 0) sections[currentKey] = buffer.join('\n').trim();
    buffer = [];
  };

  for (const line of markdown.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    const key = heading ? SECTION_KEYS[heading[1]!.trim()] : undefined;
    // Only known section headings are boundaries. Agent docs are copied in
    // verbatim and routinely carry their own `##` headings (Build, Testing,
    // …); treating those as boundaries would drop everything after the first.
    if (key) {
      flush();
      currentKey = key;
      continue;
    }
    if (currentKey) buffer.push(line);
  }
  flush();

  // A model that ignored the heading contract still yields usable context.
  if (Object.keys(sections).length === 0) sections['architecture'] = markdown.trim();
  return sections;
}
