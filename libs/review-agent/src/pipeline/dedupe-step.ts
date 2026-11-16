import {
  decide,
  type DecisionAnswers,
  type DecisionModel,
  type DecisionQuestion,
  emptyTokenUsage,
} from '@code-review-agent/llm';
import type { ReviewThread, TokenUsage } from '@code-review-agent/shared-types';

import type { AnchoredFinding } from '../tools/submit-review.tool.js';
import { firstLine, threadStatus, truncate } from './thread-format.js';

/** A thread this many lines from a finding counts as "nearby". */
const LINE_WINDOW = 15;
const MAX_DEDUPE_TIMEOUT_MS = 30_000;
const MIN_DEDUPE_TIMEOUT_MS = 5_000;
const NO_MATCH = 'none';
/** A finding is dropped only when the model is at least this sure of a match. */
const MIN_MATCH_CONFIDENCE = 0.6;

const DEDUPE_CONTEXT = `You compare new code review findings with existing review threads on the same Pull Request. Threads may come from this reviewer, other review bots, or people.

Same issue means the same defect at the same place, even if worded differently. A different problem on nearby lines is not the same issue.`;

const NO_MATCH_CRITERION =
  'None of these threads raises the same underlying issue as the finding.';

export interface DedupeInput {
  findings: AnchoredFinding[];
  threads: ReviewThread[];
  model: DecisionModel;
  remainingMs: number;
}

export interface DedupeResult {
  findings: AnchoredFinding[];
  /** Earlier discussion to show the verifier, per kept finding. */
  context: Map<AnchoredFinding, string>;
  note: string;
  usage: TokenUsage;
}

interface Candidate {
  item: AnchoredFinding;
  findingId: number;
  threads: Array<{ key: string; thread: ReviewThread }>;
}

function isNearby(item: AnchoredFinding, thread: ReviewThread): boolean {
  if (thread.path !== item.finding.path) return false;
  return (
    thread.line === null ||
    Math.abs(thread.line - item.anchor.line) <= LINE_WINDOW
  );
}

function collectCandidates(input: DedupeInput): Candidate[] {
  const keys = new Map(input.threads.map((t, i) => [t, `T${i + 1}`]));
  return input.findings
    .map((item, findingId) => ({
      item,
      findingId,
      threads: input.threads
        .filter((thread) => isNearby(item, thread))
        .map((thread) => ({ key: keys.get(thread) ?? '', thread })),
    }))
    .filter((candidate) => candidate.threads.length > 0);
}

function lastReply(thread: ReviewThread): string {
  const reply = thread.comments.length > 1 ? thread.comments.at(-1) : undefined;
  return reply
    ? `\n    Latest reply by ${reply.author}: ${truncate(reply.body, 200)}`
    : '';
}

function formatThread(thread: ReviewThread): string {
  const opener = thread.comments[0];
  const line = thread.line === null ? 'line unknown' : `line ${thread.line}`;
  const text = opener ? truncate(opener.body, 300) : '';
  return `Existing thread (${threadStatus(thread)}, ${line}): ${text}${lastReply(thread)}`;
}

function questionId(candidate: Candidate): string {
  return `finding_${candidate.findingId}`;
}

/** One choice per finding: the nearby thread raising the same issue, or none. */
function matchQuestion(candidate: Candidate): DecisionQuestion {
  const { finding, anchor } = candidate.item;
  return {
    type: 'choice',
    instructions: `New finding: [${finding.severity.toUpperCase()}] ${finding.title} at ${finding.path}:${anchor.line}
${truncate(finding.comment, 300)}

Which existing thread raises the same underlying issue as this finding?`,
    criteria: {
      ...Object.fromEntries(
        candidate.threads.map(({ key, thread }) => [key, formatThread(thread)]),
      ),
      [NO_MATCH]: NO_MATCH_CRITERION,
    },
  };
}

/** Thread ids the model matched with enough confidence, per finding. */
function confidentMatches(
  candidates: Candidate[],
  answers: DecisionAnswers,
): Array<{ findingId: number; threadId: string }> {
  return candidates.flatMap((candidate) => {
    const answer = answers.choice(questionId(candidate));
    const matched =
      answer.choice !== NO_MATCH && answer.confidence >= MIN_MATCH_CONFIDENCE;
    return matched
      ? [{ findingId: candidate.findingId, threadId: answer.choice }]
      : [];
  });
}

function resolvedContext(thread: ReviewThread): string {
  const opener = thread.comments[0];
  const raised = opener
    ? `"${firstLine(opener.body, 160)}"`
    : 'a similar issue';
  return `Earlier thread ${raised} was resolved, and the code there has changed since.${lastReply(thread)}`;
}

/** Drops a matched finding unless its thread was resolved before the code changed. */
function applyMatch(
  thread: ReviewThread | undefined,
  item: AnchoredFinding,
  context: Map<AnchoredFinding, string>,
): boolean {
  if (!thread) return true;
  if (thread.isResolved && thread.isOutdated) {
    context.set(item, resolvedContext(thread));
    return true;
  }
  return false;
}

function applyMatches(
  input: DedupeInput,
  candidates: Candidate[],
  matches: Array<{ findingId: number; threadId: string }>,
): Pick<DedupeResult, 'findings' | 'context'> {
  const byFinding = new Map(matches.map((m) => [m.findingId, m.threadId]));
  const context = new Map<AnchoredFinding, string>();
  const matchedThread = (candidate: Candidate) =>
    candidate.threads.find((t) => t.key === byFinding.get(candidate.findingId))
      ?.thread;
  const checked = new Map(candidates.map((c) => [c.item, matchedThread(c)]));
  const findings = input.findings.filter((item) =>
    applyMatch(checked.get(item), item, context),
  );
  return { findings, context };
}

function unchanged(
  input: DedupeInput,
  usage = emptyTokenUsage(),
): DedupeResult {
  return { findings: input.findings, context: new Map(), note: '', usage };
}

function dedupeTimeout(remainingMs: number): number {
  return Math.min(MAX_DEDUPE_TIMEOUT_MS, Math.floor(remainingMs / 4));
}

/**
 * Drops new findings that repeat an existing review thread (any author).
 * Findings that match a thread resolved before the code changed are kept,
 * with the earlier discussion attached for the verifier. Fails open.
 */
export async function dedupeAgainstThreads(
  input: DedupeInput,
): Promise<DedupeResult> {
  const candidates = collectCandidates(input);
  const timeoutMs = dedupeTimeout(input.remainingMs);
  if (candidates.length === 0 || timeoutMs < MIN_DEDUPE_TIMEOUT_MS) {
    return unchanged(input);
  }
  const result = await decide(input.model, {
    input: DEDUPE_CONTEXT,
    questions: Object.fromEntries(
      candidates.map((candidate) => [
        questionId(candidate),
        matchQuestion(candidate),
      ]),
    ),
    timeoutMs,
  });
  if (!result.ok) return unchanged(input, result.usage);

  const applied = applyMatches(
    input,
    candidates,
    confidentMatches(candidates, result.answers),
  );
  const dropped = input.findings.length - applied.findings.length;
  const note =
    dropped > 0
      ? `Skipped ${dropped} finding(s) already raised in existing review threads.`
      : '';
  return { ...applied, note, usage: result.usage };
}
