export type EndpointPayload<
  TParams = Record<string, unknown>,
  TPath = Record<string, string | number>,
  TQuery = Record<string, unknown>,
  TBody = unknown,
> = {
  Params?: TParams;
  Path?: TPath;
  Query?: TQuery;
  Body?: TBody;
};

export type EnpointPayload<
  TParams = Record<string, unknown>,
  TPath = Record<string, string | number>,
  TQuery = Record<string, unknown>,
  TBody = unknown,
> = EndpointPayload<TParams, TPath, TQuery, TBody>;

export interface EndpointPayloadRecord {
  '/api/v1/repos/:owner/:repo/': {
    Path: {
      owner: string;
      repo: string;
    };
  };

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
  '/api/v1/repos/:owner/:repo/pulls/:number/diff': {
    Path: {
      owner: string;
      repo: string;
      number: number | string;
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
  '/api/v1/repos/:owner/:repo/pulls/:number/files': {
    Path: {
      owner: string;
      repo: string;
      number: number | string;
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

  // Health and liveness endpoints
  '/healthz': Record<string, never>;
  '/livez': Record<string, never>;
}

export type EndointPayloadRecord = EndpointPayloadRecord;
export type EnpointPayloadRecord = EndpointPayloadRecord;

export type Endpoint = keyof EndpointPayloadRecord;
export type Enpoint = Endpoint;

export const ENDPOINTS = {
  REPO_ROOT: '/api/v1/repos/:owner/:repo/',
  PR_DIFF: '/api/v1/repos/:owner/:repo/pulls/:prNumber/diff',
  PR_DIFF_NUMBER: '/api/v1/repos/:owner/:repo/pulls/:number/diff',
  PR_FILES: '/api/v1/repos/:owner/:repo/pulls/:prNumber/files',
  PR_FILES_NUMBER: '/api/v1/repos/:owner/:repo/pulls/:number/files',
  SEARCH_CODE: '/api/v1/repos/:owner/:repo/search',
  FILE_CONTENT: '/api/v1/repos/:owner/:repo/files/:path',
  TARBALL: '/api/v1/repos/:owner/:repo/tarball',
  CONTEXT: '/api/v1/context/:prKey',
  PUBSUB_PR_EVENTS: '/api/v1/pubsub/pr-events',
  PUBSUB_REVIEW_RESULTS: '/api/v1/pubsub/review-results',
  WEBHOOKS: '/api/v1/webhooks',
  HEALTHZ: '/healthz',
  LIVEZ: '/livez',
} as const satisfies Record<string, Endpoint>;

function encodeParam(val: string | number, paramName: string): string {
  const str = String(val);
  if (paramName === 'path' || paramName.toLowerCase().endsWith('path')) {
    return str.split('/').map(encodeURIComponent).join('/');
  }
  return encodeURIComponent(str);
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
  const p = payload as
    | {
        Path?: Record<string, string | number>;
        Params?: Record<string, string | number>;
        Query?: Record<string, unknown>;
      }
    | Record<string, string | number>
    | undefined;

  const pathParams: Record<string, string | number> | undefined =
    p && typeof p === 'object'
      ? 'Path' in p && p.Path && typeof p.Path === 'object'
        ? (p.Path as Record<string, string | number>)
        : 'Params' in p && p.Params && typeof p.Params === 'object'
          ? (p.Params as Record<string, string | number>)
          : (p as Record<string, string | number>)
      : undefined;

  let url = endpoint.replace(
    /:([a-zA-Z0-9_]+)/g,
    (_match, paramName: string) => {
      const value = pathParams ? pathParams[paramName] : undefined;
      if (value === undefined || value === null) {
        throw new Error(
          `Missing required path parameter "${paramName}" for endpoint "${endpoint}"`,
        );
      }
      return encodeParam(value, paramName);
    },
  );

  const queryParams =
    p &&
    typeof p === 'object' &&
    'Query' in p &&
    p.Query &&
    typeof p.Query === 'object'
      ? (p.Query as Record<string, unknown>)
      : undefined;

  if (queryParams) {
    const entries = Object.entries(queryParams).filter(
      ([, v]) => v !== undefined && v !== null,
    );
    if (entries.length > 0) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of entries) {
        searchParams.set(k, String(v));
      }
      const qs = searchParams.toString().replace(/\+/g, '%20');
      if (qs) {
        url += (url.includes('?') ? '&' : '?') + qs;
      }
    }
  }

  return url;
}
