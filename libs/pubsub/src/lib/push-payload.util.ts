function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function extractPushMessage(
  body: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const message = body['message'];
  return isRecord(message) ? message : undefined;
}

/**
 * Parses and decodes a payload received from a Google Cloud Pub/Sub Push subscription.
 * Supports both standard GCP Pub/Sub base64-encoded push message envelopes and direct JSON payloads.
 */
export function parsePubSubPushPayload<T>(body: unknown): T {
  if (!isRecord(body)) {
    throw new Error(
      'Invalid Pub/Sub push body: body must be a non-null object',
    );
  }

  const message = extractPushMessage(body);
  if (message && typeof message['data'] === 'string') {
    try {
      const decoded = Buffer.from(message['data'], 'base64').toString('utf8');
      return JSON.parse(decoded) as T;
    } catch (err) {
      throw new Error(
        `Failed to decode/parse base64 Pub/Sub push message data: ${String(err)}`,
        { cause: err },
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
  const messageId = extractPushMessage(body)?.['messageId'];
  return typeof messageId === 'string' && messageId ? messageId : undefined;
}
