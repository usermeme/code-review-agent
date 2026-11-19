import type {
  JudgeCodeExcerpt,
  JudgeComment,
  JudgeFileChanges,
  JudgeThread,
} from './judge-input.js';

const MAX_COMMENT_CHARS = 2_000;
const MAX_HUNK_CHARS = 3_000;
const MAX_LISTED_OTHER_FILES = 30;

export const JUDGE_INSTRUCTION = `You are a Staff Software Engineer acting as a comment judge on a pull request. Every thread below is a review comment that someone marked as resolved. For each one, decide whether the code at the PR head really resolves it.

## Verdicts
- "fixed": the problem the comment describes no longer exists at the head. Any reasonable fix counts, not only the one the comment suggested.
- "not_fixed": the problem is still there, is only partly fixed, or the fix moved the same problem somewhere else. Also "not_fixed" when a reply claims a fix that the code does not show.
- "accepted": the code was not changed for this, but a reply gives a concrete reason no change is needed (a false positive, intended behavior, handled elsewhere) and that reason holds up against the code. A bare "won't fix", "done" or "not needed" is not a reason.

## Rules
- Judge only what each comment asked for. Never raise new or unrelated issues; that is the reviewer's job.
- Replies are claims to check, not evidence. Weigh them by what they say, never by who wrote them.
- The thread's diff since the comment and the current code are usually enough. Use \`read_file\`, \`grep_code\` or \`find_files\` only when the fix may be in another file or the excerpt does not show enough.
- For "not_fixed", \`reason\` is posted as a reply on the thread: say concretely what is still wrong, with \`file:line\`, in at most three sentences. For the other verdicts, one sentence.

Finish by calling \`submit_judgments\` once, with a judgment for every thread.`;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function formatComment(comment: JudgeComment): string {
  const when = comment.createdAt ? ` (${comment.createdAt})` : '';
  return `**${comment.author}**${when}:\n${clip(comment.body.trim(), MAX_COMMENT_CHARS)}`;
}

function formatLocation(thread: JudgeThread): string {
  if (thread.line !== null) return `line ${thread.line}`;
  if (thread.originalLine !== null) {
    return `originally line ${thread.originalLine}, now outdated`;
  }
  return 'file-level';
}

function formatHunk(thread: JudgeThread): string {
  if (!thread.diffHunk) return '';
  return `\n\n### Code the comment was written on\n\`\`\`diff\n${clip(thread.diffHunk, MAX_HUNK_CHARS)}\n\`\`\``;
}

function formatChanges(path: string, changes: JudgeFileChanges): string {
  if (changes.status === 'unavailable') {
    return `### Changes to \`${path}\` since the comment\nUnavailable: ${changes.reason}`;
  }
  const range = `${shortSha(changes.fromSha)} → ${shortSha(changes.toSha)}`;
  if (changes.status === 'unchanged') {
    return `### Changes to \`${path}\` since the comment (${range})\nThis file has not changed since the comment.`;
  }
  const note = changes.truncated ? '\n(diff truncated)' : '';
  return `### Changes to \`${path}\` since the comment (${range})\n\`\`\`diff\n${changes.diff}${note}\n\`\`\``;
}

function formatOtherFiles(files: string[]): string {
  if (files.length === 0) return '';
  const listed = files.slice(0, MAX_LISTED_OTHER_FILES);
  const more =
    files.length > listed.length
      ? `\n- …and ${files.length - listed.length} more`
      : '';
  const items = listed.map((file) => `- \`${file}\``).join('\n');
  return `\n\n### Other files changed since the comment\n${items}${more}`;
}

function formatCurrentCode(
  path: string,
  excerpt: JudgeCodeExcerpt | null,
): string {
  if (!excerpt) {
    return `### Current \`${path}\` at the head\nThe file no longer exists at the head.`;
  }
  const end = excerpt.startLine + excerpt.lines.length - 1;
  const numbered = excerpt.lines
    .map((text, index) => `${excerpt.startLine + index} | ${text}`)
    .join('\n');
  return `### Current \`${path}\` at the head (lines ${excerpt.startLine}-${end})\n\`\`\`\n${numbered}\n\`\`\``;
}

function formatThread(thread: JudgeThread, index: number): string {
  const comments = thread.comments.map(formatComment).join('\n\n');
  return `## Thread ${index}: \`${thread.path}\` (${formatLocation(thread)})

### Comments (oldest first)
${comments}${formatHunk(thread)}

${formatChanges(thread.path, thread.changes)}${formatOtherFiles(thread.otherChangedFiles)}

${formatCurrentCode(thread.path, thread.currentCode)}`;
}

export function buildJudgePrompt(
  title: string,
  prNumber: number,
  threads: JudgeThread[],
): string {
  const body = threads.map(formatThread).join('\n\n---\n\n');
  return `# Pull Request #${prNumber}: ${title}\n\n${body}`;
}
