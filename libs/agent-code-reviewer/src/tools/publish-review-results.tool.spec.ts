import { describe, expect, it, vi } from 'vitest';
import { createPublishReviewResultsTool } from './publish-review-results.tool.js';
import { STATE } from '../constants/state-keys.constant.js';

describe('publishReviewResultsTool', () => {
  it('has correct tool name and description', () => {
    const tool = createPublishReviewResultsTool();
    expect(tool.name).toBe('publishReviewResults');
    expect(tool.description).toContain('Publishes the final review findings');
  });

  it('formats findings into inline comments and updates state & callback', async () => {
    const onPublishResult = vi.fn().mockResolvedValue(undefined);
    const tool = createPublishReviewResultsTool({ onPublishResult });

    const stateMap = new Map<string, any>([
      [
        STATE.prMeta,
        {
          provider: 'github',
          owner: 'test-owner',
          repo: 'test-repo',
          number: 42,
        },
      ],
    ]);

    const mockCtx = {
      state: {
        get: (key: string) => stateMap.get(key),
        set: (key: string, val: any) => stateMap.set(key, val),
      },
    } as any;

    const result = await (tool as any).execute(
      {
        summary: 'Critical security issue detected',
        ticketCoverage:
          'All acceptance criteria met except input sanitization.',
        findings: [
          {
            title: 'SQL Injection Vulnerability',
            severity: 'critical',
            path: 'src/db.ts',
            startLine: 10,
            endLine: 12,
            body: 'Unsanitized user input concatenated into query string.',
            suggestion: 'db.query("SELECT * FROM users WHERE id = ?", [id])',
          },
        ],
      },
      mockCtx,
    );

    expect(result).toContain(
      'Successfully recorded 1 review findings and summary',
    );
    expect(onPublishResult).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'test-owner',
      repo: 'test-repo',
      prNumber: 42,
      summary: 'Critical security issue detected',
      ticketCoverage: 'All acceptance criteria met except input sanitization.',
      comments: [
        {
          path: 'src/db.ts',
          position: 12,
          body: '### [CRITICAL] SQL Injection Vulnerability\n\nUnsanitized user input concatenated into query string.\n\n```suggestion\ndb.query("SELECT * FROM users WHERE id = ?", [id])\n```',
        },
      ],
    });
    expect(stateMap.get(STATE.reviewResult)).toEqual(
      expect.objectContaining({
        prNumber: 42,
        summary: 'Critical security issue detected',
      }),
    );
  });

  it('handles clean review with zero findings', async () => {
    const onPublishResult = vi.fn().mockResolvedValue(undefined);
    const tool = createPublishReviewResultsTool({ onPublishResult });

    const stateMap = new Map<string, any>([
      [
        STATE.prMeta,
        {
          provider: 'github',
          owner: 'test-owner',
          repo: 'test-repo',
          number: 42,
        },
      ],
    ]);

    const mockCtx = {
      state: {
        get: (key: string) => stateMap.get(key),
        set: (key: string, val: any) => stateMap.set(key, val),
      },
    } as any;

    const result = await (tool as any).execute(
      {
        summary: 'All checks passed cleanly',
        findings: [],
      },
      mockCtx,
    );

    expect(result).toContain('Successfully recorded 0 review findings');
    expect(onPublishResult).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'All checks passed cleanly',
        comments: [],
      }),
    );
  });
});
