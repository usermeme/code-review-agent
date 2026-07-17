import { describe, expect, it } from 'vitest';
import { GithubWebhookAdapter } from './github-webhook.adapter.js';
import type { WebhookRequest } from '../vcs/interfaces/webhook-adapter.interface.js';

describe('GithubWebhookAdapter', () => {
  const adapter = new GithubWebhookAdapter();

  describe('canHandle', () => {
    it('returns true if x-github-event header is present', () => {
      const req = {
        headers: { 'x-github-event': 'pull_request' },
      } as unknown as WebhookRequest;
      expect(adapter.canHandle(req)).toBe(true);
    });

    it('returns false if x-github-event header is missing', () => {
      const req = { headers: {} } as unknown as WebhookRequest;
      expect(adapter.canHandle(req)).toBe(false);
    });
  });

  describe('parseEvent', () => {
    const basePayload = {
      repository: { full_name: 'owner/repo' },
      installation: { id: 123 },
    };

    it('parses a pull_request opened event', () => {
      const req = {
        headers: { 'x-github-event': 'pull_request' },
        body: {
          ...basePayload,
          action: 'opened',
          pull_request: { number: 42, draft: false },
        },
      } as unknown as WebhookRequest;

      const event = adapter.parseEvent(req);
      expect(event).toMatchObject({
        eventType: 'pull_request_opened',
        repo: { owner: 'owner', name: 'repo' },
        installationId: '123',
        pullRequestNumber: 42,
        isDraft: false,
      });
    });

    it('returns null for unhandled actions', () => {
      const req = {
        headers: { 'x-github-event': 'pull_request' },
        body: {
          ...basePayload,
          action: 'assigned',
        },
      } as unknown as WebhookRequest;

      expect(adapter.parseEvent(req)).toBeNull();
    });

    it('parses a pull_request_review_comment event', () => {
      const req = {
        headers: { 'x-github-event': 'pull_request_review_comment' },
        body: {
          ...basePayload,
          comment: {
            id: 999,
            body: 'Looks good',
            user: { login: 'reviewer' },
            created_at: '2023-01-01T00:00:00Z',
            path: 'src/main.ts',
          },
        },
      } as unknown as WebhookRequest;

      const event = adapter.parseEvent(req);
      expect(event).toMatchObject({
        eventType: 'pull_request_review_comment',
        body: 'Looks good',
        author: 'reviewer',
        providerCommentId: '999',
        filePath: 'src/main.ts',
      });
    });

    it('returns null if repository or installation is missing', () => {
      const req = {
        headers: { 'x-github-event': 'pull_request' },
        body: { action: 'opened' },
      } as unknown as WebhookRequest;

      expect(adapter.parseEvent(req)).toBeNull();
    });
  });
});
