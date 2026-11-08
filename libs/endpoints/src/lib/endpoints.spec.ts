import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  Endpoint,
  EndpointPayloadRecord,
  ENDPOINTS,
  interpolatePath,
} from './endpoints.js';

describe('endpoints library', () => {
  describe('interpolatePath', () => {
    it('interpolates path parameters from payload.Path', () => {
      const result = interpolatePath(ENDPOINTS.TARBALL, {
        Path: {
          owner: 'octocat',
          repo: 'hello-world',
        },
      });

      expect(result).toBe('/api/v1/repos/octocat/hello-world/tarball');
    });

    it('encodes URI components for path parameters', () => {
      const result = interpolatePath(ENDPOINTS.TARBALL, {
        Path: {
          owner: 'my org',
          repo: 'my repo',
        },
      });

      expect(result).toBe('/api/v1/repos/my%20org/my%20repo/tarball');
    });

    it('preserves slashes in file paths while encoding segments', () => {
      const result = interpolatePath('/api/v1/repos/:owner/:repo/files/:path', {
        Path: {
          owner: 'octocat',
          repo: 'hello-world',
          path: 'src/sub folder/main.ts',
        },
      });

      expect(result).toBe(
        '/api/v1/repos/octocat/hello-world/files/src/sub%20folder/main.ts',
      );
    });

    it('appends serialized query parameters from payload.Query', () => {
      const result = interpolatePath(ENDPOINTS.TARBALL, {
        Path: {
          owner: 'owner',
          repo: 'repo',
        },
        Query: {
          ref: 'feature branch',
        },
      });

      expect(result).toBe(
        '/api/v1/repos/owner/repo/tarball?ref=feature%20branch',
      );
    });

    it('interpolates numeric path parameters', () => {
      const result = interpolatePath(ENDPOINTS.PR_DIFF, {
        Path: {
          owner: 'octocat',
          repo: 'repo',
          prNumber: 42,
        },
      });

      expect(result).toBe('/api/v1/repos/octocat/repo/pulls/42/diff');
    });

    it('falls back to payload.Params if payload.Path is not present', () => {
      const result = interpolatePath(ENDPOINTS.TARBALL, {
        Params: {
          owner: 'facebook',
          repo: 'react',
        },
      } as unknown as EndpointPayloadRecord[typeof ENDPOINTS.TARBALL]);

      expect(result).toBe('/api/v1/repos/facebook/react/tarball');
    });

    it('falls back to direct payload object if Path or Params are not present', () => {
      const result = interpolatePath(ENDPOINTS.TARBALL, {
        owner: 'facebook',
        repo: 'react',
      } as unknown as EndpointPayloadRecord[typeof ENDPOINTS.TARBALL]);

      expect(result).toBe('/api/v1/repos/facebook/react/tarball');
    });

    it('throws an error if a required path parameter is missing', () => {
      expect(() => {
        interpolatePath(ENDPOINTS.TARBALL, {
          Path: {
            owner: 'octocat',
          },
        } as unknown as EndpointPayloadRecord[typeof ENDPOINTS.TARBALL]);
      }).toThrowError(
        'Missing required path parameter "repo" for endpoint "/api/v1/repos/:owner/:repo/tarball"',
      );
    });

    it('returns the endpoint unchanged when there are no parameters', () => {
      const result = interpolatePath(ENDPOINTS.HEALTHZ, {});
      expect(result).toBe('/healthz');
    });
  });

  describe('ENDPOINTS and types', () => {
    it('provides valid endpoint constants', () => {
      expect(ENDPOINTS.PR_DIFF).toBe(
        '/api/v1/repos/:owner/:repo/pulls/:prNumber/diff',
      );
      expect(ENDPOINTS.TARBALL).toBe('/api/v1/repos/:owner/:repo/tarball');
      expect(ENDPOINTS.PUBSUB_PR_EVENTS).toBe('/api/v1/pubsub/pr-events');
      expect(ENDPOINTS.PUBSUB_REVIEW_RESULTS).toBe(
        '/api/v1/pubsub/review-results',
      );
      expect(ENDPOINTS.WEBHOOKS).toBe('/api/v1/webhooks');
      expect(ENDPOINTS.HEALTHZ).toBe('/healthz');
    });

    it('verifies type definitions', () => {
      expectTypeOf<Endpoint>().toBeString();
      expectTypeOf<EndpointPayloadRecord>().toBeObject();
    });
  });
});
