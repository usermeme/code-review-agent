import type { Octokit } from 'octokit';

export interface PrFile {
  filename: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
}

export interface PrBundle {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  branch: string;
  headSha: string;
  baseRef: string;
  author: string;
  cloneUrl: string;
  /** Clone URL of the base repository — the PR head may live on a fork. */
  baseCloneUrl: string;
  diff: string;
  files: PrFile[];
}

export async function fetchPrBundle(octokit: Octokit, owner: string, repo: string, number: number): Promise<PrBundle> {
  const [{ data: pr }, diffResponse, files] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number: number }),
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
      mediaType: { format: 'diff' },
    }),
    octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    }),
  ]);

  return {
    owner,
    repo,
    number,
    title: pr.title,
    body: pr.body ?? '',
    branch: pr.head.ref,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    author: pr.user?.login ?? 'unknown',
    cloneUrl: pr.head.repo?.clone_url ?? pr.base.repo.clone_url,
    baseCloneUrl: pr.base.repo.clone_url,
    diff: diffResponse.data as unknown as string,
    files: files.map((f) => ({
      filename: f.filename,
      status: f.status,
      patch: f.patch,
      additions: f.additions,
      deletions: f.deletions,
    })),
  };
}
