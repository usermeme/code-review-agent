import { readFile } from 'node:fs/promises';
import {
  newSideHunkRanges,
  type LineRange,
} from '../../integrations/github/diff.service.js';
import type { PrDiff } from '../../integrations/vcs/types/vcs.types.js';
import { resolveInsideCheckout } from '../../common/utils/safe-path.util.js';
import { estimateTokens } from '../../common/utils/tokens.util.js';

export interface ChangedFilesOptions {
  maxFileTokens: number;
  totalTokenBudget: number;
}

export interface ChangedFilesResult {
  /** Prompt-ready rendering of the changed files; '' when nothing was loadable. */
  rendered: string;
  included: string[];
  omitted: string[];
}

const WIDE_CONTEXT_LINES = 60;
const NARROW_CONTEXT_LINES = 15;

/** Expands ranges by `context` lines, clamps to the file, and merges overlaps. */
export function expandRanges(
  ranges: LineRange[],
  context: number,
  totalLines: number,
): LineRange[] {
  const expanded = ranges
    .map((r) => ({
      start: Math.max(1, r.start - context),
      end: Math.min(totalLines, r.end + context),
    }))
    .sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  for (const range of expanded) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1)
      last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Renders lines [range.start, range.end] (1-based) prefixed with their line numbers. */
export function renderWithLineNumbers(
  lines: string[],
  range: LineRange,
): string {
  const out: string[] = [];
  for (let n = range.start; n <= range.end; n++) {
    out.push(`${String(n).padStart(5)} | ${lines[n - 1] ?? ''}`);
  }
  return out.join('\n');
}

/**
 * Renders one changed file for a reviewer prompt: the whole file when it fits
 * the budget, otherwise numbered windows around the diff hunks.
 */
export function renderChangedFile(
  path: string,
  content: string,
  patch: string | undefined,
  maxFileTokens: number,
): string {
  const lines = content.split('\n');
  const total = lines.length;
  const whole = renderWithLineNumbers(lines, { start: 1, end: total });
  if (estimateTokens(whole) <= maxFileTokens) {
    return `===== FILE: ${path} (${total} lines) =====\n${whole}`;
  }

  const hunks = patch ? newSideHunkRanges(patch) : [];
  if (hunks.length === 0) {
    return (
      `===== FILE: ${path} (${total} lines; truncated) =====\n` +
      whole.slice(0, maxFileTokens * 4) +
      '\n  ... [rest of file omitted] ...'
    );
  }

  for (const context of [WIDE_CONTEXT_LINES, NARROW_CONTEXT_LINES]) {
    const rendered = renderSegments(
      path,
      lines,
      expandRanges(hunks, context, total),
    );
    if (estimateTokens(rendered) <= maxFileTokens) return rendered;
  }
  const rendered = renderSegments(
    path,
    lines,
    expandRanges(hunks, NARROW_CONTEXT_LINES, total),
  );
  return (
    rendered.slice(0, maxFileTokens * 4) + '\n  ... [truncated for budget] ...'
  );
}

function renderSegments(
  path: string,
  lines: string[],
  ranges: LineRange[],
): string {
  const total = lines.length;
  const parts = [
    `===== FILE: ${path} (${total} lines; showing regions around the changes) =====`,
  ];
  let prevEnd = 0;
  for (const range of ranges) {
    if (range.start > prevEnd + 1)
      parts.push(`  ... [lines ${prevEnd + 1}-${range.start - 1} omitted] ...`);
    parts.push(renderWithLineNumbers(lines, range));
    prevEnd = range.end;
  }
  if (prevEnd < total)
    parts.push(`  ... [lines ${prevEnd + 1}-${total} omitted] ...`);
  return parts.join('\n');
}

/**
 * Reads the full content of every changed file from the PR head checkout and
 * renders it with 1-based line numbers, within per-file and total token
 * budgets. This is what lets reviewer agents see code around the hunks
 * instead of guessing from the diff.
 */
export async function loadChangedFiles(
  checkoutDir: string,
  files: PrDiff[],
  options: ChangedFilesOptions,
): Promise<ChangedFilesResult> {
  const sections: string[] = [];
  const included: string[] = [];
  const omitted: string[] = [];
  let budget = options.totalTokenBudget;

  for (const file of files) {
    if (file.status === 'deleted') continue;
    const full = await resolveInsideCheckout(checkoutDir, file.filename);
    if (!full) {
      omitted.push(file.filename);
      continue;
    }
    if (budget <= 0) {
      omitted.push(file.filename);
      continue;
    }
    let content: string;
    try {
      content = await readFile(full, 'utf8');
    } catch {
      omitted.push(file.filename);
      continue;
    }
    if (content.includes('\u0000')) {
      omitted.push(file.filename);
      continue;
    }
    const section = renderChangedFile(
      file.filename,
      content,
      file.patch,
      Math.min(options.maxFileTokens, budget),
    );
    budget -= estimateTokens(section);
    sections.push(section);
    included.push(file.filename);
  }

  if (sections.length > 0 && omitted.length > 0) {
    sections.push(`(Changed files not shown here: ${omitted.join(', ')})`);
  }
  return {
    rendered: sections.length > 0 ? sections.join('\n\n') : '',
    included,
    omitted,
  };
}
