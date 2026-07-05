/**
 * Annotates a unified diff with explicit NEW-side line numbers so models
 * never have to derive them from hunk headers (which they reliably get
 * wrong). Every hunk-body line that exists on the new side is prefixed with
 * its line number; removed lines get a blank prefix. Numbering matches
 * anchorableLines in review-publisher.ts, which decides what GitHub accepts
 * as an inline-comment anchor.
 */
export function annotateDiff(diff: string): string {
  const out: string[] = [];
  let newLine = 0;
  let inHunk = false;

  for (const row of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      out.push(row);
      continue;
    }
    if (row.startsWith('diff ')) inHunk = false;
    if (!inHunk) {
      out.push(row);
      continue;
    }
    if (row.startsWith('+') || row.startsWith(' ')) {
      out.push(`${String(newLine).padStart(5)} | ${row}`);
      newLine++;
    } else {
      // '-' lines and '\ No newline at end of file' have no new-side number.
      out.push(`      | ${row}`);
    }
  }
  return out.join('\n');
}

export interface LineRange {
  start: number;
  end: number;
}

/** NEW-side line ranges covered by the hunks of a single-file patch. */
export function newSideHunkRanges(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}
