import { LIMITS } from '../constants/limits.constant.js';

/**
 * Shrinks a unified PR diff before it reaches any prompt.
 *
 * The diff is re-sent on every LLM turn of every reviewer agent, so its size
 * multiplies directly into token spend. Files nobody reviews by reading
 * (lockfiles, generated code, snapshots, binaries) are dropped, each remaining
 * file is capped, and the total is capped — the omitted files are listed in a
 * preamble so the reviewers know what they did not see.
 */

export const DEFAULT_MAX_DIFF_CHARS = LIMITS.maxDiffChars;
export const DEFAULT_MAX_FILE_DIFF_CHARS = LIMITS.maxFileDiffChars;
const MAX_LISTED_OMISSIONS = 50;

const IGNORED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/,
  /(^|\/)(Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|go\.sum|mix\.lock|pubspec\.lock|Podfile\.lock|packages\.lock\.json)$/,
  /\.lock$/,
  /\.(min\.js|min\.css|map|snap)$/,
  /\.(png|jpe?g|gif|ico|webp|bmp|pdf|woff2?|ttf|eot|otf|zip|gz|tar|jar|wasm)$/i,
  /\.(pb\.go|pb\.gw\.go)$/,
  /_pb2?(_grpc)?\.(py|pyi)$/,
  /(^|\/)(node_modules|vendor|dist|build|coverage|__generated__|generated)\//,
  /(^|\/)__snapshots__\//,
  /(^|\/)gen\/.*_pb\.ts$/,
];

const TEST_PATH_PATTERNS: RegExp[] = [
  /\.(spec|test)\.[^/]+$/i,
  /(^|\/)(__tests__|tests?|e2e|[^/]+-e2e)\//i,
];

