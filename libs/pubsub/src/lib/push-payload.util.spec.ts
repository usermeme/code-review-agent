import { describe, expect, it } from 'vitest';

import { parsePubSubPushPayload } from './push-payload.util.js';

describe('parsePubSubPushPayload', () => {
  it('decodes base64 JSON payload from standard GCP Pub/Sub push envelope', () => {
    const rawData = { foo: 'bar', count: 42 };
    const base64Data = Buffer.from(JSON.stringify(rawData)).toString('base64');

    const envelope = {
      message: {
        attributes: { source: 'test' },
        data: base64Data,
        messageId: 'msg-12345',
        publishTime: '2026-10-11T10:00:00.000Z',
      },
      subscription: 'projects/test-project/subscriptions/test-sub',
    };

    const parsed = parsePubSubPushPayload<typeof rawData>(envelope);
    expect(parsed).toEqual(rawData);
  });

  it('passes through direct payload if not wrapped in Pub/Sub envelope', () => {
    const directPayload = { provider: 'github', owner: 'org', repo: 'app' };
    const parsed = parsePubSubPushPayload<typeof directPayload>(directPayload);
    expect(parsed).toEqual(directPayload);
  });

  it('throws an error if body is null or undefined or not an object', () => {
    expect(() => parsePubSubPushPayload(null)).toThrow(
      'Invalid Pub/Sub push body',
    );
    expect(() => parsePubSubPushPayload(undefined)).toThrow(
      'Invalid Pub/Sub push body',
    );
    expect(() => parsePubSubPushPayload('string')).toThrow(
      'Invalid Pub/Sub push body',
    );
  });

  it('throws an error if message data in envelope is not valid JSON', () => {
    const invalidEnvelope = {
      message: {
        data: Buffer.from('not a json string').toString('base64'),
        messageId: 'msg-invalid',
      },
    };

    expect(() => parsePubSubPushPayload(invalidEnvelope)).toThrow(
      'Failed to decode/parse base64 Pub/Sub push message data',
    );
  });
});
