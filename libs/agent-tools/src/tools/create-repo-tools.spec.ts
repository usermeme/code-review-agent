import { describe, expect, it } from 'vitest';

import { RepoWorkspace } from '../workspace/repo-workspace.js';
import { createRepoTools } from './create-repo-tools.js';

describe('createRepoTools (ADK FunctionTools)', () => {
  const workspace = new RepoWorkspace({
    files: new Map([
      [
        'src/service.ts',
        [
          'export class OrderService {',
          '  async placeOrder(id: string) {',
          '    return { id, status: "placed" };',
          '  }',
          '}',
        ],
      ],
    ]),
    rawDiff: [
      'diff --git a/src/service.ts b/src/service.ts',
      '--- a/src/service.ts',
      '+++ b/src/service.ts',
      '@@ -1,3 +1,5 @@',
      '+  async placeOrder(id: string) {',
    ].join('\n'),
  });

  const tools = createRepoTools(workspace);

  it('exposes all 4 tools with valid declarations', () => {
    expect(tools.all).toHaveLength(4);
    expect(tools.all.map((t) => t.name)).toEqual([
      'grep_code',
      'read_file',
      'find_files',
      'get_pr_diff',
    ]);
  });

  it('executes grep_code, read_file, find_files, and get_pr_diff via runAsync', async () => {
    const grepRes = await tools.grepCode.runAsync({
      args: { pattern: 'placeOrder', contextLines: 0 },
      toolContext: undefined as never,
    });
    expect(grepRes).toEqual({
      totalMatches: 1,
      truncated: false,
      matches: [
        {
          path: 'src/service.ts',
          line: 2,
          snippet: '> 2 |   async placeOrder(id: string) {',
        },
      ],
    });

    const readRes = await tools.readFile.runAsync({
      args: { path: 'src/service.ts', startLine: 1, endLine: 2 },
      toolContext: undefined as never,
    });
    expect(readRes).toEqual({
      path: 'src/service.ts',
      exists: true,
      totalLines: 5,
      startLine: 1,
      endLine: 2,
      hasMore: true,
      content:
        '1 | export class OrderService {\n2 |   async placeOrder(id: string) {',
    });

    const findRes = await tools.findFiles.runAsync({
      args: { pattern: '**/*.ts' },
      toolContext: undefined as never,
    });
    expect(findRes).toEqual({
      totalMatched: 1,
      truncated: false,
      files: ['src/service.ts'],
    });

    const diffRes = await tools.getPrDiff.runAsync({
      args: { path: 'src/service.ts' },
      toolContext: undefined as never,
    });
    expect(diffRes).toEqual({
      changedFiles: ['src/service.ts'],
      path: 'src/service.ts',
      truncated: false,
      diff: expect.stringContaining('placeOrder'),
    });
  });
});
