import type { DiscussionEntry } from '../discussion/store.service.js';
import { logger } from '../../core/logger/logger.service.js';
import type { Services } from '../../wiring.js';

/**
 * Ingests all historical PR discussions of a repository into the vector
 * store. Repo-wide comment listing endpoints are used so this is two
 * paginated walks, not one per PR.
 */
export async function backfillRepo(
  services: Services,
  params: { installationId: number; owner: string; repo: string },
): Promise<{ stored: number }> {
  const { owner, repo } = params;
  const repoFull = `${owner}/${repo}`;
  const octokit = await services.app.getInstallationOctokit(params.installationId);
  let stored = 0;

  const issueComments = octokit.paginate.iterator(octokit.rest.issues.listCommentsForRepo, {
    owner,
    repo,
    per_page: 100,
  });
  for await (const { data } of issueComments) {
    for (const comment of data) {
      if (comment.user?.type === 'Bot') continue;
      if (!comment.html_url.includes('/pull/')) continue; // PR discussions only
      stored += await safeInsert(services, {
        repo: repoFull,
        prNumber: numberFromUrl(comment.issue_url),
        source: 'issue_comment',
        author: comment.user?.login ?? 'unknown',
        body: comment.body ?? '',
        githubId: comment.id,
        createdAt: new Date(comment.created_at),
      });
    }
  }

  const reviewComments = octokit.paginate.iterator(octokit.rest.pulls.listReviewCommentsForRepo, {
    owner,
    repo,
    per_page: 100,
  });
  for await (const { data } of reviewComments) {
    for (const comment of data) {
      if (comment.user?.type === 'Bot') continue;
      stored += await safeInsert(services, {
        repo: repoFull,
        prNumber: numberFromUrl(comment.pull_request_url),
        source: 'review_comment',
        author: comment.user?.login ?? 'unknown',
        filePath: comment.path,
        body: comment.body,
        githubId: comment.id,
        createdAt: new Date(comment.created_at),
      });
    }
  }

  logger.info({ repo: repoFull, stored }, 'backfill complete');
  return { stored };
}

function numberFromUrl(url: string): number | undefined {
  const match = /\/(\d+)$/.exec(url);
  return match ? Number(match[1]) : undefined;
}

async function safeInsert(services: Services, entry: DiscussionEntry): Promise<number> {
  if (!entry.body.trim()) return 0;
  try {
    await services.discussionStore.insert(entry);
    return 1;
  } catch (error) {
    logger.warn({ githubId: entry.githubId, err: error }, 'backfill insert failed');
    return 0;
  }
}
