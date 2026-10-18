import type {
  CodeSearchResult,
  FileContentResult,
  GitAdapterContract,
  PRDiffResult,
  PRFile,
} from '@code-review-agent/shared-types';
import { Octokit } from 'octokit';
import PQueue from 'p-queue';

import { GithubAuthProvider } from './github-auth.service.js';
import {
  PostReviewOptions,
  PostReviewResult,
} from './interfaces/github.interface.js';

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

type ReviewSubmission = { reviewId: string } | { failure: PostReviewResult };

const PR_FILES_CONCURRENCY = 5;

export function formatError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : JSON.stringify(error);
}

function decodeFileContent(data: {
  encoding: string;
  content: string;
}): string {
  if (!data.content) {
    return '';
  }
  return data.encoding === 'base64'
    ? Buffer.from(data.content, 'base64').toString('utf8')
    : data.content;
}

function buildCommentsFooter(comments: ReviewComment[]): string {
  const plural = comments.length === 1 ? '' : 's';
  return `\n\n---\n*Found ${comments.length} inline review comment${plural}.*`;
}

function buildReviewBody(
  summary: string | undefined,
  ticketCoverage: string | undefined,
  comments: ReviewComment[] | undefined,
): string {
  let body = `## 🤖 AI Code Review Summary\n\n${summary ?? ''}`;
  if (ticketCoverage) {
    body += `\n\n### 🎯 Ticket & Requirements Coverage\n\n${ticketCoverage}`;
  }
  if (comments && comments.length > 0) {
    body += buildCommentsFooter(comments);
  }
  return body;
}

function resolveStartLine(
  comment: ReviewComment,
  line: number | undefined,
): number | undefined {
  // Multi-line findings anchor to their full range; GitHub requires
  // start_line < line (side defaults to RIGHT, the NEW side).
  return comment.startPosition && line && comment.startPosition < line
    ? comment.startPosition
    : undefined;
}

function toReviewCommentParams(comment: ReviewComment): ReviewCommentParams {
  const line = comment.line ?? comment.position;
  const startLine = resolveStartLine(comment, line);
  return {
    path: comment.path,
    body: comment.body,
    ...(startLine ? { start_line: startLine } : {}),
    ...(line ? { line } : {}),
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

  async getPRFiles(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRFile[]> {
    const octokit = await this.authService.getOctokit(owner, repo);
    const filesResponse = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });

    const queue = new PQueue({ concurrency: PR_FILES_CONCURRENCY });
    return Promise.all(
      filesResponse.data.map((file) =>
        queue.add(() => this.resolvePRFile(owner, repo, file)),
      ),
    );
  }

  private async resolvePRFile(
    owner: string,
    repo: string,
    file: { filename: string; status: string; patch?: string },
  ): Promise<PRFile> {
    if (file.status === 'removed') {
      return {
        filename: file.filename,
        status: file.status,
      };
    }

    let content: string | undefined;
    try {
      const fileContent = await this.getFileContent(owner, repo, file.filename);
      content = fileContent.content;
    } catch {
      content = file.patch;
    }

    return {
      filename: file.filename,
      status: file.status,
      content,
      patch: file.patch,
    };
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

  async searchCode(
    owner: string,
    repo: string,
    query: string,
  ): Promise<CodeSearchResult> {
    const octokit = await this.authService.getOctokit(owner, repo);
    const q = `${query} repo:${owner}/${repo}`;
    const response = await octokit.rest.search.code({
      q,
    });

    return {
      totalCount: response.data.total_count,
      items: response.data.items.map((item) => ({
        name: item.name,
        path: item.path,
        sha: item.sha,
        htmlUrl: item.html_url,
      })),
    };
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<FileContentResult> {
    const octokit = await this.authService.getOctokit(owner, repo);
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ...(ref ? { ref } : {}),
    });

    const data = response.data;
    if (Array.isArray(data) || !('content' in data)) {
      throw new Error(`Path ${path} is a directory or submodule, not a file`);
    }

    return {
      path: data.path,
      content: decodeFileContent(data),
      encoding: 'utf-8',
      sha: data.sha,
    };
  }

  async postReview(options: PostReviewOptions): Promise<PostReviewResult> {
    const { owner, repo, prNumber, summary, ticketCoverage, comments } =
      options;

    const octokit = await this.authService.getOctokit(owner, repo);
    const body = buildReviewBody(summary, ticketCoverage, comments);
    const commitId = await this.resolveHeadCommitId(
      octokit,
      owner,
      repo,
      prNumber,
    );

    const batchedReviewId = await this.tryBatchReview(
      octokit,
      owner,
      repo,
      prNumber,
      body,
      commitId,
      comments,
    );
    if (batchedReviewId) {
      return {
        success: true,
        message: 'Review posted successfully',
        reviewId: batchedReviewId,
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
  ): Promise<string | undefined> {
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
      return String(reviewRes.data.id);
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
  ): Promise<PostReviewResult> {
    const submission = await this.submitReviewWithFallback(
      octokit,
      owner,
      repo,
      prNumber,
      body,
      commitId,
    );
    if ('failure' in submission) {
      return submission.failure;
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
      success: true,
      message: buildPostedReviewMessage(
        counts.postedComments,
        counts.failedComments,
      ),
      reviewId: submission.reviewId,
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

  private async submitReviewWithFallback(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    commitId: string | undefined,
  ): Promise<ReviewSubmission> {
    try {
      const reviewRes = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body,
        event: 'COMMENT',
        ...(commitId ? { commit_id: commitId } : {}),
      });
      return { reviewId: String(reviewRes.data.id) };
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
          `Failed to post comment to ${comment.path}:${comment.line ?? comment.position}`,
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
    await octokit.rest.pulls.createReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      ...toReviewCommentParams(comment),
    });
  }
}
