/** A contiguous NEW-side line range covered by one diff hunk. */
export interface LineRange {
  start: number;
  end: number;
}

const HUNK_HEADER_REGEX = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

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
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      currentPath = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (currentPath && !ranges.has(currentPath)) {
        ranges.set(currentPath, []);
      }
      continue;
    }
    const hunk = HUNK_HEADER_REGEX.exec(line);
    if (hunk && currentPath) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      // A +start,0 hunk adds no NEW-side lines — nothing is anchorable.
      if (count === 0) continue;
      ranges.get(currentPath)?.push({ start, end: start + count - 1 });
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

/**
 * Annotates each NEW-side line (`+` or context ` `) inside a unified diff hunk
 * with its 1-based NEW-side line number in the left column, matching the
 * reviewer prompt instructions (`startLine`/`endLine`). Deleted lines (`-`)
 * have no NEW-side line number.
 */
export function annotateNewSideLines(diff: string): string {
  let inDeletedFile = false;
  let nextNewLine: number | null = null;

  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) {
        inDeletedFile = false;
        nextNewLine = null;
        return line;
      }
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        if (line.startsWith('+++ ')) {
          inDeletedFile = line.slice(4).trim() === '/dev/null';
        }
        nextNewLine = null;
        return line;
      }
      const hunk = HUNK_HEADER_REGEX.exec(line);
      if (hunk) {
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        nextNewLine = inDeletedFile || count === 0 ? null : Number(hunk[1]);
        return line;
      }
      if (nextNewLine === null) {
        return line;
      }
      if (line.startsWith('+') || line.startsWith(' ')) {
        const lineNo = nextNewLine;
        nextNewLine += 1;
        return `${lineNo}: ${line}`;
      }
      if (line.startsWith('-')) {
        return `   ${line}`;
      }
      if (line.startsWith('\\')) {
        return line;
      }
      nextNewLine = null;
      return line;
    })
    .join('\n');
}
