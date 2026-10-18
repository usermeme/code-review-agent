import { DatabaseService } from '../interfaces/database.interface.js';

/**
 * Cross-instance Pub/Sub delivery dedup.
 *
 * Pub/Sub redelivers a message (same messageId) when the ack deadline is
 * exceeded — even while the first delivery is still being processed. Without
 * a shared claim record, two instances can run (and pay for) the same review
 * and post duplicate comments. Claims are atomic via create-if-missing and
 * expire after {@link STALE_AFTER_MS} so a crashed processor cannot block a
 * message forever.
 */
export interface DeliveryRecord {
  messageId: string;
  startedAt: Date;
  status: 'processing' | 'done';
}

const COLLECTION = 'processed_deliveries';

/** A claim older than this is presumed leaked by a crashed instance. */
const STALE_AFTER_MS = 15 * 60 * 1000;

/** True while a 'processing' claim is younger than the stale threshold. */
function isClaimStillFresh(existing: DeliveryRecord): boolean {
  const age = Date.now() - new Date(existing.startedAt).getTime();
  return Number.isFinite(age) && age < STALE_AFTER_MS;
}

export class DeliveryRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Atomically claims a message for processing.
   * Returns false when the message was already processed or another
   * instance holds a fresh claim — callers should ack and skip.
   */
  async claim(messageId: string): Promise<boolean> {
    const created = await this.db.createDocumentIfMissing<DeliveryRecord>(
      COLLECTION,
      messageId,
      { messageId, startedAt: new Date(), status: 'processing' },
    );
    if (created) {
      return true;
    }

    const existing = await this.db.getDocument<DeliveryRecord>(
      COLLECTION,
      messageId,
    );
    if (!existing) {
      // Vanished between the two calls (e.g. TTL) — safe to proceed.
      return true;
    }
    if (existing.status === 'done') {
      return false;
    }
    if (isClaimStillFresh(existing)) {
      return false;
    }
    // Stale claim from a crashed instance — take it over.
    await this.db.setDocument<DeliveryRecord>(COLLECTION, messageId, {
      startedAt: new Date(),
      status: 'processing',
    });
    return true;
  }

  /** Records successful (or non-retryable) processing — future redeliveries are skipped. */
  async markDone(messageId: string): Promise<void> {
    await this.db.setDocument<DeliveryRecord>(COLLECTION, messageId, {
      status: 'done',
    });
  }

  /**
   * Releases the claim so a Pub/Sub redelivery can retry. Called on
   * retryable failures; errors are swallowed — a leaked claim still expires.
   */
  async release(messageId: string): Promise<void> {
    await this.db.deleteDocument(COLLECTION, messageId).catch(() => undefined);
  }
}
