import { parseDiffByFile } from '@code-review-agent/agent-tools';
import type {
  JudgeCodeExcerpt,
  JudgeComment,
  JudgeFileChanges,
  JudgeThread,
} from '@code-review-agent/review-agent';
import type {
  CompareDiffResult,
  GitAdapterContract,
  PRMeta,
  ReviewThread,
} from '@code-review-agent/shared-types';

const MAX_FILE_DIFF_CHARS = 8_000;
/** Lines of current code shown before and after the commented line. */
const EXCERPT_RADIUS = 40;

type CompareOutcome =
  { ok: true; compare: CompareDiffResult } | { ok: false; reason: string };

interface Evidence {
  compares: Map<string, CompareOutcome>;
  contents: Map<string, string | null>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commentSha(thread: ReviewThread): string | undefined {
  return thread.comments[0]?.originalCommitSha;
}

function uniqueValues(values: (string | undefined)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

/**
 * One compare per distinct comment commit: a review's comments usually
 * share one. A failed compare (e.g. the commit was force-pushed away) only
 * weakens that thread's evidence.
 */
async function loadCompares(
  git: GitAdapterContract,
  meta: PRMeta,
  headSha: string,
  threads: ReviewThread[],
): Promise<Map<string, CompareOutcome>> {
  const shas = uniqueValues(threads.map(commentSha));
  const outcomes = await Promise.all(
    shas.map(async (sha): Promise<[string, CompareOutcome]> => {
      try {
        const compare = await git.getCompareDiff(
          meta.owner,
          meta.repo,
          sha,
          headSha,
        );
        return [sha, { ok: true, compare }];
      } catch (error) {
        return [sha, { ok: false, reason: describeError(error) }];
      }
    }),
  );
  return new Map(outcomes);
}

async function loadContents(
  git: GitAdapterContract,
  meta: PRMeta,
  headSha: string,
  threads: ReviewThread[],
): Promise<Map<string, string | null>> {
  const paths = uniqueValues(threads.map((thread) => thread.path));
  const contents = await Promise.all(
    paths.map(async (path): Promise<[string, string | null]> => [
      path,
      await git.getFileContent(meta.owner, meta.repo, path, headSha),
    ]),
  );
  return new Map(contents);
}

function fileChanges(
  thread: ReviewThread,
  headSha: string,
  outcome: CompareOutcome | undefined,
): JudgeFileChanges {
  const fromSha = commentSha(thread);
  if (!fromSha) {
    return {
      status: 'unavailable',
      reason: 'the comment has no recorded commit',
    };
  }
  if (!outcome) return { status: 'unavailable', reason: 'no compare was made' };
  if (!outcome.ok) return { status: 'unavailable', reason: outcome.reason };
  const diff = parseDiffByFile(outcome.compare.diff).get(thread.path);
  if (!diff) return { status: 'unchanged', fromSha, toSha: headSha };
  return {
    status: 'changed',
    fromSha,
    toSha: headSha,
    diff: diff.slice(0, MAX_FILE_DIFF_CHARS),
    truncated: diff.length > MAX_FILE_DIFF_CHARS,
  };
}

function otherChangedFiles(
  thread: ReviewThread,
  outcome: CompareOutcome | undefined,
): string[] {
  if (!outcome?.ok) return [];
  return outcome.compare.changedFiles.filter((file) => file !== thread.path);
}

export function excerptAround(
  content: string | null,
  line: number | null,
): JudgeCodeExcerpt | null {
  if (content === null) return null;
  const lines = content.split('\n');
  const center = Math.min(Math.max(line ?? 1, 1), lines.length);
  const startLine = Math.max(1, center - EXCERPT_RADIUS);
  const endLine = Math.min(lines.length, center + EXCERPT_RADIUS);
  return { startLine, lines: lines.slice(startLine - 1, endLine) };
}

function judgeComments(thread: ReviewThread): JudgeComment[] {
  return thread.comments.map(({ author, body, createdAt }) => ({
    author,
    body,
    ...(createdAt ? { createdAt } : {}),
  }));
}

function openerHunk(thread: ReviewThread): Pick<JudgeThread, 'diffHunk'> {
  const diffHunk = thread.comments[0]?.diffHunk;
  return diffHunk ? { diffHunk } : {};
}

/** The line at the head, or where the comment was when it is outdated. */
function anchorLine(thread: ReviewThread): number | null {
  return thread.line ?? thread.originalLine ?? null;
}

function toJudgeThread(
  thread: ReviewThread,
  headSha: string,
  evidence: Evidence,
): JudgeThread {
  const sha = commentSha(thread);
  const outcome = sha ? evidence.compares.get(sha) : undefined;
  return {
    threadId: thread.id,
    path: thread.path,
    line: thread.line,
    originalLine: thread.originalLine ?? null,
    comments: judgeComments(thread),
    ...openerHunk(thread),
    changes: fileChanges(thread, headSha, outcome),
    otherChangedFiles: otherChangedFiles(thread, outcome),
    currentCode: excerptAround(
      evidence.contents.get(thread.path) ?? null,
      anchorLine(thread),
    ),
  };
}

/**
 * Builds what the judge sees per thread: the comments, the thread file's
 * diff since the comment, other changed files and the current code around
 * the line. A failed file read throws: without the current code there is
 * nothing to judge, and the threads stay queued for the next event.
 */
export async function buildJudgeThreads(
  git: GitAdapterContract,
  meta: PRMeta,
  headSha: string,
  threads: ReviewThread[],
): Promise<JudgeThread[]> {
  const [compares, contents] = await Promise.all([
    loadCompares(git, meta, headSha, threads),
    loadContents(git, meta, headSha, threads),
  ]);
  return threads.map((thread) =>
    toJudgeThread(thread, headSha, { compares, contents }),
  );
}
