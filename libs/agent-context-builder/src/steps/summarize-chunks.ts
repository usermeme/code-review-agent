import { generateText } from '@code-review-agent/llm';
import type { BaseLlm } from '@google/adk';
import PQueue from 'p-queue';

import type { ContextBuilderLogger } from '../build-repo-context.js';
import { summarizeChunkPrompt } from '../prompts/summarize-chunk.prompt.js';
import type { Chunk } from '../repo/chunker.js';

/**
 * Summarizes chunks concurrently. A failed chunk is logged and skipped — one
 * flaky call shouldn't sink a 50-chunk build — but if every chunk fails the
 * build fails rather than producing a context from nothing.
 */
export async function summarizeChunks(params: {
  llm: BaseLlm;
  chunks: Chunk[];
  concurrency: number;
  logger?: ContextBuilderLogger;
}): Promise<string[]> {
  const queue = new PQueue({ concurrency: params.concurrency });
  const results = await Promise.all(
    params.chunks.map((chunk) =>
      queue.add(async () => {
        try {
          const text = await generateText(params.llm, {
            prompt: summarizeChunkPrompt(chunk),
          });
          return `## Chunk: ${chunk.label}\n${text}`;
        } catch (error) {
          params.logger?.warn(
            `[ContextBuilder] Summary of chunk "${chunk.label}" failed; skipping: ${String(error)}`,
          );
          return null;
        }
      }),
    ),
  );

  const summaries = results.filter((r): r is string => typeof r === 'string');
  if (params.chunks.length > 0 && summaries.length === 0) {
    throw new Error('Every chunk summary failed; cannot build repo context.');
  }
  return summaries;
}
