import type { Octokit } from 'octokit';
import type { PlatformClient } from '../vcs/interfaces/vcs-client.interface.js';
import type {
  RepositoryIdentifier,
  PullRequestDetails,
  PrDiff,
  HistoricalDiscussion,
  FileChangeStatus,
} from '../vcs/types/vcs.types.js';

export class GithubClient implements PlatformClient {
  constructor(
    private readonly octokit: Octokit,
    private readonly installationToken: string,
  ) {}

  async getPullRequest(
    repo: RepositoryIdentifier,
    prNumber: number,
  ): Promise<PullRequestDetails> {
    const { data: pr } = await this.octokit.rest.pulls.get({
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
    });

    return {
      id: pr.id.toString(),
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      state: this.determinePrState(pr.merged, pr.state),
      isDraft: Boolean(pr.draft),
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      authorUsername: pr.user?.login ?? 'unknown',
      url: pr.html_url,
    };
  }

  private determinePrState(
    isMerged: boolean,
    githubState: string,
  ): PullRequestDetails['state'] {
    if (isMerged) return 'merged';
    if (githubState === 'closed') return 'closed';
    return 'open';
  }

  async getPrFiles(
    repo: RepositoryIdentifier,
    prNumber: number,
  ): Promise<PrDiff[]> {
    const files = await this.octokit.paginate(
      this.octokit.rest.pulls.listFiles,
      {
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        per_page: 100,
      },
    );

    return files.map((file) => {
      const mappedStatus = file.status === 'removed' ? 'deleted' : file.status;

      return {
        filename: file.filename,
        previousFilename: file.previous_filename,
        status: mappedStatus as FileChangeStatus,
        patch: file.patch ?? '',
        additions: file.additions,
        deletions: file.deletions,
      };
    });
  }

  async getIssue(
    repo: RepositoryIdentifier,
    issueNumber: number,
  ): Promise<unknown> {
    const { data } = await this.octokit.rest.issues.get({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
    });
    return data;
  }

  async *getHistoricalDiscussions(
    repo: RepositoryIdentifier,
  ): AsyncIterableIterator<HistoricalDiscussion> {
    yield* this.fetchIssueComments(repo);
    yield* this.fetchReviewComments(repo);
  }

  private async *fetchIssueComments(
    repo: RepositoryIdentifier,
  ): AsyncIterableIterator<HistoricalDiscussion> {
    const issueComments = this.octokit.paginate.iterator(
      this.octokit.rest.issues.listCommentsForRepo,
      {
        owner: repo.owner,
        repo: repo.name,
        per_page: 100,
      },
    );

    for await (const { data } of issueComments) {
      for (const comment of data) {
        if (comment.user?.type === 'Bot') continue;
        if (!comment.html_url.includes('/pull/')) continue; // PR discussions only

        const match = /\/(\d+)$/.exec(comment.issue_url);
        const prNumber = match ? Number(match[1]) : undefined;

        yield {
          prNumber,
          source: 'issue_comment',
          author: comment.user?.login ?? 'unknown',
          body: comment.body ?? '',
          providerId: comment.id ? String(comment.id) : undefined,
          createdAt: new Date(comment.created_at),
        };
      }
    }
  }

  private async *fetchReviewComments(
    repo: RepositoryIdentifier,
  ): AsyncIterableIterator<HistoricalDiscussion> {
    const reviewComments = this.octokit.paginate.iterator(
      this.octokit.rest.pulls.listReviewCommentsForRepo,
      {
        owner: repo.owner,
        repo: repo.name,
        per_page: 100,
      },
    );

    for await (const { data } of reviewComments) {
      for (const comment of data) {
        if (comment.user?.type === 'Bot') continue;

        const match = /\/(\d+)$/.exec(comment.pull_request_url);
        const prNumber = match ? Number(match[1]) : undefined;

        yield {
          prNumber,
          source: 'review_comment',
          author: comment.user?.login ?? 'unknown',
          filePath: comment.path,
          body: comment.body,
          providerId: comment.id ? String(comment.id) : undefined,
          createdAt: new Date(comment.created_at),
        };
      }
    }
  }

  getCloneToken(): Promise<string> {
    return Promise.resolve(this.installationToken);
  }

  async getCloneUrl(repo: RepositoryIdentifier): Promise<string> {
    const { data } = await this.octokit.rest.repos.get({
      owner: repo.owner,
      repo: repo.name,
    });
    return data.clone_url;
  }
}
