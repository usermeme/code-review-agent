import { describe, expect, it, vi } from 'vitest';

import { STATE } from '../constants/state-keys.constant.js';
import { createPublishReviewResultsTool } from './publish-review-results.tool.js';

describe('publishReviewResultsTool', () => {
  it('has correct tool name and description', () => {
    const tool = createPublishReviewResultsTool();
    expect(tool.name).toBe('publishReviewResults');
    expect(tool.description).toContain('Publishes the final review findings');
  });

  it('formats findings into inline comments and updates state & callback', async () => {
    const onPublishResult = vi.fn().mockResolvedValue(undefined);
    const tool = createPublishReviewResultsTool({ onPublishResult });

    const stateMap = new Map<string, unknown>([
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
        set: (key: string, val: unknown) => stateMap.set(key, val),
      },
    } as unknown;

    const result = await tool.execute(
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
            confidence: 0.95,
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
          startPosition: 10,
          position: 12,
          body: '### [CRITICAL] SQL Injection Vulnerability\n\nUnsanitized user input concatenated into query string.',
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

    const stateMap = new Map<string, unknown>([
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
        set: (key: string, val: unknown) => stateMap.set(key, val),
      },
    } as unknown;

    const result = await tool.execute(
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

  it('pins the publish target to the state prMeta even if coordinate args are smuggled in', async () => {
    const onPublishResult = vi.fn().mockResolvedValue(undefined);
    const tool = createPublishReviewResultsTool({ onPublishResult });

    const stateMap = new Map<string, unknown>([
      [
        STATE.prMeta,
        { provider: 'github', owner: 'real', repo: 'pr-repo', number: 1 },
      ],
    ]);
    const mockCtx = {
      state: {
        get: (key: string) => stateMap.get(key),
        set: (key: string, val: unknown) => stateMap.set(key, val),
      },
    } as unknown;

    const smuggled = {
      owner: 'victim',
      repo: 'private-repo',
      prNumber: 777,
      summary: 's',
      findings: [],
    } as unknown;

    await tool.execute(smuggled, mockCtx);

    expect(onPublishResult).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'real',
        repo: 'pr-repo',
        prNumber: 1,
      }),
    );
  });

  it('truncates over-long finding bodies at a word boundary', async () => {
    const onPublishResult = vi.fn().mockResolvedValue(undefined);
    const tool = createPublishReviewResultsTool({ onPublishResult });

    const stateMap = new Map<string, unknown>([
      [STATE.prMeta, { provider: 'github', owner: 'o', repo: 'r', number: 7 }],
    ]);
    const mockCtx = {
      state: {
        get: (key: string) => stateMap.get(key),
        set: (key: string, val: unknown) => stateMap.set(key, val),
      },
    } as unknown;

    const longBody = Array.from({ length: 400 }, (_, i) => `word${i}`).join(
      ' ',
    );
    await tool.execute(
      {
        summary: 's',
        findings: [
          {
            title: 'Verbose finding',
            severity: 'major',
            path: 'src/a.ts',
            startLine: 1,
            endLine: 2,
            body: longBody,
            confidence: 0.9,
          },
        ],
      },
      mockCtx,
    );

    const payload = onPublishResult.mock.calls[0][0];
    const body = payload.comments[0].body as string;
    expect(body.endsWith('…')).toBe(true);
    expect(body.length).toBeLessThan(longBody.length);
    // Header + capped body (+ ellipsis/space slack), never the full 2.7k text.
    expect(body.length).toBeLessThanOrEqual(
      '### [MAJOR] Verbose finding\n\n'.length + 700 + 2,
    );
    // Truncation lands on a word boundary.
    expect(body).not.toContain('word399');
  });

  it('drops low-confidence findings and caps the list in code', async () => {
    const onPublishResult = vi.fn().mockResolvedValue(undefined);
    const tool = createPublishReviewResultsTool({ onPublishResult });

    const stateMap = new Map<string, unknown>([
      [STATE.prMeta, { provider: 'github', owner: 'o', repo: 'r', number: 7 }],
    ]);
    const mockCtx = {
      state: {
        get: (key: string) => stateMap.get(key),
        set: (key: string, val: unknown) => stateMap.set(key, val),
      },
    } as unknown;

    const finding = (i: number, severity: 'critical' | 'major' | 'minor') => ({
      title: `finding ${i}`,
      severity,
      path: `src/f${i}.ts`,
      startLine: i,
      endLine: i,
      body: 'body',
      confidence: 0.9,
    });

    const findings = [
      { ...finding(0, 'minor'), confidence: 0.5 }, // dropped: low confidence
      ...Array.from({ length: 20 }, (_, i) => finding(i + 1, 'major')),
    ];

    const result = (await tool.execute(
      { summary: 's', findings },
      mockCtx,
    )) as string;

    expect(result).toContain('Successfully recorded 15 review findings');
    expect(result).toContain('dropped 1 low-confidence');
    expect(result).toContain('capped 5 over-limit');
    expect(onPublishResult).toHaveBeenCalledWith(
      expect.objectContaining({
        comments: expect.arrayContaining([
          expect.objectContaining({ path: 'src/f1.ts' }),
        ]),
      }),
    );
    const payload = onPublishResult.mock.calls[0][0];
    expect(payload.comments).toHaveLength(15);
    // Single-line findings must not carry startPosition.
    expect(payload.comments[0].startPosition).toBeUndefined();
  });

  it('drops findings whose lines fall outside the diff hunks of their file', async () => {
    const onPublishResult = vi.fn().mockResolvedValue(undefined);
    const tool = createPublishReviewResultsTool({ onPublishResult });

    const diff = [
      'diff --git a/src/db.ts b/src/db.ts',
      '--- a/src/db.ts',
      '+++ b/src/db.ts',
      '@@ -10,3 +10,4 @@',
      '+const q = `select ${input}`;',
    ].join('\n');

    const stateMap = new Map<string, unknown>([
      [
        STATE.prMeta,
        {
          provider: 'github',
          owner: 'test-owner',
          repo: 'test-repo',
          number: 42,
        },
      ],
      [STATE.diff, diff],
    ]);

    const mockCtx = {
      state: {
        get: (key: string) => stateMap.get(key),
        set: (key: string, val: unknown) => stateMap.set(key, val),
      },
    } as unknown;

    const result = await tool.execute(
      {
        summary: 'One anchored finding, two unanchorable ones',
        findings: [
          {
            title: 'Anchored',
            severity: 'high',
            path: 'src/db.ts',
            startLine: 11,
            endLine: 12,
            body: 'Inside the hunk.',
            confidence: 0.9,
          },
          {
            title: 'Outside hunk',
            severity: 'high',
            path: 'src/db.ts',
            startLine: 300,
            endLine: 305,
            body: 'Far from the diff.',
            confidence: 0.9,
          },
          {
            title: 'Unknown file',
            severity: 'high',
            path: 'src/other.ts',
            startLine: 1,
            endLine: 2,
            body: 'File not in the diff.',
            confidence: 0.9,
          },
        ],
      },
      mockCtx,
    );

    expect(result).toContain('Successfully recorded 1 review findings');
    expect(result).toContain('dropped 2 unanchorable');
    const payload = onPublishResult.mock.calls[0][0];
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toEqual(
      expect.objectContaining({ path: 'src/db.ts', position: 12 }),
    );
  });
});
