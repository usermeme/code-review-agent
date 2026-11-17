import type {
  ReviewRule,
  ReviewRuleSource,
} from '@code-review-agent/shared-types';

import type { LoadedContextSource } from './context-sources.js';
import { type ExtractedRule, MAX_CONTEXT_RULES } from './review-rule.schema.js';

const MAX_ID_CHARS = 60;

interface SourceInfo {
  source: LoadedContextSource;
  lineCount: number;
  /** `apps/core/**` for `apps/core/AGENTS.md`; null when unscoped. */
  scope: string | null;
}

/**
 * Rules from a nested guideline file only cover that file's folder. Root
 * guidelines, `.github/copilot-instructions.md` and skills are repo-wide.
 */
function guidelineScope(source: LoadedContextSource): string | null {
  if (source.kind !== 'guideline') return null;
  const folder = source.path.split('/').slice(0, -1).join('/');
  if (!folder || folder.toLowerCase() === '.github') return null;
  return `${folder}/**`;
}

function indexSources(sources: LoadedContextSource[]): Map<string, SourceInfo> {
  const byPath = new Map<string, SourceInfo>();
  for (const source of sources) {
    byPath.set(source.path.toLowerCase(), {
      source,
      lineCount: source.content.split('\n').length,
      scope: guidelineScope(source),
    });
  }
  return byPath;
}

function clampLine(line: number | undefined, max: number): number | undefined {
  if (line === undefined) return undefined;
  return Math.min(Math.max(1, line), max);
}

function lineRange(
  startLine: number | undefined,
  endLine: number | undefined,
): Omit<ReviewRuleSource, 'path'> {
  return {
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

function orderedLineRange(
  start: number | undefined,
  end: number | undefined,
): Omit<ReviewRuleSource, 'path'> {
  const reversed = start !== undefined && end !== undefined && start > end;
  return reversed ? lineRange(end, start) : lineRange(start, end);
}

function resolveSource(
  extracted: ExtractedRule['source'],
  info: SourceInfo,
): ReviewRuleSource {
  return {
    path: info.source.path,
    ...orderedLineRange(
      clampLine(extracted.startLine, info.lineCount),
      clampLine(extracted.endLine, info.lineCount),
    ),
  };
}

function normalizeGlob(glob: string): string {
  return glob
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '');
}

/**
 * Globs the model gave, normalized. A nested guideline's rule is always
 * kept inside its folder, whatever the model said.
 */
function resolveAppliesTo(globs: string[], scope: string | null): string[] {
  const normalized = [...new Set(globs.map(normalizeGlob).filter(Boolean))];
  if (!scope) return normalized;
  const folder = scope.slice(0, -'**'.length);
  const inside = normalized.filter((glob) => glob.startsWith(folder));
  return inside.length > 0 ? inside : [scope];
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_CHARS);
  return slug || 'rule';
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
  taken.add(id);
  return id;
}

function toReviewRule(
  extracted: ExtractedRule,
  info: SourceInfo,
  takenIds: Set<string>,
): ReviewRule {
  return {
    id: uniqueId(slugify(extracted.id), takenIds),
    rule: extracted.rule.trim(),
    appliesTo: resolveAppliesTo(extracted.appliesTo, info.scope),
    severity: extracted.severity,
    source: resolveSource(extracted.source, info),
  };
}

/**
 * Turns the model's rules into trusted ones: drops rules citing a file that
 * was not an input or with empty text, clamps line numbers to the file,
 * scopes nested guidelines to their folder and makes ids unique.
 */
export function validateRules(
  extracted: ExtractedRule[],
  sources: LoadedContextSource[],
): ReviewRule[] {
  const byPath = indexSources(sources);
  const takenIds = new Set<string>();
  const rules: ReviewRule[] = [];
  for (const candidate of extracted.slice(0, MAX_CONTEXT_RULES)) {
    const info = byPath.get(normalizeGlob(candidate.source.path).toLowerCase());
    if (info && candidate.rule.trim()) {
      rules.push(toReviewRule(candidate, info, takenIds));
    }
  }
  return rules;
}
