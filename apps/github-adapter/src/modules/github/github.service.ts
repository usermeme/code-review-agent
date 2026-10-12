import { Octokit } from '@octokit/rest';

import type { AdapterEnvService } from '../../env.js';
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
  envService: AdapterEnvService;
  octokit?: Octokit;
  token?: string;
}

export class GithubService implements GitAdapterContract {
  private octokit: Octokit;
  private envService: AdapterEnvService;
  private token: string;

  constructor(deps: GithubServiceDependencies) {
    this.envService = deps.envService;
    const token = deps.token ?? deps.envService.get('GITHUB_TOKEN');
    this.token = token;
    this.octokit = deps.octokit ?? new Octokit({ auth: token });
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
    const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(targetRef)}`;
    const headers: Record<string, string> = {
      'User-Agent': 'code-review-agent-github-adapter',
      Accept: 'application/vnd.github+json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(tarballUrl, {
      headers,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download repository archive from GitHub: HTTP ${response.status} ${response.statusText}`,
      );
    }

    return response;
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

    let decodedContent = '';
    if (data.encoding === 'base64' && data.content) {
      decodedContent = Buffer.from(data.content, 'base64').toString('utf8');
    } else if (data.content) {
      decodedContent = data.content;
    }

    return {
      path: data.path,
      content: decodedContent,
      encoding: 'utf-8',
      sha: data.sha,
    };
  }

  async postReview(options: PostReviewOptions): Promise<PostReviewResult> {
    const { owner, repo, prNumber, summary, ticketCoverage, comments } =
      options;

    let body = `## 🤖 AI Code Review Summary\n\n${summary}`;
    if (ticketCoverage) {
      body += `\n\n### 🎯 Ticket & Requirements Coverage\n\n${ticketCoverage}`;
    }
    if (comments && comments.length > 0) {
      const plural = comments.length === 1 ? '' : 's';
      body += `\n\n---\n*Found ${comments.length} inline review comment${plural}.*`;
    }

    let commit_id: string | undefined;
    try {
      const prData = await this.octokitClient.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      commit_id = prData.data.head.sha;
    } catch (e) {
      console.warn('Failed to fetch PR head sha for review summary', e);
    }

    let reviewId: string;
    try {
      const reviewRes = await this.octokitClient.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body,
        event: 'COMMENT',
        ...(commit_id ? { commit_id } : {}),
      });
      reviewId = String(reviewRes.data.id);
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
        reviewId = String(commentRes.data.id);
      } catch {
        return {
          success: false,
          message: `Failed to post review: ${reviewErr}`,
        };
      }
    }

    // Post inline comments if commit_id is available
    if (commit_id && comments && comments.length > 0) {
      for (const comment of comments) {
        try {
          await this.octokitClient.rest.pulls.createReviewComment({
            owner,
            repo,
            pull_number: prNumber,
            body: comment.body,
            path: comment.path,
            line: comment.position,
            commit_id,
          });
        } catch (error) {
          console.error(
            `Failed to post comment to ${comment.path}:${comment.position}`,
            error,
          );
        }
      }
    }

    return {
      success: true,
      message: 'Review posted successfully',
      reviewId,
    };
  }
}
