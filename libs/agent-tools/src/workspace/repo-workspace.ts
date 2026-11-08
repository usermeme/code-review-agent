import { createPathMatcher } from './file-filter.util.js';

export interface GrepCodeOptions {
  pattern: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  pathPattern?: string;
  contextLines?: number;
  maxResults?: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  snippet: string;
}

export interface GrepCodeResult {
  totalMatches: number;
  truncated: boolean;
  matches: GrepMatch[];
  error?: string;
}

export interface ReadFileOptions {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface ReadFileResult {
  path: string;
  exists: boolean;
  totalLines: number;
  startLine: number;
  endLine: number;
  hasMore: boolean;
  content: string;
  error?: string;
}

export interface FindFilesOptions {
  pattern?: string;
  maxResults?: number;
}

export interface FindFilesResult {
  totalMatched: number;
  truncated: boolean;
  files: string[];
}

export interface GetPrDiffOptions {
  path?: string;
  maxChars?: number;
}

export interface GetPrDiffResult {
  changedFiles: string[];
  path?: string;
  truncated: boolean;
  diff: string;
}

const DEFAULT_MAX_GREP_RESULTS = 40;
const MAX_GREP_RESULTS_LIMIT = 100;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 5;
const MAX_SNIPPET_LINE_CHARS = 300;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 250;
const DEFAULT_MAX_FIND_FILES = 200;
const MAX_FIND_FILES_LIMIT = 500;
const DEFAULT_MAX_DIFF_CHARS = 30_000;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function normalizeLookupPath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '');
}

function escapeLiteralRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLineRegex(options: GrepCodeOptions): RegExp | { error: string } {
  const flags = options.caseSensitive ? '' : 'i';
  const source = options.isRegex
    ? options.pattern
    : escapeLiteralRegex(options.pattern);
  try {
    return new RegExp(source, flags);
  } catch (err) {
    return {
      error: `Invalid regular expression "${options.pattern}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function truncateLine(line: string): string {
  return line.length > MAX_SNIPPET_LINE_CHARS
    ? `${line.slice(0, MAX_SNIPPET_LINE_CHARS)}...`
    : line;
}

function formatSnippet(
  lines: string[],
  matchIndex: number,
  contextLines: number,
): string {
  const start = Math.max(0, matchIndex - contextLines);
  const end = Math.min(lines.length - 1, matchIndex + contextLines);
  const formatted: string[] = [];
  for (let i = start; i <= end; i++) {
    const marker = i === matchIndex ? '>' : ' ';
    formatted.push(`${marker} ${i + 1} | ${truncateLine(lines[i] ?? '')}`);
  }
  return formatted.join('\n');
}

function extractDiffHeaderPath(headerLine: string): string {
  const bMatch = /\sb\/([^\s]+)$/.exec(headerLine.trim());
  if (bMatch?.[1]) {
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

function addDiffChunkToMap(chunk: string, byFile: Map<string, string>): void {
  const firstLine = extractFirstLine(chunk);
  if (!firstLine.startsWith('diff --git ')) {
    return;
  }
  const filePath = extractDiffHeaderPath(firstLine);
  if (filePath) {
    byFile.set(filePath, chunk.trimEnd());
  }
}

/**
 * Splits a unified git diff into per-file sections keyed by normalized file path.
 */
export function parseDiffByFile(rawDiff: string): Map<string, string> {
  const byFile = new Map<string, string>();
  if (!rawDiff.trim()) {
    return byFile;
  }
  for (const chunk of rawDiff.split(/(?=^diff --git )/m)) {
    addDiffChunkToMap(chunk, byFile);
  }
  return byFile;
}

export interface RepoWorkspaceInit {
  files: Map<string, string[]>;
  rawDiff?: string;
  changedFiles?: string[];
}

export class RepoWorkspace {
  private readonly files: Map<string, string[]>;
  private readonly sortedPaths: string[];
  private readonly rawDiff: string;
  private readonly diffByFile: Map<string, string>;
  private readonly changedFiles: string[];

  constructor(init: RepoWorkspaceInit) {
    this.files = init.files;
    this.sortedPaths = Array.from(init.files.keys()).sort();
    this.rawDiff = init.rawDiff ?? '';
    this.diffByFile = parseDiffByFile(this.rawDiff);
    this.changedFiles =
      init.changedFiles && init.changedFiles.length > 0
        ? [...init.changedFiles]
        : Array.from(this.diffByFile.keys());
  }

  get fileCount(): number {
    return this.sortedPaths.length;
  }

  findFiles(options: FindFilesOptions = {}): FindFilesResult {
    const matcher = createPathMatcher(options.pattern);
    const maxResults = clamp(
      options.maxResults ?? DEFAULT_MAX_FIND_FILES,
      1,
      MAX_FIND_FILES_LIMIT,
    );
    const matched = this.sortedPaths.filter(matcher);
    return {
      totalMatched: matched.length,
      truncated: matched.length > maxResults,
      files: matched.slice(0, maxResults),
    };
  }

  readFile(options: ReadFileOptions): ReadFileResult {
    const path = normalizeLookupPath(options.path);
    const lines = this.files.get(path);
    if (!lines) {
      return {
        path,
        exists: false,
        totalLines: 0,
        startLine: 0,
        endLine: 0,
        hasMore: false,
        content: '',
        error: `File not found in repository workspace: "${path}"`,
      };
    }
    return this.sliceFileLines(path, lines, options);
  }

  private sliceFileLines(
    path: string,
    lines: string[],
    options: ReadFileOptions,
  ): ReadFileResult {
    const totalLines = lines.length;
    if (totalLines === 0) {
      return {
        path,
        exists: true,
        totalLines: 0,
        startLine: 0,
        endLine: 0,
        hasMore: false,
        content: '',
      };
    }
    const startLine = clamp(options.startLine ?? 1, 1, totalLines);
    const requestedEnd = options.endLine ?? startLine + DEFAULT_READ_LINES - 1;
    const cappedEnd = Math.min(requestedEnd, startLine + MAX_READ_LINES - 1);
    const endLine = clamp(cappedEnd, startLine, totalLines);
    const formatted = lines
      .slice(startLine - 1, endLine)
      .map((line, idx) => `${startLine + idx} | ${line}`)
      .join('\n');

    return {
      path,
      exists: true,
      totalLines,
      startLine,
      endLine,
      hasMore: endLine < totalLines,
      content: formatted,
    };
  }

  grepCode(options: GrepCodeOptions): GrepCodeResult {
    if (!options.pattern) {
      return {
        totalMatches: 0,
        truncated: false,
        matches: [],
        error: 'Search pattern must not be empty.',
      };
    }
    const compiled = buildLineRegex(options);
    if ('error' in compiled) {
      return {
        totalMatches: 0,
        truncated: false,
        matches: [],
        error: compiled.error,
      };
    }
    return this.executeGrep(compiled, options);
  }

  private executeGrep(regex: RegExp, options: GrepCodeOptions): GrepCodeResult {
    const matcher = createPathMatcher(options.pathPattern);
    const contextLines = clamp(
      options.contextLines ?? DEFAULT_CONTEXT_LINES,
      0,
      MAX_CONTEXT_LINES,
    );
    const maxResults = clamp(
      options.maxResults ?? DEFAULT_MAX_GREP_RESULTS,
      1,
      MAX_GREP_RESULTS_LIMIT,
    );

    const matches: GrepMatch[] = [];
    let totalMatches = 0;

    for (const filePath of this.sortedPaths) {
      if (matcher(filePath)) {
        totalMatches += this.grepSingleFile(
          filePath,
          regex,
          contextLines,
          maxResults,
          matches,
        );
      }
    }

    return {
      totalMatches,
      truncated: totalMatches > maxResults,
      matches,
    };
  }

  private grepSingleFile(
    filePath: string,
    regex: RegExp,
    contextLines: number,
    maxResults: number,
    matches: GrepMatch[],
  ): number {
    const lines = this.files.get(filePath);
    if (!lines) {
      return 0;
    }
    return this.collectLineMatches(
      filePath,
      lines,
      regex,
      contextLines,
      maxResults,
      matches,
    );
  }

  private collectLineMatches(
    filePath: string,
    lines: string[],
    regex: RegExp,
    contextLines: number,
    maxResults: number,
    matches: GrepMatch[],
  ): number {
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        count += 1;
        this.appendMatchIfUnderCap(
          matches,
          maxResults,
          filePath,
          lines,
          i,
          contextLines,
        );
      }
    }
    return count;
  }

  private appendMatchIfUnderCap(
    matches: GrepMatch[],
    maxResults: number,
    filePath: string,
    lines: string[],
    lineIndex: number,
    contextLines: number,
  ): void {
    if (matches.length < maxResults) {
      matches.push({
        path: filePath,
        line: lineIndex + 1,
        snippet: formatSnippet(lines, lineIndex, contextLines),
      });
    }
  }

  getPrDiff(options: GetPrDiffOptions = {}): GetPrDiffResult {
    const maxChars = options.maxChars ?? DEFAULT_MAX_DIFF_CHARS;
    const requestedPath = this.normalizeOptionalPath(options.path);
    const sourceDiff = this.resolveDiffText(requestedPath);

    return {
      changedFiles: this.changedFiles,
      ...(requestedPath ? { path: requestedPath } : {}),
      truncated: sourceDiff.length > maxChars,
      diff: sourceDiff.slice(0, maxChars),
    };
  }

  private normalizeOptionalPath(path: string | undefined): string | undefined {
    return path ? normalizeLookupPath(path) : undefined;
  }

  private resolveDiffText(requestedPath: string | undefined): string {
    if (!requestedPath) {
      return this.rawDiff;
    }
    return this.diffByFile.get(requestedPath) ?? '';
  }
}
