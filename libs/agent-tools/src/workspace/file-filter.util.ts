const IGNORED_DIRECTORY_SEGMENTS = new Set([
  '.git',
  '.nx',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
]);

const IGNORED_FILENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'composer.lock',
  'gemfile.lock',
]);

const IGNORED_SUFFIXES = [
  '.min.js',
  '.min.css',
  '.bundle.js',
  '.map',
  '.lock',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp3',
  '.mp4',
  '.mov',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.class',
  '.jar',
  '.pyc',
  '.sqlite',
  '.db',
];

/**
 * Strips the top-level archive folder (e.g. `owner-repo-sha/src/index.ts` -> `src/index.ts`)
 * and normalizes slashes. Returns empty string for root or invalid traversal paths.
 */
export function normalizeTarEntryPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex < 0) {
    return '';
  }
  const relative = normalized.slice(slashIndex + 1).replace(/\/+$/, '');
  if (!relative || relative.split('/').includes('..')) {
    return '';
  }
  return relative;
}

function hasIgnoredSegment(segments: string[]): boolean {
  return segments.some((segment) =>
    IGNORED_DIRECTORY_SEGMENTS.has(segment.toLowerCase()),
  );
}

function hasIgnoredSuffix(lowerFilename: string): boolean {
  return IGNORED_SUFFIXES.some((suffix) => lowerFilename.endsWith(suffix));
}

/**
 * Returns true when a normalized repository-relative file path should be indexed
 * for code search and reading.
 */
export function isIndexableFilePath(relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }
  const segments = relativePath.split('/');
  if (hasIgnoredSegment(segments)) {
    return false;
  }
  const lowerFilename = (segments[segments.length - 1] ?? '').toLowerCase();
  if (IGNORED_FILENAMES.has(lowerFilename)) {
    return false;
  }
  return !hasIgnoredSuffix(lowerFilename);
}

/**
 * Detects binary content by checking for a NUL byte within the first 8 KB.
 */
export function isBinaryBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8192);
  return buffer.subarray(0, sampleLength).includes(0);
}

function escapeRegexChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function globTokenToRegex(token: string): string {
  if (token === '**/') return '(?:.+/)?';
  if (token === '**') return '.*';
  if (token === '*') return '[^/]*';
  if (token === '?') return '[^/]';
  return escapeRegexChar(token);
}

function isWildcardPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

function buildGlobRegex(pattern: string): RegExp {
  const tokens = pattern.match(/\*\*\/|\*\*|\*|\?|./g) ?? [];
  const regexBody = tokens.map(globTokenToRegex).join('');
  return new RegExp(`^${regexBody}$`, 'i');
}

/**
 * Converts a glob pattern (e.g. `**\/*.service.ts` or `src/**`) or plain path
 * substring into a case-insensitive matcher function.
 */
export function createPathMatcher(
  pattern: string | undefined,
): (filePath: string) => boolean {
  const trimmed = pattern?.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!trimmed) {
    return () => true;
  }
  if (!isWildcardPattern(trimmed)) {
    const lower = trimmed.toLowerCase();
    return (filePath: string) => filePath.toLowerCase().includes(lower);
  }
  const regex = buildGlobRegex(trimmed);
  return (filePath: string) => regex.test(filePath);
}