const DOC_PATH_PATTERNS: RegExp[] = [/\.(md|mdx|txt|rst)$/i, /(^|\/)docs\//i];

const FILE_HEADER = /^diff --git /m;
const PATH_FROM_HEADER = /^diff --git a\/(.+?) b\/(.+)$/m;
const OMITTED_NOTE_PREFIX = '# Files omitted from this diff (not reviewed): ';
const OMITTED_ITEM_REGEX = /^(.+) \((ignored|binary|over_budget)\)$/;

export type DiffOmissionReason = 'ignored' | 'binary' | 'over_budget';

export interface PreparedDiff {
  diff: string;
  includedFiles: string[];
  omitted: Array<{ path: string; reason: DiffOmissionReason }>;
  originalChars: number;
}

export interface PrepareDiffOptions {
  maxChars?: number;
  maxFileChars?: number;
}

export function isIgnoredDiffPath(path: string): boolean {
  return IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function filePriority(path: string): number {
  if (DOC_PATH_PATTERNS.some((pattern) => pattern.test(path))) return 2;
  if (TEST_PATH_PATTERNS.some((pattern) => pattern.test(path))) return 1;
  return 0;
}

function parsePriorOmittedNote(preamble: string): {
  cleanPreamble: string;
  priorOmitted: PreparedDiff['omitted'];
} {
  if (!preamble.startsWith(OMITTED_NOTE_PREFIX)) {
    return { cleanPreamble: preamble, priorOmitted: [] };
  }
  const newlineIdx = preamble.indexOf('\n');
  const noteLine = newlineIdx === -1 ? preamble : preamble.slice(0, newlineIdx);
  const cleanPreamble = newlineIdx === -1 ? '' : preamble.slice(newlineIdx + 1);
  const rawList = noteLine.slice(OMITTED_NOTE_PREFIX.length);
  const priorOmitted: PreparedDiff['omitted'] = [];

  for (const part of rawList.split(', ')) {
    const match = OMITTED_ITEM_REGEX.exec(part.trim());
    if (match) {
      priorOmitted.push({
        path: match[1],
        reason: match[2] as DiffOmissionReason,
      });
    }
  }
  return { cleanPreamble, priorOmitted };
}

function splitDiff(diff: string): {
  preamble: string;
  files: string[];
  priorOmitted: PreparedDiff['omitted'];
} {
  const firstHeader = diff.search(FILE_HEADER);
  if (firstHeader === -1) {
    const { cleanPreamble, priorOmitted } = parsePriorOmittedNote(diff);
    return { preamble: cleanPreamble, files: [], priorOmitted };
  }

  const { cleanPreamble, priorOmitted } = parsePriorOmittedNote(
    diff.slice(0, firstHeader),
  );
  const files = diff
    .slice(firstHeader)
    .split(FILE_HEADER)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => `diff --git ${chunk}`);
  return { preamble: cleanPreamble, files, priorOmitted };
}

function pathOf(fileDiff: string): string {
  const match = PATH_FROM_HEADER.exec(fileDiff);
  return match?.[2] ?? match?.[1] ?? '(unknown)';
}

function isBinary(fileDiff: string): boolean {
  return /^(Binary files .* differ|GIT binary patch)$/m.test(
    fileDiff.slice(0, 2_000),
  );
}

function truncateFileDiff(
  fileDiff: string,
  path: string,
  maxFileChars: number,
): string {
  if (fileDiff.length <= maxFileChars) return fileDiff;
  const suffix = `\n... [diff of ${path} truncated: ${fileDiff.length} chars]\n`;
  const budget = Math.max(0, maxFileChars - suffix.length);
  let head = fileDiff.slice(0, budget);
  // Snap to the last newline after the first hunk header so truncation never
  // leaves a half-cut line at the end of the hunk.
  const lastNewline = head.lastIndexOf('\n');
  const firstHunkIdx = head.indexOf('\n@@ ');
  if (lastNewline > 0 && firstHunkIdx !== -1 && lastNewline > firstHunkIdx) {
    head = head.slice(0, lastNewline);
  }
  return `${head}${suffix}`;
}

export function prepareDiff(
  diff: string,
  options: PrepareDiffOptions = {},
): PreparedDiff {
  const maxChars = options.maxChars ?? DEFAULT_MAX_DIFF_CHARS;
  const maxFileChars = options.maxFileChars ?? DEFAULT_MAX_FILE_DIFF_CHARS;
  const { preamble, files, priorOmitted } = splitDiff(diff);

  const omitted: PreparedDiff['omitted'] = [...priorOmitted];
  const candidates: Array<{
    index: number;
    path: string;
    capped: string;
    priority: number;
  }> = [];

  for (let i = 0; i < files.length; i++) {
    const fileDiff = files[i];
    const path = pathOf(fileDiff);
    if (isIgnoredDiffPath(path)) {
      omitted.push({ path, reason: 'ignored' });
      continue;
    }
    if (isBinary(fileDiff)) {
      omitted.push({ path, reason: 'binary' });
      continue;
    }
    candidates.push({
      index: i,
      path,
      capped: truncateFileDiff(fileDiff, path, maxFileChars),
      priority: filePriority(path),
    });
  }

  // Allocate budget to production source files before tests and docs, while
  // preserving original relative order within each priority tier.
  const byPriority = [...candidates].sort(
    (a, b) => a.priority - b.priority || a.index - b.index,
  );
  const keptIndices = new Set<number>();
  const overBudgetIndices = new Set<number>();
  let used = preamble.length;

  for (const candidate of byPriority) {
    if (used + candidate.capped.length > maxChars) {
      overBudgetIndices.add(candidate.index);
      continue;
    }
    keptIndices.add(candidate.index);
    used += candidate.capped.length;
  }

  const kept: string[] = [];
  const includedFiles: string[] = [];
  for (const candidate of candidates) {
    if (keptIndices.has(candidate.index)) {
      kept.push(candidate.capped);
      includedFiles.push(candidate.path);
    } else if (overBudgetIndices.has(candidate.index)) {
      omitted.push({ path: candidate.path, reason: 'over_budget' });
    }
  }

  const listed = omitted
    .slice(0, MAX_LISTED_OMISSIONS)
    .map((o) => `${o.path} (${o.reason})`);
  if (omitted.length > MAX_LISTED_OMISSIONS) {
    listed.push(`+${omitted.length - MAX_LISTED_OMISSIONS} more`);
  }
  const note =
    omitted.length > 0 ? `${OMITTED_NOTE_PREFIX}${listed.join(', ')}\n` : '';

  return {
    diff: note + preamble + kept.join(''),
    includedFiles,
    omitted,
    originalChars: diff.length,
  };
}
