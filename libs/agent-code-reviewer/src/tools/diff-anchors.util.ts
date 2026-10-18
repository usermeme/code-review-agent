/** A contiguous NEW-side line range covered by one diff hunk. */
export interface LineRange {
  start: number;
  end: number;
}

const HUNK_HEADER_REGEX = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** The NEW-side target path of a `+++ ` header line, or null for deletions. */
function parseNewSideTarget(line: string): string | null {
  const target = line.slice(4).trim();
  return target === '/dev/null' ? null : target.replace(/^b\//, '');
}

/** The NEW-side range of a hunk header line, or null when it adds no lines. */
function parseHunkRange(line: string): LineRange | null {
  const hunk = HUNK_HEADER_REGEX.exec(line);
  if (!hunk) return null;
  const start = Number(hunk[1]);
  const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
  // A +start,0 hunk adds no NEW-side lines — nothing is anchorable.
  if (count === 0) return null;
  return { start, end: start + count - 1 };
}

function openNewSideFile(
  ranges: Map<string, LineRange[]>,
  line: string,
): string | null {
  const currentPath = parseNewSideTarget(line);
  if (currentPath && !ranges.has(currentPath)) {
    ranges.set(currentPath, []);
  }
  return currentPath;
}

function recordHunkRange(
  ranges: Map<string, LineRange[]>,
  currentPath: string | null,
  line: string,
): void {
  const range = parseHunkRange(line);
  if (range && currentPath) {
    ranges.get(currentPath)?.push(range);
  }
}

/**
 * Parses a unified diff into the NEW-side line ranges each file's hunks
 * cover. GitHub only accepts inline review comments on lines inside these
 * ranges — anything else 422s — so publishReviewResults uses this to drop
 * un-anchorable findings before posting instead of after a failed API call.
 *
 * Handles `+++ b/<path>` targets, `/dev/null` (deleted files contribute no
 * anchorable lines), and zero-count new-side hunks (pure deletions).
 */
export function parseNewSideRanges(diff: string): Map<string, LineRange[]> {
  const ranges = new Map<string, LineRange[]>();
  let currentPath: string | null = null;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentPath = null;
    } else if (line.startsWith('+++ ')) {
      currentPath = openNewSideFile(ranges, line);
    } else {
      recordHunkRange(ranges, currentPath, line);
    }
  }

  return ranges;
}

/** True when the given NEW-side line falls inside one of the file's hunks. */
export function isLineInDiff(
  ranges: Map<string, LineRange[]>,
  path: string,
  line: number,
): boolean {
  const fileRanges = ranges.get(path);
  if (!fileRanges) return false;
  return fileRanges.some((range) => line >= range.start && line <= range.end);
}

/**
 * Finds a diff hunk in `path` that covers (or overlaps) `[startLine, endLine]`
 * and clamps both bounds into that single hunk. GitHub requires `start_line`
 * and `line` to belong to the same hunk; clamping preserves findings whose
 * range extends into surrounding lines read via `fetchRepositoryFile` and
 * prevents cross-hunk 422 errors.
 */
export function clampRangeToDiff(
  ranges: Map<string, LineRange[]>,
  path: string,
  startLine: number,
  endLine: number,
): LineRange | null {
  const fileRanges = ranges.get(path);
  if (!fileRanges) return null;
  const target =
    fileRanges.find((r) => endLine >= r.start && endLine <= r.end) ??
    fileRanges.find((r) => startLine >= r.start && startLine <= r.end) ??
    fileRanges.find((r) => startLine <= r.end && endLine >= r.start);
  if (!target) return null;
  return {
    start: Math.max(startLine, target.start),
    end: Math.min(endLine, target.end),
  };
}

/** Mutable line-scanning state shared by the annotateNewSideLines helpers. */
interface AnnotateState {
  inDeletedFile: boolean;
  nextNewLine: number | null;
}

function annotateFileBoundary(state: AnnotateState, line: string): string {
  state.inDeletedFile = false;
  state.nextNewLine = null;
  return line;
}

function annotatePathHeader(state: AnnotateState, line: string): string {
  if (line.startsWith('+++ ')) {
    state.inDeletedFile = line.slice(4).trim() === '/dev/null';
  }
  state.nextNewLine = null;
  return line;
}

function annotateHunkHeader(
  state: AnnotateState,
  line: string,
  hunk: RegExpExecArray,
): string {
  const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
  state.nextNewLine =
    state.inDeletedFile || count === 0 ? null : Number(hunk[1]);
  return line;
}

function isNumberedSideLine(line: string): boolean {
  return line.startsWith('+') || line.startsWith(' ');
}

function annotateUnnumberedLine(state: AnnotateState, line: string): string {
  if (line.startsWith('-')) {
    return `   ${line}`;
  }
  if (line.startsWith('\\')) {
    return line;
  }
  state.nextNewLine = null;
  return line;
}

function annotateContentLine(state: AnnotateState, line: string): string {
  if (state.nextNewLine === null) {
    return line;
  }
  if (!isNumberedSideLine(line)) {
    return annotateUnnumberedLine(state, line);
  }
  const lineNo = state.nextNewLine;
  state.nextNewLine += 1;
  return `${lineNo}: ${line}`;
}

function annotateLine(state: AnnotateState, line: string): string {
  if (line.startsWith('diff --git ')) {
    return annotateFileBoundary(state, line);
  }
  if (line.startsWith('--- ') || line.startsWith('+++ ')) {
    return annotatePathHeader(state, line);
  }
  const hunk = HUNK_HEADER_REGEX.exec(line);
  if (hunk) {
    return annotateHunkHeader(state, line, hunk);
  }
  return annotateContentLine(state, line);
}

/**
 * Annotates each NEW-side line (`+` or context ` `) inside a unified diff hunk
 * with its 1-based NEW-side line number in the left column, matching the
 * reviewer prompt instructions (`startLine`/`endLine`). Deleted lines (`-`)
 * have no NEW-side line number.
 */
export function annotateNewSideLines(diff: string): string {
  const state: AnnotateState = { inDeletedFile: false, nextNewLine: null };

  return diff
    .split('\n')
    .map((line) => annotateLine(state, line))
    .join('\n');
}
