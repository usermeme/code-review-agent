import type {
  GitAdapterContract,
  RepoContextContent,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';

import { collectAgentDocs, mergeAgentDocs } from './repo/agent-docs.js';
import { buildChunks, type ChunkLimits } from './repo/chunker.js';
import { collectBaselineFiles } from './steps/collect-baseline-files.js';
import { collectPrFiles } from './steps/collect-pr-files.js';
import { summarizeChunks } from './steps/summarize-chunks.js';
import {
  synthesizeBaseline,
  synthesizeUpdate,
} from './steps/synthesize-context.js';

export interface ContextBuilderLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface ContextBuildLimits extends ChunkLimits {
  /** Parallel chunk-summary LLM calls. */
  concurrency: number;
}

export const DEFAULT_CONTEXT_BUILD_LIMITS: ContextBuildLimits = {
  maxChunkTokens: 25_000,
  maxChunks: 50,
  concurrency: 10,
};

/** Collaborators. Kept apart from the input so nothing here can end up in a prompt. */
export interface ContextBuilderDeps {
  llm: BaseLlm;
  gitAdapter: GitAdapterContract;
  logger?: ContextBuilderLogger;
  limits?: Partial<ContextBuildLimits>;
}

export type BuildRepoContextInput =
  | {
      mode: 'baseline';
      owner: string;
      repo: string;
      /** Branch or commit to snapshot; the adapter picks its default when omitted. */
      ref?: string;
    }
  | {
      mode: 'incremental';
      owner: string;
      repo: string;
      /** The merged PR whose changes get folded in. */
      prNumber: number;
      /** The current baseline. An incremental update has nothing to merge into without one. */
      existing: RepoContextContent;
    };

export interface BuiltRepoContext extends RepoContextContent {
  headSha?: string;
}

/**
 * Builds (baseline) or updates (incremental) a repository's context document.
 * A fixed, deterministic pipeline — the LLM is only called to summarize chunks
 * and to synthesize the sections; it never decides what runs next.
 */
export async function buildRepoContext(
  input: BuildRepoContextInput,
  deps: ContextBuilderDeps,
): Promise<BuiltRepoContext> {
  const limits = { ...DEFAULT_CONTEXT_BUILD_LIMITS, ...deps.limits };
  return input.mode === 'baseline'
    ? buildBaseline(input, deps, limits)
    : applyMergedPr(input, deps, limits);
}

async function buildBaseline(
  input: Extract<BuildRepoContextInput, { mode: 'baseline' }>,
  deps: ContextBuilderDeps,
  limits: ContextBuildLimits,
): Promise<BuiltRepoContext> {
  const { files, headSha } = await collectBaselineFiles({
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    gitAdapter: deps.gitAdapter,
  });
  if (files.length === 0) {
    throw new Error(
      `Repository ${input.owner}/${input.repo} has no readable text files to build context from.`,
    );
  }

  const { chunks, overflow } = buildChunks(files, limits);
  deps.logger?.info(
    `[ContextBuilder] Baseline for ${input.owner}/${input.repo}: ${files.length} files in ${chunks.length} chunks, ${overflow.length} overflow.`,
  );

  const summaries = await summarizeChunks({
    llm: deps.llm,
    chunks,
    concurrency: limits.concurrency,
    logger: deps.logger,
  });
  const sections = await synthesizeBaseline({
    llm: deps.llm,
    summaries,
    overflowPaths: overflow,
  });

  return { sections, agentDocs: collectAgentDocs(files), headSha };
}

async function applyMergedPr(
  input: Extract<BuildRepoContextInput, { mode: 'incremental' }>,
  deps: ContextBuilderDeps,
  limits: ContextBuildLimits,
): Promise<BuiltRepoContext> {
  const { files, deletedPaths } = await collectPrFiles({
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    gitAdapter: deps.gitAdapter,
  });
  const agentDocs = mergeAgentDocs(
    input.existing.agentDocs,
    collectAgentDocs(files),
    deletedPaths,
  );

  if (files.length === 0 && deletedPaths.length === 0) {
    deps.logger?.info(
      `[ContextBuilder] PR #${input.prNumber} changed no readable files; keeping sections as they are.`,
    );
    return { sections: input.existing.sections, agentDocs };
  }

  const { chunks } = buildChunks(files, limits);
  const summaries = await summarizeChunks({
    llm: deps.llm,
    chunks,
    concurrency: limits.concurrency,
    logger: deps.logger,
  });
  const sections = await synthesizeUpdate({
    llm: deps.llm,
    existing: input.existing.sections,
    summaries,
    deletedPaths,
  });

  return { sections, agentDocs };
}
