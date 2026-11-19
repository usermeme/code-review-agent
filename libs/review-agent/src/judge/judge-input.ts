import type { RepoWorkspace } from '@code-review-agent/agent-tools';
import type {
  PRMeta,
  ThreadVerdict,
  TokenUsage,
} from '@code-review-agent/shared-types';
import type { BaseLlm } from '@google/adk';
import type { ThinkingLevel } from '@google/genai';

export interface JudgeComment {
  author: string;
  body: string;
  createdAt?: string;
}

/** How the thread's file changed between the comment's commit and the head. */
export type JudgeFileChanges =
  | {
      status: 'changed';
      fromSha: string;
      toSha: string;
      /** Line-annotated diff of the thread's file (new-side line numbers). */
      diff: string;
      truncated: boolean;
    }
  | { status: 'unchanged'; fromSha: string; toSha: string }
  | { status: 'unavailable'; reason: string };

/** A slice of the thread's file at the head, around the commented line. */
export interface JudgeCodeExcerpt {
  startLine: number;
  lines: string[];
}

/** Everything the judge sees about one resolved thread. */
export interface JudgeThread {
  threadId: string;
  path: string;
  /** Line at the head; null when the thread is outdated. */
  line: number | null;
  originalLine: number | null;
  /** The opening comment first, then replies, oldest first. */
  comments: JudgeComment[];
  /** The code the comment was written on. */
  diffHunk?: string;
  changes: JudgeFileChanges;
  /** Other files changed since the comment; the fix may be in one of them. */
  otherChangedFiles: string[];
  /** Null when the file no longer exists at the head. */
  currentCode: JudgeCodeExcerpt | null;
}

export interface CommentJudgeInput {
  prMeta: PRMeta;
  threads: JudgeThread[];
  /** Downloads the repository at the head; called only if a tool needs it. */
  loadWorkspace: () => Promise<RepoWorkspace>;
}

export interface CommentJudgeOptions {
  model: BaseLlm;
  timeoutMs: number;
  maxLlmCalls: number;
  thinkingLevel?: ThinkingLevel;
}

export interface ThreadJudgment {
  verdict: ThreadVerdict;
  reason: string;
}

export interface CommentJudgeResult {
  /** By thread id; a thread the model did not rule on is absent. */
  judgments: Map<string, ThreadJudgment>;
  usage: TokenUsage;
  /** Set when the session failed or ended without `submit_judgments`. */
  error?: string;
  /** True when a tool call downloaded the repository. */
  repoLoaded: boolean;
}
