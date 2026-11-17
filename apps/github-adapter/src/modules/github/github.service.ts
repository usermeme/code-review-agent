import type {
  CompareDiffResult,
  GitAdapterContract,
  PRDiffResult,
  RepoTreeFilesResult,
  ReviewThread,
} from '@code-review-agent/shared-types';
import { Octokit } from 'octokit';

import { GithubAuthProvider } from './github-auth.service.js';
import {
  PostReviewOptions,
  PostReviewResult,
} from './interfaces/github.interface.js';
import {
  decideReviewEvent,
  dismissOwnApprovals,
  type ReviewEvent,
} from './review-approval.js';
import { fetchReviewThreads } from './review-threads.query.js';

export interface GithubServiceDependencies {
  authService: GithubAuthProvider;
}

type ReviewComment = PostReviewOptions['comments'][number];

interface ReviewCommentParams {
  path: string;
  body: string;
  line?: number;
  start_line?: number;
}

interface InlineCommentCounts {
  postedComments: number;
  failedComments: number;
}

/** A posted review, with the bot login GitHub reports for it when known. */
interface PostedReview {
  reviewId: string;
  login?: string;
  /** Omitted for the issue-comment fallback, which is neither. */
  event?: ReviewEvent;
}

type ReviewSubmission = PostedReview | { failure: PostReviewResult };

interface PublishedReview {
  result: PostReviewResult;
  login?: string;
}

/** Lowercased last segment of a repository path. */
function basename(path: string): string {
  return (path.split('/').pop() ?? '').toLowerCase();
}

export function formatError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : JSON.stringify(error);
}

function buildCommentsFooter(comments: ReviewComment[]): string {
  const plural = comments.length === 1 ? '' : 's';
  return `\n\n---\n*Found ${comments.length} inline review comment${plural}.*`;
}

function buildReviewBody(
  summary: string | undefined,
  comments: ReviewComment[] | undefined,
): string {
  let body = `## 🤖 AI Code Review Summary\n\n${summary ?? ''}`;
  if (comments && comments.length > 0) {
    body += buildCommentsFooter(comments);
  }
  return body;
}

function resolveStartLine(comment: ReviewComment): number | undefined {
  // Multi-line findings anchor to their full range; GitHub requires
  // start_line < line (side defaults to RIGHT, the NEW side).
  return comment.startLine && comment.startLine < comment.line
    ? comment.startLine
    : undefined;
}

function toReviewCommentParams(comment: ReviewComment): ReviewCommentParams {
  const startLine = resolveStartLine(comment);
  return {
    path: comment.path,
    body: comment.body,
    line: comment.line,
    ...(startLine ? { start_line: startLine } : {}),
  };
}

function hasBatchableComments(
  commitId: string | undefined,
  comments: ReviewComment[] | undefined,
): comments is ReviewComment[] {
  return Boolean(commitId && comments && comments.length > 0);
}

function buildPostedReviewMessage(
  postedComments: number,
  failedComments: number,
): string {
  return failedComments > 0
    ? `Review posted successfully (${postedComments}/${postedComments + failedComments} inline comments posted; ${failedComments} failed — lines may be outside the diff)`
    : 'Review posted successfully';
}

function isRetryableGithubError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && (status === 429 || status >= 500);
}

export class GithubService implements GitAdapterContract {
  private readonly authService: GithubAuthProvider;

  constructor(deps: GithubServiceDependencies) {
    this.authService = deps.authService;
  }

