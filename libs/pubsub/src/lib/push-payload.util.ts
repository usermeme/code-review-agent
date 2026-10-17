export interface PubSubPushMessageEnvelope {
  message: {
    attributes?: Record<string, string>;
    data: string;
    messageId: string;
    publishTime?: string;
    orderingKey?: string;
  };
  subscription?: string;
  /** Present only when the subscription has a dead-letter policy. */
  deliveryAttempt?: number;
}

export interface ParsedPubSubPush<T> {
  payload: T;
  /** Stable across redeliveries of the same message; absent for direct JSON calls. */
  messageId?: string;
  deliveryAttempt?: number;
}

/**
 * Parses and decodes a payload received from a Google Cloud Pub/Sub Push subscription.
 * Supports both standard GCP Pub/Sub base64-encoded push message envelopes and direct JSON payloads.
 */
export function parsePubSubPushPayload<T>(body: unknown): T {
  return parsePubSubPushEnvelope<T>(body).payload;
}

/**
 * Like {@link parsePubSubPushPayload}, but also returns the delivery metadata
 * needed to deduplicate redeliveries of the same message.
 */
export function parsePubSubPushEnvelope<T>(body: unknown): ParsedPubSubPush<T> {
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
    let payload: T;
    try {
      const decoded = Buffer.from(obj['message']['data'], 'base64').toString(
        'utf8',
      );
      payload = JSON.parse(decoded) as T;
    } catch (err) {
      throw new Error(
        `Failed to decode/parse base64 Pub/Sub push message data: ${String(err)}`,
      );
    }
    const messageId = obj['message']['messageId'];
    const deliveryAttempt = obj['deliveryAttempt'];
    return {
      payload,
      messageId: typeof messageId === 'string' ? messageId : undefined,
      deliveryAttempt:
        typeof deliveryAttempt === 'number' ? deliveryAttempt : undefined,
    };
  }

  // Fallback: If body was sent directly as JSON (e.g. in test doubles or direct callers)
  return { payload: body as T };
}
