import { Octokit } from '@octokit/rest';

import {
  CodeSearchResult,
  FileContentResult,
  GitAdapterContract,
  PostReviewOptions,
  PostReviewResult,
  PRDiffResult,
  PRFile,
} from './interfaces/github.interface.js';

export interface GithubServiceDependencies {
  octokit: Octokit;
}

type ReviewComment = PostReviewOptions['comments'][number];

interface InlineCommentCounts {
  postedComments: number;
  failedComments: number;
}

type ReviewSubmission = { reviewId: string } | { failure: PostReviewResult };

function decodeFileContent(data: {
  encoding: string;
  content: string;
}): string {
  if (data.encoding === 'base64' && data.content) {
    return Buffer.from(data.content, 'base64').toString('utf8');
  }
  if (data.content) {
    return data.content;
  }
  return '';
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
  let body = `## 🤖 AI Code Review Summary\n\n${summary}`;
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

function buildPostedReviewMessage(
  postedComments: number,
  failedComments: number,
): string {
  return failedComments > 0
    ? `Review posted successfully (${postedComments}/${postedComments + failedComments} inline comments posted; ${failedComments} failed — lines may be outside the diff)`
    : 'Review posted successfully';
}

export class GithubService implements GitAdapterContract {
  private octokit: Octokit;

  constructor(deps: GithubServiceDependencies) {
    this.octokit = deps.octokit;
  }

  private get octokitClient(): Octokit {
    return this.octokit;
  }

  async getPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PRDiffResult> {
    const [diffResponse, filesResponse] = await Promise.all([
      this.octokitClient.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
        mediaType: {
          format: 'diff',
        },
      }),
      this.octokitClient.rest.pulls.listFiles({
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
    const filesResponse = await this.octokitClient.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
    });

    const results: PRFile[] = [];
    for (const file of filesResponse.data) {
      if (file.status === 'removed') {
        results.push({
          filename: file.filename,
          status: file.status,
        });
        continue;
      }

      let content: string | undefined;
      try {
        const fileContent = await this.getFileContent(
          owner,
          repo,
          file.filename,
        );
        content = fileContent.content;
      } catch {
        content = file.patch;
      }

      results.push({
        filename: file.filename,
        status: file.status,
        content,
        patch: file.patch,
      });
    }

    return results;
  }

  async getRepoTarball(
    owner: string,
    repo: string,
    ref?: string,
  ): Promise<Response> {
    const targetRef = ref || 'main';
    const octokitRes =
      await this.octokitClient.rest.repos.downloadTarballArchive({
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
    const q = `${query} repo:${owner}/${repo}`;
    const response = await this.octokitClient.rest.search.code({
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
    const response = await this.octokitClient.rest.repos.getContent({
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

    const body = buildReviewBody(summary, ticketCoverage, comments);
    const commitId = await this.resolveHeadCommitId(owner, repo, prNumber);

    const submission = await this.submitReviewWithFallback(
      owner,
      repo,
      prNumber,
      body,
      commitId,
    );
    if ('failure' in submission) {
      return submission.failure;
    }

    // Post inline comments if commit_id is available
    let counts: InlineCommentCounts = {
      postedComments: 0,
      failedComments: 0,
    };
    if (commitId && comments && comments.length > 0) {
      counts = await this.postInlineComments(
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
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<string | undefined> {
    try {
      const prData = await this.octokitClient.rest.pulls.get({
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
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    commitId: string | undefined,
  ): Promise<ReviewSubmission> {
    try {
      const reviewRes = await this.octokitClient.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body,
        event: 'COMMENT',
        ...(commitId ? { commit_id: commitId } : {}),
      });
      return { reviewId: String(reviewRes.data.id) };
    } catch (reviewErr) {
      console.warn(
        `[GithubService] Failed to submit formal PR review, falling back to issue comment:`,
        reviewErr,
      );
      try {
        const commentRes = await this.octokitClient.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body,
        });
        return { reviewId: String(commentRes.data.id) };
      } catch {
        return {
          failure: {
            success: false,
            message: `Failed to post review: ${reviewErr}`,
          },
        };
      }
    }
  }

  private async postInlineComments(
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
        await this.postInlineComment(owner, repo, prNumber, comment, commitId);
        postedComments += 1;
      } catch (error) {
        failedComments += 1;
        console.error(
          `Failed to post comment to ${comment.path}:${comment.position}`,
          error,
        );
      }
    }
    return { postedComments, failedComments };
  }

  private async postInlineComment(
    owner: string,
    repo: string,
    prNumber: number,
    comment: ReviewComment,
    commitId: string,
  ): Promise<void> {
    const line = comment.line ?? comment.position;
    const startLine = resolveStartLine(comment, line);
    await this.octokitClient.rest.pulls.createReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      body: comment.body,
      path: comment.path,
      ...(startLine ? { start_line: startLine } : {}),
      ...(line ? { line } : {}),
      commit_id: commitId,
    });
  }
}
