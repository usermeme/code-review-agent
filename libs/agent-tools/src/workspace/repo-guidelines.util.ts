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

function formatGuidelineSection(
  files: Map<string, string[]>,
  actualPath: string | undefined,
): string | null {
  if (!actualPath) {
    return null;
  }
  const lines = files.get(actualPath);
  const content = lines?.join('\n').trim();
  if (!content) {
    return null;
  }
  return `### ${actualPath}\n${content}`;
}

/**
 * Extracts repository coding guidelines (`AGENTS.md`, `CLAUDE.md`,
 * `.github/copilot-instructions.md`, `.cursorrules`) directly from the
 * in-memory workspace without any LLM or network calls.
 */
export function extractRepoGuidelines(
  files: Map<string, string[]>,
  maxChars = DEFAULT_MAX_GUIDELINE_CHARS,
): string {
  const pathLookup = buildLowercasePathMap(files);
  const sections: string[] = [];

  for (const candidate of GUIDELINE_CANDIDATE_PATHS) {
    const actualPath = pathLookup.get(candidate);
    const section = formatGuidelineSection(files, actualPath);
    if (section) {
      sections.push(section);
    }
  }

  const combined = sections.join('\n\n');
  return combined.length > maxChars ? combined.slice(0, maxChars) : combined;
}
