export interface PRState {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  status: 'queued' | 'building_context' | 'reviewing' | 'completed' | 'failed';
  updatedAt: Date;
}

export interface ContextReadyPayload {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  summary: string;
}

export interface RepositoryContext {
  prKey: string;
  summary: string;
  updatedAt: Date;
}

export interface ReviewResultPayload {
  provider: string;
  owner: string;
  repo: string;
  prNumber: number;
  comments: { path: string; position: number; body: string }[];
}

export interface WebhookEventPayload {
  action: string;
  prNumber: number;
  owner: string;
  repo: string;
  htmlUrl: string;
  cloneUrl?: string;
  ref?: string;
  token?: string;
  installationId?: number;
  isIncrementalUpdate?: boolean;
}
