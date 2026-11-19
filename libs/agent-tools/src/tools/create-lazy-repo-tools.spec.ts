import type { FunctionTool } from '@google/adk';
import { describe, expect, it, vi } from 'vitest';

import { RepoWorkspace } from '../workspace/repo-workspace.js';
import { createLazyRepoTools } from './create-lazy-repo-tools.js';

function workspace(): RepoWorkspace {
  return new RepoWorkspace({
    files: new Map([['src/a.ts', ['export const a = 1;']]]),
    rawDiff: '',
    changedFiles: [],
  });
}

function toolNamed(tools: FunctionTool[], name: string): FunctionTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  return tool;
}

async function call(tool: FunctionTool, args: Record<string, unknown>) {
  return tool.runAsync({ args, toolContext: undefined as never });
}

describe('createLazyRepoTools', () => {
  it('does not download the repository until a tool is called', () => {
    const load = vi.fn(async () => workspace());

    const tools = createLazyRepoTools(load);

    expect(tools.all.map((tool) => tool.name)).toEqual([
      'read_file',
      'grep_code',
      'find_files',
    ]);
    expect(load).not.toHaveBeenCalled();
    expect(tools.loaded()).toBe(false);
  });

  it('downloads once and serves every tool from the same workspace', async () => {
    const load = vi.fn(async () => workspace());
    const tools = createLazyRepoTools(load);

    const read = await call(toolNamed(tools.all, 'read_file'), {
      path: 'src/a.ts',
    });
    const found = await call(toolNamed(tools.all, 'find_files'), {});

    expect(read).toMatchObject({ exists: true, totalLines: 1 });
    expect(found).toMatchObject({ files: ['src/a.ts'] });
    expect(load).toHaveBeenCalledTimes(1);
    expect(tools.loaded()).toBe(true);
  });

  it('returns an error to the model when the download fails', async () => {
    const tools = createLazyRepoTools(async () => {
      throw new Error('tarball 502');
    });

    const result = await call(toolNamed(tools.all, 'grep_code'), {
      pattern: 'a',
    });

    expect(result).toEqual({ error: 'Repository unavailable: tarball 502' });
  });
});
