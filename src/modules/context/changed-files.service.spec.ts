import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expandRanges,
  loadChangedFiles,
  renderChangedFile,
  renderWithLineNumbers,
} from './changed-files.service.js';
import type { PrDiff } from '../../integrations/vcs/types/vcs.types.js';

function prFile(overrides: Partial<PrDiff>): PrDiff {
  return { filename: 'src/a.ts', status: 'modified', patch: '', additions: 1, deletions: 0, ...overrides };
}

describe('expandRanges', () => {
  it('expands, clamps to the file, and merges overlapping ranges', () => {
    expect(
      expandRanges(
        [
          { start: 3, end: 4 },
          { start: 10, end: 12 },
        ],
        3,
        100,
      ),
    ).toEqual([{ start: 1, end: 15 }]);
    expect(expandRanges([{ start: 98, end: 99 }], 5, 100)).toEqual([{ start: 93, end: 100 }]);
  });
});

describe('renderWithLineNumbers', () => {
  it('renders 1-based numbered lines', () => {
    expect(renderWithLineNumbers(['a', 'b', 'c'], { start: 2, end: 3 })).toBe('    2 | b\n    3 | c');
  });
});

describe('renderChangedFile', () => {
  it('renders the whole file when it fits the budget', () => {
    const rendered = renderChangedFile('x.ts', 'a\nb', undefined, 1000);
    expect(rendered).toContain('===== FILE: x.ts (2 lines) =====');
    expect(rendered).toContain('    1 | a');
  });

  it('windows around hunks when the file exceeds the budget', () => {
    const content = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n');
    const rendered = renderChangedFile('x.ts', content, '@@ -1000,2 +1000,3 @@\n+x\n+y\n z', 500);
    expect(rendered).toContain('showing regions around the changes');
    expect(rendered).toContain(' 1000 | line 1000');
    expect(rendered).toContain('omitted');
    expect(rendered).not.toContain('|  line 1\n');
  });
});

describe('loadChangedFiles', () => {
  let dir: string;
  let outside: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'changed-files-'));
    outside = await mkdtemp(join(tmpdir(), 'changed-files-outside-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/a.ts'), 'const a = 1;\n');
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0x00, 0x01]));
    await writeFile(join(outside, 'secret.txt'), 'SECRET');
    await symlink(join(outside, 'secret.txt'), join(dir, 'link.ts'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('loads changed files and reports omissions for missing/binary/removed/traversal paths', async () => {
    const result = await loadChangedFiles(
      dir,
      [
        prFile({ filename: 'src/a.ts' }),
        prFile({ filename: 'missing.ts' }),
        prFile({ filename: 'bin.dat' }),
        prFile({ filename: 'gone.ts', status: 'deleted' }),
        prFile({ filename: '../escape.ts' }),
        prFile({ filename: 'link.ts' }),
      ],
      { maxFileTokens: 1000, totalTokenBudget: 5000 },
    );
    expect(result.included).toEqual(['src/a.ts']);
    expect(result.omitted).toEqual(expect.arrayContaining(['missing.ts', 'bin.dat', '../escape.ts', 'link.ts']));
    expect(result.omitted).not.toContain('gone.ts');
    expect(result.rendered).toContain('===== FILE: src/a.ts');
    expect(result.rendered).not.toContain('SECRET');
    expect(result.rendered).toContain('Changed files not shown here');
  });

  it('stops loading once the total budget is exhausted', async () => {
    const result = await loadChangedFiles(dir, [prFile({ filename: 'src/a.ts' }), prFile({ filename: 'src/a.ts' })], {
      maxFileTokens: 1000,
      totalTokenBudget: 1,
    });
    expect(result.included).toHaveLength(1);
    expect(result.omitted).toHaveLength(1);
  });
});
