import type { RepoFile } from './file-walker.js';

export interface Chunk {
  label: string;
  files: RepoFile[];
  tokens: number;
}

export interface ChunkLimits {
  maxChunkTokens: number;
  maxChunks: number;
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
  options: ChunkLimits,
): { chunks: Chunk[]; overflow: string[] } {
  const topLevelTokens = new Map<string, number>();
  for (const file of files) {
    const topLevel = groupKey(file.path, 1);
    topLevelTokens.set(
      topLevel,
      (topLevelTokens.get(topLevel) ?? 0) + file.tokens,
    );
  }

  const groups = new Map<string, RepoFile[]>();
  for (const file of files) {
    const topLevel = groupKey(file.path, 1);
    const key =
      (topLevelTokens.get(topLevel) ?? 0) > options.maxChunkTokens
        ? groupKey(file.path, 2)
        : topLevel;
    const bucket = groups.get(key) ?? [];
    bucket.push(file);
    groups.set(key, bucket);
  }

  const chunks: Chunk[] = [];
  const overflow: string[] = [];
  let current: Chunk | null = null;

  for (const [label, groupFiles] of [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const file of groupFiles) {
      const fileTokens = Math.min(file.tokens, options.maxChunkTokens);
      if (
        chunks.length >= options.maxChunks &&
        (!current || current.tokens + fileTokens > options.maxChunkTokens)
      ) {
        overflow.push(file.path);
        continue;
      }
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
  const bodies = chunk.files
    .map((f) => `===== FILE: ${f.path} =====\n${f.content}`)
    .join('\n\n');
  return `File tree for this chunk:\n${tree}\n\n${bodies}`;
}
