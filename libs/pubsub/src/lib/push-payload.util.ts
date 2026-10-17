export interface PubSubPushMessageEnvelope {
  message: {
    attributes?: Record<string, string>;
    data: string;
    messageId: string;
    publishTime?: string;
    orderingKey?: string;
  };
  subscription?: string;
}

/**
 * Parses and decodes a payload received from a Google Cloud Pub/Sub Push subscription.
 * Supports both standard GCP Pub/Sub base64-encoded push message envelopes and direct JSON payloads.
 */
export function parsePubSubPushPayload<T>(body: unknown): T {
  if (!body || typeof body !== 'object') {
    throw new Error(
      'Invalid Pub/Sub push body: body must be a non-null object',
    );
  }

  const obj = body as Record<string, any>;

  // Check if body matches the standard Google Cloud Pub/Sub Push envelope
  if (
    obj['message'] &&
    typeof obj['message'] === 'object' &&
    typeof obj['message']['data'] === 'string'
  ) {
    try {
      const decoded = Buffer.from(obj['message']['data'], 'base64').toString(
        'utf8',
      );
      return JSON.parse(decoded) as T;
    } catch (err) {
      throw new Error(
        `Failed to decode/parse base64 Pub/Sub push message data: ${String(err)}`,
      );
    }
  }

  // Fallback: If body was sent directly as JSON (e.g. in test doubles or direct callers)
  return body as T;
}

/**
 * Extracts the Pub/Sub `messageId` from a raw push envelope, if present.
 * Used for cross-instance delivery dedup: Pub/Sub redelivers the same
 * messageId when an ack deadline is exceeded, even though processing may
 * still be running elsewhere.
 */
export function extractPushMessageId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const message = (body as Record<string, unknown>)['message'];
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const messageId = (message as Record<string, unknown>)['messageId'];
  return typeof messageId === 'string' && messageId ? messageId : undefined;
}
