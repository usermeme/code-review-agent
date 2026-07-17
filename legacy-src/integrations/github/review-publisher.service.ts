import type { Octokit } from 'octokit';
import type { CodeReviewPublisher } from '../vcs/interfaces/vcs-client.interface.js';
import type {
  RepositoryIdentifier,
  ReviewComment as VcsReviewComment,
} from '../vcs/types/vcs.types.js';
import { logger } from '../../core/logger/logger.service.js';

interface GithubReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

const HUNK_HEADER_REGEX = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function anchorableLines(patch: string): Set<number> {
  const anchorableLineNumbers = new Set<number>();
  let currentNewLineNumber = 0;

  for (const line of patch.split('\n')) {
    const hunkHeaderMatch = HUNK_HEADER_REGEX.exec(line);
    if (hunkHeaderMatch) {
      currentNewLineNumber = Number(hunkHeaderMatch[1]);
      continue;
    }

    const isAdditionOrContext = line.startsWith('+') || line.startsWith(' ');
    if (isAdditionOrContext) {
      anchorableLineNumbers.add(currentNewLineNumber);
      currentNewLineNumber++;
    }
  }

  return anchorableLineNumbers;
}

export class GithubReviewPublisher implements CodeReviewPublisher {
  constructor(private readonly octokit: Octokit) {}

  async publishReview(
    repo: RepositoryIdentifier,
    prNumber: number,
    comments: VcsReviewComment[],
    generalSummary: string,
  ): Promise<void> {
    const { headSha, anchors } = await this.fetchPullRequestData(
      repo,
      prNumber,
    );

    const { anchoredComments, unanchoredComments } = this.segregateComments(
      comments,
      anchors,
    );

    let summaryBody = generalSummary;
    if (unanchoredComments.length > 0) {
      summaryBody += '\n\n### Additional notes\n';
      summaryBody += this.formatCommentsList(unanchoredComments);
    }

    try {
      await this.octokit.rest.pulls.createReview({
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        commit_id: headSha,
        event: 'COMMENT',
        body: summaryBody,
        comments: anchoredComments,
      });
    } catch (error) {
      const isUnprocessableEntity =
        (error as { status?: number }).status === 422;

      if (!isUnprocessableEntity || anchoredComments.length === 0) {
        throw error;
      }

      logger.warn(
        { repo: `${repo.owner}/${repo.name}`, pr: prNumber, err: error },
        'inline comments rejected; republishing with all findings in the summary',
      );

      let fallbackBody = generalSummary;
      if (comments.length > 0) {
        fallbackBody += '\n\n### Findings\n';
        fallbackBody += this.formatCommentsList(comments);
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
        inline: anchoredComments.length,
        unanchored: unanchoredComments.length,
      },
      'published review',
    );
  }

  private async fetchPullRequestData(
    repo: RepositoryIdentifier,
    prNumber: number,
  ) {
    const { data: pr } = await this.octokit.rest.pulls.get({
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
    });

    const files = await this.octokit.paginate(
      this.octokit.rest.pulls.listFiles,
      {
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        per_page: 100,
      },
    );

    const anchors = new Map<string, Set<number>>();
    for (const file of files) {
      if (file.patch) anchors.set(file.filename, anchorableLines(file.patch));
    }

    return { headSha: pr.head.sha, anchors };
  }

  private segregateComments(
    comments: VcsReviewComment[],
    anchors: Map<string, Set<number>>,
  ) {
    const anchoredComments: GithubReviewComment[] = [];
    const unanchoredComments: VcsReviewComment[] = [];

    for (const comment of comments) {
      const validAnchorLines = anchors.get(comment.path);
      const isLineAnchorable =
        comment.line !== undefined && validAnchorLines?.has(comment.line);

      if (isLineAnchorable) {
        anchoredComments.push({
          path: comment.path,
          line: comment.line!,
          side: 'RIGHT',
          body: comment.body,
        });
      } else {
        unanchoredComments.push(comment);
      }
    }

    return { anchoredComments, unanchoredComments };
  }

  private formatCommentsList(comments: VcsReviewComment[]): string {
    return comments
      .map((c) => {
        const lineRef = c.line ? ` (line ${c.line})` : '';
        return `- **\`${c.path}\`${lineRef}**: ${c.body}`;
      })
      .join('\n');
  }
}
