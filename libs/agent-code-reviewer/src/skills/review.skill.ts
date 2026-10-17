/**
 * The review philosophy injected into the reviewer agents' prompts.
 *
 * Embedded as plain prompt constants on purpose: the bot must not depend on
 * filesystem-mounted skill directories at runtime (deployments are
 * container-first, and file-based loading added a silent fallback path and a
 * cache that could serve stale content). The text is kept in sync with the
 * `code-review` skill in the usermeme/skills repo when it changes
 * materially — edit it here, in the prompt, and nowhere else.
 */
export interface ReviewSkill {
  core: string;
  security: string;
}

const CORE = `# Code Review

A review has two jobs, in priority order: catch what would hurt in production (bugs, data loss,
security, broken contracts), and protect the codebase's long-term shape (conventions, patterns,
maintainability). Style opinions and cleverness are noise that dilute those signals.

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

const SECURITY = `# Security checklist (construct the attack input, don't eyeball)
- Injection: every SQL value parameterized (including ORDER BY/identifiers built from config);
  no user input in shell strings (execFile + args, no shell:true); path traversal on any joined
  path (normalize + prefix check); no user content in eval/Function/dynamic import.
- AuthN/AuthZ: every new endpoint — who can call it? Object fetched by user-supplied id — is
  ownership/tenancy checked (IDOR)? Authorization on the action, not the route. Webhooks:
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

/** The single source of review-philosophy prompt text used by all agents. */
export const REVIEW_SKILL: ReviewSkill = { core: CORE, security: SECURITY };
