import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../../core/logger/logger.service.js';

/**
 * The review philosophy injected into the reviewer agents' prompts.
 *
 * Source of truth is the `code-review` skill in the usermeme/skills repo
 * (SKILL.md + references/security.md), loaded from `skills.codeReviewDir` so
 * editing the skill updates both interactive reviews and this bot. The
 * embedded snapshot below keeps deployments working when the skills repo
 * isn't mounted — it is a condensed copy, refreshed manually when the skill
 * changes materially.
 */
export interface ReviewSkill {
  core: string;
  security: string;
}

const FALLBACK_CORE = `# Code Review

A review has two jobs, in priority order: catch what would hurt in production (bugs, data loss,
security, broken contracts), and protect the codebase's long-term shape (conventions, patterns,
maintainability). Style opinions and cleverness are noise that dilutes those signals.

## Verify before asserting — the cardinal rule
A plausible-but-wrong finding costs more than a missed one. Before any claim: read beyond the
diff (the surrounding function, callers, types — most false positives come from reviewing hunks
in isolation), and construct the concrete failure scenario — the inputs or state that produce the
wrong outcome. If you cannot construct the scenario, you have a suspicion, not a finding —
phrase it as a question.

## Severity — rank honestly, don't cry wolf
- critical: data loss/corruption, security vulnerability, broken money paths, crash on a common path.
- major: incorrect behavior users will hit, missing error handling on likely failures, realistic races, broken API contracts.
- minor: real defect with limited blast radius, convention violation, maintainability smell.
Inflating severity works exactly once.

## What's worth a comment
Raise: bugs and edge cases with their failure scenario; missing/swallowed error handling on paths
that realistically fail; security issues; reinvention — a new pattern/utility where the codebase
already has one (cite the existing one by path); contract drift vs the ticket/description; missing
or assertion-free tests.
Let go: style a formatter should own; subjective preference where the project has no convention;
hypotheticals with no realistic trigger; pre-existing issues unrelated to the diff.
A ten-comment review where three matter teaches authors to skim.

## Writing the finding
Anchor to exact file and line; one finding per comment. Structure: what's wrong → concrete
failure scenario → suggested fix. When uncertain, ask the specific question instead of asserting.
The summary leads with the verdict and the criticals — never bury a data-loss finding under nits.`;

const FALLBACK_SECURITY = `# Security checklist (construct the attack input, don't eyeball)
- Injection: every SQL value parameterized (including ORDER BY/identifiers built from config);
  no user input in shell strings (execFile + args, no shell:true); path traversal on any joined
  path (normalize + prefix check); no user content in eval/Function/dynamic import.
- AuthN/AuthZ: every new endpoint — who can call it? Object fetched by user-supplied id — is
  ownership/tenancy checked (IDOR)? Authorization on the action, not just the route. Webhooks:
  signature verified over raw bytes, constant-time compare, reject on absence.
- Secrets & data: no credentials in code/config/git; no tokens, PII, or full bodies in logs
  (including error paths and clone URLs); no stack traces to clients.
- Requests & resources: user-influenced URLs fetched server-side (SSRF — allowlist hosts);
  request sizes limited; regex on user input safe from catastrophic backtracking; redirects
  allowlisted; rate limits/idempotency on endpoints triggering paid or expensive work.
- Concurrency: check-then-act across async boundaries without a transaction or atomic op (TOCTOU);
  locks released on error paths.
- Crypto & deps: no hand-rolled crypto, no Math.random() for tokens; new dependencies maintained
  and pinned.`;

const cache = new Map<string, ReviewSkill>();

const FRONTMATTER_REGEX = /^---\n[\s\S]*?\n---\n/;

/** Removes the YAML frontmatter block — trigger metadata, not prompt material. */
export function stripFrontmatter(markdown: string): string {
  const match = FRONTMATTER_REGEX.exec(markdown);
  return (match ? markdown.slice(match[0].length) : markdown).trim();
}

export function loadReviewSkill(dir: string): ReviewSkill {
  const cached = cache.get(dir);
  if (cached) return cached;

  let core = FALLBACK_CORE;
  let security = FALLBACK_SECURITY;
  if (dir) {
    try {
      core = stripFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
      logger.info({ dir }, 'loaded code-review skill');
    } catch (error) {
      logger.warn(
        { dir, err: error },
        'code-review skill dir not readable; using embedded snapshot',
      );
    }
    try {
      security = stripFrontmatter(
        readFileSync(join(dir, 'references', 'security.md'), 'utf8'),
      );
    } catch {
      // SKILL.md warning above already signals discovery problems; keep the snapshot.
    }
  }

  const skill: ReviewSkill = { core, security };
  cache.set(dir, skill);
  return skill;
}
