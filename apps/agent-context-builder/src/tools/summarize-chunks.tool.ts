import { FunctionTool } from '@google/adk';
import { Gemini } from '@google/adk';
import { z } from 'zod';
import PQueue from 'p-queue';
import { STATE } from '../constants/state-keys.constant.js';
import { renderChunk, type Chunk } from '../services/chunker.service.js';
import { generateText } from '../services/generate.service.js';

export interface CreateSummarizeRepoToolPayload {
  model: string;
}

export function createSummarizeRepoTool({
  model,
}: CreateSummarizeRepoToolPayload) {
  const llm = new Gemini({ model });

  return new FunctionTool({
    name: 'summarize_chunks',
    description:
      'Summarizes all codebase chunks concurrently. Call this after prepare_repository.',
    parameters: z.object({
      concurrency: z.number().optional().default(10),
    }),
    execute: async (input, ctx) => {
      const chunks = ctx.state[STATE.chunks] as Chunk[];
      if (!chunks || chunks.length === 0) {
        throw new Error(
          'No chunks found in state. Did you call prepare_repository?',
        );
      }

      const queue = new PQueue({ concurrency: input.concurrency });
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

      const summaries = results.filter(
        (r): r is string => typeof r === 'string',
      );
      if (chunks.length > 0 && summaries.length === 0) {
        throw new Error(
          'Every chunk summary failed; cannot build repo context.',
        );
      }

      ctx.state[STATE.chunkSummaries] = summaries;
      return `Summarized ${summaries.length}/${chunks.length} chunks successfully.`;
    },
  });
}
