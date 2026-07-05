export type ProviderId = 'github';

export interface RepositoryIdentifier {
  provider: ProviderId;
  owner: string;
  name: string;
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unchanged';

export interface PrDiff {
  filename: string;
  previousFilename?: string; // Included if the file was renamed/copied
  status: FileChangeStatus;
  patch: string; // Unified diff format
  additions: number;
  deletions: number;
}

export interface PullRequestDetails {
  id: string; // Platform-agnostic string ID
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  baseSha: string;
  headSha: string;
  authorUsername: string;
  url: string;
}

export interface ReviewComment {
  path: string;
  line?: number;
  body: string;
}

export type DiscussionSource = 'issue_comment' | 'review_comment' | 'review' | 'bot_finding';

export interface HistoricalDiscussion {
  prNumber?: number;
  source: DiscussionSource;
  author: string;
  filePath?: string;
  body: string;
  providerId?: string;
  createdAt: Date;
}
