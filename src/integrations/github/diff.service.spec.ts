import { describe, expect, it } from 'vitest';
import { annotateDiff, newSideHunkRanges } from './diff.service.js';
import { anchorableLines } from './review-publisher.service.js';

const PATCH = [
  '@@ -1,4 +1,6 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' console.log(a);',
  '@@ -10,2 +12,3 @@',
  ' function f() {',
  '+  return b + c;',
  ' }',
].join('\n');

describe('annotateDiff', () => {
  it('prefixes new-side lines with their line numbers and leaves removals blank', () => {
    const lines = annotateDiff(PATCH).split('\n');
    expect(lines[1]).toBe('    1 |  const a = 1;');
    expect(lines[2]).toBe('      | -const b = 2;');
    expect(lines[3]).toBe('    2 | +const b = 3;');
    expect(lines[6]).toBe('@@ -10,2 +12,3 @@');
    expect(lines[8]).toBe('   13 | +  return b + c;');
  });

  it('agrees with anchorableLines on every numbered line', () => {
    const anchors = anchorableLines(PATCH);
    for (const row of annotateDiff(PATCH).split('\n')) {
      const numbered = /^\s*(\d+) \|/.exec(row);
      if (numbered) expect(anchors.has(Number(numbered[1]))).toBe(true);
    }
  });

  it('leaves file headers between diffs unannotated', () => {
    const multi = `diff --git a/x.ts b/x.ts\nindex 111..222 100644\n--- a/x.ts\n+++ b/x.ts\n${PATCH}`;
    const annotated = annotateDiff(multi);
    expect(annotated).toContain('diff --git a/x.ts b/x.ts');
    expect(annotated.split('\n')[0]).not.toContain('|');
  });
});

describe('newSideHunkRanges', () => {
  it('extracts new-side ranges from hunk headers', () => {
    expect(newSideHunkRanges(PATCH)).toEqual([
      { start: 1, end: 6 },
      { start: 12, end: 14 },
    ]);
  });

  it('handles single-line hunks and skips zero-count hunks', () => {
    expect(newSideHunkRanges('@@ -5 +7 @@\n+x')).toEqual([{ start: 7, end: 7 }]);
    expect(newSideHunkRanges('@@ -5,2 +4,0 @@\n-x\n-y')).toEqual([]);
  });
});
