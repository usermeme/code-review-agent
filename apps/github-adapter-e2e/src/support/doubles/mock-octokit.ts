export interface PostedComment {
  owner: string;
  repo: string;
  pull_number: number;
  body: string;
  path: string;
  line: number;
  commit_id: string;
}

export interface PostedReview {
  owner: string;
  repo: string;
  pull_number: number;
  body: string;
  event?: string;
  commit_id?: string;
  comments?: Array<{
    path: string;
    body: string;
    line?: number;
    start_line?: number;
  }>;
}

export interface PostedIssueComment {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
}

export class MockOctokit {
  public postedComments: PostedComment[] = [];
  public postedReviews: PostedReview[] = [];
  public postedIssueComments: PostedIssueComment[] = [];
  public diff =
    'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,4 @@\n+const x = 1;';
  public changedFiles = ['src/index.ts'];
  public headSha = 'mock-head-sha-12345';

  rest = {
    pulls: {
      get: async (params: {
        owner: string;
        repo: string;
        pull_number: number;
        mediaType?: { format: string };
      }) => {
        if (params.mediaType?.format === 'diff') {
          return { data: this.diff };
        }
        return {
          data: {
            title: `PR #${params.pull_number}`,
            body: 'Mock PR description',
            user: { login: 'testuser' },
            head: { sha: this.headSha, ref: 'feature-branch' },
            base: {
              ref: 'main',
              repo: {
                clone_url: `https://github.com/${params.owner}/${params.repo}.git`,
              },
            },
          },
        };
      },
      listFiles: async (_params: {
        owner: string;
        repo: string;
        pull_number: number;
      }) => {
        void _params;
        return {
          data: this.changedFiles.map((filename) => ({ filename })),
        };
      },
      createReviewComment: async (params: PostedComment) => {
        this.postedComments.push(params);
        return { data: { id: this.postedComments.length } };
      },
      createReview: async (params: PostedReview) => {
        this.postedReviews.push(params);
        for (const comment of params.comments ?? []) {
          this.postedComments.push({
            owner: params.owner,
            repo: params.repo,
            pull_number: params.pull_number,
            body: comment.body,
            path: comment.path,
            line: comment.line ?? 0,
            commit_id: params.commit_id ?? '',
          });
        }
        return { data: { id: this.postedReviews.length } };
      },
    },
    search: {
      code: async (params: { q: string }) => {
        return {
          data: {
            total_count: 1,
            items: [
              {
                name: 'index.ts',
                path: 'src/index.ts',
                sha: this.headSha,
                html_url: `https://github.com/mock-org/mock-repo/blob/main/src/index.ts?query=${encodeURIComponent(params.q)}`,
              },
            ],
          },
        };
      },
    },
    repos: {
      getContent: async (params: {
        owner: string;
        repo: string;
        path: string;
        ref?: string;
      }) => {
        return {
          data: {
            path: params.path,
            content: Buffer.from('export const answer = 42;').toString(
              'base64',
            ),
            encoding: 'base64',
            sha: this.headSha,
          },
        };
      },
    },
    issues: {
      createComment: async (params: PostedIssueComment) => {
        this.postedIssueComments.push(params);
        return { data: { id: this.postedIssueComments.length } };
      },
    },
  };

  clear(): void {
    this.postedComments = [];
    this.postedReviews = [];
    this.postedIssueComments = [];
  }
}

export class MockGithubApp {
  public uninstalledRepos = new Set<string>();
  public requestedInstallations: { owner: string; repo: string }[] = [];

  constructor(private readonly installationOctokit: MockOctokit) {}

  octokit = {
    rest: {
      apps: {
        getRepoInstallation: async (params: {
          owner: string;
          repo: string;
        }) => {
          this.requestedInstallations.push(params);
          if (this.uninstalledRepos.has(`${params.owner}/${params.repo}`)) {
            throw Object.assign(new Error('Not Found'), { status: 404 });
          }
          return { data: { id: 1001 } };
        },
      },
    },
  };

  async getInstallationOctokit(_installationId: number) {
    void _installationId;
    return this.installationOctokit;
  }

  clear(): void {
    this.uninstalledRepos.clear();
    this.requestedInstallations = [];
    this.installationOctokit.clear();
  }
}
