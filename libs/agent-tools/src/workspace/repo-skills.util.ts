const SKILL_FILENAME = 'skill.md';

const DEFAULT_MAX_LISTED_SKILLS = 50;

interface SkillEntry {
  name: string;
  path: string;
}

function toSkillEntry(path: string): SkillEntry | null {
  const segments = path.split('/');
  const filename = segments[segments.length - 1] ?? '';
  if (filename.toLowerCase() !== SKILL_FILENAME || segments.length < 2) {
    return null;
  }
  return { name: segments[segments.length - 2], path };
}

/**
 * Finds `<skill-name>/SKILL.md` files, sorted by path. Skills mirrored for
 * several agents (e.g. `.agents/skills/x` and `.opencode/skills/x`) are listed
 * once, under the first path.
 */
export function findRepoSkills(files: Map<string, string[]>): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  const sortedPaths = [...files.keys()].sort();
  const entries = sortedPaths
    .map(toSkillEntry)
    .filter((entry): entry is SkillEntry => entry !== null);
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, entry);
    }
  }
  return [...byName.values()];
}

function formatSkillList(skills: SkillEntry[], maxSkills: number): string {
  const listed = skills
    .slice(0, maxSkills)
    .map((skill) => `- \`${skill.name}\`: \`${skill.path}\``);
  const hidden = skills.length - listed.length;
  if (hidden > 0) {
    listed.push(
      `- …and ${hidden} more (\`find_files({ pattern: "**/SKILL.md" })\`)`,
    );
  }
  return listed.join('\n');
}

/**
 * Lists the repository's agent skills by name and path only, without their
 * contents, plus instructions for loading one on demand: the reviewer greps a
 * skill's `description:` line first and reads the body only when it applies.
 * Returns an empty string when the repository defines no skills.
 */
export function extractRepoSkillsIndex(
  files: Map<string, string[]>,
  maxSkills = DEFAULT_MAX_LISTED_SKILLS,
): string {
  const skills = findRepoSkills(files);
  if (skills.length === 0) {
    return '';
  }
  return `The repository defines these agent skills (name: path). Their contents are NOT loaded. Use a skill only when its name suggests it covers the code under review:
1. Read its description first: \`grep_code({ pattern: "^description:", isRegex: true, pathPattern: "<path>", contextLines: 2 })\`.
2. Only if the description shows it applies to this change, read its body with \`read_file({ path: "<path>" })\` and apply it like the repository guidelines.
Skip this step entirely when no skill name relates to the change.

${formatSkillList(skills, maxSkills)}`;
}
