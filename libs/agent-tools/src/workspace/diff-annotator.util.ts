import { isIndexableFilePath } from './file-filter.util.js';

export interface AnnotatedDiff {
  annotatedDiff: string;
  byFile: Map<string, string>;
  validLinesByFile: Map<string, Set<number>>;
}

export interface DiffCommentAnchor {
  line: number;
  startLine?: number;
}

const HUNK_HEADER_REGEX = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

export function extractDiffHeaderPath(headerLine: string): string {
  const bMatch = /\sb\/([^\s]+)$/.exec(headerLine.trim());
  if (bMatch) {
    return bMatch[1];
  }
  const parts = headerLine.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? '';
  return last.replace(/^b\//, '');
}

function extractFirstLine(chunk: string): string {
  const firstNewline = chunk.indexOf('\n');
  return firstNewline >= 0 ? chunk.slice(0, firstNewline) : chunk;
}

function parseHunkStartLine(line: string): number | null {
  const match = HUNK_HEADER_REGEX.exec(line);
  return match ? parseInt(match[1], 10) : null;
}

interface HunkCursor {
  inHunk: boolean;
  newLine: number;
}

function formatHunkBodyLine(
  line: string,
  cursor: HunkCursor,
  validLines: Set<number>,
): string {
  if (line.startsWith('-')) {
    return `DEL | ${line}`;
  }
  if (line.startsWith('+')) {
    const current = cursor.newLine;
    validLines.add(current);
    cursor.newLine += 1;
    return `L${current} | ${line}`;
  }
  if (line.startsWith(' ')) {
    const current = cursor.newLine;
    validLines.add(current);
    cursor.newLine += 1;
    return `L${current} | ${line}`;
  }
  return line;
}

function annotateSingleDiffLine(
  line: string,
  cursor: HunkCursor,
  validLines: Set<number>,
): string {
  const hunkStart = parseHunkStartLine(line);
  if (hunkStart !== null) {
    cursor.inHunk = true;
    cursor.newLine = hunkStart;
    return line;
  }
  if (!cursor.inHunk) {
    return line;
  }
  return formatHunkBodyLine(line, cursor, validLines);
}

function annotateFileDiffChunk(chunk: string): {
  filePath: string;
  annotatedChunk: string;
  validLines: Set<number>;
} | null {
  const firstLine = extractFirstLine(chunk);
  if (!firstLine.startsWith('diff --git ')) {
    return null;
  }
  const filePath = extractDiffHeaderPath(firstLine);
  if (!isIndexableFilePath(filePath)) {
    return null;
  }
  return buildAnnotatedChunk(filePath, chunk);
}

function buildAnnotatedChunk(
  filePath: string,
  chunk: string,
): {
  filePath: string;
  annotatedChunk: string;
  validLines: Set<number>;
} {
  const validLines = new Set<number>();
  const cursor: HunkCursor = { inHunk: false, newLine: 1 };
  const lines = chunk.trimEnd().split('\n');
  const annotatedLines = lines.map((line) =>
    annotateSingleDiffLine(line, cursor, validLines),
  );
  return {
    filePath,
    annotatedChunk: annotatedLines.join('\n'),
    validLines,
  };
}

/**
 * Splits a unified git diff by file, strips unreviewable files (lockfiles,
 * node_modules, binaries), annotates each hunk line with its 1-based NEW-side
 * line number (`L42 | +...` or `DEL | -...`), and records the set of valid
 * NEW-side commentable lines per file.
 */
export function annotateUnifiedDiff(rawDiff: string): AnnotatedDiff {
  const byFile = new Map<string, string>();
  const validLinesByFile = new Map<string, Set<number>>();
  if (!rawDiff.trim()) {
    return { annotatedDiff: '', byFile, validLinesByFile };
  }

  const annotatedChunks: string[] = [];
  for (const chunk of rawDiff.split(/(?=^diff --git )/m)) {
    const result = annotateFileDiffChunk(chunk);
    if (result) {
      byFile.set(result.filePath, result.annotatedChunk);
      validLinesByFile.set(result.filePath, result.validLines);
      annotatedChunks.push(result.annotatedChunk);
    }
  }

  return {
    annotatedDiff: annotatedChunks.join('\n'),
    byFile,
    validLinesByFile,
  };
}

function isValidStartLine(
  validLines: Set<number>,
  startLine: number | undefined,
  endLine: number,
): startLine is number {
  return (
    typeof startLine === 'number' &&
    startLine > 0 &&
    startLine < endLine &&
    validLines.has(startLine)
  );
}

/**
 * Validates that `endLine` (and optional `startLine`) belong to commentable
 * NEW-side lines in the PR diff for `filePath`. Collapses `startLine` when
 * outside the hunk; returns `null` when `endLine` is not in the diff.
 */
export function resolveDiffAnchor(
  validLinesByFile: Map<string, Set<number>>,
  filePath: string,
  endLine: number,
  startLine?: number,
): DiffCommentAnchor | null {
  const validLines = validLinesByFile.get(filePath);
  if (!validLines || !validLines.has(endLine)) {
    return null;
  }
  if (isValidStartLine(validLines, startLine, endLine)) {
    return { line: endLine, startLine };
  }
  return { line: endLine };
}
