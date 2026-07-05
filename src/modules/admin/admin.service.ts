import type { DiscussionEntry } from '../discussion/store.service.js';
import { logger } from '../../core/logger/logger.service.js';
import type { Services } from '../../wiring.js';
import type { RepositoryIdentifier } from '../../integrations/vcs/types/vcs.types.js';

export async function backfillRepo(
  services: Services,
  params: { providerId: string; installationId: string; repo: RepositoryIdentifier },
): Promise<{ stored: number }> {
  const repoFull = `${params.repo.owner}/${params.repo.name}`;
  const provider = services.getProvider(params.providerId);
  const client = await provider.getClient(params.installationId);
  
  let stored = 0;

  for await (const discussion of client.getHistoricalDiscussions(params.repo)) {
    stored += await safeInsert(services, {
      repo: repoFull,
      prNumber: discussion.prNumber,
      source: discussion.source,
      author: discussion.author,
      body: discussion.body,
      filePath: discussion.filePath,
      providerId: discussion.providerId,
      platformInstallationId: params.installationId,
      createdAt: discussion.createdAt,
    });
  }

  logger.info({ repo: repoFull, stored }, 'backfill complete');
  return { stored };
}

async function safeInsert(services: Services, entry: DiscussionEntry): Promise<number> {
  if (!entry.body.trim()) return 0;
  try {
    await services.discussionStore.insert(entry);
    return 1;
  } catch (error) {
    logger.warn({ providerId: entry.providerId, err: error }, 'backfill insert failed');
    return 0;
  }
}
