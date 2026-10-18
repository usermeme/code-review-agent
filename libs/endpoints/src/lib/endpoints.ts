export interface EndpointPayloadRecord {
  // Provider Git Adapter endpoints
  '/api/v1/repos/:owner/:repo/pulls/:prNumber/diff': {
    Path: {
      owner: string;
      repo: string;
      prNumber: number | string;
    };
    Params?: {
      owner: string;
      repo: string;
      number: string;
    };
  };
  '/api/v1/repos/:owner/:repo/pulls/:prNumber/files': {
    Path: {
      owner: string;
      repo: string;
      prNumber: number | string;
    };
    Params?: {
      owner: string;
      repo: string;
      number: string;
    };
  };
  '/api/v1/repos/:owner/:repo/search': {
    Path: {
      owner: string;
      repo: string;
    };
    Params?: {
      owner: string;
      repo: string;
    };
    Query?: {
      q?: string;
    };
  };
  '/api/v1/repos/:owner/:repo/files/:path': {
    Path: {
      owner: string;
      repo: string;
      path: string;
    };
    Params?: {
      owner: string;
      repo: string;
      '*': string;
    };
    Query?: {
      ref?: string;
    };
  };
  '/api/v1/repos/:owner/:repo/tarball': {
    Path: {
      owner: string;
      repo: string;
    };
    Params?: {
      owner: string;
      repo: string;
    };
    Query?: {
      ref?: string;
    };
  };

  // Core context lookup endpoint
  '/api/v1/context/:prKey': {
    Path: {
      prKey: string;
    };
    Params?: {
      prKey: string;
    };
  };

  // Pub/Sub push endpoints
  '/api/v1/pubsub/pr-events': {
    Body?: unknown;
  };
  '/api/v1/pubsub/review-results': {
    Body?: unknown;
  };

  // Webhooks ingress endpoint
  '/api/v1/webhooks': {
    Body?: unknown;
  };

  // Health endpoint
  '/healthz': Record<string, never>;
}

export type Endpoint = keyof EndpointPayloadRecord;

export const ENDPOINTS = {
  PR_DIFF: '/api/v1/repos/:owner/:repo/pulls/:prNumber/diff',
  PR_FILES: '/api/v1/repos/:owner/:repo/pulls/:prNumber/files',
  SEARCH_CODE: '/api/v1/repos/:owner/:repo/search',
  FILE_CONTENT: '/api/v1/repos/:owner/:repo/files/:path',
  TARBALL: '/api/v1/repos/:owner/:repo/tarball',
  CONTEXT: '/api/v1/context/:prKey',
  PUBSUB_PR_EVENTS: '/api/v1/pubsub/pr-events',
  PUBSUB_REVIEW_RESULTS: '/api/v1/pubsub/review-results',
  WEBHOOKS: '/api/v1/webhooks',
  HEALTHZ: '/healthz',
} as const satisfies Record<string, Endpoint>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function encodeParam(val: string | number, paramName: string): string {
  const str = String(val);
  if (paramName.toLowerCase().endsWith('path')) {
    return str.split('/').map(encodeURIComponent).join('/');
  }
  return encodeURIComponent(str);
}

function extractPathParams(
  payload: unknown,
): Record<string, string | number> | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (isRecord(payload['Path'])) {
    return payload['Path'] as Record<string, string | number>;
  }
  if (isRecord(payload['Params'])) {
    return payload['Params'] as Record<string, string | number>;
  }
  return payload as Record<string, string | number>;
}

function isQueryValue(v: unknown): v is string | number | boolean {
  return (
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  );
}

function formatQueryString(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload['Query'])) {
    return '';
  }
  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(payload['Query'])) {
    if (isQueryValue(v)) {
      searchParams.set(k, String(v));
    }
  }
  return searchParams.toString().replace(/\+/g, '%20');
}

export function interpolatePath<T extends Endpoint = Endpoint>(
  endpoint: T,
  payload: EndpointPayloadRecord[T],
): string;
export function interpolatePath<T extends string = string>(
  endpoint: T,
  payload?: Record<string, unknown>,
): string;
export function interpolatePath(endpoint: string, payload?: unknown): string {
  const pathParams = extractPathParams(payload);
  const url = endpoint.replace(
    /:([a-zA-Z0-9_]+)/g,
    (_match, paramName: string) => {
      const value = pathParams?.[paramName];
      if (value === undefined || value === null) {
        throw new Error(
          `Missing required path parameter "${paramName}" for endpoint "${endpoint}"`,
        );
      }
      return encodeParam(value, paramName);
    },
  );

  const qs = formatQueryString(payload);
  if (!qs) {
    return url;
  }
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}
