import { describe, expect, it } from 'vitest';
import { redactToken } from '../../src/context/clone.js';

const TOKEN = 'ghs_supersecretinstallationtoken';

describe('redactToken', () => {
  it('scrubs the token from every string field git puts it in', () => {
    // Shape mirrors a Node execFile failure: the credentialed URL appears in
    // message, stack, and cmd.
    const url = `https://x-access-token:${TOKEN}@github.com/o/r.git`;
    const error = Object.assign(new Error(`Command failed: git clone ${url} /tmp/x`), {
      cmd: `git clone ${url} /tmp/x`,
      stderr: 'fatal: Authentication failed',
    });
    error.stack = `Error: Command failed: git clone ${url} /tmp/x\n    at foo`;

    const redacted = redactToken(error, TOKEN) as Error & { cmd: string };
    expect(redacted.message).not.toContain(TOKEN);
    expect(redacted.stack).not.toContain(TOKEN);
    expect(redacted.cmd).not.toContain(TOKEN);
    expect(redacted.message).toContain('***');
    // Still useful for debugging.
    expect(redacted.message).toContain('git clone');
  });

  it('returns the error untouched when there is no token', () => {
    const error = new Error('boom');
    expect(redactToken(error, undefined)).toBe(error);
  });
});
