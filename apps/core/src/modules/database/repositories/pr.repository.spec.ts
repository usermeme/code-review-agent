import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../interfaces/database.interface.js';
import { PrRepository } from './pr.repository.js';

describe('PrRepository', () => {
  function makeMockDb(getDocumentResult: unknown = null) {
    return {
      getDocument: vi.fn().mockResolvedValue(getDocumentResult),
      setDocument: vi.fn().mockResolvedValue(undefined),
      deleteDocument: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('always reads through to the database (no stale instance-local copies)', async () => {
    const stored = {
      provider: 'github',
      owner: 'acme',
      repo: 'app',
      prNumber: 1,
      status: 'completed',
      publishedFindings: [
        {
          path: 'src/a.ts',
          startLine: 1,
          endLine: 2,
          severity: 'critical',
          title: 'Bug',
        },
      ],
    };
    const mockDb = makeMockDb(stored);
    const repo = new PrRepository(mockDb as unknown as DatabaseService);

    const first = await repo.getPRStatus('github:acme/app:1');
    expect(first?.status).toBe('completed');
    expect(first?.publishedFindings).toHaveLength(1);

    // A second read must hit the database again: another instance may have
    // updated the record in between (multi-instance deployment).
    const second = await repo.getPRStatus('github:acme/app:1');
    expect(second).toEqual(first);
    expect(mockDb.getDocument).toHaveBeenCalledTimes(2);
  });

  it('writes only the given fields so Firestore merge preserves the rest', async () => {
    const mockDb = makeMockDb();
    const repo = new PrRepository(mockDb as unknown as DatabaseService);

    await repo.updatePRStatus('github:acme/app:2', { status: 'reviewing' });

    expect(mockDb.setDocument).toHaveBeenCalledTimes(1);
    const [collection, docId, written] = mockDb.setDocument.mock.calls[0];
    expect(collection).toBe('pull_requests');
    expect(docId).toBe('github:acme/app:2');
    expect(written).toEqual({
      status: 'reviewing',
      updatedAt: expect.any(Date),
    });
    // Fields owned by other flows (prMeta, publishedFindings, summary) must
    // NOT appear in the payload — their presence would overwrite newer
    // values written by other instances.
    expect(written).not.toHaveProperty('publishedFindings');
    expect(written).not.toHaveProperty('prMeta');
  });

  it('deletes the PR record', async () => {
    const mockDb = makeMockDb({ status: 'completed' });
    const repo = new PrRepository(mockDb as unknown as DatabaseService);

    await repo.deletePRStatus('github:acme/app:3');

    expect(mockDb.deleteDocument).toHaveBeenCalledWith(
      'pull_requests',
      'github:acme/app:3',
    );
  });
});
