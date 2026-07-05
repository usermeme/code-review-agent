import type { Octokit } from 'octokit';
import type { Finding, ReviewPlan } from '../agents/schemas.js';
import type { PrFile } from './pr.js';
import { logger } from '../util/logger.js';

interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: 'RIGHT';
  start_side?: 'RIGHT';
  body: string;
}

/**
 * Returns the set of new-file-side line numbers that GitHub accepts as review
 * comment anchors for a file patch (i.e. lines appearing in a diff hunk).
 */
export function anchorableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (row.startsWith('+') || row.startsWith(' ')) {
      lines.add(newLine);
      newLine++;
    }
    // '-' lines belong to the old side only; the counter does not advance.
  }
  return lines;
}

export interface SplitFindings {
  comments: ReviewComment[];
  unanchored: Finding[];
}

export function splitFindings(findings: Finding[], files: PrFile[]): SplitFindings {
  const anchors = new Map<string, Set<number>>();
  for (const file of files) {
    if (file.patch) anchors.set(file.filename, anchorableLines(file.patch));
  }

  const comments: ReviewComment[] = [];
  const unanchored: Finding[] = [];
  for (const finding of findings) {
    const valid = anchors.get(finding.path);
    const body = renderFindingBody(finding);
    if (valid?.has(finding.endLine)) {
      // GitHub 422s the whole review if any line of a multi-line range falls
      // outside a hunk, so the entire range must be anchorable — otherwise
      // fall back to a single-line comment on the last line.
      const multiLine =
        finding.startLine < finding.endLine && rangeAnchorable(valid, finding.startLine, finding.endLine);
      comments.push({
        path: finding.path,
        line: finding.endLine,
        side: 'RIGHT',
        ...(multiLine ? { start_line: finding.startLine, start_side: 'RIGHT' as const } : {}),
        body,
      });
    } else {
      unanchored.push(finding);
    }
  }
  return { comments, unanchored };
}

function rangeAnchorable(valid: Set<number>, start: number, end: number): boolean {
  if (end - start > 10_000) return false; // pathological model output; don't loop over it
  for (let line = start; line <= end; line++) {
    if (!valid.has(line)) return false;
  }
  return true;
}

function renderFindingBody(finding: Finding): string {
  const parts = [`**[${finding.severity}] ${finding.title}**`, '', finding.body];
  if (finding.suggestion) {
    parts.push('', '```suggestion', finding.suggestion, '```');
  }
  return parts.join('\n');
}

export function renderSummary(plan: ReviewPlan, unanchored: Finding[], contextNote?: string): string {
  const sections = [plan.summary];

  if (plan.ticketCoverage) {
    sections.push('### Ticket coverage', plan.ticketCoverage);
  }

  const bySeverity = new Map<string, number>();
  for (const f of plan.findings) {
    bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
  }
  if (bySeverity.size > 0) {
    const counts = [...bySeverity.entries()].map(([sev, n]) => `${n} ${sev}`).join(', ');
    sections.push(`**Findings:** ${counts}`);
  }

  if (unanchored.length > 0) {
    sections.push(
      '### Additional notes',
      ...unanchored.map((f) => `- **[${f.severity}] ${f.title}** (\`${f.path}\`): ${f.body}`),
    );
  }

  if (contextNote) sections.push(`---\n_${contextNote}_`);
  return sections.join('\n\n');
}

export async function publishReview(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  plan: ReviewPlan;
  files: PrFile[];
  contextNote?: string;
}): Promise<void> {
  const { octokit, owner, repo, prNumber, headSha, plan, files, contextNote } = params;
  const { comments, unanchored } = splitFindings(plan.findings, files);

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: 'COMMENT',
      body: renderSummary(plan, unanchored, contextNote),
      comments,
    });
  } catch (error) {
    // GitHub rejects the entire review when any single inline comment anchor
    // is off (422). Losing the whole review over one bad anchor is worse than
    // losing the anchors: retry once with every finding in the summary body.
    if ((error as { status?: number }).status !== 422 || comments.length === 0) throw error;
    logger.warn(
      { repo: `${owner}/${repo}`, pr: prNumber, err: error },
      'inline comments rejected; republishing with all findings in the summary',
    );
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: 'COMMENT',
      body: renderSummary(plan, plan.findings, contextNote),
    });
  }
  logger.info(
    {
      repo: `${owner}/${repo}`,
      pr: prNumber,
      inline: comments.length,
      unanchored: unanchored.length,
    },
    'published review',
  );
}
