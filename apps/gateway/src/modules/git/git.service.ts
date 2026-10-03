import { FastifyBaseLogger } from 'fastify';
import { GitAdapter } from './interfaces/git-adapter.interface.js';
import { GithubAdapter } from './adapters/github.adapter.js';
import { PrRepository } from '../database/repositories/pr.repository.js';
import { ContextRepository } from '../database/repositories/context.repository.js';

export class GitService {
  private adapters: Map<string, GitAdapter> = new Map();

  registerAdapter(provider: string, adapter: GitAdapter): void {
    this.adapters.set(provider, adapter);
  }

  async initAdapters(logger: FastifyBaseLogger): Promise<void> {
    for (const [provider, adapter] of this.adapters.entries()) {
      try {
        await adapter.init(logger);
        logger.info(`Initialized GitAdapter for provider: ${provider}`);
      } catch (e) {
        logger.error(
          `Failed to initialize GitAdapter for provider: ${provider} - ${e}`,
        );
      }
    }
  }

  getAdapter(provider: string): GitAdapter | undefined {
    return this.adapters.get(provider);
  }

  getAdapterForRequest(
    headers: Record<string, string | string[] | undefined>,
  ): { provider: string; adapter: GitAdapter } | undefined {
    for (const [provider, adapter] of this.adapters.entries()) {
      if (adapter.canHandle(headers)) {
        return { provider, adapter };
      }
    }
    return undefined;
  }
}

export function createDefaultGitService(
  prRepository: PrRepository,
  contextRepository: ContextRepository,
): GitService {
  const gitService = new GitService();
  gitService.registerAdapter(
    'github',
    new GithubAdapter(prRepository, contextRepository),
  );
  return gitService;
}
