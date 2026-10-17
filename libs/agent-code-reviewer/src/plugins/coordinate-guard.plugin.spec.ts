import type { BaseTool, Context } from '@google/adk';
import { describe, expect, it } from 'vitest';

import { STATE } from '../constants/state-keys.constant.js';
import { CoordinateGuardPlugin } from './coordinate-guard.plugin.js';

function contextWithState(meta: unknown) {
  const map = new Map<string, unknown>();
  if (meta !== undefined) map.set(STATE.prMeta, meta);
  return {
    state: {
      get: (key: string) => map.get(key),
      set: (key: string, val: unknown) => map.set(key, val),
    },
  } as unknown as Context;
}

const tool = { name: 'someTool' } as unknown as BaseTool;
const META = {
  provider: 'github',
  owner: 'real',
  repo: 'pr-repo',
  number: 1,
  title: 't',
  branch: 'feature/x',
  author: 'a',
};

describe('CoordinateGuardPlugin', () => {
  const plugin = new CoordinateGuardPlugin();

  it('blocks tool calls with mismatched repository coordinates', async () => {
    const result = await plugin.beforeToolCallback({
      tool,
      toolArgs: { owner: 'victim-org', repo: 'private-repo', query: 'x' },
      toolContext: contextWithState(META),
    });

    expect(result).toBeDefined();
    expect(result).toMatchObject({
      error: expect.stringContaining('Blocked'),
    });
    expect(result).toMatchObject({
      error: expect.stringContaining('victim-org'),
    });
  });

  it('blocks mismatched prNumber and provider, accepting correct values', async () => {
    const blocked = await plugin.beforeToolCallback({
      tool,
      toolArgs: { prNumber: 999, provider: 'gitlab' },
      toolContext: contextWithState(META),
    });
    expect(blocked?.error).toContain('Blocked');

    const allowed = await plugin.beforeToolCallback({
      tool,
      toolArgs: { prNumber: 1, provider: 'GitHub' },
      toolContext: contextWithState(META),
    });
    expect(allowed).toBeUndefined();
  });

  it('accepts the combined owner/repo form for the repo argument', async () => {
    const result = await plugin.beforeToolCallback({
      tool,
      toolArgs: { repo: 'real/pr-repo' },
      toolContext: contextWithState(META),
    });
    expect(result).toBeUndefined();
  });

  it('lets clean tool calls through untouched', async () => {
    const result = await plugin.beforeToolCallback({
      tool,
      toolArgs: { path: 'src/app.ts', ref: 'feature/x' },
      toolContext: contextWithState(META),
    });
    expect(result).toBeUndefined();
  });

  it('is inert when no prMeta is in state (nothing to pin against)', async () => {
    const result = await plugin.beforeToolCallback({
      tool,
      toolArgs: { owner: 'anyone' },
      toolContext: contextWithState(undefined),
    });
    expect(result).toBeUndefined();
  });
});
