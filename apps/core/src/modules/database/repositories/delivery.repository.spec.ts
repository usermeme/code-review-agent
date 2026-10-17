import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryDatabaseService } from '../testing/in-memory-database.service.js';
import { DeliveryRepository } from './delivery.repository.js';

interface StoredDelivery {
  status: string;
  startedAt: Date;
}

describe('DeliveryRepository', () => {
  let db: InMemoryDatabaseService;
  let repo: DeliveryRepository;

  beforeEach(() => {
    db = new InMemoryDatabaseService();
    repo = new DeliveryRepository(db);
  });

  it('claims an unseen message and records it as processing', async () => {
    await expect(repo.claim('msg-1')).resolves.toBe(true);
    const record = await db.getDocument<StoredDelivery>(
      'processed_deliveries',
      'msg-1',
    );
    expect(record?.status).toBe('processing');
  });

  it('refuses a second claim while a fresh processing record exists', async () => {
    await repo.claim('msg-1');
    await expect(repo.claim('msg-1')).resolves.toBe(false);
  });

  it('refuses redelivery of an already completed message', async () => {
    await repo.claim('msg-1');
    await repo.markDone('msg-1');
    await expect(repo.claim('msg-1')).resolves.toBe(false);
  });

  it('takes over a stale processing claim from a crashed instance', async () => {
    await repo.claim('msg-1');
    await db.setDocument('processed_deliveries', 'msg-1', {
      startedAt: new Date(Date.now() - 16 * 60 * 1000),
    });
    await expect(repo.claim('msg-1')).resolves.toBe(true);
  });

  it('release lets a redelivery be claimed again', async () => {
    await repo.claim('msg-1');
    await repo.release('msg-1');
    await expect(repo.claim('msg-1')).resolves.toBe(true);
  });
});
