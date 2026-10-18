import { rm } from 'node:fs/promises';

import {
  type GitAdapterContract,
  NonRetryableTaskError,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import { z } from 'zod';

import { STATE } from './constants/state-keys.constant.js';
import { PipelineState } from './services/pipeline-state.js';
import { prepareRepository } from './services/prepare-repo.service.js';
import { summarizeChunks } from './services/summarize-chunks.service.js';
import { synthesizeContext } from './services/synthesize-context.service.js';

/**
 * Validated, credential-free payload for a context build.
 *
 * SECURITY NOTE: this schema intentionally has no `token` field and the
 * pipeline never serializes dependency objects (llm, gitAdapter) into any
 * model input — an earlier implementation sent `JSON.stringify(options)`
 * (which included the Gemini instance and its apiKey) to the LLM as the user
 * message. Credentials must stay out-of-band, in the adapter's environment.
 */
export const contextBuildPayloadSchema = z.object({
  provider: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().optional(),
  cloneUrl: z.string().optional(),
  ref: z.string().optional(),
  isIncrementalUpdate: z.boolean().optional(),
});

export type ContextBuildPayload = z.infer<typeof contextBuildPayloadSchema>;

export type ContextLoader = (
  key: string,
) => Promise<Record<string, string> | null>;

export interface BuildContextOptions extends ContextBuildPayload {
  gitAdapter?: GitAdapterContract;
  /** Model used for the final synthesis (the expensive, judgment-heavy call). */
  llm: BaseLlm;
  /**
   * Optional cheaper/faster model for the per-chunk map-step summaries.
   * Falls back to `llm` when not provided.
   */
  summaryLlm?: BaseLlm;
  contextLoader?: ContextLoader;
  summaryConcurrency?: number;
  onStoreContext?: (result: {
    provider: string;
    owner: string;
    repo: string;
    prNumber: number;
    sections: Record<string, string>;
  }) => Promise<void> | void;
}

/** Loads the stored baseline context, but only for incremental updates. */
async function loadExistingContext(
  options: BuildContextOptions,
  payload: ContextBuildPayload,
  baselineKey: string,
): Promise<Record<string, string> | null> {
  if (payload.isIncrementalUpdate && options.contextLoader) {
    return options.contextLoader(baselineKey);
  }
  return null;
}

/** Cheaper/faster map-step model when provided; falls back to `llm`. */
function resolveSummaryLlm(options: BuildContextOptions): BaseLlm {
  return options.summaryLlm ?? options.llm;
}

/** Outcome when the pipeline found nothing summarizable this run. */
function resolveNoChunksResult(
  existingContext: Record<string, string> | null,
  baselineKey: string,
): Record<string, string> {
  if (existingContext) {
    // Nothing summarizable changed (e.g. only lockfiles/binaries):
    // keep the existing baseline instead of burning LLM calls.
    return existingContext;
  }
  // Retrying cannot conjure summarizable files — ack-and-record instead
  // of burning redeliveries on a deterministic failure.
  throw new NonRetryableTaskError(
    `No summarizable files found for ${baselineKey}; cannot build a baseline context.`,
  );
}

/** Hands the synthesized sections to the caller-provided store hook, if any. */
async function storeSections(
  options: BuildContextOptions,
  payload: ContextBuildPayload,
  sections: Record<string, string>,
): Promise<void> {
  if (options.onStoreContext) {
    await options.onStoreContext({
      provider: payload.provider,
      owner: payload.owner,
      repo: payload.repo,
      // Baseline builds are always stored under prNumber 0 (the baseline).
      prNumber: 0,
      sections,
    });
  }
}

/** Removes the temporary checkout recorded in state, if one was created. */
async function removeCheckout(state: PipelineState): Promise<void> {
  const repoDir = state.get<string>(STATE.repoDir);
  if (repoDir) {
    await rm(repoDir, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup; tmpdir reaping handles the rest
    });
  }
}

/**
 * Builds (or incrementally updates) the baseline repository context.
 *
 * Deterministic code pipeline — no LLM orchestration:
 *   1. load existing baseline (incremental mode)   [code]
 *   2. prepareRepository: fetch + filter + chunk   [code]
 *   3. summarizeChunks: one LLM call per chunk     [LLM map step]
 *   4. synthesizeContext: merge summaries          [single LLM call]
 *   5. store via onStoreContext / return value     [code]
 *
 * Bulk data (chunks, summaries, sections) travels through PipelineState and
 * function returns — never through a model conversation.
 */
export async function buildContext(
  options: BuildContextOptions,
): Promise<Record<string, string>> {
  // Fail fast on malformed input; strips any unknown keys (e.g. deps).
  const payload = contextBuildPayloadSchema.parse(options);
  const state = new PipelineState();
  const baselineKey = `${payload.provider}:${payload.owner}:${payload.repo}:0`;

  try {
    const existingContext = await loadExistingContext(
      options,
      payload,
      baselineKey,
    );
    if (existingContext) {
      state.set(STATE.existingContext, existingContext);
    }

    await prepareRepository({ gitAdapter: options.gitAdapter }, payload, state);

    const chunks = state.get<unknown[]>(STATE.chunks) ?? [];
    if (chunks.length === 0) {
      return resolveNoChunksResult(existingContext, baselineKey);
    }

    await summarizeChunks(
      resolveSummaryLlm(options),
      state,
      options.summaryConcurrency,
    );
    const sections = await synthesizeContext(options.llm, state);
    state.set(STATE.synthesizedSections, sections);

    await storeSections(options, payload, sections);

    return sections;
  } finally {
    // Always remove the temporary checkout created in baseline mode.
    await removeCheckout(state);
  }
}
