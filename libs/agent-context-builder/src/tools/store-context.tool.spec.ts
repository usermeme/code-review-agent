import { describe, expect, it, vi } from 'vitest';
import { createStoreContextTool } from './store-context.tool.js';
import { STATE } from '../constants/state-keys.constant.js';

describe('storeContextTool', () => {
  it('has correct tool name and description', () => {
    const tool = createStoreContextTool();
    expect(tool.name).toBe('store_context');
    expect(tool.description).toContain('Stores the synthesized context');
  });

  it('stores context sections into ctx.state and invokes onStoreContext callback', async () => {
    const onStoreContext = vi.fn().mockResolvedValue(undefined);
    const tool = createStoreContextTool({ onStoreContext });

    const stateMap = new Map<string, any>();
    const mockCtx = {
      state: {
        set: (k: string, v: any) => stateMap.set(k, v),
        get: (k: string) => stateMap.get(k),
      },
    } as any;

    const sections = {
      architecture: 'Microservices architecture with Fastify',
      dependencies: 'Node.js, TypeScript, Vitest',
    };

    const result = await (tool as any).execute(
      {
        provider: 'github',
        owner: 'test-owner',
        repo: 'test-repo',
        prNumber: 42,
        sections,
      },
      mockCtx,
    );

    expect(result).toBe('Context successfully stored.');
    expect(stateMap.get(STATE.synthesizedSections)).toEqual(sections);
    expect(onStoreContext).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'test-owner',
      repo: 'test-repo',
      prNumber: 42,
      sections,
    });
  });

  it('defaults prNumber to 0 when not provided', async () => {
    const onStoreContext = vi.fn().mockResolvedValue(undefined);
    const tool = createStoreContextTool({ onStoreContext });

    const stateMap = new Map<string, any>();
    const mockCtx = {
      state: {
        set: (k: string, v: any) => stateMap.set(k, v),
        get: (k: string) => stateMap.get(k),
      },
    } as any;

    await (tool as any).execute(
      {
        provider: 'github',
        owner: 'test-owner',
        repo: 'test-repo',
        sections: { overview: 'Repo baseline' },
      },
      mockCtx,
    );

    expect(onStoreContext).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 0,
      }),
    );
  });
});
