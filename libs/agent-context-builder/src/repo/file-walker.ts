import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { estimateTokens } from '@code-review-agent/llm';

export interface RepoFile {
  path: string;
  content: string;
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
 * Walks an extracted checkout and returns its readable text files, sorted by
 * path. Symlinks are skipped (Dirent.isFile() is false for them), so a link in
 * untrusted repo content can't pull host files into the prompt.
 */
export async function collectFiles(rootDir: string): Promise<RepoFile[]> {
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
      if (
        IGNORED_FILES.has(entry.name) ||
        BINARY_EXTENSIONS.has(extension(entry.name))
      )
        continue;
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
