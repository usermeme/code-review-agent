import { describe, expect, it } from 'vitest';

import { prepareDiff } from './diff.util.js';

const fileDiff = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`;

describe('prepareDiff', () => {
  it('drops lockfiles, generated files and binaries but keeps source', () => {
    const diff = [
      fileDiff('src/app.ts', '+const a = 1;'),
      fileDiff('pnpm-lock.yaml', '+lock'),
      fileDiff('libs/contracts/src/gen/core_pb.ts', '+gen'),
      fileDiff('src/__snapshots__/app.spec.ts.snap', '+snap'),
      'diff --git a/logo.bin b/logo.bin\nBinary files a/logo.bin and b/logo.bin differ\n',
    ].join('');

    const result = prepareDiff(diff);

    expect(result.includedFiles).toEqual(['src/app.ts']);
    expect(result.omitted).toEqual([
      { path: 'pnpm-lock.yaml', reason: 'ignored' },
      { path: 'libs/contracts/src/gen/core_pb.ts', reason: 'ignored' },
      { path: 'src/__snapshots__/app.spec.ts.snap', reason: 'ignored' },
      { path: 'logo.bin', reason: 'binary' },
    ]);
    expect(result.diff).toContain('+const a = 1;');
    expect(result.diff).not.toContain('+lock');
    expect(result.diff).toContain('Files omitted from this diff');
  });

  it('truncates a single huge file and omits files past the total budget', () => {
    const diff = [
      fileDiff('src/big.ts', `+${'x'.repeat(5_000)}`),
      fileDiff('src/next.ts', `+${'y'.repeat(900)}`),
      fileDiff('src/last.ts', `+${'z'.repeat(900)}`),
    ].join('');

    const result = prepareDiff(diff, { maxChars: 2_500, maxFileChars: 1_000 });

    expect(result.includedFiles).toEqual(['src/big.ts', 'src/next.ts']);
    expect(result.omitted).toEqual([
      { path: 'src/last.ts', reason: 'over_budget' },
    ]);
    expect(result.diff).toContain('[diff of src/big.ts truncated');
    expect(result.diff.length).toBeLessThan(2_700);
  });

  it('is stable when applied to an already prepared diff', () => {
    const once = prepareDiff(
      [fileDiff('src/a.ts', '+a'), fileDiff('yarn.lock', '+l')].join(''),
    );
    const twice = prepareDiff(once.diff);

    expect(twice.includedFiles).toEqual(['src/a.ts']);
    expect(twice.diff).toContain('+a');
  });

  it('passes through text without file headers', () => {
    expect(prepareDiff('not a diff').diff).toBe('not a diff');
  });
});
