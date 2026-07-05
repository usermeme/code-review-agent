import type { BaseLlm } from '@google/adk';
import type { RepoContextCache } from '../cache/redis.js';
import { logger } from '../util/logger.js';
import { collectAgentDocs } from './agent-docs.js';
import { buildChunks, collectFiles } from './chunker.js';
import { cloneShallow } from './clone.js';
import { summarizeChunks, synthesize } from './summarize.js';

export interface RepoContextDoc {
  sections: Record<string, string>;
  headSha: string;
  builtAt: string;
  model: string;
}

export interface BuildOptions {
  maxChunkTokens: number;
  maxChunks: number;
  summaryConcurrency: number;
  extraIgnores: string[];
}

export class RepoContextBuilder {
  constructor(
    private readonly cache: RepoContextCache,
    private readonly llm: BaseLlm,
    private readonly options: BuildOptions,
  ) {}

  /**
   * Returns the cached whole-repo context, rebuilding once the newest doc for
   * the repo is older than the configured max age. Reviews only need
   * architecture and conventions — a bounded-stale doc is fine, and rebuilding
   * per commit would clone and re-summarize the repo on every push. The
   * context is built from the PR's base branch, so all PRs share it. When
   * another run holds the build mutex, any cached doc (even past max age)
   * beats blocking the review for minutes.
   */
  async getOrBuild(params: {
    repo: string; // "owner/name"
    ref: string;
    cloneUrl: string;
    token?: string;
  }): Promise<RepoContextDoc> {
    const fresh = await this.cache.getLatestFresh(params.repo);
    if (fresh) {
      logger.info({ repo: params.repo, builtAt: fresh.builtAt }, 'repo context cache hit');
      return fresh;
    }

    const lockToken = await this.cache.tryAcquireBuildLock(params.repo);
    if (!lockToken) {
      const latest = await this.cache.getLatest(params.repo);
      if (latest) return latest;
      throw new Error(`Repo context for ${params.repo} is being built by another run; retry shortly`);
    }

    try {
      const doc = await this.build(params);
      await this.cache.set(params.repo, doc.headSha, doc);
      return doc;
    } finally {
      await this.cache.releaseBuildLock(params.repo, lockToken);
    }
  }

  private async build(params: {
    repo: string;
    ref: string;
    cloneUrl: string;
    token?: string;
  }): Promise<RepoContextDoc> {
    logger.info({ repo: params.repo, ref: params.ref }, 'building repo context');
    const cloned = await cloneShallow({
      cloneUrl: params.cloneUrl,
      ref: params.ref,
      token: params.token,
    });
    try {
      const files = await collectFiles(cloned.dir, this.options.extraIgnores);
      const agentDocs = collectAgentDocs(files);
      const { chunks, overflow } = buildChunks(files, this.options);
      logger.info(
        {
          repo: params.repo,
          files: files.length,
          chunks: chunks.length,
          overflow: overflow.length,
        },
        'chunked repository',
      );

      const chunkSummaries = await summarizeChunks(this.llm, chunks, this.options.summaryConcurrency);
      const { sections } = await synthesize(this.llm, {
        chunkSummaries,
        agentDocs,
        overflowPaths: overflow,
      });

      return {
        sections,
        headSha: cloned.headSha,
        builtAt: new Date().toISOString(),
        model: this.llm.model,
      };
    } finally {
      await cloned.cleanup();
    }
  }
}
