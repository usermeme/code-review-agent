/**
 * Annotates a unified diff with explicit NEW-side line numbers so models
 * never have to derive them from hunk headers (which they reliably get
 * wrong). Every hunk-body line that exists on the new side is prefixed with
 * its line number; removed lines get a blank prefix. Numbering matches
 * anchorableLines in review-publisher.ts, which decides what GitHub accepts
 * as an inline-comment anchor.
 */
const HUNK_HEADER_REGEX = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function annotateDiff(diff: string): string {
  const annotatedLines: string[] = [];
  let currentNewLineNumber = 0;
  let isInsideHunk = false;

  for (const line of diff.split('\n')) {
    const hunkHeaderMatch = HUNK_HEADER_REGEX.exec(line);
    
    if (hunkHeaderMatch) {
      currentNewLineNumber = Number(hunkHeaderMatch[1]);
      isInsideHunk = true;
      annotatedLines.push(line);
      continue;
    }

    if (line.startsWith('diff ')) {
      isInsideHunk = false;
    }

    if (!isInsideHunk) {
      annotatedLines.push(line);
      continue;
    }

    const isAdditionOrContext = line.startsWith('+') || line.startsWith(' ');
    
    if (isAdditionOrContext) {
      const paddedLineNumber = String(currentNewLineNumber).padStart(5);
      annotatedLines.push(`${paddedLineNumber} | ${line}`);
      currentNewLineNumber++;
    } else {
      // Removed lines ('-') and special markers like '\ No newline at end of file'
      // do not correspond to a line number on the new side of the diff.
      annotatedLines.push(`      | ${line}`);
    }
  }
  
  return annotatedLines.join('\n');
}

export interface LineRange {
  start: number;
  end: number;
}

const HUNK_HEADER_GLOBAL_REGEX = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

/** NEW-side line ranges covered by the hunks of a single-file patch. */
export function newSideHunkRanges(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  
  for (const match of patch.matchAll(HUNK_HEADER_GLOBAL_REGEX)) {
    const startLine = Number(match[1]);
    
    // If the count (match[2]) is omitted in the header, it defaults to 1 line
    const lineCount = match[2] === undefined ? 1 : Number(match[2]);
    
    if (lineCount > 0) {
      ranges.push({ 
        start: startLine, 
        end: startLine + lineCount - 1 
      });
    }
  }
  
  return ranges;
}
