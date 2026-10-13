import type { GitAdapterContract } from '@code-review-agent/shared-types';

/**
 * The one repository a review may read, fixed in code from the PR being
 * reviewed. Tools never take owner/repo from the model: a prompt injection in
 * the diff could otherwise point them at any repo the adapter's token can read
 * and get its files quoted into a public PR comment.
 */
export interface RepoScope {
  gitAdapter: GitAdapterContract;
  owner: string;
  repo: string;
  /** PR head branch — where the code under review lives. */
  headRef?: string;
  /** PR base branch — where the repo's trusted, already-merged rules live. */
  baseRef?: string;
}
