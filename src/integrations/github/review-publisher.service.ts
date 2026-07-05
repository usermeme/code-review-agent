import type { Octokit } from 'octokit';
import type { CodeReviewPublisher } from '../vcs/interfaces/vcs-client.interface.js';
import type { RepositoryIdentifier, ReviewComment as VcsReviewComment } from '../vcs/types/vcs.types.js';
import { logger } from '../../core/logger/logger.service.js';

interface GithubReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export function anchorableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (row.startsWith('+') || row.startsWith(' ')) {
      lines.add(newLine);
      newLine++;
    }
  }
  return lines;
}

export class GithubReviewPublisher implements CodeReviewPublisher {
  constructor(private readonly octokit: Octokit) {}

  async publishReview(
    repo: RepositoryIdentifier,
    prNumber: number,
    comments: VcsReviewComment[],
    generalSummary: string
  ): Promise<void> {
    const { data: pr } = await this.octokit.rest.pulls.get({
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
    });
    const headSha = pr.head.sha;

    const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
      per_page: 100,
    });

    const anchors = new Map<string, Set<number>>();
    for (const file of files) {
      if (file.patch) anchors.set(file.filename, anchorableLines(file.patch));
    }

    const githubComments: GithubReviewComment[] = [];
    const unanchored: VcsReviewComment[] = [];

    for (const comment of comments) {
      const valid = anchors.get(comment.path);
      if (comment.line && valid?.has(comment.line)) {
        githubComments.push({
          path: comment.path,
          line: comment.line,
          side: 'RIGHT',
          body: comment.body,
        });
      } else {
        unanchored.push(comment);
      }
    }

    let body = generalSummary;
    if (unanchored.length > 0) {
      body += '\n\n### Additional notes\n';
      body += unanchored.map((c) => `- **\`${c.path}\`${c.line ? ` (line ${c.line})` : ''}**: ${c.body}`).join('\n');
    }

    try {
      await this.octokit.rest.pulls.createReview({
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        commit_id: headSha,
        event: 'COMMENT',
        body,
        comments: githubComments,
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 422 || githubComments.length === 0) throw error;
      logger.warn(
        { repo: `${repo.owner}/${repo.name}`, pr: prNumber, err: error },
        'inline comments rejected; republishing with all findings in the summary',
      );
      
      let fallbackBody = generalSummary;
      if (comments.length > 0) {
         fallbackBody += '\n\n### Findings\n';
         fallbackBody += comments.map((c) => `- **\`${c.path}\`${c.line ? ` (line ${c.line})` : ''}**: ${c.body}`).join('\n');
      }

      await this.octokit.rest.pulls.createReview({
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        commit_id: headSha,
        event: 'COMMENT',
        body: fallbackBody,
      });
    }

    logger.info(
      {
        repo: `${repo.owner}/${repo.name}`,
        pr: prNumber,
        inline: githubComments.length,
        unanchored: unanchored.length,
      },
      'published review',
    );
  }
}
