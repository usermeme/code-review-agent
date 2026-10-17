import { type BaseLlm } from '@google/adk';
import PQueue from 'p-queue';

import { STATE } from '../constants/state-keys.constant.js';
import { type Chunk, renderChunk } from './chunker.service.js';
import { generateText } from './generate.service.js';
import type { PipelineState } from './pipeline-state.js';

export const DEFAULT_SUMMARY_CONCURRENCY = 10;

/**
 * Pipeline step 2: summarize every chunk with one independent LLM call each
 * (map step). This is the dominant token cost of a context build, so callers
 * may pass a cheaper/faster model here than the one used for synthesis.
 *
 * Writes STATE.chunkSummaries and returns the summaries.
 */
export async function summarizeChunks(
  llm: BaseLlm,
  state: PipelineState,
  concurrency: number = DEFAULT_SUMMARY_CONCURRENCY,
): Promise<string[]> {
  const chunks = state.get<Chunk[]>(STATE.chunks) ?? [];
  if (chunks.length === 0) {
    throw new Error('No chunks found in state. Did prepareRepository run?');
  }

  const queue = new PQueue({ concurrency });
  const results = await Promise.all(
    chunks.map((chunk) =>
      queue.add(async () => {
        try {
          const prompt = `You are analyzing one chunk of a codebase to help build a whole-repo context document. Summarize this chunk covering: architecture and responsibilities, internal patterns and conventions, error handling idioms, testing idioms, and notable utilities. Be specific — name files, functions, and patterns.\n\nChunk Content:\n${renderChunk(chunk)}`;
          const text = await generateText(llm, { prompt });
          return `## Chunk: ${chunk.label}\n${text}`;
        } catch (error) {
          console.warn(
            { chunk: chunk.label, err: error },
            'chunk summary failed; skipping',
          );
          return null;
        }
      }),
    ),
  );

  const summaries = results.filter((r): r is string => typeof r === 'string');
  if (summaries.length === 0) {
    throw new Error('Every chunk summary failed; cannot build repo context.');
  }

  state.set(STATE.chunkSummaries, summaries);
  return summaries;
}
