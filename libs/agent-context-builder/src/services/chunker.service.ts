import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { estimateTokens } from './tokens.util.js';

export interface RepoFile {
  path: string;
  content: string;
  tokens: number;
}

export interface Chunk {
  label: string;
  files: RepoFile[];
  tokens: number;
}

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.venv',
  '__pycache__',
  'target',
]);

const IGNORED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
]);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.mp3',
  '.wasm',
  '.jar',
  '.class',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.bin',
  '.db',
  '.sqlite',
  '.parquet',
]);

const MAX_FILE_BYTES = 400_000;
const TRUNCATE_HEAD_LINES = 400;
const TRUNCATE_TAIL_LINES = 100;

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

function compileIgnorePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    // Minimal glob support: '*' within a segment, '**' anywhere.
    const regexString =
      '^' +
      pattern
        .split('**')
        .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
        .join('.*') +
      '$';
    return new RegExp(regexString);
  });
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksGenerated(content: string): boolean {
  // Minified or generated single-line blobs add noise, not signal.
  return content.split('\n', 10).some((line) => line.length > 5000);
}

function truncateLongFile(content: string): string {
  const lines = content.split('\n');
  if (lines.length <= TRUNCATE_HEAD_LINES + TRUNCATE_TAIL_LINES) return content;
  return [
    ...lines.slice(0, TRUNCATE_HEAD_LINES),
    `... [${lines.length - TRUNCATE_HEAD_LINES - TRUNCATE_TAIL_LINES} lines truncated] ...`,
    ...lines.slice(-TRUNCATE_TAIL_LINES),
  ].join('\n');
}

/**
 * True when a repo-relative path matches the ignore lists (lockfiles,
 * binaries, generated dirs). Shared by the baseline tree walk and the
 * incremental changed-file path so both modes filter identically.
 */
export function isIgnoredPath(relPath: string): boolean {
  const segments = relPath.split('/');
  const base = segments[segments.length - 1];
  if (IGNORED_FILES.has(base)) return true;
  if (BINARY_EXTENSIONS.has(extension(base))) return true;
  return segments.slice(0, -1).some((dir) => IGNORED_DIRS.has(dir));
}

/**
 * Applies the content-level filters (size cap, binary NUL check, generated
 * blob detection, long-file truncation). Returns the sanitized content, or
 * null when the file should be skipped entirely.
 */
export function acceptFileContent(content: string): string | null {
  if (content.length > MAX_FILE_BYTES) return null;
  if (content.includes('\u0000') || looksGenerated(content)) return null;
  return truncateLongFile(content);
}

/**
 * True when a repo-relative path is filtered out: either by the shared
 * ignore lists or by the caller's extra glob patterns.
 */
function shouldSkipPath(rel: string, extraIgnoreRegexes: RegExp[]): boolean {
  return (
    isIgnoredPath(rel) || extraIgnoreRegexes.some((regex) => regex.test(rel))
  );
}

/**
 * Stat/size/read checks for a single file, followed by the shared
 * content-level filters. Returns the accepted content, or null to skip.
 */
async function readAcceptedContent(full: string): Promise<string | null> {
  const info = await stat(full);
  if (info.size > MAX_FILE_BYTES) return null;
  let content: string;
  try {
    content = await readFile(full, 'utf8');
  } catch {
    return null;
  }
  return acceptFileContent(content);
}

/** Reads one non-directory entry and appends it to `files` unless filtered out. */
async function collectFileEntry(
  full: string,
  rel: string,
  extraIgnoreRegexes: RegExp[],
  files: RepoFile[],
): Promise<void> {
  if (shouldSkipPath(rel, extraIgnoreRegexes)) return;
  const accepted = await readAcceptedContent(full);
  if (accepted === null) return;
  files.push({
    path: rel,
    content: accepted,
    tokens: estimateTokens(accepted),
  });
}

