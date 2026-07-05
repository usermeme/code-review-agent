import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { estimateTokens } from '../../common/utils/tokens.util.js';

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

function matchesExtraIgnore(relPath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    // Minimal glob support: '*' within a segment, '**' anywhere.
    const regex = new RegExp(
      '^' +
        pattern
          .split('**')
          .map((part) => part.split('*').map(escapeRegex).join('[^/]*'))
          .join('.*') +
        '$',
    );
    return regex.test(relPath);
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

export async function collectFiles(rootDir: string, extraIgnores: string[] = []): Promise<RepoFile[]> {
  const files: RepoFile[] = [];

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
      if (IGNORED_FILES.has(entry.name) || BINARY_EXTENSIONS.has(extension(entry.name))) continue;
      if (matchesExtraIgnore(rel, extraIgnores)) continue;
      const info = await stat(full);
      if (info.size > MAX_FILE_BYTES) continue;
      let content: string;
      try {
        content = await readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\u0000') || looksGenerated(content)) continue;
      const truncated = truncateLongFile(content);
      files.push({
        path: rel,
        content: truncated,
        tokens: estimateTokens(truncated),
      });
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
  const topLevelTokens = new Map<string, number>();
  for (const file of files) {
    const topLevel = groupKey(file.path, 1);
    topLevelTokens.set(topLevel, (topLevelTokens.get(topLevel) ?? 0) + file.tokens);
  }

  const groups = new Map<string, RepoFile[]>();
  for (const file of files) {
    const topLevel = groupKey(file.path, 1);
    const key = (topLevelTokens.get(topLevel) ?? 0) > options.maxChunkTokens ? groupKey(file.path, 2) : topLevel;
    const bucket = groups.get(key) ?? [];
    bucket.push(file);
    groups.set(key, bucket);
  }

  const chunks: Chunk[] = [];
  const overflow: string[] = [];
  let current: Chunk | null = null;

  for (const [label, groupFiles] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const file of groupFiles) {
      if (chunks.length >= options.maxChunks && (!current || current.tokens + file.tokens > options.maxChunkTokens)) {
        overflow.push(file.path);
        continue;
      }
      const fileTokens = Math.min(file.tokens, options.maxChunkTokens);
      if (!current || current.tokens + fileTokens > options.maxChunkTokens) {
        current = { label, files: [], tokens: 0 };
        chunks.push(current);
      }
      current.files.push(file);
      current.tokens += fileTokens;
    }
  }

  if (chunks.length > options.maxChunks) {
    for (const chunk of chunks.slice(options.maxChunks)) {
      overflow.push(...chunk.files.map((f) => f.path));
    }
    chunks.length = options.maxChunks;
  }

  return { chunks, overflow };
}

export function renderChunk(chunk: Chunk): string {
  const tree = chunk.files.map((f) => f.path).join('\n');
  const bodies = chunk.files.map((f) => `===== FILE: ${f.path} =====\n${f.content}`).join('\n\n');
  return `File tree for this chunk:\n${tree}\n\n${bodies}`;
}
