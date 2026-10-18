import { describe, expect, it } from 'vitest';

import {
  annotateNewSideLines,
  clampRangeToDiff,
  parseNewSideRanges,
} from './diff-anchors.util.js';

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
    expect(clampRangeToDiff(ranges, 'src/app.ts', 21, 21)).toBeNull();
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

describe('clampRangeToDiff', () => {
  const ranges = parseNewSideRanges(DIFF);

  it('clamps partially overlapping ranges into a single hunk and rejects disjoint ones', () => {
    expect(clampRangeToDiff(ranges, 'new/name.ts', 2, 7)).toEqual({
      start: 5,
      end: 7,
    });
    expect(clampRangeToDiff(ranges, 'new/name.ts', 6, 12)).toEqual({
      start: 6,
      end: 8,
    });
    expect(clampRangeToDiff(ranges, 'new/name.ts', 100, 105)).toBeNull();
  });
});

describe('annotateNewSideLines', () => {
  it('prefixes added and context lines with 1-based NEW-side line numbers and leaves deletions unnumbered', () => {
    const annotated = annotateNewSideLines(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -10,3 +10,3 @@',
        ' context',
        '-old',
        '+new',
      ].join('\n'),
    );

    expect(annotated).toContain('10:  context');
    expect(annotated).toContain('   -old');
    expect(annotated).toContain('11: +new');
  });
});