  async getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRDiffResult> {
    const octokit = await this.authService.getOctokit(owner, repo);
    const [diffResponse, filesResponse] = await Promise.all([
      octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
        mediaType: {
          format: 'diff',
        },
      }),
      octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
      }),
    ]);

    const diff = diffResponse.data as unknown as string;
    const changedFiles = filesResponse.data.map((file) => file.filename);

    return {
      diff,
      changedFiles,
    };
  }

  async getCompareDiff(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<CompareDiffResult> {
    const octokit = await this.authService.getOctokit(owner, repo);
    const basehead = `${base}...${head}`;
    const [diffResponse, summaryResponse] = await Promise.all([
      octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead,
        mediaType: { format: 'diff' },
      }),
      octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead }),
    ]);
    return {
      diff: diffResponse.data as unknown as string,
      changedFiles: (summaryResponse.data.files ?? []).map((f) => f.filename),
      status: summaryResponse.data.status,
    };
  }

  async getReviewThreads(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ReviewThread[]> {
    const octokit = await this.authService.getOctokit(owner, repo);
    return fetchReviewThreads(octokit.graphql, {
      owner,
      repo,
      number: prNumber,
    });
  }

  async listTreeFiles(
    owner: string,
    repo: string,
    ref: string,
    names: string[],
  ): Promise<RepoTreeFilesResult> {
    const octokit = await this.authService.getOctokit(owner, repo);
    const { data } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: 'true',
    });
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    const files = data.tree
      .filter((entry) => entry.type === 'blob' && entry.path && entry.sha)
      .filter((entry) => wanted.has(basename(entry.path ?? '')))
      .map((entry) => ({ path: entry.path ?? '', blobSha: entry.sha ?? '' }));
    return { files, truncated: data.truncated };
  }

  async getBlob(owner: string, repo: string, blobSha: string): Promise<string> {
    const octokit = await this.authService.getOctokit(owner, repo);
    const { data } = await octokit.rest.git.getBlob({
      owner,
      repo,
      file_sha: blobSha,
    });
    return Buffer.from(data.content, 'base64').toString('utf8');
  }

  async getRepoTarball(
    owner: string,
    repo: string,
    ref?: string,
  ): Promise<Response> {
    const targetRef = ref || 'main';
    const octokit = await this.authService.getOctokit(owner, repo);
    const octokitRes = await octokit.rest.repos.downloadTarballArchive({
      owner,
      repo,
      ref: targetRef,
      request: {
        parseSuccessResponseBody: false,
      },
    });

    const headers: Record<string, string> = {
      'content-type':
        octokitRes.headers['content-type'] || 'application/x-gzip',
    };
    if (octokitRes.headers['x-github-commit-sha']) {
      headers['x-github-commit-sha'] = String(
        octokitRes.headers['x-github-commit-sha'],
      );
    }

    return new Response(
      octokitRes.data as ConstructorParameters<typeof Response>[0],
      {
        status: octokitRes.status,
        headers,
      },
    );
  }

  async postReview(options: PostReviewOptions): Promise<PostReviewResult> {
    const { owner, repo, summary, comments } = options;

    const octokit = await this.authService.getOctokit(owner, repo);
    const commitId = await this.resolveHeadCommitId(
      octokit,
      owner,
      repo,
      options.prNumber,
    );
    const decision = await decideReviewEvent(octokit, options, commitId);
    const body = buildReviewBody(summary, comments) + decision.note;

    const published = await this.publishReview(
      octokit,
      options,
      body,
      commitId,
      decision.event,
    );
    // An earlier approval no longer holds once a newer review finds issues.
    if (published.login && comments.length > 0) {
      await dismissOwnApprovals(octokit, options, published.login);
    }
    return published.result;
  }

  private async publishReview(
    octokit: Octokit,
    options: PostReviewOptions,
    body: string,
    commitId: string | undefined,
    event: ReviewEvent,
  ): Promise<PublishedReview> {
    const { owner, repo, prNumber, comments } = options;
    const batched = await this.tryBatchReview(
      octokit,
      owner,
      repo,
      prNumber,
      body,
      commitId,
      comments,
    );
    if (batched) {
      return {
        result: {
          success: true,
          message: 'Review posted successfully',
          reviewId: batched.reviewId,
          event: 'COMMENT',
        },
        login: batched.login,
      };
    }

    return this.submitSummaryAndIndividualComments(
      octokit,
      owner,
      repo,
      prNumber,
      body,
      commitId,
      comments,
      event,
    );
  }

  private async tryBatchReview(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    commitId: string | undefined,
    comments: ReviewComment[] | undefined,
  ): Promise<PostedReview | undefined> {
    if (!hasBatchableComments(commitId, comments)) {
      return undefined;
    }
    try {
      const reviewRes = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body,
        event: 'COMMENT',
        commit_id: commitId,
        comments: comments.map(toReviewCommentParams),
      });
      return {
        reviewId: String(reviewRes.data.id),
        login: reviewRes.data.user?.login,
      };
    } catch (err) {
      if (isRetryableGithubError(err)) {
        throw err;
      }
      return undefined;
    }
  }

  private async submitSummaryAndIndividualComments(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    commitId: string | undefined,
    comments: ReviewComment[] | undefined,
    event: ReviewEvent,
  ): Promise<PublishedReview> {
    const submission = await this.submitReview(
      octokit,
      owner,
      repo,
      prNumber,
      body,
      commitId,
      event,
    );
    if ('failure' in submission) {
      return { result: submission.failure };
    }

    let counts: InlineCommentCounts = {
      postedComments: 0,
      failedComments: 0,
    };
    if (commitId && comments && comments.length > 0) {
      counts = await this.postInlineComments(
        octokit,
        owner,
        repo,
        prNumber,
        commitId,
        comments,
      );
    }

    return {
      result: {
        success: true,
        message: buildPostedReviewMessage(
          counts.postedComments,
          counts.failedComments,
        ),
        reviewId: submission.reviewId,
        event: submission.event,
      },
      login: submission.login,
    };
  }

  private async resolveHeadCommitId(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<string | undefined> {
    try {
      const prData = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      return prData.data.head.sha;
    } catch (e) {
      console.warn('Failed to fetch PR head sha for review summary', e);
      return undefined;
    }
  }

  private async createFormalReview(
    octokit: Octokit,
    pr: { owner: string; repo: string; prNumber: number },
    body: string,
    commitId: string | undefined,
    event: ReviewEvent,
  ): Promise<PostedReview> {
    const reviewRes = await octokit.rest.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.prNumber,
      body,
      event,
      ...(commitId ? { commit_id: commitId } : {}),
    });
    return {
      reviewId: String(reviewRes.data.id),
      login: reviewRes.data.user?.login,
      event,
    };
  }

  /** Approves when asked; a rejected approval still posts as a comment. */
  private async submitReview(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    commitId: string | undefined,
    event: ReviewEvent,
  ): Promise<ReviewSubmission> {
    const fallback = () =>
      this.submitReviewWithFallback(
        octokit,
        owner,
        repo,
        prNumber,
        body,
        commitId,
      );
    if (event !== 'APPROVE') return fallback();
    try {
      const pr = { owner, repo, prNumber };
      return await this.createFormalReview(octokit, pr, body, commitId, event);
    } catch (approveErr) {
      if (isRetryableGithubError(approveErr)) throw approveErr;
      console.warn(
        `[GithubService] Approval rejected, posting as a comment instead:`,
        approveErr,
      );
      return fallback();
    }
  }

  private async submitReviewWithFallback(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    commitId: string | undefined,
  ): Promise<ReviewSubmission> {
    try {
      const pr = { owner, repo, prNumber };
      return await this.createFormalReview(
        octokit,
        pr,
        body,
        commitId,
        'COMMENT',
      );
    } catch (reviewErr) {
      if (isRetryableGithubError(reviewErr)) {
        throw reviewErr;
      }
      console.warn(
        `[GithubService] Failed to submit formal PR review, falling back to issue comment:`,
        reviewErr,
      );
      return this.submitFallbackIssueComment(
        octokit,
        owner,
        repo,
        prNumber,
        body,
        reviewErr,
      );
    }
  }

  private async submitFallbackIssueComment(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    reviewErr: unknown,
  ): Promise<ReviewSubmission> {
    try {
      const commentRes = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
      return { reviewId: String(commentRes.data.id) };
    } catch (commentErr) {
      if (isRetryableGithubError(commentErr)) {
        throw commentErr;
      }
      const message =
        reviewErr instanceof Error
          ? reviewErr.message
          : JSON.stringify(reviewErr);
      return {
        failure: {
          success: false,
          message: `Failed to post review: ${message}`,
        },
      };
    }
  }

  private async postInlineComments(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    commitId: string,
    comments: ReviewComment[],
  ): Promise<InlineCommentCounts> {
    let postedComments = 0;
    let failedComments = 0;
    for (const comment of comments) {
      try {
        await this.postInlineComment(
          octokit,
          owner,
          repo,
          prNumber,
          comment,
          commitId,
        );
        postedComments += 1;
      } catch (error) {
        failedComments += 1;
        console.error(
          `Failed to post comment to ${comment.path}:${comment.line}`,
          error,
        );
      }
    }
    return { postedComments, failedComments };
  }

  private async postInlineComment(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    comment: ReviewComment,
    commitId: string,
  ): Promise<void> {
    await this.postInlineCommentRequest(
      octokit,
      owner,
      repo,
      prNumber,
      comment,
      commitId,
    );
  }

  private async postInlineCommentRequest(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    comment: ReviewComment,
    commitId: string,
  ): Promise<void> {
    await octokit.rest.pulls.createReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      ...toReviewCommentParams(comment),
    });
  }
}
