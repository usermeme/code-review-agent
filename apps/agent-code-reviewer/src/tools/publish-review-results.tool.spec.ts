import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createPublishReviewResultsTool } from './publish-review-results.tool.js';
import { STATE } from '../constants/state-keys.constant.js';

describe('publishReviewResultsTool', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('has correct tool name and description', () => {
    const tool = createPublishReviewResultsTool('http://localhost:8080');
    expect(tool.name).toBe('publishReviewResults');
    expect(tool.description).toContain('Publishes the final review findings');
  });

  it('formats findings into inline comments and sends to gateway via HTTP fallback', async () => {
    let capturedBody: any;
    global.fetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
      };
    }) as any;

    const tool = createPublishReviewResultsTool('http://mock-gateway:8080');
    const mockCtx = {
      state: new Map([
        [
          STATE.prMeta,
          {
            provider: 'github',
            owner: 'test-owner',
            repo: 'test-repo',
            number: 42,
          },
        ],
      ]),
    } as any;

    const result = await (tool as any).execute(
      {
        summary: 'Critical security issue detected',
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

    expect(result).toContain('Successfully sent 1 review comments');
    expect(capturedBody).toBeDefined();

    const decoded = JSON.parse(
      Buffer.from(capturedBody.message.data, 'base64').toString('utf8'),
    );

    expect(decoded.provider).toBe('github');
    expect(decoded.owner).toBe('test-owner');
    expect(decoded.repo).toBe('test-repo');
    expect(decoded.prNumber).toBe(42);
    expect(decoded.comments).toHaveLength(1);
    expect(decoded.comments[0].path).toBe('src/db.ts');
    expect(decoded.comments[0].position).toBe(12);
    expect(decoded.comments[0].body).toContain('### [CRITICAL] SQL Injection Vulnerability');
    expect(decoded.comments[0].body).toContain('```suggestion');
  });
});
