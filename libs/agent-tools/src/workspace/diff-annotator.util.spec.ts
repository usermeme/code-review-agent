import { describe, expect, it } from 'vitest';

import {
  annotateUnifiedDiff,
  resolveDiffAnchor,
} from './diff-annotator.util.js';

const MULTI_FILE_DIFF = [
  'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
  '--- a/pnpm-lock.yaml',
  '+++ b/pnpm-lock.yaml',
  '@@ -1,2 +1,2 @@',
  '-lockfileVersion: 6.0',
  '+lockfileVersion: 9.0',
  'diff --git a/src/service.ts b/src/service.ts',
  '--- a/src/service.ts',
  '+++ b/src/service.ts',
  '@@ -10,4 +10,5 @@ export class Service {',
  '   existingLine() {}',
  '-  oldMethod() {}',
  '+  newMethodA() {}',
  '+  newMethodB() {}',
  '   closingLine() {}',
].join('\n');

describe('diff-annotator.util', () => {
  it('strips lockfiles and annotates NEW-side line numbers and deletions', () => {
    const result = annotateUnifiedDiff(MULTI_FILE_DIFF);

    expect(Array.from(result.byFile.keys())).toEqual(['src/service.ts']);
    expect(result.annotatedDiff).toBe(
      [
        'diff --git a/src/service.ts b/src/service.ts',
        '--- a/src/service.ts',
        '+++ b/src/service.ts',
        '@@ -10,4 +10,5 @@ export class Service {',
        'L10 |    existingLine() {}',
        'DEL | -  oldMethod() {}',
        'L11 | +  newMethodA() {}',
        'L12 | +  newMethodB() {}',
        'L13 |    closingLine() {}',
      ].join('\n'),
    );

    const validLines = result.validLinesByFile.get('src/service.ts');
    expect(Array.from(validLines ?? [])).toEqual([10, 11, 12, 13]);
  });

  it('validates single-line and multi-line diff anchors', () => {
    const { validLinesByFile } = annotateUnifiedDiff(MULTI_FILE_DIFF);

    // Valid multi-line range inside hunk
    expect(
      resolveDiffAnchor(validLinesByFile, 'src/service.ts', 12, 11),
    ).toEqual({
      line: 12,
      startLine: 11,
    });

    // Start line outside hunk collapses to single-line anchor on endLine
    expect(
      resolveDiffAnchor(validLinesByFile, 'src/service.ts', 12, 2),
    ).toEqual({
      line: 12,
    });

    // End line outside hunk is rejected
    expect(
      resolveDiffAnchor(validLinesByFile, 'src/service.ts', 99, 11),
    ).toBeNull();
  });
});
