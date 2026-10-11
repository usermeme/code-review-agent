export interface ProcessedWebhookResult {
  ignored: boolean;
  reason?: string;
}

export interface GithubWebhookPayload {
  action?: string;
  pull_request?: {
    number: number;
    html_url: string;
    title: string;
    body: string;
    user: { login: string };
    head: { ref: string; sha?: string };
    base?: { ref: string; repo?: { clone_url?: string } };
    merged?: boolean;
  };
  issue?: {
    number: number;
    html_url: string;
    pull_request?: unknown;
  };
  comment?: {
    body: string;
  };
  repository?: {
    name: string;
    owner?: {
      login: string;
    };
  };
}
