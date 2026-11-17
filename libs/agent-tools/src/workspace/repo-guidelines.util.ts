const GUIDELINE_CANDIDATE_PATHS = [
  'agents.md',
  'claude.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
];

const DEFAULT_MAX_GUIDELINE_CHARS = 12_000;

function buildLowercasePathMap(
  files: Map<string, string[]>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const key of files.keys()) {
    map.set(key.toLowerCase(), key);
  }
  return map;
}

function readGuideline(
  files: Map<string, string[]>,
  actualPath: string | undefined,
): string | null {
  if (!actualPath) {
    return null;
  }
  const content = files.get(actualPath)?.join('\n').trim();
  return content || null;
}

/** One `### path` section per guideline file, skipping repeated content. */
function collectUniqueSections(files: Map<string, string[]>): string[] {
  const pathLookup = buildLowercasePathMap(files);
  const sections: string[] = [];
  const seenContents = new Set<string>();
  for (const candidate of GUIDELINE_CANDIDATE_PATHS) {
    const actualPath = pathLookup.get(candidate);
    const content = readGuideline(files, actualPath);
    if (content && !seenContents.has(content)) {
      seenContents.add(content);
      sections.push(`### ${actualPath}\n${content}`);
    }
  }
  return sections;
}

/**
 * Extracts repository coding guidelines (`AGENTS.md`, `CLAUDE.md`,
 * `.github/copilot-instructions.md`, `.cursorrules`) directly from the
 * in-memory workspace without any LLM or network calls. A file whose
 * content repeats an earlier one (e.g. `CLAUDE.md` kept as a copy of
 * `AGENTS.md`) is included once.
 */
export function extractRepoGuidelines(
  files: Map<string, string[]>,
  maxChars = DEFAULT_MAX_GUIDELINE_CHARS,
): string {
  const combined = collectUniqueSections(files).join('\n\n');
  return combined.length > maxChars ? combined.slice(0, maxChars) : combined;
}