export async function collectFiles(
  rootDir: string,
  extraIgnores: string[] = [],
): Promise<RepoFile[]> {
  const files: RepoFile[] = [];
  const extraIgnoreRegexes = compileIgnorePatterns(extraIgnores);

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(rootDir, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      await collectFileEntry(full, rel, extraIgnoreRegexes, files);
    }
  }

  await walk(rootDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function groupKey(path: string, depth: number): string {
  const segments = path.split('/');
  if (segments.length === 1) return '(root)';
  return segments.slice(0, Math.min(depth, segments.length - 1)).join('/');
}

/** Total tokens per top-level directory group. */
function computeTopLevelTokens(files: RepoFile[]): Map<string, number> {
  const topLevelTokens = new Map<string, number>();
  for (const file of files) {
    const topLevel = groupKey(file.path, 1);
    topLevelTokens.set(
      topLevel,
      (topLevelTokens.get(topLevel) ?? 0) + file.tokens,
    );
  }
  return topLevelTokens;
}

/** Group key for one file: its top-level dir, or one level deeper for oversized groups. */
function resolveGroupKey(
  file: RepoFile,
  topLevelTokens: Map<string, number>,
  maxChunkTokens: number,
): string {
  const topLevel = groupKey(file.path, 1);
  return (topLevelTokens.get(topLevel) ?? 0) > maxChunkTokens
    ? groupKey(file.path, 2)
    : topLevel;
}

function groupFilesByDirectory(
  files: RepoFile[],
  maxChunkTokens: number,
): Map<string, RepoFile[]> {
  const topLevelTokens = computeTopLevelTokens(files);

  const groups = new Map<string, RepoFile[]>();
  for (const file of files) {
    const key = resolveGroupKey(file, topLevelTokens, maxChunkTokens);
    const bucket = groups.get(key) ?? [];
    bucket.push(file);
    groups.set(key, bucket);
  }
  return groups;
}

function sortedGroupEntries(
  groups: Map<string, RepoFile[]>,
): Array<[string, RepoFile[]]> {
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Mutable packing state shared across the greedy packing loop. */
interface ChunkPacking {
  chunks: Chunk[];
  overflow: string[];
  current: Chunk | null;
}

/** True when the open chunk exists and still has room for `fileTokens`. */
function canExtendChunk(
  current: Chunk | null,
  fileTokens: number,
  maxChunkTokens: number,
): current is Chunk {
  return current !== null && current.tokens + fileTokens <= maxChunkTokens;
}

/** Greedily packs one file into the open chunk, a new chunk, or the overflow list. */
function packFile(
  packing: ChunkPacking,
  label: string,
  file: RepoFile,
  options: { maxChunkTokens: number; maxChunks: number },
): void {
  const fileTokens = Math.min(file.tokens, options.maxChunkTokens);
  const current = packing.current;
  if (
    packing.chunks.length >= options.maxChunks &&
    !canExtendChunk(current, fileTokens, options.maxChunkTokens)
  ) {
    packing.overflow.push(file.path);
    return;
  }
  if (canExtendChunk(current, fileTokens, options.maxChunkTokens)) {
    current.files.push(file);
    current.tokens += fileTokens;
    return;
  }
  const created: Chunk = { label, files: [], tokens: 0 };
  packing.current = created;
  packing.chunks.push(created);
  created.files.push(file);
  created.tokens += fileTokens;
}

/** Trims chunks past maxChunks, moving their files to the overflow list. */
function capPackedChunks(packing: ChunkPacking, maxChunks: number): void {
  if (packing.chunks.length > maxChunks) {
    for (const chunk of packing.chunks.slice(maxChunks)) {
      packing.overflow.push(...chunk.files.map((f) => f.path));
    }
    packing.chunks.length = maxChunks;
  }
}

/**
 * Greedy directory-based packing: files grouped by top-level directory, groups
 * larger than the budget re-grouped one level deeper, then packed into chunks
 * of at most maxChunkTokens. Returns at most maxChunks chunks plus the list of
 * files that only made it as tree entries (overflow).
 */
export function buildChunks(
  files: RepoFile[],
  options: { maxChunkTokens: number; maxChunks: number },
): { chunks: Chunk[]; overflow: string[] } {
  const groups = groupFilesByDirectory(files, options.maxChunkTokens);
  const packing: ChunkPacking = { chunks: [], overflow: [], current: null };

  for (const [label, groupFiles] of sortedGroupEntries(groups)) {
    for (const file of groupFiles) {
      packFile(packing, label, file, options);
    }
  }

  capPackedChunks(packing, options.maxChunks);

  return { chunks: packing.chunks, overflow: packing.overflow };
}

export function renderChunk(chunk: Chunk): string {
  const tree = chunk.files.map((f) => f.path).join('\n');
  const bodies = chunk.files
    .map((f) => `===== FILE: ${f.path} =====\n${f.content}`)
    .join('\n\n');
  return `File tree for this chunk:\n${tree}\n\n${bodies}`;
}
