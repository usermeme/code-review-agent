import { describe, expect, it } from 'vitest';

import { isLineInDiff, parseNewSideRanges } from './diff-anchors.util.js';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 111..222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,5 @@ function header',
  ' context',
  '+added line',
  '@@ -20,7 +21,0 @@',
  '-removed block only',
  'diff --git a/deleted.ts b/deleted.ts',
  '--- a/deleted.ts',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-bye',
  'diff --git a/old/name.ts b/new/name.ts',
  'similarity index 91%',
  'rename from old/name.ts',
  'rename to new/name.ts',
  '--- a/old/name.ts',
  '+++ b/new/name.ts',
  '@@ -5,3 +5,4 @@',
  '+fresh line',
  'diff --git a/single.ts b/single.ts',
  '--- a/single.ts',
  '+++ b/single.ts',
  '@@ -8 +8 @@',
  '-old',
  '+new',
].join('\n');

describe('parseNewSideRanges', () => {
  const ranges = parseNewSideRanges(DIFF);

  it('maps hunks to NEW-side line ranges', () => {
    expect(ranges.get('src/app.ts')).toEqual([{ start: 1, end: 5 }]);
  });

  it('skips zero-count new-side hunks (pure deletions)', () => {
    // The +21,0 hunk contributes no anchorable lines.
    expect(ranges.get('src/app.ts')).toHaveLength(1);
    expect(isLineInDiff(ranges, 'src/app.ts', 21)).toBe(false);
  });

  it('omits deleted files entirely', () => {
    expect(ranges.has('deleted.ts')).toBe(false);
  });

  it('keys renamed files by their new path', () => {
    expect(ranges.get('new/name.ts')).toEqual([{ start: 5, end: 8 }]);
    expect(ranges.has('old/name.ts')).toBe(false);
  });

  it('defaults a count-less hunk header to a single line', () => {
    expect(ranges.get('single.ts')).toEqual([{ start: 8, end: 8 }]);
  });
});

describe('isLineInDiff', () => {
  const ranges = parseNewSideRanges(DIFF);

  it('accepts lines inside and on the boundaries of a hunk', () => {
    expect(isLineInDiff(ranges, 'src/app.ts', 1)).toBe(true);
    expect(isLineInDiff(ranges, 'src/app.ts', 3)).toBe(true);
    expect(isLineInDiff(ranges, 'src/app.ts', 5)).toBe(true);
  });

  it('rejects lines outside every hunk of the file', () => {
    expect(isLineInDiff(ranges, 'src/app.ts', 6)).toBe(false);
    expect(isLineInDiff(ranges, 'src/app.ts', 0)).toBe(false);
    expect(isLineInDiff(ranges, 'src/app.ts', 300)).toBe(false);
  });

  it('rejects unknown and deleted files', () => {
    expect(isLineInDiff(ranges, 'src/unknown.ts', 1)).toBe(false);
    expect(isLineInDiff(ranges, 'deleted.ts', 1)).toBe(false);
  });
});
