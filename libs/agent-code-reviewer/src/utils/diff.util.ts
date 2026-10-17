/**
 * Shrinks a unified PR diff before it reaches any prompt.
 *
 * The diff is re-sent on every LLM turn of every reviewer agent, so its size
 * multiplies directly into token spend. Files nobody reviews by reading
 * (lockfiles, generated code, snapshots, binaries) are dropped, each remaining
 * file is capped, and the total is capped — the omitted files are listed in a
 * preamble so the reviewers know what they did not see.
 */

export const DEFAULT_MAX_DIFF_CHARS = 120_000;
export const DEFAULT_MAX_FILE_DIFF_CHARS = 20_000;
const MAX_LISTED_OMISSIONS = 50;

const IGNORED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/,
  /(^|\/)(Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|go\.sum|mix\.lock|pubspec\.lock|Podfile\.lock|packages\.lock\.json)$/,
  /\.lock$/,
  /\.(min\.js|min\.css|map|snap)$/,
  /\.(png|jpe?g|gif|ico|webp|bmp|pdf|woff2?|ttf|eot|otf|zip|gz|tar|jar|wasm)$/i,
  /\.(pb\.go|pb\.gw\.go)$/,
  /_pb2?(_grpc)?\.(py|pyi)$/,
  /(^|\/)(node_modules|vendor|dist|build|coverage|__generated__|generated)\//,
  /(^|\/)__snapshots__\//,
  /\/gen\/.*_pb\.ts$/,
];

const FILE_HEADER = /^diff --git /m;
const PATH_FROM_HEADER = /^diff --git a\/(.+?) b\/(.+)$/m;

export type DiffOmissionReason = 'ignored' | 'binary' | 'over_budget';

export interface PreparedDiff {
  diff: string;
  includedFiles: string[];
  omitted: Array<{ path: string; reason: DiffOmissionReason }>;
  originalChars: number;
}

export interface PrepareDiffOptions {
  maxChars?: number;
  maxFileChars?: number;
}

export function isIgnoredDiffPath(path: string): boolean {
  return IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function splitDiff(diff: string): { preamble: string; files: string[] } {
  const firstHeader = diff.search(FILE_HEADER);
  if (firstHeader === -1) return { preamble: diff, files: [] };

  const preamble = diff.slice(0, firstHeader);
  const files = diff
    .slice(firstHeader)
    .split(FILE_HEADER)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => `diff --git ${chunk}`);
  return { preamble, files };
}

function pathOf(fileDiff: string): string {
  const match = PATH_FROM_HEADER.exec(fileDiff);
  return match?.[2] ?? match?.[1] ?? '(unknown)';
}

function isBinary(fileDiff: string): boolean {
  return /^Binary files .* differ$/m.test(fileDiff.slice(0, 2_000));
}

export function prepareDiff(
  diff: string,
  options: PrepareDiffOptions = {},
): PreparedDiff {
  const maxChars = options.maxChars ?? DEFAULT_MAX_DIFF_CHARS;
  const maxFileChars = options.maxFileChars ?? DEFAULT_MAX_FILE_DIFF_CHARS;
  const { preamble, files } = splitDiff(diff);

  const kept: string[] = [];
  const includedFiles: string[] = [];
  const omitted: PreparedDiff['omitted'] = [];
  let used = preamble.length;

  for (const fileDiff of files) {
    const path = pathOf(fileDiff);
    if (isIgnoredDiffPath(path)) {
      omitted.push({ path, reason: 'ignored' });
      continue;
    }
    if (isBinary(fileDiff)) {
      omitted.push({ path, reason: 'binary' });
      continue;
    }

    const capped =
      fileDiff.length > maxFileChars
        ? `${fileDiff.slice(0, maxFileChars)}\n... [diff of ${path} truncated: ${fileDiff.length} chars]\n`
        : fileDiff;
    if (used + capped.length > maxChars) {
      omitted.push({ path, reason: 'over_budget' });
      continue;
    }

    kept.push(capped);
    includedFiles.push(path);
    used += capped.length;
  }

  const listed = omitted
    .slice(0, MAX_LISTED_OMISSIONS)
    .map((o) => `${o.path} (${o.reason})`);
  if (omitted.length > MAX_LISTED_OMISSIONS) {
    listed.push(`+${omitted.length - MAX_LISTED_OMISSIONS} more`);
  }
  const note =
    omitted.length > 0
      ? `# Files omitted from this diff (not reviewed): ${listed.join(', ')}\n`
      : '';

  return {
    diff: note + preamble + kept.join(''),
    includedFiles,
    omitted,
    originalChars: diff.length,
  };
}
