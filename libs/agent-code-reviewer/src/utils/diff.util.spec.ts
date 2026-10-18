import { describe, expect, it } from 'vitest';

import { prepareDiff, stripUnreviewableOmissions } from './diff.util.js';

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

    // Truncation snaps to a line boundary, so the single 5k-char line of
    // src/big.ts collapses to headers + marker (~130 chars) and the two
    // ~990-char files decide the budget: next still fits, last does not.
    const result = prepareDiff(diff, { maxChars: 2_000, maxFileChars: 1_000 });

    expect(result.includedFiles).toEqual(['src/big.ts', 'src/next.ts']);
    expect(result.omitted).toEqual([
      { path: 'src/last.ts', reason: 'over_budget' },
    ]);
    expect(result.diff).toContain('[diff of src/big.ts truncated');
    expect(result.diff.length).toBeLessThan(2_200);
  });

  it('is strictly idempotent even when files were truncated and omitted', () => {
    const raw = [
      fileDiff('src/big.ts', `+${'x'.repeat(5_000)}`),
      fileDiff('src/keep.ts', `+${'y'.repeat(900)}`),
      fileDiff('src/drop.ts', `+${'z'.repeat(900)}`),
      fileDiff('yarn.lock', '+l'),
    ].join('');
    const opts = { maxChars: 2_000, maxFileChars: 1_000 };

    const once = prepareDiff(raw, opts);
    const twice = prepareDiff(once.diff, opts);

    expect(twice.diff).toBe(once.diff);
    expect(twice.includedFiles).toEqual(['src/big.ts', 'src/keep.ts']);
    expect(twice.omitted).toEqual(once.omitted);
  });

  it('prioritizes production source files over tests and docs when over budget', () => {
    const diff = [
      fileDiff('README.md', `+${'d'.repeat(900)}`),
      fileDiff('src/app.spec.ts', `+${'t'.repeat(900)}`),
      fileDiff('src/app.ts', `+${'s'.repeat(900)}`),
    ].join('');

    const result = prepareDiff(diff, { maxChars: 2_100, maxFileChars: 2_000 });

    expect(result.includedFiles).toEqual(['src/app.spec.ts', 'src/app.ts']);
    expect(result.omitted).toEqual([
      { path: 'README.md', reason: 'over_budget' },
    ]);
  });

  it('passes through text without file headers', () => {
    expect(prepareDiff('not a diff').diff).toBe('not a diff');
  });
});

describe('stripUnreviewableOmissions', () => {
  it('drops ignored names from the note but keeps budget omissions', () => {
    const prepared = prepareDiff(
      [
        fileDiff('src/app.ts', '+const a = 1;'),
        fileDiff('src/big.ts', `+${'x'.repeat(5_000)}`),
        fileDiff('src/next.ts', `+${'y'.repeat(900)}`),
        fileDiff('pnpm-lock.yaml', '+lock'),
      ].join(''),
      { maxChars: 1_200, maxFileChars: 1_000 },
    );

    const stripped = stripUnreviewableOmissions(prepared.diff);

    expect(stripped).not.toContain('pnpm-lock.yaml');
    expect(stripped).toContain('src/next.ts (over_budget)');
    expect(stripped).toContain('+const a = 1;');
  });

  it('removes the note entirely when nothing review-relevant was omitted', () => {
    const prepared = prepareDiff(
      [
        fileDiff('src/app.ts', '+const a = 1;'),
        fileDiff('yarn.lock', '+l'),
      ].join(''),
    );

    const stripped = stripUnreviewableOmissions(prepared.diff);

    expect(stripped.startsWith('diff --git')).toBe(true);
    expect(stripped).not.toContain('Files omitted');
    expect(stripped).not.toContain('yarn.lock');
    expect(stripped).toContain('+const a = 1;');
  });

  it('passes diffs without an omission note through untouched', () => {
    const diff = fileDiff('src/app.ts', '+const a = 1;');

    expect(stripUnreviewableOmissions(diff)).toBe(diff);
  });
});
